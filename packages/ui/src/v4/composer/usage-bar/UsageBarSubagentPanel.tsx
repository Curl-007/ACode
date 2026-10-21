/**
 * 子智能体任务级面板（apps/acode-cli/specs/usage-statusbar-port.md §2.5）。
 *
 * 挂在子智能体段的固定浮层里（锚在段上、不随鼠标走）：逐行「状态点 + 任务名 + 状态 +
 * 该任务自己的速度 + 用量」，主会话合计单列一行。
 *
 * 数据分两段取：
 *   - 运行中：直接读 snapshot.subagents.running[]（任务名 = 目录同源的 title）；
 *   - 已结束：只在**点按钉住后**才走目录同一条游标查询（listSessionSubagents），
 *     悬停不发起查询；查询失败只收起该分组，不影响运行中分组。
 * 用量按 childSessionId 从各子会话快照取（与只读子面板同口径），读不到就不显示用量。
 */
import { memo, useMemo } from "react";
import { TID_V4_COMPOSER_USAGE_BAR_SUBAGENT_PANEL } from "@acode/shared";
import { cn } from "@/components/lib/utils.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useSessionSubagents } from "@/hooks/useSessionSubagents.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { TurnMetricsMessageFormat } from "@/chat-input-toolbar/turnMetrics.js";
import { formatCompact } from "./usageBarFormat.js";
import {
  buildSubagentTaskRows,
  resolveEndedGroupHintId,
  type SubagentTaskInfo,
  type SubagentTaskRow,
  type SubagentTaskTone,
} from "./usageBarSubagents.js";

/** 面板入参：任务身份与状态；用量与速度各自按 childSessionId 查（见下）。 */
export type SubagentTaskDescriptor = Omit<SubagentTaskInfo, "tokenTotal" | "liveRate">;

/** 状态点：running 脉冲（motion-reduce 静止）、成功绿、失败红、其余次级灰。 */
const DOT_TONE_CLASS: Record<SubagentTaskTone, string> = {
  live: "bg-success motion-safe:animate-pulse motion-reduce:animate-none",
  success: "bg-success",
  error: "bg-destructive",
  default: "bg-foreground-subtlest",
};

interface UsageBarSubagentPanelProps {
  /** 运行中任务（snapshot.subagents.running[]）。 */
  runningTasks: readonly SubagentTaskDescriptor[];
  /** childSessionId → 该子会话累计 token；缺失/值为 null 的行不显示用量。 */
  childTokenTotals: ReadonlyMap<string, number>;
  /** childSessionId → 该任务自己的实时输出速率；缺失的行不显示速度（不写 0）。 */
  childRates: ReadonlyMap<string, number>;
  mainTokenTotal: number | null;
  endedTotal: number;
  /** 点按钉住后才去查已结束明细（悬停不查询）。 */
  pinned: boolean;
  sessionId: string | null;
  workspacePath: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export const UsageBarSubagentPanel = memo(function UsageBarSubagentPanelImpl(
  props: UsageBarSubagentPanelProps,
) {
  const services = useOptionalServices();
  // 没有 Service provider 的宿主（只读分享时间线等）：只渲染运行中分组，不接目录查询。
  if (!services || !props.workspacePath || !props.sessionId) {
    return (
      <UsageBarSubagentPanelBody
        {...props}
        endedTasks={null}
        endedLoading={false}
        endedFailed={false}
      />
    );
  }
  return <UsageBarSubagentPanelWithDirectory {...props} />;
});

function UsageBarSubagentPanelWithDirectory(props: UsageBarSubagentPanelProps) {
  const directory = useSessionSubagents({
    // 只在钉住后查询：悬停打开面板不发起目录请求（见文件头注释）。
    enabled: props.pinned,
    workspacePath: props.workspacePath ?? "",
    ...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {}),
    ...(props.remoteSessionId ? { remoteSessionId: props.remoteSessionId } : {}),
    sessionId: props.sessionId,
  });
  const endedTasks = useMemo<SubagentTaskDescriptor[]>(
    () =>
      (directory.ended.items ?? []).map((item) => ({
        childSessionId: item.childSessionId,
        title: item.title,
        subagentType: item.subagentType,
        status: item.status,
      })),
    [directory.ended.items],
  );
  return (
    <UsageBarSubagentPanelBody
      {...props}
      endedTasks={props.pinned ? endedTasks : null}
      endedLoading={props.pinned && directory.loading}
      // 查询失败要如实说失败：否则面板会显示「点一下钉住」这种与事实不符的引导。
      endedFailed={props.pinned && directory.error !== null}
    />
  );
}

function UsageBarSubagentPanelBody({
  runningTasks,
  childTokenTotals,
  childRates,
  mainTokenTotal,
  endedTotal,
  pinned,
  endedTasks,
  endedLoading,
  endedFailed,
}: UsageBarSubagentPanelProps & {
  /** null = 未请求（未钉住 / 无 service）或查询失败 → 只显示总数与提示。 */
  endedTasks: readonly SubagentTaskDescriptor[] | null;
  endedLoading: boolean;
  endedFailed: boolean;
}) {
  const { intl, locale } = useACodeIntl();
  const formatMessage = useMemo<TurnMetricsMessageFormat>(
    () => (descriptor, values) => intl.formatMessage(descriptor, values),
    [intl],
  );
  const withUsage = useMemo(
    () =>
      (tasks: readonly SubagentTaskDescriptor[]): SubagentTaskInfo[] =>
        tasks.map((task) => ({
          ...task,
          tokenTotal: childTokenTotals.get(task.childSessionId) ?? null,
          liveRate: childRates.get(task.childSessionId) ?? null,
        })),
    [childTokenTotals, childRates],
  );
  const runningRows = useMemo(
    () => buildSubagentTaskRows({ tasks: withUsage(runningTasks), locale, formatMessage }),
    [withUsage, runningTasks, locale, formatMessage],
  );
  const endedRows = useMemo(
    () => buildSubagentTaskRows({ tasks: withUsage(endedTasks ?? []), locale, formatMessage }),
    [withUsage, endedTasks, locale, formatMessage],
  );
  const endedHintId = resolveEndedGroupHintId({
    pinned,
    loading: endedLoading,
    failed: endedFailed,
    rowCount: endedRows.length,
  });

  return (
    <div data-testid={TID_V4_COMPOSER_USAGE_BAR_SUBAGENT_PANEL} className="space-y-1.5 py-0.5">
      <div className="text-ui-base font-semibold text-foreground">
        {intl.formatMessage({ id: "chat.usageStatusbar.subagents.label" })}
      </div>
      {runningRows.length > 0 ? (
        <PanelGroup
          title={formatMessage(
            { id: "chat.usageStatusbar.subagents.running" },
            { count: runningRows.length },
          )}
        >
          {runningRows.map((row) => (
            <PanelRow key={row.key} row={row} />
          ))}
        </PanelGroup>
      ) : null}
      {endedTotal > 0 ? (
        <PanelGroup
          title={formatMessage(
            { id: "chat.usageStatusbar.subagents.ended" },
            { count: endedTotal },
          )}
        >
          {endedRows.length > 0 ? (
            endedRows.map((row) => <PanelRow key={row.key} row={row} />)
          ) : endedHintId === null ? null : (
            <p className="px-0.5 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: endedHintId })}
            </p>
          )}
        </PanelGroup>
      ) : null}
      {mainTokenTotal !== null ? (
        <div className="flex items-center justify-between gap-4 border-t border-border pt-1.5">
          <span className="text-foreground-subtle">
            {intl.formatMessage({ id: "chat.usageStatusbar.subagents.main" })}
          </span>
          <span className="font-mono font-medium text-foreground tabular-nums">
            {formatCompact(locale, mainTokenTotal)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PanelGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-ui-xs text-foreground-subtle">{title}</p>
      {children}
    </div>
  );
}

function PanelRow({ row }: { row: SubagentTaskRow }) {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        title={row.statusLabel}
        className={cn("size-1.5 shrink-0 rounded-full", DOT_TONE_CLASS[row.tone])}
      />
      <span className="min-w-0 flex-1 truncate text-foreground" title={row.name}>
        {row.name}
      </span>
      <span className="text-ui-xs text-foreground-subtle">{row.statusLabel}</span>
      {/* 该任务自己的实时速度（无样本整条省略）：与状态点同为「这个任务在产出」的信号。 */}
      {row.speedLabel !== null ? (
        <span className="font-mono text-success tabular-nums">{row.speedLabel}</span>
      ) : null}
      {row.usageLabel !== null ? (
        <span className="font-mono text-foreground tabular-nums">{row.usageLabel}</span>
      ) : null}
    </div>
  );
}
