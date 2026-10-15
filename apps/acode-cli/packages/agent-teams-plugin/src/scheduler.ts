import { computeReadyTaskIds, isTaskReady, tasksBlockedByFailedQuality } from "./state/dag.js";
import type { TeamState, TeamTask } from "./state/types.js";
import { CAPTAIN_ADDRESS } from "./state/types.js";

/**
 * 指令式调度器（PRD §11）：插件无法调用宿主 Agent 工具，唤醒的执行者是队长模型——
 * 因此每次工具调用后把「唤醒谁、传什么」压缩成机械指令（next_actions），协议要求
 * 队长原样执行 SendMessage。wake 指令纯派生、无副作用，漏执行只延迟不破坏一致性。
 */

export interface WakeInstruction {
  /** SendMessage 的 to（Agent 工具返回的 agentId）。 */
  to: string;
  member: string;
  /** 派工消息正文：任务契约要点，协议要求原样传递、不得转述省略。 */
  message: string;
  taskId: string;
}

export interface NextActions {
  wake: WakeInstruction[];
  notes: string[];
  /** true：提示成员用 RespondToCoordinator 回报队长。 */
  report_to_captain: boolean;
}

export function computeNextActions(params: {
  team: TeamState;
  tasks: readonly TeamTask[];
  perspective: "captain" | "member";
  viewerMemberName?: string;
}): NextActions {
  const { team, tasks } = params;
  if (team.status === "draft" || team.status === "paused" || team.status === "archived") {
    return { wake: [], notes: [teamStatusNote(team.status)], report_to_captain: false };
  }

  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const readyIds = computeReadyTaskIds(tasks);
  const busyMembers = new Set(
    tasks
      .filter((task) => task.status === "in_progress")
      .map((task) => task.attempts.find((attempt) => attempt.id === task.activeAttemptId)?.owner)
      .filter((owner): owner is string => owner !== undefined),
  );

  const wake: WakeInstruction[] = [];
  const notes: string[] = [];

  // 1) 已指派的就绪任务 → 指派对象优先。
  // 2) 无主就绪任务（taskId 升序）→ 空闲且已 bind 的成员。
  const unassignedReady = readyIds
    .map((taskId) => tasksById.get(taskId))
    .filter((task): task is TeamTask => task !== undefined && !task.assignee)
    .filter((task) => isTaskReady(task, tasksById));

  const idleBoundMembers = team.members.filter(
    (member) =>
      member.status === "bound" &&
      member.agentId &&
      !busyMembers.has(member.name) &&
      member.name !== params.viewerMemberName,
  );

  for (const task of unassignedReady) {
    const member = idleBoundMembers.shift();
    if (!member) {
      notes.push(`Ready task ${task.taskId} has no idle bound member; captain may claim it.`);
      continue;
    }
    wake.push(buildWake(member, task));
  }

  for (const taskId of readyIds) {
    const task = tasksById.get(taskId);
    if (!task?.assignee) continue;
    const member = team.members.find((item) => item.name === task.assignee);
    if (!member) {
      notes.push(`Ready task ${taskId} is assigned to unknown member ${task.assignee}.`);
      continue;
    }
    if (busyMembers.has(member.name)) continue;
    if (member.status !== "bound" || !member.agentId) {
      notes.push(`Ready task ${taskId} is assigned to ${member.name} which is not bound yet; spawn and bind first.`);
      continue;
    }
    wake.push(buildWake(member, task));
  }

  for (const blocked of tasksBlockedByFailedQuality(tasks)) {
    notes.push(
      `Task ${blocked.taskId} is blocked by failed quality gate(s) ${blocked.blockedBy.join(", ")}; create a repair task that depends on the reviewed task, not the failed review.`,
    );
  }

  const unbound = team.members.filter((member) => member.status === "registered");
  if (unbound.length > 0) {
    notes.push(
      `Members not bound yet: ${unbound.map((member) => member.name).join(", ")} (spawn via Agent tool, then bind).`,
    );
  }

  return {
    wake,
    notes,
    // 成员视角：完成任务后必须回报队长，让队长推进调度。
    report_to_captain: params.perspective === "member",
  };
}

function buildWake(member: { name: string; agentId?: string }, task: TeamTask): WakeInstruction {
  return {
    to: member.agentId ?? "",
    member: member.name,
    taskId: task.taskId,
    message: [
      `任务 ${task.taskId} 已就绪，指派给你（${member.name}）。`,
      `标题：${task.title}`,
      `目标：${task.objective}`,
      `验收标准：`,
      ...task.acceptance.map((item, index) => `${index + 1}. ${item}`),
      `先用 agent_teams_claim_task 认领（taskId: ${task.taskId}），完成后用 agent_teams_update_task 更新并按返回指令回报。`,
    ].join("\n"),
  };
}

function teamStatusNote(status: TeamState["status"]): string {
  switch (status) {
    case "draft":
      return "Team is in draft: present roster and task DAG to the user for approval; call agent_teams_approve_plan after user confirms.";
    case "paused":
      return "Team is paused: call agent_teams_resume with a reason to continue.";
    case "archived":
      return "Team is archived: all team tools are closed.";
    default:
      return "";
  }
}

export function buildDispatchMessage(params: {
  task: TeamTask;
  memberName: string;
}): string {
  return buildWake({ name: params.memberName }, params.task).message;
}

export function captainAddress(): string {
  return CAPTAIN_ADDRESS;
}
