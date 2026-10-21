import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/**
 * 新建任务默认值文案守护：中英两套词典的键集必须一致，且设置页依赖的键一个都不能少
 *（缺键时 IntlProvider 会把原始 id 直接画到界面上）。
 */
const isTaskDefaultsKey = (key: string) => key.startsWith("settings.taskDefaults.");

const zhKeys = Object.keys(zhCN).filter(isTaskDefaultsKey).sort();
const enKeys = Object.keys(enUS).filter(isTaskDefaultsKey).sort();

const required = [
  "settings.taskDefaults.title",
  "settings.taskDefaults.enabled",
  "settings.taskDefaults.enabledDescription",
  "settings.taskDefaults.mode",
  "settings.taskDefaults.modeDescription",
  "settings.taskDefaults.model",
  "settings.taskDefaults.modelDescription",
  "settings.taskDefaults.reasoningLevel",
  "settings.taskDefaults.reasoningLevelDescription",
  "settings.taskDefaults.speed",
  "settings.taskDefaults.speedDescription",
  "settings.taskDefaults.followDefault",
  "settings.taskDefaults.reasoningPick",
  "settings.taskDefaults.reasoningPickDescription",
  "settings.taskDefaults.reasoningPick.first",
  "settings.taskDefaults.reasoningPick.highest",
  "settings.taskDefaults.catalogUnavailable",
];

test("zh-CN and en-US expose the same taskDefaults key set", () => {
  assert.deepEqual(zhKeys, enKeys);
  assert.deepEqual(zhKeys, [...required].sort());
});

test("taskDefaults critical keys exist in both locales", () => {
  for (const key of required) {
    assert.equal(typeof zhCN[key], "string", `zh-CN 缺少 ${key}`);
    assert.equal(typeof enUS[key], "string", `en-US 缺少 ${key}`);
  }
});
