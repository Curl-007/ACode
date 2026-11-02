// runtime 接线面（apps/acode-cli/specs/host-team-wake.md R4）：owner 的 per-runtime 惰性
// 单例（模块私有 WeakMap，唯一所有者 = 本模块；不进 internal.ts 状态簇）、公开命令面
// `applyTeamWakeIntent`，以及 drain 侧消费回调。照 auto-resume 的 runtime-api 纪律。
import type { AgentRuntimeInternal } from "../internal.js";
import type { TeamWakeRuntimeCommand } from "../command-queue.js";
import { enqueueTeamWakeCommand } from "./injector.js";
import { TeamWakeOwner } from "./owner.js";
import { resolveTeamWakeConfig } from "./types.js";
import type { TeamWakeIntent } from "./types.js";

const owners = new WeakMap<AgentRuntimeInternal, TeamWakeOwner>();

/** owner 惰性构造（module-private WeakMap）：同一 runtime 上唯一；不跨 runtime 共享计数。 */
export function getTeamWakeOwner(runtime: AgentRuntimeInternal): TeamWakeOwner {
  const existing = owners.get(runtime);
  if (existing) return existing;
  const owner = new TeamWakeOwner({
    getConfig: () => resolveTeamWakeConfig(runtime.config.agentTeams?.hostWake),
    now: () => runtime.now().getTime(),
  });
  owners.set(runtime, owner);
  return owner;
}

/**
 * 公开命令面（AgentRuntime optional 成员，经 methods/index.ts 一行装配）：bootstrap 在
 * 落 PluginStateUpdated 事件后，把已规范化的 intent 交给队长 runtime。owner 决策为
 * enqueued 时入队 team-wake 命令（空闲即开轮 / 忙碌留队）；skip 只 debug 记录（
 * disabled/expired/empty 等不是错误，投影面另有 wakeHint 提示）。
 */
export function applyTeamWakeIntent(this: AgentRuntimeInternal, intent: TeamWakeIntent): void {
  const owner = getTeamWakeOwner(this);
  let decision: ReturnType<TeamWakeOwner["applyIntent"]>;
  try {
    decision = owner.applyIntent(intent);
  } catch (error) {
    this.logger?.warn("Team wake intent failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "team_wake.intent_failed",
      module: "core.runtime",
      teamId: intent.teamId,
    });
    return;
  }
  if (decision.kind === "skipped") {
    this.logger?.debug("Team wake intent skipped", {
      event: "team_wake.intent_skipped",
      generation: decision.generation,
      module: "core.runtime",
      reason: decision.reason,
      teamId: decision.teamId,
    });
    return;
  }
  enqueueTeamWakeCommand.call(this, decision.plan, this.branchGeneration);
}

/** drain 消费成功后的 ack 回写（consume-on-inject，R9）。 */
export function completeTeamWakeDelivery(
  runtime: AgentRuntimeInternal,
  command: TeamWakeRuntimeCommand,
): void {
  try {
    getTeamWakeOwner(runtime).completeDelivery({
      generation: command.wakeGeneration,
      messageIds: command.messageIds,
      settledTaskIds: command.settledTaskIds,
      teamId: command.teamId,
    });
  } catch {
    // containment：ack 回写失败不改变 turn 收口语义。
  }
}

/** 命令未注入（陈旧分支 / 空触发）时清 pending，使下一次通知可重排。 */
export function dropTeamWakePending(runtime: AgentRuntimeInternal, teamId: string): void {
  try {
    getTeamWakeOwner(runtime).dropPending(teamId);
  } catch {
    // containment 同上。
  }
}

/** 成功 turn / 用户输入 admission 的重置档（R7）：清唤醒计数与重试档，不动已 ack 事实。 */
export function notifyTeamWakeTurnSettled(runtime: AgentRuntimeInternal): void {
  try {
    owners.get(runtime)?.resetChain();
  } catch {
    // containment：重置失败不影响 turn 收口。
  }
}

/** 公开命令面的原型装配（methods/index.ts 只留一行调用）。 */
export function installTeamWakeRuntimeMethods(proto: Record<string, unknown>): void {
  proto.applyTeamWakeIntent = applyTeamWakeIntent;
}