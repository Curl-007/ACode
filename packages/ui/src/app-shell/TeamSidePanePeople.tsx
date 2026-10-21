import { memo, useMemo } from "react";
import { cn } from "@/components/lib/utils.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import { memberColor } from "@/app-shell/teamPaneParts.js";
import type { ConversationStatusPanelTeam } from "@/v4/teamPanelModel.js";

/**
 * 成员页签与邮箱页签。
 *
 * 成员行的「当前状态」是**推导**出来的，不是快照字段：快照只给 currentTaskId（进行中
 * 任务的 attempt owner），而「为什么这个人闲着」要靠任务名册反查——他有已指派但还没就绪
 * 的任务，就是在等依赖；一个指派都没有，才是真空闲。不推这一步，界面上只会出现一个
 * 孤零零的「—」，用户看不出该不该干预。
 */

export const TeamSidePaneMembers = memo(function TeamSidePaneMembers({
  team,
  onOpenMemberSession,
}: {
  team: ConversationStatusPanelTeam;
  /** 成员有子会话时的「查看会话」（SPEC-012 R16）：打开该成员的子 Agent 会话。 */
  onOpenMemberSession?: (request: { childSessionId: string; title: string }) => void;
}) {
  const { intl } = useACodeIntl();
  const ready = useMemo(() => new Set(team.readyTaskIds), [team.readyTaskIds]);
  if (team.members.length === 0) {
    return (
      <p className="px-1.5 text-ui-base text-foreground-subtlest">
        {intl.formatMessage({ id: "teamPanel.member.empty" })}
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {team.members.map((member) => {
        const color = memberColor(member.name, team.members);
        const assigned = team.tasks.filter(
          (task) => task.assignee === member.name && task.status === "todo",
        );
        const claimable = assigned.find((task) => ready.has(task.taskId));
        const state = member.currentTaskId
          ? { label: member.currentTaskId, tone: "text-[var(--color-warning)]" }
          : member.status === "registered"
            ? {
                label: intl.formatMessage({ id: "teamPanel.member.registered" }),
                tone: "text-[var(--color-foreground-subtlest)]",
              }
            : claimable
              ? {
                  label: `${intl.formatMessage({ id: "teamPanel.group.ready" })} · ${claimable.taskId}`,
                  tone: "text-[var(--color-success)]",
                }
              : assigned.length > 0
                ? {
                    label: intl.formatMessage({
                      id: team.hasTaskDerivations
                        ? "teamPanel.member.waitingDeps"
                        : "teamPanel.member.pending",
                    }),
                    tone: "text-[var(--color-foreground-subtlest)]",
                  }
                : {
                    label: intl.formatMessage({ id: "teamPanel.member.idle" }),
                    tone: "text-[var(--color-foreground-subtlest)]",
                  };
        const unread = team.mailboxes.find((box) => box.address === member.name)?.unread ?? 0;
        return (
          <div
            key={member.name}
            className="flex min-h-8 min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--color-hover)]"
          >
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
            <span className="shrink-0 text-ui-base font-medium text-foreground">{member.name}</span>
            <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle">
              {member.role}
            </span>
            {unread > 0 ? (
              <span className="shrink-0 rounded-full bg-[var(--color-warning)]/14 px-1.5 text-ui-xs tabular-nums text-[var(--color-warning)]">
                {unread}
              </span>
            ) : null}
            {member.childSessionId && onOpenMemberSession ? (
              <button
                className="shrink-0 rounded-sm text-ui-sm text-foreground-subtle underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
                data-testid="team-member-open-session"
                title={intl.formatMessage(
                  { id: "teamPanel.member.openSession" },
                  { name: member.name },
                )}
                type="button"
                onClick={() =>
                  onOpenMemberSession({
                    childSessionId: member.childSessionId!,
                    title: member.name,
                  })
                }
              >
                {intl.formatMessage({ id: "teamPanel.member.openSessionShort" })}
              </button>
            ) : null}
            <span className={cn("shrink-0 text-ui-sm", state.tone)}>{state.label}</span>
          </div>
        );
      })}
    </div>
  );
});

export const TeamSidePaneMailbox = memo(function TeamSidePaneMailbox({
  team,
}: {
  team: ConversationStatusPanelTeam;
}) {
  const { intl } = useACodeIntl();
  const totalUnread = team.mailboxes.reduce((sum, mailbox) => sum + mailbox.unread, 0);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <section>
        <h3 className="px-1.5 pb-1.5 text-ui-sm font-medium text-[var(--color-foreground-subtlest)]">
          {intl.formatMessage({ id: "teamPanel.mailbox.unreadSection" })} · {totalUnread}
        </h3>
        {team.unreadMessages.length === 0 ? (
          <p className="px-1.5 text-ui-base text-foreground-subtlest">
            {intl.formatMessage({
              id:
                totalUnread > 0
                  ? "teamPanel.mailbox.previewUnavailable"
                  : "teamPanel.mailbox.empty",
            })}
          </p>
        ) : (
          team.unreadMessages.map((message) => (
            <div
              key={message.id}
              className="flex min-w-0 gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--color-hover)]"
            >
              <span
                aria-hidden="true"
                className="mt-1 size-2 shrink-0 rounded-full"
                style={{ backgroundColor: memberColor(message.from, team.members) }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5 text-ui-sm text-foreground-subtle">
                  <span className="truncate text-foreground">{message.from}</span>
                  <span aria-hidden="true">→</span>
                  <span className="truncate">{message.to}</span>
                  {message.deliveredAt ? (
                    <span className="ml-auto shrink-0 font-mono text-ui-xs text-[var(--color-foreground-subtlest)]">
                      {message.deliveredAt.slice(11, 16)}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-ui-base leading-5 text-foreground">{message.message}</p>
              </div>
            </div>
          ))
        )}
        {totalUnread > team.unreadMessages.length && team.unreadMessages.length > 0 ? (
          <p className="px-1.5 pt-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "teamPanel.mailbox.previewLimited" })}
          </p>
        ) : null}
      </section>
      <section>
        <h3 className="px-1.5 pb-1.5 text-ui-sm font-medium text-[var(--color-foreground-subtlest)]">
          {intl.formatMessage({ id: "teamPanel.mailbox.rosterSection" })}
        </h3>
        {team.mailboxes.length === 0 ? (
          <p className="px-1.5 text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "teamPanel.mailbox.rosterEmpty" })}
          </p>
        ) : (
          team.mailboxes.map((mailbox) => (
            <div
              key={mailbox.address}
              className="flex min-h-7 min-w-0 items-center gap-2 rounded-lg px-2 text-ui-base"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtle">
                {mailbox.address}
              </span>
              <span
                className={cn(
                  "shrink-0 text-ui-sm tabular-nums",
                  mailbox.unread > 0
                    ? "text-[var(--color-warning)]"
                    : "text-[var(--color-foreground-subtlest)]",
                )}
              >
                {intl.formatMessage(
                  { id: "teamPanel.mailbox.counts" },
                  { unread: String(mailbox.unread), read: String(mailbox.read) },
                )}
              </span>
            </div>
          ))
        )}
      </section>
    </div>
  );
});
