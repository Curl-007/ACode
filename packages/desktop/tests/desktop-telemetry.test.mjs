/**
 * WI-14 desktop main 遥测门禁单测（apps/acode-cli/specs/otel-telemetry.md 开关矩阵）。
 * desktopTelemetry.ts 不 import electron、@opentelemetry/* 全部函数内动态 import，
 * 因此门禁矩阵与 no-op init 可在纯 node（tsx loader）下直测。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const {
  resolveDesktopTelemetryGate,
  describeDesktopTelemetryRejection,
  initDesktopTelemetry,
} = await import("../src/main/desktopTelemetry.ts");

const ENDPOINT_ENV = {
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
};

function reasonOf(decision) {
  return decision.enabled ? "enabled" : decision.reason;
}

test("gate: 默认（无端点）= 完全 no-op", () => {
  assert.equal(reasonOf(resolveDesktopTelemetryGate({})), "no_endpoint");
});

test("gate: ACODE_TELEMETRY opt-out 优先于端点存在", () => {
  assert.equal(
    reasonOf(resolveDesktopTelemetryGate({ ...ENDPOINT_ENV, ACODE_TELEMETRY: "0" })),
    "opt_out",
  );
});

test("gate: OTEL_SDK_DISABLED kill-switch", () => {
  assert.equal(
    reasonOf(resolveDesktopTelemetryGate({ ...ENDPOINT_ENV, OTEL_SDK_DISABLED: "true" })),
    "sdk_disabled",
  );
});

test("gate: exporter 选择 none / 非 otlp", () => {
  assert.equal(
    reasonOf(resolveDesktopTelemetryGate({ ...ENDPOINT_ENV, OTEL_TRACES_EXPORTER: "none" })),
    "exporter_none",
  );
  assert.equal(
    reasonOf(resolveDesktopTelemetryGate({ ...ENDPOINT_ENV, OTEL_TRACES_EXPORTER: "jaeger" })),
    "exporter_not_otlp",
  );
});

test("gate: grpc / http-json 显式拒绝并给出明确错误文案", () => {
  const decision = resolveDesktopTelemetryGate({
    ...ENDPOINT_ENV,
    OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
  });
  assert.equal(reasonOf(decision), "unsupported_protocol");
  const rejection = describeDesktopTelemetryRejection(decision);
  assert.ok(rejection.includes("grpc"));
  assert.ok(rejection.includes("unsupported"));
  assert.ok(rejection.includes("http/protobuf"));
});

test("gate: 端点存在（per-signal 或公共回退）= 启用", () => {
  assert.equal(reasonOf(resolveDesktopTelemetryGate(ENDPOINT_ENV)), "enabled");
  assert.equal(
    reasonOf(
      resolveDesktopTelemetryGate({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }),
    ),
    "enabled",
  );
});

test("init: 无端点 → undefined（OTel 模块图不加载，静默无 warn）", async () => {
  const warnings = [];
  const handle = await initDesktopTelemetry({
    appVersion: "0.0.0-test",
    env: {},
    logger: { debug: () => {}, info: () => {}, warn: (...args) => warnings.push(args) },
  });
  assert.equal(handle, undefined);
  assert.equal(warnings.length, 0);
});

test("init: grpc 拒绝 → undefined + warn 一次", async () => {
  const warnings = [];
  const handle = await initDesktopTelemetry({
    appVersion: "0.0.0-test",
    env: { ...ENDPOINT_ENV, OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "grpc" },
    logger: { debug: () => {}, info: () => {}, warn: (...args) => warnings.push(args) },
  });
  assert.equal(handle, undefined);
  assert.equal(warnings.length, 1);
  assert.ok(String(warnings[0][0]).includes("unsupported"));
});
