import assert from "node:assert/strict";
import { test } from "node:test";
import { assertScriptWorkflowResumeOwner } from "../packages/workflow-run-command/src/index.ts";

const SESSION = "session_owner";
const RUN = {
  cwd: "C:/repo",
  id: "wf_owner_1",
  parentSessionId: SESSION,
  remoteSessionId: "remote_1",
  workspaceIdentity: "workspace_1",
};

function deps(overrides = {}) {
  return {
    sessionId: SESSION,
    sessionStore: {
      async getSession() {
        return { workspaceID: "workspace_1" };
      },
      ...overrides,
    },
  };
}

const owner = {
  parentSessionId: SESSION,
  remoteSessionId: "remote_1",
  workspaceIdentity: "workspace_1",
  workspacePath: "C:/repo",
};

test("合法 owner 通过且只读取父 session", async () => {
  let reads = 0;
  await assertScriptWorkflowResumeOwner(
    deps({
      async getSession(sessionId) {
        reads++;
        assert.equal(sessionId, SESSION);
        return { workspaceID: "workspace_1" };
      },
    }),
    RUN,
    owner,
  );
  assert.equal(reads, 1);
});

test("parent session 越权在读取 workspace 前拒绝", async () => {
  let reads = 0;
  await assert.rejects(
    assertScriptWorkflowResumeOwner(
      deps({ getSession: async () => (reads++, null) }),
      { ...RUN, parentSessionId: "foreign_session" },
      owner,
    ),
    (error) => {
      assert.equal(error.type, "permission_denied");
      assert.deepEqual(error.context, {
        boundary: "parent_session_id",
        ownerMismatch: true,
        runId: RUN.id,
      });
      return true;
    },
  );
  assert.equal(reads, 0);
});

test("存量 run 没有 workspace identity 时回退父 session workspace", async () => {
  await assertScriptWorkflowResumeOwner(
    deps({
      sessionStore: {
        async getSession() {
          return { workspaceID: "workspace_1" };
        },
      },
    }),
    { ...RUN, workspaceIdentity: undefined, cwd: "C:/legacy-path" },
    owner,
  );
});

test("workspace identity 不匹配拒绝且带边界上下文", async () => {
  await assert.rejects(
    assertScriptWorkflowResumeOwner(deps(), RUN, {
      ...owner,
      workspaceIdentity: "workspace_foreign",
    }),
    (error) => {
      assert.equal(error.type, "permission_denied");
      assert.equal(error.context?.boundary, "workspace_identity");
      assert.equal(error.context?.ownerMismatch, true);
      assert.equal(error.recoverable, false);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("remote identity 缺失或不匹配均 fail closed", async () => {
  for (const currentRemote of [undefined, "remote_foreign"]) {
    await assert.rejects(
      assertScriptWorkflowResumeOwner(deps(), RUN, {
        ...owner,
        remoteSessionId: currentRemote,
      }),
      (error) => {
        assert.equal(error.type, "permission_denied");
        assert.equal(error.context?.boundary, "remote_session_id");
        return true;
      },
    );
  }
});
