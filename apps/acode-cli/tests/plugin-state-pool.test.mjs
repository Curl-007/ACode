import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const { createMcpAdapterConnectionPool } = await import("../packages/adapters/src/mcp/index.ts");

const SERVER_SCRIPT = join(
  import.meta.dirname,
  "..",
  "packages",
  "agent-teams-plugin",
  "dist",
  "mcp",
  "server.js",
);

it("pooled plugin notifications reach only live session leases", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "at-pool-"));
  const pool = createMcpAdapterConnectionPool({ clientName: "pool-test", clientVersion: "0.0.0" });
  const settings = pool.acquireLease({ leaseId: "settings" });
  const first = pool.acquireLease({ leaseId: "first", sessionId: "sess-first" });
  const second = pool.acquireLease({ leaseId: "second", sessionId: "sess-second" });
  const config = {
    type: "stdio",
    command: process.execPath,
    args: [SERVER_SCRIPT],
    env: { ACODE_PROJECT_DIR: workspace },
    isolation: "workspace",
    source: { kind: "builtin", pluginId: "agent-teams@acode-plugins-official" },
  };
  const name = "plugin:agent-teams:team";
  const receivedFirst = [];
  const receivedSecond = [];
  const stopFirst = first.subscribePluginStateNotifications?.((notification) =>
    receivedFirst.push(notification.state),
  );
  second.subscribePluginStateNotifications?.((notification) =>
    receivedSecond.push(notification.state),
  );
  assert.equal(
    settings.subscribePluginStateNotifications?.(() =>
      assert.fail("settings must not receive plugin state"),
    ) instanceof Function,
    true,
  );
  try {
    await Promise.all([
      first.connectServer(name, config, { workingDirectory: workspace }),
      second.connectServer(name, config, { workingDirectory: workspace }),
    ]);
    const call = async (toolName, args) => {
      return await first.callTool({
        serverName: name,
        toolName,
        arguments: args,
        runtimeScope: "main",
        trace: {
          sessionId: "sess-first",
          traceId: "trace-first",
          turnId: "turn-1",
        },
      });
    };
    const created = await call("agent_teams_create", { goal: "pooled team" });
    assert.equal(
      JSON.parse(created.content[0].text).ok,
      true,
      created.content[0].text,
    );
    assert.equal(receivedFirst.length, 1);
    assert.equal(receivedSecond.length, 1);
    stopFirst?.();
    await first.close();
    const added = await second.callTool({
      serverName: name,
      toolName: "agent_teams_add_member",
      arguments: { name: "dev-1", role: "dev", charter: "test" },
      runtimeScope: "main",
      trace: {
        sessionId: "sess-first",
        traceId: "trace-second",
        turnId: "turn-2",
      },
    });
    assert.equal(
      JSON.parse(added.content[0].text).ok,
      true,
      added.content[0].text,
    );
    assert.equal(receivedFirst.length, 1);
    assert.equal(receivedSecond.length, 2);
  } finally {
    await Promise.all([first.close(), second.close(), settings.close()]);
    await pool.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
