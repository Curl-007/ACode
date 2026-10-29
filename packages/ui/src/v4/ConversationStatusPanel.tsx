/* oxlint-disable eslint(max-lines) -- 状态面板同时维护收起态摘要、展开态分区、菜单策略和宽度自适应，同文件能保证两种形态共享同一内容优先级；批次 4 已将纯格式化/决策函数外迁 conversationStatusPanelFormat.ts，批次 6 第一阶段已将分区外壳与 environment/plan/agent-teams/已结束页脚外迁 conversation-status-panel/，批次 7 第二阶段又把四个秒级分区（Goal/Terminals/Workflows/Agents）外迁并把 tick 统一到 useNowTicker；实时投影语义（memo/胶囊兜底链）仍在本文件。 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  EllipsisIcon,
  Minimize2Icon,
} from "lucide-react";
import {
  TID_CHAT_SUMMARY_PANEL,
} from "@acode/shared";
import type {
  GitChangeSourceId,
  GitRepositorySummary,
  ACodeSessionRunningSubagent,
  ACodeTaskChangeSummary,
} from "@acode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  PlanState,
  ToolCallRow,
  WorkflowRunState,
} from "@acode/shared/acode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { TeamEndedSection } from "@/v4/TeamEndedSection.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenSubagentDirectorySideTabRequest,
  OpenSubagentSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
  OpenOrchestrationSideTabRequest,
  OpenTeamSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import type { ChatViewSummaryPanelVariant } from "@/v4/legacyChatViewTypes.js";
import { resolveConversationStatusPanelVariant } from "@/v4/conversationLayout.js";
import {
  EMPTY_BACKGROUND_WORKS,
  EMPTY_RUNNING_SUBAGENTS,
  EMPTY_WORKFLOW_RUNS,
} from "@/v4/conversationStatusPanelFormat.js";
import {
  buildConversationStatusPanelModel,
  type ConversationStatusPanelWorkflowRunTarget,
} from "@/v4/conversationStatusPanelModel.js";
import { GitStatusSection } from "@/v4/conversation-status-panel/GitStatusSection.js";
import {
  PlanStatusSection,
  SessionPlansStatusSection,
} from "@/v4/conversation-status-panel/PlanStatusSections.js";
import { TeamStatusSection } from "@/v4/conversation-status-panel/TeamAndEndedSections.js";
import { GoalStatusSection } from "@/v4/conversation-status-panel/GoalStatusSection.js";
import { BackgroundWorkStatusSection } from "@/v4/conversation-status-panel/BackgroundWorkStatusSection.js";
import { WorkflowStatusSection } from "@/v4/conversation-status-panel/WorkflowStatusSection.js";
import { SubagentStatusSection } from "@/v4/conversation-status-panel/SubagentStatusSection.js";
import { StatusSummaryRow } from "@/v4/conversation-status-panel/StatusSummaryRow.js";

interface ConversationStatusPanelProps {
  workspacePath: string;
  workspaceIdentity?: string;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  activeTaskChangeSummary?: ACodeTaskChangeSummary | null;
  goal?: GoalState | null;
  sessionPlans?: readonly ToolCallRow[];
  plan?: PlanState | null;
  backgroundWorks?: readonly BackgroundWorkSummary[];
  runningSubagents?: readonly ACodeSessionRunningSubagent[];
  /** 本会话 `snapshot.workflowRuns.runs`；与 backgroundWorks 在模型层按 workId ≡ runId 联接。 */
  workflowRuns?: readonly WorkflowRunState[];
  /** 插件状态快照（conversationSnapshot.pluginStates）；AgentTeams 团队卡从中收窄。 */
  pluginStates?: Record<string, unknown> | null;
  /**
   * 已结束的 workflow run 条数（journal 口径，`countEndedWorkflowRuns`）。
   * 面板不自己算：它手上的投影是 memory-only 的活状态，重启后为空，而这条计数恰恰要在重启后
   * 仍然正确。
   */
  endedWorkflowRunCount?: number;
  endedSubagentCount?: number;
  rootSessionId?: string;
  parentSessionId?: string;
  /** 当前 pane 是否由手机 Web 远控壳承载。 */
  /** 当前是否为粗指针手机视口。 */
  isMobileViewport?: boolean;
  layoutMode?: "none" | "auto" | "inline";
  summaryPanelVariantOverride?: ChatViewSummaryPanelVariant | null;
  onVariantChange?: (variant: ChatViewSummaryPanelVariant | null) => void;
  terminalSectionOpen?: boolean;
  onTerminalSectionOpenChange?: (open: boolean) => void;
  agentSectionOpen?: boolean;
  onAgentSectionOpenChange?: (open: boolean) => void;
  workflowSectionOpen?: boolean;
  onWorkflowSectionOpenChange?: (open: boolean) => void;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenSubagentDirectorySideTabRequest) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  onOpenWorkflowRunDirectory?: (request: OpenWorkflowRunDirectorySideTabRequest) => void;
  /** 面板菜单的「编排总览」项 → 统一编排 side pane（orchestration-side-pane spec R3 入口）。 */
  onOpenOrchestration?: (request: OpenOrchestrationSideTabRequest) => void;
  onOpenTeamPanel?: (request: OpenTeamSideTabRequest) => void;
  className?: string;
}

function ConversationStatusPanelImpl({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  gitDirtyFileCount = 0,
  gitWorktreeReviewSourceId,
  gitWorktreeChangeSummary,
  activeTaskChangeSummary,
  goal,
  sessionPlans,
  plan,
  backgroundWorks = EMPTY_BACKGROUND_WORKS,
  runningSubagents = EMPTY_RUNNING_SUBAGENTS,
  workflowRuns = EMPTY_WORKFLOW_RUNS,
  pluginStates,
  endedWorkflowRunCount = 0,
  endedSubagentCount = 0,
  rootSessionId,
  parentSessionId,
  isMobileViewport = false,
  layoutMode = "none",
  summaryPanelVariantOverride,
  onVariantChange,
  terminalSectionOpen,
  onTerminalSectionOpenChange,
  agentSectionOpen,
  onAgentSectionOpenChange,
  workflowSectionOpen,
  onWorkflowSectionOpenChange,
  onRefreshGit,
  onOpenGitReview,
  onPauseGoal,
  onResumeGoal,
  onOpenPlanDetail,
  onOpenBackgroundBash,
  onCancelBackgroundWork,
  onOpenSubagentSession,
  onOpenSubagentDirectory,
  onOpenTeamPanel,
  onOpenWorkflowRun,
  onOpenWorkflowRunDirectory,
  onOpenOrchestration,
  className,
}: ConversationStatusPanelProps) {
  const isOfficeMode = useIsOfficeMode();
  const miniMeasureRef = useRef<HTMLDivElement | null>(null);
  const [miniWidth, setMiniWidth] = useState(320);
  // 多团队卡折叠（UI-19）：>4 张卡时先只渲染 4 张，提供「显示全部/收起」切换，
  // 避免状态面板展开态被 8 张团队卡连续撑爆。
  const [showAllTeams, setShowAllTeams] = useState(false);
  const TEAM_CARDS_COLLAPSED_LIMIT = 4;
  const model = useMemo(
    () =>
      buildConversationStatusPanelModel({
        isOfficeMode,
        gitSummary,
        gitDirtyFileCount,
        gitWorktreeChangeSummary,
        goal,
        sessionPlans,
        workspacePath,
        plan,
        backgroundWorks,
        runningSubagents,
        workflowRuns,
        pluginStates,
        sessionId: parentSessionId ?? null,
      }),
    [
      isOfficeMode,
      backgroundWorks,
      gitDirtyFileCount,
      gitSummary,
      gitWorktreeChangeSummary,
      goal,
      sessionPlans,
      parentSessionId,
      plan,
      pluginStates,
      runningSubagents,
      workflowRuns,
      workspacePath,
    ],
  );
  // 残留成员停止入口（SPEC-012 R13）：子会话 id → backgroundWorks 的 workId，
  // 与智能体分区同一份事实、同一个停止回调；团队分区不新造停止通道。
  const runningSubagentWorkIds = useMemo(() => {
    const map = new Map<string, string>();
    for (const work of model.runningSubagentWorks) {
      if (work.controlWorkId !== undefined && work.cancellable !== false) {
        map.set(work.childSessionId, work.controlWorkId);
      }
    }
    return map;
  }, [model.runningSubagentWorks]);
  const variant = resolveConversationStatusPanelVariant({
    variantOverride: summaryPanelVariantOverride ?? null,
  });
  const isVariantAutomatic = summaryPanelVariantOverride == null;
  const useVerticalFloatingPanels = false;
  const panelModeValue = isVariantAutomatic ? "auto" : variant;
  const { intl } = useACodeIntl();
  const panelMenuLabel = intl.formatMessage({
    id: "chat.summaryPanel.displayMode",
  });
  const shellStyle = useMemo(
    () =>
      ({
        "--chat-summary-panel-mini-width": `${miniWidth}px`,
      }) as CSSProperties,
    [miniWidth],
  );
  const canRenderGit = Boolean(model.git && gitSummary && onRefreshGit);
  const canRenderGoal = Boolean(model.goal);
  const canRenderSessionPlans = Boolean(model.sessionPlans);
  const canRenderPlan = Boolean(model.plan);
  const canRenderTeam = model.team !== null;
  const canRenderTerminals = model.runningBashWorks.length > 0;
  // 已结束的 run 也开门（与 canRenderAgents 同判断）：重启后活动数为零，若只按它开门，
  // 通往 run 目录的唯一入口会连带消失。
  const canRenderEndedWorkflows = Boolean(
    endedWorkflowRunCount > 0 && parentSessionId && onOpenWorkflowRunDirectory,
  );
  const canRenderWorkflows = model.runningWorkflowRuns.length > 0 || canRenderEndedWorkflows;
  const canRenderEndedAgents = Boolean(
    endedSubagentCount > 0 && parentSessionId && onOpenSubagentDirectory,
  );
  // 已结束目录入口过去渲染在 Agent StatusSection 之后，视觉和 DOM 都被提升成
  // 并列顶层 section。Agent 的运行态和已结束目录属于同一领域，统一由 Agent 折叠分组承载。
  const canRenderAgents = model.runningSubagentWorks.length > 0 || canRenderEndedAgents;
  const handlePanelModeChange = useCallback(
    (value: string) => {
      if (value === "auto") {
        onVariantChange?.(null);
        return;
      }
      if (value === "panel" || value === "mini") {
        onVariantChange?.(value);
      }
    },
    [onVariantChange],
  );
  const handleCollapseToMini = useCallback(() => {
    onVariantChange?.("mini");
  }, [onVariantChange]);

  useEffect(() => {
    const element = miniMeasureRef.current;
    if (!element) {
      return;
    }
    const updateMiniWidth = () => {
      const nextWidth = Math.ceil(element.getBoundingClientRect().width);
      if (nextWidth > 0) {
        const nextMiniWidth = Math.min(nextWidth, 320);
        setMiniWidth((currentMiniWidth) =>
          currentMiniWidth === nextMiniWidth ? currentMiniWidth : nextMiniWidth,
        );
      }
    };

    updateMiniWidth();

    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(updateMiniWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [model]);

  // `model.hasContent` 只认**活的**内容（模型手上的投影都是活状态），所以「只剩历史」的
  // 会话会连整个胶囊一起消失——而那正是重启后打开一条旧对话的样子，run 目录的入口于是又没了。
  // 已结束的 run 因此单独开这道门。（Agents 的已结束行有同一个洞：`endedSubagentCount` 也
  // 没进 `hasContent`。那是既有行为，不在本轮一起翻。）
  if (!model.hasContent && !canRenderEndedWorkflows) {
    return null;
  }

  return (
    <div
      className={cn(
        "pointer-events-none absolute top-0 z-20 pt-4",
        // 旧 ChatView 的 inline 面板直接钉在右侧，正文列通过独立 translate 让位。
        // v4 若继续用 inset-x-0 + justify-end，会让面板容器宽铺满并改变宽屏下的横向对齐。
        layoutMode === "inline"
          ? "right-4"
          : layoutMode === "auto"
            ? "inset-x-0 flex justify-end px-4 @min-[1280px]/conversation:left-auto @min-[1280px]/conversation:right-4 @min-[1280px]/conversation:px-0"
            : "inset-x-0 flex justify-end px-4",
        className,
      )}
    >
      {/* 状态面板恢复旧 ChatView 的同 shell 收起/展开模型。
          之前 v4 用固定展开卡片替代 summary panel，窄屏会遮挡聊天正文，也丢失用户 override。 */}
      <aside
        aria-label={intl.formatMessage({ id: "chat.summaryPanel.title" })}
        data-testid={TID_CHAT_SUMMARY_PANEL}
        data-state={variant === "mini" ? "collapsed" : "expanded"}
        data-display-mode={variant}
        data-goal-status={model.goal?.status}
        data-goal-objective={model.goal?.objective}
        data-running-background-count={
          model.runningBashWorks.length +
          model.runningSubagentWorks.length +
          model.runningWorkflowRuns.length
        }
        data-running-terminal-count={model.runningBashWorks.length}
        data-running-agent-count={model.runningSubagentWorks.length}
        data-running-workflow-count={model.runningWorkflowRuns.length}
        data-ended-workflow-count={endedWorkflowRunCount}
        style={shellStyle}
        className={cn(
          "pointer-events-auto relative overflow-hidden rounded-2xl border border-[var(--color-popover-border)] bg-[var(--color-popover)] text-[var(--color-foreground)] shadow-md transition-[border-radius,padding,background-color,box-shadow] duration-300 ease-in-out",
          variant === "mini"
            ? "inline-flex max-h-8.5 w-[var(--chat-summary-panel-mini-width)] max-w-[calc(100vw-1.5rem)] flex-col"
            : variant === "panel"
              ? "flex max-h-[min(64dvh,32rem)] w-80 max-w-[calc(100vw-1.5rem)] flex-col"
              : "inline-flex max-h-8.5 w-[var(--chat-summary-panel-mini-width)] max-w-[calc(100vw-1.5rem)] flex-col @min-[1280px]/conversation:max-h-[min(64dvh,32rem)] @min-[1280px]/conversation:w-80",
        )}
      >
        {variant !== "mini" ? (
          <div
            className={cn(
              "absolute right-3 top-3 z-10 items-center gap-1",
              variant === "auto" ? "hidden @min-[1280px]/conversation:flex" : "flex",
            )}
          >
            <DropdownMenu>
              <ControlHintTooltip title={panelMenuLabel} side="left">
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    aria-label={panelMenuLabel}
                  >
                    <EllipsisIcon className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </ControlHintTooltip>
              <DropdownMenuContent align="end" side="bottom" className="w-44">
                <DropdownMenuRadioGroup
                  value={panelModeValue}
                  onValueChange={handlePanelModeChange}
                >
                  <DropdownMenuRadioItem value="auto">
                    {intl.formatMessage({
                      id: "chat.summaryPanel.displayModeAuto",
                    })}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                {onOpenOrchestration && parentSessionId ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => onOpenOrchestration({ parentSessionId })}>
                      {intl.formatMessage({ id: "sidePane.orchestration" })}
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <ControlHintTooltip
              title={intl.formatMessage({ id: "chat.summaryPanel.showMini" })}
              side="left"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label={intl.formatMessage({
                  id: "chat.summaryPanel.showMini",
                })}
                onClick={handleCollapseToMini}
              >
                <Minimize2Icon className="size-3.5" />
              </Button>
            </ControlHintTooltip>
          </div>
        ) : null}
        {variant !== "mini" ? (
          // 单个区块限高后，多区块同时展开仍可能超过 shell；外层必须提供
          // 第二层兜底滚动，保证后续区块标题和操作始终可达，不能继续直接裁切。
          <div
            className={cn(
              "min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto p-2",
              variant === "auto" ? "hidden @min-[1280px]/conversation:flex" : "flex",
            )}
          >
            {canRenderGit ? (
              <GitStatusSection
                model={model}
                gitSummary={gitSummary}
                gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
                workspacePath={workspacePath}
                workspaceIdentity={workspaceIdentity}
                activeTaskChangeSummary={activeTaskChangeSummary}
                onRefreshGit={onRefreshGit}
                onOpenGitReview={onOpenGitReview}
                separated={false}
                useVerticalFloatingPanels={useVerticalFloatingPanels}
              />
            ) : null}
            {canRenderGoal ? (
              <GoalStatusSection
                model={model}
                separated={canRenderGit}
                onPauseGoal={onPauseGoal}
                onResumeGoal={onResumeGoal}
              />
            ) : null}
            {canRenderSessionPlans ? (
              <SessionPlansStatusSection
                model={model}
                parentSessionId={parentSessionId}
                onOpenPlanDetail={onOpenPlanDetail}
                separated={canRenderGit || canRenderGoal}
              />
            ) : null}
            {canRenderPlan ? (
              <PlanStatusSection
                model={model}
                popoverSide={useVerticalFloatingPanels ? "bottom" : "left"}
                separated={canRenderGit || canRenderGoal || canRenderSessionPlans}
              />
            ) : null}
            {canRenderTeam && model.teams.length > 0
              ? (() => {
                  // 多于 4 张团队卡时折叠：默认渲染前 4 张 + 展开按钮（UI-19）。
                  const teamCardsCollapsed =
                    !showAllTeams && model.teams.length > TEAM_CARDS_COLLAPSED_LIMIT;
                  const visibleTeams = teamCardsCollapsed
                    ? model.teams.slice(0, TEAM_CARDS_COLLAPSED_LIMIT)
                    : model.teams;
                  return (
                    <>
                      {visibleTeams.map((team, index) => (
                        <TeamStatusSection
                          key={team.teamId}
                          separated={
                            index > 0 ||
                            canRenderGit ||
                            canRenderGoal ||
                            canRenderSessionPlans ||
                            canRenderPlan
                          }
                          team={team}
                          parentSessionId={parentSessionId}
                          onOpenTeamPanel={onOpenTeamPanel}
                          title={intl.formatMessage({ id: "chat.statusPanel.agentTeams" })}
                        />
                      ))}
                      {teamCardsCollapsed ? (
                        <button
                          type="button"
                          className="shrink-0 px-2 text-left text-ui-sm text-foreground-subtle hover:text-foreground"
                          onClick={() => {
                            setShowAllTeams(true);
                          }}
                        >
                          {intl.formatMessage(
                            { id: "chat.statusPanel.agentTeams.showAll" },
                            { count: String(model.teams.length) },
                          )}
                        </button>
                      ) : showAllTeams && model.teams.length > TEAM_CARDS_COLLAPSED_LIMIT ? (
                        <button
                          type="button"
                          className="shrink-0 px-2 text-left text-ui-sm text-foreground-subtle hover:text-foreground"
                          onClick={() => {
                            setShowAllTeams(false);
                          }}
                        >
                          {intl.formatMessage({ id: "chat.statusPanel.agentTeams.showLess" })}
                        </button>
                      ) : null}
                    </>
                  );
                })()
              : null}
            {canRenderTeam || model.endedTeams.length > 0 ? (
              <TeamEndedSection
                teams={model.endedTeams}
                parentSessionId={parentSessionId}
                runningChildSessionIds={runningSubagentWorkIds}
                {...(onOpenTeamPanel ? { onOpenTeamPanel } : {})}
                {...(onCancelBackgroundWork ? { onStopChildSession: onCancelBackgroundWork } : {})}
              />
            ) : null}
            {canRenderTerminals ? (
              <BackgroundWorkStatusSection
                onOpenBackgroundBash={onOpenBackgroundBash}
                section="terminal"
                title={intl.formatMessage({ id: "chat.statusPanel.terminals" })}
                works={model.runningBashWorks}
                open={terminalSectionOpen}
                onOpenChange={onTerminalSectionOpenChange}
                separated={
                  canRenderGit ||
                  canRenderGoal ||
                  canRenderSessionPlans ||
                  canRenderPlan ||
                  canRenderTeam
                }
                onCancelBackgroundWork={onCancelBackgroundWork}
              />
            ) : null}
            {canRenderWorkflows ? (
              <WorkflowStatusSection
                title={intl.formatMessage({ id: "chat.statusPanel.workflows" })}
                runs={model.runningWorkflowRuns}
                endedRunCount={canRenderEndedWorkflows ? endedWorkflowRunCount : 0}
                open={workflowSectionOpen}
                onOpenChange={onWorkflowSectionOpenChange}
                separated={
                  canRenderGit ||
                  canRenderGoal ||
                  canRenderSessionPlans ||
                  canRenderPlan ||
                  canRenderTerminals
                }
                parentSessionId={parentSessionId}
                onCancelBackgroundWork={onCancelBackgroundWork}
                onOpenWorkflowRun={onOpenWorkflowRun}
                onOpenDirectory={onOpenWorkflowRunDirectory}
              />
            ) : null}
            {canRenderAgents ? (
              <SubagentStatusSection
                title={intl.formatMessage({ id: "chat.statusPanel.agents" })}
                subagents={model.runningSubagentWorks}
                endedSubagentCount={canRenderEndedAgents ? endedSubagentCount : 0}
                onCancelBackgroundWork={onCancelBackgroundWork}
                open={agentSectionOpen}
                onOpenChange={onAgentSectionOpenChange}
                separated={
                  canRenderGit ||
                  canRenderGoal ||
                  canRenderSessionPlans ||
                  canRenderPlan ||
                  canRenderTeam ||
                  canRenderTerminals ||
                  canRenderWorkflows
                }
                parentSessionId={parentSessionId}
                rootSessionId={rootSessionId}
                onOpenSubagentSession={onOpenSubagentSession}
                onOpenSubagentDirectory={onOpenSubagentDirectory}
              />
            ) : null}
          </div>
        ) : null}
        <div
          ref={miniMeasureRef}
          aria-hidden={variant === "panel"}
          className={cn(
            "w-max max-w-80 transition-opacity duration-150",
            variant === "mini"
              ? "pointer-events-auto relative visible opacity-100"
              : variant === "panel"
                ? "pointer-events-none invisible absolute left-0 top-0 opacity-0"
                : "pointer-events-auto relative visible opacity-100 @min-[1280px]/conversation:hidden",
          )}
        >
          <StatusSummaryRow
            model={model}
            // 与页脚同一道门（canRenderEndedWorkflows）：缺会话或缺回调时目录打不开，
            // 胶囊也就不该报一个点了没反应的数。
            endedWorkflowRunCount={canRenderEndedWorkflows ? endedWorkflowRunCount : 0}
            gitWorktreeChangeSummary={gitWorktreeChangeSummary}
            onVariantChange={onVariantChange}
          />
        </div>
      </aside>
    </div>
  );
}

export const ConversationStatusPanel = memo(ConversationStatusPanelImpl);
