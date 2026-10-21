import type { ReactNode } from "react";
import { TeamWorkflowCard } from "@/components/TeamWorkflowCard.js";
import type {
  OpenSubagentSideTabRequest,
  OpenTeamSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import type { ConversationStatusPanelTeam } from "./teamPanelModel.js";

/**
 * 会话尾部的团队卡槽。团队卡需要的会话 / 工作区身份一律由宿主（SessionPane）补齐：
 * 卡片只发意图（打开团队面板 / 打开成员会话），不感知 scope。
 */
export interface ConversationTeamCardsScope {
  parentSessionId: string | null;
  /** 子会话仍在运行 → 停止入口（SPEC-012 R13）：宿主把「子会话 id → 停止」对齐后传进来。 */
  resolveMemberStop?: (childSessionId: string) => (() => void) | undefined;
}

export function conversationTeamCardsSlot(
  teams: readonly ConversationStatusPanelTeam[],
  scope: ConversationTeamCardsScope,
  onOpenTeamPanel: ((request: OpenTeamSideTabRequest) => void) | undefined,
  onOpenSubagentSession: ((request: OpenSubagentSideTabRequest) => void) | undefined,
  hidden: boolean,
): ReactNode {
  return hidden || !scope.parentSessionId || teams.length === 0 ? null : (
    <ConversationTeamCards
      teams={teams}
      scope={scope}
      onOpenTeamPanel={onOpenTeamPanel}
      onOpenSubagentSession={onOpenSubagentSession}
    />
  );
}

export function ConversationTeamCards({
  teams,
  scope,
  onOpenTeamPanel,
  onOpenSubagentSession,
}: {
  teams: readonly ConversationStatusPanelTeam[];
  scope: ConversationTeamCardsScope;
  onOpenTeamPanel?: (request: OpenTeamSideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
}) {
  const parentSessionId = scope.parentSessionId;
  if (!parentSessionId || teams.length === 0) return null;
  return (
    <div
      className="flex min-w-0 flex-col gap-3 px-4 pb-4 pt-2"
      data-testid="conversation-team-cards"
    >
      {teams.map((team) => (
        <TeamWorkflowCard
          key={team.teamId}
          team={team}
          {...(onOpenTeamPanel
            ? { onOpen: (landing) => onOpenTeamPanel({ ...landing, parentSessionId }) }
            : {})}
          {...(onOpenSubagentSession
            ? {
                onOpenMemberSession: ({ childSessionId, title }) =>
                  onOpenSubagentSession({
                    parentSessionId,
                    childSessionId,
                    subagentType: "agent-teams:member",
                    title,
                  }),
              }
            : {})}
          {...(scope.resolveMemberStop ? { resolveMemberStop: scope.resolveMemberStop } : {})}
        />
      ))}
    </div>
  );
}
