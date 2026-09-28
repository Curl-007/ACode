import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskRespondPermissionParams,
  selectFallbackPermissionRequest,
  type SnapshotPendingInteractionRef,
} from "../src/v4/botPermissionFallback.js";
import type { ACodePermissionOption, ACodePermissionRequest } from "@acode/shared";

function makeRequest(requestId: string): ACodePermissionRequest {
  const option: ACodePermissionOption = {
    optionId: `${requestId}-allow`,
    kind: "allow",
    name: "Allow",
    response: { decision: "allow" },
  };
  return {
    type: "permission_request",
    taskId: "task-1",
    traceId: "trace-1" as ACodePermissionRequest["traceId"],
    requestId,
    description: "run command",
    kind: "bash",
    options: [
      option,
      {
        optionId: "deny",
        kind: "deny",
        name: "Deny",
        response: { decision: "deny", reason: "user denied" },
      },
    ],
    raw: {},
  };
}

function snap(
  interactionId: string,
  kind: string,
): SnapshotPendingInteractionRef {
  return { interactionId, payload: { kind } };
}

test("snapshot permission interaction suppresses store fallback for same requestId", () => {
  const req = makeRequest("r1");
  const result = selectFallbackPermissionRequest([snap("r1", "permission")], {
    permissionRequest: req,
    pendingPermissionRequests: [],
  });
  assert.equal(result, null);
});

test("snapshot userInput interaction does not suppress permission fallback", () => {
  const req = makeRequest("r1");
  const result = selectFallbackPermissionRequest([snap("r1", "userInput")], {
    permissionRequest: req,
    pendingPermissionRequests: [],
  });
  // requestId 相同但 kind 不是 permission：snapshot 那条是别的交互，store 权限仍需兜底。
  assert.equal(result?.requestId, "r1");
});

test("queue order is head-first then pending, preserving arrival order", () => {
  const head = makeRequest("r1");
  const p2 = makeRequest("r2");
  const p3 = makeRequest("r3");
  const result = selectFallbackPermissionRequest([], {
    permissionRequest: head,
    pendingPermissionRequests: [p2, p3],
  });
  assert.equal(result?.requestId, "r1");
});

test("first non-snapshot candidate wins when head is already projected", () => {
  const head = makeRequest("r1");
  const p2 = makeRequest("r2");
  const p3 = makeRequest("r3");
  const result = selectFallbackPermissionRequest([snap("r1", "permission")], {
    permissionRequest: head,
    pendingPermissionRequests: [p2, p3],
  });
  assert.equal(result?.requestId, "r2");
});

test("duplicate requestId across head and queue is rendered once", () => {
  const head = makeRequest("r1");
  const dup = makeRequest("r1");
  const result = selectFallbackPermissionRequest([snap("r1", "permission")], {
    permissionRequest: head,
    pendingPermissionRequests: [dup],
  });
  // head 被 snapshot 压掉后，队列里的同 requestId 也应被去重（不重复渲染），返回 null。
  assert.equal(result, null);
});

test("empty store yields no fallback", () => {
  assert.equal(
    selectFallbackPermissionRequest([], {
      permissionRequest: null,
      pendingPermissionRequests: [],
    }),
    null,
  );
});

test("undefined snapshot is treated as no projection", () => {
  const req = makeRequest("r1");
  const result = selectFallbackPermissionRequest(undefined, {
    permissionRequest: req,
    pendingPermissionRequests: [],
  });
  assert.equal(result?.requestId, "r1");
});

test("buildTaskRespondPermissionParams omits workspaceIdentity when absent", () => {
  const req = makeRequest("r1");
  const params = buildTaskRespondPermissionParams({
    taskId: "task-1",
    workspacePath: "/ws",
    request: req,
    option: req.options[0],
  });
  assert.equal(params.taskId, "task-1");
  assert.equal(params.workspacePath, "/ws");
  assert.equal(params.requestId, "r1");
  assert.equal(params.optionId, "r1-allow");
  assert.deepEqual(params.response, { decision: "allow" });
  assert.equal("workspaceIdentity" in params, false);
});

test("buildTaskRespondPermissionParams carries workspaceIdentity when provided", () => {
  const req = makeRequest("r1");
  const params = buildTaskRespondPermissionParams({
    taskId: "task-1",
    workspacePath: "/ws",
    workspaceIdentity: "remote-identity",
    request: req,
    option: req.options[1],
  });
  assert.equal(params.workspaceIdentity, "remote-identity");
  assert.equal(params.optionId, "deny");
  assert.deepEqual(params.response, { decision: "deny", reason: "user denied" });
});
