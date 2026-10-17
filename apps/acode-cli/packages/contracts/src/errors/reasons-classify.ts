// ============================================================
// 闭集 reason 词表的文本分类器与上报点收窄总入口
// （specs/error-taxonomy-injection-defense.md R1）
// ============================================================
// 自 reasons.ts 按架构 ratchet 行数门禁抽出（逻辑逐字保留，只加导入头）；
// 词表 token 本体仍住 reasons.ts，本文件单向依赖它（无环）。公开出口经
// errors/index.ts 的 export * 再导出，所有既有导入路径逐名不变。

import {
  isClosedErrorReasonToken,
  PermissionDenialReason,
  SessionErrorClass,
  type ClosedErrorReasonToken,
} from "./reasons.js";

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
  // dontAsk 模式拒绝（批 2 R1）：规范文案句式先判——归因段可能携带底层
  // ruleId（含 breaker.* 等），后置规则会误归类，故排最前。
  {
    token: PermissionDenialReason.DontAskModeDenied,
    pattern: /denied without a prompt|don'?t ask mode/i,
  },
  {
    token: PermissionDenialReason.PolicyDenied,
    pattern: /denied by managed policy|managed policy floor/i,
  },
  {
    token: PermissionDenialReason.DisallowedTool,
    pattern: /explicitly disallowed|disallowed tool/i,
  },
  {
    token: PermissionDenialReason.ProjectRuleDenied,
    pattern: /denied by project permission rules|project rule/i,
  },
  {
    token: PermissionDenialReason.SessionRuleDenied,
    pattern: /denied by session (?:permission )?rules?|session rule/i,
  },
  {
    token: PermissionDenialReason.PlanModeRequiresReadOnly,
    pattern: /plan mode only allows read-only|plan mode .*read-only/i,
  },
  { token: PermissionDenialReason.BreakerDenied, pattern: /breaker|bypass-immune/i },
  {
    token: PermissionDenialReason.HookDenied,
    pattern: /blocked by pretooluse hook|pretooluse hook/i,
  },
  { token: PermissionDenialReason.CriticalRiskRequiresApproval, pattern: /critical risk/i },
  { token: PermissionDenialReason.HighRiskRequiresApproval, pattern: /high risk/i },
  { token: PermissionDenialReason.PermissionRequestFailed, pattern: /permission request failed/i },
  {
    token: PermissionDenialReason.UserDenied,
    pattern: /user (?:denied|rejected|declined)|denied by user|user doesn'?t want to proceed/i,
  },
  // 审批参数绑定失效（批 2 R4）：批准绑定弹卡时呈现的参数——应答回来参数已
  // 不同即拒绝复用。映射本仓将采用的规范文案句式（自撰），外部自由文本不收。
  {
    token: PermissionDenialReason.ApprovalArgumentsMismatch,
    pattern:
      /approval (?:was|came back) (?:for|with) different arguments|different arguments, so it was not run/i,
  },
  {
    token: PermissionDenialReason.ModeRequiresApproval,
    pattern: /requires (?:explicit )?approval/i,
  },
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
  {
    token: SessionErrorClass.DiskFull,
    pattern: /\bENOSPC\b|no space left on device|disk full|out of disk space/i,
  },
  {
    token: SessionErrorClass.RateLimit,
    pattern: /\brate.?limit|\b429\b|too many requests|quota exceeded/i,
  },
  {
    token: SessionErrorClass.AuthError,
    pattern:
      /\b401\b|\b403\b|unauthorized|unauthenticated|invalid[ _-]?(?:api[ _-]?)?key|authentication (?:error|failed)|invalid credentials|access denied|forbidden|sign.?in (?:required|expired)/i,
  },
  {
    token: SessionErrorClass.ContextExceeded,
    pattern:
      /context (?:length|window|limit)|maximum context|context_exceeded|prompt is too long|too many tokens/i,
  },
  {
    token: SessionErrorClass.Timeout,
    pattern:
      /\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|\bECONNABORTED\b|timed? ?out|timeout|deadline exceeded/i,
  },
  {
    token: SessionErrorClass.GitNotFound,
    pattern:
      /'git' is not recognized|git: command not found|command not found: git|git .*not (?:found|installed)/i,
  },
  {
    token: SessionErrorClass.GitOperationFailed,
    pattern:
      /fatal: not a git repository|git (?:checkout|merge|rebase|clone|push|pull|fetch|commit) .*failed|could not read from remote repository|index\.lock/i,
  },
  {
    token: SessionErrorClass.StorageError,
    pattern: /\bEIO\b|\bEROFS\b|\bSQLITE_\w+|database is locked|storage (?:error|failure)/i,
  },
  {
    token: SessionErrorClass.ConfigurationError,
    pattern:
      /configuration (?:error|invalid)|invalid (?:configuration|config|setting)|misconfigured/i,
  },
  {
    token: SessionErrorClass.Cancelled,
    pattern:
      /\bcancelled\b|\bcanceled\b|\baborted\b|request was aborted|user requested (?:stop|cancel)/i,
  },
  {
    token: SessionErrorClass.Network,
    pattern:
      /\bENETUNREACH\b|\bEHOSTUNREACH\b|\bECONNREFUSED\b|\bECONNRESET\b|\bEAI_AGAIN\b|\bENOTFOUND\b|\bEPIPE\b|\bUND_ERR_\w+|network (?:error|unreachable)|socket hang up|fetch failed|connection (?:closed|reset|refused)/i,
  },
  {
    token: SessionErrorClass.ModelError,
    pattern:
      /\b50[0-9]\b|internal server error|bad gateway|service unavailable|overloaded|model (?:error|failed)|provider (?:error|failure)|api error/i,
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
