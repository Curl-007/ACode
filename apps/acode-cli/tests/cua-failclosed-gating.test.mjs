/**
 * acode-cua fail-closed 门控测试（R2-09）。
 *
 * 修复依据：review 发现 `package.json` / `README.md` 宣称「every runtime surface reports
 * unavailable and fails closed」与实现不符——客户端 wire 面（broker.js socket 客户端 +
 * index.js createComputerUseRuntime）是**功能完整**实现，仅在缺 brokerSocketPath 时才 fail-closed；
 * 生产端的关闭实际靠上游门控。本文件把「fail-closed 到底由什么保证」固化为可执行断言，
 * 覆盖 finding 1c 要求的两条：
 *   ① 无 brokerSocketPath 时 execute() 返回 isError（unavailable），不抛、不假成功。
 *   ② dev env 存在但插件/内部特性未启用时，上游门控判定不创建 Helper（即不注入 live broker
 *      socket env）——用「假 env + 导入上游判定函数」验证，不修改 packages/services/src/node.ts。
 *
 * ② 的判定链（对应 node.ts:1721-1731 的 isCuaEnabledForContext 闭包，该闭包不导出，故本测试
 * 复用其两个可导入的组成谓词 + 一个 admission 谓词逐段验证，注释标明镜像来源）：
 *   cuaPluginEnabled = isACodeCuaInternalFeatureEnabled(process.env)          // @acode/shared runtimeEnv
 *                    || isOfficialCuaPluginEnabledForWorkspace({...})         // 本包 broker-server stub（恒 false）
 *   → 传入 shouldCreateDefaultCuaProductHelper({ hasBuiltInCuaPlugin: cuaPluginEnabled, ... })
 *     决定是否 acquire 一个托管 Helper（node.ts:1752 getOrCreateDefaultCuaProductHelper）。
 *     admission 为 false ⇒ 无 Helper ⇒ win32 无 live broker socket 可注入 ⇒ 客户端面 fail-closed。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createComputerUseRuntime } from "../../../packages/acode-cua/index.js";
import { mintBrokerSocketPath } from "../../../packages/acode-cua/broker.js";
import { isOfficialCuaPluginEnabledForWorkspace } from "../../../packages/acode-cua/broker-server.js";

/** 取单文本块结果的解析 JSON（模拟 SDK unwrapEnvelope 的读取方式）。 */
function parsedText(result) {
  assert.ok(Array.isArray(result?.content), "结果必须有 content 数组（CallToolResult 形态）");
  const textBlocks = result.content.filter((b) => b?.type === "text" && typeof b.text === "string");
  assert.equal(textBlocks.length, 1, "本测试路径都应是单文本块");
  return JSON.parse(textBlocks[0].text);
}

const CTX = { sessionId: "s1", runtimeScope: "main", workspaceKey: "wk" };

// ─────────────────────────────────────────────────────────────────────────────
// ① 客户端 wire 面的 fail-closed：无 brokerSocketPath → isError（unavailable）
// ─────────────────────────────────────────────────────────────────────────────

test("① execute：未配置 brokerSocketPath → isError 结果（不抛、不假成功）", async () => {
  const rt = createComputerUseRuntime({});
  const result = await rt.execute({ toolName: "left_click", arguments: { x: 1, y: 2 }, context: CTX });
  assert.equal(result.isError, true, "无 socketPath 必须 fail-closed 为 isError");
  const payload = parsedText(result);
  assert.equal(payload.code, "internal", "SDK 会归 INTERNAL——与占位的可观测映射一致");
  assert.match(payload.error.message, /not available in this build/u, "保留不可用文案");
});

test("① execute：变更类动作（type/key）在无 socketPath 时同样 fail-closed，绝不发起连接", async () => {
  const rt = createComputerUseRuntime({});
  for (const toolName of ["type", "key", "left_click_drag", "paste"]) {
    const result = await rt.execute({ toolName, arguments: { text: "x" }, context: CTX });
    assert.equal(result.isError, true, `${toolName} 无 socketPath 必须 isError（不得下发变更动作）`);
    assert.match(parsedText(result).error.message, /not available in this build/u);
  }
});

test("① execute：非法 brokerSocketPath（非字符串）视同未配置 → 走 unavailable", async () => {
  const rt = createComputerUseRuntime({ brokerSocketPath: 123 });
  const result = await rt.execute({ toolName: "list_apps", context: CTX });
  assert.equal(result.isError, true, "非法 socketPath 不得被当作 live 端点");
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 上游门控：插件/内部特性未启用 → 不创建 Helper（不注入 live broker socket env）
//    只用可导入的纯谓词 + 假 env，不修改 packages/services/src/node.ts。
// ─────────────────────────────────────────────────────────────────────────────

test("② 内部特性谓词：ACODE_CUA_PRODUCT_HELPER=0/false/off 显式关闭；缺省 ON", async () => {
  const { isACodeCuaInternalFeatureEnabled } = await import(
    "../../../packages/shared/src/runtimeEnv.ts"
  );
  // 订正 review 的过期表述：isACodeCuaInternalFeatureEnabled **默认 ON**（runtimeEnv.ts:44-48、
  // node.ts:700「2026-08 注释更正——旧注释称默认关闭已过期」）。故 dev env 不是「打开」活路径的
  // 唯一开关，显式 PRODUCT_HELPER=0 才是「关闭」。测试如实固化两侧行为。
  assert.equal(isACodeCuaInternalFeatureEnabled({}), true, "缺省 ON");
  assert.equal(isACodeCuaInternalFeatureEnabled({ ACODE_CUA_DEV_MODE: "1" }), true, "dev 旋钮 ON");
  assert.equal(isACodeCuaInternalFeatureEnabled({ ACODE_CUA_PRODUCT_HELPER: "0" }), false, "显式关闭");
  assert.equal(isACodeCuaInternalFeatureEnabled({ ACODE_CUA_PRODUCT_HELPER: "off" }), false);
  assert.equal(isACodeCuaInternalFeatureEnabled({ ACODE_CUA_PRODUCT_HELPER: "false" }), false);
});

test("② 官方插件 enablement 谓词：本包 stub 恒 false（插件未打包/未启用）", () => {
  // broker-server.js:132 的占位——生产链阶段 5 打包未落地，官方插件 workspace enablement 恒 false。
  assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: {}, workingDirectory: undefined }), false);
  assert.equal(isOfficialCuaPluginEnabledForWorkspace({ env: { ACODE_CUA_DEV_MODE: "1" } }), false);
});

test("② cuaPluginEnabled 镜像：关闭门控需 PRODUCT_HELPER=0 且无 DEV_MODE（DEV_MODE 优先级更高）", async () => {
  const { isACodeCuaInternalFeatureEnabled } = await import(
    "../../../packages/shared/src/runtimeEnv.ts"
  );
  // 镜像 node.ts:1726 的 isCuaEnabledForContext 表达式（该闭包不导出，故按同一 OR 组合复算）。
  const cuaPluginEnabled = (env) =>
    isACodeCuaInternalFeatureEnabled(env) || isOfficialCuaPluginEnabledForWorkspace({ env });
  // 关键优先级：runtimeEnv.ts:44 先判 isCuaDevModeRequested → DEV_MODE=1 **短路返回 true**，
  // 早于 PRODUCT_HELPER=0 的关闭分支。故想真正关闭门控必须「PRODUCT_HELPER=0 且不设 DEV_MODE」。
  assert.equal(cuaPluginEnabled({ ACODE_CUA_PRODUCT_HELPER: "0" }), false, "仅显式关闭 ⇒ 门控 false");
  assert.equal(
    cuaPluginEnabled({ ACODE_CUA_PRODUCT_HELPER: "0", ACODE_CUA_DEV_MODE: "1" }),
    true,
    "DEV_MODE=1 覆盖 PRODUCT_HELPER=0（dev 旋钮优先级更高，不可用它关闭）",
  );
  // 对照：缺省（内部特性 ON）⇒ 门控 true——说明生产 fail-closed 不靠此门控默认关闭，
  // 而靠 admission（下条）+ Helper host 是无法启动的 stub（见 README/CONTRACT）。
  assert.equal(cuaPluginEnabled({}), true);
});

test("② admission 谓词：门控为 false 时即便 desktop-local 也不创建 Helper（无 live broker 可注入）", async () => {
  // shouldCreateDefaultCuaProductHelper 是 node.ts:715 导出的纯谓词（getOrCreateDefaultCuaProductHelper
  // 的 isAdmitted）。只读导入，不修改 node.ts。hasBuiltInCuaPlugin 即 isCuaEnabledForContext(context)
  // 的结果（node.ts:1761）。admission false ⇒ acquire 返回 undefined ⇒ 无托管 Helper ⇒ win32 无 live
  // broker socket env 注入 ⇒ 客户端 createComputerUseRuntime 缺 socketPath 而 fail-closed。
  const { shouldCreateDefaultCuaProductHelper } = await import(
    "../../../packages/services/src/node.ts"
  );
  const base = {
    serviceAuthorityMode: "desktop-local",
    hasRemoteWorkspaceIdentity: false,
    hasInjectedResolver: false,
  };
  // 插件未启用（门控 false）：即使 desktop-local 也不建 Helper。
  assert.equal(shouldCreateDefaultCuaProductHelper({ ...base, hasBuiltInCuaPlugin: false }), false);
  // 正向对照：唯一被 admit 的路径——门控 true + desktop-local + 非远程 + 无注入 resolver。
  assert.equal(shouldCreateDefaultCuaProductHelper({ ...base, hasBuiltInCuaPlugin: true }), true);
});

test("② admission 谓词：远程/server workspace 即便门控 true 也不建本地 Helper（不投影到本机屏幕）", async () => {
  const { shouldCreateDefaultCuaProductHelper } = await import(
    "../../../packages/services/src/node.ts"
  );
  const enabled = { hasBuiltInCuaPlugin: true, hasRemoteWorkspaceIdentity: false, hasInjectedResolver: false };
  // 非 desktop-local 的 authority mode 一律不建本地 Helper。
  assert.equal(
    shouldCreateDefaultCuaProductHelper({ ...enabled, serviceAuthorityMode: "standalone-server" }),
    false,
  );
  assert.equal(
    shouldCreateDefaultCuaProductHelper({ ...enabled, serviceAuthorityMode: "desktop-attached-remote" }),
    false,
  );
  // desktop-local 但带远程 workspace identity ⇒ 仍不建（远程 turn 不得投影本机桌面）。
  assert.equal(
    shouldCreateDefaultCuaProductHelper({
      hasBuiltInCuaPlugin: true,
      serviceAuthorityMode: "desktop-local",
      hasRemoteWorkspaceIdentity: true,
      hasInjectedResolver: false,
    }),
    false,
  );
});

// 正向对照：mintBrokerSocketPath 确实能造出 socketPath——证明客户端面「拿到 socketPath 就活」，
// fail-closed 纯由「上游不注入」而非「客户端惰性」。有 socketPath 但无服务端监听时 execute 归
// warming-up（CUA_NOT_READY，可重试），仍绝不假装动作成功（详见 cua-runtime-execute.test.mjs）。
test("对照：拿到 socketPath 的客户端面是活的（无服务端时归 CUA_NOT_READY，非 unavailable 惰性）", async () => {
  const rt = createComputerUseRuntime({ brokerSocketPath: mintBrokerSocketPath() });
  const result = await rt.execute({ toolName: "list_apps", context: CTX });
  const envelope = parsedText(result);
  // 连不上（无 Helper 监听）= warming-up，走可重试的 CUA_NOT_READY 非-error 信封，
  // 与「无 socketPath」的 isError unavailable 是**两条不同路径**——印证客户端面非惰性。
  assert.equal(envelope.kind, "CUA_NOT_READY");
  assert.notEqual(result.isError, true, "warming-up 是非-error 信封，不是 unavailable isError");
});
