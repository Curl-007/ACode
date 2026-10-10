import {
  createCoreError,
  CoreErrorType,
  type SessionId,
  type SessionStorePort,
} from "@acode/contracts";

export interface ScriptWorkflowOwnerContext {
  parentSessionId: SessionId;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  workspacePath: string;
}

export interface ScriptWorkflowOwnerDeps {
  sessionId: SessionId;
  sessionStore: SessionStorePort;
}

/**
 * Assert that a script workflow run belongs to the current session/workspace/remote attachment.
 * The gate is read-only and intentionally owns no workflow state.
 */
export async function assertScriptWorkflowResumeOwner(
  deps: ScriptWorkflowOwnerDeps,
  run: {
    cwd: string;
    id: string;
    parentSessionId?: SessionId;
    remoteSessionId?: string;
    workspaceIdentity?: string;
  },
  owner: ScriptWorkflowOwnerContext,
): Promise<void> {
  if (run.parentSessionId !== owner.parentSessionId || run.parentSessionId !== deps.sessionId) {
    throw workflowOwnerMismatch(run.id, "parent_session_id");
  }

  // 存量行没有 workspaceIdentity：从 parent session 的持久化 workspaceID 恢复，再退回 cwd。
  // 远程上下文仍要求显式 remoteSessionId，缺失时 fail closed。
  const parentSession = await deps.sessionStore.getSession(run.parentSessionId);
  const persistedWorkspace =
    run.workspaceIdentity?.trim() || parentSession?.workspaceID?.trim() || run.cwd;
  const currentWorkspace = owner.workspaceIdentity?.trim() || owner.workspacePath;
  if (!persistedWorkspace || persistedWorkspace !== currentWorkspace) {
    throw workflowOwnerMismatch(run.id, "workspace_identity");
  }

  const persistedRemote = run.remoteSessionId?.trim() || undefined;
  const currentRemote = owner.remoteSessionId?.trim() || undefined;
  if (persistedRemote !== currentRemote) {
    throw workflowOwnerMismatch(run.id, "remote_session_id");
  }
}

function workflowOwnerMismatch(runId: string, boundary: string): Error {
  return createCoreError(CoreErrorType.PermissionDenied, "Workflow run owner mismatch", {
    context: { boundary, ownerMismatch: true, runId },
    recoverable: false,
    retryable: false,
  });
}
