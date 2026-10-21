import { Button } from "@/components/ui/button.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationStatusPanelTeamMember } from "@/v4/teamPanelModel.js";

/**
 * 已结束团队仍绑着子会话时的一行提示（SPEC-012 R13）。
 *
 * 团队结束后成员的后台 Agent 可能还在跑（队长漏停，或成员卡在长回合里）。事实由
 * `members[].childSessionId` 给出；停在宿主侧只有一条通道——智能体分区每行的「停止」
 * （backgroundWorks 的 workId）。所以这里**不新造停止动作**：调用方把「子会话 id →
 * workId」的对齐关系传进来（`resolveStop`），本组件只负责一行文案加一个按钮。
 */
export function TeamLingeringMembers({
  members,
  title,
  resolveStop,
}: {
  members: readonly ConversationStatusPanelTeamMember[];
  title?: string;
  /** 子会话仍在运行 → 返回停止入口；返回 undefined 即只在文案里指路。 */
  resolveStop?: (childSessionId: string) => (() => void) | undefined;
}) {
  const { intl } = useACodeIntl();
  if (!resolveStop) return null;
  // 「已在跑」以宿主的运行事实为准，不以「成员已绑定」为准：绑定过但早已结束的成员
  // 不该在这里报「仍在运行」（此刻会吓着人，也点不动）。
  const stoppers = members
    .filter((member) => member.status !== "removed" && member.childSessionId)
    .flatMap((member) => {
      const stop = resolveStop(member.childSessionId!);
      return stop === undefined ? [] : [stop];
    });
  if (stoppers.length === 0) return null;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5 text-ui-sm text-foreground-subtle"
      data-testid="team-lingering-members"
      data-count={stoppers.length}
      title={title}
    >
      <span>
        {intl.formatMessage(
          { id: "chat.statusPanel.agentTeams.lingeringMembers" },
          { count: stoppers.length },
        )}
      </span>
      <Button
        size="xs"
        variant="ghost"
        data-testid="team-lingering-stop"
        onClick={() => {
          for (const stop of stoppers) stop();
        }}
      >
        {intl.formatMessage({ id: "chat.statusPanel.agentTeams.stopAll" })}
      </Button>
    </div>
  );
}
