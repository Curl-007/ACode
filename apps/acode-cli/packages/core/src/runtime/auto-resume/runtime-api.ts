// runtime 接线面（specs/turn-auto-resume.md「状态所有者」）：coordinator 的 per-runtime
// 惰性单例（模块私有 WeakMap，唯一所有者 = 本模块；不进 internal.ts 状态簇）、观察挂点
// 的 containment 包装（通知失败绝不改变 turn 失败路径语义）、以及公开命令面方法。
import type { SessionTaskType, TraceContext } from "../deps.js";
import { CoreErrorType, isCoreError } from "../deps.js";
import { projectExecutionErrorPayload } from "../../errors/error-payload.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ExecuteTurnOptions } from "../types.js";
import { AutoResumeCoordinator } from "./coordinator.js";
import { runAutoResumeInjection } from "./injector.js";
import { emitAutoResumeScheduledStatus } from "./status-event.js";
import { resolveAutoResumeConfig } from "./types.js";
import type {
  AutoResumeFailureFacts,
  AutoResumeInjectionContext,
  AutoResumeRuntimeCommand,
  AutoResumeSettlement,
  AutoResumeStatusSnapshot,
} from "./types.js";

/**
 * 子代理/工作流 child 会话：turn 失败的收口归各自 supervisor（subagent runner /
 * dwf engine）所有——auto-resume 在失败后再注入新 turn 会与 supervisor 的结算竞态
 * 双写，故整档不干预（主会话/交互 fork/side chat 不受影响）。
 */
const CHILD_SESSION_TASK_TYPES: ReadonlySet<SessionTaskType> = new Set<SessionTaskType>([
  "subagent_child",
  "workflow_child",
  "nested_workflow_child",
]);

const coordinators = new WeakMap<AgentRuntimeInternal, AutoResumeCoordinator>();

export function getAutoResumeCoordinator(runtime: AgentRuntimeInternal): AutoResumeCoordinator {
  const existing = coordinators.get(runtime);
  if (existing) return existing;
  let coordinator: AutoResumeCoordinator;
  coordinator = new AutoResumeCoordinator({
    sessionId: runtime.sessionId,
    now: () => runtime.now().getTime(),
    getConfig: () => resolveAutoResumeConfig(runtime.config.autoResume),
    isChildSession: () =>
      runtime.config.taskType !== undefined &&
      CHILD_SESSION_TASK_TYPES.has(runtime.config.taskType),
    // 触发前重查最新会话状态：shutdown、active turn、队列/drain/reservation 任一在场
    // 都说明用户或系统已接管，放弃注入。
    isSessionInjectable: () => !runtime.shuttingDown && !runtime.hasActiveOrQueuedTurnWork(),
    inject: (plan) =>
      runAutoResumeInjection(runtime, plan, coordinator.getStatus().continueMessage),
    emitScheduled: ({ delayMs, plan }) => emitAutoResumeScheduledStatus(runtime, { delayMs, plan }),
    ...(runtime.logger
      ? {
          logger: {
            info: (message, fields) => runtime.logger?.info(message, fields),
            warn: (message, fields) => runtime.logger?.warn(message, fields),
          },
        }
      : {}),
  });
  coordinators.set(runtime, coordinator);
  return coordinator;
}

/**
 * turn 失败观察挂点（turn.ts 失败路径 throw 前 await）：取消走重置档；真实失败分类后
 * 排定退避。containment——coordinator/事件面异常只 warn，不改变既有事件语义、不吞
 * 原始 turn error（调用方随后仍 throw coreError）。
 */
export async function notifyAutoResumeTurnFailure(
  runtime: AgentRuntimeInternal,
  input: {
    coreError: unknown;
    traceContext: TraceContext;
    turnOptions?: ExecuteTurnOptions;
  },
): Promise<void> {
  try {
    if (isCoreError(input.coreError) && input.coreError.type === CoreErrorType.TurnCancelled) {
      getAutoResumeCoordinator(runtime).notifyTurnSettled("cancelled");
      return;
    }
    await getAutoResumeCoordinator(runtime).notifyTurnFailure(
      buildAutoResumeFailureFacts(input.coreError),
      buildAutoResumeInjectionContext(input.turnOptions, input.traceContext),
    );
  } catch (error) {
    runtime.logger?.warn("Auto-resume failure notification failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "auto_resume.notify_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

/** 成功 turn / 预算结局通知（TurnComplete 收口路径）。 */
export function notifyAutoResumeTurnSettled(
  runtime: AgentRuntimeInternal,
  settlement: AutoResumeSettlement,
): void {
  try {
    getAutoResumeCoordinator(runtime).notifyTurnSettled(settlement);
  } catch {
    // 重置通知失败不影响 turn 收口；下次失败通知会重新惰性构造。
  }
}

/** 新用户输入被 admission（prompt-admission.ts 用户来源路径）：用户已接管，链清零。 */
export function notifyAutoResumeUserInputAdmitted(runtime: AgentRuntimeInternal): void {
  try {
    getAutoResumeCoordinator(runtime).notifyUserInputAdmitted();
  } catch {
    // 同上：重置通知失败不影响 admission。
  }
}

/** 停止命令/前台执行 abort：用户显式取消语义。 */
export function abortAutoResumeChain(runtime: AgentRuntimeInternal, reason: string): void {
  try {
    // 未曾创建 coordinator（本会话从未失败过）时不构造，避免 stop 路径无谓分配。
    coordinators.get(runtime)?.abortChain(reason);
  } catch {
    // containment 同上。
  }
}

/** 会话关闭/进程退出：取消 pending 定时器并终结 coordinator。 */
export function disposeAutoResumeCoordinator(runtime: AgentRuntimeInternal): void {
  try {
    coordinators.get(runtime)?.dispose();
  } catch {
    // containment 同上。
  }
}

// ── 公开命令面（agent-runtime.ts 的 AgentRuntime 接口 optional 成员，经
// methods/index.ts 安装到原型；/auto-resume 命令模块与 v4 handler leaf 消费）──

export function getAutoResumeStatus(this: AgentRuntimeInternal): AutoResumeStatusSnapshot {
  return getAutoResumeCoordinator(this).getStatus();
}

export function applyAutoResumeCommand(
  this: AgentRuntimeInternal,
  input: AutoResumeRuntimeCommand,
): void {
  getAutoResumeCoordinator(this).applyCommand(input);
}

/**
 * 公开命令面的原型装配（methods/index.ts 只留一行调用，避免 install 清单继续膨胀）。
 * 与 installAgentRuntimeMethods 同款：把 this-方法挂到 AgentRuntime.prototype。
 */
export function installAutoResumeRuntimeMethods(proto: Record<string, unknown>): void {
  proto.getAutoResumeStatus = getAutoResumeStatus;
  proto.applyAutoResumeCommand = applyAutoResumeCommand;
}

function buildAutoResumeFailureFacts(coreError: unknown): AutoResumeFailureFacts {
  const coreErrorType = isCoreError(coreError) ? coreError.type : CoreErrorType.UnknownError;
  // projectExecutionErrorPayload 是仓库既有的结构化归因投影（TurnError payload 同源）：
  // reason 已过闭集收窄、retryable 只认非 wrapper 帧与 context 显式布尔。
  const projection = projectExecutionErrorPayload(coreError);
  return {
    coreErrorType,
    ...(projection.attribution ? { attribution: projection.attribution } : {}),
  };
}

function buildAutoResumeInjectionContext(
  turnOptions: ExecuteTurnOptions | undefined,
  traceContext: TraceContext,
): AutoResumeInjectionContext {
  return {
    // 安全红线：无人值守身份与工具面/execution 模型选择原样透传给注入 turn。
    ...(turnOptions?.automationId ? { automationId: turnOptions.automationId } : {}),
    ...(turnOptions?.offPeakTaskId
      ? {
          offPeakTaskId: turnOptions.offPeakTaskId,
          ...(turnOptions.offPeakRunType ? { offPeakRunType: turnOptions.offPeakRunType } : {}),
        }
      : {}),
    ...(turnOptions?.toolDisallowlist ? { toolDisallowlist: turnOptions.toolDisallowlist } : {}),
    ...(turnOptions?.modelExecution ? { modelExecution: turnOptions.modelExecution } : {}),
    traceContext,
  };
}
