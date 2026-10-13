/**
 * isPotentialACodeCuaAgentMcpServer 防漂移对照测试——角色 B 增量 4。
 *
 * module-boundary.md 不变量 2 补注「防漂移方案」：acode-cua `requires: []` 禁止 import
 * @acode/shared，故 `isPotentialACodeCuaAgentMcpServer` 在包内**复刻**了单一事实源
 * （`packages/shared/src/mcp.ts` 的 `isACodeCuaMcpCommand`/`isACodeCuaMcpPackageArg` 及其私有
 * `acodeCuaArgLeaf`/`matchesACodeCuaSpec`）。两处实现物理分离，本测试在 services 侧
 * （不受 `requires: []` 约束，可同时 import 两处）对**同一组样本**断言两者判定一致，
 * 把「两处漂移」变成测试可抓（不变量 2 补注 / 验收场景 4「防漂移验收」）。
 *
 * 样本覆盖 apps/acode-cli/tests/cua-agent-mcp-predicate.test.mjs 的全部边界：
 * name 维度、command/args 包规格（下划线归一、@version、==version、[extras]、.git、
 * 点号子模块、路径叶子、尾部分隔符、负样本 acode-cua-proxy）、env Array<{name,value}>
 * 扫描（命中/未命中/Record 畸形不抛）、http/sse 变体、畸形输入。
 *
 * 期望值除对照单一事实源外，另以 `expected` 字段钉死 spec 语义——防止两处同错时测试空洞通过。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isPotentialACodeCuaAgentMcpServer } from "@acode/acode-cua/broker/server";
import {
  ACODE_CUA_OFFICIAL_PLUGIN_ID,
  ACODE_PLUGIN_ID_ENV_KEY,
  isACodeCuaMcpCommand,
  isACodeCuaMcpPackageArg,
} from "@acode/shared";

// ─────────────────────────────────────────────────────────────────────────────
// 用 @acode/shared 单一事实源独立构造的期望判定
// ─────────────────────────────────────────────────────────────────────────────

// CUA server 用户露出名 = 官方 plugin id 的 `@` 前段（mcp.ts:10-13；node.ts:1073 /
// mcp-config.ts:173 以同字面量判别）。从常量派生而非手写字面量，锚定「单一事实源」。
const CUA_SERVER_NAME = ACODE_CUA_OFFICIAL_PLUGIN_ID.split("@")[0]!;

/**
 * 判别面对齐 mcp-config.ts:168-186 isACodeCuaStdioServer（module-boundary.md 不变量 2 补注
 * 「谓词须匹配的字段 1-4」），适配 ACodeAgentMcpServer（mcp.ts:166-197）的
 * `env: Array<{name,value}>` 形状；入参按 unknown 对待，任何畸形输入返回 false、不抛。
 */
function sharedSourceOfTruthSays(server: unknown): boolean {
  if (server === null || typeof server !== "object") return false;
  const s = server as { name?: unknown; command?: unknown; args?: unknown; env?: unknown };
  // ① name 维度（字段 1 未限定 stdio/http/sse 变体）。
  if (s.name === CUA_SERVER_NAME) return true;
  // ② stdio command 命中 acode-cua 包规格（字段 2，单一事实源 isACodeCuaMcpCommand）。
  if (typeof s.command === "string" && isACodeCuaMcpCommand(s.command)) return true;
  // ③ stdio args 任一元素命中同规格（字段 3，单一事实源 isACodeCuaMcpPackageArg）。
  if (
    Array.isArray(s.args) &&
    s.args.some((arg: unknown) => typeof arg === "string" && isACodeCuaMcpPackageArg(arg))
  ) {
    return true;
  }
  // ④ env 数组扫描 {ACODE_PLUGIN_ID: 官方 plugin id}（字段 4；官方 plugin server 的
  // command/args 不含 acode-cua 字样，只有 _plugin id env 可识别，mcp-config.ts:174-182）。
  // value 比对对齐 mcp-config.ts:179：trim().toLowerCase()。
  return (
    Array.isArray(s.env) &&
    s.env.some((entry: unknown) => {
      if (entry === null || typeof entry !== "object") return false;
      const e = entry as { name?: unknown; value?: unknown };
      return (
        e.name === ACODE_PLUGIN_ID_ENV_KEY &&
        typeof e.value === "string" &&
        e.value.trim().toLowerCase() === ACODE_CUA_OFFICIAL_PLUGIN_ID
      );
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 样本集（与 cua-agent-mcp-predicate.test.mjs 的边界一一对应）
// ─────────────────────────────────────────────────────────────────────────────

type Sample = { id: string; server: unknown; expected: boolean };

// 中性 stdio 底座：四维都不命中。
const stdio = (overrides: Record<string, unknown> = {}) => ({
  name: "mcp",
  command: "node",
  args: ["server.js"],
  env: [],
  ...overrides,
});

// 官方 plugin server 形态（mcp-config.ts:174-176）：command/args 不含 acode-cua 字样。
const pluginHostArgs = ["acode.cjs", "__acode-plugin-host", "server.js"];

const nameSamples: Sample[] = [
  { id: "name/stdio 同名命中", server: stdio({ name: "computer-use" }), expected: true },
  {
    id: "name/http 同名命中（字段 1 不限变体）",
    server: { name: "computer-use", type: "http", url: "https://mcp.example.com/cua", headers: [] },
    expected: true,
  },
  {
    id: "name/sse 同名命中",
    server: { name: "computer-use", type: "sse", url: "https://mcp.example.com/cua", headers: [] },
    expected: true,
  },
  { id: "name/大小写不同不命中", server: stdio({ name: "Computer-Use" }), expected: false },
  { id: "name/后缀续接不命中", server: stdio({ name: "computer-use-x" }), expected: false },
  { id: "name/前缀续接不命中", server: stdio({ name: "my-computer-use" }), expected: false },
];

const commandSamples: Sample[] = [
  { id: "cmd/裸包名", server: stdio({ command: "acode-cua" }), expected: true },
  { id: "cmd/下划线归一", server: stdio({ command: "acode_cua" }), expected: true },
  { id: "cmd/@version", server: stdio({ command: "acode-cua@1.2.3" }), expected: true },
  { id: "cmd/==version", server: stdio({ command: "acode-cua==1.2.3" }), expected: true },
  { id: "cmd/[extras]", server: stdio({ command: "acode-cua[gui]" }), expected: true },
  { id: "cmd/下划线+extras+@version", server: stdio({ command: "acode_cua[gui]@1.2.3" }), expected: true },
  { id: "cmd/.git", server: stdio({ command: "acode-cua.git" }), expected: true },
  { id: "cmd/点号子模块", server: stdio({ command: "acode-cua.server" }), expected: true },
  { id: "cmd/posix 路径取叶子", server: stdio({ command: "/opt/bin/acode-cua" }), expected: true },
  { id: "cmd/win32 路径取叶子", server: stdio({ command: "D:\\tools\\acode-cua" }), expected: true },
  { id: "cmd/尾部分隔符 posix", server: stdio({ command: "/opt/bin/acode-cua/" }), expected: true },
  { id: "cmd/尾部分隔符 win32", server: stdio({ command: "D:\\tools\\acode-cua\\" }), expected: true },
  { id: "cmd/负样本 proxy 短横续接", server: stdio({ command: "acode-cua-proxy" }), expected: false },
  { id: "cmd/负样本 路径叶子 proxy", server: stdio({ command: "/opt/bin/acode-cua-proxy" }), expected: false },
  { id: "cmd/负样本 前缀粘连", server: stdio({ command: "myacode-cua" }), expected: false },
  { id: "cmd/负样本 中性命令", server: stdio({ command: "npx" }), expected: false },
];

const argsSamples: Sample[] = [
  { id: "args/裸包名", server: stdio({ command: "uvx", args: ["acode-cua"] }), expected: true },
  { id: "args/下划线归一", server: stdio({ command: "uvx", args: ["acode_cua"] }), expected: true },
  {
    id: "args/--from @version",
    server: stdio({ command: "uvx", args: ["--from", "acode-cua@0.6.3", "acode-cua"] }),
    expected: true,
  },
  { id: "args/-m 点号子模块", server: stdio({ command: "python", args: ["-m", "acode_cua.server"] }), expected: true },
  {
    id: "args/--from git url（叶子 acode-cua.git@v1）",
    server: stdio({
      command: "uvx",
      args: ["--from", "git+https://git.example.com/acode/acode-cua.git@v1", "acode-cua"],
    }),
    expected: true,
  },
  {
    id: "args/--from 本地路径尾部分隔符",
    server: stdio({ command: "uvx", args: ["--from", "/home/u/acode-cua/", "acode-cua"] }),
    expected: true,
  },
  { id: "args/负样本 proxy", server: stdio({ command: "uvx", args: ["acode-cua-proxy"] }), expected: false },
  { id: "args/空数组", server: stdio({ command: "uvx", args: [] }), expected: false },
  { id: "args/中性元素", server: stdio({ command: "uvx", args: ["some-mcp", "--verbose"] }), expected: false },
  { id: "args/非数组畸形", server: stdio({ command: "uvx", args: "acode-cua" }), expected: false },
  {
    id: "args/含非字符串元素（跳过后字符串仍判定）",
    server: stdio({ command: "uvx", args: [null, 42, {}, "acode-cua"] }),
    expected: true,
  },
];

const envSamples: Sample[] = [
  {
    id: "env/官方 plugin id 命中",
    server: stdio({
      command: "node",
      args: pluginHostArgs,
      env: [
        { name: "SOME_OTHER", value: "x" },
        { name: "ACODE_PLUGIN_ID", value: "computer-use@acode-plugins-official" },
      ],
    }),
    expected: true,
  },
  {
    id: "env/value trim+大小写归一命中（对齐 mcp-config.ts:179）",
    server: stdio({
      command: "node",
      args: pluginHostArgs,
      env: [{ name: "ACODE_PLUGIN_ID", value: "  Computer-Use@ACode-Plugins-Official  " }],
    }),
    expected: true,
  },
  {
    id: "env/plugin id 值不匹配",
    server: stdio({ env: [{ name: "ACODE_PLUGIN_ID", value: "other@acode-plugins-official" }] }),
    expected: false,
  },
  {
    id: "env/env key 不匹配",
    server: stdio({ env: [{ name: "PLUGIN_ID", value: "computer-use@acode-plugins-official" }] }),
    expected: false,
  },
  { id: "env/空数组", server: stdio({ env: [] }), expected: false },
  {
    id: "env/Record 形状畸形不抛",
    server: stdio({ env: { ACODE_PLUGIN_ID: "computer-use@acode-plugins-official" } }),
    expected: false,
  },
  { id: "env/元素为原始值", server: stdio({ env: [null, 42, "ACODE_PLUGIN_ID"] }), expected: false },
  { id: "env/缺 value", server: stdio({ env: [{ name: "ACODE_PLUGIN_ID" }] }), expected: false },
  { id: "env/value 非字符串", server: stdio({ env: [{ name: "ACODE_PLUGIN_ID", value: 42 }] }), expected: false },
  { id: "env/缺 name", server: stdio({ env: [{ value: "computer-use@acode-plugins-official" }] }), expected: false },
];

const transportSamples: Sample[] = [
  {
    id: "http/中性 server",
    server: { name: "ctx", type: "http", url: "https://mcp.example.com/ctx", headers: [] },
    expected: false,
  },
  {
    id: "sse/headers 不当 env 扫描",
    server: {
      name: "ctx",
      type: "sse",
      url: "https://mcp.example.com/ctx",
      headers: [{ name: "ACODE_PLUGIN_ID", value: "computer-use@acode-plugins-official" }],
    },
    expected: false,
  },
];

const malformedSamples: Sample[] = [
  { id: "malformed/null", server: null, expected: false },
  { id: "malformed/undefined", server: undefined, expected: false },
  { id: "malformed/数字", server: 42, expected: false },
  { id: "malformed/空串", server: "", expected: false },
  { id: "malformed/原始值字符串同名", server: "computer-use", expected: false },
  { id: "malformed/数组", server: [], expected: false },
  { id: "malformed/空对象", server: {}, expected: false },
  { id: "malformed/name 非字符串", server: { name: 123 }, expected: false },
  { id: "malformed/字段全 null", server: { name: "x", command: null, args: null, env: null }, expected: false },
  { id: "malformed/字段类型错位", server: { name: "x", command: {}, args: {}, env: 0 }, expected: false },
];

// ─────────────────────────────────────────────────────────────────────────────
// 对照断言
// ─────────────────────────────────────────────────────────────────────────────

function assertParity(samples: Sample[]): void {
  for (const { id, server, expected } of samples) {
    // 两侧都不得抛（入参按 unknown 对待；node.ts:789 在 resolver 收尾路径调用，抛会炸会话创建）。
    assert.doesNotThrow(() => isPotentialACodeCuaAgentMcpServer(server), `${id}: acode-cua 谓词不得抛`);
    const actual = isPotentialACodeCuaAgentMcpServer(server);
    const shared = sharedSourceOfTruthSays(server);
    assert.equal(
      actual,
      shared,
      `${id}: acode-cua 包内复刻判定(${actual}) 必须与 @acode/shared 单一事实源(${shared}) 一致` +
        "（module-boundary.md 不变量 2 补注「防漂移方案」）",
    );
    assert.equal(actual, expected, `${id}: 判定应符合 spec 钉死的期望值（防两处同错时空洞通过）`);
  }
}

test("常量锚：单一事实源常量与判别字面量未漂移", () => {
  // 若上游常量演变（改名/改值），本测试先红，强制两处实现与样本集同步修订。
  assert.equal(CUA_SERVER_NAME, "computer-use");
  assert.equal(ACODE_PLUGIN_ID_ENV_KEY, "ACODE_PLUGIN_ID");
  assert.equal(ACODE_CUA_OFFICIAL_PLUGIN_ID, "computer-use@acode-plugins-official");
});

test("name 维度：与单一事实源判定一致", () => {
  assertParity(nameSamples);
});

test("command 包规格边界：与单一事实源 isACodeCuaMcpCommand 判定一致", () => {
  assertParity(commandSamples);
});

test("args 包规格边界：与单一事实源 isACodeCuaMcpPackageArg 判定一致", () => {
  assertParity(argsSamples);
});

test("env 数组扫描：与 ACODE_PLUGIN_ID_ENV_KEY/ACODE_CUA_OFFICIAL_PLUGIN_ID 判别一致", () => {
  assertParity(envSamples);
});

test("http/sse 变体：与单一事实源判定一致", () => {
  assertParity(transportSamples);
});

test("畸形输入：两侧一致返回 false 且不抛", () => {
  assertParity(malformedSamples);
});
