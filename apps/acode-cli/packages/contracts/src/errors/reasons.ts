// ============================================================
// Closed-set error reason vocabularies
// (specs/error-taxonomy-injection-defense.md R1)
// ============================================================
//
// 三组封闭 token 集：agent 启动/进程失败面、权限/会话拒绝面、会话错误分类。
// 纪律（R1）：
// - 遥测与 UI 可见的 reason 只收本文件的闭集 token；
// - 自由错误文本只进 detail/debug 通道（error-payload 的 formatContextDetail）；
// - 外部输入（子进程 errno 名、provider 错误串等）必须先过正则白名单
//   （形态 + 长度）再查词表成员资格，永不直接透传成 token；
// - 文本分类器只映射仓库自有文案的显式正则，映射不了返回 undefined，不猜。

/** 闭集 token 的统一形态白名单：小写字母开头的 snake_case，长度 2..64。 */
const CLOSED_REASON_TOKEN_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

// -----------------------------------------------
// 1. Agent 启动/进程失败面
// -----------------------------------------------

/**
 * 按 CLI 实际抛错点收敛（core/src/subagent/runner.ts + tool/handlers/agent.ts）。
 * 与 AgentErrorCode（contracts/src/tools/agent.ts）并存不合并：code 标识「哪个契约面
 * 失败」，reason 标识「为什么失败」。desktop 侧进程崩溃面（binary/arch/crash_loop 类）
 * 属 desktop 失败面，CLI 词表不预置空位（spec「不在本项范围」第 5 条）。
 */
export const AgentLaunchFailureReason = {
  /** SubagentPort 未配置，Agent 工具不可用。 */
  SubagentUnavailable: "subagent_unavailable",
  /** 后台派发在当前语境被拒（单次执行模型 override / off-peak 继承）。 */
  BackgroundUnavailable: "background_unavailable",
  /** 请求的 agentType 不在已注册 profile 集内。 */
  UnknownAgentType: "unknown_agent_type",
  /** child runtime 生命周期失败（真实 provider/model 错误在 cause 链里）。 */
  ChildRuntimeFailed: "child_runtime_failed",
  /** 树级预算准入拒绝（局部拒绝维度在 context.budgetReason）。 */
  TreeBudgetExceeded: "tree_budget_exceeded",
  /** 启动元数据写入失败，child runtime 未开始执行。 */
  StartupMetadataWriteFailed: "startup_metadata_write_failed",
  /** 活动看门狗：子代理静默超时被中止。 */
  InactivityTimeout: "inactivity_timeout",
  /** 父 signal 中止：子代理返回前被取消。 */
  CancelledBeforeCompletion: "cancelled_before_completion",
} as const;

export type AgentLaunchFailureReason =
  (typeof AgentLaunchFailureReason)[keyof typeof AgentLaunchFailureReason];

const AGENT_LAUNCH_FAILURE_REASONS: readonly string[] = Object.freeze(
  Object.values(AgentLaunchFailureReason),
);

export function isAgentLaunchFailureReason(value: unknown): value is AgentLaunchFailureReason {
  return typeof value === "string" && AGENT_LAUNCH_FAILURE_REASONS.includes(value);
}

// -----------------------------------------------
// 2. 权限/会话拒绝面
// -----------------------------------------------

/**
 * 按 core/src/permission/service.ts 的实际 ruleId/拒绝文案收敛
 * （rule.policy.deny / rule.disallowedTools / rule.project.deny /
 * mode.plan.nonReadOnly / mode.build.criticalRisk 等）。
 * permission 服务本身的 reason 词表化属 WSA 面，分批接线（spec R2）。
 */
export const PermissionDenialReason = {
  /** 托管策略地板 deny。 */
  PolicyDenied: "policy_denied",
  /** 用户/策略显式禁用的工具（disallowedTools）。 */
  DisallowedTool: "disallowed_tool",
  /** 项目权限规则 deny。 */
  ProjectRuleDenied: "project_rule_denied",
  /** 会话级规则 deny。 */
  SessionRuleDenied: "session_rule_denied",
  /** Plan 模式只允许只读、非破坏性工具。 */
  PlanModeRequiresReadOnly: "plan_mode_requires_read_only",
  /** 旁路免疫熔断器命中。 */
  BreakerDenied: "breaker_denied",
  /** PreToolUse hook 拒绝。 */
  HookDenied: "hook_denied",
  /** critical 风险需显式批准。 */
  CriticalRiskRequiresApproval: "critical_risk_requires_approval",
  /** high 风险需显式批准。 */
  HighRiskRequiresApproval: "high_risk_requires_approval",
  /** 当前协作模式要求批准（通用档）。 */
  ModeRequiresApproval: "mode_requires_approval",
  /** 工具自报 deny（denyPriority: beforeAsk 的硬阻断）。 */
  ToolSelfDenied: "tool_self_denied",
  /** 权限请求本身失败（broker/ask 通道错误）。 */
  PermissionRequestFailed: "permission_request_failed",
  /** 用户在弹窗里显式拒绝。 */
  UserDenied: "user_denied",
} as const;

export type PermissionDenialReason =
  (typeof PermissionDenialReason)[keyof typeof PermissionDenialReason];

const PERMISSION_DENIAL_REASONS: readonly string[] = Object.freeze(
  Object.values(PermissionDenialReason),
);

export function isPermissionDenialReason(value: unknown): value is PermissionDenialReason {
  return typeof value === "string" && PERMISSION_DENIAL_REASONS.includes(value);
}

// -----------------------------------------------
// 3. 会话错误分类
// -----------------------------------------------

/**
 * 按 error-payload attribution 实际流经的失败形态收敛。
 * 不预置「unknown」兜底 token：分类不了就让 reason 缺席，
 * 自由文本留在 detail 通道——闭集的价值在于每个 token 都可聚合、可行动。
 */
export const SessionErrorClass = {
  AuthError: "auth_error",
  RateLimit: "rate_limit",
  Network: "network",
  Timeout: "timeout",
  DiskFull: "disk_full",
  ContextExceeded: "context_exceeded",
  ModelError: "model_error",
  StorageError: "storage_error",
  ConfigurationError: "configuration_error",
  Cancelled: "cancelled",
  GitNotFound: "git_not_found",
  GitOperationFailed: "git_operation_failed",
} as const;

export type SessionErrorClass = (typeof SessionErrorClass)[keyof typeof SessionErrorClass];

const SESSION_ERROR_CLASSES: readonly string[] = Object.freeze(Object.values(SessionErrorClass));

export function isSessionErrorClass(value: unknown): value is SessionErrorClass {
  return typeof value === "string" && SESSION_ERROR_CLASSES.includes(value);
}

// -----------------------------------------------
// 联合视图与收窄工具
// -----------------------------------------------

export type ClosedErrorReasonToken =
  | AgentLaunchFailureReason
  | PermissionDenialReason
  | SessionErrorClass;

/** 值是否已是任一闭集词表的成员（精确、区分大小写）。 */
export function isClosedErrorReasonToken(value: unknown): value is ClosedErrorReasonToken {
  return (
    isAgentLaunchFailureReason(value) ||
    isPermissionDenialReason(value) ||
    isSessionErrorClass(value)
  );
}

/**
 * 外部输入的 token 收窄（R1）：先 trim + 小写归一（errno 名习惯大写），
 * 再过形态白名单，最后查词表成员资格。任一环节不过返回 undefined——
 * 外部字符串永远不会「看起来像」就放行。
 */
export function narrowExternalReasonToken<T extends string>(
  value: unknown,
  vocabulary: readonly T[],
): T | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  if (!CLOSED_REASON_TOKEN_PATTERN.test(candidate)) return undefined;
  return (vocabulary as readonly string[]).includes(candidate) ? (candidate as T) : undefined;
}

/** 对三个词表依次做 narrowExternalReasonToken。 */
export function narrowExternalClosedReasonToken(value: unknown): ClosedErrorReasonToken | undefined {
  return (
    narrowExternalReasonToken(value, AGENT_LAUNCH_FAILURE_REASONS as readonly AgentLaunchFailureReason[]) ??
    narrowExternalReasonToken(value, PERMISSION_DENIAL_REASONS as readonly PermissionDenialReason[]) ??
    narrowExternalReasonToken(value, SESSION_ERROR_CLASSES as readonly SessionErrorClass[])
  );
}

// -----------------------------------------------
// 文本分类器（显式正则白名单，映射不了返回 undefined）
// -----------------------------------------------

interface TextClassificationRule<T extends string> {
  token: T;
  pattern: RegExp;
}

/**
 * 仓库自有拒绝文案 → PermissionDenialReason。
 * 正则来源：permission/service.ts 与 executor 的既有字面文案（spec R2 分批接线前，
 * 上报点收窄先用它们把自由文本折叠成 token）。顺序即优先级：先具体后通用。
 */
const PERMISSION_DENIAL_TEXT_RULES: readonly TextClassificationRule<PermissionDenialReason>[] = [
  { token: PermissionDenialReason.PolicyDenied, pattern: /denied by managed policy|managed policy floor/i },
  { token: PermissionDenialReason.DisallowedTool, pattern: /explicitly disallowed|disallowed tool/i },
  { token: PermissionDenialReason.ProjectRuleDenied, pattern: /denied by project permission rules|project rule/i },
  { token: PermissionDenialReason.SessionRuleDenied, pattern: /denied by session (?:permission )?rules?|session rule/i },
  { token: PermissionDenialReason.PlanModeRequiresReadOnly, pattern: /plan mode only allows read-only|plan mode .*read-only/i },
  { token: PermissionDenialReason.BreakerDenied, pattern: /breaker|bypass-immune/i },
  { token: PermissionDenialReason.HookDenied, pattern: /blocked by pretooluse hook|pretooluse hook/i },
  { token: PermissionDenialReason.CriticalRiskRequiresApproval, pattern: /critical risk/i },
  { token: PermissionDenialReason.HighRiskRequiresApproval, pattern: /high risk/i },
  { token: PermissionDenialReason.PermissionRequestFailed, pattern: /permission request failed/i },
  { token: PermissionDenialReason.UserDenied, pattern: /user (?:denied|rejected|declined)|denied by user|user doesn'?t want to proceed/i },
  { token: PermissionDenialReason.ModeRequiresApproval, pattern: /requires (?:explicit )?approval/i },
];

export function classifyPermissionDenialText(text: unknown): PermissionDenialReason | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  for (const rule of PERMISSION_DENIAL_TEXT_RULES) {
    if (rule.pattern.test(text)) return rule.token;
  }
  return undefined;
}

/**
 * 会话错误文本 → SessionErrorClass。顺序即优先级：
 * 磁盘/限速/认证等具体信号先判，通用的 network/model 垫后；
 * git_not_found 先于 git_operation_failed（「git 不存在」比「git 操作失败」更具体）。
 */
const SESSION_ERROR_TEXT_RULES: readonly TextClassificationRule<SessionErrorClass>[] = [
  { token: SessionErrorClass.DiskFull, pattern: /\bENOSPC\b|no space left on device|disk full|out of disk space/i },
  { token: SessionErrorClass.RateLimit, pattern: /\brate.?limit|\b429\b|too many requests|quota exceeded/i },
  { token: SessionErrorClass.AuthError, pattern: /\b401\b|\b403\b|unauthorized|unauthenticated|invalid[ _-]?(?:api[ _-]?)?key|authentication (?:error|failed)|invalid credentials|access denied|forbidden|sign.?in (?:required|expired)/i },
  { token: SessionErrorClass.ContextExceeded, pattern: /context (?:length|window|limit)|maximum context|context_exceeded|prompt is too long|too many tokens/i },
  { token: SessionErrorClass.Timeout, pattern: /\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|\bECONNABORTED\b|timed? ?out|timeout|deadline exceeded/i },
  { token: SessionErrorClass.GitNotFound, pattern: /'git' is not recognized|git: command not found|command not found: git|git .*not (?:found|installed)/i },
  { token: SessionErrorClass.GitOperationFailed, pattern: /fatal: not a git repository|git (?:checkout|merge|rebase|clone|push|pull|fetch|commit) .*failed|could not read from remote repository|index\.lock/i },
  { token: SessionErrorClass.StorageError, pattern: /\bEIO\b|\bEROFS\b|\bSQLITE_\w+|database is locked|storage (?:error|failure)/i },
  { token: SessionErrorClass.ConfigurationError, pattern: /configuration (?:error|invalid)|invalid (?:configuration|config|setting)|misconfigured/i },
  { token: SessionErrorClass.Cancelled, pattern: /\bcancelled\b|\bcanceled\b|\baborted\b|request was aborted|user requested (?:stop|cancel)/i },
  {
    token: SessionErrorClass.Network,
    pattern:
      /\bENETUNREACH\b|\bEHOSTUNREACH\b|\bECONNREFUSED\b|\bECONNRESET\b|\bEAI_AGAIN\b|\bENOTFOUND\b|\bEPIPE\b|\bUND_ERR_\w+|network (?:error|unreachable)|socket hang up|fetch failed|connection (?:closed|reset|refused)/i,
  },
  {
    token: SessionErrorClass.ModelError,
    pattern: /\b50[0-9]\b|internal server error|bad gateway|service unavailable|overloaded|model (?:error|failed)|provider (?:error|failure)|api error/i,
  },
];

export function classifySessionErrorText(text: unknown): SessionErrorClass | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  for (const rule of SESSION_ERROR_TEXT_RULES) {
    if (rule.pattern.test(text)) return rule.token;
  }
  return undefined;
}

/**
 * 上报点收窄总入口（error-payload 用）：原始 reason 值依次过
 * 「精确成员 → 拒绝文案分类器 → 会话错误分类器」；全不过返回 undefined。
 * 精确成员检查区分大小写（闭集 token 本身是小写形态）；分类器负责自由文本。
 */
export function narrowErrorReasonToClosedToken(value: unknown): ClosedErrorReasonToken | undefined {
  if (isClosedErrorReasonToken(value)) return value;
  if (typeof value !== "string") return undefined;
  return classifyPermissionDenialText(value) ?? classifySessionErrorText(value);
}
