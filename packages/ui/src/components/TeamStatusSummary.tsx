import { Maximize2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { teamStatusDotClass } from "@/app-shell/teamPaneParts.js";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationStatusPanelTeam } from "@/v4/teamPanelModel.js";
import { teamStatusMessageId } from "@/v4/teamWorkflowPresentation.js";
import type { OpenTeamSideTabRequest } from "@/lib/workspaceSidePane.js";

export function TeamStatusSummary({
  team,
  parentSessionId,
  onOpenTeamPanel,
}: {
  team: ConversationStatusPanelTeam;
  parentSessionId?: string;
  onOpenTeamPanel?: (request: OpenTeamSideTabRequest) => void;
}) {
  const { intl } = useACodeIntl();
  const statusId = teamStatusMessageId(team.status);
  return (
    <div className="min-w-0 px-3 pb-2">
      <div className="flex min-w-0 items-start gap-2">
        <span
          aria-hidden
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", teamStatusDotClass(team))}
        />
        <span
          className="line-clamp-2 min-w-0 flex-1 text-ui-base text-foreground"
          title={team.goal}
        >
          {team.goal}
        </span>
        {parentSessionId && onOpenTeamPanel ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "chat.statusPanel.agentTeams.openPanel" })}
            onClick={() => onOpenTeamPanel({ parentSessionId, teamId: team.teamId })}
          >
            <Maximize2Icon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 text-ui-sm text-foreground-subtle">
        <span>{statusId ? intl.formatMessage({ id: statusId }) : team.status}</span>
        <span>
          {intl.formatMessage(
            { id: "chat.statusPanel.agentTeams.memberCount" },
            { count: team.members.filter((member) => member.status !== "removed").length },
          )}
        </span>
        {team.counts.inProgress > 0 ? (
          <span>
            {intl.formatMessage(
              { id: "chat.statusPanel.agentTeams.inProgressCount" },
              { count: team.counts.inProgress },
            )}
          </span>
        ) : null}
        {team.stale ? (
          <span title={intl.formatMessage({ id: "chat.statusPanel.agentTeams.staleHint" })}>
            {intl.formatMessage({ id: "chat.statusPanel.agentTeams.stale" })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
