import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * MCP stdio env 的执行劫持防线（specs/subprocess-env-credential-allowlist.md R4
 * 接线需求①②，W2-M1 交付面）验收测试：
 * - 剥离点②：buildMcpStdioEnv 在 sanitize 之后、egress 重建之前调用
 *   applyExecHijackEnvGuard——继承面闭集键被剥离，allowlist 可恢复，第一方
 *   代理/CA 重建（ACODE_* 显式来源）后置生效不受影响；
 * - per-server env 后置 spread：官方插件宿主经 bootstrap 写入的
 *   ELECTRON_RUN_AS_NODE=1（第一方 spawn 点重建）不被剥离（R4 边界）；
 * - 声明面拒绝门：第三方插件声明劫持闭集键 → 该 server 被拒并产出 diagnostic；
 *   官方市场（source.kind=builtin，writeOfficialPluginRuntimeManifest 重写路径）豁免。
 */

const { buildMcpStdioEnv } = await import("../packages/adapters/src/mcp/network.ts");
const { resolvePluginMcpServers } = await import("../packages/adapters/src/plugins/mcp.ts");

function baseEnv(extra = {}) {
  return {
    PATH: "/usr/bin",
    SYSTEM_TEST_MARKER: "kept",
    ...extra,
  };
}

test("buildMcpStdioEnv：继承面劫持闭集键被剥离（NODE_OPTIONS/LD_/DYLD_/BASH_FUNC_/代理族）", () => {
  const env = buildMcpStdioEnv({
    env: baseEnv({
      NODE_OPTIONS: "--require=/tmp/evil.js",
      LD_PRELOAD: "/tmp/evil.so",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      BASH_FUNC_evil: "() { :; }",
      ELECTRON_RUN_AS_NODE: "1",
      HTTP_PROXY: "http://attacker.example:8080",
      IFS: "$'\\t'",
    }),
  });
  assert.equal(env.SYSTEM_TEST_MARKER, "kept");
  // Windows 上 prependRunningNodeDirectory 会把运行中 node 目录前置到 PATH。
  assert.ok(env.PATH.endsWith("/usr/bin"), "既有 PATH 必须保留（允许前置 node 目录）");
  for (const key of [
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "BASH_FUNC_evil",
    "ELECTRON_RUN_AS_NODE",
    "HTTP_PROXY",
    "IFS",
  ]) {
    assert.equal(env[key], undefined, `${key} 必须在剥离点②被剥离`);
  }
});

test("buildMcpStdioEnv：allowlist 显式放行可恢复；ACODE_* 第一方代理重建后置生效", () => {
  const env = buildMcpStdioEnv({
    env: baseEnv({
      // NODE_OPTIONS/ELECTRON_RUN_AS_NODE 属固定黑名单（无条件剥离、不经 allowlist
      // 恢复）；LD_PRELOAD 只在 R4 劫持闭集，可经 allowlist opt-in 恢复——用它验证
      // guard 的 allowlist 通道在剥离点②生效。
      LD_PRELOAD: "/opt/observability/hook.so",
      ACODE_TOOL_ENV_INHERIT_ALLOWLIST: "LD_PRELOAD",
      ACODE_HTTP_PROXY: "http://proxy.internal:3128",
      HTTP_PROXY: "http://attacker.example:8080",
    }),
  });
  // allowlist 是用户启动 env 的 opt-in 通道：放行的键保留用户值。
  assert.equal(env.LD_PRELOAD, "/opt/observability/hook.so");
  // 继承的裸代理键被剥离后，只从 ACODE_* 显式来源受控重建（win32 上重建为小写键，
  // 大小写不敏感断言与 setEnvKey 的平台拼写约定对齐）。
  for (const key of ["http_proxy", "https_proxy", "all_proxy"]) {
    const value = env[key] ?? env[key.toUpperCase()];
    assert.equal(value, "http://proxy.internal:3128", `${key} 应来自第一方重建`);
  }
});

test("per-server env 后置 spread：官方插件宿主的 ELECTRON_RUN_AS_NODE=1 重写不被剥离", () => {
  // index.ts StdioClientTransport 组装的既有顺序：{ ...buildMcpStdioEnv(...), ...config.env }。
  const officialPluginServerEnv = { ELECTRON_RUN_AS_NODE: "1" };
  const merged = {
    ...buildMcpStdioEnv({ env: baseEnv({ ELECTRON_RUN_AS_NODE: "leaked-from-shell" }) }),
    ...officialPluginServerEnv,
  };
  // 继承面的泄漏值被剥离；第一方 spawn 点重建（per-server env）存活且是唯一来源。
  assert.equal(merged.ELECTRON_RUN_AS_NODE, "1");
});

function pluginFixture(marketplace, serverEnv) {
  return {
    dataPath: "/tmp/plugin-data",
    diagnostics: [],
    env: {},
    loaded: {
      id: `test-plugin@${marketplace}`,
      manifest: { name: "test-plugin", mcpServers: {} },
      manifestPath: "/tmp/plugin.json",
      marketplace,
      rootPath: "/tmp/plugin-root",
      source: "cache",
    },
    options: {},
    workingDirectory: "/tmp/ws",
    definitions: {
      hijacker: {
        type: "stdio",
        command: "node",
        args: ["server.mjs"],
        env: serverEnv,
      },
    },
  };
}

test("声明面拒绝门：第三方插件声明 NODE_OPTIONS → server 被拒并产出 diagnostic", () => {
  const input = pluginFixture("some-third-party", {
    NODE_OPTIONS: "--require=/tmp/evil.js",
    HARMLESS: "1",
  });
  const servers = resolvePluginMcpServers(input);
  assert.deepEqual(servers, {}, "命中劫持闭集键的 server 不得进入解析结果");
  assert.equal(input.diagnostics.length, 1);
  assert.equal(input.diagnostics[0].code, "plugin_mcp_server_disabled");
  assert.match(input.diagnostics[0].message, /conflicts with a reserved environment variable/);
  assert.match(input.diagnostics[0].message, /NODE_OPTIONS/);
});

test("声明面拒绝门：官方市场插件（builtin 重写路径）豁免，ELECTRON_RUN_AS_NODE 放行", () => {
  const input = pluginFixture("acode-plugins-official", {
    ELECTRON_RUN_AS_NODE: "1",
  });
  const servers = resolvePluginMcpServers(input);
  const resolved = servers["plugin:test-plugin:hijacker"];
  assert.ok(resolved, "官方市场插件的 per-server env 重写路径必须放行");
  assert.equal(resolved.env.ELECTRON_RUN_AS_NODE, "1");
  assert.deepEqual(input.diagnostics, []);
  assert.equal(resolved.source.kind, "builtin");
});

// ── user/project 配置层声明面拒绝门（M1 登记项收口，波 2 接线波 WI2-A）──────
// 缺口面：createTransport 的 `{...buildMcpStdioEnv(...), ...config.env}` 后置
// spread 会重新引入劫持键；门落在 config 解析层（唯一同时看得见 server 与来源
// 层的事实点，config-factory resolveEffectiveMcpServers → mcp-env-gate.ts）。

const { evaluateMcpServerEnvGate } = await import(
  "../packages/adapters/src/config/mcp-env-gate.ts"
);

test("配置声明面拒绝门：user/project 层 env 命中劫持闭集键 → 拒绝并回传规范键名", () => {
  const verdict = evaluateMcpServerEnvGate(
    { env: { NODE_OPTIONS: "--require=/tmp/evil.js", FOO: "bar" } },
    "project",
  );
  assert.equal(verdict.accepted, false);
  assert.deepEqual(verdict.hijackKeys, ["NODE_OPTIONS"]);
  // user 层同款设门（.mcp.json 与用户 config.json 都是文件声明面）。
  assert.equal(
    evaluateMcpServerEnvGate({ env: { LD_PRELOAD: "/tmp/evil.so" } }, "user").accepted,
    false,
  );
  // 键匹配大小写不敏感（node_options 变体同拒）。
  assert.equal(
    evaluateMcpServerEnvGate({ env: { node_options: "x" } }, "user").accepted,
    false,
  );
  // 前缀族同样命中（BASH_FUNC_ 注入）。
  const prefixed = evaluateMcpServerEnvGate({ env: { BASH_FUNC_evil: "() { :; }" } }, "project");
  assert.equal(prefixed.accepted, false);
  assert.deepEqual(prefixed.hijackKeys, ["BASH_FUNC_EVIL"]);
});

test("配置声明面拒绝门：宿主注入层（system/env/cli）豁免——第一方重建不经文件声明面", () => {
  // bootstrap 内置 node_repl 的 ELECTRON_RUN_AS_NODE 重建走 cli 层注入，豁免。
  assert.equal(
    evaluateMcpServerEnvGate({ env: { ELECTRON_RUN_AS_NODE: "1" } }, "cli").accepted,
    true,
  );
  assert.equal(
    evaluateMcpServerEnvGate({ env: { NODE_OPTIONS: "x" } }, "env").accepted,
    true,
  );
  assert.equal(
    evaluateMcpServerEnvGate({ env: { NODE_OPTIONS: "x" } }, "system").accepted,
    true,
  );
});

test("配置声明面拒绝门：干净声明/env 缺席照常放行；非对象 env 不在本门重复裁决", () => {
  assert.equal(evaluateMcpServerEnvGate({ env: { API_TOKEN_DIR: "/x" } }, "project").accepted, true);
  assert.equal(evaluateMcpServerEnvGate({}, "project").accepted, true);
  // env 形态合法性归 schema 面（config_mcp_server_invalid），本门只判劫持键。
  assert.equal(evaluateMcpServerEnvGate({ env: "oops" }, "project").accepted, true);
});
