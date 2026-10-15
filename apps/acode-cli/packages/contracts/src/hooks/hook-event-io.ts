// Hook 事件的输入 payload 与 hookSpecificOutput 契约（specs/hook-event-surface.md）。
// 从 index.ts 拆出的叶子文件：只依赖基础词汇叶子与 hook-event-names.ts，不回引 index，
// 公开 API 经 hooks/index.ts 的 `export *` 原样再导出。
import { z } from "zod";
import type { ModelToolSideEffectScope } from "../model/index.js";
// 架构断环（specs/architecture-contracts-module.md）：session.events 引用 hooks 的
// HookRunLifecyclePayload，本模块若经 session.port 取基础词汇即成环；改走叶子文件。
import type { CollaborationMode, RiskLevel } from "../interfaces/session-shared.js";
import type { PermissionUpdate } from "../interfaces/permission.port.js";
import type { SessionId, ToolCallId, TraceId, TurnId } from "../interfaces/shared.js";
// compact 只依赖 zod + interfaces/shared，不回引 hooks，无环。
import type { CompactTrigger } from "../compact/index.js";
import { HookEventName, type HookPermissionDecision } from "./hook-event-names.js";

export interface BaseHookInput {
  agentName?: string;
  cwd: string;
  hookEventName: HookEventName;
  mode: CollaborationMode;
  sessionId: SessionId;
  timestamp: string;
  traceId: TraceId;
  turnId?: TurnId;
}

export interface PreToolUseHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PreToolUse;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

export interface PermissionRequestHookInput extends BaseHookInput {
  permissionSuggestions?: PermissionUpdate[];
  hookEventName: typeof HookEventName.PermissionRequest;
  reason: string;
  requestId: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

export interface PostToolUseHookInput extends BaseHookInput {
  artifactRefs?: string[];
  hookEventName: typeof HookEventName.PostToolUse;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
  toolResponse: unknown;
  toolResultPreview: string;
}

export interface PostToolUseFailureHookInput extends BaseHookInput {
  error: {
    message: string;
    // TODO(闭集): 现为自由 string（CoreErrorType 或 Error.name）。待闭集错误词表
    // （WSB 波次，contracts/src/errors）落地后收敛为封闭枚举；见
    // specs/hook-event-surface.md F7。本文件刻意不 import 尚未存在的枚举。
    type: string;
  };
  hookEventName: typeof HookEventName.PostToolUseFailure;
  isInterrupt?: boolean;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

/** 一个并行组（batch）的全部工具调用结算后触发一次；通知类（specs/hook-event-surface.md）。 */
export interface PostToolBatchHookInput extends BaseHookInput {
  errorCount: number;
  hookEventName: typeof HookEventName.PostToolBatch;
  successCount: number;
  toolResults: Array<{
    durationMs?: number;
    success: boolean;
    toolCallId: ToolCallId | string;
    toolName: string;
  }>;
}

/** 压缩开始前（已确认可压缩、CompactStarted timeline 之前）；阻断类：block ⇒ 放弃压缩。 */
export interface PreCompactHookInput extends BaseHookInput {
  customInstructions?: string;
  hookEventName: typeof HookEventName.PreCompact;
  preCompactTokenCount?: number;
  trigger: CompactTrigger;
}

/** 压缩成功结算后一次（outcome=compacted）；通知类。 */
export interface PostCompactHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PostCompact;
  postCompactTokenCount?: number;
  preCompactTokenCount?: number;
  trigger: CompactTrigger;
}

/** 会话内模型切换 mutation 之前；阻断类：block ⇒ 保持 previous selection。 */
export interface PreModelSwitchHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PreModelSwitch;
  nextModel: string;
  previousModel?: string;
}

/** 模型切换已 set+persist 并发出 ModelSelected 之后；通知类。 */
export interface PostModelSwitchHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PostModelSwitch;
  nextModel: string;
  previousModel?: string;
}

/**
 * 会话结束。本波只落契约与配置面，触发点待 shutdown 链路接线
 * （specs/hook-event-surface.md F1/D3）。
 */
export interface SessionEndHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.SessionEnd;
  // TODO(闭集): reason 收敛依赖 shutdown 链路接线时一并定义（clear/exit/dispose/…）。
  reason: string;
}

/** turn 以失败/取消收口（TurnError outcome 之后、throw 之前）；通知类，绝不掩盖原错误。 */
export interface StopFailureHookInput extends BaseHookInput {
  cancelled: boolean;
  errorMessage: string;
  // TODO(闭集): 现为 CoreErrorType 或 Error.name 自由 string；待 WSB 闭集词表收敛（F7）。
  errorType: string;
  hookEventName: typeof HookEventName.StopFailure;
  toolCallCount?: number;
}

/** 后台任务（bash/subagent/workflow）登记开始；通知类、异步旁路。 */
export interface TaskCreatedHookInput extends BaseHookInput {
  description?: string;
  hookEventName: typeof HookEventName.TaskCreated;
  taskKind?: string;
  taskId: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
}

/** 后台任务进入终态（含 lost）；通知类、异步旁路。 */
export interface TaskCompletedHookInput extends BaseHookInput {
  description?: string;
  hookEventName: typeof HookEventName.TaskCompleted;
  taskKind?: string;
  taskId: string;
  // TODO(闭集): completed/failed/cancelled/killed/stopped/lost——待与 runtime-task
  // 终态词表统一收敛（F7 同批）。
  taskStatus: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
}

/** 会话执行 cwd 真实变化（bash cd 持久化）后；通知类、异步旁路（事实不可回滚）。 */
export interface CwdChangedHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.CwdChanged;
  newCwd: string;
  previousCwd: string;
}

export interface UserPromptSubmitHookInput extends BaseHookInput {
  attachmentsSummary?: string;
  hookEventName: typeof HookEventName.UserPromptSubmit;
  prompt: string;
}

export interface SessionStartHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.SessionStart;
  model?: string;
  source: "startup" | "resume" | "clear" | "compact";
}

export interface StopHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.Stop;
  responsePreview: string;
  responseText?: string;
  stopHookActive: boolean;
  toolCallCount: number;
}

export type HookInput =
  | PreToolUseHookInput
  | PermissionRequestHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | PostToolBatchHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | StopFailureHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | PreModelSwitchHookInput
  | PostModelSwitchHookInput
  | TaskCreatedHookInput
  | TaskCompletedHookInput
  | CwdChangedHookInput;

export type PermissionRequestHookDecision =
  | {
      behavior: "allow";
      permissionUpdates?: PermissionUpdate[];
      updatedPermissions?: PermissionUpdate[];
      updatedInput?: unknown;
    }
  | {
      behavior: "deny";
      interrupt?: boolean;
      message?: string;
    };

/** 通知类事件的通用 specific output：只允许回注 additionalContext。 */
type ContextOnlyHookSpecificOutput<TEvent extends HookEventName> = {
  additionalContext?: string;
  hookEventName: TEvent;
};

export type HookSpecificOutput =
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PreToolUse;
      permissionDecision?: HookPermissionDecision;
      permissionDecisionReason?: string;
      updatedInput?: unknown;
    }
  | ContextOnlyHookSpecificOutput<typeof HookEventName.UserPromptSubmit>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.SessionStart>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.PostToolUse>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.PostToolUseFailure>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.PostToolBatch>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.PreCompact>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.PostCompact>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.PreModelSwitch>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.PostModelSwitch>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.SessionEnd>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.StopFailure>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.TaskCreated>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.TaskCompleted>
  | ContextOnlyHookSpecificOutput<typeof HookEventName.CwdChanged>
  | {
      decision?: PermissionRequestHookDecision;
      hookEventName: typeof HookEventName.PermissionRequest;
    }
  | ContextOnlyHookSpecificOutput<typeof HookEventName.Stop>;

const PermissionRequestHookDecisionSchema = z.union([
  z.object({
    behavior: z.literal("allow"),
    permissionUpdates: z
      .array(
        z.object({
          type: z.literal("addRules"),
          behavior: z.enum(["allow", "deny", "ask"]),
          rules: z.array(
            z.object({
              toolName: z.string().min(1),
              ruleContent: z.string().optional(),
            }),
          ),
        }),
      )
      .optional(),
    updatedPermissions: z
      .array(
        z.object({
          type: z.literal("addRules"),
          behavior: z.enum(["allow", "deny", "ask"]),
          rules: z.array(
            z.object({
              toolName: z.string().min(1),
              ruleContent: z.string().optional(),
            }),
          ),
        }),
      )
      .optional(),
    updatedInput: z.unknown().optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    interrupt: z.boolean().optional(),
    message: z.string().optional(),
  }),
]);

/** 通知类事件共用同一 specific output 形状：可选 additionalContext + 事件名字面量。 */
function contextOnlyHookSpecificOutputSchema<const TEvent extends HookEventName>(event: TEvent) {
  return z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(event),
  });
}

export const HookSpecificOutputSchema = z.discriminatedUnion("hookEventName", [
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PreToolUse),
    permissionDecision: z.enum(["allow", "ask", "deny"]).optional(),
    permissionDecisionReason: z.string().optional(),
    updatedInput: z.unknown().optional(),
  }),
  contextOnlyHookSpecificOutputSchema(HookEventName.UserPromptSubmit),
  contextOnlyHookSpecificOutputSchema(HookEventName.SessionStart),
  contextOnlyHookSpecificOutputSchema(HookEventName.PostToolUse),
  contextOnlyHookSpecificOutputSchema(HookEventName.PostToolUseFailure),
  contextOnlyHookSpecificOutputSchema(HookEventName.PostToolBatch),
  contextOnlyHookSpecificOutputSchema(HookEventName.PreCompact),
  contextOnlyHookSpecificOutputSchema(HookEventName.PostCompact),
  contextOnlyHookSpecificOutputSchema(HookEventName.PreModelSwitch),
  contextOnlyHookSpecificOutputSchema(HookEventName.PostModelSwitch),
  contextOnlyHookSpecificOutputSchema(HookEventName.SessionEnd),
  contextOnlyHookSpecificOutputSchema(HookEventName.StopFailure),
  contextOnlyHookSpecificOutputSchema(HookEventName.TaskCreated),
  contextOnlyHookSpecificOutputSchema(HookEventName.TaskCompleted),
  contextOnlyHookSpecificOutputSchema(HookEventName.CwdChanged),
  z.object({
    decision: PermissionRequestHookDecisionSchema.optional(),
    hookEventName: z.literal(HookEventName.PermissionRequest),
  }),
  contextOnlyHookSpecificOutputSchema(HookEventName.Stop),
]);
