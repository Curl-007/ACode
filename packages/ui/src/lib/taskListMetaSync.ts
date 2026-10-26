import type { ACodeTaskMeta } from "@acode/shared";
import type { ACodeTaskListSortBy } from "@acode/services";
import { mergeTaskMetaCandidates } from "@/lib/acodeTaskMetaMerge.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { getTaskMeta, useACodeSessionStore } from "@/store/acodeSessionStore.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import {
  applyTaskQueryCacheMutation,
  removeTaskFromTaskQueryCaches,
  updateTaskQueryCacheTaskMetaPreservingMembership,
  upsertTaskQueryCacheTaskMeta,
  useTaskQueryCacheStore,
  type TaskListMembershipState,
} from "@/store/taskQueryCacheStore.js";

// ─────────────────────────────────────────────────────────────────────────────
// task meta 单一事务写入路径（specs/task-meta-cache-ownership.md）
//
// Bugfix(R2-06): 同一 task meta 存于四个 store 副本——acodeSessionStore 的
// optimistic 池 / taskListCache、taskQueryCacheStore.taskMetaByEntityKey、
// remoteTimelineTaskStore、remotePinnedTaskStore。此前组件在单个 handler 内
// 手写 3-4 条独立 store 写入 + 直调 applyTaskQueryCacheMutation（全仓 40 处），
// 乐观失败回滚路径极易漏写某一副本造成 drift。这里把「一次成员关系迁移」的
// 全部副本写入收进单一事务函数：组件只声明各副本的放置意图，写入顺序、
// workspaceIdentity gating、query cache mutation 收尾全部在此固定。
// ─────────────────────────────────────────────────────────────────────────────

/** 单个 task meta 副本的放置意图；`none`（默认）表示本次迁移不触碰该副本。 */
export type TaskMetaPlacement = "upsert" | "remove" | "none";

export interface TaskMetaCacheWrite {
  workspacePath: string;
  /** 远端 workspace 身份；缺失时 remoteTimeline/remotePinned 副本写入被跳过（本地无远端缓存）。 */
  workspaceIdentity?: string;
  taskId: string;
  /** 迁移前的 task meta，用于 query cache 成员关系差分。 */
  previousTask: ACodeTaskMeta;
  /** 迁移后的 task meta；所有 upsert 副本（optimistic/remote）统一写入此值。 */
  nextTask: ACodeTaskMeta;
  previousState: TaskListMembershipState;
  nextState: TaskListMembershipState;
  /**
   * acodeSessionStore optimistic 池：`upsert` 写入 nextTask，`remove` 清除该 task。
   * 本地 session store，不受 workspaceIdentity gating。默认 `none`。
   */
  optimistic?: TaskMetaPlacement;
  /**
   * 清空 task 运行态（removeTaskState，含持久化草稿）；归档/删除终态使用。
   * 与 optimistic 互斥，本地 session store，不受 workspaceIdentity gating。默认 false。
   */
  clearTaskState?: boolean;
  /** remoteTimelineTaskStore 放置意图；仅 workspaceIdentity 存在时生效。默认 `none`。 */
  remoteTimeline?: TaskMetaPlacement;
  /** remoteTimeline upsert 时的排序键（透传 store 的 sortBy，默认 `updated`）。 */
  remoteTimelineSortBy?: ACodeTaskListSortBy;
  /** remotePinnedTaskStore 放置意图；仅 workspaceIdentity 存在时生效。默认 `none`。 */
  remotePinned?: TaskMetaPlacement;
}

/**
 * task meta 四副本的单一事务写入路径。
 *
 * 固定写入顺序（与各组件历史内联顺序一致，保证零行为漂移）：
 * 1. optimistic 池（本地）→ 2. clearTaskState（本地）→ 3. remoteTimeline（远端）
 * → 4. remotePinned（远端）→ 5. applyTaskQueryCacheMutation（query cache，收尾）。
 *
 * remote 副本写入统一按 `workspaceIdentity` gating：本地 workspace 没有远端缓存副本，
 * 身份缺失时跳过，避免把本地 task 误写进以 identity 为键的远端 store。
 */
export function writeTaskMetaToCaches(write: TaskMetaCacheWrite): void {
  const sessionStore = useACodeSessionStore.getState();

  // 1. optimistic 池（本地 session store）：rename/unread upsert、pin 提交 remove。
  if (write.optimistic === "upsert") {
    sessionStore.upsertOptimisticTaskListItem(
      write.workspacePath,
      write.nextTask,
      write.workspaceIdentity,
    );
  } else if (write.optimistic === "remove") {
    sessionStore.removeOptimisticTaskListItem(
      write.workspacePath,
      write.taskId,
      write.workspaceIdentity,
    );
  }

  // 2. 清空 task 运行态（归档/删除终态）。
  if (write.clearTaskState) {
    sessionStore.removeTaskState(write.workspacePath, write.taskId, write.workspaceIdentity);
  }

  // 3./4. 远端 timeline / pinned 副本，仅远端 workspace（有 identity）写入。
  if (write.workspaceIdentity) {
    const timeline = useRemoteTimelineTaskStore.getState();
    if (write.remoteTimeline === "upsert") {
      // 身份键不变量（specs/task-meta-cache-ownership.md）：upsertTask 的 workspaceKey 是从
      // **task 对象**派生的（remoteTimelineTaskStore.ts: getWorkspaceKey(task.workspacePath,
      // task.workspaceIdentity)），而下面 removeTask 的 workspaceKey 用的是**显式参数**
      // write.workspaceIdentity。调用方必须保证 write.nextTask.workspaceIdentity ===
      // write.workspaceIdentity（且 workspacePath 一致），否则同一次事务的 upsert 与 remove
      // 会落到不同的 workspaceKey，副本之间静默 drift，而这里的 identity gating 也察觉不到。
      // 当前所有组件调用方都从同一个 item/meta 同时流入两处，天然满足；该不变量由
      // taskMetaCacheComposition 的守护用例钉住，不在生产路径加运行时 throw。
      timeline.upsertTask(write.nextTask, write.remoteTimelineSortBy);
    } else if (write.remoteTimeline === "remove") {
      timeline.removeTask(write.workspacePath, write.taskId, write.workspaceIdentity);
    }

    const pinned = useRemotePinnedTaskStore.getState();
    if (write.remotePinned === "upsert") {
      // 同上身份键不变量：remotePinnedTaskStore.upsertTask 亦从 nextTask 派生 workspaceKey。
      pinned.upsertTask(write.nextTask);
    } else if (write.remotePinned === "remove") {
      pinned.removeTask(write.workspacePath, write.taskId, write.workspaceIdentity);
    }
  }

  // 5. query cache 成员关系迁移，事务收尾（唯一权威 total/membership 写入点）。
  applyTaskQueryCacheMutation({
    previousTask: write.previousTask,
    nextTask: write.nextTask,
    previousState: write.previousState,
    nextState: write.nextState,
  });
}

export function removeTaskFromTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): boolean {
  const store = useACodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  if (workspaceState.taskListCache) {
    store.setTaskListCache(
      params.workspacePath,
      workspaceState.taskListCache.filter((task) => task.taskId !== params.taskId),
      params.workspaceIdentity,
    );
  }
  store.removeTaskState(params.workspacePath, params.taskId, params.workspaceIdentity);
  return removeTaskFromTaskQueryCaches(params);
}

const ABSENT_MEMBERSHIP: TaskListMembershipState = {
  pinned: true,
  archived: true,
};

function sortTasksByUpdatedAt(tasks: readonly ACodeTaskMeta[]): ACodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

export function syncTaskMetaToTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ACodeTaskMeta;
  membership?: TaskListMembershipState;
  forceInsertMembership?: boolean;
  ensureInWorkspaceTaskCache?: boolean;
  preserveListMembership?: boolean;
  applyQueryCacheMutation?: boolean;
}): void {
  const store = useACodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const previousTask = getTaskMeta(workspaceState, params.task.taskId);
  const queryTask = useTaskQueryCacheStore.getState().taskMetaByEntityKey[
    buildTaskEntityKey({
      taskId: params.task.taskId,
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? params.task.workspaceIdentity,
    })
  ];
  // Bugfix: session/readSession 快照的 updatedAt 可能落后于首发 prompt 写入的前端乐观时间。
  // 同步快照时必须先和本地已有 task meta 单调合并，否则新建任务会在 sqlite 首屏刷新后跳回下面。
  // Bugfix: 重启恢复时 workspace store 可能还没有当前 task，但 query cache 已经有 sqlite indexed meta。
  // raw session snapshot 不带 titleOverridden，必须一起合并，避免手动重命名标题在 renderer 被还原。
  const task =
    mergeTaskMetaCandidates(params.task, previousTask, queryTask) ?? params.task;
  const cachedTasks = workspaceState.taskListCache ?? [];
  const hasCachedTask = cachedTasks.some((cachedTask) => cachedTask.taskId === task.taskId);
  const shouldExistInWorkspaceTaskCache =
    params.membership?.pinned === false && params.membership.archived === false;
  const nextCachedTasks = params.preserveListMembership
    ? cachedTasks.map((cachedTask) => (cachedTask.taskId === task.taskId ? task : cachedTask))
    : shouldExistInWorkspaceTaskCache
      ? sortTasksByUpdatedAt([
          task,
          ...cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId),
        ])
      : cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId);

  // Bugfix: 终态/回滚类操作之前统一 bump 整个 taskListVersion，只是为了把最新 snapshot.meta
  // 重新捞回列表。这里改成按 task 增量回写 taskListCache，避免所有 task 列表整轮重查。
  if (
    workspaceState.taskListCache !== null &&
    ((params.preserveListMembership && hasCachedTask) ||
      params.ensureInWorkspaceTaskCache ||
      hasCachedTask ||
      !shouldExistInWorkspaceTaskCache)
  ) {
    store.setTaskListCache(params.workspacePath, nextCachedTasks, params.workspaceIdentity);
  }

  // Bugfix: Header / 当前会话信息会优先拿 optimistic meta 覆盖旧缓存。
  // 如果这里只改 query cache，不补 optimistic 池，当前激活 task 仍可能继续显示旧标题/旧摘要。
  store.upsertOptimisticTaskListItem(params.workspacePath, task, params.workspaceIdentity);
  upsertTaskQueryCacheTaskMeta(task);

  if (params.preserveListMembership) {
    updateTaskQueryCacheTaskMetaPreservingMembership(task);
  } else if (params.membership && params.applyQueryCacheMutation !== false) {
    // Bugfix: 手机 shared-host 创建 task 时，桌面 renderer 只收到 workspace 事件，
    // 没有本地首发路径的 insertTaskIntoTaskCaches。previousTask 缺失时仍要按 active
    // 成员关系插入 query cache，否则远控首页会继续同步旧列表顺序。
    // Bugfix: 本地首发会先写 optimistic meta，再插入列表成员；此时 previousTask 虽然存在，
    // 但它只代表“已有元数据”，不代表“已经计入列表 total”。新建任务必须显式按 absent -> active
    // 处理，否则第 6 个 workspace task 的 total 仍停在 5，Show more 不会出现。
    applyTaskQueryCacheMutation({
      previousTask: previousTask ?? task,
      nextTask: task,
      previousState:
        previousTask && !params.forceInsertMembership
          ? params.membership
          : ABSENT_MEMBERSHIP,
      nextState: params.membership,
    });
  }
}

export function insertTaskIntoTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ACodeTaskMeta;
  membership: TaskListMembershipState;
}): void {
  // Bugfix: 新建/fork/远控 shared-host 创建 task 都应走同一条“无 -> 有”成员变更。
  // syncTaskMetaToTaskCaches 会在 previousTask 缺失时按 ABSENT_MEMBERSHIP 插入 query cache，
  // 这里不能再二次 apply mutation，否则 total 会被重复加一。
  syncTaskMetaToTaskCaches({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    task: params.task,
    membership: params.membership,
    forceInsertMembership: true,
    ensureInWorkspaceTaskCache:
      params.membership.pinned === false && params.membership.archived === false,
  });
}
