import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NEW_TASK_DEFAULTS,
  NEW_TASK_DEFAULT_MODE_IDS,
  newTaskDefaultsSchema,
  normalizeNewTaskDefaultMode,
} from "../src/new-task-defaults.js";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

// 新建任务默认值的数据面登记：schema 本体、AppSettings 默认值、patch 通道三处必须一致。
// 目标仓没有设置同步能力（无 sync-scope.ts），因此本文件不覆盖同步键。

test("schema 默认值：空对象补齐关闭态且各项为空", () => {
  assert.deepEqual(newTaskDefaultsSchema.parse({}), DEFAULT_NEW_TASK_DEFAULTS);
  assert.deepEqual(DEFAULT_NEW_TASK_DEFAULTS, {
    enabled: false,
    mode: null,
    model: null,
    reasoningLevel: null,
    speed: null,
  });
});

test("未知字段丢弃不报错；speed 作为 additive 字段保留（旧/新版本设置互读）", () => {
  const parsed = newTaskDefaultsSchema.parse({
    enabled: true,
    speed: "fast",
    futureField: "whatever",
  });
  assert.deepEqual(parsed, {
    enabled: true,
    mode: null,
    model: null,
    reasoningLevel: null,
    speed: "fast",
  });
  assert.equal("futureField" in parsed, false);
});

test("旧 setting.json 缺 newTaskDefaults：AppSettings 读取补齐默认关闭态", () => {
  const result = appSettingsSchema.parse({ recentProjects: [], locale: "zh-CN" });
  assert.deepEqual(result.newTaskDefaults, DEFAULT_NEW_TASK_DEFAULTS);
  // 默认值用工厂函数，多次 parse 不共享同一个可变对象。
  assert.notEqual(
    appSettingsSchema.parse({}).newTaskDefaults,
    appSettingsSchema.parse({}).newTaskDefaults,
  );
});

test("object 面登记：显式值与模型身份原样保留，不会被 strip", () => {
  const result = appSettingsSchema.parse({
    newTaskDefaults: {
      enabled: true,
      mode: "dontAsk",
      model: { providerId: "custom", modelId: "demo" },
      reasoningLevel: "high",
      speed: "fast",
    },
  });
  assert.deepEqual(result.newTaskDefaults, {
    enabled: true,
    mode: "dontAsk",
    model: { providerId: "custom", modelId: "demo" },
    reasoningLevel: "high",
    speed: "fast",
  });
});

test("object 面非法值拒绝：模型身份缺字段、空字符串", () => {
  assert.equal(
    appSettingsSchema.safeParse({
      newTaskDefaults: { model: { providerId: "", modelId: "demo" } },
    }).success,
    false,
  );
  assert.equal(
    appSettingsSchema.safeParse({
      newTaskDefaults: { reasoningLevel: "  " },
    }).success,
    false,
  );
});

test("patch 面整份对象替换：半份对象按内层默认补齐", () => {
  const result = appSettingsPatchSchema.parse({
    newTaskDefaults: { enabled: true },
  });
  assert.deepEqual(result.newTaskDefaults, {
    enabled: true,
    mode: null,
    model: null,
    reasoningLevel: null,
    speed: null,
  });
  assert.equal(appSettingsPatchSchema.safeParse({ newTaskDefaults: null }).success, false);
});

test("mode 归一化：plan 不可固定，dontAsk 可固定，越界值按跟随默认", () => {
  assert.equal(normalizeNewTaskDefaultMode(null), null);
  assert.equal(normalizeNewTaskDefaultMode(undefined), null);
  assert.equal(normalizeNewTaskDefaultMode("plan"), null);
  for (const mode of NEW_TASK_DEFAULT_MODE_IDS) {
    assert.equal(normalizeNewTaskDefaultMode(mode), mode);
  }
  // 存储被外部改写时也不得写入不可固定的值。
  assert.equal(normalizeNewTaskDefaultMode("bogus" as never), null);
});

test("defaultReasoningLevelPick：合法值在 object/patch 两面都保留，非法值拒绝", () => {
  const valid = [
    "first",
    "highest",
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ] as const;
  for (const pick of valid) {
    const objectResult = appSettingsSchema.parse({ defaultReasoningLevelPick: pick });
    assert.equal(objectResult.defaultReasoningLevelPick, pick);
    const patchResult = appSettingsPatchSchema.parse({ defaultReasoningLevelPick: pick });
    assert.equal(patchResult.defaultReasoningLevelPick, pick);
  }
  assert.equal(appSettingsSchema.safeParse({ defaultReasoningLevelPick: "lowest" }).success, false);
  assert.equal(appSettingsPatchSchema.safeParse({ defaultReasoningLevelPick: 42 }).success, false);
  // 缺席保持 undefined：不给 default，避免把取法冻结进用户配置。
  assert.equal(appSettingsSchema.parse({}).defaultReasoningLevelPick, undefined);
});
