import assert from "node:assert/strict";
import test from "node:test";
import { SCRIPT_WORKFLOW_MODES } from "../src/script-workflow-feature.js";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
} from "../src/validationAppSettings.js";

// C7/D1 的 validation 半边（t-8 验证门 P3-4）：scriptWorkflowMode 在
// validationAppSettings.ts 有三处登记——enum 闭集（:45）、appSettingsObjectSchema（:511，
// 漏登记则写盘被 strip 的 2026-10-11 实机教训）、appSettingsPatchSchema（:561，patch
// 局部更新入口）。enum 本体不导出，三处登记统一经两个公开 schema 面观察：
// object 面走 appSettingsSchema（preprocess 后落 appSettingsObjectSchema），
// patch 面走 appSettingsPatchSchema；两处共用同一个 enum，漂移即写盘分歧。

test("object 面登记：三档合法值原样通过且不被 strip（写盘教训的 direct 钉）", () => {
  for (const mode of SCRIPT_WORKFLOW_MODES) {
    const result = appSettingsSchema.safeParse({ scriptWorkflowMode: mode });
    assert.equal(result.success, true, `${mode} 应通过 object 校验`);
    if (!result.success) continue;
    assert.equal(
      result.data.scriptWorkflowMode,
      mode,
      "漏登记 object schema 时 zod 会 strip 该键，值读不回来",
    );
  }
});

test("object 面登记：enum 闭集之外的值拒绝", () => {
  for (const bogus of ["bogus", "ondemand", 42, null]) {
    assert.equal(
      appSettingsSchema.safeParse({ scriptWorkflowMode: bogus }).success,
      false,
      `${String(bogus)} 必须被拒绝`,
    );
  }
});

test("patch 面登记：局部单键更新通过且保留，非法值与 object 同判", () => {
  for (const mode of SCRIPT_WORKFLOW_MODES) {
    const result = appSettingsPatchSchema.safeParse({ scriptWorkflowMode: mode });
    assert.equal(result.success, true, `patch 接受 ${mode}`);
    if (!result.success) continue;
    assert.equal(result.data.scriptWorkflowMode, mode);
  }
  assert.equal(
    appSettingsPatchSchema.safeParse({ scriptWorkflowMode: "bogus" }).success,
    false,
    "patch 与 object 必须共用同一 enum 闭集",
  );
});
