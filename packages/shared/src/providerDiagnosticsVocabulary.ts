import { z } from "zod";

/**
 * Provider 诊断（U08）的**词汇面**：闭集枚举（档位 / 检查点 id / 四态 / verdict /
 * 终态 / 稳定原因码 / 修复动作）与 spend 形状。
 *
 * 与 `providerDiagnostics.ts`（线协议 schema 面）拆开的原因：词汇是「有哪些取值」，
 * 请求/结果 schema 是「怎么组装成一次跨进程调用」。两侧演进节奏不同——词汇只增不改不删
 * （改一个码等于改全部 UI 文案映射），而 DTO 形状会随诊断能力演进而加字段。
 *
 * 语义唯一真源是 apps/acode-cli/specs/provider-doctor.md（R1-R7 与 12 检查点表）；
 * 本文件只镜像其**线协议词汇**，一致性由
 * apps/acode-cli/tests/provider-diagnostics-contract-parity.test.mjs 机械钉住。
 */

/** 诊断档位。语义（是否触网/是否花费/追加验证什么）见 provider-doctor.md R2。 */
export const providerDiagnosticsTierSchema = z.enum(["offline", "catalog", "live"]);
export type ProviderDiagnosticsTier = z.infer<typeof providerDiagnosticsTierSchema>;
export const PROVIDER_DIAGNOSTICS_TIERS = providerDiagnosticsTierSchema.options;

/**
 * 12 个检查点的稳定 id。顺序与 provider-doctor.md R3 的检查点表逐字一致，
 * 且与 Doctor 的 `PROVIDER_DOCTOR_CHECKPOINT_IDS` 同源（parity 测试钉住）。
 * 新增只能追加，不能重命名既有条目——改 id 等于改账本 schema。
 */
export const PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS = [
  "config_sources_loaded",
  "provider_schema_valid",
  "endpoint_shape_valid",
  "credential_available",
  "catalog_models_declared",
  "model_route_resolved",
  "endpoint_public_egress",
  "catalog_live_endpoint",
  "catalog_model_listed",
  "non_streaming_chat_completion",
  "streaming_chat_completion",
  "tool_call_parse",
] as const;
export const providerDiagnosticsCheckpointIdSchema = z.enum(PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS);
export type ProviderDiagnosticsCheckpointId = z.infer<
  typeof providerDiagnosticsCheckpointIdSchema
>;
/** 检查点数量恒为 12（provider-doctor.md R3）；结果里必须每个 id 恰出现一次。 */
export const PROVIDER_DIAGNOSTICS_CHECKPOINT_COUNT = PROVIDER_DIAGNOSTICS_CHECKPOINT_IDS.length;

/**
 * 四态检查状态，逐字沿用 Doctor（provider-doctor.md R2/R3）。**不得折叠**：
 * `skipped`（本档不跑 / 前置未满足而刻意不发请求，不计入通过）与 `failed`（跑了且结论否定）
 * 必须可区分（spec R5 / U08-A5）；`blocked` = 依赖不可用、诊断无法证明。
 */
export const providerDiagnosticsCheckStatusSchema = z.enum([
  "passed",
  "failed",
  "skipped",
  "blocked",
]);
export type ProviderDiagnosticsCheckStatus = z.infer<
  typeof providerDiagnosticsCheckStatusSchema
>;

/** 档位结论，逐字沿用 Doctor：`ready` 只可能出现在 live 档全通过（轻档不越档背书）。 */
export const providerDiagnosticsVerdictSchema = z.enum(["ready", "tier-passed", "failed"]);
export type ProviderDiagnosticsVerdict = z.infer<typeof providerDiagnosticsVerdictSchema>;

/** 执行终态三值。`cancelled` 与 `failed` 分开，取消不是失败（spec R4）。 */
export const providerDiagnosticsRunStatusSchema = z.enum(["completed", "failed", "cancelled"]);
export type ProviderDiagnosticsRunStatus = z.infer<
  typeof providerDiagnosticsRunStatusSchema
>;

/**
 * 稳定原因码闭集。UI 按它出 i18n 文案与修复动作；**禁止**改用 detail/message 文本判定
 * （spec R6）。只增不改不删——改码等于改全部 UI 文案映射。
 *
 * `credential-missing`（引用悬空/未配置）、`credential-rejected`（密钥被端点拒绝）、
 * `catalog-empty`（2xx 但解析不出模型）三者互不相同，是 U08-A2 的机械断言面。
 */
export const PROVIDER_DIAGNOSTICS_REASON_CODES = [
  // ── 请求与执行环境 ──
  /** 请求本身不合法（schema 之外的形态、缺字段）。 */
  "invalid-request",
  /** 没有可承载诊断的 agent 运行时（首次配置尚无 workspace → 零调用失败，spec 无 workspace 段）。 */
  "no-agent-runtime",
  /** tier=live 但用户未显式 opt-in（spec R9）。 */
  "live-opt-in-required",
  /** 结果 revision 与请求 revision 不一致（执行方违约，spec R2）。 */
  "revision-mismatch",
  /** providerId 不在 Registry 快照内。 */
  "provider-unknown",
  // ── 执行生命周期 ──
  "cancelled",
  "execution-failed",
  /** offline 档 blockedNetworkCalls > 0：零网络不变量被违背（spec R9）。 */
  "offline-network-blocked",
  // ── offline 检查点 #1-#6 ──
  "config-source-unavailable",
  "config-schema-invalid",
  "endpoint-shape-invalid",
  "credential-missing",
  /** 凭据库不可用/不可解密 → Doctor 记 blocked（无法证明，不是失败）。 */
  "credential-undecryptable",
  "catalog-not-declared",
  "model-route-unresolved",
  // ── catalog 检查点 #7-#9 ──
  "endpoint-not-public",
  /** 凭据送到了端点但被拒（401/403）——「密钥错了」，区别于「密钥不在」。 */
  "credential-rejected",
  /** 目录端点 2xx 但没有解析出任何模型 id。 */
  "catalog-empty",
  /** 目录端点网络层不可达（超时/连接失败/DNS）。 */
  "catalog-unreachable",
  /** 端点不支持目录列举（404/405/501）→ Doctor 记 skipped，不是失败。 */
  "catalog-unsupported",
  "model-not-listed",
  // ── live 检查点 #10-#12 ──
  "live-probe-failed",
  /** 模型声明不支持 tool call → Doctor 记 skipped（provider-doctor.md R3）。 */
  "tool-call-unsupported",
] as const;
export const providerDiagnosticsReasonCodeSchema = z.enum(PROVIDER_DIAGNOSTICS_REASON_CODES);
export type ProviderDiagnosticsReasonCode = z.infer<
  typeof providerDiagnosticsReasonCodeSchema
>;

/**
 * 允许 UI 呈现的修复动作白名单。UI 只能渲染成按钮/链接并映射 i18n，
 * **不能**据此拼命令执行；可粘贴命令走 `nextStepCommands`（只展示）。
 */
export const PROVIDER_DIAGNOSTICS_REMEDIATION_ACTIONS = [
  /** 打开桌面设置 → Provider 填 API Key。 */
  "open-api-key-settings",
  /** 重新登录账号型 provider（对应 CLI `acode login`）。 */
  "relogin-account",
  /** 换一个模型再诊断。 */
  "select-another-model",
  /** 修改 baseUrl / 端点配置。 */
  "edit-endpoint",
  /** 检查网络 / 代理（含 fake-IP 情形，provider-doctor.md R4 已知限制）。 */
  "check-network",
  /** 升档到 catalog（会联网，约零花费）。 */
  "escalate-tier-catalog",
  /** 升档到 live（会花费余额，需显式 opt-in）。 */
  "escalate-tier-live",
  /** 重试本次诊断（不重新创建 provider，spec R3）。 */
  "retry-diagnostics",
  /** 保持「已保存、尚未验证」，稍后再验证（提案 §3.6 回退段）。 */
  "verify-later",
] as const;
export const providerDiagnosticsRemediationActionSchema = z.enum(
  PROVIDER_DIAGNOSTICS_REMEDIATION_ACTIONS,
);
export type ProviderDiagnosticsRemediationAction = z.infer<
  typeof providerDiagnosticsRemediationActionSchema
>;

/** 花费事实。取消时也要携带，让 UI 能如实说「已发生的调用无法撤销」（spec R4）。 */
export const providerDiagnosticsSpendSchema = z
  .object({
    billableCalls: z.number().int().nonnegative(),
    catalogCalls: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    hasTokenData: z.boolean(),
  })
  .strict();
export type ProviderDiagnosticsSpend = z.infer<typeof providerDiagnosticsSpendSchema>;
