/**
 * AutomationsSection 的 tab 可见性 / 导航 / 详情路由 / toast id 纯决策模型。
 * batch-1 helper 外迁（specs/god-component-split-plan.md「settings 上帝组件拆分计划」
 * AutomationsSection 登记行；review 2026-10-28 §3.①）：自 AutomationsSection.tsx 逐字迁移，
 * 纯函数、无 React、无闭包依赖。消费方：AutomationsSection 主组件与 AutomationActionsMenu。
 */
import type { ComponentType, SVGProps } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import {
  isAutomationCreateLimitError,
  type ACodeAutomation,
  type ACodeOffPeakTask,
} from "@acode/shared";
import {
  AutomationClockIcon,
  AutomationPausedIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import type { AutomationStatusKind } from "@/settings/automationFormat.js";
import type { AutomationRunNowResult } from "@/store/automationManagementStore.js";

/** 主视图标签页：Scheduled 常驻，Idle-time 受灰度控制；不设 All 混排视图。 */
export type AutomationsTab = "scheduled" | "idle";

export const AUTOMATIONS_TOAST_ANCHOR_ID = "automations-main-toast-anchor";

export const SCHEDULED_ONLY_AUTOMATION_TABS: readonly AutomationsTab[] = ["scheduled"];
export const SCHEDULED_AND_IDLE_AUTOMATION_TABS: readonly AutomationsTab[] = ["scheduled", "idle"];

export function resolveVisibleAutomationTabs({
  hasAnyTasks,
  offPeakVisible,
}: {
  hasAnyTasks: boolean;
  offPeakVisible: boolean;
}): readonly AutomationsTab[] {
  if (!hasAnyTasks) return [];
  return offPeakVisible ? SCHEDULED_AND_IDLE_AUTOMATION_TABS : SCHEDULED_ONLY_AUTOMATION_TABS;
}

export function resolveAutomationTabAfterOffPeakChange(
  tab: AutomationsTab,
  offPeakVisible: boolean,
): AutomationsTab {
  return tab === "idle" && !offPeakVisible ? "scheduled" : tab;
}

export function resolveAutomationTabNavigation({
  requestedTab,
  tabsReady,
  visibleTabs,
}: {
  requestedTab: AutomationsTab;
  tabsReady: boolean;
  visibleTabs: readonly AutomationsTab[];
}): { status: "pending" } | { status: "settled"; tab: AutomationsTab } {
  if (!tabsReady) return { status: "pending" };
  return {
    status: "settled",
    tab: visibleTabs.includes(requestedTab) ? requestedTab : "scheduled",
  };
}

export function resolveAutomationTemplateVisibility({
  hasAnyTasks,
  offPeakCreationEnabled,
  tab,
}: {
  hasAnyTasks: boolean;
  offPeakCreationEnabled: boolean;
  tab: AutomationsTab;
}): {
  showOffPeakTemplates: boolean;
  showScheduledTemplates: boolean;
} {
  // 移除 All tab 后空首页仍默认落在 Scheduled，导致闲时模板被 tab 条件误隐藏。
  // 无任务时恢复两类模板并列展示；有任务后继续由 Scheduled / Idle tab 分流。
  const showAllTemplates = !hasAnyTasks;
  return {
    showOffPeakTemplates: offPeakCreationEnabled && (showAllTemplates || tab === "idle"),
    showScheduledTemplates: showAllTemplates || tab === "scheduled",
  };
}

export const STATUS_META: Record<
  AutomationStatusKind,
  { icon: ComponentType<SVGProps<SVGSVGElement>>; className: string }
> = {
  active: { icon: AutomationClockIcon, className: "text-success" },
  // 设计稿的暂停态是 stop-circle 描边图标，不能回退为圆圈内实心方块。
  paused: { icon: AutomationPausedIcon, className: "text-foreground-subtle" },
  completed: { icon: CircleCheck, className: "text-foreground-subtle" },
  failed: { icon: TriangleAlert, className: "text-destructive" },
};

export function automationPromptSummary(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : " ";
}

export function canRestartAutomation(
  automation: Pick<ACodeAutomation, "lifecycleStatus">,
): boolean {
  return automation.lifecycleStatus === "failed";
}

export function canToggleAutomation(
  automation: Pick<ACodeAutomation, "lifecycleStatus">,
): boolean {
  return automation.lifecycleStatus !== "completed" && automation.lifecycleStatus !== "failed";
}

export function getAutomationRunNowToastId(
  result: AutomationRunNowResult,
): "automations.runNowQueued" | "automations.runNowAlreadyRunning" | "automations.runNowFailed" {
  if (result === "queued") return "automations.runNowQueued";
  if (result === "duplicate") return "automations.runNowAlreadyRunning";
  return "automations.runNowFailed";
}

export type AutomationActionError = "create" | "update" | "toggle" | "restart" | "delete";

/** 原始 Agent/RPC 错误留在 logger；界面只展示当前动作对应的可理解提示。 */
export function getAutomationActionErrorToastId(action: AutomationActionError): string {
  return `automations.error.${action}`;
}

export function getAutomationCreateErrorToastId(error: unknown): string {
  return isAutomationCreateLimitError(error)
    ? "automations.error.createLimit"
    : getAutomationActionErrorToastId("create");
}

export function resolveAutomationDetailTarget(
  automations: readonly ACodeAutomation[],
  automationId?: string | null,
): ACodeAutomation | null {
  const targetId = automationId?.trim();
  if (!targetId) return null;
  return automations.find((automation) => automation.automationId === targetId) ?? null;
}

export function resolveAutomationDetailNavigation(
  automations: readonly ACodeAutomation[],
  automationId: string | null | undefined,
  listReady: boolean,
): { status: "pending" } | { status: "missing" } | { status: "found"; target: ACodeAutomation } {
  if (!automationId?.trim() || !listReady) return { status: "pending" };
  const target = resolveAutomationDetailTarget(automations, automationId);
  return target ? { status: "found", target } : { status: "missing" };
}

/** openAutomationId 里 `offpeak-` 前缀 id 的判别（生成点唯一：offPeakTaskService 的 offpeak-${uuid}）。 */
export function isOffPeakDetailNavigationId(automationId: string | null | undefined): boolean {
  return Boolean(automationId?.trim().startsWith("offpeak-"));
}

/** 闲时轮尾卡跳转的并行解析路径；与 cron 的 resolveAutomationDetailNavigation 对称。 */
export function resolveOffPeakDetailNavigation(
  tasks: readonly ACodeOffPeakTask[],
  offPeakTaskId: string | null | undefined,
  listReady: boolean,
  listError: string | null = null,
):
  | { status: "pending" }
  | { status: "unavailable" }
  | { status: "missing" }
  | { status: "found"; target: ACodeOffPeakTask } {
  const targetId = offPeakTaskId?.trim();
  if (!targetId || !listReady) return { status: "pending" };
  // review：store.refresh 吞错保留旧列表；列表不可信时不能做 found/missing 终审。
  if (listError) return { status: "unavailable" };
  const target = tasks.find((task) => task.offPeakTaskId === targetId) ?? null;
  return target ? { status: "found", target } : { status: "missing" };
}
