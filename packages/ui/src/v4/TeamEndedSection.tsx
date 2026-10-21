import { useState } from "react";
import { CheckCircle2Icon, ChevronDownIcon, ChevronRightIcon, Maximize2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { TeamLingeringMembers } from "@/components/TeamLingeringMembers.js";
import { teamStatusDotClass } from "@/app-shell/teamPaneParts.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenTeamSideTabRequest } from "@/lib/workspaceSidePane.js";
import type { ConversationStatusPanelTeam } from "./teamPanelModel.js";

/**
 * 状态面板「团队」分区的「已结束的团队」桶（SPEC-012 R11–R12）。
 *
 * 形态对齐智能体分区的「已结束 N ›」：先一行页脚行（图标 + 文案 + 计数 + ›），点开就地
 * 展开紧凑行，而不是另开一个 team-directory tab 类型——省一套落点路由与视图，行尾 ⤢
 * 复用既有团队 tab（落点 teamId），已结束团队在侧栏按只读终态渲染。
 *
 * 单独成文件的原因：ConversationStatusPanel.tsx 已在 boundaries 基线内（只许减不许增），
 * 新分区的行渲染必须落在新文件里，原文件只加一处接线。
 */
export function TeamEndedSection({
  teams,
  parentSessionId,
  onOpenTeamPanel,
  runningChildSessionIds,
  onStopChildSession,
}: {
  teams: readonly ConversationStatusPanelTeam[];
  /** 构造打开请求需要：团队 tab 的身份边界是 parentSessionId + teamId。 */
  parentSessionId?: string;
  onOpenTeamPanel?: (request: OpenTeamSideTabRequest) => void;
  /** 仍在运行的子会话 id（智能体分区同一份事实）；用于残留成员提示与「全部停止」。 */
  runningChildSessionIds?: ReadonlyMap<string, string>;
  /** 停止一个子会话：复用智能体分区的取消通道，不新增停止路径（SPEC-012 R13）。 */
  onStopChildSession?: (workId: string) => void;
}) {
  const { intl } = useACodeIntl();
  const [expanded, setExpanded] = useState(false);
  if (teams.length === 0) return null;
  const resolveStop =
    runningChildSessionIds && onStopChildSession
      ? (childSessionId: string) => {
          const workId = runningChildSessionIds.get(childSessionId);
          return workId === undefined ? undefined : () => onStopChildSession(workId);
        }
      : undefined;
  const label = intl.formatMessage({ id: "chat.statusPanel.agentTeams.endedTeams" });
  return (
    <div data-testid="team-ended-section">
      <div className="border-t border-[var(--color-border)] pt-2">
        <button
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-ui-base text-[var(--color-foreground)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
          data-testid="team-ended-directory"
          type="button"
          onClick={() => setExpanded((value) => !value)}
        >
          <CheckCircle2Icon
            aria-hidden
            className="size-4 shrink-0 text-[var(--color-foreground-subtle)]"
          />
          <span>{label}</span>
          <span className="ml-auto text-[var(--color-foreground-subtle)]">{teams.length}</span>
          {expanded ? (
            <ChevronDownIcon aria-hidden className="size-4 text-[var(--color-foreground-subtle)]" />
          ) : (
            <ChevronRightIcon
              aria-hidden
              className="size-4 text-[var(--color-foreground-subtle)]"
            />
          )}
        </button>
      </div>
      {expanded ? (
        <ul className="flex flex-col gap-0.5 pt-1" data-testid="team-ended-list">
          {teams.map((team) => (
            <li key={team.teamId}>
              <EndedTeamRow
                team={team}
                parentSessionId={parentSessionId}
                onOpenTeamPanel={onOpenTeamPanel}
                {...(resolveStop ? { resolveStop } : {})}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EndedTeamRow({
  team,
  parentSessionId,
  onOpenTeamPanel,
  resolveStop,
}: {
  team: ConversationStatusPanelTeam;
  parentSessionId?: string;
  onOpenTeamPanel?: (request: OpenTeamSideTabRequest) => void;
  resolveStop?: (childSessionId: string) => (() => void) | undefined;
}) {
  const { intl } = useACodeIntl();
  const ago = team.endedAt ? relativeTime(team.endedAt) : "";
  const endedLabel = ago
    ? intl.formatMessage({ id: "chat.statusPanel.agentTeams.endedAgo" }, { time: ago })
    : undefined;
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 rounded-lg px-2 py-1 opacity-75"
      data-team-id={team.teamId}
      data-testid="team-ended-row"
    >
      <div className="flex min-w-0 items-center gap-2 text-ui-sm">
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", teamStatusDotClass(team))}
        />
        <span className="min-w-0 flex-1 truncate text-[var(--color-foreground)]" title={team.goal}>
          {team.goal}
        </span>
        <span className="shrink-0 tabular-nums text-[var(--color-foreground-subtle)]">
          {team.counts.done}/{team.tasks.length}
        </span>
        {team.counts.failed + team.counts.blocked > 0 ? (
          <span className="shrink-0 text-[var(--color-destructive)]">
            {intl.formatMessage(
              { id: "chat.statusPanel.agentTeams.failedCount" },
              { count: team.counts.failed + team.counts.blocked },
            )}
          </span>
        ) : null}
        {endedLabel ? (
          <span className="shrink-0 text-[var(--color-foreground-subtlest)]">{endedLabel}</span>
        ) : null}
        {onOpenTeamPanel && parentSessionId ? (
          <button
            aria-label={intl.formatMessage({ id: "chat.statusPanel.agentTeams.openPanel" })}
            className="shrink-0 rounded-sm text-[var(--color-foreground-subtle)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
            data-testid="team-ended-open"
            type="button"
            onClick={() =>
              onOpenTeamPanel({
                parentSessionId,
                teamId: team.teamId,
              })
            }
          >
            <Maximize2Icon aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </div>
      <TeamLingeringMembers
        members={team.members}
        title={team.goal}
        {...(resolveStop ? { resolveStop } : {})}
      />
    </div>
  );
}

/** 结束于「X 前」的 X：粗粒度相对时间（语言无关的 m/h/d），解析失败即返回空串不显示。 */
function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
