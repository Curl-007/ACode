import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { createMcpAdapter } = await import("../packages/adapters/src/mcp/index.ts");
const { ProductProjection } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/product-projection.ts"
);
const { SessionEventType } = await import("../packages/contracts/src/events/session.events.ts");

/**
 * 通知桥接：插件 server（dist 产物）→ 宿主 adapter 的 logging notification handler →
 * McpPluginStateNotification 截获。验证宿主侧收到的 pluginId/key/state 形状与
 * specs/agent-teams-desktop-panel.md §3.1 的约定一致。
 *
 * server 侧是 esbuild 产物（真实 bundle，不是源码 import），链路与生产一致。
 */
const SERVER_SCRIPT = join(
  import.meta.dirname,
  "..",
  "packages",
  "agent-teams-plugin",
  "dist",
  "mcp",
  "server.js",
);

describe("MCP 插件状态通知桥（adapter → PluginStateUpdated 输入）", () => {
  it("forwards acode-plugin-state logging notifications with derived pluginId", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "at-bridge-"));
    const received = [];
    const adapter = createMcpAdapter({
      clientName: "bridge-test",
      clientVersion: "0.0.0",
      onPluginStateNotification: (notification) => {
        received.push({
          pluginId: notification.pluginId,
          key: notification.key,
          state: notification.state,
        });
      },
    });
    try {
      await adapter.connectConfiguredServers(
        {
          "plugin:agent-teams:team": {
            type: "stdio",
            command: process.execPath,
            args: [SERVER_SCRIPT],
            enabled: true,
            timeoutMs: 60_000,
            env: { ACODE_PROJECT_DIR: workspace },
            source: { kind: "builtin", pluginId: "agent-teams@acode-plugins-official" },
          },
        },
        {},
      );
      // adapter.callTool 的 toolName 是 server 原生工具名（mcp__ 前缀名是模型可见层）。
      const toolName = "agent_teams_create";
      await adapter.callTool({
        serverName: "plugin:agent-teams:team",
        toolName,
        arguments: { goal: "bridge test" },
        trace: {
          traceId: "trace-bridge",
          sessionId: "sess-bridge",
          turnId: "turn-1",
        },
      });
      // 通知是 fire-and-forget：轮询等待送达。
      const deadline = Date.now() + 15_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(received.length >= 1, "adapter 应转发至少一条插件状态通知");
      const first = received[0];
      assert.equal(first.pluginId, "agent-teams@acode-plugins-official");
      assert.equal(first.key, "agent-teams");
      const state = first.state;
      assert.equal(state.v, 1);
      assert.equal(state.goal, "bridge test");
      assert.ok(typeof state.teamId === "string" && state.teamId.length > 0);
    } finally {
      await adapter.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps marketplace identity from the loader instead of guessing official by server name", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "at-personal-"));
    const received = [];
    const adapter = createMcpAdapter({
      clientName: "identity-test",
      clientVersion: "0.0.0",
      onPluginStateNotification: (notification) => received.push(notification.pluginId),
    });
    try {
      await adapter.connectConfiguredServers(
        {
          "plugin:agent-teams:team": {
            type: "stdio",
            command: process.execPath,
            args: [SERVER_SCRIPT],
            enabled: true,
            timeoutMs: 60_000,
            env: { ACODE_PROJECT_DIR: workspace },
            source: { kind: "plugin", pluginId: "agent-teams@personal-market" },
          },
        },
        {},
      );
      await adapter.callTool({
        serverName: "plugin:agent-teams:team",
        toolName: "agent_teams_create",
        arguments: { goal: "personal test" },
        trace: {
          traceId: "trace-personal",
          sessionId: "sess-personal",
          turnId: "turn-1",
        },
      });
      const deadline = Date.now() + 15_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.deepEqual(received, ["agent-teams@personal-market"]);
    } finally {
      await adapter.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("never forwards state notifications without a loader-proven pluginId", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "at-untrusted-"));
    const received = [];
    const adapter = createMcpAdapter({
      clientName: "no-source-test",
      clientVersion: "0.0.0",
      onPluginStateNotification: (notification) => received.push(notification),
    });
    try {
      // 普通 MCP（source 缺席）即使 server 自报 acode-plugin-state: logger 也不得投递：
      // 身份只能来自 loader 写在 config.source.pluginId 的权威值。
      await adapter.connectConfiguredServers(
        {
          "plugin:agent-teams:team": {
            type: "stdio",
            command: process.execPath,
            args: [SERVER_SCRIPT],
            enabled: true,
            timeoutMs: 60_000,
            env: { ACODE_PROJECT_DIR: workspace },
          },
        },
        {},
      );
      await adapter.callTool({
        serverName: "plugin:agent-teams:team",
        toolName: "agent_teams_create",
        arguments: { goal: "no source test" },
        trace: {
          traceId: "trace-no-source",
          sessionId: "sess-no-source",
          turnId: "turn-1",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assert.deepEqual(received, []);
    } finally {
      await adapter.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not bump projection revision for equal plugin states", () => {
    const projection = new ProductProjection("sess-bridge", "epoch-bridge");
    // 初次快照无插件状态（projection-state 初值 null）。
    assert.equal(projection.getSnapshot().pluginStates, null);
    const event = (state, sequenceNumber) => ({
      id: `event-${sequenceNumber}`,
      sessionId: "sess-bridge",
      traceId: "trace-bridge",
      type: SessionEventType.PluginStateUpdated,
      timestamp: new Date(),
      sequenceNumber,
      payload: { pluginId: "agent-teams@acode-plugins-official", key: "agent-teams", state },
    });
    const first = { v: 1, teamId: "team-1", counts: { done: 1 } };
    const equalCopy = { counts: { done: 1 }, teamId: "team-1", v: 1 };
    const changed = { ...first, counts: { done: 2 } };
    const events = [event(first, 1), event(equalCopy, 2), event(changed, 3), event(null, 4)];
    assert.ok(projection.applyEvent(events[0]).length > 0);
    const revision = projection.getSnapshot().revision;
    assert.deepEqual(projection.getSnapshot().pluginStates, {
      "agent-teams@acode-plugins-official:agent-teams": first,
    });
    assert.deepEqual(projection.applyEvent(events[1]), []);
    assert.equal(projection.getSnapshot().revision, revision);
    assert.ok(projection.applyEvent(events[2]).length > 0);
    // pluginStates 是非命令展示状态，不进 REVISION_BEARING_PATCH_KEYS：值变也不抬 revision。
    assert.equal(projection.getSnapshot().revision, revision);
    assert.deepEqual(projection.getSnapshot().pluginStates, {
      "agent-teams@acode-plugins-official:agent-teams": changed,
    });
    // 归档后插件推 state=null：键级整体替换为 null（UI 卡片消失），revision 仍不动。
    assert.ok(projection.applyEvent(events[3]).length > 0);
    assert.equal(projection.getSnapshot().revision, revision);
    assert.deepEqual(projection.getSnapshot().pluginStates, {
      "agent-teams@acode-plugins-official:agent-teams": null,
    });
    // 冷恢复：同一事件日志在新投影上重放，pluginStates 与热投影逐字节一致。
    const replay = new ProductProjection("sess-bridge", "epoch-bridge");
    for (const item of events) replay.applyEvent(item);
    assert.deepEqual(replay.getSnapshot().pluginStates, projection.getSnapshot().pluginStates);
  });
});
