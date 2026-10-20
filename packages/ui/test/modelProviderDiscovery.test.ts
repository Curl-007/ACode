import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  computeDiscoverySelection,
  mapDiscoveryErrorKindToMessageId,
} from "../src/settings/model-provider-section/modelDiscoveryDialogModel.js";
import type { ProviderModelDiscoveryErrorKind } from "@acode/services";

// 获取模型（specs/provider-model-discovery.md 验收场景 4 的 ui 层）：
// 纯函数用例（三分集/保序去重、error kind 全映射）+ 源码契约断言
// （按钮位置/禁用态/双回调门控、对话框无 onMouseLeave 关闭路径、确认走 onConfirm）。
// ui 包无 jsdom/testing-library 基建，组件层行为用源码契约守护（同
// usageStatusbarTooltipStability.test.ts 口径）；交互级验证依赖运行时。

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARD_SECTIONS_PATH = resolve(
  __dirname,
  "../src/settings/model-provider-section/ProviderCardSections.tsx",
);
const DIALOG_PATH = resolve(
  __dirname,
  "../src/settings/model-provider-section/DiscoverModelsDialog.tsx",
);
const SHARED_TEST_IDS_PATH = resolve(__dirname, "../../shared/src/test-ids.ts");
const ZH_LOCALE_PATH = resolve(__dirname, "../src/i18n/locales/zh-CN.ts");
const EN_LOCALE_PATH = resolve(__dirname, "../src/i18n/locales/en-US.ts");

function readSource(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

test("computeDiscoverySelection：三分集划分 + 保序去重", () => {
  const selection = computeDiscoverySelection(["b", "a", "b", "c"], ["b"]);
  // addable = fetched 中未配置者，保持 fetched 原序、去重（"b" 重复且已配置，两因都不入）。
  assert.deepEqual(selection.addable, ["a", "c"]);
  // preselected = addable 全量（spec 产品规则 5：未配置 id 默认勾选）。
  assert.deepEqual(selection.preselected, ["a", "c"]);
  // configuredHits = fetched 中已配置者。
  assert.deepEqual(selection.configuredHits, ["b"]);
});

test("computeDiscoverySelection：空 configured / 空 fetched / 全已配置边界", () => {
  assert.deepEqual(computeDiscoverySelection(["x", "x"], []), {
    addable: ["x"],
    preselected: ["x"],
    configuredHits: [],
  });
  assert.deepEqual(computeDiscoverySelection([], ["y"]), {
    addable: [],
    preselected: [],
    configuredHits: [],
  });
  const allConfigured = computeDiscoverySelection(["m1", "m2"], ["m2", "m1", "m3"]);
  assert.deepEqual(allConfigured.addable, []);
  assert.deepEqual(allConfigured.preselected, []);
  assert.deepEqual(allConfigured.configuredHits, ["m1", "m2"]);
});

const ALL_ERROR_KINDS: readonly ProviderModelDiscoveryErrorKind[] = [
  "network",
  "timeout",
  "unauthorized",
  "forbidden",
  "not-found",
  "unsupported-shape",
  "too-large",
  "insecure-url",
  "redirect-cross-origin",
  "http",
];

const EXPECTED_ERROR_MESSAGE_IDS: Record<ProviderModelDiscoveryErrorKind, string> = {
  network: "settings.modelProvider.discover.error.network",
  timeout: "settings.modelProvider.discover.error.timeout",
  unauthorized: "settings.modelProvider.discover.error.unauthorized",
  forbidden: "settings.modelProvider.discover.error.forbidden",
  "not-found": "settings.modelProvider.discover.error.notFound",
  "unsupported-shape": "settings.modelProvider.discover.error.unsupportedShape",
  "too-large": "settings.modelProvider.discover.error.tooLarge",
  "insecure-url": "settings.modelProvider.discover.error.insecureUrl",
  "redirect-cross-origin": "settings.modelProvider.discover.error.redirectCrossOrigin",
  http: "settings.modelProvider.discover.error.http",
};

test("mapDiscoveryErrorKindToMessageId：全部错误 kind 映射到预期 i18n key", () => {
  for (const kind of ALL_ERROR_KINDS) {
    assert.equal(mapDiscoveryErrorKindToMessageId(kind), EXPECTED_ERROR_MESSAGE_IDS[kind]);
  }
});

const ALL_DISCOVER_I18N_KEYS = [
  "settings.modelProvider.discoverModels",
  ...Object.values(EXPECTED_ERROR_MESSAGE_IDS),
  "settings.modelProvider.discover.title",
  "settings.modelProvider.discover.loading",
  "settings.modelProvider.discover.summary",
  "settings.modelProvider.discover.truncated",
  "settings.modelProvider.discover.configured",
  "settings.modelProvider.discover.empty",
  "settings.modelProvider.discover.confirm",
  "settings.modelProvider.discover.retry",
  "settings.modelProvider.discover.hostNote",
  "settings.modelProvider.discover.disabledTooltip",
  "settings.modelProvider.discover.addFailed",
  "settings.modelProvider.discover.error.noBaseUrl",
];

test("i18n 双语键齐全：discover 全量 key 在 zh-CN 与 en-US 都存在", () => {
  const zh = readSource(ZH_LOCALE_PATH);
  const en = readSource(EN_LOCALE_PATH);
  for (const key of ALL_DISCOVER_I18N_KEYS) {
    assert.ok(zh.includes(`"${key}"`), `zh-CN 缺少 ${key}`);
    assert.ok(en.includes(`"${key}"`), `en-US 缺少 ${key}`);
  }
});

test("shared test-ids：获取模型按钮与对话框常量已登记", () => {
  const source = readSource(SHARED_TEST_IDS_PATH);
  assert.ok(
    source.includes(
      'export const TID_MODEL_PROVIDER_DISCOVER_MODELS_BUTTON = "model-provider-discover-models-button";',
    ),
  );
  assert.ok(
    source.includes(
      'export const TID_MODEL_PROVIDER_DISCOVER_DIALOG = "model-provider-discover-dialog";',
    ),
  );
});

test("ProviderCardSections 契约：获取模型按钮在添加模型左侧、禁用绑 canDiscoverModels、对话框双回调门控", () => {
  const source = readSource(CARD_SECTIONS_PATH);
  // 按钮位置：discover 按钮的 data-testid 必须先于 add-model 的 data-testid 渲染。
  const discoverUsageId = source.indexOf("data-testid={TID_MODEL_PROVIDER_DISCOVER_MODELS_BUTTON}");
  const addUsageId = source.indexOf("data-testid={TID_MODEL_PROVIDER_ADD_MODEL_BUTTON}");
  assert.ok(discoverUsageId > -1, "缺少获取模型按钮 testid");
  assert.ok(addUsageId > -1, "缺少添加模型按钮 testid");
  assert.ok(discoverUsageId < addUsageId, "获取模型按钮必须渲染在添加模型按钮之前（左侧）");
  // 禁用态：仅 canDiscoverModels === false 时禁用（undefined 不禁用，兼容旧调用方）。
  assert.ok(
    source.includes("disabled={canDiscoverModels === false}"),
    "获取模型按钮禁用态必须绑 canDiscoverModels === false",
  );
  // 禁用 tooltip 使用指定 i18n key。
  assert.ok(source.includes('"settings.modelProvider.discover.disabledTooltip"'));
  // 双回调门控：按钮与对话框都只在 onDiscoverModels 与 onAddDiscoveredModels 同时在场渲染。
  const gateMatches = source.match(/onDiscoverModels && onAddDiscoveredModels \? \(/g) ?? [];
  assert.ok(gateMatches.length >= 2, "按钮与对话框必须分别由双回调门控");
  const lastGate = source.lastIndexOf("onDiscoverModels && onAddDiscoveredModels ? (");
  const dialogRender = source.indexOf("<DiscoverModelsDialog");
  assert.ok(dialogRender > -1, "缺少 DiscoverModelsDialog 渲染");
  assert.ok(
    dialogRender > lastGate && dialogRender - lastGate < 200,
    "DiscoverModelsDialog 必须紧跟双回调门控渲染",
  );
  // configuredModelIds 来源为当前模型列表。
  assert.ok(source.includes("configuredModelIds={models.map((model) => model.modelId)}"));
  // 确认包装：await onAddDiscoveredModels 后才关闭（reject 抛回对话框，不关闭）。
  assert.ok(source.includes("await onAddDiscoveredModels(modelIds);"));
});

test("DiscoverModelsDialog 契约：无 onMouseLeave 关闭路径、确认走 onConfirm、成功关闭/失败 inline", () => {
  const source = readSource(DIALOG_PATH);
  // 关闭路径只有 Radix Dialog 自身（Esc/遮罩/关闭钮）与显式取消；不得引入 hover 离开关闭。
  assert.ok(!source.includes("onMouseLeave"), "对话框不得含 onMouseLeave 关闭路径");
  // 对话框 testid 挂在 DialogContent。
  assert.ok(source.includes("data-testid={TID_MODEL_PROVIDER_DISCOVER_DIALOG}"));
  // 确认走 onConfirm(勾选集)，成功关闭、失败留在对话框内 inline 报错。
  assert.match(source, /await onConfirm\(confirmIds\);\s*onOpenChange\(false\);/);
  assert.ok(source.includes('"settings.modelProvider.discover.addFailed"'));
  // 已配置行禁选（绝不覆盖/重复添加，spec 产品规则 5/7）。
  assert.ok(source.includes("disabled={row.configured || saving}"));
  // 确认按钮禁用：勾选集为空或保存中。
  assert.ok(source.includes("disabled={confirmIds.length === 0 || saving}"));
  // 错误态映射 + 重试。
  assert.ok(source.includes("mapDiscoveryErrorKindToMessageId(discoveryError.kind)"));
  assert.ok(source.includes('"settings.modelProvider.discover.retry"'));
  // 主机出口脚注（spec 产品规则 9）。
  assert.ok(source.includes('"settings.modelProvider.discover.hostNote"'));
});
