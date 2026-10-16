// ============================================================
// Permission Broker Port - async client permission boundary
// ============================================================

// 架构断环（specs/architecture-contracts-module.md）：PermissionDecision 的定义从
// session.events.ts 下沉到本文件（本文件的请求/结果类型引用它，而 session.events
// 反向引用 PermissionOptionsPolicy/PermissionUpdate，定义留在那边即成环）；
// session.events.ts 原样再导出，包导出面逐名不变。CollaborationMode/RiskLevel
// 同理改从叶子文件 session-shared.ts 导入。
import type { ModelToolSideEffectScope } from "../model/index.js";
import type { CollaborationMode, RiskLevel } from "./session-shared.js";
import type { InteractionRequestOrigin, SessionId, ToolCallId, TraceId, TurnId } from "./shared.js";

export type PermissionDecision = "allow" | "deny" | "escalate" | "modify";

export type PermissionRuleBehavior = "allow" | "deny" | "ask";

export const PermissionCapabilityGroup = {
  OfficialCua: "official_cua",
} as const;

export type PermissionCapabilityGroup =
  (typeof PermissionCapabilityGroup)[keyof typeof PermissionCapabilityGroup];

export interface PermissionRuleValue {
  toolName: string;
  ruleContent?: string;
}

export interface PermissionRuleset {
  version?: 1;
  allow?: PermissionRuleValue[];
  deny?: PermissionRuleValue[];
  ask?: PermissionRuleValue[];
  mode?: CollaborationMode;
  [key: string]: unknown;
}

export type PermissionUpdate = {
  type: "addRules";
  behavior: PermissionRuleBehavior;
  rules: PermissionRuleValue[];
  /**
   * TTL 持久授权（specs/mcp-lifecycle-ttl-approval.md R4）：这些 allow 规则在指定
   * 时刻（ISO 8601）过期，过期后判定回落 ask。仅 `behavior: "allow"` 有意义；
   * deny/ask 携带该字段被忽略（收紧类规则不存在「到期自动放宽」的语义）。
   * 缺省 = 既有语义不变（会话级 sessionRules 或项目持久 ruleset）。
   * legacy wire schema（packages/shared 的 acodePermissionUpdateSchema）已携带可选
   * `expiresAt`（2026-10-15 接线批次，spec「范围外接线」已收口）；v4 交互应答按
   * optionId 映射服务端合成选项，无独立 permissionUpdate wire schema。审批 UI 的
   * 「允许 N 天」选项与 broker 结果携带 expiresAt 仍为后续批次（见 spec）。
   */
  expiresAt?: string;
};

/**
 * 一条带过期时间的持久授权（TTL grant）。存储与迁移语义见
 * specs/mcp-lifecycle-ttl-approval.md R4；判定消费点在
 * `PermissionService`（allow 级位次，被策略地板/项目 ask/plan 结构性压制）。
 */
export interface TtlPermissionGrant {
  /** 授权唯一标识（去重与撤销用）。 */
  grantId: string;
  toolName: string;
  /** 与 PermissionRuleValue.ruleContent 同一匹配语义（命令/URL 前缀、通配）。 */
  ruleContent?: string;
  /** 过期时刻（ISO 8601）；到期回落后不再进 active 集合。 */
  expiresAt: string;
  /** 批准时刻（ISO 8601）。 */
  grantedAt: string;
  /**
   * 批准来源：交互式会话（人工确认）或无人值守运行（cron / off-peak /
   * automation 派发）。unattended 的持久批准一律限期且默认/上限更短（R4）。
   */
  origin: TtlPermissionGrantOrigin;
  /**
   * 作用域键（项目标识 / workspace identity）。缺省 = 本机用户级，对所有判定
   * 上下文生效；携带时只对 `PermissionContext.permissionScopeKey` 相同的上下文生效。
   */
  scopeKey?: string;
}

export type TtlPermissionGrantOrigin = "interactive" | "unattended";

/** TTL 授权落盘文件的带版本形态；迁移与 fail-closed 语义见 spec R4。 */
export interface TtlPermissionGrantFile {
  version: 1;
  grants: TtlPermissionGrant[];
}

export const TTL_PERMISSION_GRANT_FILE_VERSION = 1;

// 修改原因：workflow Refine 与 plan 反馈同构——
// deny + reason 只有携带专用 source 才允许被升级为真实 user message。
export type PermissionBrokerReasonSource = "plan_approval_feedback" | "workflow_refine_feedback";

/**
 * Narrows the option set a permission ask may offer. `no-always-allow` drops the
 * persistent project rule option: some tools carry different code on every call
 * (CreateWorkflow scripts), so "always allow" would permanently disable the gate
 * rather than remember a comparable decision. `session-always-allow` replaces the
 * persistent rule with a session-scoped one that lives only in the runtime's memory.
 */
export type PermissionOptionsPolicy = "no-always-allow" | "session-always-allow";

export interface PermissionBrokerRequest {
  requestId: string;
  sessionId: SessionId;
  turnId?: TurnId;
  traceId: TraceId;
  toolCallId: ToolCallId;
  toolName: string;
  input: unknown;
  mode: CollaborationMode;
  ruleId: string;
  reason: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  suggestedPermissionUpdates?: PermissionUpdate[];
  optionsPolicy?: PermissionOptionsPolicy;
  requestedAt: Date;
  origin?: InteractionRequestOrigin;
}

export interface PermissionBrokerResult {
  decision: PermissionDecision;
  reason?: string;
  /** V4 permission feedback 需要保留 provider-visible 原文；只由 broker 结果携带。 */
  preserveReasonFormatting?: boolean;
  reasonSource?: PermissionBrokerReasonSource;
  modifiedInput?: unknown;
  permissionUpdates?: PermissionUpdate[];
  /**
   * Session-scoped grants ("Always allow in this session"). Applied to the runtime's
   * in-memory session ruleset only; never persisted with `permissionUpdates`. Synthesized
   * by the broker on the answer side because the wire option schema is strict.
   */
  sessionPermissionUpdates?: PermissionUpdate[];
  resolvedAt?: Date;
}

export interface PermissionBrokerRequestOptions {
  /** 带提交副作用的应答先取得唯一胜者；失败保留用户审批，Hook 不再竞争。 */
  claimResponse?: () => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PermissionBrokerPort {
  requestPermission(
    request: PermissionBrokerRequest,
    options?: PermissionBrokerRequestOptions,
  ): Promise<PermissionBrokerResult>;
}
