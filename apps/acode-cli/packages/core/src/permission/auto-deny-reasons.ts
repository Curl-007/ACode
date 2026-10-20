// ============================================================
// auto-deny reason 闭集 + 工具名防伪统一回应
// (specs/permission-auto-deny-reasons.md R1/R2/R3)
// ============================================================
// 来源：价值提取第三轮 E1-C4（Claude desktop auto-deny 链的闭集 reason 逐条度量 +
// forged_card_name「No such tool.」纪律）。安全依据：
// - 闭集 token 让「哪类自动拒绝发生了多少次」可本地聚合（decision-log，env 门控
//   JSONL，no-telemetry 红线：token 永不进外部遥测）；
// - 防伪统一回应：名字不在实际服务清单时回显「请求名/清单/就近建议」= 给注入内容
//   一个探测 oracle（确认命名猜测、重建工具面），统一常量回应切断该信道。
// 词表纪律（spec R1 扩集清单）：token 复用 contracts PermissionDenialReason 既有值
// （同语义同字符串，避免双词表漂移）；ACode 特有类别在 CoreAutoDenyExtraReason 本地
// 扩展；分类是结构性的（ruleId 精确 + 前缀），映射不了返回 undefined，不猜。

import { PermissionDenialReason } from "@acode/contracts";
import { appendPermissionDecisionLogEntry } from "./decision-log.js";
import { DONT_ASK_RULE_ID } from "./dont-ask-mode.js";
import { isBashReflexGateRuleId } from "./bash-confirm-reflex-gate.js";

// -----------------------------------------------
// R1 闭集词表
// -----------------------------------------------

/**
 * ACode 特有 auto-deny 类别（contracts PermissionDenialReason 未覆盖的语义）。
 * 升格进 contracts 词表属跨域跟进（spec R1）；升格前本地扩展与 contracts 值的
 * 互斥性由守护测试钉住（token 唯一性断言）。
 */
export const CoreAutoDenyExtraReason = {
  /** 技能激活期 disallowed-tools 声明拒绝（rule.skillActivation.deny）。 */
  SkillActivationDenied: "skill_activation_denied",
  /** plan 模式过渡工具误用（mode.plan.exitOnly：ExitPlanMode 非 plan 态）。 */
  PlanModeTransitionDenied: "plan_mode_transition_denied",
  /** Bash Confirm 反射门首轮 deny（gate.bashConfirmReflex.* 前缀）。 */
  ReflexGateDenied: "reflex_gate_denied",
  /**
   * 工具名不在实际服务清单（dispatch registry-miss，含空名；FORGED_TOOL_NAME_RULE_ID）。
   * 语义对齐 Claude forged_card_name：拒且统一回应「No such tool.」（R3）。
   * MCP 逐工具开关关闭表现为名字缺席注册表，同折叠进本 token（spec R1）。
   */
  ForgedToolName: "forged_tool_name",
} as const;

export type CoreAutoDenyExtraReason =
  (typeof CoreAutoDenyExtraReason)[keyof typeof CoreAutoDenyExtraReason];

/** auto-deny 闭集：contracts 既有权限拒绝 token ∪ core 本地扩展 token。 */
export type AutoDenyReason = PermissionDenialReason | CoreAutoDenyExtraReason;

const AUTO_DENY_REASONS: readonly string[] = Object.freeze([
  ...Object.values(PermissionDenialReason),
  ...Object.values(CoreAutoDenyExtraReason),
]);

export function isAutoDenyReason(value: unknown): value is AutoDenyReason {
  return typeof value === "string" && AUTO_DENY_REASONS.includes(value);
}

/** 熔断器 ruleId 前缀（bypass-immune-breakers.ts 的 "breaker.*" 字面量族）。 */
const BREAKER_RULE_ID_PREFIX = "breaker.";

/** forged 类拒绝在决策日志里的 ruleId（dispatch 层，先于权限裁决发生）。 */
export const FORGED_TOOL_NAME_RULE_ID = "dispatch.forgedToolName";

/** ruleId → token 的精确映射（结构性分类；来源 = service.ts / plan-mode-policy.ts 常量）。 */
const RULE_ID_TO_AUTO_DENY_REASON: Readonly<Record<string, AutoDenyReason>> = Object.freeze({
  "rule.policy.deny": PermissionDenialReason.PolicyDenied,
  "rule.disallowedTools": PermissionDenialReason.DisallowedTool,
  "rule.skillActivation.deny": CoreAutoDenyExtraReason.SkillActivationDenied,
  "rule.project.deny": PermissionDenialReason.ProjectRuleDenied,
  "mode.plan.nonReadOnly": PermissionDenialReason.PlanModeRequiresReadOnly,
  "mode.plan.exitOnly": CoreAutoDenyExtraReason.PlanModeTransitionDenied,
  [DONT_ASK_RULE_ID]: PermissionDenialReason.DontAskModeDenied,
  [FORGED_TOOL_NAME_RULE_ID]: CoreAutoDenyExtraReason.ForgedToolName,
});

/**
 * deny 决策的 ruleId → 闭集 reason token。映射不了返回 undefined（不猜，
 * 对齐 error-taxonomy-injection-defense.md R1 分类器纪律）——消费面此时
 * 省略 denyReason 字段，自由文本 reason 照记。
 */
export function classifyAutoDenyRuleId(ruleId: string | undefined): AutoDenyReason | undefined {
  if (ruleId === undefined) return undefined;
  const exact = RULE_ID_TO_AUTO_DENY_REASON[ruleId];
  if (exact !== undefined) return exact;
  if (ruleId.startsWith(BREAKER_RULE_ID_PREFIX)) return PermissionDenialReason.BreakerDenied;
  // 反射门前缀判定复用门模块的单一来源谓词（不手写第二份前缀字面量）。
  if (isBashReflexGateRuleId(ruleId)) return CoreAutoDenyExtraReason.ReflexGateDenied;
  return undefined;
}

// -----------------------------------------------
// R3 工具名防伪统一回应
// -----------------------------------------------

/**
 * registry-miss 的统一 provider 可见回应。刻意不含：请求名回显、注册表清单、
 * 就近建议、「拼错 vs 伪造」区分、内部载体解释——每一项都是探测信道（spec R3）。
 * 模型的自修复不依赖本回执：本轮请求已携带全量工具 schema。
 */
export const NO_SUCH_TOOL_MODEL_RESPONSE = "<tool_use_error>Error: No such tool.</tool_use_error>";

/** 日志内工具名截断（外部可控自由文本，防日志膨胀；对齐 reason 截断纪律）。 */
export const FORGED_TOOL_NAME_LOG_MAX_CHARS = 200;

/** registry-miss 无权限模式可归因时的日志 mode 占位（denied at dispatch）。 */
const FORGED_DENY_FALLBACK_MODE = "dispatch";

export interface ForgedToolNameDenialInput {
  /** 模型请求的原始名（记录前截断；回应侧不回显）。 */
  toolName: string;
  sessionId?: string;
  /** 当前协作模式；缺席 = dispatch 无法归因模式（占位 "dispatch"）。 */
  mode?: string;
  workingDirectory?: string;
}

/**
 * forged_tool_name 的逐条本地度量（spec R2）：registry-miss 不经 PermissionService
 * （发生在权限裁决之前），由 dispatch 处调本函数落决策日志——词表与条目构造仍归
 * permission 域所有。env 门控 / 失败静默 / 零网络出口由 decision-log 模块保证。
 */
export function recordForgedToolNameDenial(input: ForgedToolNameDenialInput): void {
  const toolName =
    input.toolName.length > FORGED_TOOL_NAME_LOG_MAX_CHARS
      ? `${input.toolName.slice(0, FORGED_TOOL_NAME_LOG_MAX_CHARS)}…`
      : input.toolName;
  appendPermissionDecisionLogEntry(
    {
      ts: Date.now(),
      tool: toolName,
      decision: "deny",
      ruleId: FORGED_TOOL_NAME_RULE_ID,
      mode: input.mode ?? FORGED_DENY_FALLBACK_MODE,
      denyReason: CoreAutoDenyExtraReason.ForgedToolName,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    },
    input.workingDirectory ? { workingDirectory: input.workingDirectory } : {},
  );
}
