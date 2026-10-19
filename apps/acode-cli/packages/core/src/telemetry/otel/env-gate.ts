/**
 * OTel trace 导出的 env 门禁（specs/otel-telemetry.md「开关矩阵」）。
 *
 * 机制参照 oh-my-pi（MIT）packages/coding-agent/src/telemetry-export.ts 的
 * `signalEnabled`/`initTelemetryExport` 语义：无 OTLP 端点即完全 no-op（impl 模块
 * 不加载）、`OTEL_SDK_DISABLED` kill-switch、仅支持 http/protobuf——grpc/json 显式
 * 拒绝而不是把 protobuf 载荷误路由到别的传输端点。
 *
 * 本文件是纯函数层：不 import 任何 @opentelemetry/*，位于默认启动路径的静态模块图，
 * 必须保持零依赖、零 IO，可直接单测。
 */

/** 门禁拒绝原因；`unsupported_protocol` 需要 warn 日志给出明确错误说明。 */
export type OtelGateDisabledReason =
  | "opt_out"
  | "sdk_disabled"
  | "exporter_none"
  | "exporter_not_otlp"
  | "no_endpoint"
  | "unsupported_protocol";

export type OtelTraceGateDecision =
  | { enabled: true }
  | { enabled: false; reason: OtelGateDisabledReason; protocol?: string };

/** 用户 opt-out 总开关的关闭值（大小写不敏感）。 */
const OPT_OUT_VALUES = new Set(["0", "false", "off"]);

/**
 * 按 spec 开关矩阵自上而下判定 traces 信号。命中即停；除 enabled 外全部是
 * 完全 no-op——调用方（init.ts）据此决定是否动态 import impl 模块。
 */
export function resolveOtelTraceGate(
  env: Readonly<Record<string, string | undefined>>,
): OtelTraceGateDecision {
  // 1. ACode 总开关：只有「关」的语义；=1 不构成强制启用（端点仍是唯一启用条件）。
  const master = env.ACODE_TELEMETRY?.trim().toLowerCase();
  if (master !== undefined && OPT_OUT_VALUES.has(master)) {
    return { enabled: false, reason: "opt_out" };
  }
  // 2. OTel 标准 kill-switch。
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") {
    return { enabled: false, reason: "sdk_disabled" };
  }
  // 3/4. OTEL_TRACES_EXPORTER 选择列表：含 none 关闭；有非空选择且不含 otlp 也关闭
  //（用户选了 console/jaeger 等其他 exporter，本运行时不实现，不冒充）。
  const exporterSelection = env.OTEL_TRACES_EXPORTER;
  if (exporterSelection) {
    let hasSelection = false;
    let hasOtlp = false;
    for (const entry of exporterSelection.split(",")) {
      const selection = entry.trim().toLowerCase();
      if (!selection) continue;
      hasSelection = true;
      if (selection === "none") return { enabled: false, reason: "exporter_none" };
      if (selection === "otlp") hasOtlp = true;
    }
    if (hasSelection && !hasOtlp) {
      return { enabled: false, reason: "exporter_not_otlp" };
    }
  }
  // 5. 端点门禁（默认态）：per-signal 端点优先于公共端点，两者皆无 = 完全 no-op。
  const endpoint =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint?.trim()) {
    return { enabled: false, reason: "no_endpoint" };
  }
  // 6. 协议门禁：仅 http/protobuf；显式设置其他协议（grpc、http/json）= 拒绝。
  const protocol = (
    env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL
  )
    ?.trim()
    .toLowerCase();
  if (protocol && protocol !== "http/protobuf") {
    return { enabled: false, reason: "unsupported_protocol", protocol };
  }
  return { enabled: true };
}

/**
 * 拒绝时的用户可见说明（warn 日志文案）。unsupported_protocol 必须显式点名协议值，
 * 帮助用户发现「配了 grpc 端点但本运行时只发 protobuf」的误路由风险。
 */
export function describeOtelGateRejection(decision: OtelTraceGateDecision): string | undefined {
  if (decision.enabled) return undefined;
  switch (decision.reason) {
    case "unsupported_protocol":
      return `OTEL trace export disabled: protocol ${decision.protocol} is unsupported; only http/protobuf is supported`;
    case "exporter_not_otlp":
      return "OTEL trace export disabled: OTEL_TRACES_EXPORTER selects a non-otlp exporter";
    default:
      // opt_out / sdk_disabled / exporter_none / no_endpoint 都是用户意图内的静默关闭。
      return undefined;
  }
}
