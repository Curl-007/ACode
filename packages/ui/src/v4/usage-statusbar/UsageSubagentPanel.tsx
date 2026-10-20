import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { formatUsageTokenCount } from "@/v4/usage-statusbar/usageStatusbarFormat.js";
import { UsageStatusbarTooltipNote } from "@/v4/usage-statusbar/UsageStatusbarCapsule.js";
import type {
  SubagentPanelItem,
  SubagentSummaryView,
} from "@/v4/usage-statusbar/usageStatusbarModel.js";

// 子智能体展开面板：列表 = 每派发任务（标题 + cumulativeTokens + running 状态）。
// 归因纪律：只消费投影给的官方关联字段（RunningSubagentSummary 的 agentId 硬关联产物：
// title/subagentType/childSessionId/cumulativeTokens/status），无名字显示线路名
// （subagentType），连线路名都没有才落到 childSessionId——宁无名不错名；
// 禁止任何时间/前缀启发式。● 指示只用权威 status，不做心跳猜测。

const STATUS_MESSAGE_ID: Record<SubagentPanelItem["status"], string> = {
  running: "chat.usageStatusbar.subagents.running",
  waiting: "chat.usageStatusbar.subagents.waiting",
  blocked: "chat.usageStatusbar.subagents.blocked",
};

export function UsageSubagentPanel({
  view,
  locale,
  mainTotalTokens,
}: {
  view: SubagentSummaryView;
  locale: string;
  /** 主代理累计（input+output，来自 snapshot.usage.cumulative 权威面）。 */
  mainTotalTokens: number;
}) {
  const { intl } = useACodeIntl();
  return (
    <div className="flex w-72 flex-col gap-1.5" data-testid="usage-statusbar-subagent-panel">
      <div className="flex items-baseline justify-between gap-3 px-1 text-ui-sm">
        <span className="text-foreground-subtle">
          {intl.formatMessage({ id: "chat.usageStatusbar.subagents.main" })}
        </span>
        <span className="font-mono tabular-nums text-foreground">
          {formatUsageTokenCount(locale, mainTotalTokens)}
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-3 px-1 text-ui-sm">
        <span className="text-foreground-subtle">
          {intl.formatMessage({ id: "chat.usageStatusbar.subagents.children" })}
          {view.endedTotal > 0
            ? ` · ${intl.formatMessage({ id: "chat.usageStatusbar.subagents.ended" }, { count: view.endedTotal })}`
            : null}
        </span>
        <span className="font-mono tabular-nums text-foreground">
          {/* 旧投影不带 cumulativeTokens（缺席 ≠ 0）：整列显示占位而非假零。 */}
          {formatUsageTokenCount(locale, view.childTotalTokens)}
        </span>
      </div>
      <span className="border-t border-border" />
      {view.items.length === 0 ? (
        <span className="px-1 py-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.usageStatusbar.subagents.empty" })}
        </span>
      ) : (
        <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
          {view.items.map((item) => (
            <li
              key={item.childSessionId}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-ui-sm"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  item.status === "running" ? "animate-pulse bg-success" : "bg-foreground-subtle",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-foreground" title={item.label}>
                {item.label}
              </span>
              <span className="shrink-0 text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: STATUS_MESSAGE_ID[item.status] })}
              </span>
              <span className="w-14 shrink-0 text-right font-mono tabular-nums text-foreground-subtle">
                {formatUsageTokenCount(locale, item.cumulativeTokens)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* 胶囊 hover Tooltip 退役（specs/usage-statusbar.md「Tooltip 稳定性」2026-10-19
          最小修复）：值语义口径说明移入点击面板尾部，i18n key 不变。 */}
      <UsageStatusbarTooltipNote>
        {intl.formatMessage({ id: "chat.usageStatusbar.subagents.tooltip" })}
      </UsageStatusbarTooltipNote>
    </div>
  );
}
