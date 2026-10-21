import { useCallback } from "react";
import type {
  OpenScopedTeamSideTabRequest,
  OpenTeamSideTabRequest,
} from "@/lib/workspaceSidePane.js";

export function useTeamPanelOpener({
  onOpenTeamPanel,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  rootSessionId,
}: {
  onOpenTeamPanel?: (request: OpenScopedTeamSideTabRequest) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  rootSessionId?: string | null;
}) {
  return useCallback(
    (request: OpenTeamSideTabRequest) => {
      onOpenTeamPanel?.({
        ...request,
        rootSessionId: request.rootSessionId ?? rootSessionId ?? request.parentSessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
      });
    },
    [onOpenTeamPanel, remoteSessionId, rootSessionId, workspaceIdentity, workspacePath],
  );
}
