// CUA broker 凭据中继门的验收测试（specs/cua-broker-credential-relay.md）。
//
// 被钉住的缺陷（fix/cua-spawn-broker-credentials）：dev 链（ACODE_CUA_DEV_MODE=1）下宿主
// 权威（isCuaEnabledForContext，缺省 ON）已创建 Helper 并把 broker 凭据注入 agent spawn env，
// 但 CLI 中继门只认 computerUse feature（依赖设置页开关落盘的 enabledPlugins 记录，
// tier default_false 且缺省无记录）→ 凭据被扣在私有快照里，node_repl 子进程缺
// ACODE_CUA_PERMISSION_BROKER_SOCKET → agent.computerUse fail-closed。
//
// 断言链（对应 spec 验收场景 A1-A6）：
//   A1 dev 旗标 + 完整凭据 + feature 关 → 注入（本缺陷修复面）；
//   A2 无 dev 旗标 + 凭据 + feature 关 → 不注入（生产语义零变化，R2）；
//   A3 feature 开（设置页开关落盘路径）+ 凭据 → 注入（既有路径逐字保留）；
//   A4 dev 旗标 + 无凭据 → 不注入（门开也无料可写，R3）；
//   A5 dev 旗标 + 半组凭据 → 不注入（半组 fail-closed，R3）；
//   A6 isACodeCuaDevActivationRequested 谓词闭集；
//   A7 dev 旗标 + 凭据 + node_repl 未注册 → no-op 不崩溃（边界）。
//
// 仅用 mkdtemp 临时目录（workspace fixture + 临时用户配置），绝不触碰真实 ~/.acode。
// 凭据捕获是进程级私有快照：每条用例前后都必须 reset，避免跨用例串扰。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveAppRuntimeConfig } = await import(
  "../packages/bootstrap/src/app/runtime-config.ts"
);
const { createConfig } = await import(
  "../packages/adapters/src/config/config-factory.ts"
);
const {
  ACODE_CUA_BROKER_SOCKET_ENV_KEY,
  isACodeCuaDevActivationRequested,
  resetCapturedACodeCuaBrokerCredentialsForTest,
  sanitizeACodeRuntimeEnv,
} = await import("../../../packages/shared/src/runtimeEnv.ts");

const AUTHORITY_ENV_KEY = "ACODE_CUA_PLUGIN_AUTHORITY";
const NODE_REPL_HOST_ENV_KEY = "ACODE_CUA_NODE_REPL_HOST";
const PLUGIN_ID_ENV_KEY = "ACODE_PLUGIN_ID";
const CUA_PLUGIN_ID = "computer-use@acode-plugins-official";

/** Windows 命名管道形态的假 socket；拼接构造避免多层反斜杠转义踩坑（cua-bridge.test.mjs 先例）。 */
const FAKE_SOCKET = "\\" + "\\" + "." + "\\" + "pipe" + "\\" + "acode-cua-relay-test";
const FAKE_AUTHORITY = "relay-test-authority-0123456789abcdef";

/** 宿主内建 node_repl 的最小 stdio 形态（resolveBuiltInNodeReplMcpServers 产物同型）。 */
function makeBuiltInNodeRepl() {
  return {
    node_repl: {
      type: "stdio",
      command: process.execPath,
      args: ["node-repl-host-server.js"],
      env: {},
    },
  };
}

/** 临时 workspace + 空用户配置（隔离真实 ~/.acode；enabledPlugins 缺省 = 无启用记录）。 */
function makeFixture() {
  const homeDir = mkdtempSync(join(tmpdir(), "acode-cua-relay-home-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "acode-cua-relay-ws-"));
  const userConfigPath = join(homeDir, "user-config.json");
  writeFileSync(userConfigPath, JSON.stringify({}), "utf-8");
  const configResult = createConfig({
    env: {},
    userConfigPath,
    workingDirectory: workspaceDir,
  });
  return { homeDir, workspaceDir, configResult };
}

function cleanup(...dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

/**
 * 模拟 CLI 入口的凭据捕获：agent spawn env 携带宿主下发的凭据对，入口 sanitize 时
 * 捕获进进程私有快照并从子进程 env 剔除（runtimeEnv.ts:151-176 的 confused-deputy 防护）。
 */
function captureCredentials({ socket = FAKE_SOCKET, authority = FAKE_AUTHORITY } = {}) {
  sanitizeACodeRuntimeEnv({
    ...(socket ? { [ACODE_CUA_BROKER_SOCKET_ENV_KEY]: socket } : {}),
    ...(authority ? { [AUTHORITY_ENV_KEY]: authority } : {}),
  });
}

function resolveRuntime({ fixture, env, pluginRuntimeFeatures, builtInMcpServers }) {
  return resolveAppRuntimeConfig({
    cliStorageRoot: join(fixture.homeDir, "cli"),
    configResult: fixture.configResult,
    options: { env },
    ...(pluginRuntimeFeatures ? { pluginRuntimeFeatures } : {}),
    ...(builtInMcpServers ? { builtInMcpServers } : {}),
    subagentOutputRootDir: join(fixture.homeDir, "agents"),
    workingDirectory: fixture.workspaceDir,
  });
}

function nodeReplEnvOf(resolved) {
  const nodeRepl = resolved.runtimeConfig.mcp?.servers?.node_repl;
  assert.ok(nodeRepl, "node_repl 必须保留在自动连接集合里（中继门不做剔除）");
  return nodeRepl.env ?? {};
}

test("A1 dev 旗标 + 完整凭据 + feature 关 → node_repl 拿到 broker 凭据（本缺陷）", () => {
  const fixture = makeFixture();
  resetCapturedACodeCuaBrokerCredentialsForTest();
  try {
    captureCredentials();
    const resolved = resolveRuntime({
      fixture,
      env: { ACODE_CUA_DEV_MODE: "1" },
      builtInMcpServers: makeBuiltInNodeRepl(),
    });
    const env = nodeReplEnvOf(resolved);
    assert.equal(env[ACODE_CUA_BROKER_SOCKET_ENV_KEY], FAKE_SOCKET, "socket 必须中继进 node_repl env");
    assert.equal(env[AUTHORITY_ENV_KEY], FAKE_AUTHORITY, "authority 随快照一并中继（provenance 校验材料）");
    assert.equal(env[NODE_REPL_HOST_ENV_KEY], "1", "node_repl host marker 必须打上");
    assert.equal(env[PLUGIN_ID_ENV_KEY], CUA_PLUGIN_ID, "官方 plugin id 必须打上（__acode-plugin-host 恢复门）");
  } finally {
    resetCapturedACodeCuaBrokerCredentialsForTest();
    cleanup(fixture.homeDir, fixture.workspaceDir);
  }
});

test("A2 无 dev 旗标 + 凭据 + feature 关 → 不注入（生产语义零变化，R2）", () => {
  const fixture = makeFixture();
  resetCapturedACodeCuaBrokerCredentialsForTest();
  try {
    captureCredentials();
    const resolved = resolveRuntime({
      fixture,
      env: {},
      builtInMcpServers: makeBuiltInNodeRepl(),
    });
    const env = nodeReplEnvOf(resolved);
    assert.equal(env[ACODE_CUA_BROKER_SOCKET_ENV_KEY], undefined, "生产形态不得绕过设置页开关注入凭据");
    assert.equal(env[AUTHORITY_ENV_KEY], undefined);
    assert.equal(env[NODE_REPL_HOST_ENV_KEY], undefined);
  } finally {
    resetCapturedACodeCuaBrokerCredentialsForTest();
    cleanup(fixture.homeDir, fixture.workspaceDir);
  }
});

test("A3 feature 开（设置页开关落盘路径）+ 凭据 → 注入（既有路径逐字保留）", () => {
  const fixture = makeFixture();
  resetCapturedACodeCuaBrokerCredentialsForTest();
  try {
    captureCredentials();
    const resolved = resolveRuntime({
      fixture,
      env: {},
      pluginRuntimeFeatures: { computerUse: true },
      builtInMcpServers: makeBuiltInNodeRepl(),
    });
    const env = nodeReplEnvOf(resolved);
    assert.equal(env[ACODE_CUA_BROKER_SOCKET_ENV_KEY], FAKE_SOCKET);
    assert.equal(env[AUTHORITY_ENV_KEY], FAKE_AUTHORITY);
  } finally {
    resetCapturedACodeCuaBrokerCredentialsForTest();
    cleanup(fixture.homeDir, fixture.workspaceDir);
  }
});

test("A4 dev 旗标 + 无凭据 → 不注入（门开也无料可写，R3）", () => {
  const fixture = makeFixture();
  resetCapturedACodeCuaBrokerCredentialsForTest();
  try {
    const resolved = resolveRuntime({
      fixture,
      env: { ACODE_CUA_DEV_MODE: "1" },
      builtInMcpServers: makeBuiltInNodeRepl(),
    });
    const env = nodeReplEnvOf(resolved);
    assert.equal(env[ACODE_CUA_BROKER_SOCKET_ENV_KEY], undefined, "无凭据时绝不伪造注入");
    assert.equal(env[NODE_REPL_HOST_ENV_KEY], undefined);
  } finally {
    resetCapturedACodeCuaBrokerCredentialsForTest();
    cleanup(fixture.homeDir, fixture.workspaceDir);
  }
});

test("A5 dev 旗标 + 半组凭据（只有 socket）→ 不注入（半组 fail-closed，R3）", () => {
  const fixture = makeFixture();
  resetCapturedACodeCuaBrokerCredentialsForTest();
  try {
    // captureACodeCuaBrokerCredentials 对半组凭据清空快照（上游注入不完整/轮换中），
    // 且 CLI 入口 sanitize 已把该键从 env 剔除——env 兜底同样拿不到。
    // 注意传 null 而非 undefined：解构默认值对显式 undefined 也会生效，会误捕完整凭据组。
    captureCredentials({ authority: null });
    const resolved = resolveRuntime({
      fixture,
      env: { ACODE_CUA_DEV_MODE: "1" },
      builtInMcpServers: makeBuiltInNodeRepl(),
    });
    const env = nodeReplEnvOf(resolved);
    assert.equal(env[ACODE_CUA_BROKER_SOCKET_ENV_KEY], undefined, "半组凭据不得中继");
  } finally {
    resetCapturedACodeCuaBrokerCredentialsForTest();
    cleanup(fixture.homeDir, fixture.workspaceDir);
  }
});

test("A6 isACodeCuaDevActivationRequested 谓词闭集（缺省 false，只认显式 dev 旋钮）", () => {
  assert.equal(isACodeCuaDevActivationRequested({}), false, "缺省必须 false（与缺省 ON 的 internal feature 谓词不同）");
  assert.equal(isACodeCuaDevActivationRequested({ ACODE_CUA_DEV_MODE: "1" }), true);
  assert.equal(isACodeCuaDevActivationRequested({ ACODE_CUA_DEV_MODE: "true" }), true);
  assert.equal(isACodeCuaDevActivationRequested({ ACODE_CUA_DEV_MODE: "0" }), false);
  assert.equal(isACodeCuaDevActivationRequested({ ACODE_CUA_PRODUCT_HELPER: "1" }), true);
  assert.equal(isACodeCuaDevActivationRequested({ ACODE_CUA_PRODUCT_HELPER: "0" }), false);
  assert.equal(isACodeCuaDevActivationRequested({ ACODE_CUA_PRODUCT_HELPER: "off" }), false);
  assert.equal(isACodeCuaDevActivationRequested({ ACODE_CUA_PRODUCT_HELPER: "false" }), false);
  assert.equal(isACodeCuaDevActivationRequested({ ACODE_CUA_PRODUCT_HELPER: "  " }), false);
});

test("A7 dev 旗标 + 凭据 + node_repl 未注册 → no-op（边界）", () => {
  const fixture = makeFixture();
  resetCapturedACodeCuaBrokerCredentialsForTest();
  try {
    captureCredentials();
    const resolved = resolveRuntime({
      fixture,
      env: { ACODE_CUA_DEV_MODE: "1" },
    });
    assert.equal(resolved.runtimeConfig.mcp?.servers?.node_repl, undefined);
    assert.equal(resolved.runtimeConfig.mcp?.trustedOfficialCuaServerNames?.length ?? 0, 0, "注入资格集不得污染图片 authority 集（R4）");
  } finally {
    resetCapturedACodeCuaBrokerCredentialsForTest();
    cleanup(fixture.homeDir, fixture.workspaceDir);
  }
});
