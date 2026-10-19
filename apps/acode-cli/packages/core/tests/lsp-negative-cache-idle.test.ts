// 验收场景 3（specs/lsp-diagnostics-loop.md §7）：负缓存 + 空闲关停单测——
// 确定性 init 失败第二次调用立即失败；idleTimeout 到期 checkIdleClients 关停；
// pending 请求期间不回收。
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkIdleClients,
  isIdleCheckerRunning,
  isIdleClient,
  resetInitFailures,
} from "../src/lsp/client-idle.js";
import { setSpawnTransportOverride, getOrCreateClient } from "../src/lsp/client.js";
import { configCache } from "../src/lsp/config.js";
import type { LspClient, ServerConfig } from "../src/lsp/types.js";

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { command: "stub-lsp", args: [], fileTypes: [".stub"], rootMarkers: ["."], ...overrides };
}

/** 立即退出的传输替身：initialize 永远失败（EOF）。 */
function failingTransport(): LspClient["proc"] {
  return {
    stdin: { write: () => false, end: () => {} },
    stdout: null as unknown as NodeJS.ReadableStream,
    kill: () => {},
    get exitCode() {
      return 0;
    },
    exited: Promise.resolve(0),
    peekStderr: () => "stub-server exploded",
  };
}

test("deterministic init failures are negatively cached", async () => {
  resetInitFailures();
  configCache.clear();
  setSpawnTransportOverride(() => failingTransport());
  try {
    const cfg = config();
    await assert.rejects(
      () => getOrCreateClient(cfg, process.cwd()),
      /stub-server exploded|exited/,
      "第一次调用报告服务器失败",
    );
    // 负缓存命中：第二次调用快速失败且不再 spawn（错误信息为负缓存文案）。
    await assert.rejects(() => getOrCreateClient(cfg, process.cwd()), /failed to initialize recently/);
  } finally {
    setSpawnTransportOverride(null);
    resetInitFailures();
    configCache.clear();
  }
});

test("idle clients are reaped only after quiet timeout and never mid-request", async () => {
  const fakeClient = {
    pendingRequests: new Map(),
    lastActivity: Date.now() - 10_000,
  } as unknown as LspClient;
  assert.equal(isIdleClient(fakeClient, Date.now(), 5_000), true, "空闲超限 → 可回收");
  assert.equal(isIdleClient(fakeClient, Date.now(), 60_000), false, "未超空闲窗口 → 不可回收");

  const busyClient = {
    pendingRequests: new Map([["1", { resolve: () => {}, reject: () => {}, method: "x" }]]),
    lastActivity: Date.now() - 10_000,
  } as unknown as LspClient;
  assert.equal(isIdleClient(busyClient, Date.now(), 5_000), false, "在途请求 → busy 绝不回收");
});

test("checkIdleClients with no configured timeout is a no-op and the checker stays off", async () => {
  configCache.clear();
  await checkIdleClients();
  assert.equal(isIdleCheckerRunning(), false, "无 idleTimeoutMs 配置时不启动后台 checker");
});
