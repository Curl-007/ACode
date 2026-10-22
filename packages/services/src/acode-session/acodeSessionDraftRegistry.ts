import { resolveWorkspaceKey, type ACodeSessionStateSnapshot } from "@acode/shared";
import type {
  ACodeSessionWorkspaceTarget,
  ACodeTaskTarget,
} from "#src/acode-session/acodeSession.js";

// 修复原因（review R3 EI-2）：此前内联 `target.workspaceIdentity?.trim() || target.workspacePath`，
// 改用 shared 的 resolveWorkspaceKey 统一权威实现，语义一致。
function getWorkspaceKey(target: ACodeSessionWorkspaceTarget): string {
  return resolveWorkspaceKey(target);
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
