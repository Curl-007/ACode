import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * MCP 快启门 + Deferred 工具缓存 + 配置硬化（specs/mcp-startup-gate-breaker.md
 * R1/R4）验收测试。
 *
 * 覆盖：
 * 1. 工具磁盘缓存纯单元（确定性时钟：读写往返 / 指纹不符 / TTL / 损坏 fail-open /
 *    schema 变更以新握手为准）；
 * 2. `${VAR:-default}` 深展开纯单元；
 * 3. 工具名碰撞确定性赢家纯单元；
 * 4. 快启门时序集成（注入假门钟：预算内就绪 / 超预算 Deferred / 后台完成原子替换 /
 *    无缓存不注册），stdio fixture 真实握手。
 */

const { createMcpToolCache, mcpToolCacheConfigFingerprint } = await import(
  "../packages/adapters/src/mcp/mcp-tool-cache.ts"
);
const { expandMcpEnvDeep } = await import("../packages/adapters/src/mcp/expand-env.ts");
const { deduplicateMcpToolDescriptors } = await import(
  "../packages/adapters/src/mcp/descriptor.ts"
);
const { createMcpAdapter, DEFAULT_MCP_STARTUP_GATE_BUDGET_MS } = await import(
  "../packages/adapters/src/mcp/index.ts"
);

// 与 descriptor.ts 的 sanitizeMcpName 同形（保留 [a-zA-Z0-9_-]，其余折 _，折叠 _+）。
const sanitizeMcpName = (name) => name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
const DESCRIPTOR = (serverName, toolName, description) => ({
  serverName,
  toolName,
  name: `mcp__${sanitizeMcpName(serverName)}__${sanitizeMcpName(toolName)}`,
  description,
  inputSchema: { type: "object", properties: {} },
});

// -----------------------------------------------
// 纯单元：工具磁盘缓存
// -----------------------------------------------

test("tool-cache: 读写往返；配置指纹一致才命中", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-tool-cache-"));
  try {
    const filePath = join(dir, "tool-cache.json");
    const cache = createMcpToolCache({ filePath });
    const config = { type: "http", url: "https://mcp.example.test/sse" };
    const tools = [DESCRIPTOR("example", "search", "cached")];
    await cache.set("example", config, tools);
    assert.deepEqual(await cache.get("example", config), tools, "同配置必须命中");
    assert.equal(
      await cache.get("example", { type: "http", url: "https://other.example.test/sse" }),
      null,
      "配置变了（指纹不符）不得命中——旧配置的工具清单不能冒充新 server",
    );
    // 指纹与键序无关：同一配置换键序仍命中。
    assert.deepEqual(
      await cache.get("example", { url: "https://mcp.example.test/sse", type: "http" }),
      tools,
      "键序不同但内容相同的配置必须命中（稳定序列化）",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool-cache: TTL 过期与文件损坏一律 fail-open（当作没有缓存）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-tool-cache-"));
  try {
    const filePath = join(dir, "tool-cache.json");
    const config = { type: "http", url: "https://mcp.example.test/sse" };
    const tools = [DESCRIPTOR("example", "search", "cached")];

    let now = 1_000_000;
    await createMcpToolCache({ filePath, now: () => now }).set("example", config, tools);
    now += 30 * 24 * 60 * 60 * 1000 + 1;
    assert.equal(
      await createMcpToolCache({ filePath, now: () => now }).get("example", config),
      null,
      "新鲜窗外视为没有缓存",
    );

    writeFileSync(filePath, "{broken json", "utf8");
    assert.equal(await createMcpToolCache({ filePath }).get("example", config), null, "损坏文件 fail-open");

    writeFileSync(filePath, JSON.stringify({ version: 999, servers: {} }), "utf8");
    assert.equal(await createMcpToolCache({ filePath }).get("example", config), null, "未来版本整份作废");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool-cache: schema 变更以新握手为准（覆写生效）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-tool-cache-"));
  try {
    const filePath = join(dir, "tool-cache.json");
    const cache = createMcpToolCache({ filePath });
    const config = { type: "http", url: "https://mcp.example.test/sse" };
    await cache.set("example", config, [DESCRIPTOR("example", "search", "v1")]);
    await cache.set("example", config, [DESCRIPTOR("example", "search", "v2")]);
    const cached = await cache.get("example", config);
    assert.equal(cached[0].description, "v2", "后一次握手覆写缓存");
    assert.equal(mcpToolCacheConfigFingerprint(config), mcpToolCacheConfigFingerprint(config));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -----------------------------------------------
// 纯单元：${VAR:-default} 深展开
// -----------------------------------------------

test("expand-env: ${VAR} 与 ${VAR:-default} 的 POSIX :− 语义", () => {
  const env = { SET: "value", EMPTY: "" };
  const expand = (text) => expandMcpEnvDeep(text, { env });
  assert.equal(expand("${SET}"), "value");
  assert.equal(expand("${SET:-fallback}"), "value", "已设置非空 → 值");
  assert.equal(expand("${EMPTY:-fallback}"), "fallback", "空值 → default（POSIX :−）");
  assert.equal(expand("${EMPTY}"), "", "无 default 的空值原样保留");
  assert.equal(expand("${UNSET}"), "${UNSET}", "未设置且无 default → 保持字面");
  assert.equal(expand("${UNSET:-C:\\tools}"), "C:\\tools", "未设置 → default");
  assert.equal(expand("a/${SET}/b"), "a/value/b", "嵌在文本中同样展开");
});

test("expand-env: 深递归与幂等；原型成员不可作为变量", () => {
  const env = { TOKEN: "t0k3n" };
  const input = {
    type: "stdio",
    command: "${TOKEN}",
    args: ["--x=${TOKEN:-d}", "literal"],
    env: { NESTED: "${TOKEN}", KEEP: "${UNSET:-keep}" },
    nested: { deeper: ["${TOKEN}"] },
    count: 3,
    flag: true,
  };
  const expanded = expandMcpEnvDeep(input, { env });
  assert.deepEqual(expanded, {
    type: "stdio",
    command: "t0k3n",
    args: ["--x=t0k3n", "literal"],
    env: { NESTED: "t0k3n", KEEP: "keep" },
    nested: { deeper: ["t0k3n"] },
    count: 3,
    flag: true,
  });
  // 幂等：已展开配置再展开不变（重连路径传入已展开配置的保证）。
  assert.deepEqual(expandMcpEnvDeep(expanded, { env }), expanded);
  // 原型成员不可替换（只认 own property）。
  assert.equal(expandMcpEnvDeep("${toString}", { env }), "${toString}");
  // 键名不动。
  const keyed = expandMcpEnvDeep({ "${TOKEN}": "${TOKEN}" }, { env });
  assert.equal(keyed["${TOKEN}"], "t0k3n");
});

// -----------------------------------------------
// 纯单元：工具名碰撞确定性赢家
// -----------------------------------------------

test("dedupe: sanitizer 撞名时赢家与数组顺序无关（原始身份键字典序）", () => {
  // ACode 的 sanitizer 保留 -、把其余折为 _ 并折叠 _+：(a.b, c) 与 (a__b, c)
  // 都 mint 成 mcp__a_b__c——不同来源撞同一模型面名。
  const first = { ...DESCRIPTOR("a.b", "c", "one") };
  const second = { ...DESCRIPTOR("a__b", "c", "two") };

  const run1 = deduplicateMcpToolDescriptors([first, second]);
  const run2 = deduplicateMcpToolDescriptors([second, first]);
  assert.equal(run1.tools.length, 1);
  assert.equal(run2.tools.length, 1);
  // 原始身份键 "a.b\0c" < "a__b\0c"（'.' 0x2e < '_' 0x5f）→ (a.b, c) 恒为赢家。
  assert.equal(run1.tools[0].description, "one");
  assert.equal(run2.tools[0].description, "one");
  assert.equal(run1.collisions.length, 1);
  assert.deepEqual(run1.collisions[0].kept, { serverName: "a.b", toolName: "c" });
  assert.deepEqual(run1.collisions[0].dropped, { serverName: "a__b", toolName: "c" });

  // 同源重复静默去重，不算碰撞。
  const dup = deduplicateMcpToolDescriptors([first, { ...first }]);
  assert.equal(dup.tools.length, 1);
  assert.equal(dup.collisions.length, 0);

  // 无撞名时全部保留。
  const distinct = deduplicateMcpToolDescriptors([first, DESCRIPTOR("other", "tool", "x")]);
  assert.equal(distinct.tools.length, 2);
  assert.equal(distinct.collisions.length, 0);
});

// -----------------------------------------------
// adapter 集成：快启门时序（注入假门钟 + 真实 stdio fixture）
// -----------------------------------------------

// 最小 stdio MCP server：等 FLAG 文件出现才回答 initialize（门时序的夹具抓手）。
// Deferred 阶段可见的是缓存里被人为改旧的 schema（测试在两次会话之间改写缓存），
// 后台完成后 server 返回真实 schema——以可观测的差异证明「原子替换」确实发生。
const GATED_SERVER_SOURCE = `
const fs = require("node:fs");
const flagFile = process.env.FAKE_FLAG;
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function waitForFlag() {
  for (let i = 0; i < 2000; i++) {
    if (fs.existsSync(flagFile)) return;
    const dead = Date.now() + 10;
    while (Date.now() < dead) {}
  }
}
function handle(msg) {
  if (msg.method === "initialize") {
    waitForFlag();
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "gated-mcp", version: "0.0.1" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "live-echo",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.resume();
`;

async function waitUntil(predicate, timeoutMs = 20_000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

async function withGatedFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "acode-mcp-startup-gate-"));
  try {
    const serverPath = join(dir, "gated-server.cjs");
    writeFileSync(serverPath, GATED_SERVER_SOURCE, "utf8");
    const flagFile = join(dir, "go.flag");
    const cachePath = join(dir, "tool-cache.json");
    const config = () => ({
      type: "stdio",
      command: process.execPath,
      args: [serverPath],
      protocolVersion: "legacy",
      timeoutMs: 15_000,
      env: { FAKE_FLAG: flagFile },
    });
    // 两次会话之间把缓存里的 schema 人为改旧：Deferred 面显示旧值，后台完成显示
    // server 当前值——配置（与指纹）不变的前提下证明原子替换。
    const patchCachedDescription = (description) => {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
      for (const entry of Object.values(parsed.servers)) {
        for (const tool of entry.tools) {
          tool.description = description;
        }
      }
      writeFileSync(cachePath, JSON.stringify(parsed), "utf8");
    };
    return await fn({ config, flagFile, cachePath, dir, patchCachedDescription });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("gate: 预算内就绪走真实工具，不产生 Deferred", async (t) => {
  await withGatedFixture(async ({ config, flagFile, cachePath }) => {
    writeFileSync(flagFile, "1", "utf8");
    const adapter = createMcpAdapter({
      startupGate: { budgetMs: 250, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
      toolCache: createMcpToolCache({ filePath: cachePath }),
    });
    t.after(() => adapter.close());
    const snapshot = await adapter.connectConfiguredServers({ gated: config() }, {});
    assert.equal(snapshot.statuses.gated.status, "connected");
    assert.equal(snapshot.tools.length, 1);
    assert.equal(snapshot.tools[0].description, "live-echo");
  });
});

test("gate: 超预算 Deferred 用缓存注册，后台完成后原子替换为真实工具", async (t) => {
  await withGatedFixture(async ({ config, flagFile, cachePath, patchCachedDescription }) => {
    // 第一会话：放行握手（flag 预置），连接成功并把工具清单写入磁盘缓存。
    writeFileSync(flagFile, "1", "utf8");
    const first = createMcpAdapter({
      toolCache: createMcpToolCache({ filePath: cachePath }),
    });
    t.after(() => first.close());
    await first.connectConfiguredServers({ gated: config() }, {});
    assert.ok(
      await waitUntil(() => existsSync(cachePath)),
      "tools/list 成功后缓存必须落盘",
    );
    patchCachedDescription("stale-cache");

    // 第二会话：收起 flag → 握手被夹住；注入假门钟，门到期即触发 Deferred 物化。
    rmSync(flagFile, { force: true });
    let releaseGate;
    const gatePromise = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const changes = [];
    const second = createMcpAdapter({
      startupGate: { budgetMs: DEFAULT_MCP_STARTUP_GATE_BUDGET_MS, sleep: () => gatePromise },
      toolCache: createMcpToolCache({ filePath: cachePath }),
      onStatusChange: (change) => changes.push(change),
    });
    t.after(() => second.close());
    // 工具面变更订阅（McpPort.onToolsChanged，R1 收尾接线）：后台原子替换必须触发。
    let toolsChangedHits = 0;
    const unsubscribeToolsChanged = second.onToolsChanged(() => {
      toolsChangedHits += 1;
    });
    t.after(unsubscribeToolsChanged);

    const snapshotPromise = second.connectConfiguredServers({ gated: config() }, {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseGate();
    const snapshot = await snapshotPromise;

    // Deferred 面：status 仍 connecting，但缓存 descriptor 已在工具清单里可见。
    assert.equal(snapshot.statuses.gated.status, "connecting");
    assert.equal(snapshot.tools.length, 1, "Deferred：缓存 schema 先行可见");
    assert.equal(snapshot.tools[0].description, "stale-cache", "此刻可见的是缓存里的旧 schema");
    assert.equal(snapshot.tools[0].toolName, "echo");

    // 后台完成：放行握手 → 真实工具原子替换 + connected 状态事件。
    writeFileSync(flagFile, "1", "utf8");
    assert.ok(
      await waitUntil(async () => {
        const statuses = await second.status();
        return statuses.gated?.status === "connected";
      }),
      "后台握手完成后必须进入 connected",
    );
    const tools = await second.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].description, "live-echo", "真实工具替换缓存 descriptor");
    assert.ok(changes.some((change) => change.trigger === "connected"), "派发 connected 事件");
    assert.ok(toolsChangedHits >= 1, "后台原子替换必须触发 onToolsChanged（rebind 信号）");
  });
});

test("gate: 超预算且无缓存 → 启动不注册工具，后台完成后补注册", async (t) => {
  await withGatedFixture(async ({ config, flagFile, cachePath }) => {
    rmSync(flagFile, { force: true });
    let releaseGate;
    const gatePromise = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const adapter = createMcpAdapter({
      startupGate: { budgetMs: 250, sleep: () => gatePromise },
      toolCache: createMcpToolCache({ filePath: cachePath }),
    });
    t.after(() => adapter.close());

    const snapshotPromise = adapter.connectConfiguredServers({ gated: config() }, {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseGate();
    const snapshot = await snapshotPromise;
    assert.equal(snapshot.statuses.gated.status, "connecting");
    assert.equal(snapshot.tools.length, 0, "无缓存 → 不注册任何工具（不阻塞启动）");

    writeFileSync(flagFile, "1", "utf8");
    assert.ok(
      await waitUntil(async () => (await adapter.listTools()).length === 1),
      "后台完成后工具补注册",
    );
  });
});
