import assert from "node:assert/strict";
import test from "node:test";
import {
  ACODE_AGENT_ENGINE_IDS,
  ACODE_AGENT_ENGINE_REGISTRY,
  ACODE_NATIVE_AGENT_ENGINE,
  getAgentEngineDescriptors,
  getAgentEnginePermissionModes,
  getBotSelectablePermissionModes,
  isAgentEngineId,
  isNativeAgentEngine,
  resolveAgentEngine,
} from "../src/acode-agent-registry.js";
import { ACODE_JCODE_AGENT_RUNTIME, getEngineRuntime } from "../src/acode-agent-runtime.js";
import { getACodeAgentAvailableModes } from "../src/acode-agent-model-state.js";
import {
  acodeAgentProviderSchema,
  normalizeAgentProviderToACodeAgent,
} from "../src/acode-agent-policy.js";
import {
  DEFAULT_AGENT_ENGINE_SETTING,
  normalizeAgentEngineSetting,
  resolveAgentEngineSetting,
} from "../src/agent-engine-setting.js";

// 引擎注册表恢复 jcode 槽位的核心验收（packages/shared/specs/agent-engine-jcode-slot.md
// 验收场景 1-5）。jcode 是被删的 codex/opencode/gemini 空槽位之外**首个有实现的**外部引擎。

test("场景1: ACodeProvider 与 ENGINE_IDS 双向绑定——两侧都含 jcode", () => {
  assert.deepEqual([...ACODE_AGENT_ENGINE_IDS], ["glm", "jcode"]);
  // native 固定首位（UI/缺省锚点）。
  assert.equal(ACODE_AGENT_ENGINE_IDS[0], ACODE_NATIVE_AGENT_ENGINE);
  // Record<ACodeProvider, descriptor> 穷尽：缺 jcode 条目会编译失败（此处运行时复核）。
  assert.ok(ACODE_AGENT_ENGINE_REGISTRY.jcode, "注册表必须有 jcode 条目");
  assert.ok(ACODE_AGENT_ENGINE_REGISTRY.glm, "注册表必须有 glm 条目");
});

test("场景2: resolveAgentEngine 对 jcode 返回非 native；未知/空值回退 native", () => {
  const jcode = resolveAgentEngine("jcode");
  assert.equal(jcode.id, "jcode");
  assert.equal(jcode.native, false);
  assert.equal(isNativeAgentEngine("jcode"), false);
  assert.equal(isNativeAgentEngine("glm"), true);
  // 旧数据兼容：已下线的空槽位旧值 + 空值 + 未知值全部回退 native。
  for (const fallback of ["codex", "opencode", "gemini", undefined, null, ""]) {
    assert.equal(
      resolveAgentEngine(fallback).id,
      "glm",
      `resolveAgentEngine(${String(fallback)}) 应回退 native glm`,
    );
  }
  assert.equal(isAgentEngineId("jcode"), true);
  assert.equal(isAgentEngineId("codex"), false, "codex 不是合法引擎 id");
});

test("场景3: getEngineRuntime 按引擎 dispatch spawnArgs（jcode→jcode-bridge）", () => {
  assert.deepEqual(getEngineRuntime("jcode").spawnArgs, ["jcode-bridge", "--stdio"]);
  assert.deepEqual(getEngineRuntime("glm").spawnArgs, ["app-server", "--stdio"]);
  // 未知/空值回退 native runtime。
  assert.deepEqual(getEngineRuntime("codex").spawnArgs, ["app-server", "--stdio"]);
  assert.deepEqual(getEngineRuntime(undefined).spawnArgs, ["app-server", "--stdio"]);
  // jcode 与 glm 共用同一 bundle（bundledResourceDir / nodeBundleEntryFile），只换子命令。
  assert.equal(ACODE_JCODE_AGENT_RUNTIME.bundledResourceDir, "glm");
  assert.equal(ACODE_JCODE_AGENT_RUNTIME.nodeBundleEntryFile, "acode.cjs");
  // jcode 用独立 binaryEnvVar（不与 glm 的 GLM_BINARY_PATH 撞）。
  assert.equal(ACODE_JCODE_AGENT_RUNTIME.binaryEnvVar, "JCODE_BINARY_PATH");
});

test("场景4: provider 归一——jcode 透传，codex 等旧值归一 undefined/native", () => {
  // schema：合法引擎 id 原样通过（曾是 `=== "glm"` 会把 jcode 归一成 undefined）。
  assert.equal(acodeAgentProviderSchema.parse("jcode"), "jcode");
  assert.equal(acodeAgentProviderSchema.parse("glm"), "glm");
  assert.equal(acodeAgentProviderSchema.parse("codex"), undefined);
  assert.equal(acodeAgentProviderSchema.parse(undefined), undefined);
  // normalize：合法透传，其余回退 native。
  assert.equal(normalizeAgentProviderToACodeAgent("jcode"), "jcode");
  assert.equal(normalizeAgentProviderToACodeAgent("codex"), "glm");
});

test("场景5: bot 天花板——jcode 只有 yolo，被剔除后远程可选集为空（P0-3 不变量）", () => {
  // R2 诚实收敛：jcode 后端无权限审批回路，只声明 yolo。
  assert.deepEqual([...getAgentEnginePermissionModes("jcode")], ["yolo"]);
  assert.equal(resolveAgentEngine("jcode").defaultPermissionMode, "yolo");
  // bot 天花板剔除 yolo → jcode 的远程可选权限模式为空集，
  // 故远程 bot 入口自动无法驱动 jcode（既有机制达成，无需新增守卫）。
  assert.deepEqual([...getBotSelectablePermissionModes("jcode")], []);
  // 对照：glm 的 bot 可选集非空（yolo 被剔除但 build/edit/plan/dontAsk 保留）。
  assert.ok(getBotSelectablePermissionModes("glm").length > 0, "glm 的 bot 可选权限模式应非空");
});

test("getACodeAgentAvailableModes 引擎作用域：jcode 只暴露 yolo 档", () => {
  const jcodeModes = getACodeAgentAvailableModes("jcode").map((m) => m.id);
  assert.deepEqual(jcodeModes, ["yolo"], "jcode 不应呈现它不支持的 build/edit/plan");
  const glmModes = getACodeAgentAvailableModes("glm").map((m) => m.id);
  assert.ok(glmModes.includes("build") && glmModes.includes("plan"), "glm 保留全部档位");
  // 未知值回退 native 模式集。
  assert.deepEqual(
    getACodeAgentAvailableModes("codex").map((m) => m.id),
    glmModes,
  );
});

test("getAgentEngineDescriptors 含 jcode（UI 引擎选择 + BOT_ACODE_PROVIDER_OPTIONS 消费）", () => {
  const ids = getAgentEngineDescriptors().map((d) => d.id);
  assert.deepEqual(ids, ["glm", "jcode"]);
});

test("引擎设置归一化：jcode/glm 透传，非法值回退 native", () => {
  assert.equal(normalizeAgentEngineSetting("jcode"), "jcode");
  assert.equal(normalizeAgentEngineSetting("glm"), "glm");
  assert.equal(normalizeAgentEngineSetting("codex"), undefined);
  assert.equal(normalizeAgentEngineSetting("  jcode  "), "jcode", "trim 后判定");
  assert.equal(normalizeAgentEngineSetting(42), undefined);
  assert.equal(resolveAgentEngineSetting(undefined), DEFAULT_AGENT_ENGINE_SETTING);
  assert.equal(DEFAULT_AGENT_ENGINE_SETTING, "glm");
});
