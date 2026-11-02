import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderImportCandidateView, ProviderImportWarning } from "@acode/services";
import { ACodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { getLocaleMessagesResource } from "../src/i18n/localeMessages.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { ProviderImportCandidateList } from "../src/settings/model-provider-section/provider-import/ProviderImportCandidateList.js";
import {
  ProviderImportResultList,
  ProviderImportWarningSection,
} from "../src/settings/model-provider-section/provider-import/ProviderImportResultList.js";
import { ProviderImportSourcePicker } from "../src/settings/model-provider-section/provider-import/ProviderImportSourcePicker.js";
import {
  defaultProviderImportSelection,
  providerImportErrorMessageId,
  providerImportWarningMessageId,
} from "../src/settings/model-provider-section/provider-import/providerImportModel.js";

/**
 * Provider 导入向导的接缝内渲染测试（形态对照 remotePluginSyncSections.test.ts：
 * renderToStaticMarkup + createElement，无 jsdom）。守护：
 *   - 来源勾选（含静态 `~` 路径标签）；
 *   - 候选行（名称/来源/协议三值文案/baseUrl/key 状态/重复徽标与原因）；
 *   - 重复项默认不勾选（data-state="checked" 计数）；
 *   - 结果列表与告警区；
 *   - 负向断言：渲染产物不含明文 key（N1/N5 的 UI 层等价）；
 *   - i18n：warning/error 全码在 zh-CN 与 en-US 都有文案（EI-107 同批）。
 */

// 词典是懒加载资源；renderToStaticMarkup 不支持异步 suspend，先预热两份词典。
test.before(async () => {
  await getLocaleMessagesResource("zh-CN").promise;
  await getLocaleMessagesResource("en-US").promise;
});

const FAKE_PLAINTEXT_KEY = "sk-test-fake-provider-import-render-0002";

const render = (node: React.ReactNode): string =>
  renderToStaticMarkup(
    createElement(
      ACodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TooltipProvider, null, node),
    ),
  );

/** radix Checkbox 的根节点带 aria-checked；指示器也会带 data-state，故按 aria 计数避免双计。 */
const checkedCount = (markup: string): number => (markup.match(/aria-checked="true"/g) ?? []).length;

async function loadMessages(locale: "zh-CN" | "en-US"): Promise<Record<string, string>> {
  const resource = getLocaleMessagesResource(locale);
  return resource.state === "pending" ? resource.promise : resource.messages;
}

function candidate(overrides: Partial<ProviderImportCandidateView> = {}): ProviderImportCandidateView {
  return {
    id: "11111111-1111-4111-8111-000000000001",
    source: "codex",
    sourceLabel: "Codex · Beta",
    name: "Beta",
    api: "openai-chat-completions",
    baseUrl: "https://beta.example.test/v1",
    models: [{ id: "gpt-5", name: "gpt-5" }],
    hasApiKey: true,
    apiKeyHint: "••••0001",
    isCurrent: true,
    ...overrides,
  };
}

test("来源选择器：三家来源 + 静态 ~ 路径标签 + 默认全选", () => {
  const markup = render(
    createElement(ProviderImportSourcePicker, {
      selectedSources: ["claude-code", "codex", "cc-switch"],
      disabled: false,
      onSourceSelected: () => {},
      onSelectAll: () => {},
      onClearAll: () => {},
    }),
  );
  assert.ok(markup.includes("Claude Code"));
  assert.ok(markup.includes("~/.claude/settings.json"));
  assert.ok(markup.includes("~/.codex/config.toml"));
  assert.ok(markup.includes("~/.cc-switch/cc-switch.db"));
  assert.equal(checkedCount(markup), 3, "默认三家全选");
});

test("候选列表：展示字段齐全，重复徽标与原因可见，且不含明文", () => {
  const rows: ProviderImportCandidateView[] = [
    candidate({ id: "a" }),
    candidate({
      id: "b",
      name: "Duplicated",
      duplicate: "existing",
      duplicateOf: "已有供应商",
    }),
    candidate({ id: "c", name: "NoKey", hasApiKey: false, apiKeyHint: undefined }),
  ];
  const selected = defaultProviderImportSelection(rows);
  const markup = render(
    createElement(ProviderImportCandidateList, {
      candidates: rows,
      selectedCandidateIds: selected,
      disabled: false,
      onToggleCandidate: () => {},
      onSelectAll: () => {},
      onClearAll: () => {},
    }),
  );
  assert.ok(markup.includes("Beta"));
  assert.ok(markup.includes("Codex · Beta"));
  assert.ok(markup.includes("https://beta.example.test/v1"), "baseUrl 展示（Q6）");
  assert.ok(markup.includes("••••0001"), "key 状态显示 apiKeyHint");
  assert.ok(markup.includes("未检测到密钥"), "无 key 行显示未检测到");
  assert.ok(markup.includes("当前在用"), "isCurrent 徽标");
  assert.ok(markup.includes("已存在"), "existing 重复徽标");
  assert.ok(markup.includes("已有供应商"), "重复原因含既有名");
  assert.ok(markup.includes("Chat Completions"), "协议用三值同款文案");
  // 默认勾选：existing 重复不勾 → 3 行中 2 行 checked。
  assert.equal(checkedCount(markup), 2);
  assert.ok(!markup.includes(FAKE_PLAINTEXT_KEY), "渲染产物不得含明文");
});

test("N1/N5（渲染层）：上游视图误带 apiKey 也不进入渲染产物", () => {
  const leaky = { ...candidate(), apiKey: FAKE_PLAINTEXT_KEY } as unknown as ProviderImportCandidateView;
  const markup = render(
    createElement(ProviderImportCandidateList, {
      candidates: [leaky],
      selectedCandidateIds: defaultProviderImportSelection([leaky]),
      disabled: false,
      onToggleCandidate: () => {},
      onSelectAll: () => {},
      onClearAll: () => {},
    }),
  );
  assert.ok(!markup.includes(FAKE_PLAINTEXT_KEY), "渲染产物不得含明文");
  assert.ok(!markup.includes("apiKey"), "渲染产物不得出现 apiKey 字段名");
});

test("结果列表与告警区：逐项结果 + 可展开告警（只带键名）", () => {
  const warnings: ProviderImportWarning[] = [
    { code: "env-missing-key", params: { source: "codex", key: "ALPHA_KEY" } },
    { code: "unsupported-api-format", params: { source: "cc-switch", count: 1 } },
  ];
  const resultMarkup = render(
    createElement(ProviderImportResultList, {
      result: {
        ok: true,
        imported: [{ id: "a", providerId: "p1", name: "Beta", modelIds: ["gpt-5"] }],
        skipped: [{ id: "b", name: "NoKey", reason: "model-exists" }],
      },
    }),
  );
  assert.ok(resultMarkup.includes("Beta"));
  assert.ok(resultMarkup.includes("gpt-5"));
  assert.ok(resultMarkup.includes("NoKey"));
  assert.ok(resultMarkup.includes("模型已存在"));

  const warningMarkup = render(createElement(ProviderImportWarningSection, { warnings }));
  assert.ok(warningMarkup.includes("<summary"));
  assert.ok(warningMarkup.includes("ALPHA_KEY"), "告警可含键名");
  assert.ok(warningMarkup.includes("1 条"), "聚合计数参数可插值");
  assert.ok(!warningMarkup.includes(FAKE_PLAINTEXT_KEY));
});

test("i18n 真源：warning/error 全码在 zh-CN 与 en-US 同批存在", async () => {
  const warningCodes = [
    "source-read-failed",
    "invalid-json",
    "invalid-toml",
    "no-table",
    "auth-ignored",
    "env-missing-key",
    "config-invalid-json",
    "unsupported-api-format",
    "unsupported-app-type",
    "file-too-large",
    "db-too-large",
    "candidate-invalid",
    "candidates-truncated",
  ];
  const errorCodes = [
    "invalid-args",
    "scan-stale",
    "candidate-missing",
    "scan-failed",
    "write-failed",
  ];
  const staticIds = [
    "settings.modelProvider.import.title",
    "settings.modelProvider.import.hostNote",
    "settings.modelProvider.import.source.label",
    "settings.modelProvider.import.source.claudeCode",
    "settings.modelProvider.import.source.codex",
    "settings.modelProvider.import.source.ccSwitch",
    "settings.modelProvider.import.source.selectAll",
    "settings.modelProvider.import.source.clearAll",
    "settings.modelProvider.import.scan",
    "settings.modelProvider.import.rescan",
    "settings.modelProvider.import.scanning",
    "settings.modelProvider.import.importing",
    "settings.modelProvider.import.cancel",
    "settings.modelProvider.import.confirm",
    "settings.modelProvider.import.finish",
    "settings.modelProvider.import.empty",
    "settings.modelProvider.import.preview.summary",
    "settings.modelProvider.import.preview.selectionCount",
    "settings.modelProvider.import.preview.selectAll",
    "settings.modelProvider.import.preview.clearAll",
    "settings.modelProvider.import.preview.current",
    "settings.modelProvider.import.preview.duplicateExisting",
    "settings.modelProvider.import.preview.duplicateCandidate",
    "settings.modelProvider.import.preview.duplicateExistingReason",
    "settings.modelProvider.import.preview.duplicateCandidateReason",
    "settings.modelProvider.import.preview.modelCount",
    "settings.modelProvider.import.preview.keyPresent",
    "settings.modelProvider.import.preview.keyMissing",
    "settings.modelProvider.import.result.imported",
    "settings.modelProvider.import.result.skipped",
    "settings.modelProvider.import.result.empty",
    "settings.modelProvider.import.skipReason.model-exists",
    "settings.modelProvider.import.warnings.title",
    "settings.modelProvider.import.error.candidateMissingNote",
    "settings.mcpServers.import.variableReference.title",
    "settings.mcpServers.import.variableReference.titleNoKeys",
    "settings.mcpServers.import.variableReference.location.env",
    "settings.mcpServers.import.variableReference.location.headers",
    "settings.mcpServers.import.variableReference.location.args",
    "settings.mcpServers.import.variableReference.location.url",
    "settingsSync.agent.cursor",
    "settingsSync.agent.gemini",
    "settingsSync.agent.vscode",
    "settingsSync.agent.ccSwitch",
  ];
  const dynamicIds = [
    ...warningCodes.map((code) => providerImportWarningMessageId(code)),
    ...errorCodes.map((code) => providerImportErrorMessageId(code)),
  ];
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = await loadMessages(locale);
    for (const id of [...staticIds, ...dynamicIds]) {
      assert.equal(
        typeof messages[id],
        "string",
        `${locale} 缺少文案：${id}`,
      );
      assert.ok(messages[id].length > 0, `${locale} 文案为空：${id}`);
    }
  }
});