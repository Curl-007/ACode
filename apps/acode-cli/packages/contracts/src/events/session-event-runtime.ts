// ============================================================
// Session Event runtime payloads - workflow/swarm/plugin/permission/hook/target 载荷
// ============================================================
// 例外债务偿还（2026-10-28，batch B）：session.events.ts（1373 行）按主题拆叶，
// 本文件承载运行时载荷：dynamic workflow run 进度、插件状态、swarm plan、权限、
// 用户输入自动放行、workspace hook 复核、target 变更与目标完成校验。
// 断环纪律：RiskLevel / PermissionDecision 等取自叶子文件（permission.port / session-shared）。
// 依赖方向（DAG）：shared.js / permission.port / session-shared / tools/target /
// tools/tool-result-metadata → 本文件 → factory 叶 → session.events.ts 桶。
// 注：ToolResultDisplayPayload 由 PermissionRequestedPayload.display 使用（原文件同名导入）。
// ToolResultDisplayPayload 在 support→workflow-launch 链之外，本叶直接引 tools 叶。

import type {
  InteractionRequestOrigin,
  MessageId,
  ToolCallId,
  TurnId,
} from "../interfaces/shared.js";
import type {
  PermissionDecision,
  PermissionOptionsPolicy,
  PermissionUpdate,
} from "../interfaces/permission.port.js";
import type { RiskLevel } from "../interfaces/session-shared.js";
import type { GoalCompletionVerificationOutput, SessionGoal } from "../tools/target.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";

/**
 * 一条 workflow run 进度事件（父会话）。字段与 {@link DynamicWorkflowRunEvent} 同形——
 * **一次序列化、两个消费者**：`listEvents` 的事件页与这里的会话事件用同一个有界载荷，
 * 读端因此不需要两套解释规则。`type` 已被会话事件信封占用，故引擎事件种类叫 `eventType`。
 */
export interface DynamicWorkflowRunProgressPayload {
  runId: string;
  /** 发起这次 run 的 CreateWorkflow 工具调用（工具卡 → 详情页的关联键）。 */
  toolCallId?: ToolCallId | string;
  /** journal sequence（`appendEvent` 单调分配）；事件日志的 cursor 与它同一把尺。 */
  sequence: number;
  /** 引擎事件种类：run-started / actor-created / node-* / usage-updated / log / report / phase-entered / run-settled。 */
  eventType: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
  /** 派生字段（toProgressPayload）：`actor-created` 上该子代理会话的 id（driver 铸的 `sess_dwf-…`）。 */
  actorSessionId?: string;
  /**
   * 派生字段（与 `actorSessionId` 同类，见 toProgressPayload）：该 run 的 `run-launched.inputId`。
   * 只挂在 `actor-created` / `run-settled` 两种事件上，供下游把子代理归到发起 run 的那一轮。升级前的 run 没有 `run-launched`，字段缺席。
   */
  launchInputId?: string;
}

/**
 * 插件 MCP server 投递的自定义状态快照（通用通道，非 AgentTeams 专有）。
 * server 侧用标准 `notifications/message` logging 通知、logger 取
 * `acode-plugin-state:<plugin>`；宿主 adapter 只透传不解释，`state` 归插件命名空间。
 * v4 投影按 `pluginStates[pluginId + ":" + key]` 键级整体替换。
 */
export interface PluginStateUpdatedPayload {
  /** 插件身份（adapter 注入，来自本地 plugin registry，server 不可伪造 official 身份）。 */
  pluginId: string;
  /** 插件侧状态主题（如 "agent-teams"）；快照键 = pluginId + ":" + key。 */
  key: string;
  /** 快照内容（插件所有；UI 端按 pluginId+key 选择解释器）。 */
  state: unknown;
}

/**
 * 一条 swarm plan 提交投影事件（父会话；specs/swarm-observability-projection.md R2/R7）。
 * 字段与 shared 的 swarmPlanStateSchema 同形——**一次序列化、两个消费者**（listEvents 的
 * 事件页与 v4 swarmPlan 状态键用同一个有界载荷）。编译期闸在 bootstrap 的载荷 mapper
 * （core 状态视图 → 本载荷的 typed 赋值），运行期闸是 shared reducer 的 safeParse。
 * `cleared: true` 时状态视图字段缺席（清除事件只带代际信息）。
 */
export interface SwarmPlanProgressPayload {
  /** plan 清除（代际终局）：为 true 时以下状态视图字段全部缺席。 */
  cleared?: boolean;
  /** 代际键（re-seed = 新代际；版本去重只在同代际内做）。 */
  createdAtMs?: number;
  goal?: string;
  mode?: "light" | "deep";
  version?: number;
  noArtifactRequeues?: number;
  terminalState?: "completed" | "stalled" | "active";
  counts?: {
    done: number;
    failed: number;
    gates: number;
    queued: number;
    running: number;
    stalled: number;
  };
  readyGateIds?: string[];
  readyWorkerIds?: string[];
  stalledNodeIds?: string[];
  nodes?: Array<{
    id: string;
    kind: "explore" | "implement" | "verify" | "fix" | "synthesize" | "critique";
    status: "queued" | "running" | "done" | "failed";
    isGate: boolean;
    origin: "seed" | "expand" | "gap" | "gate";
    owner: string | null;
    priority: number;
    dependsOn: string[];
    expanded: boolean;
    artifactRequeues: number;
    /** 节点 content 的有界预览（≤160 字符）；全文走 PlanStatus 工具面。 */
    contentPreview?: string;
  }>;
  /** nodes 触到上限被截断（原始事实仍在 plan 行）。 */
  truncated?: boolean;
  updatedAtMs?: number;
}

export interface PermissionRequestedPayload {
  requestId?: string;
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: RiskLevel;
  reason: string;
  input: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /**
   * 工具自报的确认预览，由 `prepareApproval` 钩子产出。复用结果通道的 display 投影，
   * 让 ask 与结果卡共享同一套有界形状，不新增无界字段。
   */
  display?: ToolResultDisplayPayload;
  fullAccessSupported?: boolean;
  optionsPolicy?: PermissionOptionsPolicy;
}

export interface PermissionResolvedPayload {
  requestId?: string;
  toolCallId: ToolCallId;
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
}

export interface PermissionDeniedPayload {
  toolCallId: ToolCallId;
  toolName: string;
  reason: string;
  inputSummary?: unknown;
}

export type UserInputAutoResolutionState =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

export interface UserInputAutoResolutionUpdatedPayload {
  interactionId: string;
  toolCallId: ToolCallId;
  autoResolution: UserInputAutoResolutionState;
}

export interface WorkspaceHookReviewRequestedPayload {
  request: unknown;
}

export interface WorkspaceHookReviewSettledPayload {
  interactionId: string;
  state: "resolved" | "timed_out" | "configuration_error";
  reasonCode?: string;
}

export interface WorkspaceHookReviewSupersededPayload {
  interactionId: string;
  supersededByInteractionId: string;
}

// 软门禁:准入层完成评估后上报 pending 状态。
// pendingCount = configuredEnabled && admissionClass === "pending" 的声明数;
// pendingCount === 0 → 投影层将 snapshot.workspaceHookAdmission 置 null(提示条消失)。
export interface WorkspaceHookAdmissionUpdatedPayload {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

export type TargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";

export type TargetChangedSource = "command" | "tool" | "runtime";

export interface TargetChangedPayload {
  action: TargetChangedAction;
  source: TargetChangedSource;
  target: SessionGoal | null;
  previousTarget?: SessionGoal | null;
}

export type TargetCompletionVerificationStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";

export interface TargetCompletionVerificationPayload {
  targetId: string;
  status: TargetCompletionVerificationStatus;
  verificationId: string;
  /** 与触发该验证的前台 runtime command 共用，供 Stop 做 stale guard。 */
  foregroundExecutionId?: string;
  /** sendQueuedNow 抢占 verifier 时只暂停 goal，不暂停 future queue。 */
  preserveQueueAutoDrainOnCancel?: boolean;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
}
