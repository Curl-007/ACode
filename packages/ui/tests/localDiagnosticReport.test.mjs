// U12 本地诊断报告组合器测试。spec: packages/ui/specs/local-diagnostic-report-ui.md，
// 契约真源: packages/shared/specs/local-diagnostic-report.md。
// 组合器是纯函数，无需 jsdom；本文件覆盖可用性四态、条目/大小上限、脱敏与纯函数性。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCAL_DIAGNOSTIC_MAX_EVENTS,
  localDiagnosticReportSchema,
} from "@acode/shared";
import {
  DEFAULT_DIAGNOSTIC_SCOPE,
  composeLocalDiagnosticReport,
  diagnosticAvailabilityBadgeVariant,
  diagnosticAvailabilityLabelId,
  diagnosticReportFileName,
  resolveDownloadOutcome,
} from "../src/lib/localDiagnosticReport.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EN_LOCALE_PATH = resolve(__dirname, "../src/i18n/locales/en-US.ts");
const ZH_LOCALE_PATH = resolve(__dirname, "../src/i18n/locales/zh-CN.ts");

/** Desktop 端事实 fixture（main 采集的白名单字段）。 */
function desktopFacts() {
  return {
    platformType: "desktop",
    build: {
      appVersion: "1.0.4",
      os: "win32",
      arch: "x64",
      locale: "zh-CN",
      capabilities: ["exportLogs", "saveDialog"],
    },
    buildAvailability: "collected",
    connection: { deliveryMode: "desktop-continuous", errorCodes: [], reconnectCount: 0 },
    connectionAvailability: "collected",
  };
}

/** Web 端事实 fixture（省略 os/arch，build 组仍 collected）。 */
function webFacts() {
  return {
    platformType: "web",
    build: { locale: "en-US", capabilities: ["saveDiagnosticReport"] },
    buildAvailability: "collected",
    connectionAvailability: "unavailable",
  };
}

const NOW = "2026-10-26T08:00:00.000Z";

test("默认范围是最小集：provider/events 默认不选入", () => {
  assert.deepEqual(DEFAULT_DIAGNOSTIC_SCOPE, {
    build: true,
    connection: true,
    performance: true,
    provider: false,
    events: false,
  });
});

test("U12-A4: 四态可用性逐一准确——collected / unavailable / not-collected", () => {
  const report = composeLocalDiagnosticReport({
    facts: desktopFacts(),
    memoryCounts: { "taskQueryCache.entries": 12 },
    memoryAvailable: true,
    providerEntries: null,
    events: [],
    // provider 选了但无既有结果 → unavailable；events 未选 → not-collected
    scope: { ...DEFAULT_DIAGNOSTIC_SCOPE, provider: true, events: false },
    generatedAt: NOW,
  });

  assert.equal(report.fieldAvailability.build, "collected");
  assert.equal(report.fieldAvailability.connection, "collected");
  assert.equal(report.fieldAvailability.performance, "collected");
  // 关键：无既有 provider 结果时标 unavailable，**不得**伪造 collected（缺失不伪造健康）
  assert.equal(report.fieldAvailability.provider, "unavailable");
  assert.equal(report.provider, undefined);
  // 未选入的组标 not-collected 且缺席（不是空对象——空对象会被误读为「查过且为空」）
  assert.equal(report.fieldAvailability.events, "not-collected");
  assert.equal(report.events, undefined);
});

test("U12-A4: 内存指标不可得（Web 无 performance.memory）时 performance 标 unavailable", () => {
  const report = composeLocalDiagnosticReport({
    facts: webFacts(),
    memoryCounts: null,
    memoryAvailable: false,
    providerEntries: null,
    events: [],
    scope: DEFAULT_DIAGNOSTIC_SCOPE,
    generatedAt: NOW,
  });
  assert.equal(report.platformType, "web");
  assert.equal(report.fieldAvailability.performance, "unavailable");
  assert.equal(report.performance, undefined);
  // Web 的 build 组仍 collected（提供了自有的 locale/capabilities），但省略 os/arch
  assert.equal(report.fieldAvailability.build, "collected");
  assert.equal(report.build?.os, undefined);
  assert.equal(report.build?.locale, "en-US");
  // connection 该端报 unavailable → 不伪造
  assert.equal(report.fieldAvailability.connection, "unavailable");
  assert.equal(report.connection, undefined);
});

test("U12-A4: events 超条目上限被裁到 200 且标 truncated", () => {
  const manyEvents = Array.from({ length: LOCAL_DIAGNOSTIC_MAX_EVENTS + 57 }, (_, i) => ({
    at: NOW,
    code: `evt-${i}`,
  }));
  const report = composeLocalDiagnosticReport({
    facts: desktopFacts(),
    memoryCounts: {},
    memoryAvailable: true,
    providerEntries: null,
    events: manyEvents,
    scope: { ...DEFAULT_DIAGNOSTIC_SCOPE, events: true },
    generatedAt: NOW,
  });
  assert.equal(report.fieldAvailability.events, "truncated");
  assert.equal(report.events?.length, LOCAL_DIAGNOSTIC_MAX_EVENTS);
  // 裁剪保留最前面的（时间序），不是随机丢弃
  assert.equal(report.events?.[0]?.code, "evt-0");
});

test("provider 选入且有既有结果时标 collected，条目原样透传（不含凭据字段）", () => {
  const entries = [{ id: "zai", tier: "live", status: "ok", code: "provider-ok" }];
  const report = composeLocalDiagnosticReport({
    facts: desktopFacts(),
    memoryCounts: {},
    memoryAvailable: true,
    providerEntries: entries,
    events: [],
    scope: { ...DEFAULT_DIAGNOSTIC_SCOPE, provider: true },
    generatedAt: NOW,
  });
  assert.equal(report.fieldAvailability.provider, "collected");
  assert.deepEqual(report.provider?.entries, entries);
});

test("U12-A3: 组合器不引入敏感字段面，顶层键集封闭", () => {
  // 组合器不做脱敏（schema 结构性排除敏感字段名）；本测试钉住「组合器不会自己引入敏感字段」，
  // 且各端上报的白名单值原样透传——若某端误把敏感值塞进 locale，那是该端采集缺陷，由该端测试拦截。
  const report = composeLocalDiagnosticReport({
    facts: desktopFacts(),
    memoryCounts: { "taskQueryCache.entries": 3 },
    memoryAvailable: true,
    providerEntries: null,
    events: [{ at: NOW, code: "reconnect", count: 2 }],
    scope: { ...DEFAULT_DIAGNOSTIC_SCOPE, events: true },
    generatedAt: NOW,
  });
  const serialized = JSON.stringify(report);
  for (const forbidden of ["bearer ", "sk-", "password", "authorization", "apikey"]) {
    assert.ok(!serialized.toLowerCase().includes(forbidden), `出现敏感形状: ${forbidden}`);
  }
  // 顶层字段集封闭：只有 schema 允许的键
  assert.deepEqual(Object.keys(report).sort(), [
    "build",
    "connection",
    "events",
    "fieldAvailability",
    "generatedAt",
    "performance",
    "platformType",
    "schemaVersion",
  ]);
});

test("输出恒过 schema 自校验（契约 U12-A6）", () => {
  const report = composeLocalDiagnosticReport({
    facts: desktopFacts(),
    memoryCounts: { a: 1 },
    memoryAvailable: true,
    providerEntries: null,
    events: [],
    scope: DEFAULT_DIAGNOSTIC_SCOPE,
    generatedAt: NOW,
  });
  assert.doesNotThrow(() => localDiagnosticReportSchema.parse(report));
});

test("大小上限：超 1 MiB 时按优先级丢弃可选组并标 truncated，核心组不丢", () => {
  // 造一份大 events，配合注入的放大 byteLength 迫使组合器丢弃 events 组
  // （丢弃顺序 events → provider → performance）
  const hugeEvents = Array.from({ length: LOCAL_DIAGNOSTIC_MAX_EVENTS }, (_, i) => ({
    at: NOW,
    code: `evt-${i}-${"x".repeat(6000)}`,
    count: i + 1,
  }));
  const report = composeLocalDiagnosticReport({
    facts: desktopFacts(),
    memoryCounts: {},
    memoryAvailable: true,
    providerEntries: null,
    events: hugeEvents,
    scope: { ...DEFAULT_DIAGNOSTIC_SCOPE, events: true, provider: true },
    generatedAt: NOW,
  });
  assert.equal(report.fieldAvailability.events, "truncated");
  assert.equal(report.events, undefined); // 被丢弃的组缺席
  // 核心最小集仍在
  assert.equal(report.fieldAvailability.build, "collected");
  assert.ok(report.build);
  assert.ok(report.connection);
});

test("大小上限：丢弃全部可选组后仍超限则 fail-loud 抛错，不静默产出超大报告", () => {
  assert.throws(
    () =>
      composeLocalDiagnosticReport({
        facts: desktopFacts(),
        memoryCounts: {},
        memoryAvailable: true,
        providerEntries: null,
        events: [],
        scope: DEFAULT_DIAGNOSTIC_SCOPE,
        generatedAt: NOW,
        // 任何非空报告都判为超限 → 无可选组可丢 → 必须抛错
        byteLength: () => Number.MAX_SAFE_INTEGER,
      }),
    /local-diagnostic-report-too-large/,
  );
});

test("U12-A5: 组合是纯函数——同输入多次调用结果稳定、不就地修改入参", () => {
  const input = {
    facts: desktopFacts(),
    memoryCounts: { a: 1, b: 2 },
    memoryAvailable: true,
    providerEntries: null,
    events: [{ at: NOW, code: "x" }],
    scope: { ...DEFAULT_DIAGNOSTIC_SCOPE, events: true },
    generatedAt: NOW,
  };
  const first = JSON.stringify(composeLocalDiagnosticReport(input));
  const second = JSON.stringify(composeLocalDiagnosticReport(input));
  assert.equal(first, second);
  // 输入对象未被就地修改（不污染调用方的 facts/memoryCounts）
  assert.equal(input.facts.buildAvailability, "collected");
  assert.deepEqual(input.memoryCounts, { a: 1, b: 2 });
});

test("文件名只用跨平台安全字符", () => {
  const name = diagnosticReportFileName("desktop", NOW);
  assert.match(name, /^acode-diagnostics-desktop-[\dTZ-]+\.json$/);
  // ISO 时间的冒号/点已替换（冒号是 Windows 文件名非法字符）
  assert.ok(!name.includes(":"));
  assert.ok(name.endsWith(".json"));
});

test("U12-A5: 下载结果决策矩阵——取消/成功/降级复制/失败四路互斥且不谎报成功", () => {
  // 用户取消：静默（cancelled），不弹错误——取消是正常结果不是失败
  assert.deepEqual(
    resolveDownloadOutcome({ result: { saved: false, cancelled: true }, clipboardAvailable: true }),
    { kind: "cancelled" },
  );
  // 保存成功带路径
  assert.deepEqual(
    resolveDownloadOutcome({
      result: { saved: true, path: "/tmp/x.json" },
      clipboardAvailable: false,
    }),
    { kind: "saved", path: "/tmp/x.json" },
  );
  // 保存成功无路径（Web Blob 下载不给路径）
  assert.deepEqual(
    resolveDownloadOutcome({ result: { saved: true }, clipboardAvailable: false }),
    { kind: "saved" },
  );
  // 平台无 saveDiagnosticReport（旧 preload）→ 剪贴板降级
  assert.deepEqual(
    resolveDownloadOutcome({ result: undefined, clipboardAvailable: true }),
    { kind: "copied" },
  );
  // 平台明确拒绝下载（Web 的 download-unsupported）→ 剪贴板降级，不当失败
  assert.deepEqual(
    resolveDownloadOutcome({
      result: { saved: false, error: "download-unsupported" },
      clipboardAvailable: true,
    }),
    { kind: "copied" },
  );
  // 保存失败且无剪贴板 → failed，透传平台稳定码（不谎报成功）
  assert.deepEqual(
    resolveDownloadOutcome({
      result: { saved: false, error: "diagnostic-report-write-failed" },
      clipboardAvailable: false,
    }),
    { kind: "failed", errorCode: "diagnostic-report-write-failed" },
  );
  // 无 result 也无剪贴板 → failed + 兜底稳定码（不得返回 saved）
  assert.deepEqual(
    resolveDownloadOutcome({ result: undefined, clipboardAvailable: false }),
    { kind: "failed", errorCode: "save-unavailable" },
  );
});

test("U12-A5: 任何输入组合都不得把未成功的保存报成 saved（不谎报成功的穷举守护）", () => {
  const results = [
    undefined,
    { saved: false },
    { saved: false, cancelled: true },
    { saved: false, error: "download-unsupported" },
    { saved: false, error: "diagnostic-report-too-large" },
  ];
  for (const result of results) {
    for (const clipboardAvailable of [true, false]) {
      const outcome = resolveDownloadOutcome({ result, clipboardAvailable });
      assert.notEqual(outcome.kind, "saved", `result=${JSON.stringify(result)} 不得报 saved`);
    }
  }
});

test("U12-A4: 可用性四态标签键在两个 locale 都已定义（缺译会把原始键名渲染给用户）", () => {
  const en = readFileSync(EN_LOCALE_PATH, "utf8");
  const zh = readFileSync(ZH_LOCALE_PATH, "utf8");
  const states = ["collected", "unavailable", "not-collected", "truncated"];
  const labelIds = states.map((state) => diagnosticAvailabilityLabelId(state));
  // 四态必须映射到**互不相同**的键——否则「可见地区分」不成立（A4 的核心要求）。
  assert.equal(new Set(labelIds).size, 4, `四态标签键重复: ${labelIds.join(",")}`);
  for (const id of labelIds) {
    assert.ok(en.includes(`"${id}"`), `en-US 缺词条 ${id}`);
    assert.ok(zh.includes(`"${id}"`), `zh-CN 缺词条 ${id}`);
  }
  // 字段组名与对话框 UI 用到的其余词条也一并守护（动态拼接的键 grep 不出来）。
  for (const group of ["build", "connection", "performance", "provider", "events"]) {
    const id = `diagnostics.group.${group}`;
    assert.ok(en.includes(`"${id}"`), `en-US 缺词条 ${id}`);
    assert.ok(zh.includes(`"${id}"`), `zh-CN 缺词条 ${id}`);
  }
  for (const id of [
    "diagnostics.title",
    "diagnostics.description",
    "diagnostics.collecting",
    "diagnostics.error",
    "diagnostics.close",
    "diagnostics.download.action",
    "diagnostics.download.pending",
    "diagnostics.download.saved",
    "diagnostics.download.savedPath",
    "diagnostics.download.copiedFallback",
    "diagnostics.download.failed",
    "workspaceHeader.help.diagnostics",
  ]) {
    assert.ok(en.includes(`"${id}"`), `en-US 缺词条 ${id}`);
    assert.ok(zh.includes(`"${id}"`), `zh-CN 缺词条 ${id}`);
  }
});

test("U12-A4: 四态 Badge variant 可见区分——truncated 用警示色，两态弱化不混淆为成功", () => {
  assert.equal(diagnosticAvailabilityBadgeVariant("collected"), "secondary");
  assert.equal(diagnosticAvailabilityBadgeVariant("truncated"), "destructive");
  assert.equal(diagnosticAvailabilityBadgeVariant("unavailable"), "outline");
  assert.equal(diagnosticAvailabilityBadgeVariant("not-collected"), "outline");
  // 只用 Badge 既有 variant（DESIGN.md：不新造样式）——曾误用过不存在的 "warning"。
  const allowed = new Set(["default", "secondary", "destructive", "outline", "ghost", "link"]);
  for (const state of ["collected", "unavailable", "not-collected", "truncated"]) {
    assert.ok(allowed.has(diagnosticAvailabilityBadgeVariant(state)), `${state} 用了不存在的 variant`);
  }
});
