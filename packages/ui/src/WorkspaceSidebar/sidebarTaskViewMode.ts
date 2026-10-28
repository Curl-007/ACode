/**
 * WorkspaceSidebar 批次 5 外迁：任务区视图模式纯决策（逐字迁移自 WorkspaceSidebar.tsx）。
 */
import type { SidebarTaskOrganizeBy } from "@/lib/sidebarTaskPreferences.js";

export type SidebarTaskViewMode = "grouped" | "workspace" | "timeline" | "archived";

export function resolveSidebarTaskViewMode(params: {
  showArchivedTasks: boolean;
  taskOrganizeBy: SidebarTaskOrganizeBy;
}): SidebarTaskViewMode {
  if (params.showArchivedTasks) {
    return "archived";
  }
  if (params.taskOrganizeBy === "chronological") {
    return "timeline";
  }
  if (params.taskOrganizeBy === "grouped") {
    return "grouped";
  }
  return "workspace";
}
