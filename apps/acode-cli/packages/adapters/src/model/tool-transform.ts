// ============================================================
// Vercel AI SDK tool transforms
// ============================================================

import { anthropic } from "@ai-sdk/anthropic";
import { jsonSchema, tool, type ToolSet } from "ai";
import { ModelErrorCode, type JsonSchema, type ModelToolContract } from "@acode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";
import { ToolCapabilityStripError } from "./tool-capability-strip.js";
import {
  adaptSchemaForStrict,
  applyModelToolSchemaDialect,
  resolveModelToolSchemaPlan,
  type ModelToolSchemaPlan,
} from "./schema-normalize/index.js";
import { isAnthropicFirstPartyModelId, toStrictToolSchema } from "./strict-tool-schema.js";

export interface AiSdkToolTransformOptions {
  requiresMfjsToolSchema?: boolean;
  supportsNativeWebSearch?: boolean;
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "gateway" | "custom";

  /** 本次请求的模型 id，用于首方 strict 资格判定与方言计划的结构化身份分类；缺席即两者都不启用。 */
  modelId?: string;

  /** Provider id，仅用于方言计划的结构化身份分类（classifyModel）；缺席即身份 unknown。 */
  providerId?: string;
}

export function toAiSdkTools(
  tools?: ModelToolContract[],
  options: AiSdkToolTransformOptions = {},
): ToolSet | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  // 方言分发计划每请求计算一次（specs/tool-schema-normalize.md R2.2）：
  // 路由信号 = requiresMfjsToolSchema 标志 + providerKind→wire 一一映射 +
  // classifyModel 结构化身份，禁止模型 id 字符串分支。
  const plan = resolveModelToolSchemaPlan({
    providerKind: options.providerKind,
    providerId: options.providerId,
    modelId: options.modelId,
    requiresMfjsToolSchema: options.requiresMfjsToolSchema,
  });

  const entries = tools.flatMap((contract): [string, ToolSet[string]][] => {
    if (contract.providerNative) {
      // R13 闭集信号：provider-native 编码要么成功、要么 ToolCapabilityStripError
      // （fail 档）；旧实现 `providerTool ? [[…]] : []` 的静默空数组路径已删除——
      // 未注册编码器/能力缺失都不允许静默丢弃工具（specs/tool-search.md R13）。
      return [[contract.name, toAiSdkProviderNativeTool(contract, options)]];
    }

    const projected = projectToolSchemaForWire(contract, options, plan);
    const baseTool = {
      description: contract.description,
      inputSchema: jsonSchema<unknown>(projected.schema),
      ...(projected.strict ? { strict: true } : {}),
      needsApproval: contract.needsApproval,
      ...providerOptionsForClientTool(options),
    };

    if (!contract.execute) {
      return [[contract.name, tool<unknown, never>(baseTool)]];
    }

    return [
      [
        contract.name,
        tool<unknown, unknown>({
          ...baseTool,
          execute: async (input, options) =>
            contract.execute?.(input, {
              toolCallId: options.toolCallId,
              abortSignal: options.abortSignal,
              metadata: {
                readOnly: contract.readOnly,
                destructive: contract.destructive,
                concurrentSafe: contract.concurrentSafe,
                requiresUserInteraction: contract.requiresUserInteraction,
                sideEffectScope: contract.sideEffectScope,
                maxOutputBytes: contract.maxOutputBytes,
                timeoutMs: contract.timeoutMs,
                experimentalContext: options.experimental_context,
              },
            }),
        }),
      ],
    ];
  });

  return entries.length > 0 ? (Object.fromEntries(entries) as ToolSet) : undefined;
}

/**
 * contract 声明 strict、provider 能力匹配、模型具备首方资格且 schema 可表达时，返回严格 schema；
 * 任一条件不满足都返回 undefined，调用方继续发送原 schema，避免兼容端收到陌生字段或非法形状。
 */
function resolveStrictToolSchema(
  contract: ModelToolContract,
  options: AiSdkToolTransformOptions,
): JsonSchema | undefined {
  if (contract.strict !== true) return undefined;
  if (options.providerKind !== "anthropic") return undefined;
  if (!isAnthropicFirstPartyModelId(options.modelId)) return undefined;
  return toStrictToolSchema(contract.inputSchema as JsonSchema);
}

/**
 * 工具 schema 的发送面投影（specs/tool-schema-normalize.md R2.2/R3/R4）：
 *   anthropic strict 折叠（存量路径，不变） → MFJS $ref hoist → 方言归一
 *   （Responses sanitize → MFJS，顺序照抄 omp openai-responses.ts 论证）
 *   → Responses strict 管线（contract.strict 且 enforce 成功才发 strict:true）。
 * fail-closed：归一器意外抛出包装为 InvalidModelRequest 拒绝发送本次请求——
 * 宁可失败也不发坏 schema（对照 model-option-map-fetch.ts 的既有先例）；
 * strict 资格失败不是错误，降级为非 strict 的合法 schema（omp CONSTRAINTS #1.5）。
 */
function projectToolSchemaForWire(
  contract: ModelToolContract,
  options: AiSdkToolTransformOptions,
  plan: ModelToolSchemaPlan,
): { schema: JsonSchema; strict: boolean } {
  try {
    const strictSchema = resolveStrictToolSchema(contract, options);
    const base = strictSchema ?? (contract.inputSchema as JsonSchema);
    const hoisted = normalizeToolInputSchema(contract.name, base, options);
    const dialect = applyModelToolSchemaDialect(plan, hoisted);
    if (strictSchema !== undefined) {
      // anthropic 首方 strict：存量折叠路径，strict 资格已由 toStrictToolSchema 判定。
      return { schema: dialect, strict: true };
    }
    if (plan.responsesStrictEligible && contract.strict === true) {
      const adapted = adaptSchemaForStrict(dialect, true);
      return { schema: adapted.schema, strict: adapted.strict };
    }
    return { schema: dialect, strict: false };
  } catch (error) {
    if (error instanceof AiSdkModelAdapterError) throw error;
    throw new AiSdkModelAdapterError(
      ModelErrorCode.InvalidModelRequest,
      `Tool ${contract.name} schema normalization failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error, context: { toolName: contract.name, wire: plan.wire } },
    );
  }
}

function normalizeToolInputSchema(
  toolName: string,
  schema: JsonSchema,
  options: AiSdkToolTransformOptions,
): JsonSchema {
  if (!options.requiresMfjsToolSchema) {
    return schema;
  }
  return hoistLocalJsonSchemaRefsToDefs(toolName, schema);
}

function hoistLocalJsonSchemaRefsToDefs(toolName: string, schema: JsonSchema): JsonSchema {
  const refs = new Set<string>();
  collectNonDefsLocalRefs(schema, refs);
  const unresolvedRef = [...refs].find((ref) => resolveLocalJsonPointer(schema, ref) === undefined);
  if (unresolvedRef) {
    throw new AiSdkModelAdapterError(
      ModelErrorCode.InvalidModelRequest,
      `Tool ${toolName} contains an unresolvable local schema reference ${unresolvedRef}`,
      { context: { toolName, ref: unresolvedRef } },
    );
  }
  if (refs.size === 0) {
    return schema;
  }

  const existingDefs = asPlainRecord(schema.$defs) ?? {};
  const usedDefKeys = new Set(Object.keys(existingDefs));
  const defKeyByRef = new Map<string, string>();
  let nextDefIndex = 0;
  for (const ref of refs) {
    let defKey = `acode_ref_${nextDefIndex}`;
    while (usedDefKeys.has(defKey)) {
      nextDefIndex += 1;
      defKey = `acode_ref_${nextDefIndex}`;
    }
    nextDefIndex += 1;
    usedDefKeys.add(defKey);
    defKeyByRef.set(ref, defKey);
  }

  const rewrittenRoot = rewriteJsonSchemaRefs(schema, defKeyByRef) as JsonSchema;
  const rewrittenDefs = asPlainRecord(rewrittenRoot.$defs) ?? {};
  const hoistedDefs: Record<string, unknown> = {};
  for (const [ref, defKey] of defKeyByRef) {
    hoistedDefs[defKey] = rewriteJsonSchemaRefs(resolveLocalJsonPointer(schema, ref), defKeyByRef);
  }

  // MCP schema 会复用 #/properties/...，但 K3 只接受 #/$defs/...。
  // 在模型适配边界复制引用目标并改写引用，既不修改原 tool contract，也不影响其他模型。
  return {
    ...rewrittenRoot,
    $defs: {
      ...rewrittenDefs,
      ...hoistedDefs,
    },
  };
}

function collectNonDefsLocalRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNonDefsLocalRefs(item, refs);
    }
    return;
  }
  const record = asPlainRecord(value);
  if (!record) return;
  if (
    typeof record.$ref === "string" &&
    record.$ref.startsWith("#/") &&
    !record.$ref.startsWith("#/$defs/")
  ) {
    refs.add(record.$ref);
  }
  for (const child of Object.values(record)) {
    collectNonDefsLocalRefs(child, refs);
  }
}

function resolveLocalJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current = root;
  try {
    for (const encodedSegment of ref.slice(2).split("/")) {
      const segment = decodeURIComponent(encodedSegment)
        .replaceAll("~1", "/")
        .replaceAll("~0", "~");
      if (Array.isArray(current)) {
        if (!/^\d+$/u.test(segment)) return undefined;
        current = current[Number(segment)];
        continue;
      }
      const record = asPlainRecord(current);
      if (!record || !Object.prototype.hasOwnProperty.call(record, segment)) {
        return undefined;
      }
      current = record[segment];
    }
  } catch {
    return undefined;
  }
  return current;
}

function rewriteJsonSchemaRefs(value: unknown, defKeyByRef: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteJsonSchemaRefs(item, defKeyByRef));
  }
  const record = asPlainRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => {
      if (key === "$ref" && typeof child === "string") {
        const defKey = defKeyByRef.get(child);
        if (defKey) {
          return [key, `#/$defs/${defKey}`];
        }
      }
      return [key, rewriteJsonSchemaRefs(child, defKeyByRef)];
    }),
  );
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerOptionsForClientTool(options: AiSdkToolTransformOptions): {
  providerOptions?: Record<string, Record<string, boolean>>;
} {
  if (options.providerKind !== "anthropic") {
    return {};
  }

  // AI SDK enables Anthropic fine-grained tool input streaming by default
  // and serializes eager_input_streaming on every function tool. Several
  // Anthropic-compatible gateways reject that extra tool field, so ACode opts out
  // at the provider-option boundary unless a future capability contract enables it.
  return {
    providerOptions: {
      anthropic: {
        eagerInputStreaming: false,
      },
    },
  };
}

/**
 * provider-native 工具的 wire 编码（R13 闭集信号）：返回类型不含 undefined——
 * 编码成功或抛 ToolCapabilityStripError（fail 档，code 仍 InvalidModelRequest，
 * failure-classifier 归档不变），不存在静默丢弃路径。message 保持既有文案。
 */
function toAiSdkProviderNativeTool(
  contract: ModelToolContract,
  options: AiSdkToolTransformOptions,
): ToolSet[string] {
  if (contract.providerNative?.logicalName !== "WebSearch") {
    // 注册表/构建事实：未登记的 logicalName 无编码器。旧实现返回 undefined 由
    // 调用方折叠成空数组（静默丢弃）；R13 禁止静默丢弃，显式闭集报错。
    throw new ToolCapabilityStripError(
      "provider_native_tool_unregistered",
      contract.name,
      `Provider-native tool ${contract.name} (${
        contract.providerNative?.logicalName ?? "unknown"
      }) has no registered wire encoder`,
    );
  }

  const args = contract.providerNative.args ?? {};
  const maxUses = numberArg(args.maxUses) ?? 8;
  const allowedDomains = stringArrayArg(args.allowedDomains);
  const blockedDomains = stringArrayArg(args.blockedDomains);

  switch (options.providerKind) {
    case "anthropic":
      if (!options.supportsNativeWebSearch) {
        // 目的工具能力缺失（对照上游 fail:foundry-purpose-request）：模型属性面
        // 声明不支持 native WebSearch，handler 门禁后的第二道防线。
        throw new ToolCapabilityStripError(
          "native_web_search_model_unsupported",
          contract.name,
          "Effective Model Config does not support provider-native WebSearch",
        );
      }
      return anthropic.tools.webSearch_20260209({
        maxUses,
        allowedDomains,
        blockedDomains,
      }) as ToolSet[string];

    default:
      // 后端 API 面不编码 provider-native web search（openai 兼容后端必然缺）。
      throw new ToolCapabilityStripError(
        "native_web_search_provider_unencodable",
        contract.name,
        `Provider API kind ${options.providerKind ?? "unknown"} does not encode provider-native WebSearch`,
      );
  }
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayArg(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string");
  return values.length > 0 ? values : undefined;
}
