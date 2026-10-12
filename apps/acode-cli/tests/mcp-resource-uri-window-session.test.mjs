// MCP 资源 uri 白名单窗口「不跨会话」回归（specs/mcp-sampling-resources.md 场景 5）。
// 根因：窗口曾是模块级、仅按 serverName 键控的全局 Map，一个 agent 进程内多个并发
// runtime（各持独立 pool lease/连接）注册同名 server 时会互相覆盖——A 刚列出的 uri
// 被 B 的 list 冲掉，导致 A 的合法 read 被误判 uri_not_listed；反向则 B 能 read 只有
// A 列过的 uri，越过 per-session 授权边界。修复：窗口 Map 在 registerMcpResourceTools
// 内部创建、随 runtime 存续，handler 只读写自己闭包内的 Map。
import assert from "node:assert/strict";
import { test } from "node:test";

const { registerMcpResourceTools } = await import(
  "../packages/core/src/mcp/resources.ts"
);

/** 收集注册的工具 entry，按 metadata.name 建索引，便于直接调 handler。 */
function makeRegistry() {
  const entries = new Map();
  return {
    register(entry) {
      entries.set(entry.metadata.name, entry);
    },
    get(name) {
      return entries.get(name);
    },
  };
}

/** 造一个只暴露资源面的最小 McpPort，list/read 各自返回预设 uri 集。 */
function makePort(uris) {
  return {
    listResources: async () =>
      uris.map((uri) => ({ uri, name: uri, mimeType: "text/plain" })),
    readResource: async (_name, uri) => ({ uri, mimeType: "text/plain", text: `body:${uri}` }),
  };
}

const SERVERS = { github: { command: "node", args: [], resources: true } };

test("两个 runtime 注册同名 server 时白名单窗口互不覆盖", async () => {
  // A、B 各是一个独立 runtime（独立 registry + 独立 port + 独立 registerMcpResourceTools 调用）。
  const regA = makeRegistry();
  const regB = makeRegistry();
  registerMcpResourceTools(regA, makePort(["a://1", "a://2"]), SERVERS);
  registerMcpResourceTools(regB, makePort(["b://1"]), SERVERS);

  const listA = regA.get("mcp__github__list_resources");
  const readA = regA.get("mcp__github__read_resource");
  const listB = regB.get("mcp__github__list_resources");
  const readB = regB.get("mcp__github__read_resource");
  assert.ok(listA && readA && listB && readB, "两个 runtime 都应注册 list/read 工具");

  // A 先 list（窗口写入 A 的 uri 集）。
  const listARes = await listA.handler({});
  assert.deepEqual(
    listARes.resources.map((r) => r.uri),
    ["a://1", "a://2"],
  );

  // B 随后 list（曾会整体覆盖全局窗口，把 A 的 uri 冲掉）。
  await listB.handler({});

  // A read 自己刚列出的 uri：修复后必须成功（不再被 B 的 list 顶掉）。
  const readARes = await readA.handler({ uri: "a://1" });
  assert.equal(readARes.error, undefined, `A 的合法 read 被误拒：${readARes.error ?? ""}`);
  assert.equal(readARes.text, "body:a://1");

  // B read 只有 A 列过的 uri：修复后必须被拒（跨 session 误放行）。
  const readBCross = await readB.handler({ uri: "a://1" });
  assert.equal(readBCross.error, "uri_not_listed", "B 不应能 read 只有 A 列过的 uri");

  // B read 自己列出的 uri：应成功。
  const readBOwn = await readB.handler({ uri: "b://1" });
  assert.equal(readBOwn.error, undefined, `B 的合法 read 被误拒：${readBOwn.error ?? ""}`);
  assert.equal(readBOwn.text, "body:b://1");
});

test("窗口过期后 read 被拒且要求重新 list", async () => {
  const reg = makeRegistry();
  registerMcpResourceTools(reg, makePort(["x://1"]), SERVERS);
  const list = reg.get("mcp__github__list_resources");
  const read = reg.get("mcp__github__read_resource");

  await list.handler({});
  // 手动把窗口过期时间调到过去（TTL 5 分钟）：模拟过期。
  const now = Date.now();
  const realNow = Date.now;
  try {
    // 通过 read 内部的 Date.now 触发过期分支：让 Date.now 跳到 6 分钟后。
    Date.now = () => now + 6 * 60 * 1000;
    const res = await read.handler({ uri: "x://1" });
    assert.equal(res.error, "uri_not_listed", "窗口过期后 read 应被拒");
  } finally {
    Date.now = realNow;
  }
});

test("port 未实现资源面时不注册工具（旧 adapter fail-safe）", () => {
  const reg = makeRegistry();
  const registered = registerMcpResourceTools(reg, {}, SERVERS);
  assert.deepEqual(registered, [], "旧 adapter 缺席资源面时不应注册任何工具");
  assert.equal(reg.get("mcp__github__list_resources"), undefined);
});
