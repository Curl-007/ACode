import assert from "node:assert/strict";
import test from "node:test";
import { ACODE_AGENT_ENGINE_IDS } from "../src/acode-agent-registry.js";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

// agentEngine / jcodeBinaryPath 在 validationAppSettings.ts 的登记（enum 闭集 / object 面 /
// patch 面），形态对照 appSettingsToolSearchMode.test.ts——漏登记 object schema 会被写盘
// strip（2026-10-11 实机教训，validationAppSettings.ts 内注释反复强调）。
// 规格见 packages/shared/specs/agent-engine-jcode-slot.md R6/R7。

test("object 面登记：每个引擎 id 原样通过且不被 strip", () => {
  for (const engine of ACODE_AGENT_ENGINE_IDS) {
    const result = appSettingsSchema.safeParse({ agentEngine: engine });
    assert.equal(result.success, true, `${engine} 应通过 object 校验`);
    if (!result.success) continue;
    assert.equal(
      result.data.agentEngine,
      engine,
      "漏登记 object schema 时 zod 会 strip 该键，值读不回来",
    );
  }
});

test("object 面登记：enum 闭集之外的值拒绝（含已下线的空槽位旧值）", () => {
  // codex/opencode/gemini 曾被删除（agent-engine-external-slots-removal.md），
  // 本次只恢复 jcode——这三个仍必须被拒绝，否则 packages/ui/test/nonCliAcpRetirement
  // 的归一断言会判红。
  for (const bogus of ["codex", "opencode", "gemini", "GLM", "Jcode", "", 42, null]) {
    assert.equal(
      appSettingsSchema.safeParse({ agentEngine: bogus }).success,
      false,
      `${String(bogus)} 必须被拒绝`,
    );
  }
});

test("patch 面登记：局部单键更新通过且保留，非法值与 object 同判", () => {
  for (const engine of ACODE_AGENT_ENGINE_IDS) {
    const result = appSettingsPatchSchema.safeParse({ agentEngine: engine });
    assert.equal(result.success, true, `patch 接受 ${engine}`);
    if (!result.success) continue;
    assert.equal(result.data.agentEngine, engine);
  }
  assert.equal(
    appSettingsPatchSchema.safeParse({ agentEngine: "codex" }).success,
    false,
    "patch 与 object 必须共用同一 enum 闭集",
  );
});

test("缺省缺席不写默认值：空设置解析后不含 agentEngine 键", () => {
  const result = appSettingsSchema.safeParse({});
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(
    "agentEngine" in result.data,
    false,
    "缺席即回退 native 由读取方归一化兜底（resolveAgentEngineSetting）；schema 写默认值会把 glm 冻结进用户配置",
  );
});

test("jcodeBinaryPath：object 与 patch 两面都登记（漏登记则路径写盘被 strip）", () => {
  const path = process.platform === "win32" ? "C:\\jcode\\bin\\jcode.exe" : "/usr/local/bin/jcode";
  const objectResult = appSettingsSchema.safeParse({ jcodeBinaryPath: path });
  assert.equal(objectResult.success, true);
  if (objectResult.success) {
    assert.equal(
      objectResult.data.jcodeBinaryPath,
      path,
      "漏登记 object schema 时 zod 会 strip 该键，Settings 里填的路径存不下来",
    );
  }
  const patchResult = appSettingsPatchSchema.safeParse({ jcodeBinaryPath: path });
  assert.equal(patchResult.success, true);
  if (patchResult.success) {
    assert.equal(patchResult.data.jcodeBinaryPath, path);
  }
  // 非字符串必须拒绝（schema 是 z.string()，不接受数字/对象）。
  assert.equal(appSettingsSchema.safeParse({ jcodeBinaryPath: 42 }).success, false);
});
