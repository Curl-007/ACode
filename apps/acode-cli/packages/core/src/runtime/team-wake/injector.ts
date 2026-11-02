// 宿主团队唤醒注入器（apps/acode-cli/specs/host-team-wake.md R5/R6）：合成注入文本并
// 并入队 runtime 命令（mode: "team-wake"）。命令**不经** v4 CommandInbox——唤醒不是用户
// 输入，没有 commandId/admission/CAS 语义；复用 runtime 层 FIFO（与 subagent-message 同档）。
import { createMessageId, createRootTraceContext } from "../deps.js";
import type { MessageId } from "../deps.js";
import { createRuntimeCommandId, type TeamWakeRuntimeCommand } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { getRuntimeBranchRestorePort } from "../turn-coordination.js";
import type { TeamWakeInjectionPlan } from "./owner.js";

/** 成员名约束（与插件 MEMBER_NAME_PATTERN 同形）：无法携带任意载荷，注入是结构事实。 */
const MEMBER_NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
/** 注入文本最多点名的成员数（防止畸形快照把 body 撑爆）。 */
const MAX_INLINE_MEMBERS = 8;

function sanitizeMemberName(name: string): string | undefined {
  return MEMBER_NAME_PATTERN.test(name) ? name : undefined;
}

function collectMemberNames(plan: TeamWakeInjectionPlan): string[] {
  const names = new Set<string>();
  for (const message of plan.messages) {
    const name = sanitizeMemberName(message.from);
    if (name) names.add(name);
  }
  for (const task of plan.settledTasks) {
    const name = sanitizeMemberName(task.owner);
    if (name) names.add(name);
  }
  return [...names].slice(0, MAX_INLINE_MEMBERS);
}

/**
 * 自撰结构化事实块（R6）：只含 teamId、触发器、计数、messageId 列表、任务终态与成员名
 * （受 MEMBER_NAME_PATTERN 约束），**不内联成员原文**——原文仍在磁盘 mailbox，队长经
 * `agent_teams_status` 的 trust-wrapper 读边界后才进模型上下文。
 */
export function buildTeamWakeCommandText(plan: TeamWakeInjectionPlan): string {
  const lines = [
    "Host team-wake event.",
    `Team: ${plan.teamId}`,
    `Triggers: ${plan.triggers.join(", ")}`,
    `Captain unread messages: ${plan.messages.length}${formatMessageIds(plan.messages)}`,
    `Settled member tasks: ${plan.settledTasks.length}${formatSettledTasks(plan.settledTasks)}`,
  ];
  const members = collectMemberNames(plan);
  if (members.length > 0) lines.push(`Members involved: ${members.join(", ")}`);
  if (plan.truncated) lines.push("Note: the event list was truncated by the plugin snapshot cap.");
  lines.push(
    "Next step: call agent_teams_status to read the team inbox (trust-wrapped bodies) and continue scheduling.",
  );
  return lines.join("\n");
}

function formatMessageIds(messages: TeamWakeInjectionPlan["messages"]): string {
  if (messages.length === 0) return "";
  return ` (messageIds: ${messages.map((message) => message.messageId).join(", ")})`;
}

function formatSettledTasks(tasks: TeamWakeInjectionPlan["settledTasks"]): string {
  if (tasks.length === 0) return "";
  const rendered = tasks.map((task) => `${task.taskId}(${task.status})`).join(", ");
  return ` (taskIds: ${rendered})`;
}

/** 把唤醒计划物化成 runtime 命令并入队（空闲即开轮 / 忙碌留队，R5）。 */
export function enqueueTeamWakeCommand(
  this: AgentRuntimeInternal,
  plan: TeamWakeInjectionPlan,
  branchGeneration: number,
): void {
  const text = buildTeamWakeCommandText(plan);
  const command = {
    branchGeneration,
    captainSessionId: plan.captainSessionId,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    messageIds: plan.messages.map((message) => message.messageId),
    mode: "team-wake" as const,
    priority: "next" as const,
    settledTaskIds: plan.settledTasks.map((task) => task.taskId),
    source: "team_wake" as const,
    teamId: plan.teamId,
    text,
    traceContext: createRootTraceContext({ sessionId: this.sessionId }),
    triggers: plan.triggers,
    wakeGeneration: plan.generation,
  } satisfies TeamWakeRuntimeCommand;
  this.logger?.debug("Team wake enqueued into runtime command queue", {
    captainSessionId: plan.captainSessionId,
    commandId: command.id,
    event: "team_wake.runtime_enqueued",
    generation: plan.generation,
    messageCount: command.messageIds.length,
    module: "core.runtime",
    settledTaskCount: command.settledTaskIds.length,
    teamId: plan.teamId,
    triggers: plan.triggers,
  });
  this.enqueueRuntimeCommand(command);
}

/**
 * 持久化合成 model-only notice 并写回历史（照 subagent-message 先例）。
 * 分支陈旧时 `persistNotificationIfCurrent` 返回 null——调用方据此丢弃命令。
 */
export async function persistTeamWakeCommand(
  this: AgentRuntimeInternal,
  command: TeamWakeRuntimeCommand,
): Promise<MessageId | null> {
  return await getRuntimeBranchRestorePort(this).persistNotificationIfCurrent(
    command.branchGeneration,
    async () => {
      await this.ensureContextInitialized(command.traceContext);
      const messageID = createMessageId();
      const inputPresentation = "team_wake";
      this.messageHistory.addUser(command.text, runtimeInputMetadata(inputPresentation));
      await this.persistSyntheticUserNoticeForSession({
        messageID,
        sessionId: this.sessionId,
        source: "team_wake",
        text: command.text,
        traceContext: command.traceContext,
        visibility: "model-only",
        metadata: {
          inputPresentation,
          teamWake: {
            captainSessionId: command.captainSessionId,
            generation: command.wakeGeneration,
            messageIds: command.messageIds,
            settledTaskIds: command.settledTaskIds,
            teamId: command.teamId,
            triggers: command.triggers,
          },
        },
      });
      return messageID;
    },
  );
}