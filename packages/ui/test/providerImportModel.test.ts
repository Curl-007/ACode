import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderImportCandidateView } from "@acode/services";
import {
  buildProviderImportCandidateRows,
  defaultProviderImportSelection,
  isProviderImportCandidateSelectable,
  isProviderImportRescanRequired,
  providerImportErrorMessageId,
  providerImportImportedCount,
  providerImportScanErrorCode,
  providerImportWarningMessageId,
  summarizeProviderImportResult,
  toggleProviderImportCandidateIds,
  toggleProviderImportSource,
} from "../src/settings/model-provider-section/provider-import/providerImportModel.js";

/**
 * Provider 导入向导纯模型测试（docs/specs/provider-config-import.md R8）。
 * 含 UI 层的 N1/N5 等价断言：渲染行是**白名单投影**，即使上游视图多带字段也不会携带凭据。
 */

const FAKE_PLAINTEXT_KEY = "sk-test-fake-provider-import-ui-0001";

function candidate(overrides: Partial<ProviderImportCandidateView> = {}): ProviderImportCandidateView {
  return {
    id: "11111111-1111-4111-8111-000000000001",
    source: "claude-code",
    sourceLabel: "Claude Code",
    name: "Demo",
    api: "anthropic-messages",
    baseUrl: "https://claude.example.test",
    models: [{ id: "claude-sonnet-4-5", name: "Sonnet 4.5" }],
    hasApiKey: true,
    apiKeyHint: "••••0001",
    isCurrent: false,
    ...overrides,
  };
}

test("N1/N5（UI 层）：候选行是白名单投影，上游多带 apiKey 也不进渲染行", () => {
  // 模拟上游视图被误扩展：多出 apiKey 字段。白名单投影必须丢弃它。
  const leaky = {
    ...candidate(),
    apiKey: FAKE_PLAINTEXT_KEY,
    credentialRef: "provider:apikey:demo",
  } as unknown as ProviderImportCandidateView;

  const rows = buildProviderImportCandidateRows([leaky]);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    [
      "api",
      "apiKeyHint",
      "baseUrl",
      "duplicate",
      "duplicateOf",
      "hasApiKey",
      "id",
      "isCurrent",
      "modelCount",
      "modelPreview",
      "name",
      "selectable",
      "sourceLabel",
    ].sort(),
    "渲染行字段集合必须是显式白名单",
  );
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(FAKE_PLAINTEXT_KEY), "渲染行不得含明文");
  assert.ok(!Object.keys(rows[0]).includes("apiKey"));
  assert.ok(!Object.keys(rows[0]).includes("credentialRef"));
  // hint 只保留末 4 位形态（服务端已归一，UI 不二次加工）。
  assert.equal(rows[0].apiKeyHint, "••••0001");
});

test("默认勾选：existing 重复项不勾，candidate 重复项仍可勾", () => {
  const existing = candidate({ id: "a", duplicate: "existing", duplicateOf: "已有供应商" });
  const candidateDup = candidate({ id: "b", duplicate: "candidate", duplicateOf: "Claude Code" });
  const clean = candidate({ id: "c" });
  const list = [existing, candidateDup, clean];

  assert.deepEqual(defaultProviderImportSelection(list), ["b", "c"]);
  assert.equal(isProviderImportCandidateSelectable(existing), false);
  assert.equal(isProviderImportCandidateSelectable(candidateDup), true);

  const rows = buildProviderImportCandidateRows(list);
  assert.equal(rows[0].selectable, false);
  assert.equal(rows[0].duplicateOf, "已有供应商");
  assert.equal(rows[1].duplicate, "candidate");
});

test("勾选归一：来源开关与候选批量勾选保持有序去重", () => {
  assert.deepEqual(toggleProviderImportSource(["codex", "cc-switch"], "claude-code", true), [
    "claude-code",
    "codex",
    "cc-switch",
  ]);
  assert.deepEqual(toggleProviderImportSource(["claude-code", "codex"], "codex", false), [
    "claude-code",
  ]);
  assert.deepEqual(toggleProviderImportCandidateIds(["a"], ["b", "a"], true), ["a", "b"]);
  assert.deepEqual(toggleProviderImportCandidateIds(["a", "b"], ["b"], false), ["a"]);
});

test("错误/告警 code → i18n id 与结果归一", () => {
  assert.equal(
    providerImportWarningMessageId("unsupported-api-format"),
    "settings.modelProvider.import.warning.unsupported-api-format",
  );
  assert.equal(
    providerImportErrorMessageId("scan-stale"),
    "settings.modelProvider.import.error.scan-stale",
  );
  assert.equal(providerImportScanErrorCode(null), null);
  assert.equal(providerImportScanErrorCode({ ok: true, candidates: [], warnings: [] }), null);
  assert.equal(providerImportScanErrorCode({ ok: false, error: { code: "scan-failed" } }), "scan-failed");
  assert.equal(isProviderImportRescanRequired("scan-stale"), true);
  assert.equal(isProviderImportRescanRequired("write-failed"), false);
  assert.equal(
    summarizeProviderImportResult({
      ok: true,
      imported: [
        { id: "a", providerId: "p1", name: "A", modelIds: ["m1"] },
      ],
      skipped: [],
    })?.imported,
    1,
  );
  assert.equal(summarizeProviderImportResult({ ok: false, error: { code: "write-failed" } }), null);
  assert.equal(
    providerImportImportedCount({ ok: false, error: { code: "scan-stale" } }),
    0,
    "失败态零写入 → 完成数 0",
  );
});