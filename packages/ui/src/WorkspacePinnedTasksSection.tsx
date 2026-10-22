/* eslint-disable max-lines -- pinned 列表现在同时承载本地查询、远端主动注入结果和任务操作分发，先集中保持交互一致。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ACodeTaskMeta } from "@acode/shared";
import { toast } from "@/components/ui/toast.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { compareACodeTaskListItems } from "@/lib/taskListOrdering.js";
import { resolveTaskFileTreeTargetFromTabs } from "@/lib/taskFileTreeTarget.js";
import { MemoTaskItem, TaskListItemContextMenuContent } from "@/TaskListItem.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { useACodeSessionStore } from "@/store/acodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { TaskListRemoteSyncHint } from "@/TaskListRemoteSyncHint.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
// R2-06: task meta 四副本写入收进 writeTaskMetaToCaches 单一事务，组件不再直调
// applyTaskQueryCacheMutation 或自己拼 optimistic/remote 多 store 写入。
import { writeTaskMetaToCaches } from "@/lib/taskListMetaSync.js";
import {
  getRemoteWorkspaceServicesForIdentity,
  useRemoteWorkspaceSessionStore,
} from "@/store/remoteWorkspaceSessionStore.js";

function buildPinnedItemKey(workspacePath: string, taskId: string, workspaceIdentity?: string) {
  return `${buildTaskWorkspaceKey(workspacePath, workspaceIdentity)}:${taskId}`;
}

interface PinnedTaskItemHandlers {
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (event: ReactMouseEvent, taskId: string) => void;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  onOpenTaskContextMenu: (taskId: string) => void;
  onOpenFileTree: (task: ACodeTaskMeta) => void;
}

function PinnedTasksSectionTitle({ title }: { title: string }) {
  return <h3 className="px-2.5 py-1 text-ui-base font-medium text-foreground-subtlest">{title}</h3>;
}

export function WorkspacePinnedTasksSection({
  workspaceTabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  taskSortBy,
  onSelectTask,
  onOpenFileTree,
}: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  taskSortBy: "created" | "updated";
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
  onOpenFileTree?: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
}) {
  const { intl } = useACodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const scopedWorkspaceTabs = useLocalWorkspaceScopes({
    workspaceTabs,
  });
  const remoteSessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  // R2-06: removeTaskState / upsertOptimisticTaskListItem / removeOptimisticTaskListItem
  // 的副本写入已收进 writeTaskMetaToCaches 事务，组件不再单独取这些 selector。
  const setTaskUnreadIndicator = useACodeSessionStore((state) => state.setTaskUnreadIndicator);
  const [pendingArchiveItemKey, setPendingArchiveItemKey] = useState<string | null>(null);
  const [renamingItemKey, setRenamingItemKey] = useState<string | null>(null);
  const [contextMenuItemKey, setContextMenuItemKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [showAllTasks, setShowAllTasks] = useState(false);
  const collapsedLimit = 20;
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingArchiveItemKeyRef = useRef<string | null>(pendingArchiveItemKey);
  const taskSortByRef = useRef(taskSortBy);
  const intlRef = useRef(intl);
  const onSelectTaskRef = useRef(onSelectTask);
  const setTaskUnreadIndicatorRef = useRef(setTaskUnreadIndicator);
  const taskItemHandlersByKeyRef = useRef(new Map<string, PinnedTaskItemHandlers>());
  pendingArchiveItemKeyRef.current = pendingArchiveItemKey;
  taskSortByRef.current = taskSortBy;
  intlRef.current = intl;
  onSelectTaskRef.current = onSelectTask;
  setTaskUnreadIndicatorRef.current = setTaskUnreadIndicator;
  const { items: localItems } = useGlobalTaskList({
    kind: "pinned",
    workspaceTabs: scopedWorkspaceTabs,
    sortBy: taskSortBy,
    searchQuery: "",
    expanded: true,
    collapsedLimit,
  });
  const remotePinnedItemsByWorkspaceKey = useRemotePinnedTaskStore(
    (state) => state.itemsByWorkspaceKey,
  );
  const remotePinnedLoadingByWorkspaceKey = useRemotePinnedTaskStore(
    (state) => state.loadingByWorkspaceKey,
  );
  const remoteItems = useMemo(() => {
    const remoteWorkspaceKeys = new Set(
      workspaceTabs
        .filter((tab) => tab.workspaceIdentity || tab.remoteTarget || tab.remoteSessionId)
        .map((tab) => buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity)),
    );
    return [...remoteWorkspaceKeys].flatMap(
      (workspaceKey) => remotePinnedItemsByWorkspaceKey[workspaceKey] ?? [],
    );
  }, [remotePinnedItemsByWorkspaceKey, workspaceTabs]);
  const sortedItems = useMemo(() => {
    return [...localItems, ...remoteItems].sort((left, right) =>
      compareACodeTaskListItems(left, right, taskSortBy),
    );
  }, [localItems, remoteItems, taskSortBy]);
  const items = showAllTasks ? sortedItems : sortedItems.slice(0, collapsedLimit);
  const total = sortedItems.length;
  const syncingRemoteWorkspaces = workspaceTabs.some((tab) => {
    if (!tab.workspaceIdentity && !tab.remoteTarget && !tab.remoteSessionId) {
      return false;
    }
    return Boolean(
      remotePinnedLoadingByWorkspaceKey[
        buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity)
      ],
    );
  });
  const canToggleExpanded = total > collapsedLimit;
  const sectionTitle = intl.formatMessage({ id: "taskList.pinnedSection" });
  const activeWorkspaceKey = buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity);
  const itemByKey = useMemo(() => {
    const nextItemByKey = new Map<string, ACodeTaskMeta>();
    for (const item of items) {
      nextItemByKey.set(
        buildPinnedItemKey(item.workspacePath, item.taskId, item.workspaceIdentity),
        item,
      );
    }
    return nextItemByKey;
  }, [items]);
  const itemByKeyRef = useRef(itemByKey);
  itemByKeyRef.current = itemByKey;
  const workspaceTabsRef = useRef(workspaceTabs);
  workspaceTabsRef.current = workspaceTabs;
  const onOpenFileTreeRef = useRef(onOpenFileTree);
  onOpenFileTreeRef.current = onOpenFileTree;

  const resolveTaskServices = useCallback(
    (workspaceIdentity?: string) => {
      if (!workspaceIdentity) {
        return baseServices;
      }
      return getRemoteWorkspaceServicesForIdentity(workspaceIdentity);
    },
    [baseServices],
  );
  const resolveTaskServicesRef = useRef(resolveTaskServices);
  resolveTaskServicesRef.current = resolveTaskServices;

  const handleCancelArchiveConfirm = useCallback(() => {
    setPendingArchiveItemKey(null);
  }, []);

  const handleCancelRenameTask = useCallback(() => {
    setRenamingItemKey(null);
    setRenameDraft("");
  }, []);

  const findItemByKey = useCallback(
    (itemKey: string) => itemByKey.get(itemKey) ?? null,
    [itemByKey],
  );
  const getCurrentPinnedItemContext = useCallback((itemKey: string) => {
    const item = itemByKeyRef.current.get(itemKey);
    if (!item) {
      return null;
    }

    const services = resolveTaskServicesRef.current(item.workspaceIdentity);
    if (!services) {
      return null;
    }

    return { item, services };
  }, []);
  const archivePinnedItem = useCallback(
    (itemKey: string) => {
      const current = getCurrentPinnedItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, services } = current;
      void services.acodeTaskService
        .archiveTask({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
        })
        .then((meta) => {
          // R2-06: 归档终态——清 task 运行态 + 远端 pinned/timeline 双副本移除 + query cache pinned:false/archived:true。
          writeTaskMetaToCaches({
            workspacePath: item.workspacePath,
            workspaceIdentity: item.workspaceIdentity,
            taskId: item.taskId,
            previousTask: item,
            nextTask: meta,
            previousState: { pinned: true, archived: false },
            nextState: { pinned: false, archived: true },
            clearTaskState: true,
            remotePinned: "remove",
            remoteTimeline: "remove",
          });
        });
    },
    [getCurrentPinnedItemContext],
  );
  const selectPinnedItem = useCallback((itemKey: string) => {
    const item = itemByKeyRef.current.get(itemKey);
    if (!item) {
      return;
    }
    onSelectTaskRef.current(item.workspacePath, item.taskId, item.workspaceIdentity, item.unreadAt);
  }, []);
  const archivePinnedItemInline = useCallback(
    (event: ReactMouseEvent, itemKey: string) => {
      event.stopPropagation();
      if (pendingArchiveItemKeyRef.current !== itemKey) {
        setPendingArchiveItemKey(itemKey);
        return;
      }
      setPendingArchiveItemKey(null);
      archivePinnedItem(itemKey);
    },
    [archivePinnedItem],
  );
  const togglePinnedItemPin = useCallback(
    (itemKey: string, pinned: boolean) => {
      const current = getCurrentPinnedItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, services } = current;
      // unpin 以前等 RPC 返回后才把任务移出 pinned 区，重查期间会出现列表闪烁。
      // 这里先乐观移动，RPC 失败再把任务恢复为 pinned。
      // R2-06: 乐观阶段——pinned 项本在 pinned 区，先移出 pinned；unpin 时补入 timeline。
      writeTaskMetaToCaches({
        workspacePath: item.workspacePath,
        workspaceIdentity: item.workspaceIdentity,
        taskId: item.taskId,
        previousTask: item,
        nextTask: item,
        previousState: { pinned: true, archived: false },
        nextState: { pinned, archived: false },
        remotePinned: "remove",
        remoteTimeline: pinned ? "none" : "upsert",
        remoteTimelineSortBy: taskSortByRef.current,
      });
      void services.acodeTaskService
        .setTaskPinned({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
          pinned,
        })
        .then((meta) => {
          // R2-06: 提交阶段——清 optimistic 池；pinned 时回 pinned 区并移出 timeline，unpin 时补入 timeline。
          writeTaskMetaToCaches({
            workspacePath: item.workspacePath,
            workspaceIdentity: item.workspaceIdentity,
            taskId: item.taskId,
            previousTask: item,
            nextTask: meta,
            previousState: { pinned, archived: false },
            nextState: { pinned, archived: false },
            optimistic: "remove",
            remotePinned: pinned ? "upsert" : "none",
            remoteTimeline: pinned ? "remove" : "upsert",
            remoteTimelineSortBy: taskSortByRef.current,
          });
        })
        .catch(() => {
          // R2-06: 回滚阶段——恢复到 pinned 区，从 timeline 移除，query cache 回到 pinned:true。
          writeTaskMetaToCaches({
            workspacePath: item.workspacePath,
            workspaceIdentity: item.workspaceIdentity,
            taskId: item.taskId,
            previousTask: item,
            nextTask: item,
            previousState: { pinned, archived: false },
            nextState: { pinned: true, archived: false },
            remotePinned: "upsert",
            remoteTimeline: "remove",
          });
          toast(intlRef.current.formatMessage({ id: "taskList.pinFailed" }));
        });
    },
    [getCurrentPinnedItemContext],
  );
  const startPinnedItemRename = useCallback((itemKey: string, currentTitle: string) => {
    setPendingArchiveItemKey(null);
    setRenamingItemKey(itemKey);
    setRenameDraft(currentTitle);
  }, []);
  const markPinnedItemAsUnread = useCallback(
    (itemKey: string) => {
      const current = getCurrentPinnedItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, services } = current;
      void services.acodeTaskService
        .setTaskUnread({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
          unread: true,
        })
        .then((meta) => {
          // unread 覆盖态是独立 overlay，不属于 task meta 四副本，仍直调 setTaskUnreadIndicator。
          setTaskUnreadIndicatorRef.current(
            item.workspacePath,
            item.taskId,
            true,
            item.workspaceIdentity,
          );
          // R2-06: unread 一次写 optimistic 池 + 远端 pinned（远端时）+ query cache。
          writeTaskMetaToCaches({
            workspacePath: item.workspacePath,
            workspaceIdentity: item.workspaceIdentity,
            taskId: item.taskId,
            previousTask: item,
            nextTask: meta,
            previousState: { pinned: true, archived: false },
            nextState: { pinned: true, archived: false },
            optimistic: "upsert",
            remotePinned: "upsert",
          });
        });
    },
    [getCurrentPinnedItemContext],
  );
  const openPinnedItemContextMenu = useCallback((itemKey: string) => {
    // pinned row handler 按 itemKey 缓存；打开菜单时从 ref 读取最新确认态，
    // 避免 pendingArchiveItemKey 变化时重建所有 TaskListItem callback。
    if (pendingArchiveItemKeyRef.current === itemKey) {
      setPendingArchiveItemKey(null);
    }
    setContextMenuItemKey(itemKey);
  }, []);
  const getPinnedTaskItemHandlers = useCallback(
    (itemKey: string) => {
      let handlers = taskItemHandlersByKeyRef.current.get(itemKey);
      if (!handlers) {
        // trace 显示 pinned row 的 action props 仍因 map 内联闭包变化。
        // 每个 itemKey 只创建一次 handler，实际执行时再通过 ref 读取最新 item/services/state。
        handlers = {
          onSelectTask: () => {
            selectPinnedItem(itemKey);
          },
          onArchiveTaskInline: (event) => {
            archivePinnedItemInline(event, itemKey);
          },
          onTogglePinTask: (_taskId, pinned) => {
            togglePinnedItemPin(itemKey, pinned);
          },
          onStartRenameTask: (_taskId, currentTitle) => {
            startPinnedItemRename(itemKey, currentTitle);
          },
          onArchiveTask: () => {
            archivePinnedItem(itemKey);
          },
          onMarkTaskAsUnread: () => {
            markPinnedItemAsUnread(itemKey);
          },
          onOpenTaskContextMenu: () => {
            openPinnedItemContextMenu(itemKey);
          },
          onOpenFileTree: (task) => {
            const target = resolveTaskFileTreeTargetFromTabs(task, workspaceTabsRef.current);
            if (target) {
              onOpenFileTreeRef.current?.(target);
            }
          },
        };
        taskItemHandlersByKeyRef.current.set(itemKey, handlers);
      }
      return handlers;
    },
    [
      archivePinnedItem,
      archivePinnedItemInline,
      markPinnedItemAsUnread,
      openPinnedItemContextMenu,
      selectPinnedItem,
      startPinnedItemRename,
      togglePinnedItemPin,
    ],
  );

  useEffect(() => {
    if (!renamingItemKey) {
      return;
    }

    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingItemKey]);

  useEffect(() => {
    if (!contextMenuItemKey) {
      return;
    }

    if (!findItemByKey(contextMenuItemKey)) {
      setContextMenuItemKey(null);
    }
  }, [contextMenuItemKey, findItemByKey]);

  useEffect(() => {
    for (const itemKey of taskItemHandlersByKeyRef.current.keys()) {
      if (!itemByKey.has(itemKey)) {
        taskItemHandlersByKeyRef.current.delete(itemKey);
      }
    }
  }, [itemByKey]);

  const contextMenuItem = contextMenuItemKey ? findItemByKey(contextMenuItemKey) : null;
  const contextMenuServices = contextMenuItem
    ? resolveTaskServices(contextMenuItem.workspaceIdentity)
    : null;

  if (items.length === 0) {
    // 切换/加入工作区时 pinned 查询会先进入 loading，但此时没有可展示的数据。
    // 不能仍渲染“已置顶 + 正在获取任务”，否则侧栏每次切换都出现一次无实际帮助的 loading。
    // 有缓存数据时继续走下面的正常渲染路径，保持 stale-while-revalidate 的展示体验。
    return null;
  }

  return (
    <div className="flex flex-col gap-1 px-2 empty:hidden">
      {renamingItemKey !== null ? (
        <TaskRenameDialog
          open
          value={renameDraft}
          inputRef={renameInputRef}
          intl={intl}
          onOpenChange={(open) => {
            if (!open) {
              handleCancelRenameTask();
            }
          }}
          onChange={setRenameDraft}
          onCancel={handleCancelRenameTask}
          onConfirm={() => {
            if (!renamingItemKey) {
              return;
            }
            const item = findItemByKey(renamingItemKey);
            if (!item) {
              handleCancelRenameTask();
              return;
            }
            const services = resolveTaskServices(item.workspaceIdentity);
            if (!services) {
              handleCancelRenameTask();
              return;
            }
            void services.acodeTaskService
              .renameTask({
                taskId: item.taskId,
                workspacePath: item.workspacePath,
                ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
                title: renameDraft.trim(),
              })
              .then((meta) => {
                // R2-06: rename 一次写 optimistic 池 + 远端 pinned（远端时）+ query cache。
                writeTaskMetaToCaches({
                  workspacePath: item.workspacePath,
                  workspaceIdentity: item.workspaceIdentity,
                  taskId: item.taskId,
                  previousTask: item,
                  nextTask: meta,
                  previousState: { pinned: true, archived: false },
                  nextState: { pinned: true, archived: false },
                  optimistic: "upsert",
                  remotePinned: "upsert",
                });
                handleCancelRenameTask();
              })
              .catch(() => {
                toast(intl.formatMessage({ id: "taskList.renameFailed" }));
              });
          }}
        />
      ) : null}
      <PinnedTasksSectionTitle title={sectionTitle} />
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) {
            setContextMenuItemKey(null);
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <ul className="space-y-0.5">
            {items.map((item) => {
              const itemKey = buildPinnedItemKey(
                item.workspacePath,
                item.taskId,
                item.workspaceIdentity,
              );
              const services = resolveTaskServices(item.workspaceIdentity);
              if (!services) {
                return null;
              }
              const handlers = getPinnedTaskItemHandlers(itemKey);
              return (
                <MemoTaskItem
                  key={itemKey}
                  workspacePath={item.workspacePath}
                  remoteSessionId={
                    item.workspaceIdentity
                      ? remoteSessionIdByWorkspaceIdentity[item.workspaceIdentity]
                      : undefined
                  }
                  task={item}
                  isPinned
                  isActive={
                    // 同路径远端 workspace 可能包含相同 taskId，选中态必须按 workspaceIdentity 隔离。
                    buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity) ===
                      activeWorkspaceKey && item.taskId === activeTaskId
                  }
                  onSelectTask={handlers.onSelectTask}
                  onArchiveTaskInline={handlers.onArchiveTaskInline}
                  onCancelArchiveConfirm={handleCancelArchiveConfirm}
                  isArchiveConfirming={pendingArchiveItemKey === itemKey}
                  onTogglePinTask={handlers.onTogglePinTask}
                  onStartRenameTask={handlers.onStartRenameTask}
                  onArchiveTask={handlers.onArchiveTask}
                  onMarkTaskAsUnread={handlers.onMarkTaskAsUnread}
                  onOpenTaskContextMenu={handlers.onOpenTaskContextMenu}
                  onOpenFileTree={onOpenFileTree ? handlers.onOpenFileTree : undefined}
                  intl={intl}
                />
              );
            })}
          </ul>
        </ContextMenuTrigger>
        {contextMenuItem && contextMenuServices ? (
          <TaskListItemContextMenuContent
            workspacePath={contextMenuItem.workspacePath}
            remoteSessionId={
              contextMenuItem.workspaceIdentity
                ? remoteSessionIdByWorkspaceIdentity[contextMenuItem.workspaceIdentity]
                : undefined
            }
            task={contextMenuItem}
            isPinned
            intl={intl}
            onTogglePinTask={(_taskId, pinned) => {
              // R2-06: 乐观阶段——pinned 项先移出 pinned；unpin 时补入 timeline。
              writeTaskMetaToCaches({
                workspacePath: contextMenuItem.workspacePath,
                workspaceIdentity: contextMenuItem.workspaceIdentity,
                taskId: contextMenuItem.taskId,
                previousTask: contextMenuItem,
                nextTask: contextMenuItem,
                previousState: { pinned: true, archived: false },
                nextState: { pinned, archived: false },
                remotePinned: "remove",
                remoteTimeline: pinned ? "none" : "upsert",
                remoteTimelineSortBy: taskSortBy,
              });
              void contextMenuServices.acodeTaskService
                .setTaskPinned({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                  pinned,
                })
                .then((meta) => {
                  // R2-06: 提交阶段——清 optimistic 池；pinned 时回 pinned 区并移出 timeline，unpin 时补入 timeline。
                  writeTaskMetaToCaches({
                    workspacePath: contextMenuItem.workspacePath,
                    workspaceIdentity: contextMenuItem.workspaceIdentity,
                    taskId: contextMenuItem.taskId,
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: { pinned, archived: false },
                    nextState: { pinned, archived: false },
                    optimistic: "remove",
                    remotePinned: pinned ? "upsert" : "none",
                    remoteTimeline: pinned ? "remove" : "upsert",
                    remoteTimelineSortBy: taskSortBy,
                  });
                })
                .catch(() => {
                  // R2-06: 回滚阶段——恢复到 pinned 区，从 timeline 移除，query cache 回到 pinned:true。
                  writeTaskMetaToCaches({
                    workspacePath: contextMenuItem.workspacePath,
                    workspaceIdentity: contextMenuItem.workspaceIdentity,
                    taskId: contextMenuItem.taskId,
                    previousTask: contextMenuItem,
                    nextTask: contextMenuItem,
                    previousState: { pinned, archived: false },
                    nextState: { pinned: true, archived: false },
                    remotePinned: "upsert",
                    remoteTimeline: "remove",
                  });
                  toast(intl.formatMessage({ id: "taskList.pinFailed" }));
                });
            }}
            onStartRenameTask={(_taskId, currentTitle) => {
              setPendingArchiveItemKey(null);
              setRenamingItemKey(contextMenuItemKey);
              setRenameDraft(currentTitle);
            }}
            onArchiveTask={() => {
              void contextMenuServices.acodeTaskService
                .archiveTask({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                })
                .then((meta) => {
                  // R2-06: 归档终态——清 task 运行态 + 远端 pinned/timeline 双副本移除 + query cache pinned:false/archived:true。
                  writeTaskMetaToCaches({
                    workspacePath: contextMenuItem.workspacePath,
                    workspaceIdentity: contextMenuItem.workspaceIdentity,
                    taskId: contextMenuItem.taskId,
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: { pinned: true, archived: false },
                    nextState: { pinned: false, archived: true },
                    clearTaskState: true,
                    remotePinned: "remove",
                    remoteTimeline: "remove",
                  });
                });
            }}
            onMarkTaskAsUnread={() => {
              void contextMenuServices.acodeTaskService
                .setTaskUnread({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                  unread: true,
                })
                .then((meta) => {
                  // unread 覆盖态是独立 overlay，不属于 task meta 四副本，仍直调 setTaskUnreadIndicator。
                  setTaskUnreadIndicator(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    true,
                    contextMenuItem.workspaceIdentity,
                  );
                  // R2-06: unread 一次写 optimistic 池 + 远端 pinned（远端时）+ query cache。
                  writeTaskMetaToCaches({
                    workspacePath: contextMenuItem.workspacePath,
                    workspaceIdentity: contextMenuItem.workspaceIdentity,
                    taskId: contextMenuItem.taskId,
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: { pinned: true, archived: false },
                    nextState: { pinned: true, archived: false },
                    optimistic: "upsert",
                    remotePinned: "upsert",
                  });
                });
            }}
          />
        ) : null}
      </ContextMenu>
      {syncingRemoteWorkspaces ? <TaskListRemoteSyncHint /> : null}
      {canToggleExpanded ? (
        <div className="cursor-pointer pl-8.5">
          <span
            className="text-ui-base text-foreground-subtlest hover:text-foreground-subtle"
            onClick={() => {
              setShowAllTasks((current) => !current);
            }}
          >
            {intl.formatMessage({
              id: showAllTasks ? "taskList.showLess" : "taskList.showMore",
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
