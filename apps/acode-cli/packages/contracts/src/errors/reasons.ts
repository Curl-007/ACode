// ============================================================
// Closed-set error reason vocabularies
// (specs/error-taxonomy-injection-defense.md R1)
// ============================================================
//
// 四组封闭 token 集：agent 启动/进程失败面、权限/会话拒绝面、会话错误分类、
// 启动拒绝面（org/gateway/provider 族，specs/permission-adjudication-batch2.md R4）。
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
  /**
   * 声明式 worktree 隔离的进入被拒（specs/subagent-declarative-keys.md 接线需求 8）：
   * 取代对 subagent_unavailable 的复用；局部维度仍在 context.isolationReason 聚合。
   */
  WorktreeIsolationUnavailable: "worktree_isolation_unavailable",
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
  /**
   * 审批参数绑定失效（specs/permission-adjudication-batch2.md R4）：批准绑定到
   * 弹卡时呈现的那份参数；应答回来时参数已不同（hook 改写等），批准不可复用、
   * 调用不执行。现行复核路径（permission-input-recheck 重新弹卡）在结构上已
   * 保证不复用旧批准——本 token 供该语义进入上报面时收窄。
   */
  ApprovalArgumentsMismatch: "approval_arguments_mismatch",
  /** dontAsk 模式拒绝（批 2 R1）：无人可问，未白名单即拒不弹卡。 */
  DontAskModeDenied: "dontask_mode_denied",
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
// 4. 启动拒绝面（org/gateway/provider/托管设置类）
// -----------------------------------------------

/**
 * 第四组闭集（specs/permission-adjudication-batch2.md R4；词表增补证据 =
 * 价值提取第二轮 T3-C「启动失败词表 18 项映射」的 org/gateway/provider 族）。
 * **前瞻词表**：ACode 的 org/gateway 启动链路尚无抛错点——本组先把可聚合的
 * token 面备好（远程服务器 CLI 启动、桌面托管设置、provider 准入面接线时
 * 直接消费），文本分类器规则按纪律**暂不配**（分类器只映射仓库自有文案，
 * 抛错点落地时同批补规则）。与 AgentLaunchFailureReason 的分工：那组是
 * 「子代理/后台派发为什么失败」，本组是「app/会话为什么起不来或进不去」。
 */
export const LaunchRefusalReason = {
  /** 托管设置（组织下发的 managed settings）拒绝本次启动。 */
  ManagedSettingsRefused: "managed_settings_refused",
  /** 组织配置校验失败，启动被拒。 */
  OrgConfigRefused: "org_config_refused",
  /** 必需的组织配置不可用（拉取失败/缺失）。 */
  OrgConfigUnavailable: "org_config_unavailable",
  /** 组织设备/主机钉扎不匹配：该账号不被允许在这台机器上使用。 */
  OrgPinMismatch: "org_pin_mismatch",
  /** 组织凭据在本上下文不被允许（credential 与 org 策略不匹配）。 */
  OrgCredentialNotAllowed: "org_credential_not_allowed",
  /** 组织策略显式拒绝（通用档：具体策略面在 detail 通道）。 */
  OrgPolicyDenied: "org_policy_denied",
  /** 网关需要（重新）登录：sign-in 缺失或已过期。 */
  GatewaySigninRequired: "gateway_signin_required",
  /** 网关拒绝访问（鉴权通过但准入被拒）。 */
  GatewayAccessDenied: "gateway_access_denied",
  /** 网关会话过期（与 signin_required 分立：会话失效 vs 从未登录）。 */
  GatewaySessionExpired: "gateway_session_expired",
  /** 组织策略不允许该 provider/模型（provider 准入族）。 */
  ProviderNotAllowed: "provider_not_allowed",
  /** root/管理员身份被禁止使用 bypass 权限档启动。 */
  BypassPermissionsRootBlocked: "bypass_permissions_root_blocked",
  /** 会话 worktree 无法验证（缺失/不可信），拒绝进入。 */
  WorktreeUnverified: "worktree_unverified",
} as const;

export type LaunchRefusalReason = (typeof LaunchRefusalReason)[keyof typeof LaunchRefusalReason];

const LAUNCH_REFUSAL_REASONS: readonly string[] = Object.freeze(Object.values(LaunchRefusalReason));

export function isLaunchRefusalReason(value: unknown): value is LaunchRefusalReason {
  return typeof value === "string" && LAUNCH_REFUSAL_REASONS.includes(value);
}

// -----------------------------------------------
// 联合视图与收窄工具
// -----------------------------------------------

export type ClosedErrorReasonToken =
  | AgentLaunchFailureReason
  | PermissionDenialReason
  | SessionErrorClass
  | LaunchRefusalReason;

/** 值是否已是任一闭集词表的成员（精确、区分大小写）。 */
export function isClosedErrorReasonToken(value: unknown): value is ClosedErrorReasonToken {
  return (
    isAgentLaunchFailureReason(value) ||
    isPermissionDenialReason(value) ||
    isSessionErrorClass(value) ||
    isLaunchRefusalReason(value)
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

/** 对四个词表依次做 narrowExternalReasonToken。 */
export function narrowExternalClosedReasonToken(
  value: unknown,
): ClosedErrorReasonToken | undefined {
  return (
    narrowExternalReasonToken(
      value,
      AGENT_LAUNCH_FAILURE_REASONS as readonly AgentLaunchFailureReason[],
    ) ??
    narrowExternalReasonToken(
      value,
      PERMISSION_DENIAL_REASONS as readonly PermissionDenialReason[],
    ) ??
    narrowExternalReasonToken(value, SESSION_ERROR_CLASSES as readonly SessionErrorClass[]) ??
    narrowExternalReasonToken(value, LAUNCH_REFUSAL_REASONS as readonly LaunchRefusalReason[])
  );
}
