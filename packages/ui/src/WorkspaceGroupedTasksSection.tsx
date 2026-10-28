/* eslint-disable max-lines -- 顶层 grouped task 容器仍集中维护远程 workspace service 解析、group 菜单、task 菜单和列表写回；子行与纯 helper 已拆到 workspace-grouped-tasks 目录。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  DragCancelEvent,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import type { ACodeGroupedTaskView, ACodeTaskGroupColor } from "@acode/services";
import { OFF_PEAK_DEFAULT_GROUP_ID, type ACodeTaskMeta } from "@acode/shared";
import { createPortal } from "react-dom";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { shouldHideGroupedTaskContent, useGroupedTaskView } from "@/hooks/useGroupedTaskView.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { getPathLeaf } from "@/lib/path.js";
import { resolveTaskFileTreeTargetFromTabs } from "@/lib/taskFileTreeTarget.js";
import { toast } from "@/components/ui/toast.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { selectWorkspaceACodeState, useACodeSessionStore } from "@/store/acodeSessionStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
// R2-06: task meta 四副本写入收进 writeTaskMetaToCaches 单一事务，组件不再直调
// applyTaskQueryCacheMutation 或自己拼 optimistic/remote 多 store 写入。
import { writeTaskMetaToCaches } from "@/lib/taskListMetaSync.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { GroupItem, GroupedTaskItem } from "@/workspace-grouped-tasks/items.js";
import { GroupDragOverlay } from "@/workspace-grouped-tasks/group-drag-overlay.js";
import { VirtualizedGroupedTopLevelList } from "@/workspace-grouped-tasks/virtualized-top-level-list.js";
import { GroupedDraftTaskRow } from "@/workspace-grouped-tasks/draft-task-row.js";
import { StickyGroupHeader } from "@/workspace-grouped-tasks/sticky-group-header.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import {
  findTaskInGroupedView,
  filterGroupedViewByTaskKeys,
  getGroupedTaskGroupIds,
  moveTaskByMenu,
  moveTaskToTopByMenu,
  replaceTaskInGroupedView,
  resolveGroupedDraftTaskPlacementForTask,
  taskKey,
} from "@/workspace-grouped-tasks/shared.js";
import type { TaskGroupMenuItem } from "@/workspace-grouped-tasks/shared.js";
import {
  areStringArraysEqual,
  areTaskGroupMenuItemsEqual,
  getGroupedTaskDragGroupId,
  getGroupedTaskDragTaskKey,
  groupedTaskCollisionDetection,
} from "@/workspace-grouped-tasks/groupedTaskDragData.js";
import type { GroupedTaskDragDirectionPosition } from "@/workspace-grouped-tasks/groupedTaskDragData.js";
import {
  getGroupedGroupOverGroupPreviewView,
  getGroupedGroupOverTaskPreviewView,
  getGroupedTaskOverCollapsedGroupPreviewView,
  getGroupedTaskOverEmptyDropZonePreviewView,
  getGroupedTaskOverGroupFooterPreviewView,
  getGroupedTaskOverGroupHeaderPreviewView,
  getGroupedTaskOverTaskPreviewView,
  getGroupedTaskViewSignature,
} from "@/workspace-grouped-tasks/groupedTaskPreviewViews.js";
import {
  GROUPED_TASK_AUTO_SCROLL_THRESHOLD,
  GROUPED_TASK_DROP_ANIMATION,
  animateGroupedTaskLayoutFrom,
  collectGroupedTaskLayoutRects,
  findNearestScrollableAncestor,
  measureGroupedGroupPreviewWidth,
  measureGroupedTaskPreviewWidth,
  resolveStickyGroupedTaskGroupId,
} from "@/workspace-grouped-tasks/groupedTaskLayout.js";
import type { WorkbenchSessionDragPayload } from "@/v4/workbenchDragDrop.js";
import {
  cancelWorkbenchPointerDrag,
  finishWorkbenchPointerDrag,
  updateWorkbenchPointerDrag,
} from "@/v4/workbenchPointerDragDrop.js";
import {
  createWorkbenchPointerPositionTracker,
  type WorkbenchPointerPositionTracker,
} from "@/v4/workbenchPointerPositionTracker.js";

export function WorkspaceGroupedTasksSection({
  workspaceTabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  onSelectTask,
  onCreateTask,
  onOpenFileTree,
  onCreateGroupActionChange,
  onCreateDraftTaskActionChange,
  collapsedGroupIds,
  onGroupedTaskGroupIdsChange,
  onCollapsedGroupIdsChange,
  onStickyGroupHeaderChange,
  onOpenAutomations,
}: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCreateTask: (request?: CreateTaskRequest) => void;
  onOpenFileTree?: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
  onCreateGroupActionChange?: (action: (() => void) | null) => void;
  onCreateDraftTaskActionChange?: (action: (() => void) | null) => void;
  collapsedGroupIds: ReadonlySet<string>;
  onGroupedTaskGroupIdsChange?: (groupIds: string[]) => void;
  onCollapsedGroupIdsChange: (updater: (currentGroupIds: Set<string>) => Set<string>) => void;
  onStickyGroupHeaderChange?: (node: ReactNode | null) => void;
  /** 闲时系统分组的「+」/右键新建路由到 Automations 主视图。 */
  onOpenAutomations?: () => void;
}) {
  const { intl } = useACodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const workspaceServiceLookup = useMemo(
    () => buildWorkspaceServiceLookup(workspaceTabs, baseServices, serviceResolverState),
    [baseServices, serviceResolverState, workspaceTabs],
  );
  // R2-06: removeTaskState / upsertOptimisticTaskListItem 的副本写入已收进
  // writeTaskMetaToCaches 事务，组件不再单独取这些 selector。
  const setTaskUnreadIndicator = useACodeSessionStore((state) => state.setTaskUnreadIndicator);
  const groupedDraftTask = useACodeSessionStore(
    (state) =>
      selectWorkspaceACodeState(state, activeWorkspacePath, activeWorkspaceIdentity)
        .groupedDraftTask,
  );
  const groupedDraftFocusVersion = useACodeSessionStore(
    (state) =>
      selectWorkspaceACodeState(state, activeWorkspacePath, activeWorkspaceIdentity)
        .draftFocusVersion,
  );
  const clearGroupedDraftTask = useACodeSessionStore((state) => state.clearGroupedDraftTask);
  const {
    view: authoritativeView,
    setView,
    loading,
    initialized,
    saving,
    createGroup,
    renameGroup,
    updateGroupColor,
    ungroupGroup,
    applyOrder,
  } = useGroupedTaskView({
    workspaceTabs,
  });
  const [archivingTaskKeys, setArchivingTaskKeys] = useState<ReadonlySet<string>>(() => new Set());
  const view = useMemo(
    () => filterGroupedViewByTaskKeys(authoritativeView, archivingTaskKeys),
    [archivingTaskKeys, authoritativeView],
  );

  useEffect(() => {
    if (archivingTaskKeys.size === 0) {
      return;
    }
    setArchivingTaskKeys((current) => {
      const next = new Set(
        [...current].filter((key) => findTaskInGroupedView(authoritativeView, key)),
      );
      return next.size === current.size ? current : next;
    });
  }, [archivingTaskKeys.size, authoritativeView]);
  const groupedSectionRootRef = useRef<HTMLDivElement | null>(null);
  // 已经画出过 grouped 列表：之后任何 loading/未初始化帧都不再回到空白门禁。
  // 挂载时若模块级缓存已种出非空 view，本帧就会画出列表，闩锁直接种 true——把「渲染期置位」
  // 的窗口收窄到只剩真正的首屏。
  const hasPaintedGroupedListRef = useRef(view.nodes.length > 0);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const groupMenuItemsRef = useRef<TaskGroupMenuItem[]>([]);
  const groupIdsRef = useRef<string[]>([]);
  const dragOriginViewRef = useRef<ACodeGroupedTaskView | null>(null);
  const dragPreviewViewRef = useRef<ACodeGroupedTaskView | null>(null);
  const lastDragOverEventRef = useRef<DragOverEvent | null>(null);
  const createDraftContextRef = useRef({
    activeTaskId,
    activeWorkspaceIdentity,
    activeWorkspacePath,
    groupedDraftPlacement: groupedDraftTask?.placement,
    view,
  });
  const groupDragCollapsedSnapshotRef = useRef<Set<string> | null>(null);
  const layoutAnimationFrameRef = useRef<number | null>(null);
  const dragDirectionRef = useRef<GroupedTaskDragDirectionPosition>("after");
  const lastDragDeltaYRef = useRef(0);
  const workbenchDragPayloadRef = useRef<WorkbenchSessionDragPayload | null>(null);
  const workbenchPointerPositionTrackerRef = useRef<WorkbenchPointerPositionTracker | null>(null);
  const [renamingTaskKey, setRenamingTaskKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [newGroupSetupId, setNewGroupSetupId] = useState<string | null>(null);
  const [activeDragTaskKey, setActiveDragTaskKey] = useState<string | null>(null);
  const [activeDragGroupId, setActiveDragGroupId] = useState<string | null>(null);
  const [activeDragOverlayWidth, setActiveDragOverlayWidth] = useState<number | null>(null);
  const [stickyGroupId, setStickyGroupId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
  );
  const isGroupedDraftActive = Boolean(groupedDraftTask && activeTaskId === null);
  const handleGroupedPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 必须在 dnd-kit 激活前监听，才能捕获越过 6px 阈值的首个
      // pointermove；快速拖到 Workbench 后立即松手也要使用真实 viewport 坐标。
      workbenchPointerPositionTrackerRef.current?.dispose();
      workbenchPointerPositionTrackerRef.current = createWorkbenchPointerPositionTracker(
        event.currentTarget.ownerDocument,
        event.nativeEvent,
      );
    },
    [],
  );
  useEffect(
    () => () => {
      workbenchPointerPositionTrackerRef.current?.dispose();
      workbenchPointerPositionTrackerRef.current = null;
      cancelWorkbenchPointerDrag();
    },
    [],
  );
  useEffect(() => {
    createDraftContextRef.current = {
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspacePath,
      groupedDraftPlacement: groupedDraftTask?.placement,
      view,
    };
  }, [
    activeTaskId,
    activeWorkspaceIdentity,
    activeWorkspacePath,
    groupedDraftTask?.placement,
    view,
  ]);
  const handleCreateTopDraftTask = useCallback(() => {
    onCreateTask({ groupedDraftPlacement: { type: "top" } });
  }, [onCreateTask]);
  const handleCreateGroupDraftTask = useCallback(
    (groupId: string) => {
      onCollapsedGroupIdsChange((current) => {
        if (!current.has(groupId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(groupId);
        return next;
      });
      onCreateTask({ groupedDraftPlacement: { type: "group", groupId } });
    },
    [onCollapsedGroupIdsChange, onCreateTask],
  );
  const handleCreateContextualDraftTask = useCallback(() => {
    const {
      activeTaskId: currentActiveTaskId,
      activeWorkspaceIdentity: currentActiveWorkspaceIdentity,
      activeWorkspacePath: currentActiveWorkspacePath,
      groupedDraftPlacement,
      view: currentView,
    } = createDraftContextRef.current;
    const activeTaskKey = currentActiveTaskId
      ? taskKey({
          taskId: currentActiveTaskId,
          workspaceIdentity: currentActiveWorkspaceIdentity,
          workspacePath: currentActiveWorkspacePath,
        })
      : null;
    const draftPlacement = activeTaskKey
      ? resolveGroupedDraftTaskPlacementForTask(currentView, activeTaskKey)
      : (groupedDraftPlacement ?? { type: "top" });
    if (draftPlacement.type === "group") {
      onCollapsedGroupIdsChange((current) => {
        if (!current.has(draftPlacement.groupId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(draftPlacement.groupId);
        return next;
      });
    }
    onCreateTask({ groupedDraftPlacement: draftPlacement });
  }, [onCollapsedGroupIdsChange, onCreateTask]);
  const handleCloseGroupedDraftTask = useCallback(() => {
    // grouped 草稿会在切 workspace 时迁移到目标 workspace。
    // 只能由用户关闭、真实 task 创建或明确离开草稿时清理，不能跟随列表组件卸载自动清掉。
    clearGroupedDraftTask(activeWorkspacePath, activeWorkspaceIdentity);
  }, [activeWorkspaceIdentity, activeWorkspacePath, clearGroupedDraftTask]);
  useEffect(() => {
    onCreateDraftTaskActionChange?.(handleCreateContextualDraftTask);
    return () => onCreateDraftTaskActionChange?.(null);
  }, [handleCreateContextualDraftTask, onCreateDraftTaskActionChange]);
  useEffect(() => {
    if (groupedDraftTask?.placement.type !== "top") {
      return;
    }
    const rootElement = groupedSectionRootRef.current;
    if (!rootElement) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      const scrollContainer = findNearestScrollableAncestor(rootElement);
      // 全局 New task 的草稿创建在 grouped 列表顶部。
      // 用户可能已经滚到下面的 group；这里按入口语义把列表滚动条归零，而不是只保证草稿可见。
      scrollContainer?.scrollTo({ top: 0 });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [groupedDraftFocusVersion, groupedDraftTask]);
  const groups = useMemo<TaskGroupMenuItem[]>(() => {
    const nextGroups = view.nodes.flatMap((node) =>
      node.type === "group"
        ? [
            {
              id: node.group.id,
              title: node.group.title,
              color: node.group.color,
            },
          ]
        : [],
    );
    if (areTaskGroupMenuItemsEqual(groupMenuItemsRef.current, nextGroups)) {
      return groupMenuItemsRef.current;
    }
    groupMenuItemsRef.current = nextGroups;
    return nextGroups;
  }, [view.nodes]);
  const groupIds = useMemo(() => {
    const nextGroupIds = getGroupedTaskGroupIds(view);
    if (areStringArraysEqual(groupIdsRef.current, nextGroupIds)) {
      return groupIdsRef.current;
    }
    groupIdsRef.current = nextGroupIds;
    return nextGroupIds;
  }, [view]);
  useEffect(() => {
    onGroupedTaskGroupIdsChange?.(groupIds);
  }, [groupIds, onGroupedTaskGroupIdsChange]);
  useEffect(() => {
    const rootElement = groupedSectionRootRef.current;
    if (!rootElement || activeDragTaskKey !== null || activeDragGroupId !== null) {
      setStickyGroupId(null);
      return undefined;
    }
    const scrollContainer = findNearestScrollableAncestor(rootElement);
    if (!scrollContainer) {
      setStickyGroupId(null);
      return undefined;
    }
    let animationFrame: number | null = null;
    const updateStickyGroup = () => {
      animationFrame = null;
      setStickyGroupId(resolveStickyGroupedTaskGroupId(rootElement));
    };
    const scheduleUpdate = () => {
      if (animationFrame !== null) {
        return;
      }
      animationFrame = window.requestAnimationFrame(updateStickyGroup);
    };
    updateStickyGroup();
    scrollContainer.addEventListener("scroll", scheduleUpdate, {
      passive: true,
    });
    window.addEventListener("resize", scheduleUpdate);
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(rootElement);
    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      scrollContainer.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver?.disconnect();
    };
  }, [
    activeDragGroupId,
    activeDragTaskKey,
    collapsedGroupIds,
    groupedDraftTask?.placement,
    view.nodes,
  ]);
  const workspaceTabByKey = useMemo(
    () =>
      new Map(
        workspaceTabs.map((tab) => [
          buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
          tab,
        ]),
      ),
    [workspaceTabs],
  );

  const getTaskWorkspaceLabel = useCallback(
    (task: ACodeTaskMeta) => {
      const tab = workspaceTabByKey.get(
        buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
      );
      if (tab?.workspacePurpose === "conversation") {
        return intl.formatMessage({
          id: "workspaceSidebar.conversationsSection",
        });
      }
      return tab?.label || getPathLeaf(task.workspacePath) || task.workspacePath;
    },
    [intl, workspaceTabByKey],
  );
  const draftWorkspaceLabel = useMemo(() => {
    const tab = workspaceTabByKey.get(
      buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity),
    );
    if (tab?.workspacePurpose === "conversation") {
      return intl.formatMessage({
        id: "workspaceSidebar.conversationsSection",
      });
    }
    return tab?.label || getPathLeaf(activeWorkspacePath) || activeWorkspacePath;
  }, [activeWorkspaceIdentity, activeWorkspacePath, intl, workspaceTabByKey]);

  const getTaskRemoteSessionId = useCallback(
    (task: ACodeTaskMeta) =>
      workspaceServiceLookup.get(buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity))
        ?.remoteSessionId,
    [workspaceServiceLookup],
  );

  const handleOpenTaskFileTree = useCallback(
    (task: ACodeTaskMeta) => {
      const target = resolveTaskFileTreeTargetFromTabs(task, workspaceTabs);
      if (!onOpenFileTree || !target) {
        return;
      }
      onOpenFileTree(target);
    },
    [onOpenFileTree, workspaceTabs],
  );

  const handleCreateGroup = useCallback(() => {
    void createGroup()
      .then((group) => {
        setNewGroupSetupId(group.id);
      })
      .catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.createFailed" }));
      });
  }, [createGroup, intl]);

  useEffect(() => {
    onCreateGroupActionChange?.(handleCreateGroup);
    return () => onCreateGroupActionChange?.(null);
  }, [handleCreateGroup, onCreateGroupActionChange]);

  const handleNewGroupSetupStarted = useCallback((groupId: string) => {
    setNewGroupSetupId((currentGroupId) => (currentGroupId === groupId ? null : currentGroupId));
  }, []);

  const handleToggleGroupCollapsed = useCallback(
    (groupId: string) => {
      onCollapsedGroupIdsChange((currentGroupIds) => {
        const nextGroupIds = new Set(currentGroupIds);
        if (nextGroupIds.has(groupId)) {
          nextGroupIds.delete(groupId);
        } else {
          nextGroupIds.add(groupId);
        }
        return nextGroupIds;
      });
    },
    [onCollapsedGroupIdsChange],
  );
  const isGroupCollapsed = useCallback(
    (groupId: string) => collapsedGroupIds.has(groupId),
    [collapsedGroupIds],
  );

  const handleCancelRenameTask = useCallback(() => {
    setRenamingTaskKey(null);
    setRenameDraft("");
  }, []);

  const handleStartRenameTask = useCallback((task: ACodeTaskMeta) => {
    setRenamingTaskKey(taskKey(task));
    setRenameDraft(task.title ?? "");
  }, []);

  const handleMoveTaskToGroup = useCallback(
    (task: ACodeTaskMeta, groupId: string | null) => {
      // archivingTaskKeys 过滤后的 view 只用于渲染；若拿它计算并持久化排序，
      // 归档请求失败前的任意结构变更都会把被隐藏任务从权威分组中永久删除。
      const nextView = moveTaskByMenu(authoritativeView, task, groupId);
      if (nextView === authoritativeView) {
        return;
      }
      void applyOrder(nextView).catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
      });
    },
    [applyOrder, authoritativeView, intl],
  );

  const handleMoveTaskToTop = useCallback(
    (task: ACodeTaskMeta) => {
      const nextView = moveTaskToTopByMenu(authoritativeView, task);
      if (nextView === authoritativeView) {
        return;
      }
      void applyOrder(nextView).catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
      });
    },
    [applyOrder, authoritativeView, intl],
  );

  const handleSubmitRenameTask = useCallback(async () => {
    if (!renamingTaskKey) {
      return;
    }

    const task = findTaskInGroupedView(view, renamingTaskKey);
    if (!task) {
      handleCancelRenameTask();
      return;
    }
    const workspaceServices = workspaceServiceLookup.get(
      buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
    );
    if (!workspaceServices) {
      handleCancelRenameTask();
      return;
    }

    const normalizedTitle = renameDraft.trim();
    if (normalizedTitle === (task.title ?? "").trim()) {
      handleCancelRenameTask();
      return;
    }

    try {
      const meta = await workspaceServices.services.acodeTaskService.renameTask({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        title: normalizedTitle,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      });

      if (!meta) {
        toast(intl.formatMessage({ id: "taskList.renameFailed" }));
        return;
      }

      setView((currentView) => replaceTaskInGroupedView(currentView, meta));
      // R2-06: grouped 是本地聚合视图，rename 只写 optimistic 池 + query cache（无远端副本变更）。
      writeTaskMetaToCaches({
        workspacePath: task.workspacePath,
        workspaceIdentity: task.workspaceIdentity,
        taskId: task.taskId,
        previousTask: task,
        nextTask: meta,
        previousState: { pinned: false, archived: false },
        nextState: { pinned: false, archived: false },
        optimistic: "upsert",
      });
      handleCancelRenameTask();
    } catch {
      toast(intl.formatMessage({ id: "taskList.renameFailed" }));
    }
  }, [
    handleCancelRenameTask,
    intl,
    renameDraft,
    renamingTaskKey,
    setView,
    view,
    workspaceServiceLookup,
  ]);

  const handleMarkTaskAsUnread = useCallback(
    (task: ACodeTaskMeta) => {
      const workspaceServices = workspaceServiceLookup.get(
        buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
      );
      if (!workspaceServices) {
        return;
      }

      void workspaceServices.services.acodeTaskService
        .setTaskUnread({
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          unread: true,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        })
        .then((meta) => {
          // unread 覆盖态是独立 overlay，不属于 task meta 四副本，仍直调 setTaskUnreadIndicator。
          setTaskUnreadIndicator(task.workspacePath, task.taskId, true, task.workspaceIdentity);
          setView((currentView) => replaceTaskInGroupedView(currentView, meta));
          // R2-06: grouped 本地视图，unread 只写 optimistic 池 + query cache（无远端副本变更）。
          writeTaskMetaToCaches({
            workspacePath: task.workspacePath,
            workspaceIdentity: task.workspaceIdentity,
            taskId: task.taskId,
            previousTask: task,
            nextTask: meta,
            previousState: { pinned: false, archived: false },
            nextState: { pinned: false, archived: false },
            optimistic: "upsert",
          });
        })
        .catch(() => {
          toast(intl.formatMessage({ id: "taskList.markAsUnreadFailed" }));
        });
    },
    [intl, setTaskUnreadIndicator, setView, workspaceServiceLookup],
  );

  const handleCloseTask = useCallback(
    (task: ACodeTaskMeta) => {
      const workspaceServices = workspaceServiceLookup.get(
        buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
      );
      if (!workspaceServices) {
        return;
      }

      const closingTaskKey = taskKey(task);
      setArchivingTaskKeys((current) => {
        if (current.has(closingTaskKey)) {
          return current;
        }
        return new Set(current).add(closingTaskKey);
      });

      void workspaceServices.services.acodeTaskService
        .archiveTask({
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        })
        .then((meta) => {
          // grouped 的后台 refresh 可能携带归档前的 membership，直接覆盖乐观删除。
          // 归档成功后主动换代 membership；渲染层在权威列表确认消失前继续屏蔽该 task。
          bumpTaskListMembershipVersion();
          // R2-06: 归档终态——清 task 运行态 + 远端 timeline/pinned 双副本移除 + query cache archived:true。
          writeTaskMetaToCaches({
            workspacePath: task.workspacePath,
            workspaceIdentity: task.workspaceIdentity,
            taskId: task.taskId,
            previousTask: task,
            nextTask: meta,
            previousState: { pinned: false, archived: false },
            nextState: { pinned: false, archived: true },
            clearTaskState: true,
            remoteTimeline: "remove",
            remotePinned: "remove",
          });
        })
        .catch(() => {
          setArchivingTaskKeys((current) => {
            if (!current.has(closingTaskKey)) {
              return current;
            }
            const next = new Set(current);
            next.delete(closingTaskKey);
            return next;
          });
          toast(intl.formatMessage({ id: "taskList.archiveFailed" }));
        });
    },
    [intl, workspaceServiceLookup],
  );

  const handleRenameGroup = useCallback(
    (groupId: string, title: string) => {
      void renameGroup(groupId, title).catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.renameFailed" }));
      });
    },
    [intl, renameGroup],
  );

  const handleUpdateGroupColor = useCallback(
    (groupId: string, color: ACodeTaskGroupColor) => {
      void updateGroupColor(groupId, color).catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.colorFailed" }));
      });
    },
    [intl, updateGroupColor],
  );

  const handleUngroupGroup = useCallback(
    (groupId: string) => {
      void ungroupGroup(groupId).catch(() => {
        toast(intl.formatMessage({ id: "taskGroup.ungroupFailed" }));
      });
    },
    [intl, ungroupGroup],
  );

  useEffect(() => {
    return () => {
      if (layoutAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutAnimationFrameRef.current);
      }
    };
  }, []);

  const setViewWithGroupedTaskAnimation = useCallback(
    (nextView: ACodeGroupedTaskView) => {
      const previousRects = collectGroupedTaskLayoutRects(groupedSectionRootRef.current);
      setView(nextView);
      if (layoutAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutAnimationFrameRef.current);
      }
      layoutAnimationFrameRef.current = window.requestAnimationFrame(() => {
        layoutAnimationFrameRef.current = null;
        animateGroupedTaskLayoutFrom(groupedSectionRootRef.current, previousRects);
      });
    },
    [setView],
  );

  useEffect(() => {
    if (!renamingTaskKey) {
      return;
    }
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingTaskKey]);

  useEffect(() => {
    if (!renamingTaskKey) {
      return;
    }
    if (!findTaskInGroupedView(view, renamingTaskKey)) {
      handleCancelRenameTask();
    }
  }, [handleCancelRenameTask, renamingTaskKey, view]);

  const restoreGroupDragCollapsedState = useCallback(() => {
    const snapshot = groupDragCollapsedSnapshotRef.current;
    if (!snapshot) {
      return;
    }
    groupDragCollapsedSnapshotRef.current = null;
    onCollapsedGroupIdsChange(() => new Set(snapshot));
  }, [onCollapsedGroupIdsChange]);

  const handleGroupedTaskDragStart = useCallback(
    (event: DragStartEvent) => {
      dragDirectionRef.current = "after";
      lastDragDeltaYRef.current = 0;
      lastDragOverEventRef.current = null;
      const nextActiveGroupId = getGroupedTaskDragGroupId(event.active.data.current);
      if (nextActiveGroupId) {
        dragOriginViewRef.current = authoritativeView;
        dragPreviewViewRef.current = authoritativeView;
        groupDragCollapsedSnapshotRef.current = new Set(collapsedGroupIds);
        setActiveDragGroupId(nextActiveGroupId);
        const nextWidth = measureGroupedGroupPreviewWidth(
          groupedSectionRootRef.current,
          nextActiveGroupId,
        );
        if (nextWidth !== null) {
          setActiveDragOverlayWidth(nextWidth);
        }
        onCollapsedGroupIdsChange((currentGroupIds) => {
          if (currentGroupIds.has(nextActiveGroupId)) {
            return currentGroupIds;
          }
          const nextGroupIds = new Set(currentGroupIds);
          nextGroupIds.add(nextActiveGroupId);
          return nextGroupIds;
        });
        return;
      }
      const nextActiveTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
      if (!nextActiveTaskKey) {
        return;
      }
      const activeTask = findTaskInGroupedView(view, nextActiveTaskKey);
      if (activeTask) {
        workbenchDragPayloadRef.current = {
          kind: "acode/session",
          workspacePath: activeTask.workspacePath,
          workspaceIdentity: activeTask.workspaceIdentity,
          remoteSessionId: getTaskRemoteSessionId(activeTask),
          sessionId: activeTask.taskId,
        };
      }
      dragOriginViewRef.current = authoritativeView;
      dragPreviewViewRef.current = authoritativeView;
      // task overlay 宽度只在 drag start 测一次。
      // 之前依赖 view 的 layout effect 会在每次拖拽 preview 重排后同步 setState，容易和 dnd-kit 测量形成嵌套更新循环。
      const nextWidth = measureGroupedTaskPreviewWidth(
        groupedSectionRootRef.current,
        nextActiveTaskKey,
      );
      if (nextWidth !== null) {
        setActiveDragOverlayWidth(nextWidth);
      }
      setActiveDragTaskKey(nextActiveTaskKey);
    },
    [collapsedGroupIds, getTaskRemoteSessionId, onCollapsedGroupIdsChange, authoritativeView, view],
  );

  const applyGroupedTaskDragOverPreview = useCallback(
    (event: DragOverEvent) => {
      const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
      const activeGroupId = getGroupedTaskDragGroupId(event.active.data.current);
      if ((!activeTaskKey && !activeGroupId) || !event.over) {
        return;
      }
      const currentPreviewView = dragPreviewViewRef.current ?? authoritativeView;
      const dragDirection = dragDirectionRef.current;
      const nextView = activeGroupId
        ? getGroupedGroupOverTaskPreviewView(
            getGroupedGroupOverGroupPreviewView(currentPreviewView, event, dragDirection),
            event,
            dragDirection,
          )
        : getGroupedTaskOverTaskPreviewView(
            getGroupedTaskOverEmptyDropZonePreviewView(
              getGroupedTaskOverGroupFooterPreviewView(
                getGroupedTaskOverGroupHeaderPreviewView(
                  getGroupedTaskOverCollapsedGroupPreviewView(
                    currentPreviewView,
                    event,
                    dragDirection,
                  ),
                  event,
                  dragDirection,
                ),
                event,
                dragDirection,
              ),
              event,
            ),
            event,
            dragDirection,
          );
      if (
        nextView === currentPreviewView ||
        getGroupedTaskViewSignature(nextView) === getGroupedTaskViewSignature(currentPreviewView)
      ) {
        return;
      }
      dragPreviewViewRef.current = nextView;
      setViewWithGroupedTaskAnimation(nextView);
    },
    [authoritativeView, setViewWithGroupedTaskAnimation],
  );

  const handleGroupedTaskDragMove = useCallback(
    (event: DragMoveEvent) => {
      const workbenchPayload = workbenchDragPayloadRef.current;
      const position = workbenchPointerPositionTrackerRef.current?.getPosition();
      if (workbenchPayload && position) {
        updateWorkbenchPointerDrag(workbenchPayload, position.x, position.y);
      }
      const nextDeltaY = event.delta.y;
      const previousDirection = dragDirectionRef.current;
      if (nextDeltaY > lastDragDeltaYRef.current) {
        dragDirectionRef.current = "after";
      } else if (nextDeltaY < lastDragDeltaYRef.current) {
        dragDirectionRef.current = "before";
      }
      lastDragDeltaYRef.current = nextDeltaY;
      if (dragDirectionRef.current !== previousDirection && lastDragOverEventRef.current) {
        applyGroupedTaskDragOverPreview(lastDragOverEventRef.current);
      }
    },
    [applyGroupedTaskDragOverPreview],
  );

  const handleGroupedTaskDragOver = useCallback(
    (event: DragOverEvent) => {
      lastDragOverEventRef.current = event.over ? event : null;
      applyGroupedTaskDragOverPreview(event);
    },
    [applyGroupedTaskDragOverPreview],
  );

  const resetGroupedTaskDrag = useCallback(() => {
    cancelWorkbenchPointerDrag();
    workbenchDragPayloadRef.current = null;
    workbenchPointerPositionTrackerRef.current?.dispose();
    workbenchPointerPositionTrackerRef.current = null;
    setActiveDragTaskKey(null);
    setActiveDragGroupId(null);
    setActiveDragOverlayWidth(null);
    dragDirectionRef.current = "after";
    lastDragDeltaYRef.current = 0;
    lastDragOverEventRef.current = null;
    dragOriginViewRef.current = null;
    dragPreviewViewRef.current = null;
  }, []);

  const handleGroupedTaskDragCancel = useCallback(
    (event?: DragCancelEvent) => {
      const activeGroupId =
        getGroupedTaskDragGroupId(event?.active.data.current) ?? activeDragGroupId;
      if (activeGroupId) {
        restoreGroupDragCollapsedState();
        resetGroupedTaskDrag();
        return;
      }
      if (dragOriginViewRef.current) {
        setViewWithGroupedTaskAnimation(dragOriginViewRef.current);
      }
      resetGroupedTaskDrag();
    },
    [
      activeDragGroupId,
      resetGroupedTaskDrag,
      restoreGroupDragCollapsedState,
      setViewWithGroupedTaskAnimation,
    ],
  );

  const handleGroupedTaskDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeGroupId =
        getGroupedTaskDragGroupId(event.active.data.current) ?? activeDragGroupId;
      if (activeGroupId) {
        const originView = dragOriginViewRef.current;
        const currentPreviewView = dragPreviewViewRef.current ?? authoritativeView;
        const nextView = currentPreviewView;
        restoreGroupDragCollapsedState();
        resetGroupedTaskDrag();
        if (
          !originView ||
          getGroupedTaskViewSignature(nextView) === getGroupedTaskViewSignature(originView)
        ) {
          if (originView) {
            setViewWithGroupedTaskAnimation(originView);
          }
          return;
        }
        setViewWithGroupedTaskAnimation(nextView);
        void applyOrder(nextView).catch(() => {
          setViewWithGroupedTaskAnimation(originView);
          toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
        });
        return;
      }
      const originView = dragOriginViewRef.current;
      const workbenchPayload = workbenchDragPayloadRef.current;
      const workbenchDropPosition =
        workbenchPointerPositionTrackerRef.current?.getPosition() ?? null;
      if (
        originView &&
        workbenchPayload &&
        workbenchDropPosition &&
        finishWorkbenchPointerDrag(
          workbenchPayload,
          workbenchDropPosition.x,
          workbenchDropPosition.y,
        )
      ) {
        resetGroupedTaskDrag();
        setViewWithGroupedTaskAnimation(originView);
        return;
      }
      const currentPreviewView = dragPreviewViewRef.current ?? authoritativeView;
      const nextView = currentPreviewView;
      resetGroupedTaskDrag();
      if (
        !originView ||
        getGroupedTaskViewSignature(nextView) === getGroupedTaskViewSignature(originView)
      ) {
        if (originView) {
          setViewWithGroupedTaskAnimation(originView);
        }
        return;
      }
      setViewWithGroupedTaskAnimation(nextView);
      void applyOrder(nextView).catch(() => {
        setViewWithGroupedTaskAnimation(originView);
        toast(intl.formatMessage({ id: "taskGroup.updateFailed" }));
      });
    },
    [
      activeDragGroupId,
      applyOrder,
      authoritativeView,
      intl,
      resetGroupedTaskDrag,
      restoreGroupDragCollapsedState,
      setViewWithGroupedTaskAnimation,
    ],
  );

  const activeDragTask = useMemo(
    () => (activeDragTaskKey ? findTaskInGroupedView(view, activeDragTaskKey) : null),
    [activeDragTaskKey, view],
  );
  const activeDragGroup = useMemo(
    () =>
      activeDragGroupId
        ? view.nodes.find((node) => node.type === "group" && node.group.id === activeDragGroupId)
        : null,
    [activeDragGroupId, view.nodes],
  );

  useEffect(() => {
    const dragging = activeDragTaskKey !== null || activeDragGroupId !== null;
    if (!dragging || typeof document === "undefined") {
      return undefined;
    }
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = previousCursor;
    };
  }, [activeDragTaskKey, activeDragGroupId]);

  const groupedTooltipsDisabled = activeDragTaskKey !== null || activeDragGroupId !== null;
  const stickyGroupNode = useMemo(
    () =>
      stickyGroupId
        ? view.nodes.find((node) => node.type === "group" && node.group.id === stickyGroupId)
        : null,
    [view.nodes, stickyGroupId],
  );
  useEffect(() => {
    if (!onStickyGroupHeaderChange) {
      return undefined;
    }
    if (stickyGroupNode?.type !== "group") {
      onStickyGroupHeaderChange(null);
      return () => onStickyGroupHeaderChange(null);
    }
    onStickyGroupHeaderChange(
      <StickyGroupHeader
        node={stickyGroupNode}
        collapsed={collapsedGroupIds.has(stickyGroupNode.group.id)}
        tooltipsDisabled={groupedTooltipsDisabled}
        onCreateTask={() =>
          stickyGroupNode.group.id === OFF_PEAK_DEFAULT_GROUP_ID
            ? onOpenAutomations?.()
            : handleCreateGroupDraftTask(stickyGroupNode.group.id)
        }
        onToggleCollapsed={handleToggleGroupCollapsed}
        onUpdateGroupColor={handleUpdateGroupColor}
        onUngroupGroup={handleUngroupGroup}
      />,
    );
    return () => onStickyGroupHeaderChange(null);
  }, [
    collapsedGroupIds,
    groupedTooltipsDisabled,
    handleCreateGroupDraftTask,
    onOpenAutomations,
    handleToggleGroupCollapsed,
    handleUngroupGroup,
    handleUpdateGroupColor,
    onStickyGroupHeaderChange,
    stickyGroupNode,
  ]);

  const renderTopLevelNode = useCallback(
    (node: ACodeGroupedTaskView["nodes"][number]) =>
      node.type === "group" ? (
        <div key={node.group.id} data-grouped-layout-key={`group:${node.group.id}`}>
          <GroupItem
            node={node}
            groups={groups}
            activeWorkspacePath={activeWorkspacePath}
            activeWorkspaceIdentity={activeWorkspaceIdentity}
            activeTaskId={activeTaskId}
            getTaskRemoteSessionId={getTaskRemoteSessionId}
            getTaskWorkspaceLabel={getTaskWorkspaceLabel}
            onSelectTask={onSelectTask}
            onCloseTask={handleCloseTask}
            onOpenFileTree={onOpenFileTree ? handleOpenTaskFileTree : undefined}
            onCreateTask={() =>
              node.group.id === OFF_PEAK_DEFAULT_GROUP_ID
                ? onOpenAutomations?.()
                : handleCreateGroupDraftTask(node.group.id)
            }
            hasDraftTask={
              groupedDraftTask?.placement.type === "group" &&
              groupedDraftTask.placement.groupId === node.group.id
            }
            draftTaskActive={isGroupedDraftActive}
            draftWorkspaceLabel={draftWorkspaceLabel}
            onSelectDraftTask={() => handleCreateGroupDraftTask(node.group.id)}
            onCloseDraftTask={handleCloseGroupedDraftTask}
            onRenameGroup={handleRenameGroup}
            onUpdateGroupColor={handleUpdateGroupColor}
            onUngroupGroup={handleUngroupGroup}
            onMoveTaskToGroup={handleMoveTaskToGroup}
            onMoveTaskToTop={handleMoveTaskToTop}
            onStartRenameTask={handleStartRenameTask}
            onArchiveTask={handleCloseTask}
            onMarkTaskAsUnread={handleMarkTaskAsUnread}
            newGroupSetup={newGroupSetupId === node.group.id}
            onNewGroupSetupStarted={handleNewGroupSetupStarted}
            collapsed={collapsedGroupIds.has(node.group.id)}
            onToggleCollapsed={handleToggleGroupCollapsed}
            activeDragTaskKey={activeDragTaskKey}
            activeDragGroupId={activeDragGroupId}
            tooltipsDisabled={groupedTooltipsDisabled}
          />
        </div>
      ) : (
        <GroupedTaskItem
          key={taskKey(node.task)}
          task={node.task}
          groups={groups}
          remoteSessionId={getTaskRemoteSessionId(node.task)}
          workspaceLabel={getTaskWorkspaceLabel(node.task)}
          activeWorkspacePath={activeWorkspacePath}
          activeWorkspaceIdentity={activeWorkspaceIdentity}
          activeTaskId={activeTaskId}
          onSelectTask={onSelectTask}
          onCloseTask={handleCloseTask}
          onOpenFileTree={onOpenFileTree ? handleOpenTaskFileTree : undefined}
          onMoveTaskToGroup={handleMoveTaskToGroup}
          onMoveTaskToTop={handleMoveTaskToTop}
          onStartRenameTask={handleStartRenameTask}
          onArchiveTask={handleCloseTask}
          onMarkTaskAsUnread={handleMarkTaskAsUnread}
          dragId={taskKey(node.task)}
          dragging={activeDragTaskKey === taskKey(node.task)}
          tooltipsDisabled={groupedTooltipsDisabled}
        />
      ),
    [
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspacePath,
      activeDragTaskKey,
      activeDragGroupId,
      groupedTooltipsDisabled,
      collapsedGroupIds,
      draftWorkspaceLabel,
      getTaskRemoteSessionId,
      getTaskWorkspaceLabel,
      groupedDraftTask?.placement,
      groups,
      handleCloseGroupedDraftTask,
      handleCloseTask,
      handleCreateGroupDraftTask,
      onOpenAutomations,
      handleMoveTaskToGroup,
      handleMoveTaskToTop,
      handleNewGroupSetupStarted,
      handleOpenTaskFileTree,
      handleRenameGroup,
      handleToggleGroupCollapsed,
      handleUngroupGroup,
      handleUpdateGroupColor,
      handleMarkTaskAsUnread,
      handleStartRenameTask,
      isGroupedDraftActive,
      newGroupSetupId,
      onOpenFileTree,
      onSelectTask,
    ],
  );

  // 首次权威请求结束前既需要阻止 grouped draft/空态抢先出现，又曾把这个
  // 数据门禁直接渲染成“正在获取任务”；切换到分组时，置顶列表下方因此闪出无帮助的文案。
  // 这里保留 initialized 门禁但隐藏主体，数据就绪后再一次性展示权威列表。
  // 门禁只该拦首屏。之前每次会话流式节点都可能让它回关，
  // grouped 整棵子树随之卸载再重挂载——这就是「左侧分组列表整块闪一下」。
  // 画过一次列表后一律继续渲染，旧数据优于空白。
  if (
    shouldHideGroupedTaskContent({
      initialized,
      loading,
      hasNodes: view.nodes.length > 0,
      hasPaintedOnce: hasPaintedGroupedListRef.current,
    })
  ) {
    return null;
  }
  if (view.nodes.length > 0) {
    // 渲染期写 ref 的前提（禁止照搬到非单调状态）：本 ref 是单调闩锁（false→true，永不回落），
    // 新值只由本次渲染的 view 内容推导。concurrent 下被丢弃的渲染也会执行这次赋值，最坏结果是
    // 门禁提前开门一帧、显示空态文案而不是隐藏；对可回落状态用同样写法则会产生不可复现的漏帧。
    hasPaintedGroupedListRef.current = true;
  }
  const dragOverlayWidthStyle = activeDragOverlayWidth
    ? { width: `${activeDragOverlayWidth}px` }
    : undefined;
  const dragOverlayWidthClassName =
    "transition-[width,max-width] duration-150 ease-out motion-reduce:transition-none";

  const groupedTaskDragOverlay = (
    <DragOverlay dropAnimation={GROUPED_TASK_DROP_ANIMATION}>
      {activeDragTask ? (
        <div className={dragOverlayWidthClassName} style={dragOverlayWidthStyle}>
          <GroupedTaskItem
            task={activeDragTask}
            groups={groups}
            remoteSessionId={getTaskRemoteSessionId(activeDragTask)}
            workspaceLabel={getTaskWorkspaceLabel(activeDragTask)}
            activeWorkspacePath={activeWorkspacePath}
            activeWorkspaceIdentity={activeWorkspaceIdentity}
            activeTaskId={activeTaskId}
            onSelectTask={onSelectTask}
            onCloseTask={handleCloseTask}
            onOpenFileTree={onOpenFileTree ? handleOpenTaskFileTree : undefined}
            onMoveTaskToGroup={handleMoveTaskToGroup}
            onMoveTaskToTop={handleMoveTaskToTop}
            onStartRenameTask={handleStartRenameTask}
            onArchiveTask={handleCloseTask}
            onMarkTaskAsUnread={handleMarkTaskAsUnread}
            dragId={activeDragTaskKey ?? undefined}
            dragOverlay
          />
        </div>
      ) : activeDragGroup?.type === "group" ? (
        <GroupDragOverlay
          node={activeDragGroup}
          className={dragOverlayWidthClassName}
          style={dragOverlayWidthStyle}
        />
      ) : null}
    </DragOverlay>
  );

  return (
    <>
      <TaskRenameDialog
        open={renamingTaskKey !== null}
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
          void handleSubmitRenameTask();
        }}
      />
      <DndContext
        sensors={sensors}
        autoScroll={{ threshold: GROUPED_TASK_AUTO_SCROLL_THRESHOLD }}
        collisionDetection={groupedTaskCollisionDetection}
        onDragStart={handleGroupedTaskDragStart}
        onDragMove={handleGroupedTaskDragMove}
        onDragOver={handleGroupedTaskDragOver}
        onDragEnd={handleGroupedTaskDragEnd}
        onDragCancel={handleGroupedTaskDragCancel}
      >
        <div
          ref={groupedSectionRootRef}
          onPointerDownCapture={handleGroupedPointerDownCapture}
          className={cn("pb-4", saving && "opacity-90")}
        >
          {groupedDraftTask?.placement.type === "top" ? (
            <GroupedDraftTaskRow
              active={isGroupedDraftActive}
              workspaceLabel={draftWorkspaceLabel}
              onSelect={handleCreateTopDraftTask}
              onClose={handleCloseGroupedDraftTask}
            />
          ) : null}
          <VirtualizedGroupedTopLevelList
            nodes={view.nodes}
            isGroupCollapsed={isGroupCollapsed}
            renderNode={renderTopLevelNode}
          />
          {view.nodes.length === 0 && !groupedDraftTask && !loading ? (
            <div className="px-3 py-2 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "taskList.noTasks" })}
            </div>
          ) : null}
        </div>
        {/* overlay 是鼠标浮层，挂到 body，避免被 grouped task 滚动容器的滚动条/裁剪上下文影响。 */}
        {typeof document === "undefined"
          ? groupedTaskDragOverlay
          : createPortal(groupedTaskDragOverlay, document.body)}
      </DndContext>
    </>
  );
}
