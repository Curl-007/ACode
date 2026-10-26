// 本地诊断报告 schema 契约守护测试（U12，specs/local-diagnostic-report.md 验收场景 U12-A6）。
//
// 钉住三条契约不变量：
// 1. `.strict()` 白名单——未知字段、尤其敏感字段名（apiKey/token/authorization/path…）在 parse
//    时被拒，「结构性排除敏感信息」不依赖采集侧自律；
// 2. `parseLocalDiagnosticReport` fail-loud——非法输入抛稳定错误码，不吞异常不降级；
// 3. 四态可用性枚举闭集——「缺失不伪造健康」的类型面：不存在 passed/healthy 之类的值。
//
// 各端 DTO 组合的行为测试（脱敏 fixture、截断、零外联）归 desktop/web/ui 各自包内测试；
// 本文件只守护 shared 契约自身。
import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_DIAGNOSTIC_MAX_BYTES,
  LOCAL_DIAGNOSTIC_MAX_EVENTS,
  LOCAL_DIAGNOSTIC_PARSE_ERROR,
  LOCAL_DIAGNOSTIC_REPORT_SCHEMA_VERSION,
  localDiagnosticAvailabilitySchema,
  localDiagnosticFactsSchema,
  localDiagnosticReportSchema,
  parseLocalDiagnosticReport,
} from "../src/localDiagnosticReport.js";

/** 一份最小合法报告（所有组 not-collected/缺席也合法——availability 必填、组可缺）。 */
function minimalReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: LOCAL_DIAGNOSTIC_REPORT_SCHEMA_VERSION,
    platformType: "desktop",
    generatedAt: "2026-10-26T00:00:00.000Z",
    fieldAvailability: {
      build: "collected",
      connection: "unavailable",
      performance: "not-collected",
      provider: "not-collected",
      events: "not-collected",
    },
    build: {
      os: "win32",
      arch: "x64",
      locale: "zh-CN",
      capabilities: ["exportLogs"],
    },
    ...overrides,
  };
}

test("U12-A6: 最小合法报告通过 parse，且逐字段回读一致", () => {
  const parsed = parseLocalDiagnosticReport(minimalReport());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.platformType, "desktop");
  assert.equal(parsed.build?.os, "win32");
  assert.equal(parsed.fieldAvailability.connection, "unavailable");
  // 缺席组保持缺席（不被补默认值）——「缺失不伪造健康」的结构面。
  assert.equal(parsed.connection, undefined);
  assert.equal(parsed.performance, undefined);
});

test("U12-A1: Web 报告可整体省略 os/arch/appVersion，但 platformType 与 locale 必填", () => {
  // 手机离线场景：Web 不猜 OS/arch/版本（不开新指纹面），仍必须能表明「这是 Web 端报告」。
  const webReport = minimalReport({
    platformType: "web",
    build: { locale: "en-US", capabilities: ["saveDiagnosticReport"] },
  });
  const parsed = parseLocalDiagnosticReport(webReport);
  assert.equal(parsed.platformType, "web");
  assert.equal(parsed.build?.os, undefined);
  assert.equal(parsed.build?.arch, undefined);
  assert.equal(parsed.build?.appVersion, undefined);
  assert.equal(parsed.build?.locale, "en-US");
  // platformType 缺失即拒绝——不允许出现「不知来自哪端」的报告。
  const { platformType: _drop, ...noPlatform } = minimalReport();
  assert.throws(() => parseLocalDiagnosticReport(noPlatform));
});

test("U12-A6: .strict() 拒绝顶层未知字段", () => {
  assert.throws(
    () => parseLocalDiagnosticReport(minimalReport({ unexpectedField: 1 })),
    (err: unknown) => err instanceof Error && err.message === LOCAL_DIAGNOSTIC_PARSE_ERROR,
  );
});

test("U12-A6: .strict() 在字段组内拒绝敏感字段名（结构性排除的核心断言）", () => {
  // 采集侧若被改坏、把敏感值塞进 build 组，schema 必须在 parse 层拒绝——不依赖下游过滤。
  for (const sensitive of [
    { build: { ...minimalReport().build, apiKey: "sk-live-fake" } },
    { build: { ...minimalReport().build, hostname: "user-machine" } },
    {
      connection: {
        errorCodes: [],
        reconnectCount: 0,
        authorization: "Bearer fake",
      },
    },
    {
      provider: {
        entries: [{ id: "p1", keyHash: "deadbeef" }],
      },
    },
  ]) {
    assert.throws(
      () => parseLocalDiagnosticReport(minimalReport(sensitive)),
      (err: unknown) => err instanceof Error && err.message === LOCAL_DIAGNOSTIC_PARSE_ERROR,
      `敏感字段注入未被拒绝: ${JSON.stringify(Object.keys(sensitive))}`,
    );
  }
});

test("U12-A6: 缺 schemaVersion / 版本错误 / fieldAvailability 缺组均拒绝", () => {
  const { schemaVersion: _drop, ...noVersion } = minimalReport();
  assert.throws(() => parseLocalDiagnosticReport(noVersion));
  assert.throws(() => parseLocalDiagnosticReport(minimalReport({ schemaVersion: 2 })));
  const partial = minimalReport();
  const { events: _e, ...missingGroup } = partial.fieldAvailability;
  assert.throws(() =>
    parseLocalDiagnosticReport(minimalReport({ fieldAvailability: missingGroup })),
  );
});

test("U12-A6: 可用性是四态闭集——不存在 passed/healthy 之类可伪造健康的值", () => {
  const allowed = localDiagnosticAvailabilitySchema.options;
  assert.deepEqual([...allowed].sort(), [
    "collected",
    "not-collected",
    "truncated",
    "unavailable",
  ]);
  assert.throws(() => localDiagnosticAvailabilitySchema.parse("passed"));
  assert.throws(() => localDiagnosticAvailabilitySchema.parse("healthy"));
});

test("U12-A6: 非法负数计数与非整数事件数拒绝（受限计数契约）", () => {
  assert.throws(() =>
    parseLocalDiagnosticReport(
      minimalReport({
        connection: { errorCodes: [], reconnectCount: -1 },
        fieldAvailability: { ...minimalReport().fieldAvailability, connection: "collected" },
      }),
    ),
  );
  assert.throws(() =>
    parseLocalDiagnosticReport(
      minimalReport({
        events: [{ at: "2026-10-26T00:00:00.000Z", code: "c", count: 0 }],
        fieldAvailability: { ...minimalReport().fieldAvailability, events: "collected" },
      }),
    ),
  );
});

test("契约常量与 spec 量化门槛一致（改常量必须同改 spec）", () => {
  // spec §量化门槛：JSON ≤1 MiB、events ≤200。此测试是「schema 常量 ↔ spec 文字」的防漂移钉。
  assert.equal(LOCAL_DIAGNOSTIC_MAX_BYTES, 1 * 1024 * 1024);
  assert.equal(LOCAL_DIAGNOSTIC_MAX_EVENTS, 200);
});

test("facts DTO schema：build 缺席 + unavailable 合法；组内未知字段拒绝", () => {
  const ok = localDiagnosticFactsSchema.parse({
    platformType: "web",
    buildAvailability: "unavailable",
    connectionAvailability: "unavailable",
  });
  assert.equal(ok.build, undefined);
  assert.throws(() =>
    localDiagnosticFactsSchema.parse({
      platformType: "web",
      buildAvailability: "unavailable",
      connectionAvailability: "unavailable",
      rawLogs: "整段日志透传",
    }),
  );
  // platformType 缺失即拒绝：facts DTO 也必须能表明来自哪端。
  assert.throws(() =>
    localDiagnosticFactsSchema.parse({
      buildAvailability: "unavailable",
      connectionAvailability: "unavailable",
    }),
  );
});

test("报告 schema 拒绝把原始日志/正文形状塞进任何组（白名单面完整性抽查）", () => {
  // events 条目只允许 at/code/count——正文、参数、URL 都无处安放。
  const reportSchemaShape = localDiagnosticReportSchema;
  assert.throws(() =>
    reportSchemaShape.parse(
      minimalReport({
        events: [{ at: "2026-10-26T00:00:00.000Z", code: "c", body: "会话正文泄漏" }],
        fieldAvailability: { ...minimalReport().fieldAvailability, events: "collected" },
      }),
    ),
  );
});
