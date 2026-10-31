/**
 * ConversationStatusPanel 的收起态胶囊行（批次 7 外迁，第二阶段）。
 *
 * 逐字迁移自 `ConversationStatusPanel.tsx` 的 `StatusSummaryMetric` + `StatusSummaryRow`。
 * 分支优先级**不在本文件**——它收在 `statusSummaryCapsuleModel.ts` 的判别联合里
 * （顺序即 `STATUS_SUMMARY_CAPSULE_PRIORITY`，由 `conversationStatusPanelCapsule.test.ts`
 * 穷举钉住）。本文件只做「按 kind 渲染」：每个 kind 的图标/文案/数值逐字保留。
 */
import type { ReactNode } from "react";
import {
  ActivityIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  FileDiffIcon,
  GoalIcon,
  ListChecksIcon,
  Maximize2Icon,
  SquareTerminalIcon,
  Workflow,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { formatRunningCount, formatRunningSubagentCount } from "@/v4/conversationStatusPanelFormat.js";
import { getCompletedPlanItem, getCurrentPlanItem } from "@/v4/conversationStatusPanelFormat.js";
import type { ConversationStatusPanelModel } from "@/v4/conversationStatusPanelModel.js";
import {
  buildStatusSummaryCapsuleFacts,
  resolveRunningSummaryIconKind,
  resolveStatusSummaryCapsuleKind,
  shouldUseSubagentRunningLabel,
  type StatusSummaryCapsuleFacts,
  type StatusSummaryCapsuleKind,
} from "@/v4/conversation-status-panel/statusSummaryCapsuleModel.js";
import type { ChatViewSummaryPanelVariant } from "@/v4/legacyChatViewTypes.js";

function StatusSummaryMetric({ children, icon }: { children: ReactNode; icon: ReactNode }) {
  return (
    <div className="flex h-8 w-max max-w-80 min-w-0 items-center gap-1.5 pl-2 pr-3 text-ui-base text-[var(--color-foreground)]">
      <span className="relative size-4 shrink-0">
        <span className="absolute inset-0 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0">
          {icon}
        </span>
        <Maximize2Icon className="absolute inset-0 size-4 text-[var(--color-foreground)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
      </span>
      {children}
    </div>
  );
}

function RunningSummaryIcon({ facts }: { facts: StatusSummaryCapsuleFacts }) {
  const kind = resolveRunningSummaryIconKind(facts);
  const Icon =
    kind === "mixed"
      ? ActivityIcon
      : kind === "workflow"
        ? Workflow
        : kind === "bash"
          ? SquareTerminalIcon
          : BotIcon;
  return <Icon className="size-4 text-[var(--color-foreground)]" />;
}

export function StatusSummaryRow({
  endedWorkflowRunCount,
  gitWorktreeChangeSummary,
  model,
  onVariantChange,
}: {
  /** 已结束 run 的目录计数；宿主给 0 表示目录入口不可渲染（缺会话或缺回调）。 */
  endedWorkflowRunCount: number;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  model: ConversationStatusPanelModel;
  onVariantChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
}) {
  const { intl } = useACodeIntl();
  const expandLabel = intl.formatMessage({ id: "chat.summaryPanel.showPanel" });
  const facts = buildStatusSummaryCapsuleFacts({
    model,
    gitWorktreeChangeSummary,
    endedWorkflowRunCount,
  });
  const kind = resolveStatusSummaryCapsuleKind(facts);

  if (!kind) {
    return null;
  }

  const added = gitWorktreeChangeSummary?.added ?? 0;
  const removed = gitWorktreeChangeSummary?.removed ?? 0;
  const goal = model.goal;
  const goalTitle = goal ? goal.summaryTitle?.trim() || goal.objective.trim() || null : null;

  return (
    <ControlHintTooltip title={expandLabel} sideOffset={4} side="left">
      <button
        type="button"
        aria-label={expandLabel}
        className="group inline-flex w-max max-w-80 cursor-pointer flex-col items-stretch text-left text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-menu-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        onClick={() => onVariantChange?.("panel")}
      >
        <CapsuleMetric
          kind={kind}
          facts={facts}
          added={added}
          removed={removed}
          goalTitle={goalTitle}
          model={model}
        />
      </button>
    </ControlHintTooltip>
  );
}

/** 按 kind 渲染胶囊内容——每个分支的图标/文案/数值逐字迁移自原三元链。 */
function CapsuleMetric({
  kind,
  facts,
  added,
  removed,
  goalTitle,
  model,
}: {
  kind: StatusSummaryCapsuleKind;
  facts: StatusSummaryCapsuleFacts;
  added: number;
  removed: number;
  goalTitle: string | null;
  model: ConversationStatusPanelModel;
}) {
  const { intl } = useACodeIntl();

  switch (kind) {
    case "team":
      return (
        <StatusSummaryMetric icon={<BotIcon className="size-4 text-[var(--color-foreground)]" />}>
          <span className="min-w-0 truncate">
            {intl.formatMessage({ id: "chat.statusPanel.agentTeams" })}
          </span>
          <span className="shrink-0 text-[var(--color-foreground-subtle)]">
            {model.team?.counts.done}/{model.team?.totalCount}
          </span>
        </StatusSummaryMetric>
      );
    case "current-plan":
      return (
        <StatusSummaryMetric
          icon={<ArrowRightIcon className="size-4 text-[var(--color-foreground)]" />}
        >
          <span className="min-w-0 truncate">
            {getCurrentPlanContent(model)}
          </span>
        </StatusSummaryMetric>
      );
    case "active-goal":
    case "done-goal":
      return (
        <StatusSummaryMetric icon={<GoalIcon className="size-4 text-[var(--color-foreground)]" />}>
          <span className="min-w-0 truncate">{goalTitle}</span>
        </StatusSummaryMetric>
      );
    case "git-summary":
      return (
        <StatusSummaryMetric
          icon={<FileDiffIcon className="size-4 text-[var(--color-foreground)]" />}
        >
          <span className="min-w-0 truncate">
            {intl.formatMessage({ id: "chat.statusPanel.changes" })}
          </span>
          <span className="shrink-0 text-[var(--color-diff-added)]">+{added}</span>
          <span className="shrink-0 text-[var(--color-diff-removed)]">-{removed}</span>
        </StatusSummaryMetric>
      );
    case "completed-plan":
      return (
        <StatusSummaryMetric
          icon={<CheckCircle2Icon className="size-4 text-[var(--color-success)]" />}
        >
          <span className="min-w-0 truncate">{getCompletedPlanContent(model)}</span>
        </StatusSummaryMetric>
      );
    case "plan-count":
      return (
        <StatusSummaryMetric
          icon={<ListChecksIcon className="size-4 text-[var(--color-foreground-subtle)]" />}
        >
          <span className="min-w-0 truncate">
            {intl.formatMessage({ id: "chat.statusPanel.todo" })}
          </span>
          <span className="shrink-0 text-[var(--color-foreground-subtle)]">
            {model.plan?.completedCount}/{model.plan?.totalCount}
          </span>
        </StatusSummaryMetric>
      );
    case "session-plan":
      return (
        <StatusSummaryMetric
          icon={<ListChecksIcon className="size-4 text-[var(--color-foreground)]" />}
        >
          <span className="min-w-0 truncate">
            {model.sessionPlans?.items[0]?.title ??
              intl.formatMessage({ id: "chat.statusPanel.planFallback" })}
          </span>
        </StatusSummaryMetric>
      );
    case "running-count":
      return (
        <StatusSummaryMetric icon={<RunningSummaryIcon facts={facts} />}>
          {/* 产品规则：实时活动只能在没有 Goal/Todo/Git 等主状态时兜底，
              避免胶囊把主状态和输入框已展示的实时计数重复拼接。 */}
          <span className="shrink-0">
            {shouldUseSubagentRunningLabel(facts)
              ? formatRunningSubagentCount(intl.formatMessage, facts.runningCount)
              : formatRunningCount(intl.formatMessage, facts.runningCount)}
          </span>
        </StatusSummaryMetric>
      );
    case "ended-workflows":
      return (
        // 胶囊的兜底链止步于「活动计数」，而面板级的卸载闸门（!hasContent &&
        // !canRenderEndedWorkflows）为了保住 run 目录入口，会在**只剩已结束 run**时仍保留
        // 整个壳——工作区无 Git 变更时 workflow 一结束，胶囊各分支全 null，只剩一条 2px
        // 空壳线（与 goal notSatisfied 那次是同一个失效形状）。这里补上最低优先级的终态
        // 分支：图标沿用 Workflow 域，文案与 Workflows 分区页脚同 key，点开即展开面板。
        <StatusSummaryMetric
          icon={<Workflow className="size-4 text-[var(--color-foreground-subtle)]" />}
        >
          <span className="min-w-0 truncate">
            {intl.formatMessage({ id: "chat.statusPanel.endedWorkflows" })}
          </span>
          <span className="shrink-0 text-[var(--color-foreground-subtle)]">
            {facts.endedWorkflowRunCount}
          </span>
        </StatusSummaryMetric>
      );
  }
}

function getCurrentPlanContent(model: ConversationStatusPanelModel): string {
  return getCurrentPlanItemContent(model) ?? "";
}

function getCompletedPlanContent(model: ConversationStatusPanelModel): string {
  return getCompletedPlanItemContent(model) ?? "";
}

// 与模型层同一份选择器（不在此重复实现「哪一项算当前/最近完成」）。

function getCurrentPlanItemContent(model: ConversationStatusPanelModel): string | null {
  return getCurrentPlanItem(model.plan)?.content ?? null;
}

function getCompletedPlanItemContent(model: ConversationStatusPanelModel): string | null {
  return getCompletedPlanItem(model.plan)?.content ?? null;
}
