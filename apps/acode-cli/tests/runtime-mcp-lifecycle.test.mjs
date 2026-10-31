import assert from "node:assert/strict";
import { test } from "node:test";

const { initializeMcp } = await import("../packages/core/src/runtime/methods/mcp.ts");
const { initializeRuntimeMcpLifecycle } = await import(
  "../packages/core/src/runtime/runtime-mcp-lifecycle.ts"
);

function makeRuntime(startup) {
  let registered = 0;
  const runtime = {
    mcpPort: { callTool: async () => ({ content: [] }) },
    config: { mcp: { servers: {} } },
    registry: {
      register() {
        registered += 1;
      },
    },
    invalidateToolCache() {},
    startMcpStartup() {
      return startup();
    },
    logger: undefined,
  };
  // R1-01 B4：mcpInitialized/mcpStartupPromise/mcpInitializationPromise/mcpToolsRegistered
  // 归 RuntimeMcpLifecycleOwner——桩与真实构造期一样装只读 getter（初始值 false/undefined，
  // 与迁移前的扁平字面量一致），initializeMcp 的 claim/release/单调提交经端口。
  initializeRuntimeMcpLifecycle(runtime);
  return { runtime, getRegistered: () => registered };
}

const TOOL = {
  serverName: "fixture",
  toolName: "read",
  inputSchema: { type: "object", properties: {} },
};

test("并发 initializeMcp 共享一次 registration attempt", async () => {
  let release;
  let startupCalls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { runtime, getRegistered } = makeRuntime(async () => {
    startupCalls += 1;
    await gate;
    return { statuses: {}, tools: [TOOL] };
  });

  const first = initializeMcp.call(runtime, { traceId: "trace-1", turnId: "turn-1" });
  const second = initializeMcp.call(runtime, { traceId: "trace-2", turnId: "turn-2" });
  await Promise.resolve();
  assert.equal(startupCalls, 1);
  assert.equal(runtime.mcpToolsRegistered, false);

  release();
  await Promise.all([first, second]);
  assert.equal(getRegistered(), 1, "并发调用只能注册一次工具");
  assert.equal(runtime.mcpToolsRegistered, true);
  assert.equal(runtime.mcpInitializationPromise, undefined);
});

test("初始化完成后重复调用不重新读取 startup", async () => {
  let startupCalls = 0;
  const { runtime, getRegistered } = makeRuntime(async () => {
    startupCalls += 1;
    return { statuses: {}, tools: [] };
  });

  await initializeMcp.call(runtime, { traceId: "trace-1", turnId: "turn-1" });
  await initializeMcp.call(runtime, { traceId: "trace-2", turnId: "turn-2" });
  assert.equal(startupCalls, 1);
  assert.equal(getRegistered(), 0);
});

test("startup 拒绝后只完成一次 fail-closed 初始化", async () => {
  let startupCalls = 0;
  const { runtime, getRegistered } = makeRuntime(async () => {
    startupCalls += 1;
    throw new Error("startup failed");
  });

  await initializeMcp.call(runtime, { traceId: "trace-1", turnId: "turn-1" });
  await initializeMcp.call(runtime, { traceId: "trace-2", turnId: "turn-2" });

  assert.equal(startupCalls, 1, "startup 拒绝后不能在同一 runtime 重试连接");
  assert.equal(getRegistered(), 0, "startup 失败必须保持工具未注册");
  assert.equal(runtime.mcpToolsRegistered, true);
  assert.equal(runtime.mcpInitializationPromise, undefined);
});
