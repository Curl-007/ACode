/**
 * 批次 4 helper 外迁（god-component-split-plan 中 WorkspaceGroupedTasksSection 登记行）：
 * drag-over 预览视图构建器与视图签名，从 WorkspaceGroupedTasksSection.tsx 逐字迁入
 * （函数体零改动，仅补 export 与 import）；moveTask/moveGroup 系列仍来自 shared.js。
 */
import type { ACodeGroupedTaskView } from "@acode/services";
import type { DragOverEvent } from "@dnd-kit/core";
import {
  moveGroupAroundTopLevelNode,
  moveTaskOverTask,
  moveTaskToGroupEnd,
  moveTaskToGroupStart,
  moveTaskToRootAroundGroup,
  taskKey,
} from "@/workspace-grouped-tasks/shared.js";
import {
  getGroupedGroupOverGroupId,
  getGroupedTaskCollapsedOverGroupId,
  getGroupedTaskDragGroupId,
  getGroupedTaskDragTaskKey,
  getGroupedTaskEmptyOverGroupId,
  getGroupedTaskFooterOverGroupId,
  getGroupedTaskHeaderOverGroupId,
} from "@/workspace-grouped-tasks/groupedTaskDragData.js";
import type { GroupedTaskDragDirectionPosition } from "@/workspace-grouped-tasks/groupedTaskDragData.js";

export function getGroupedTaskOverTaskPreviewView(
  view: ACodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ACodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overTaskKey = getGroupedTaskDragTaskKey(event.over?.data.current);
  if (!activeTaskKey || !overTaskKey || activeTaskKey === overTaskKey) {
    return view;
  }
  return moveTaskOverTask(view, {
    activeTaskKey,
    overTaskKey,
    position,
  });
}

export function getGroupedTaskOverCollapsedGroupPreviewView(
  view: ACodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ACodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskCollapsedOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  return moveTaskToRootAroundGroup(view, {
    activeTaskKey,
    groupId: overGroupId,
    position,
  });
}

export function getGroupedTaskOverGroupHeaderPreviewView(
  view: ACodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ACodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskHeaderOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  if (position === "before") {
    return moveTaskToRootAroundGroup(view, {
      activeTaskKey,
      groupId: overGroupId,
      position: "before",
    });
  }
  return moveTaskToGroupStart(view, {
    activeTaskKey,
    groupId: overGroupId,
  });
}

export function getGroupedTaskOverGroupFooterPreviewView(
  view: ACodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ACodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskFooterOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  if (position === "before") {
    return moveTaskToGroupEnd(view, {
      activeTaskKey,
      groupId: overGroupId,
    });
  }
  return moveTaskToRootAroundGroup(view, {
    activeTaskKey,
    groupId: overGroupId,
    position: "after",
  });
}

export function getGroupedTaskOverEmptyDropZonePreviewView(
  view: ACodeGroupedTaskView,
  event: DragOverEvent,
): ACodeGroupedTaskView {
  const activeTaskKey = getGroupedTaskDragTaskKey(event.active.data.current);
  const overGroupId = getGroupedTaskEmptyOverGroupId(event.over?.data.current);
  if (!activeTaskKey || !overGroupId) {
    return view;
  }
  return moveTaskToGroupStart(view, {
    activeTaskKey,
    groupId: overGroupId,
  });
}

export function getGroupedGroupOverGroupPreviewView(
  view: ACodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ACodeGroupedTaskView {
  const activeGroupId = getGroupedTaskDragGroupId(event.active.data.current);
  const overGroupId = getGroupedGroupOverGroupId(event.over?.data.current);
  if (!activeGroupId || !overGroupId || activeGroupId === overGroupId) {
    return view;
  }
  return moveGroupAroundTopLevelNode(view, {
    activeGroupId,
    over: { type: "group", groupId: overGroupId },
    position,
  });
}

export function getGroupedGroupOverTaskPreviewView(
  view: ACodeGroupedTaskView,
  event: DragOverEvent,
  position: GroupedTaskDragDirectionPosition,
): ACodeGroupedTaskView {
  const activeGroupId = getGroupedTaskDragGroupId(event.active.data.current);
  const overTaskKey = getGroupedTaskDragTaskKey(event.over?.data.current);
  if (!activeGroupId || !overTaskKey) {
    return view;
  }
  return moveGroupAroundTopLevelNode(view, {
    activeGroupId,
    over: { type: "task", taskKey: overTaskKey },
    position,
  });
}

export function getGroupedTaskViewSignature(view: ACodeGroupedTaskView): string {
  return view.nodes
    .map((node) =>
      node.type === "task"
        ? `t:${taskKey(node.task)}`
        : `g:${node.group.id}[${node.tasks.map(taskKey).join(",")}]`,
    )
    .join("|");
}
