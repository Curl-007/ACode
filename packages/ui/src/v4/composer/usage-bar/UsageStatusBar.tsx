/**
 * 输入框下方的用量状态栏（apps/acode-cli/specs/usage-statusbar-port.md §2/R5）。
 *
 * 数字全部读 snapshot 上的权威事实（CLI ProductProjection 下发）与本地 AppUsage 聚合：
 * 这里不重算指标、不估算 token，只做可见性、折叠与渲染。展示开关读目标设置切片
 * （lib/usageStatusbarPreferences.ts），与设置页同一字段。
 *
 * 位置：挂在 composer 输入卡之外、工具条之下单独一行，避免与模型选择器抢宽度。
 * 窄宽折叠走容器查询（@container/usagebar）：先收上下文容量、今日、本轮，再收子智能体、工具；
 * 「生成速度」「会话累计」和齿轮永不收起。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TID_V4_COMPOSER_USAGE_BAR, TID_V4_COMPOSER_USAGE_BAR_SETTINGS } from "@acode/shared";
import type { ConversationSnapshot } from "@acode/shared/acode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { useTodayAppUsage } from "@/hooks/useTodayAppUsage.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useLiveOutputRate } from "@/v4/composer/useLiveOutputRate.js";
import { useChildSessionTokenStats } from "@/v4/composer/useChildSessionTokenStats.js";
import {
  collectChildSessionIds,
  collectLiveChildSessionIds,
  isLiveOutputPhase,
  readSessionTokenTotal,
} from "@/v4/composer/sessionTokenStats.js";
import { resolveContextUsageCostUSD } from "@/chat-input-toolbar/contextUsageCost.js";
import {
  buildUsageBarModel,
  resolveUsageBarSettings,
  USAGE_BAR_COLLAPSE_TIER,
  type UsageBarModel,
  type UsageBarSettings,
} from "./usageBarModel.js";
import {
  activateDetail,
  deactivateDetail,
  EMPTY_DETAIL_GROUP_STATE,
  type UsageBarDetailGroup,
} from "./usageBarDetailGroup.js";
import { UsageBarHoverDetail } from "./UsageBarHoverDetail.js";
import { UsageBarSettingsPopover } from "./UsageBarSettingsPopover.js";
import { UsageBarSubagentPanel, type SubagentTaskDescriptor } from "./UsageBarSubagentPanel.js";
import { UsageBarMoreTooltip, UsageBarSegmentView } from "./usageBarSegmentView.js";
import { useUsageBarPreferences } from "./useUsageBarPreferences.js";

interface UsageStatusBarProps {
  snapshot: ConversationSnapshot | null;
  /** 会话权威模型 id（快照 config.model 优先），用于预估费用查表。 */
  costModelId?: string | null;
  /** 子代理面板查询已结束明细用（与「子智能体目录」同一条游标查询）。 */
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export const UsageStatusBar = memo(function UsageStatusBarImpl(props: UsageStatusBarProps) {
  const preferences = useUsageBarPreferences();
  const resolved = useMemo(() => resolveUsageBarSettings(preferences), [preferences]);
  return <UsageStatusBarWithData {...props} settings={resolved} />;
});

/** 数据层：把 snapshot + 子会话/本地聚合归一成模型入参。 */
function UsageStatusBarWithData({
  snapshot,
  costModelId = null,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  settings,
}: UsageStatusBarProps & { settings: UsageBarSettings }) {
  const { intl, locale } = useACodeIntl();
  const { layer } = useV4Conversation();
  const liveOutputRate = useLiveOutputRate(snapshot);
  const sessionId = snapshot?.sessionId ?? "";
  const childIds = useMemo(
    () => collectChildSessionIds(snapshot, sessionId),
    [snapshot, sessionId],
  );
  // 只实时订阅运行中的子会话（有上限），已结束的不再拉整条投影进 renderer。
  const liveChildIds = useMemo(
    () => collectLiveChildSessionIds(snapshot, sessionId),
    [snapshot, sessionId],
  );
  const childStats = useChildSessionTokenStats(layer, childIds, liveChildIds);
  const { todayUsage, refresh } = useTodayAppUsage(settings.today);

  const turnLive = snapshot ? isLiveOutputPhase(snapshot.control.phase) : false;
  const displayUsage = snapshot?.usage ?? null;
  const mainTokenTotal = readSessionTokenTotal(
    displayUsage?.cumulative ?? null,
    snapshot?.usage.contextWindow?.usedTokens ?? 0,
  );
  const childTokenTotal = childStats.tokenTotal;
  const sessionTokenTotal = mainTokenTotal === null ? null : mainTokenTotal + childTokenTotal;
  // 预估费用只在有会话累计时查表（与原上下文弹层同一门槛：0 不显示 $0.00）。
  const estimatedCostUSD =
    mainTokenTotal === null || mainTokenTotal <= 0
      ? null
      : resolveContextUsageCostUSD({
          modelId: costModelId,
          cumulative: snapshot?.usage.cumulative ?? null,
        });

  const contextWindow = snapshot?.usage.contextWindow ?? null;
  const contextCapacity = useMemo(
    () =>
      contextWindow === null || contextWindow === undefined
        ? null
        : {
            usedTokens: contextWindow.usedTokens,
            maxTokens: contextWindow.maxTokens,
            autoCompactThresholdTokens: contextWindow.autoCompactThresholdTokens,
            cacheHitRate: contextWindow.cache?.hitRate ?? null,
          },
    [contextWindow],
  );

  // 子代理任务（面板与段值共用）：任务名与「子智能体目录」同源（running[].title /
  // 目录查询的 ended title），用量按 childSessionId 取各子会话累计；缺名退回线路名。
  const subagentTasks = useMemo<SubagentTaskDescriptor[]>(
    () =>
      (snapshot?.subagents?.running ?? []).map((item) => ({
        childSessionId: item.childSessionId,
        title: item.title,
        subagentType: item.subagentType,
        status: item.status,
      })),
    [snapshot?.subagents?.running],
  );

  // 段值只算「正在运行」的任务（已结束不进段值）：把运行中任务的各自用量相加，
  // 一个都读不到时给 null，段值就省略 tokens 部分而不是显示 0。
  const runningTokenTotal = useMemo(() => {
    let sum = 0;
    let known = 0;
    for (const task of subagentTasks) {
      const total = childStats.tokenTotalByChildId.get(task.childSessionId);
      if (total === undefined) continue;
      sum += total;
      known += 1;
    }
    return known > 0 ? sum : null;
  }, [subagentTasks, childStats.tokenTotalByChildId]);

  const model = useMemo(
    () =>
      buildUsageBarModel({
        turnMetrics: snapshot?.composerTurnMetrics ?? null,
        turnLive,
        mainTokenTotal,
        mainInputTokens: snapshot?.usage.cumulative.inputTokens ?? null,
        mainOutputTokens: snapshot?.usage.cumulative.outputTokens ?? null,
        sessionTokenTotal,
        incompleteTotal: childStats.unknownCount > 0,
        contextCapacity,
        liveOutputRate,
        childLiveOutputRate: childStats.liveOutputRate,
        childCount: childStats.childCount,
        childTokenTotal,
        childCurrentOutputTokens: childStats.currentOutputTokens,
        // 与上下文弹层同源，但不套 78% 展示门槛：状态栏明细是用量口径，低命中也要看得到。
        cacheHitRate: contextWindow?.cache?.hitRate ?? null,
        toolStats: snapshot?.sessionToolStats ?? null,
        subagentGroups: {
          running: subagentTasks.length,
          ended: snapshot?.subagents?.endedTotal ?? 0,
          mainTokenTotal,
          runningTokenTotal,
        },
        todayUsage,
        estimatedCostLabel:
          estimatedCostUSD === null || estimatedCostUSD <= 0
            ? null
            : new Intl.NumberFormat(undefined, { currency: "USD", style: "currency" }).format(
                estimatedCostUSD,
              ),
        settings,
        formatMessage: intl.formatMessage,
        locale,
      }),
    [
      snapshot?.composerTurnMetrics,
      turnLive,
      snapshot?.usage,
      mainTokenTotal,
      sessionTokenTotal,
      contextCapacity,
      childStats.unknownCount,
      childStats.liveOutputRate,
      childStats.childCount,
      childTokenTotal,
      childStats.currentOutputTokens,
      contextWindow?.cache?.hitRate,
      snapshot?.sessionToolStats,
      subagentTasks,
      runningTokenTotal,
      snapshot?.subagents?.endedTotal,
      liveOutputRate,
      todayUsage,
      estimatedCostUSD,
      settings,
      intl,
      locale,
    ],
  );

  // 轮收口（streaming true → false）后请求一次今日合计刷新；防抖与去轮询在 hook 内部。
  const streaming = (snapshot?.composerTurnMetrics?.streaming ?? false) || turnLive;
  const wasStreamingRef = useRef(streaming);
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) refresh();
    wasStreamingRef.current = streaming;
  }, [streaming, refresh]);

  const subagentPanel = useCallback(
    (pinned: boolean) => (
      <UsageBarSubagentPanel
        runningTasks={subagentTasks}
        childTokenTotals={childStats.tokenTotalByChildId}
        childRates={childStats.rateByChildId}
        mainTokenTotal={mainTokenTotal}
        endedTotal={snapshot?.subagents?.endedTotal ?? 0}
        sessionId={sessionId || null}
        workspacePath={workspacePath ?? null}
        {...(workspaceIdentity ? { workspaceIdentity } : {})}
        {...(remoteSessionId ? { remoteSessionId } : {})}
        pinned={pinned}
      />
    ),
    [
      subagentTasks,
      childStats.tokenTotalByChildId,
      childStats.rateByChildId,
      mainTokenTotal,
      snapshot?.subagents?.endedTotal,
      sessionId,
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
    ],
  );

  return (
    <UsageStatusBarView model={model} settings={settings} renderSubagentPanel={subagentPanel} />
  );
}

function UsageStatusBarView({
  model,
  settings,
  renderSubagentPanel,
}: {
  model: UsageBarModel;
  settings: UsageBarSettings;
  renderSubagentPanel: (pinned: boolean) => ReactNode;
}) {
  const { intl } = useACodeIntl();
  // 明细互斥：状态栏是这组浮层状态的所有者，同一时刻只让一个展开（spec §2.2）。
  // 规则本体是 usageBarDetailGroup.ts 的纯函数（可单测），这里只把它接到 React state。
  const [detailGroupState, setDetailGroupState] = useState(EMPTY_DETAIL_GROUP_STATE);
  const detailGroup = useMemo<UsageBarDetailGroup>(
    () => ({
      activeId: detailGroupState.activeId,
      activate: (id) => setDetailGroupState((current) => activateDetail(current, id)),
      deactivate: (id) => setDetailGroupState((current) => deactivateDetail(current, id)),
    }),
    [detailGroupState],
  );
  if (!model.visible) return null;

  // 「+N」必须只数**当前宽度真的被收起**的段：两个断点各挂一个浮层，
  // 480–639px 时子智能体/工具还在栏上，不能把它们算进 N（否则浮层与栏上项重复）。
  const collapsedAt = (tier: "wideTier" | "narrowTier") =>
    model.segments.filter((segment) => {
      const segmentTier = USAGE_BAR_COLLAPSE_TIER[segment.id];
      if (segmentTier === undefined) return false;
      // 窄档时宽档已先收起，两者都在「看不到」的集合里。
      return segmentTier === tier || (tier === "narrowTier" && segmentTier === "wideTier");
    });
  const moreTiers = [
    // 只在 480–639px 显示：数宽档的三段。
    {
      key: "wideTier" as const,
      className: "@min-[640px]/usagebar:hidden @max-[479px]/usagebar:hidden",
    },
    // 只在 <480px 显示：宽档 + 窄档全收起。
    { key: "narrowTier" as const, className: "@min-[480px]/usagebar:hidden" },
  ];

  return (
    <div
      data-testid={TID_V4_COMPOSER_USAGE_BAR}
      data-usage-bar-root
      role="status"
      aria-label={model.segments.map((segment) => `${segment.label} ${segment.value}`).join(", ")}
      className="@container/usagebar flex h-7 w-full min-w-0 items-center gap-0.5 overflow-hidden px-1 font-mono text-ui-sm text-foreground-subtle tabular-nums"
    >
      {model.segments.map((segment) => (
        <UsageBarSegmentView
          key={segment.id}
          segment={segment}
          detailGroup={detailGroup}
          // 子智能体段的明细是任务级面板（固定浮层），替掉通用键值明细；
          // 面板只在钉住态去查已结束明细（悬停不发起查询）。
          detail={
            segment.id === "subagents" ? ({ pinned }) => renderSubagentPanel(pinned) : undefined
          }
        />
      ))}
      {moreTiers.map(({ key, className }) => {
        const hidden = collapsedAt(key);
        if (hidden.length === 0) return null;
        const errors = hidden.filter((segment) => segment.tone === "error").length;
        return (
          <UsageBarHoverDetail
            key={key}
            content={<UsageBarMoreTooltip segments={hidden} />}
            className="min-w-[180px]"
            detailId={`more:${key}`}
            detailGroup={detailGroup}
          >
            <span
              tabIndex={0}
              className={cn(
                "inline-flex h-5 shrink-0 items-center rounded-full bg-foreground/8 px-1.5 text-ui-xs",
                className,
                errors > 0 && "text-destructive",
              )}
            >
              {intl.formatMessage({ id: "chat.usageStatusbar.more" }, { count: hidden.length })}
            </span>
          </UsageBarHoverDetail>
        );
      })}
      <div className="ml-auto flex shrink-0 items-center">
        <UsageBarSettingsPopover settings={settings} testId={TID_V4_COMPOSER_USAGE_BAR_SETTINGS} />
      </div>
    </div>
  );
}
