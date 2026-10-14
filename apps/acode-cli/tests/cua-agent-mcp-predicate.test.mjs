/**
 * isPotentialACodeCuaAgentMcpServer 单测——角色 B 增量 4。
 *
 * 覆盖 module-boundary.md 不变量 2 补注「谓词须匹配的字段 1-4」：
 * - ① name === "computer-use"（ACODE_CUA_OFFICIAL_PLUGIN_ID 的用户露出名）；
 * - ② stdio command 命中 acode-cua 包规格（mcp.ts:228-252 单一事实源的包内复刻）；
 * - ③ stdio args 任一元素命中同规格；
 * - ④ env 为 Array<{name,value}>（非 Record），扫描 ACODE_PLUGIN_ID=官方 plugin id。
 * 边界样本：下划线归一（acode_cua）、@version、==version、[extras]、.git、点号子模块
 * （acode-cua.server）、路径前缀取叶子、尾部分隔符、负样本 acode-cua-proxy（短横续接
 * 不以 `.`/`@`/`[`/`==` 边界续接，不得误判）、http/sse 变体、畸形输入不抛。
 *
 * fail-closed 方向 = 宁可过判不漏判（漏判会让 node.ts:789 的 stale-generation 过滤失效，
 * Agent 可能回退成 Python 自持 TCC）。与 @acode/shared 单一事实源的一致性由 services 侧
 * 对照测试锁定（packages/services/test/cuaAgentMcpPredicateParity.test.ts，不变量 2 补注
 * 「防漂移方案」），本文件只测包内实现的行为边界。
 *
 * 落 apps/acode-cli/tests/（packages/acode-cua 无 test 脚本）；深路径 import broker-server.js，
 * 与 cua-broker-server-host.test.mjs 同法，不依赖 cwd。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isPotentialACodeCuaAgentMcpServer } from "../../../packages/acode-cua/broker-server.js";

// 中性底座：非 CUA 的 stdio server（name/command/args/env 四维都不命中）。
function stdio(overrides = {}) {
  return { name: "mcp", command: "node", args: ["server.js"], env: [], ...overrides };
}

// ─────────────────────────────────────────────────────────────────────────────
// 组 1：name 维度（字段 1）
// ─────────────────────────────────────────────────────────────────────────────

test("name：stdio 变体 name === 'computer-use' → true（command/args/env 全中性也命中）", () => {
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ name: "computer-use" })), true);
});

test("name：http/sse 变体同名也命中（字段 1 未限定变体，过判方向）", () => {
  assert.equal(
    isPotentialACodeCuaAgentMcpServer({
      name: "computer-use",
      type: "http",
      url: "https://mcp.example.com/cua",
      headers: [],
    }),
    true,
  );
  assert.equal(
    isPotentialACodeCuaAgentMcpServer({
      name: "computer-use",
      type: "sse",
      url: "https://mcp.example.com/cua",
      headers: [],
    }),
    true,
  );
});

test("name：大小写不同 / 前后缀续接 → false（严格字面量，同 mcp-config.ts:173）", () => {
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ name: "Computer-Use" })), false);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ name: "computer-use-x" })), false);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ name: "my-computer-use" })), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 2：command 维度（字段 2）——包规格边界
// ─────────────────────────────────────────────────────────────────────────────

test("command：裸包名与下划线归一（PyPI 视 _/- 等价）→ true", () => {
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "acode-cua" })), true);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "acode_cua" })), true);
});

test("command：@version / ==version / [extras] 边界 → true", () => {
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "acode-cua@1.2.3" })), true);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "acode-cua==1.2.3" })), true);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "acode-cua[gui]" })), true);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "acode_cua[gui]@1.2.3" })), true);
});

test("command：.git 与点号子模块（python -m acode_cua.server）→ true", () => {
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "acode-cua.git" })), true);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "acode-cua.server" })), true);
});

test("command：路径前缀取叶子（posix 与 win32 分隔符、尾部分隔符防空串叶子漏判）→ true", () => {
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "/opt/bin/acode-cua" })), true);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "D:\\tools\\acode-cua" })), true);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "/opt/bin/acode-cua/" })), true);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "D:\\tools\\acode-cua\\" })), true);
});

test("command：负样本——acode-cua-proxy 短横续接不命中（不以 ./@/[/== 边界续接）", () => {
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "acode-cua-proxy" })), false);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "/opt/bin/acode-cua-proxy" })), false);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "myacode-cua" })), false);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "npx" })), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 3：args 维度（字段 3）——任一元素命中即判定
// ─────────────────────────────────────────────────────────────────────────────

test("args：uvx/pip 常见形态（--from 包规格、-m 子模块、git url、本地路径）→ true", () => {
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "uvx", args: ["acode-cua"] })), true);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "uvx", args: ["acode_cua"] })), true);
  assert.equal(
    isPotentialACodeCuaAgentMcpServer(stdio({ command: "uvx", args: ["--from", "acode-cua@0.6.3", "acode-cua"] })),
    true,
  );
  assert.equal(
    isPotentialACodeCuaAgentMcpServer(stdio({ command: "python", args: ["-m", "acode_cua.server"] })),
    true,
  );
  assert.equal(
    isPotentialACodeCuaAgentMcpServer(
      stdio({ command: "uvx", args: ["--from", "git+https://git.example.com/acode/acode-cua.git@v1", "acode-cua"] }),
    ),
    true,
  );
  assert.equal(
    isPotentialACodeCuaAgentMcpServer(stdio({ command: "uvx", args: ["--from", "/home/u/acode-cua/", "acode-cua"] })),
    true,
  );
});

test("args：全元素不命中 / 空数组 → false；负样本 acode-cua-proxy 不误判", () => {
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "uvx", args: ["acode-cua-proxy"] })), false);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "uvx", args: [] })), false);
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ command: "uvx", args: ["some-mcp", "--verbose"] })), false);
});

test("args：非数组 / 含非字符串元素 → 不抛、不命中（入参按 unknown 对待）", () => {
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ args: "acode-cua" })), false, "args 是字符串非数组 → false");
  assert.doesNotThrow(() => isPotentialACodeCuaAgentMcpServer(stdio({ args: [null, 42, {}, "acode-cua"] })));
  assert.equal(
    isPotentialACodeCuaAgentMcpServer(stdio({ args: [null, 42, {}, "acode-cua"] })),
    true,
    "非字符串元素跳过后，字符串元素仍参与判定",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 4：env 维度（字段 4）——Array<{name,value}> 扫描 ACODE_PLUGIN_ID
// ─────────────────────────────────────────────────────────────────────────────

// 官方 plugin server 形态（mcp-config.ts:174-176）：command 是 Helper、args 走
// __acode-plugin-host，都不含 acode-cua 字样，只有 _plugin id env 可识别。
const pluginHostStdio = { command: "node", args: ["acode.cjs", "__acode-plugin-host", "server.js"] };

test("env：数组含 {ACODE_PLUGIN_ID: 官方 plugin id} → true（官方 plugin server 唯一识别面）", () => {
  assert.equal(
    isPotentialACodeCuaAgentMcpServer(
      stdio({
        ...pluginHostStdio,
        env: [
          { name: "SOME_OTHER", value: "x" },
          { name: "ACODE_PLUGIN_ID", value: "computer-use@acode-plugins-official" },
        ],
      }),
    ),
    true,
  );
});

test("env：value trim + 大小写归一后命中（对齐 mcp-config.ts:179 判别面）→ true", () => {
  assert.equal(
    isPotentialACodeCuaAgentMcpServer(
      stdio({
        ...pluginHostStdio,
        env: [{ name: "ACODE_PLUGIN_ID", value: "  Computer-Use@ACode-Plugins-Official  " }],
      }),
    ),
    true,
  );
});

test("env：plugin id 不匹配 / env key 不匹配 / 数组无命中项 → false", () => {
  assert.equal(
    isPotentialACodeCuaAgentMcpServer(stdio({ env: [{ name: "ACODE_PLUGIN_ID", value: "other@acode-plugins-official" }] })),
    false,
  );
  assert.equal(
    isPotentialACodeCuaAgentMcpServer(stdio({ env: [{ name: "PLUGIN_ID", value: "computer-use@acode-plugins-official" }] })),
    false,
  );
  assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ env: [] })), false);
});

test("env：Record 形状（非契约的畸形输入）→ 不抛、env 维度不命中", () => {
  assert.doesNotThrow(() =>
    isPotentialACodeCuaAgentMcpServer(stdio({ env: { ACODE_PLUGIN_ID: "computer-use@acode-plugins-official" } })),
  );
  assert.equal(
    isPotentialACodeCuaAgentMcpServer(stdio({ env: { ACODE_PLUGIN_ID: "computer-use@acode-plugins-official" } })),
    false,
  );
});

test("env：数组元素畸形（null/原始值/缺 value/value 非字符串）→ 不抛、不命中", () => {
  for (const env of [
    [null, 42, "ACODE_PLUGIN_ID"],
    [{ name: "ACODE_PLUGIN_ID" }],
    [{ name: "ACODE_PLUGIN_ID", value: 42 }],
    [{ value: "computer-use@acode-plugins-official" }],
  ]) {
    assert.doesNotThrow(() => isPotentialACodeCuaAgentMcpServer(stdio({ env })));
    assert.equal(isPotentialACodeCuaAgentMcpServer(stdio({ env })), false, `env=${JSON.stringify(env)} 应 false`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 组 5：http/sse 变体与畸形输入
// ─────────────────────────────────────────────────────────────────────────────

test("http/sse：非同名、无 command/args/env → false；headers 不参与 env 扫描", () => {
  assert.equal(
    isPotentialACodeCuaAgentMcpServer({ name: "ctx", type: "http", url: "https://mcp.example.com/ctx", headers: [] }),
    false,
  );
  assert.equal(
    isPotentialACodeCuaAgentMcpServer({
      name: "ctx",
      type: "sse",
      url: "https://mcp.example.com/ctx",
      // headers 不是 env（ACodeAgentMcpServer 联合形状，mcp.ts:184-197）：即使值同形也不命中。
      headers: [{ name: "ACODE_PLUGIN_ID", value: "computer-use@acode-plugins-official" }],
    }),
    false,
  );
});

test("畸形输入：null/undefined/原始值/数组/空对象/字段全畸形 → false 且不抛（fail-closed 不崩）", () => {
  const malformed = [
    null,
    undefined,
    42,
    "",
    "computer-use", // 原始值字符串即便同名也不是对象 → false
    [],
    {},
    { name: 123 },
    { name: "x", command: null, args: null, env: null },
    { name: "x", command: { toString: () => "acode-cua" }, args: {}, env: 0 },
  ];
  for (const bad of malformed) {
    assert.doesNotThrow(() => isPotentialACodeCuaAgentMcpServer(bad), `输入 ${String(bad)} 不得抛`);
    assert.equal(isPotentialACodeCuaAgentMcpServer(bad), false, `输入 ${String(bad)} 应 false`);
  }
});

test("综合：官方 plugin stdio 形态（四维仅 env 命中）→ true；stale 过滤语义可依赖", () => {
  // node.ts:789 用 !isPotentialACodeCuaAgentMcpServer 过滤：CUA candidate 必须全部命中，
  // 否则旧代际 socket/token 会交给晚到 Agent（漏判 = 安全违规，过判可容忍）。
  assert.equal(
    isPotentialACodeCuaAgentMcpServer({
      name: "plugin:computer-use:computer-use",
      ...pluginHostStdio,
      env: [{ name: "ACODE_PLUGIN_ID", value: "computer-use@acode-plugins-official" }],
    }),
    true,
  );
});
