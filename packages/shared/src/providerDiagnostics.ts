import { z } from "zod";
// 词汇面（闭集枚举 + spend 形状）拆到伴生文件，避免单文件超 400 行门禁；本文件只放
// 跨进程的线协议 schema（请求/结果/取消/parse/方法名）。re-export 让 shared 根 barrel
// 的 `export * from "./providerDiagnostics.js"` 仍把词汇一并公开，消费者 import 面不变。
export * from "./providerDiagnosticsVocabulary.js";
import {
  PROVIDER_DIAGNOSTICS_CHECKPOINT_COUNT,
  PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS,
  providerDiagnosticsCheckStatusSchema,
  providerDiagnosticsCheckpointIdSchema,
  providerDiagnosticsReasonCodeSchema,
  providerDiagnosticsRemediationActionSchema,
  providerDiagnosticsRunStatusSchema,
  providerDiagnosticsSpendSchema,
  providerDiagnosticsTierSchema,
  providerDiagnosticsVerdictSchema,
  type ProviderDiagnosticsSpend,
} from "./providerDiagnosticsVocabulary.js";

/**
 * Provider 诊断（U08）的**线协议 schema 面**。规格见 packages/services/specs/provider-diagnostics.md。
 *
 * 设计要点（安全与 i18n 承重，勿轻改）：
 * 1. **只搬结构化闭集，不搬自由文本**——检查点的 `label` 与 `detail`（Doctor 产出的中文
 *    文案）**不进** DTO。用户可见文本一律由 UI 按 `id` + `reasonCode` 走 i18n 生成；这既
 *    避免中英文混排（AGENTS.md 国际化纪律），也让「不做文本匹配」成为结构保证而非约定
 *    （spec R6）。顺带收紧隐私面：边界上没有任何自由字符串可夹带密钥片段。
 * 2. **白名单 + `.strict()`**——任何未登记字段（尤其 `apiKey`/`authorization`/`keyHash` 形态）
 *    在 parse 时被拒，是结构性排除，不依赖生产侧自律（spec R8）。
 * 3. **`revision` 必填回显**——迟到结果对新 revision 的写入为 0（spec R2）由 schema 强制。
 *
 * 词汇枚举（tier/checkpoint/status/verdict/reasonCode/remediation/spend）在伴生的
 * providerDiagnosticsVocabulary.ts；两者经本文件的 re-export 合成为一个公开契约叶子。
 */

// ------------------------------------------------------------
// 请求
// ------------------------------------------------------------

/**
 * 诊断请求。`tier` 刻意**不设 schema 默认值**：缺省档由 UI 决定（首次配置默认 offline），
 * schema 给默认值会让「忘记传 tier」静默变成某一档，可能意外升档触网。
 *
 * 提案 §3.2 的 `modelSelection` 在这里拆为 `providerId` + `modelId`：`reasoningLevel` 与
 * `maxOutputTokens` 由 Doctor 自己按 provider-doctor.md R3 固定（`maxOutputTokens: 64`、
 * 取第一个合法档位），让 UI 传它只会造出一个 UI 无权决定、且必然被忽略的假接口面。
 */
export const providerDiagnosticsRequestSchema = z
  .object({
    /** 调用方生成的关联键；取消与单次执行去重都按它（spec R3/R4）。 */
    requestId: z.string().trim().min(1),
    providerId: z.string().trim().min(1),
    /** 发起时的 `ProviderSettingsView.revision`；结果必须回显同一值（spec R2）。 */
    revision: z.number().int().nonnegative(),
    tier: providerDiagnosticsTierSchema,
    /** 缺席时 Doctor 按其缺省顺序选目标模型（provider-doctor.md R1）。 */
    modelId: z.string().trim().min(1).optional(),
    /** tier=live 时必须为 true，否则 `live-opt-in-required`（spec R9）。 */
    liveOptIn: z.boolean().optional(),
  })
  .strict();
export type ProviderDiagnosticsRequest = z.infer<typeof providerDiagnosticsRequestSchema>;

export const providerDiagnosticsCancelRequestSchema = z
  .object({
    requestId: z.string().trim().min(1),
  })
  .strict();
export type ProviderDiagnosticsCancelRequest = z.infer<
  typeof providerDiagnosticsCancelRequestSchema
>;

// ------------------------------------------------------------
// 结果
// ------------------------------------------------------------

/**
 * 单检查点结果。**只有 id + status + 可选 reasonCode/durationMs**：无 label、无 detail
 * （见文件头设计要点 1）。`reasonCode` 仅在非 `passed` 时出现，`passed` 携带它没有意义。
 */
export const providerDiagnosticsCheckpointSchema = z
  .object({
    id: providerDiagnosticsCheckpointIdSchema,
    status: providerDiagnosticsCheckStatusSchema,
    reasonCode: providerDiagnosticsReasonCodeSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ProviderDiagnosticsCheckpoint = z.infer<
  typeof providerDiagnosticsCheckpointSchema
>;

const providerDiagnosticsCheckpointsSchema = z
  .array(providerDiagnosticsCheckpointSchema)
  // 12 检查点契约（provider-doctor.md R3）：数量恒定、id 集合恰为闭集且各出现一次。
  // 少一个或多一个都说明执行方漂移了检查点目录，必须 fail-loud 而不是让 UI 渲染残缺列表。
  .superRefine((checkpoints, context) => {
    if (checkpoints.length !== PROVIDER_DIAGNOSTICS_CHECKPOINT_COUNT) {
      context.addIssue({
        code: "custom",
        message: `expected ${PROVIDER_DIAGNOSTICS_CHECKPOINT_COUNT} checkpoints`,
      });
      return;
    }
    const seen = new Set<string>();
    for (const checkpoint of checkpoints) {
      if (seen.has(checkpoint.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate checkpoint id: ${checkpoint.id}`,
        });
      }
      seen.add(checkpoint.id);
    }
    for (const id of PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS) {
      if (!seen.has(id)) {
        context.addIssue({ code: "custom", message: `missing checkpoint id: ${id}` });
      }
    }
  });

/**
 * 诊断结果。`revision` 必填且必须是**请求时**的值（spec R2）——它是 UI 丢弃迟到结果的
 * 唯一依据；执行方不得替换成执行时的最新 revision，否则 fencing 失效。
 */
export const providerDiagnosticsResultSchema = z
  .object({
    requestId: z.string().trim().min(1),
    providerId: z.string().trim().min(1),
    revision: z.number().int().nonnegative(),
    tier: providerDiagnosticsTierSchema,
    /** Doctor 实际选中的目标模型（请求可缺席，结果必须说清楚诊断了哪个）。 */
    modelId: z.string().trim().min(1).optional(),
    status: providerDiagnosticsRunStatusSchema,
    /** 仅 `status === "completed"` 时有意义；其余档位结论不可信。 */
    verdict: providerDiagnosticsVerdictSchema.optional(),
    /** `status !== "completed"` 时必填：终态必须给稳定原因，不能只说「失败了」。 */
    errorCode: providerDiagnosticsReasonCodeSchema.optional(),
    checkpoints: providerDiagnosticsCheckpointsSchema,
    remediationActions: z.array(providerDiagnosticsRemediationActionSchema),
    /**
     * Doctor R7 已白名单化的可粘贴命令（provider id 非白名单时已退化成占位符）。
     * UI **仅展示**，绝不执行——命令构造与注入防护的所有者是 Doctor，不是 UI。
     */
    nextStepCommands: z.array(z.string().min(1)),
    /**
     * 花费事实。**可选**：只有拿到 Doctor 报告时才携带。取消/无运行时/执行抛错时 Doctor
     * 不返回报告，此时缺席表示「花费未知」——绝不填 0 冒充「没花钱」（R4：已发出的调用
     * 无法追回，谎报 0 等于承诺退费）。`status === "completed"` 时必填（见 superRefine）。
     */
    spend: providerDiagnosticsSpendSchema.optional(),
    /** offline 档 >0 即零网络不变量被违背（spec R9）。 */
    blockedNetworkCalls: z.number().int().nonnegative(),
    /** 只 host：不含 query、header、凭据（spec R8 / Doctor R5）。`baseUrl` 全串不进 DTO。 */
    endpointHost: z.string().trim().min(1).optional(),
    startedAt: z.string().trim().min(1),
    finishedAt: z.string().trim().min(1),
  })
  .strict()
  .superRefine((result, context) => {
    // 终态与原因码互相约束：失败/取消必须带稳定码，完成则不该带（带了会让 UI 误判）。
    if (result.status !== "completed" && result.errorCode === undefined) {
      context.addIssue({
        code: "custom",
        message: "errorCode is required when status is not completed",
      });
    }
    // verdict 只在 completed 时可信：失败/取消的结果若带 verdict，UI 可能把它渲染成结论。
    if (result.status !== "completed" && result.verdict !== undefined) {
      context.addIssue({
        code: "custom",
        message: "verdict must be absent when status is not completed",
      });
    }
    // completed 一定有 Doctor 报告，因此一定有 spend；缺席即执行方漏装配（R4 的诚实基线）。
    if (result.status === "completed" && result.spend === undefined) {
      context.addIssue({
        code: "custom",
        message: "spend is required when status is completed",
      });
    }
  });
export type ProviderDiagnosticsResult = z.infer<typeof providerDiagnosticsResultSchema>;

/** 取消结果。`cancelled: false` 表示该 requestId 不在飞，**不是错误**（spec R4）。 */
export const providerDiagnosticsCancelResultSchema = z
  .object({
    requestId: z.string().trim().min(1),
    cancelled: z.boolean(),
    /** 截至取消时刻的花费事实：已发出的请求无法追回，UI 据此如实告知而非承诺退费。 */
    spend: providerDiagnosticsSpendSchema.optional(),
  })
  .strict();
export type ProviderDiagnosticsCancelResult = z.infer<
  typeof providerDiagnosticsCancelResultSchema
>;

// ------------------------------------------------------------
// 运行时校验（fail-loud，稳定错误码）
// ------------------------------------------------------------

export const PROVIDER_DIAGNOSTICS_REQUEST_PARSE_ERROR = "provider-diagnostics-request-invalid";
export const PROVIDER_DIAGNOSTICS_RESULT_PARSE_ERROR = "provider-diagnostics-result-invalid";
export const PROVIDER_DIAGNOSTICS_CANCEL_PARSE_ERROR = "provider-diagnostics-cancel-invalid";

/** 解析诊断请求；失败抛带稳定码的错误（镜像 `parseLocalDiagnosticReport` 纪律）。 */
export function parseProviderDiagnosticsRequest(input: unknown): ProviderDiagnosticsRequest {
  return parseOrThrow(providerDiagnosticsRequestSchema, input, PROVIDER_DIAGNOSTICS_REQUEST_PARSE_ERROR);
}

/**
 * 解析诊断结果。**跨进程边界的每一侧都应调用**：CLI 侧出口自校验（fail-loud 暴露装配 bug），
 * UI 侧入口校验（不信任远端产物）。
 */
export function parseProviderDiagnosticsResult(input: unknown): ProviderDiagnosticsResult {
  return parseOrThrow(providerDiagnosticsResultSchema, input, PROVIDER_DIAGNOSTICS_RESULT_PARSE_ERROR);
}

export function parseProviderDiagnosticsCancelResult(
  input: unknown,
): ProviderDiagnosticsCancelResult {
  return parseOrThrow(
    providerDiagnosticsCancelResultSchema,
    input,
    PROVIDER_DIAGNOSTICS_CANCEL_PARSE_ERROR,
  );
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, errorCode: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(errorCode);
  return result.data;
}

// ------------------------------------------------------------
// 零花费常量（offline 档的期望值；断言用，避免各处手写字面量）
// ------------------------------------------------------------

/** offline 档的 spend 必须全 0：这一档零网络零花费是承诺，不是巧合（spec R9）。 */
export const PROVIDER_DIAGNOSTICS_ZERO_SPEND: ProviderDiagnosticsSpend = Object.freeze({
  billableCalls: 0,
  catalogCalls: 0,
  promptTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  hasTokenData: false,
});

// ------------------------------------------------------------
// 协议方法名
// ------------------------------------------------------------

/**
 * host → CLI 的协议方法名。
 *
 * **刻意落在这个中立叶子，不进 legacy 协议面**：原 legacy barrel
 * `acode-protocol/index.ts`（M4a 已删）是冻结面（只删不增，见
 * specs/legacy-protocol-freeze.md），既有 `providerTestModelConnectivity` 在 barrel 里是
 * 存量、不是可效仿的先例。方法名走中立叶子 + 客户端方法联合扩一项，是「新命令不进冻结面」
 * 的合规形态。
 *
 * 命名沿用 `provider/` 前缀（与既有 `provider/testModelConnectivity` 同族）。
 *
 * 线上载荷就是 `providerDiagnosticsRequestSchema` / `providerDiagnosticsCancelRequestSchema`
 * （不再另立 wire 变体，避免两份同形 schema 漂移）。`revision` 只由 host 盖章、CLI
 * **逐字回显**：host 的 `ProviderSettingsView.revision` 与 CLI 进程的
 * `sourceRevisions.config` 是两套独立计数器，不可比较；CLI 若改写成自己的 revision，
 * R2 的 fencing 就失效了。
 */
export const PROVIDER_DIAGNOSTICS_METHODS = {
  run: "provider/diagnosticsRun",
  cancel: "provider/diagnosticsCancel",
} as const;
export type ProviderDiagnosticsMethod =
  (typeof PROVIDER_DIAGNOSTICS_METHODS)[keyof typeof PROVIDER_DIAGNOSTICS_METHODS];
