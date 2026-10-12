import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "./validationAppSettings.js";
import {
  AUTO_TRANSLATE_INPUT_MAX_CHARS,
  AUTO_TRANSLATE_MAX_OUTPUT_TOKENS,
  AUTO_TRANSLATE_QUERY_SOURCE,
  AUTO_TRANSLATE_REQUEST_TIMEOUT_MS,
  AUTO_TRANSLATE_TIMEOUT_MS,
  DEFAULT_AUTO_TRANSLATE_SETTINGS,
  autoTranslateSettingsSchema,
} from "./auto-translate.js";

test("autoTranslate 缺省补齐为整份关闭（语义表 #1：零行为变化）", () => {
  const parsed = appSettingsSchema.parse({ recentProjects: [] });
  assert.deepEqual(parsed.autoTranslate, DEFAULT_AUTO_TRANSLATE_SETTINGS);
  assert.equal(parsed.autoTranslate.enabled, false);
  assert.equal(parsed.autoTranslate.mode, "translate");
  assert.equal(parsed.autoTranslate.modelSelection, null);
});

test("autoTranslate 只存 enabled 时其余内层字段也补齐默认值", () => {
  const parsed = appSettingsSchema.parse({ recentProjects: [], autoTranslate: { enabled: true } });
  // 语义表 #2：开关开 + 模型未选 = 功能不生效；schema 层允许该形态存在。
  assert.equal(parsed.autoTranslate.enabled, true);
  assert.equal(parsed.autoTranslate.mode, "translate");
  assert.equal(parsed.autoTranslate.modelSelection, null);
});

test("autoTranslate 完整形态保留三项（语义表 #5）", () => {
  const parsed = appSettingsSchema.parse({
    recentProjects: [],
    autoTranslate: {
      enabled: true,
      mode: "translate-polish",
      modelSelection: { providerId: "zai", modelId: "glm-4.7" },
    },
  });
  assert.deepEqual(parsed.autoTranslate.modelSelection, { providerId: "zai", modelId: "glm-4.7" });
  assert.equal(parsed.autoTranslate.mode, "translate-polish");
});

test("autoTranslate 非法 mode 与非法 modelSelection 被拒绝", () => {
  assert.equal(
    appSettingsSchema.safeParse({
      recentProjects: [],
      autoTranslate: { enabled: true, mode: "summarize" },
    }).success,
    false,
  );
  assert.equal(
    appSettingsSchema.safeParse({
      recentProjects: [],
      autoTranslate: { enabled: true, modelSelection: { providerId: "", modelId: "x" } },
    }).success,
    false,
  );
  // 档位不允许进入设置：档位由 CLI 侧 AUXILIARY 绑定自动补齐（§4.1）。
  assert.equal(
    appSettingsSchema.safeParse({
      recentProjects: [],
      autoTranslate: {
        enabled: true,
        modelSelection: {
          providerId: "zai",
          modelId: "glm-4.7",
          options: { reasoningLevel: "high" },
        },
      },
    }).success,
    false,
  );
  // 未知字段被 strict 拒绝。
  assert.equal(
    appSettingsSchema.safeParse({
      recentProjects: [],
      autoTranslate: { enabled: true, extra: 1 },
    }).success,
    false,
  );
});

test("patch schema 接受整份替换并拒绝半份外的非法值", () => {
  const full = {
    enabled: true,
    mode: "translate",
    modelSelection: { providerId: "zai", modelId: "glm-4.7" },
  };
  assert.deepEqual(appSettingsPatchSchema.parse({ autoTranslate: full }).autoTranslate, full);
  // modelSelection 置空（清除选择）必须合法：关闭时不互相清空、清除选择是显式操作。
  assert.equal(
    appSettingsPatchSchema.parse({ autoTranslate: { enabled: true, modelSelection: null } })
      .autoTranslate?.modelSelection,
    null,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ autoTranslate: { enabled: "yes" } }).success,
    false,
  );
  assert.equal(appSettingsPatchSchema.safeParse({ autoTranslate: 42 }).success, false);
});

test("autoTranslateSettingsSchema 独立解析：两 mode 枚举均合法", () => {
  assert.equal(autoTranslateSettingsSchema.parse({ mode: "translate" }).mode, "translate");
  assert.equal(
    autoTranslateSettingsSchema.parse({ mode: "translate-polish" }).mode,
    "translate-polish",
  );
});

test("常量与 PRD §4.4/§4.6 口径一致", () => {
  assert.equal(AUTO_TRANSLATE_QUERY_SOURCE, "auto_translate");
  assert.equal(AUTO_TRANSLATE_INPUT_MAX_CHARS, 4_000);
  assert.equal(AUTO_TRANSLATE_TIMEOUT_MS, 15_000);
  assert.equal(AUTO_TRANSLATE_MAX_OUTPUT_TOKENS, 512);
  // 协议层超时必须大于自身 deadline（PRD §4.4：deadline + 5s 缓冲）。
  assert.equal(AUTO_TRANSLATE_REQUEST_TIMEOUT_MS, AUTO_TRANSLATE_TIMEOUT_MS + 5_000);
});
