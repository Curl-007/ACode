import type { ACodePermissionOption, ACodePermissionRequest } from "@acode/shared";

/**
 * Bot 任务权限的桌面兜底批准路径（纯函数层）。
 *
 * 背景：bot 权限请求经 bots:task / bots:task-stream 广播回放进 acodeSessionStore
 * （taskUiByTaskId[taskId].permissionRequest + pendingPermissionRequests 队列），
 * 但 V4InteractionDialogs 只消费当前打开 session 的 v4 snapshot。订阅不健康或
 * 事件竞态时（elicitation 已有同类 bugfix 先例），桌面就没有批准出口。
 * 规格见 packages/services/specs/bot-permission-local-approval.md R1。
 *
 * 权威状态仍是 CLI interaction-broker：snapshot 与 store 同时含同一请求时
 * snapshot 路径优先（interactionId ≡ 业务 requestId，broker 同源注册），
 * 这里只负责按 requestId 去重后选出兜底候选。
 */

/** snapshot 中待渲染交互的最小结构投影，仅用于去重判断。 */
export interface SnapshotPendingInteractionRef {
  interactionId: string;
  payload: { kind: string };
}

export interface TaskPermissionQueueState {
  permissionRequest: ACodePermissionRequest | null;
  pendingPermissionRequests: ACodePermissionRequest[];
}

export function selectFallbackPermissionRequest(
  snapshotPending: readonly SnapshotPendingInteractionRef[] | undefined,
  storeState: TaskPermissionQueueState,
): ACodePermissionRequest | null {
  const snapshotPermissionIds = new Set(
    (snapshotPending ?? [])
      .filter((interaction) => interaction.payload.kind === "permission")
      .map((interaction) => interaction.interactionId),
  );
  const queue: ACodePermissionRequest[] = [];
  if (storeState.permissionRequest) {
    queue.push(storeState.permissionRequest);
  }
  for (const item of storeState.pendingPermissionRequests ?? []) {
    // setTaskPermissionRequest 保证 head 与队列不重叠，但广播回放与本地乐观清理
    // 可能短暂共存，按 requestId 去重，避免同一请求被渲染两次。
    if (item && !queue.some((existing) => existing.requestId === item.requestId)) {
      queue.push(item);
    }
  }
  for (const candidate of queue) {
    if (!snapshotPermissionIds.has(candidate.requestId)) {
      return candidate;
    }
  }
  return null;
}

export interface TaskRespondPermissionParams {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  requestId: string;
  optionId: string;
  response: ACodePermissionOption["response"];
}

export function buildTaskRespondPermissionParams(input: {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  request: ACodePermissionRequest;
  option: ACodePermissionOption;
}): TaskRespondPermissionParams {
  return {
    taskId: input.taskId,
    workspacePath: input.workspacePath,
    // 远程 workspace 的身份隔离要求贯穿传递 workspaceIdentity，不能仅按路径匹配。
    ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
    requestId: input.request.requestId,
    optionId: input.option.optionId,
    // adapter 不将 response 上 wire（CLI 按 optionId 精确回映完整 response），
    // 参数形状与 botsService 的 respondPermission 调用保持一致。
    response: input.option.response,
  };
}
