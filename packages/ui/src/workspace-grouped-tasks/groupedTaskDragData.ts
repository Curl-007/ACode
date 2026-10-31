/**
 * 批次 4 helper 外迁（god-component-split-plan 中 WorkspaceGroupedTasksSection 登记行）：
 * 拖拽 data 读取器、菜单/字符串数组等价判定与 dnd-kit 碰撞检测纯逻辑，
 * 从 WorkspaceGroupedTasksSection.tsx 逐字迁入（函数体零改动，仅补 export 与 import）。
 */
import { closestCenter } from "@dnd-kit/core";
import type { CollisionDetection } from "@dnd-kit/core";
import type { TaskGroupMenuItem } from "@/workspace-grouped-tasks/shared.js";

export function areTaskGroupMenuItemsEqual(
  left: readonly TaskGroupMenuItem[],
  right: readonly TaskGroupMenuItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.id === right[index]?.id &&
        item.title === right[index]?.title &&
        item.color === right[index]?.color,
    )
  );
}

export function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function getGroupedTaskDragTaskKey(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; taskKey?: unknown };
  return data.type === "grouped-task" && typeof data.taskKey === "string" ? data.taskKey : null;
}

export function getGroupedTaskDragGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-group" && typeof data.groupId === "string" ? data.groupId : null;
}

export function getGroupedTaskDragType(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown };
  return typeof data.type === "string" ? data.type : null;
}

export function getGroupedGroupOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-group-over" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export function getGroupedTaskCollapsedOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-collapsed-group" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export function getGroupedTaskHeaderOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-expanded-group-header" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export function getGroupedTaskFooterOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-expanded-group-footer" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export function getGroupedTaskEmptyOverGroupId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const data = value as { type?: unknown; groupId?: unknown };
  return data.type === "grouped-empty-drop-zone" && typeof data.groupId === "string"
    ? data.groupId
    : null;
}

export type GroupedTaskDragDirectionPosition = "before" | "after";

export const groupedTaskCollisionDetection: CollisionDetection = (args) => {
  const activeType = getGroupedTaskDragType(args.active.data.current);
  const droppableContainers =
    activeType === "grouped-group"
      ? args.droppableContainers.filter((container) => {
          const type = getGroupedTaskDragType(container.data.current);
          return type === "grouped-task" || type === "grouped-group-over";
        })
      : args.droppableContainers.filter(
          (container) => getGroupedTaskDragType(container.data.current) !== "grouped-group-over",
        );
  return closestCenter({
    ...args,
    droppableContainers,
  });
};
