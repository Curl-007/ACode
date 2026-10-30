import assert from "node:assert/strict";
import test from "node:test";
import type { ACodeAgentMcpServer, ACodeMcpServer } from "@acode/shared";
import { type V4McpServerStatusSnapshot, type V4PluginInfo } from "@acode/shared/acode-protocol-v4";
import {
  MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS,
  MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS,
  MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS,
  buildMcpOAuthAuthorizationStatusRefreshOptions,
  buildMcpOAuthAuthorizationStatusRefreshServers,
  buildMcpServerStatusListKey,
  buildPendingMcpOAuthAuthorizationRefreshKey,
  buildPluginMcpServerStatusListKey,
  createMcpOAuthAuthorizationStatusRefreshDeadline,
  createMcpStatusListRefreshQueue,
  isMcpOAuthAuthorizationStatusRefreshExpired,
  resolveMcpStatusListRefreshSkipReason,
  shouldShowPluginMcpServersInMcpSettings,
  transitionMcpAutoStatusListRefreshKey,
  transitionMcpOAuthAuthorizationPendingRefresh,
} from "../src/settings/mcp/mcpSettingsModel.js";

/**
 * McpSettingsSection batch-1 helper 外迁的接缝内决策表单测
 * （specs/god-component-split-plan.md 的 settings 三件套批次 + review 2026-10-28 §3.⑤）。
 *
 * 覆盖：
 * - refresh queue 决策矩阵（skip reason × queue 串行/重跑 × auto refresh key 去重）
 * - OAuth authorization build（pending/follow-up 的 servers 子集 + status mode payload + pending key）
 * - status list key 构建（server/plugin 的去重 key 形状与 enabled 抖动）
 * - OAuth 刷新窗口边界（deadline 边界 now = deadline / now = deadline+1）
 */

function makeServer(overrides: Partial<ACodeMcpServer> = {}): ACodeMcpServer {
  return {
    id: "srv",
    name: "srv",
    config: { command: "srv", args: [] },
    enabled: true,
    source: "acodeagentmcp",
    scope: "user",
    ...overrides,
  } as ACodeMcpServer;
}

function makeSnapshot(
  overrides: Partial<V4McpServerStatusSnapshot> = {},
): V4McpServerStatusSnapshot {
  return {
    status: "connected",
    transport: "stdio",
    toolCount: 0,
    updatedAt: "2026-10-28T00:00:00.000Z",
    ...overrides,
  } as V4McpServerStatusSnapshot;
}

function makePlugin(overrides: Partial<V4PluginInfo> = {}): V4PluginInfo {
  return {
    id: "com.acode.alpha",
    name: "alpha",
    enabled: true,
    source: "marketplace",
    marketplace: "acode-official",
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: [],
    ...overrides,
  } as V4PluginInfo;
}

// ── 常量钉死（review §3.⑤ 明示要外露）──

test("常量：refresh 间隔 1s / 窗口 5min / follow-up 上限 10", () => {
  assert.equal(MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS, 1_000);
  assert.equal(MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS, 5 * 60_000);
  assert.equal(MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS, 10);
});

// ── OAuth 刷新窗口边界（deadline 边界 now = deadline / now = deadline+1）──

test("createMcpOAuthAuthorizationStatusRefreshDeadline: now + 5min", () => {
  const t0 = 1_000_000;
  const deadline = createMcpOAuthAuthorizationStatusRefreshDeadline(() => t0);
  assert.equal(deadline, t0 + MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_DURATION_MS);
});

test("isMcpOAuthAuthorizationStatusRefreshExpired: now=deadline-1 false / now=deadline true / now=deadline+1 true", () => {
  const deadline = 5_000;
  assert.equal(isMcpOAuthAuthorizationStatusRefreshExpired(deadline, () => deadline - 1), false);
  // 边界：now == deadline 已视为过期（>=），覆盖 review 强调的两条边界用例
  assert.equal(isMcpOAuthAuthorizationStatusRefreshExpired(deadline, () => deadline), true);
  assert.equal(isMcpOAuthAuthorizationStatusRefreshExpired(deadline, () => deadline + 1), true);
});

// ── auto status list refresh key 去重 ──

test("transitionMcpAutoStatusListRefreshKey: 空 nextKey 清空 + 不刷新（workspace 切换防误判）", () => {
  assert.deepEqual(transitionMcpAutoStatusListRefreshKey("prev", ""), {
    lastRefreshKey: "",
    shouldRefresh: false,
  });
});

test("transitionMcpAutoStatusListRefreshKey: key 相同不刷新 / 不同则刷新并更新", () => {
  assert.deepEqual(transitionMcpAutoStatusListRefreshKey("k1", "k1"), {
    lastRefreshKey: "k1",
    shouldRefresh: false,
  });
  assert.deepEqual(transitionMcpAutoStatusListRefreshKey("k1", "k2"), {
    lastRefreshKey: "k2",
    shouldRefresh: true,
  });
});

// ── OAuth pending → follow-up transition ──

test("transitionMcpOAuthAuthorizationPendingRefresh: 无 active workspace → 双 null", () => {
  const r = transitionMcpOAuthAuthorizationPendingRefresh({
    activeWorkspaceKey: "",
    mcpServers: [],
    pendingKey: "k",
    previous: null,
  });
  assert.deepEqual(r, { followup: null, pending: null });
});

test("transitionMcpOAuthAuthorizationPendingRefresh: pendingKey 非空 → 重置 pending（拷贝 servers）", () => {
  const srv = { name: "s1" } as ACodeAgentMcpServer;
  const inputServers = [srv];
  const r = transitionMcpOAuthAuthorizationPendingRefresh({
    activeWorkspaceKey: "ws1",
    mcpServers: inputServers,
    pendingKey: "pk",
    previous: null,
  });
  assert.deepEqual(r.followup, null);
  assert.equal(r.pending?.workspaceKey, "ws1");
  assert.equal(r.pending?.pendingKey, "pk");
  assert.deepEqual(r.pending?.mcpServers, [srv]);
  // 必须拷贝——后续对入参数组的原地 push 不应污染已记录 pending
  assert.notEqual(r.pending?.mcpServers, inputServers);
});

test("transitionMcpOAuthAuthorizationPendingRefresh: 同 workspace 已有 followup → 保留同一对象引用", () => {
  const existing = {
    mcpServers: [],
    refreshKey: "ws1:pk:1",
    workspaceKey: "ws1",
  };
  const r = transitionMcpOAuthAuthorizationPendingRefresh({
    activeWorkspaceKey: "ws1",
    existingFollowup: existing,
    mcpServers: [],
    pendingKey: "",
    previous: {
      mcpServers: [],
      pendingKey: "pk",
      workspaceKey: "ws1",
    },
  });
  // 有界重试窗口必须保持同一对象（首包后自我 cleanup 会破坏重试节拍）
  assert.equal(r.followup, existing);
  assert.equal(r.pending, null);
});

test("transitionMcpOAuthAuthorizationPendingRefresh: 跨 workspace 的 followup → 双 null（不沿用）", () => {
  const existing = {
    mcpServers: [],
    refreshKey: "wsOther:pk:1",
    workspaceKey: "wsOther",
  };
  const r = transitionMcpOAuthAuthorizationPendingRefresh({
    activeWorkspaceKey: "ws1",
    existingFollowup: existing,
    mcpServers: [],
    pendingKey: "",
    previous: null,
  });
  assert.deepEqual(r, { followup: null, pending: null });
});

test("transitionMcpOAuthAuthorizationPendingRefresh: 无 pending 且 previous 跨 workspace → 双 null", () => {
  const r = transitionMcpOAuthAuthorizationPendingRefresh({
    activeWorkspaceKey: "ws1",
    mcpServers: [],
    pendingKey: "",
    previous: { mcpServers: [], pendingKey: "pk", workspaceKey: "wsOther" },
  });
  assert.deepEqual(r, { followup: null, pending: null });
});

test("transitionMcpOAuthAuthorizationPendingRefresh: 同 workspace 的 previous → 派生 followup（refreshKey 含 now）", () => {
  const now = () => 42;
  const srv = { name: "s1" } as ACodeAgentMcpServer;
  const previousServers = [srv];
  const r = transitionMcpOAuthAuthorizationPendingRefresh({
    activeWorkspaceKey: "ws1",
    mcpServers: [],
    now,
    pendingKey: "",
    previous: { mcpServers: previousServers, pendingKey: "pk", workspaceKey: "ws1" },
  });
  assert.equal(r.pending, null);
  assert.equal(r.followup?.workspaceKey, "ws1");
  assert.equal(r.followup?.refreshKey, "ws1:pk:42");
  assert.deepEqual(r.followup?.mcpServers, [srv]);
  // 必须拷贝——previous 与 followup 不能共享 servers 数组
  assert.notEqual(r.followup?.mcpServers, previousServers);
});

// ── resolveMcpStatusListRefreshSkipReason 决策矩阵 ──

test("resolveMcpStatusListRefreshSkipReason: 完整通过条件返回 undefined", () => {
  const input = {
    activeWorkspaceKey: "ws",
    activeWorkspacePath: "/tmp/ws",
    configReadyWorkspaceKey: "ws",
    isConfigLoaded: true,
    serverStatusListKey: "k",
    storeWorkspaceKey: "ws",
  };
  assert.equal(
    resolveMcpStatusListRefreshSkipReason({ input, requestedWorkspaceKey: "ws", trigger: "auto" }),
    undefined,
  );
});

test("resolveMcpStatusListRefreshSkipReason: 空 requested → no-active-workspace", () => {
  const input = {
    activeWorkspaceKey: "ws",
    activeWorkspacePath: "/tmp/ws",
    configReadyWorkspaceKey: "ws",
    isConfigLoaded: true,
    serverStatusListKey: "k",
    storeWorkspaceKey: "ws",
  };
  assert.equal(
    resolveMcpStatusListRefreshSkipReason({ input, requestedWorkspaceKey: "", trigger: "auto" }),
    "no-active-workspace",
  );
});

test("resolveMcpStatusListRefreshSkipReason: 各错位的 workspace key", () => {
  const base = {
    activeWorkspaceKey: "ws",
    activeWorkspacePath: "/tmp/ws",
    configReadyWorkspaceKey: "ws",
    isConfigLoaded: true,
    serverStatusListKey: "k",
    storeWorkspaceKey: "ws",
  };
  assert.equal(
    resolveMcpStatusListRefreshSkipReason({
      input: { ...base, activeWorkspaceKey: "ws2" },
      requestedWorkspaceKey: "ws",
      trigger: "auto",
    }),
    "workspace-changed",
  );
  assert.equal(
    resolveMcpStatusListRefreshSkipReason({
      input: { ...base, storeWorkspaceKey: "ws2" },
      requestedWorkspaceKey: "ws",
      trigger: "auto",
    }),
    "mcp-store-not-aligned",
  );
  assert.equal(
    resolveMcpStatusListRefreshSkipReason({
      input: { ...base, configReadyWorkspaceKey: "ws2" },
      requestedWorkspaceKey: "ws",
      trigger: "auto",
    }),
    "config-not-ready",
  );
});

test("resolveMcpStatusListRefreshSkipReason: config 未加载 / 无 workspacePath", () => {
  const base = {
    activeWorkspaceKey: "ws",
    activeWorkspacePath: "/tmp/ws",
    configReadyWorkspaceKey: "ws",
    isConfigLoaded: true,
    serverStatusListKey: "k",
    storeWorkspaceKey: "ws",
  };
  assert.equal(
    resolveMcpStatusListRefreshSkipReason({
      input: { ...base, isConfigLoaded: false },
      requestedWorkspaceKey: "ws",
      trigger: "auto",
    }),
    "config-not-loaded",
  );
  assert.equal(
    resolveMcpStatusListRefreshSkipReason({
      input: { ...base, activeWorkspacePath: undefined },
      requestedWorkspaceKey: "ws",
      trigger: "auto",
    }),
    "no-workspace-path",
  );
});

test("resolveMcpStatusListRefreshSkipReason: 空 key × auto skip / 空 key × manual 不 skip（按钮必须真发请求）", () => {
  const base = {
    activeWorkspaceKey: "ws",
    activeWorkspacePath: "/tmp/ws",
    configReadyWorkspaceKey: "ws",
    isConfigLoaded: true,
    serverStatusListKey: "",
    storeWorkspaceKey: "ws",
  };
  assert.equal(
    resolveMcpStatusListRefreshSkipReason({ input: base, requestedWorkspaceKey: "ws", trigger: "auto" }),
    "empty-status-list-key",
  );
  assert.equal(
    resolveMcpStatusListRefreshSkipReason({
      input: base,
      requestedWorkspaceKey: "ws",
      trigger: "manual",
    }),
    undefined,
  );
});

// ── refresh queue 串行 / 重跑 ──

test("createMcpStatusListRefreshQueue: 并发请求串行执行 + 后到请求触发重跑", async () => {
  const queue = createMcpStatusListRefreshQueue();
  const runs: string[] = [];
  const release: Array<() => void> = [];

  const first = queue.request(async () => {
    runs.push("first");
    // 模拟长任务：等外部 release 才返回
    await new Promise<void>((resolve) => release.push(resolve));
  });
  const second = queue.request(async () => {
    runs.push("second");
  });

  // first 还未 resolve，second 已入队等待
  await Promise.resolve();
  assert.deepEqual(runs, ["first"]);

  // 放行 first，second 请求会被合并为「跑一次 latestRun」
  release.forEach((r) => r());
  await Promise.all([first, second]);

  // second 调用更新了 latestRun，但队列在 first 完成后会重跑一次 latest（即 second 的 run）
  assert.deepEqual(runs, ["first", "second"]);
});

test("createMcpStatusListRefreshQueue: 单请求顺序完成", async () => {
  const queue = createMcpStatusListRefreshQueue();
  let called = 0;
  await queue.request(async () => {
    called += 1;
  });
  assert.equal(called, 1);
});

// ── OAuth authorization build ──

test("buildMcpOAuthAuthorizationStatusRefreshServers: 只挑 acodeagentmcp + enabled + 有 pending authorization", () => {
  const pending = makeServer({
    id: "p1",
    name: "p1",
    authorization: {
      type: "oauth_authorization_code",
      authorizationUrl: "https://x",
      startedAt: "t1",
    },
  });
  const notEnabled = makeServer({
    id: "p2",
    name: "p2",
    enabled: false,
    authorization: {
      type: "oauth_authorization_code",
      authorizationUrl: "https://x",
      startedAt: "t1",
    },
  });
  const notAcodeSource = makeServer({
    id: "p3",
    name: "p3",
    source: "mcp",
    authorization: {
      type: "oauth_authorization_code",
      authorizationUrl: "https://x",
      startedAt: "t1",
    },
  });
  const noAuth = makeServer({ id: "p4", name: "p4" });

  const out = buildMcpOAuthAuthorizationStatusRefreshServers([
    pending,
    notEnabled,
    notAcodeSource,
    noAuth,
  ]);
  // stdio 形态的 convertToACodeAgentMcpServer 期望 command；makeServer 用 command:"srv"
  assert.equal(out.length, 1);
  assert.equal(out[0]?.name, "p1");
});

test("buildMcpOAuthAuthorizationStatusRefreshServers: statusSnapshots 中的 pending 也算", () => {
  const srv = makeServer({ id: "p1", name: "p1" });
  const snapshots: Record<string, V4McpServerStatusSnapshot> = {
    p1: makeSnapshot({
      authorization: {
        type: "oauth_authorization_code",
        authorizationUrl: "https://x",
        startedAt: "t1",
      },
    }),
  };
  const out = buildMcpOAuthAuthorizationStatusRefreshServers([srv], snapshots);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.name, "p1");
});

test("buildMcpOAuthAuthorizationStatusRefreshServers: 同名去重（保留首个）", () => {
  const a = makeServer({
    id: "p1",
    name: "same",
    authorization: {
      type: "oauth_authorization_code",
      authorizationUrl: "https://x",
      startedAt: "t1",
    },
  });
  const b = makeServer({
    id: "p2",
    name: "same",
    authorization: {
      type: "oauth_authorization_code",
      authorizationUrl: "https://y",
      startedAt: "t2",
    },
  });
  const out = buildMcpOAuthAuthorizationStatusRefreshServers([a, b]);
  assert.equal(out.length, 1);
});

test("buildMcpOAuthAuthorizationStatusRefreshServers: convertToACodeAgentMcpServer 返回 null 时跳过", () => {
  // 无 command/url 的 server 在 convertToACodeAgentMcpServer 里返回 null
  const bad = makeServer({
    id: "p1",
    name: "p1",
    config: {} as ACodeMcpServer["config"],
    authorization: {
      type: "oauth_authorization_code",
      authorizationUrl: "https://x",
      startedAt: "t1",
    },
  });
  const out = buildMcpOAuthAuthorizationStatusRefreshServers([bad]);
  assert.equal(out.length, 0);
});

test("buildMcpOAuthAuthorizationStatusRefreshOptions: 恒为 mode=status（不进入 connect replace 路径）", () => {
  const srv = { name: "s1" } as ACodeAgentMcpServer;
  assert.deepEqual(buildMcpOAuthAuthorizationStatusRefreshOptions([srv]), {
    mode: "status",
    mcpServers: [srv],
  });
});

// ── status list key 构建 ──

test("buildMcpServerStatusListKey: 仅取 acodeagentmcp + 按 id:enabled:config 拼", () => {
  const a = makeServer({ id: "a", name: "a", config: { command: "x", args: [] } });
  const b = makeServer({ id: "b", name: "b", source: "mcp" });
  const c = makeServer({ id: "c", name: "c", enabled: false });
  const key = buildMcpServerStatusListKey([a, b, c]);
  // b 非 acodeagentmcp 被过滤；a/c 以 enabled/disabled 区分
  assert.ok(key.includes("a:enabled:"));
  assert.ok(!key.includes("b:"));
  assert.ok(key.includes("c:disabled:"));
  assert.ok(key.includes("|"));
});

test("buildMcpServerStatusListKey: config 序列化差异 → key 不同", () => {
  const x = makeServer({ id: "s", name: "s", config: { command: "a", args: [] } });
  const y = makeServer({ id: "s", name: "s", config: { command: "b", args: [] } });
  assert.notEqual(buildMcpServerStatusListKey([x]), buildMcpServerStatusListKey([y]));
});

test("buildPluginMcpServerStatusListKey: 空声明+空 runtime+空 host → 该 plugin 不进 key", () => {
  const p = makePlugin({
    declaredMcpServerNames: [],
    mcpServerNames: [],
    hostMcpServerNames: [],
  });
  const key = buildPluginMcpServerStatusListKey([p]);
  assert.equal(key, "");
});

test("buildPluginMcpServerStatusListKey: disabled 且无 host 名 → 不进 key", () => {
  const p = makePlugin({
    enabled: false,
    declaredMcpServerNames: ["x"],
    mcpServerNames: ["x"],
    hostMcpServerNames: [],
  });
  const key = buildPluginMcpServerStatusListKey([p]);
  assert.equal(key, "");
});

test("buildPluginMcpServerStatusListKey: enabled + 有声明 → 含 enabled + 排序后名称", () => {
  const p = makePlugin({
    enabled: true,
    declaredMcpServerNames: ["b", "a"],
    mcpServerNames: ["r2", "r1"],
    hostMcpServerNames: [],
  });
  const key = buildPluginMcpServerStatusListKey([p]);
  assert.ok(key.includes("com.acode.alpha:enabled:"));
  // 名称排序后拼接
  assert.ok(key.includes("a,b"));
  assert.ok(key.includes("r1,r2"));
});

test("buildPluginMcpServerStatusListKey: host 名非空 → 即使 disabled 也进 key 并附 host=", () => {
  const p = makePlugin({
    enabled: false,
    declaredMcpServerNames: ["x"],
    mcpServerNames: ["x"],
    hostMcpServerNames: ["h2", "h1"],
  });
  const key = buildPluginMcpServerStatusListKey([p]);
  assert.ok(key.includes(":disabled:"));
  assert.ok(key.includes("host=h1,h2"));
});

test("buildPluginMcpServerStatusListKey: 多 plugin 用 | 分隔", () => {
  const a = makePlugin({
    id: "a",
    declaredMcpServerNames: ["x"],
    mcpServerNames: ["x"],
  });
  const b = makePlugin({
    id: "b",
    declaredMcpServerNames: ["y"],
    mcpServerNames: ["y"],
  });
  const key = buildPluginMcpServerStatusListKey([a, b]);
  assert.ok(key.includes("a:enabled:"));
  assert.ok(key.includes("b:enabled:"));
  assert.ok(key.includes("|"));
});

// ── shouldShowPluginMcpServersInMcpSettings ──

test("shouldShowPluginMcpServersInMcpSettings: 远程同步上下文隐藏", () => {
  assert.equal(shouldShowPluginMcpServersInMcpSettings(true), false);
  assert.equal(shouldShowPluginMcpServersInMcpSettings(false), true);
});

// ── buildPendingMcpOAuthAuthorizationRefreshKey ──

test("buildPendingMcpOAuthAuthorizationRefreshKey: 本地 pending + runtime pending 并集去重", () => {
  const local = makeServer({
    id: "l1",
    name: "l1",
    authorization: {
      type: "oauth_authorization_code",
      authorizationUrl: "https://x",
      startedAt: "t1",
    },
  });
  const other = makeServer({ id: "l2", name: "l2" }); // 无 authorization → 不计
  const snapshots: Record<string, V4McpServerStatusSnapshot> = {
    rt1: makeSnapshot({
      authorization: {
        type: "oauth_authorization_code",
        authorizationUrl: "https://y",
        startedAt: "t2",
      },
    }),
    rt2: makeSnapshot(),
  };
  const key = buildPendingMcpOAuthAuthorizationRefreshKey([local, other], snapshots);
  assert.ok(key.includes("l1:t1"));
  assert.ok(key.includes("rt1:t2"));
  assert.ok(!key.includes("l2:"));
  assert.ok(!key.includes("rt2:"));
});

test("buildPendingMcpOAuthAuthorizationRefreshKey: 同名去重（本地 + runtime 同名）", () => {
  const local = makeServer({
    id: "s",
    name: "s",
    authorization: {
      type: "oauth_authorization_code",
      authorizationUrl: "https://x",
      startedAt: "t",
    },
  });
  const snapshots: Record<string, V4McpServerStatusSnapshot> = {
    s: makeSnapshot({
      authorization: {
        type: "oauth_authorization_code",
        authorizationUrl: "https://x",
        startedAt: "t",
      },
    }),
  };
  const key = buildPendingMcpOAuthAuthorizationRefreshKey([local], snapshots);
  // id 与 serverName 一致且 startedAt 一致 → 合并为一个条目
  assert.equal(key, "s:t");
});

test("buildPendingMcpOAuthAuthorizationRefreshKey: 全空 → 空串", () => {
  assert.equal(buildPendingMcpOAuthAuthorizationRefreshKey([], {}), "");
});

test("buildPendingMcpOAuthAuthorizationRefreshKey: 非 acodeagentmcp 源不计入", () => {
  const other = makeServer({
    id: "x",
    name: "x",
    source: "mcp",
    authorization: {
      type: "oauth_authorization_code",
      authorizationUrl: "https://x",
      startedAt: "t",
    },
  });
  assert.equal(buildPendingMcpOAuthAuthorizationRefreshKey([other], {}), "");
});

test("buildPendingMcpOAuthAuthorizationRefreshKey: 缺 startedAt 用空串占位", () => {
  const srv = makeServer({
    id: "s",
    name: "s",
    authorization: {
      type: "oauth_authorization_code",
      authorizationUrl: "https://x",
      startedAt: "",
    },
  });
  assert.equal(buildPendingMcpOAuthAuthorizationRefreshKey([srv], {}), "s:");
});
