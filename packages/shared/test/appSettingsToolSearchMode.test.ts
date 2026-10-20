import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_SEARCH_APP_MODES } from "../src/tool-search-feature.js";
import {
  appSettingsPatchSchema,
  appSettingsSchema,
} from "../src/validationAppSettings.js";

// toolSearchMode 在 validationAppSettings.ts 的三处登记（enum 闭集 / object 面 /
// patch 面），形态对照 appSettingsScriptWorkflowMode.test.ts——漏登记 object schema
// 会被写盘 strip（2026-10-11 实机教训）。规格见 apps/acode-cli/specs/tool-search.md R11。

test("object 面登记：三档合法值原样通过且不被 strip（写盘教训的 direct 钉）", () => {
  for (const mode of TOOL_SEARCH_APP_MODES) {
    const result = appSettingsSchema.safeParse({ toolSearchMode: mode });
    assert.equal(result.success, true, `${mode} 应通过 object 校验`);
    if (!result.success) continue;
    assert.equal(
      result.data.toolSearchMode,
      mode,
      "漏登记 object schema 时 zod 会 strip 该键，值读不回来",
    );
  }
});

test("object 面登记：enum 闭集之外的值拒绝（native 是 CLI 独有档，不进 App 设置面）", () => {
  for (const bogus of ["native", "bogus", "Off", 42, null]) {
    assert.equal(
      appSettingsSchema.safeParse({ toolSearchMode: bogus }).success,
      false,
      `${String(bogus)} 必须被拒绝`,
    );
  }
});

test("patch 面登记：局部单键更新通过且保留，非法值与 object 同判", () => {
  for (const mode of TOOL_SEARCH_APP_MODES) {
    const result = appSettingsPatchSchema.safeParse({ toolSearchMode: mode });
    assert.equal(result.success, true, `patch 接受 ${mode}`);
    if (!result.success) continue;
    assert.equal(result.data.toolSearchMode, mode);
  }
  assert.equal(
    appSettingsPatchSchema.safeParse({ toolSearchMode: "native" }).success,
    false,
    "patch 与 object 必须共用同一 enum 闭集",
  );
});

test("缺省缺席不写默认值：空设置解析后不含 toolSearchMode 键（不给 default 的裁决钉）", () => {
  const result = appSettingsSchema.safeParse({});
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(
    "toolSearchMode" in result.data,
    false,
    "缺席即 off 由读取方归一化兜底；schema 写默认值会把 off 冻结进用户配置，将来翻转缺省救不回来",
  );
});
