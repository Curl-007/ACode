import { memo, useState, type KeyboardEvent } from "react";
import type { ConversationStatusPanelTeam } from "@/v4/teamPanelModel.js";
import { CopyIcon, UsersIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { TeamSidePaneTab } from "@/lib/workspaceSidePane.js";
import { teamStatusDotClass } from "./teamPaneParts.js";
import { TeamSidePaneMembers, TeamSidePaneMailbox } from "./TeamSidePanePeople.js";
import { TeamSidePaneTasks } from "./TeamSidePaneTasks.js";
import { TeamWorkflowPhaseList } from "./TeamWorkflowPhaseList.js";
import { teamStatusMessageId } from "@/v4/teamWorkflowPresentation.js";

type PanelTab = "overview" | "tasks" | "members" | "mailbox";
export const TeamSidePaneView = memo(function TeamSidePaneView({
  tab,
  teams,
  endedTeams = [],
  loading = false,
  onOpenMemberSession,
}: {
  tab: TeamSidePaneTab;
  teams: readonly ConversationStatusPanelTeam[];
  /** 最近结束的团队（recentEnded）：落点命中它们时按只读终态渲染（SPEC-012 R15）。 */
  endedTeams?: readonly ConversationStatusPanelTeam[];
  /** lease 未就绪 / 投影未到达：与「真正没有团队」分开显示（SPEC-012 R14）。 */
  loading?: boolean;
  /** 成员页签的「查看会话」（SPEC-012 R16）。 */
  onOpenMemberSession?: (request: { childSessionId: string; title: string }) => void;
}) {
  const { intl } = useACodeIntl();
  const [selection, setSelection] = useState<{
    openedAt?: number;
    teamId?: string;
    panelTab: PanelTab;
  }>({ panelTab: "overview" });
  // 新打开的落点覆盖本地查看选择；普通快照更新不重置页签或展开状态。
  const selectionCurrent = selection.openedAt === tab.openedAt;
  const selectedTeamId = selectionCurrent ? selection.teamId : tab.teamId;
  const panelTab = selectionCurrent ? selection.panelTab : "overview";
  // 落点是否命中「已结束」：命中 recentEnded 时按只读终态渲染（邮箱页签隐藏——
  // 已结束快照不带 mailboxes）。
  const endedIds = new Set(endedTeams.map((candidate) => candidate.teamId));
  const landingEnded =
    selectedTeamId !== undefined &&
    endedIds.has(selectedTeamId) &&
    !teams.some((item) => item.teamId === selectedTeamId);
  const team =
    teams.find((item) => item.teamId === selectedTeamId) ??
    (landingEnded ? endedTeams.find((item) => item.teamId === selectedTeamId) : undefined) ??
    teams[0];
  // 落点 teamId 既不在活跃也不在 recentEnded（超过保留条数）：给一句明确提示，
  // 而不是静默显示第一张卡（SPEC-012 R14 第三态）。
  const landingMissing =
    selectedTeamId !== undefined &&
    !teams.some((item) => item.teamId === selectedTeamId) &&
    !endedIds.has(selectedTeamId);
  const select = (teamId: string, nextTab: PanelTab = panelTab) =>
    setSelection({ openedAt: tab.openedAt, teamId, panelTab: nextTab });
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!team) return;
    const current = teams.indexOf(team);
    const index =
      event.key === "ArrowLeft"
        ? (current - 1 + teams.length) % teams.length
        : event.key === "ArrowRight"
          ? (current + 1) % teams.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? teams.length - 1
              : undefined;
    if (index === undefined) return;
    event.preventDefault();
    const next = teams[index]!;
    select(next.teamId);
    const button = event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[index];
    button?.focus();
  };
  if (!team)
    return (
      <p
        className="px-4 py-3 text-ui-base text-foreground-subtlest"
        data-testid={loading ? "team-side-pane-loading" : "team-side-pane-empty"}
      >
        {intl.formatMessage({ id: loading ? "teamPanel.loading" : "teamPanel.empty" })}
      </p>
    );
  const unreadTotal = team.mailboxes.reduce((sum, mailbox) => sum + mailbox.unread, 0);
  const statusId = teamStatusMessageId(team.status);
  const copyPanelUrl = async () => {
    if (!team.panelUrl) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(team.panelUrl);
      toast(intl.formatMessage({ id: "chat.statusPanel.agentTeams.copyPanelUrlSuccess" }));
    } catch {
      toast(intl.formatMessage({ id: "chat.statusPanel.agentTeams.copyPanelUrlFailed" }));
    }
  };
  return (
    <div
      className="flex size-full min-h-0 flex-col bg-background"
      data-testid="team-side-pane"
      data-selected-team-id={team.teamId}
    >
      {teams.length > 1 ? (
        <div
          className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1"
          role="tablist"
          aria-label={intl.formatMessage({ id: "teamPanel.teamSwitcher" })}
          onKeyDown={keyDown}
        >
          {teams.map((candidate) => (
            <button
              key={candidate.teamId}
              type="button"
              role="tab"
              aria-selected={candidate.teamId === team.teamId}
              tabIndex={candidate.teamId === team.teamId ? 0 : -1}
              onClick={() => select(candidate.teamId)}
              title={candidate.goal}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-ui-sm",
                candidate.teamId === team.teamId
                  ? "bg-selected text-foreground"
                  : "text-foreground-subtle hover:bg-hover",
              )}
            >
              <span
                aria-hidden
                className={cn("size-1.5 shrink-0 rounded-full", teamStatusDotClass(candidate))}
              />
              <span className="max-w-36 truncate">{candidate.goal || candidate.teamId}</span>
            </button>
          ))}
        </div>
      ) : null}
      <header className="shrink-0 border-b border-border px-3 py-3">
        <div className="flex min-w-0 items-start gap-2">
          <UsersIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
          <h2 className="min-w-0 flex-1 break-words text-ui-base font-medium text-foreground">
            {team.goal}
          </h2>
          {team.panelUrl ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={intl.formatMessage({ id: "chat.statusPanel.agentTeams.copyPanelUrl" })}
              onClick={() => void copyPanelUrl()}
            >
              <CopyIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-ui-sm text-foreground-subtle">
          <span aria-hidden className={cn("size-2 rounded-full", teamStatusDotClass(team))} />
          {statusId ? intl.formatMessage({ id: statusId }) : team.status}
          <span className="text-foreground-subtlest">
            ·{" "}
            {intl.formatMessage(
              { id: "teamPanel.timeline.paneSummary" },
              {
                members: team.members.filter((member) => member.status !== "removed").length,
                done: team.counts.done,
                total: team.tasks.length,
                unread: unreadTotal,
              },
            )}
          </span>
          {team.stale ? (
            <span title={intl.formatMessage({ id: "chat.statusPanel.agentTeams.staleHint" })}>
              · {intl.formatMessage({ id: "chat.statusPanel.agentTeams.stale" })}
            </span>
          ) : null}
        </div>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        {(team.status === "archived" || !team.mailboxes.length
          ? (["overview", "tasks", "members"] as const)
          : (["overview", "tasks", "members", "mailbox"] as const)
        ).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => select(team.teamId, id)}
            aria-pressed={panelTab === id}
            className={cn(
              "inline-flex h-7 items-center rounded-lg px-2 text-ui-sm",
              panelTab === id
                ? "bg-selected text-foreground"
                : "text-foreground-subtle hover:bg-hover",
            )}
          >
            {intl.formatMessage({ id: `teamPanel.tab.${id}` })}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {landingMissing ? (
          <p
            className="mx-3 mt-3 rounded-xl border border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle"
            data-testid="team-side-pane-target-ended"
          >
            {intl.formatMessage({ id: "teamPanel.targetEnded" })}
          </p>
        ) : null}
        {team.status === "archived" || landingEnded ? (
          <p className="mx-3 mt-3 rounded-xl border border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
            {landingEnded
              ? `${intl.formatMessage({ id: "teamPanel.archivedHint" })} · ${intl.formatMessage({ id: "teamPanel.endedReadonly" })}`
              : intl.formatMessage({ id: "teamPanel.archivedHint" })}
          </p>
        ) : null}
        {panelTab === "overview" ? (
          <TeamWorkflowPhaseList
            key={team.teamId}
            team={team}
            {...(team.teamId === tab.teamId && !selectionCurrent
              ? { landing: { ...tab, key: `${tab.teamId}:${tab.openedAt}` } }
              : {})}
          />
        ) : null}
        {panelTab === "tasks" ? (
          <div className="p-3">
            <TeamSidePaneTasks team={team} />
          </div>
        ) : null}
        {panelTab === "members" ? (
          <div className="p-3">
            <TeamSidePaneMembers
              team={team}
              {...(onOpenMemberSession ? { onOpenMemberSession } : {})}
            />
          </div>
        ) : null}
        {panelTab === "mailbox" ? (
          <div className="p-3">
            <TeamSidePaneMailbox team={team} />
          </div>
        ) : null}
      </div>
    </div>
  );
});
