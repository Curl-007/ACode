// ============================================================
// Invalid Tool Receipt (K9 工具微增补) - 畸形工具调用的规范化回执载体
// ============================================================
// 注册待整合方接线：本文件不进 handlers/index.ts 的 BUILT_IN 聚合，
// 注册（含 providerVisible 形态与分发层引用方式）由整合方统一处理。
//
// 语义（specs/tooling-micro-additions.md R1）：模型调用不存在的工具名 / 入参不符合
// schema 时，引擎原本只回一条裸错误文本——模型（尤其换模型/新工具上线时）常常原样重犯。
// 这里把该回执规范化成结构化 markdown：工具名就近建议（编辑距离）、schema 违例逐字段
// 清单（路径+期望+截断实际值）。模型对「工具结果」的注意力远高于裸错误串，自修复率更高。
// 呈现策略参照 jcode (MIT) 的 invalid 工具思路，自撰实现。
//
// 红线：
// - 判定逻辑零变化——失败分类（ToolNotFound / ToolExecutionFailed）、事件与遥测仍由
//   引擎分发层（executor/call-runner.ts）原路径产生，这里只提供呈现载体；
// - 畸形调用零工具执行、零副作用（本文件全部为纯函数 + 只读 handler）；
// - 该工具不出现在模型可主动调用的注册表面（metadata.providerVisible=false，
//   描述声明引擎内部使用）；模型主动调 invalid 按_unknown-name 回执处理。

import { validateJsonSchemaValue } from "../json-schema.js";
import type {
  ToolInputValidationIssue,
  ToolInputValidationPath,
} from "../tool-input-validation-issues.js";
import type { ToolEntry, ToolHandler } from "../types.js";

// -----------------------------------------------
// 常量（spec「常量」表）
// -----------------------------------------------

export const INVALID_TOOL_NAME = "invalid";
/** 就近建议最多列出多少个名字。 */
export const INVALID_SUGGEST_MAX = 3;
/** 编辑距离超过该值的名字不算「就近」。 */
export const INVALID_SUGGEST_EDIT_DISTANCE = 2;
/** schema 违例回执中实际值的截断上限——防超长入参把回执变成投毒面。 */
export const INVALID_VALUE_PREVIEW_CHARS = 200;
/** 截断省略标记。 */
export const INVALID_VALUE_TRUNCATION_MARKER = "…(truncated)";

const INVALID_RECEIPT_MODEL_BYTES = 20_000;

// -----------------------------------------------
// 注册表读取面
// -----------------------------------------------

/**
 * unknown-name 回执的数据源：当前会话的工具注册表快照（spec R1——全集来自注册表，
 * 不是硬编码）。executor 的 ToolRegistry 天然满足该结构；测试可传最小桩。
 * 只列 provider 可见名——模型实际可调用的行动面。
 */
export interface InvalidToolRegistrySnapshot {
  list(): readonly string[];
  getMetadata(name: string): { providerVisible?: boolean } | undefined;
}

function listProviderVisibleToolNames(registry: InvalidToolRegistrySnapshot): string[] {
  return registry
    .list()
    .filter((name) => registry.getMetadata(name)?.providerVisible !== false)
    .sort((left, right) => left.localeCompare(right));
}

// -----------------------------------------------
// 就近建议（编辑距离）
// -----------------------------------------------

/**
 * 编辑距离 ≤ INVALID_SUGGEST_EDIT_DISTANCE 的合法工具名，按（距离, 字典序）排序，
 * 最多 INVALID_SUGGEST_MAX 个。长度差已超阈值的名字直接剪枝（banded 计算）。
 */
export function suggestToolNames(
  requestedName: string,
  registeredToolNames: readonly string[],
): string[] {
  return registeredToolNames
    .map((name) => ({ name, distance: boundedLevenshtein(requestedName, name) }))
    .filter((candidate) => candidate.distance !== undefined)
    .sort(
      (left, right) =>
        (left.distance ?? 0) - (right.distance ?? 0) || left.name.localeCompare(right.name),
    )
    .slice(0, INVALID_SUGGEST_MAX)
    .map((candidate) => candidate.name);
}

/** 预算封顶的 Levenshtein：距离超过 maxDistance 时提前判负（返回 undefined），避免长名全量 DP。 */
function boundedLevenshtein(
  left: string,
  right: string,
  maxDistance = INVALID_SUGGEST_EDIT_DISTANCE,
): number | undefined {
  if (Math.abs(left.length - right.length) > maxDistance) return undefined;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j += 1) {
      const substitution =
        previous[j - 1]! + (left.charCodeAt(i - 1) === right.charCodeAt(j - 1) ? 0 : 1);
      const deletion = previous[j]! + 1;
      const insertion = current[j - 1]! + 1;
      const cell = Math.min(substitution, deletion, insertion);
      current.push(cell);
      rowMin = Math.min(rowMin, cell);
    }
    if (rowMin > maxDistance) return undefined;
    previous = current;
  }
  const distance = previous[right.length]!;
  return distance > maxDistance ? undefined : distance;
}

// -----------------------------------------------
// unknown-name 回执
// -----------------------------------------------

/**
 * unknown tool name 的规范化回执：
 * - 原始名 + 就近建议（≤2、最多 3 个）；
 * - 无近似名 → 列当前注册表 provider 可见工具名全集（来自注册表快照）；
 * - 模型主动调 `invalid` 本身 → 说明该工具非主动调用面（引擎合成的回执载体）。
 */
export function formatInvalidUnknownToolReceipt(
  toolName: string,
  registry: InvalidToolRegistrySnapshot,
): string {
  const available = listProviderVisibleToolNames(registry);

  if (toolName === INVALID_TOOL_NAME) {
    // spec R1：invalid 是引擎侧合成的回执载体，不在模型可主动调用的注册表里。
    // 模型主动调它没有意义——按 unknown-name 口径说明，并给出真实可用面。
    return wrapReceipt(
      [
        `\`${INVALID_TOOL_NAME}\` is not a tool you can call: it is the engine-internal receipt carrier for malformed tool calls (unknown tool names and schema violations).`,
        `Your malformed calls are already answered with a receipt through it — check the corrected name / field violations in that receipt instead of calling \`${INVALID_TOOL_NAME}\`.`,
        `Tools available in this session: ${formatNameList(available)}.`,
        "Use one of the registered tool names and retry.",
      ].join("\n"),
    );
  }

  const suggestions = suggestToolNames(toolName, available);
  if (suggestions.length > 0) {
    return wrapReceipt(
      [
        `No such tool available: \`${toolName}\`.`,
        `Did you mean: ${formatNameList(suggestions)}?`,
        "Retry with the corrected tool name; do not repeat the original call.",
      ].join("\n"),
    );
  }

  return wrapReceipt(
    [
      `No such tool available: \`${toolName}\`.`,
      `No similar tool name found (edit distance > ${INVALID_SUGGEST_EDIT_DISTANCE}). Tools registered in this session: ${formatNameList(available)}.`,
      "Use one of the registered tool names and retry.",
    ].join("\n"),
  );
}

// -----------------------------------------------
// schema 违例回执
// -----------------------------------------------

/**
 * 入参 schema 违例的规范化回执：违例字段逐条（路径 + 期望 + 实际类型；实际值截断
 * INVALID_VALUE_PREVIEW_CHARS 字符）。issues 由同一份 inputSchema 重新求值得出——
 * 与触发失败的判定共用同一条纯函数（json-schema.ts validateJsonSchemaValue），
 * 因此内容与失败原因严格同源，不引入第二套判定。
 */
export function formatInvalidSchemaViolationReceipt(
  toolName: string,
  input: unknown,
  inputSchema: ToolEntry["inputSchema"],
): string {
  const validation = validateJsonSchemaValue(input, inputSchema);
  const lines = projectIssueLines(validation.issues, input);
  const header = `\`${toolName}\` failed input schema validation. Check each violating field below and retry with a corrected call; do not repeat the original call.`;
  if (lines.length === 0) {
    // 理论上不可达（失败才进该回执）；防御性保留原文案通道，不静默吞掉诊断。
    return wrapReceipt([header, ...validation.errors.map((error) => `- ${error}`)].join("\n"));
  }
  return wrapReceipt([header, ...lines].join("\n"));
}

interface ViolationLine {
  path: string;
  expected: string;
  actualType: string;
  actualPreview?: string;
}

function projectIssueLines(
  issues: readonly ToolInputValidationIssue[],
  input: unknown,
): string[] {
  const lines: ViolationLine[] = [];
  for (const issue of issues) {
    switch (issue.code) {
      case "unrecognized_keys":
        // 逐 key 拆行：一次 unrecognized_keys 可能携带多个非法字段。
        for (const key of issue.keys) {
          const path = [...issue.path, key];
          lines.push({
            path: formatValidationPath(path),
            expected: "absent (not defined by the tool schema)",
            ...describeActualValue(readValueAtPath(input, path)),
          });
        }
        break;
      case "invalid_type":
        lines.push({
          path: formatValidationPath(issue.path),
          expected: issue.expected,
          ...describeActualValue(readValueAtPath(input, issue.path)),
        });
        break;
      case "invalid_value":
        lines.push({
          path: formatValidationPath(issue.path),
          expected: `one of ${issue.values.map((value) => safeStringify(value)).join(" | ")}`,
          ...describeActualValue(readValueAtPath(input, issue.path)),
        });
        break;
      case "invalid_format":
        lines.push({
          path: formatValidationPath(issue.path),
          expected:
            issue.pattern === undefined
              ? `string with format ${issue.format}`
              : `string with format ${issue.format} matching ${issue.pattern}`,
          ...describeActualValue(readValueAtPath(input, issue.path)),
        });
        break;
      case "too_small":
      case "too_big":
      case "custom":
      case "invalid_union":
        // 约束类 issue 的期望已由 message 完整描述（如 "Too big: expected string to have <=10 characters"）。
        lines.push({
          path: formatValidationPath(issue.path),
          expected: issue.message,
          ...describeActualValue(readValueAtPath(input, issue.path)),
        });
        break;
    }
  }
  return lines.map(formatViolationLine);
}

function formatViolationLine(line: ViolationLine): string {
  const valueClause =
    line.actualPreview === undefined
      ? line.actualType === "undefined"
        ? " (missing)"
        : ""
      : `; actual value: ${line.actualPreview}`;
  return `- \`${line.path}\`: expected \`${line.expected}\`, actual type \`${line.actualType}\`${valueClause}`;
}

/** 读取入参在违例路径上的实际值（模型原始输入，未经任何修改）。 */
function readValueAtPath(input: unknown, path: ToolInputValidationPath): unknown {
  let current: unknown = input;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

function describeActualValue(value: unknown): { actualType: string; actualPreview?: string } {
  const actualType = describeValueType(value);
  if (value === undefined || value === null) return { actualType };
  const text = typeof value === "string" ? value : safeStringify(value);
  if (text === undefined) return { actualType };
  if (text.length > INVALID_VALUE_PREVIEW_CHARS) {
    return {
      actualType,
      actualPreview: `${text.slice(0, INVALID_VALUE_PREVIEW_CHARS)}${INVALID_VALUE_TRUNCATION_MARKER}`,
    };
  }
  return { actualType, actualPreview: text };
}

function describeValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item,
    ) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatNameList(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(", ");
}

function formatValidationPath(path: ToolInputValidationPath): string {
  if (path.length === 0) return "(root)";
  return path.reduce<string>((formatted, segment, index) => {
    if (typeof segment === "number") return `${formatted}[${segment.toString()}]`;
    return index === 0 ? segment : `${formatted}.${segment}`;
  }, "");
}

function wrapReceipt(body: string): string {
  // 沿用引擎 provider 可见工具错误既有的 <tool_use_error> 包装（call-runner 空名分支同款），
  // 模型侧呈现语义不变——变的是载体内容本身。
  return `<tool_use_error>${body}</tool_use_error>`;
}

// -----------------------------------------------
// 引擎内部 entry
// -----------------------------------------------

const invalidHandler: ToolHandler = async (_input, context) => {
  // 模型主动调 invalid：它不是主动调用面（spec R1）。回执按 unknown-name 口径说明，
  // 工具清单取当前会话 provider 可见名（注册表快照投影，非硬编码）。
  return formatInvalidUnknownToolReceipt(INVALID_TOOL_NAME, {
    list: () => context.providerVisibleToolNames ?? [],
    getMetadata: () => undefined,
  });
};

/**
 * 引擎侧合成的回执载体 entry。providerVisible=false（不进模型可见工具面）；
 * 描述显式声明「引擎内部使用、非模型主动调用面」。注册待整合方接线——
 * 分发层（call-runner）直接引用上面的回执构造函数，不依赖本 entry 在场。
 */
export const invalidToolEntry: ToolEntry = {
  capability:
    "Engine-internal receipt carrier that normalizes malformed tool call feedback (unknown tool names and schema violations); not a model-callable tool",
  metadata: {
    name: INVALID_TOOL_NAME,
    description: `Engine-internal: the engine returns the receipt for your malformed tool calls (unknown tool name or schema-violating input) through this carrier. This is NOT a tool for you to call proactively — when your call was malformed you already received a receipt naming the corrected tool name and the violating fields (paths, expected types, truncated actual values). Fix the call and retry; do not repeat the original malformed call and do not call \`invalid\` yourself.`,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 5_000,
    maxOutputBytes: INVALID_RECEIPT_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
    // 关键声明：不进模型可主动调用的注册表面（toContracts 过滤）。
    providerVisible: false,
  },
  handler: invalidHandler,
  // 引擎合成载体无入参面（spec「接口」：invalid 无入参 schema——引擎合成）；
  // 空 schema 在 json-schema.ts 校验器里恒通过，不会拦截任何探查性调用。
  inputSchema: {},
  outputSchema: {},
  permission: {
    permission: "invalid",
    reason: "invalid is a read-only engine receipt carrier with no executable surface",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["none"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: INVALID_RECEIPT_MODEL_BYTES,
    maxModelBytes: INVALID_RECEIPT_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: INVALID_RECEIPT_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 5_000,
    maxMs: 5_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "invalid receipt synthesis was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    // 回执可能含超长入参片段；trace 只记摘要，不进原始输入。
    recordInput: "none",
    recordOutput: "summary",
  },
};
