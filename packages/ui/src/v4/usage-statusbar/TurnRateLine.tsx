import { Zap } from "lucide-react";
import type { TurnHeaderStats } from "@acode/shared/acode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatTokensPerSecond,
  formatUsageDurationMs,
  formatUsageTokenCount,
} from "@/v4/usage-statusbar/usageStatusbarFormat.js";
import { deriveTurnRateLine } from "@/v4/usage-statusbar/usageStatusbarModel.js";
import { useUsageStatusbarPreferences } from "@/v4/usage-statusbar/useUsageStatusbarPreferences.js";

// 回答末尾速率行（specs/usage-statusbar.md「回答末尾速率行」节；inert 展示件）。
// 挂载点（ConversationTurnGroup/Timeline 的轮尾）由编排者接线；本组件只消费**单个**
// turnHeader.stats——stats=null（纯问答轮/无模型事实）或速率行开关关闭 → 不渲染，
// 绝不显示上一问的统计（宿主按轮传入，组件自身无跨轮状态）。

export interface TurnRateLineProps {
  /** 该轮的 turnHeader.stats；null/undefined → 不渲染。 */
  stats: TurnHeaderStats | null | undefined;
  /** 缺省读偏好事实源的速率行开关；显式传入供宿主/测试覆盖。 */
  enabled?: boolean;
  className?: string;
}

export function TurnRateLine({ stats, enabled, className }: TurnRateLineProps) {
  const { intl, locale } = useACodeIntl();
  const preferences = useUsageStatusbarPreferences();
  const rateLineEnabled = enabled ?? preferences.rateLineEnabled;
  const model = deriveTurnRateLine(stats ?? null);
  if (!rateLineEnabled || !model) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "flex w-fit items-center gap-1.5 rounded-md px-1.5 py-0.5 text-ui-sm tabular-nums text-foreground-subtle",
            className,
          )}
          data-testid="turn-rate-line"
        >
          <Zap aria-hidden="true" className="size-3.5 shrink-0" />
          {/* tok/s 后缀走 i18n（specs/usage-statusbar.md「排版一致性」节）。 */}
          <span className="font-mono">
            {formatTokensPerSecond(
              locale,
              model.tokensPerSecond,
              intl.formatMessage({ id: "chat.usageStatusbar.unit.tokensPerSecond" }),
            )}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {intl.formatMessage(
              { id: "chat.usageStatusbar.rateLine.ttft" },
              { duration: formatUsageDurationMs(locale, model.timeToFirstTokenMs) },
            )}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            {intl.formatMessage(
              { id: "chat.usageStatusbar.rateLine.output" },
              { count: formatUsageTokenCount(locale, model.outputTokens) },
            )}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatUsageDurationMs(locale, model.generationMs)}</span>
          {/* 多模型轮标记（specs/usage-statusbar.md，omp served-model marker 对应物）：
              轮中模型晋升产生 ≥2 个服务模型时才出现；单模型轮不加噪音。 */}
          {model.servedModels.length >= 2 ? (
            <>
              <span aria-hidden="true">·</span>
              <span
                className="inline-flex items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-sm leading-none whitespace-nowrap text-foreground-subtle ring-1 ring-border"
                title={model.servedModels.join(" → ")}
              >
                {intl.formatMessage({ id: "chat.usageStatusbar.rateLine.multiModel" })}
              </span>
            </>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent
        className="max-w-80 flex-col items-start gap-1 px-3 py-2 text-left"
        side="top"
      >
        {/* tooltip 标题 = text-ui-sm（DESIGN.md「Tooltip：titles … use text-ui-sm」）。 */}
        <span className="text-ui-sm font-medium">
          {intl.formatMessage({ id: "chat.usageStatusbar.rateLine.label" })}
        </span>
        {/* 口径差异必须随速率行解释：状态栏 = 最近一段请求；速率行 = 本问已入库多段
            的加权（Σoutput ÷ ΣgenerationMs），收尾正文不在采样内。 */}
        <span className="text-ui-xs leading-snug text-tooltip-foreground/70">
          {intl.formatMessage({ id: "chat.usageStatusbar.rateLine.tooltip" })}
        </span>
        {model.servedModels.length > 0 ? (
          <span className="font-mono text-ui-xs leading-snug text-tooltip-foreground/70">
            {intl.formatMessage(
              { id: "chat.usageStatusbar.rateLine.servedModels" },
              { models: model.servedModels.join(" → ") },
            )}
          </span>
        ) : null}
        {model.promptCacheMisses !== null && model.promptCacheMisses > 0 ? (
          <span className="text-ui-xs leading-snug text-tooltip-foreground/70">
            {intl.formatMessage(
              { id: "chat.usageStatusbar.rateLine.cacheMisses" },
              { count: String(model.promptCacheMisses) },
            )}
          </span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
