// 熔断挂起的 store 映射语义（apps/acode-cli/specs/mcp-lifecycle-ttl-approval.md R2.3 验收 3）：
// failed/disconnected 透传挂起字段；快照缺失时清除旧值——恢复后不得残留挂起横幅。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeMcpServerStatusSnapshots } from "../src/store/mcpStoreStatusList.js";
import type { ACodeMcpServer } from "@acode/shared";
import { type V4McpServerStatusSnapshot } from "@acode/shared/acode-protocol-v4";

const SERVER: ACodeMcpServer = {
  id: "srv",
  name: "srv",
  config: { command: "srv", args: [] },
  enabled: true,
  source: "acodeagentmcp",
  scope: "user",
};

const SUSPENSION = {
  consecutiveFailures: 3,
  suspendedAt: "2026-10-18T11:59:00.000Z",
  suspendedBy: "connect_failures",
} as const;

function snapshot(
  partial: Partial<V4McpServerStatusSnapshot> & {
    reconnectSuspension?: V4McpServerStatusSnapshot["reconnectSuspension"];
  },
): V4McpServerStatusSnapshot {
  return {
    status: "failed",
    transport: "stdio",
    toolCount: 0,
    updatedAt: "2026-10-18T12:00:00.000Z",
    ...partial,
  } as V4McpServerStatusSnapshot;
}

test("failed 快照带挂起：映射保留 reconnectSuspension 且 status=error", () => {
  const [merged] = mergeMcpServerStatusSnapshots([SERVER], {
    srv: snapshot({ status: "failed", error: "boom", reconnectSuspension: { ...SUSPENSION } }),
  });
  assert.equal(merged?.status, "error");
  assert.deepEqual(merged?.reconnectSuspension, { ...SUSPENSION });
});

test("disconnected 快照带挂起（in_call_crashes/crash_storm 挂在该态）：同样保留", () => {
  const [merged] = mergeMcpServerStatusSnapshots([SERVER], {
    srv: snapshot({
      status: "disconnected",
      reconnectSuspension: {
        consecutiveFailures: 0,
        consecutiveInCallCrashes: 3,
        suspendedAt: "2026-10-18T11:59:00.000Z",
        suspendedBy: "in_call_crashes",
      },
    }),
  });
  assert.equal(merged?.status, "disconnected");
  assert.equal(merged?.reconnectSuspension?.suspendedBy, "in_call_crashes");
});

test("恢复后的快照无挂起字段：store 内旧值被清除", () => {
  const suspended: ACodeMcpServer = { ...SERVER, reconnectSuspension: { ...SUSPENSION } };
  const [merged] = mergeMcpServerStatusSnapshots([suspended], {
    srv: snapshot({ status: "connected", toolCount: 4 }),
  });
  assert.equal(merged?.status, "connected");
  assert.equal(merged?.reconnectSuspension, undefined);
});

test("connected 快照即使异常携带挂起字段也不透传（R1：显式复位先于连接）", () => {
  const [merged] = mergeMcpServerStatusSnapshots([SERVER], {
    srv: snapshot({ status: "connected", reconnectSuspension: { ...SUSPENSION } }),
  });
  assert.equal(merged?.reconnectSuspension, undefined);
});

test("非 acodeagentmcp 来源的行不参与状态合并（既有语义不受影响）", () => {
  const external: ACodeMcpServer = { ...SERVER, id: "ext", name: "ext", source: "mcp" };
  const [merged] = mergeMcpServerStatusSnapshots([external], {
    ext: snapshot({ status: "failed", reconnectSuspension: { ...SUSPENSION } }),
  });
  assert.equal(merged?.reconnectSuspension, undefined);
  assert.equal(merged?.status, undefined);
});
