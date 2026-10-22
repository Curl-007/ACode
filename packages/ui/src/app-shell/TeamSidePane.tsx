import { memo, useEffect, useMemo, useState } from "react";
import type { TeamSidePaneTab } from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import {
  buildConversationStatusPanelEndedTeams,
  buildConversationStatusPanelTeams,
} from "@/v4/teamPanelModel.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { TeamSidePaneView } from "./TeamSidePaneView.js";

const TeamSidePaneContents = memo(function TeamSidePaneContents({
  tab,
  onOpenMemberSession,
}: {
  tab: TeamSidePaneTab;
  onOpenMemberSession?: (request: { childSessionId: string; title: string }) => void;
}) {
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  // 团队面板与会话尾部团队卡同一归属口径：只列出以 tab.parentSessionId 为队长的团队。
  const teams = useMemo(
    () => buildConversationStatusPanelTeams(projection.snapshot?.pluginStates, tab.parentSessionId),
    [projection.snapshot?.pluginStates, tab.parentSessionId],
  );
  // 已结束的团队不在 teams[] 里（归档后随即从快照消失），落点命中 recentEnded 时
  // 仍要能只读查看（SPEC-012 R15）。
  const endedTeams = useMemo(
    () =>
      buildConversationStatusPanelEndedTeams(
        projection.snapshot?.pluginStates,
        tab.parentSessionId,
      ),
    [projection.snapshot?.pluginStates, tab.parentSessionId],
  );
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  // 载入态（SPEC-012 R14）：lease 未就绪或投影未到达。此前这一段渲染的是
  // 「当前会话没有活跃团队。」，与真正无团队共用一句话，看起来就像「点了没反应」。
  const loading = lease === null || projection.snapshot?.pluginStates === undefined;
  return (
    <TeamSidePaneView
      tab={tab}
      teams={teams}
      endedTeams={endedTeams}
      loading={loading}
      {...(onOpenMemberSession ? { onOpenMemberSession } : {})}
    />
  );
});

export const TeamSidePane = memo(function TeamSidePane({
  tab,
  onOpenMemberSession,
}: {
  tab: TeamSidePaneTab;
  /** 成员页签的「查看会话」（SPEC-012 R16）：打开该成员的子 Agent 会话。 */
  onOpenMemberSession?: (request: { childSessionId: string; title: string }) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <TeamSidePaneContents tab={tab} {...(onOpenMemberSession ? { onOpenMemberSession } : {})} />
    </V4PaneConversationProvider>
  );
});
