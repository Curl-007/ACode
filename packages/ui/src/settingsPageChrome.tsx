/**
 * SettingsPage 的 chrome 小组件：Usage 分区 Coding Plan provider tabs 与侧栏导航按钮。
 * 批次 4 helper 外迁（settings 上帝组件拆分计划扩展批次，2026-10-28）：自 SettingsPage.tsx
 * 逐字迁移，JSX 结构未改一字；消费方：仅 SettingsPage 主组件。
 */
import { type LucideIcon } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { TID_SETTINGS_USAGE_TAB, testId } from "@acode/shared";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { SegmentPill } from "@/settings/PluginStoreListView.js";
import type { UsageStatsSectionTab } from "@/settings/UsageStatsSection.js";
import type { CodingPlanUsageSource } from "@/settings/usage-stats/CodingPlanUsagePanel.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import {
  createSettingsUsageCodingPlanTabId,
  isTeamCodingPlanUsageSource,
  resolveSettingsUsageCodingPlanTabLabel,
} from "./settingsUsageCodingPlanTabs.js";

export function SettingsUsageProviderTabs({
  activeTab,
  codingPlanSources,
  onTabChange,
}: {
  activeTab: UsageStatsSectionTab;
  codingPlanSources: CodingPlanUsageSource[];
  onTabChange: (tab: UsageStatsSectionTab) => void;
}) {
  const { intl } = useACodeIntl();
  const tabItems = [
    {
      id: "app" as const,
      label: intl.formatMessage({ id: "settings.usage.tab.appUsage" }),
    },
    ...codingPlanSources.map((source, index) => ({
      id: createSettingsUsageCodingPlanTabId(source.id),
      label: resolveSettingsUsageCodingPlanTabLabel({
        defaultLabel: intl.formatMessage({
          id: "settings.usage.tab.codingPlan",
        }),
        hasMultiplePersonalSources:
          codingPlanSources.filter((item) => !isTeamCodingPlanUsageSource(item)).length > 1,
        index,
        source,
      }),
    })),
  ];
  const visibleActiveTab =
    activeTab === "codingPlan" && codingPlanSources[0]
      ? createSettingsUsageCodingPlanTabId(codingPlanSources[0].id)
      : activeTab;

  return (
    <div className="flex items-center gap-1.5">
      {tabItems.map((item) => (
        <SegmentPill
          key={item.id}
          active={visibleActiveTab === item.id}
          label={item.label}
          testId={testId(TID_SETTINGS_USAGE_TAB, item.id)}
          onClick={() => onTabChange(item.id)}
        />
      ))}
    </div>
  );
}

export function SettingsSidebarButton({
  icon: Icon,
  label,
  active,
  children,
  className,
  ...buttonProps
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  children?: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <ControlHintTooltip title={label} side="right" align="center">
      <button
        {...buttonProps}
        type={buttonProps.type ?? "button"}
        aria-label={label}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-xl px-2.5 text-left transition-colors",
          "max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0",
          active
            ? "bg-surface-hover text-foreground"
            : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
          className,
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-current">
          <Icon className="size-4 text-foreground" />
        </span>
        <span className="min-w-0 flex-1 max-lg:sr-only">
          {children ?? <span className="truncate text-ui-base text-foreground">{label}</span>}
        </span>
      </button>
    </ControlHintTooltip>
  );
}
