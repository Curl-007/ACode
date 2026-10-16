/**
 * 凭据 helper 上下文标记：五值封闭集（specs/credential-helper-context.md）。
 *
 * 背景：ACode 现状没有凭据 helper（外部命令供凭据）机制，但无人值守消费面已经存在
 * （desktop automation 的 cron / off-peak 派发链路）。凭据获取层
 * （ProviderApiKeyVault 及未来的 helper invoker）需要知道「本次获取有没有人类在场
 * 能应答交互提示」——否则无人值守 run 里的凭据缺失只能挂起等 stdin 或静默降级。
 * 本模块先立闭集语义与解析（接口预留），helper 机制落地批与 cron/off-peak 传递
 * 接线直接沿用，不再造词。
 *
 * 纯常量 + 纯函数、无 IO，符合 provider 模块单层 app 形态。
 */

/** 跨进程传递面：helper 子进程 env 里的上下文标记键（见 spec R2）。 */
export const ACODE_HELPER_CONTEXT_ENV_KEY = "ACODE_HELPER_CONTEXT";

/**
 * 五值封闭集（单一事实源；新值 = 代码评审 + spec 更新，不接受运行时扩展）。
 * 语义轴是「有没有人类在场能应答提示」：
 * - interactive：用户正在主动操作（CLI auth-login、桌面设置页签入）。
 * - mid-session-refresh：活跃会话中的静默刷新（token 过期检查、mid-turn 401 重试）。
 * - background：后台/无人值守执行，非定时任务（off-peak 链路、后台 workflow）。
 * - scheduled-task：定时任务触发的运行（desktop cron 派发）。
 * - setup-test：设置期连通性测试（provider doctor、设置页「测试连接」）——用户在场，
 *   但意图是「测试」而非「使用」。
 */
export const CREDENTIAL_HELPER_CONTEXTS = [
  "interactive",
  "mid-session-refresh",
  "background",
  "scheduled-task",
  "setup-test",
] as const;

export type CredentialHelperContext = (typeof CREDENTIAL_HELPER_CONTEXTS)[number];

const CREDENTIAL_HELPER_CONTEXT_SET: ReadonlySet<string> = new Set(CREDENTIAL_HELPER_CONTEXTS);

/**
 * 解析上下文标记：trim + 小写归一后闭集校验。
 * 未知值/空值 → undefined（fail-closed：调用方必须落到「无人值守」分支，
 * 不得拿不准就提示，见 spec R1）。
 */
export function parseCredentialHelperContext(
  raw: string | undefined,
): CredentialHelperContext | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  return CREDENTIAL_HELPER_CONTEXT_SET.has(normalized)
    ? (normalized as CredentialHelperContext)
    : undefined;
}

/**
 * 「用户在场」判定（spec R1 裁决规则的唯一实现点）：仅 interactive / setup-test
 * 允许交互提示。undefined（缺席/未知值）为 false——fail-closed 按无人值守处理。
 */
export function isUserPresentCredentialHelperContext(
  context: CredentialHelperContext | undefined,
): boolean {
  return context === "interactive" || context === "setup-test";
}
