import type { ACodeSessionStateSnapshot } from "@acode/shared";
import type {
  ACodeSessionWorkspaceTarget,
  ACodeTaskTarget,
} from "#src/acode-session/acodeSession.js";

function getWorkspaceKey(target: ACodeSessionWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function getSessionScopedKey(target: ACodeTaskTarget): string {
  return `${getWorkspaceKey(target)}\0${target.sessionId}`;
}

export function createACodeDeferredDraftRegistry() {
  const sessionKeys = new Set<string>();

  return {
    remember(params: ACodeSessionWorkspaceTarget, snapshot: ACodeSessionStateSnapshot): void {
      sessionKeys.add(
        getSessionScopedKey({
          workspacePath: snapshot.session.workspace.workspacePath,
          workspaceIdentity:
            snapshot.session.workspace.workspaceIdentity ?? params.workspaceIdentity,
          sessionId: snapshot.session.sessionId,
        }),
      );
    },

    has(target: ACodeTaskTarget): boolean {
      return sessionKeys.has(getSessionScopedKey(target));
    },

    forget(target: ACodeTaskTarget): void {
      sessionKeys.delete(getSessionScopedKey(target));
    },
  };
}
