/**
 * Desktop main 进程级 OTel Resource 初始化（WI-14，apps/acode-cli/specs/otel-telemetry.md）。
 *
 * 最小面：门禁与 CLI 同款（无 OTEL_EXPORTER_OTLP_* 端点即完全 no-op——OTel SDK
 * 模块图不加载；ACODE_TELEMETRY=0 opt-out；OTEL_SDK_DISABLED kill-switch；仅
 * http/protobuf，grpc/json 显式拒绝）。启用时只注册带进程级 Resource 身份
 * （app 版本 / 平台 / 进程会话 UUID）的 TracerProvider；**本波不产 desktop 业务
 * span**（登记波外）。机制参照 oh-my-pi（MIT）telemetry-export.ts 的懒加载门禁。
 *
 * 本文件不 import electron（保持纯 node 可单测）；quit 收口经 registerQuitHandler
 * 回调由 index.ts 接线。@opentelemetry/* 全部走函数内动态 import——tsup 将其保留
 * 为 external（package.json dependencies），禁用态零加载。
 */
import { randomUUID } from "node:crypto";

/** 与 CLI env-gate 同构的门禁判定（单一事实源 = specs/otel-telemetry.md 开关矩阵）。 */
export type DesktopTelemetryGateReason =
  | "opt_out"
  | "sdk_disabled"
  | "exporter_none"
  | "exporter_not_otlp"
  | "no_endpoint"
  | "unsupported_protocol";

export type DesktopTelemetryGateDecision =
  | { enabled: true }
  | { enabled: false; reason: DesktopTelemetryGateReason; protocol?: string };

const OPT_OUT_VALUES = new Set(["0", "false", "off"]);

export function resolveDesktopTelemetryGate(
  env: Readonly<Record<string, string | undefined>>,
): DesktopTelemetryGateDecision {
  const master = env.ACODE_TELEMETRY?.trim().toLowerCase();
  if (master !== undefined && OPT_OUT_VALUES.has(master)) {
    return { enabled: false, reason: "opt_out" };
  }
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") {
    return { enabled: false, reason: "sdk_disabled" };
  }
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
  const endpoint =
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint?.trim()) {
    return { enabled: false, reason: "no_endpoint" };
  }
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

/** 显式拒绝类原因的用户可见说明；意图内静默关闭返回 undefined。 */
export function describeDesktopTelemetryRejection(
  decision: DesktopTelemetryGateDecision,
): string | undefined {
  if (decision.enabled) return undefined;
  if (decision.reason === "unsupported_protocol") {
    return `OTEL trace export disabled: protocol ${decision.protocol} is unsupported; only http/protobuf is supported`;
  }
  if (decision.reason === "exporter_not_otlp") {
    return "OTEL trace export disabled: OTEL_TRACES_EXPORTER selects a non-otlp exporter";
  }
  return undefined;
}

export interface DesktopTelemetryInitOptions {
  appVersion: string;
  env?: Readonly<Record<string, string | undefined>>;
  logger?: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  /** quit 收口接线（index.ts 传 app.on("will-quit", ...)）；缺席则不注册。 */
  registerQuitHandler?: (handler: () => void) => void;
  serviceName?: string;
}

export interface DesktopTelemetryHandle {
  shutdown(): Promise<void>;
}

let activeHandle: DesktopTelemetryHandle | undefined;
let initPromise: Promise<DesktopTelemetryHandle | undefined> | undefined;

/**
 * 门禁通过时动态装配进程级 TracerProvider（Resource 身份），否则完全 no-op。
 * 幂等：main 进程只装配一次；失败降级 no-op + warn，绝不阻断桌面启动。
 */
export function initDesktopTelemetry(
  options: DesktopTelemetryInitOptions,
): Promise<DesktopTelemetryHandle | undefined> {
  if (initPromise) return initPromise;

  const env = options.env ?? process.env;
  const logger = options.logger;
  const decision = resolveDesktopTelemetryGate(env);
  if (!decision.enabled) {
    const rejection = describeDesktopTelemetryRejection(decision);
    if (rejection) logger?.warn(`[telemetry] ${rejection}`);
    return Promise.resolve(undefined);
  }

  initPromise = (async () => {
    try {
      // 分支内动态 import：OTel SDK + OTLP exporter 模块图只在启用态加载。
      const [traceSdk, traceExporter, resources] = await Promise.all([
        import("@opentelemetry/sdk-trace-base"),
        import("@opentelemetry/exporter-trace-otlp-proto"),
        import("@opentelemetry/resources"),
      ]);
      // Resource：兜底身份先构造，env detector（OTEL_SERVICE_NAME /
      // OTEL_RESOURCE_ATTRIBUTES 用户自配）merge 在后 = 优先级最高（omp 同款顺序）。
      const resource = resources
        .resourceFromAttributes({
          "service.name": options.serviceName ?? "acode-desktop",
          "service.version": options.appVersion,
          // 进程级会话身份：main 每次启动一个 UUID（不派生自硬件/账号）。
          "service.instance.id": randomUUID(),
          "os.type": process.platform,
        })
        .merge(resources.detectResources({ detectors: [resources.envDetector] }));
      const provider = new traceSdk.BasicTracerProvider({
        resource,
        spanProcessors: [
          new traceSdk.BatchSpanProcessor(new traceExporter.OTLPTraceExporter()),
        ],
      });
      // OTel JS 2.x：无 provider.register()——经 API 全局注册（本波不产 span，
      // 注册只为进程级 Resource 身份与后续波次的 tracer 获取）。
      const api = await import("@opentelemetry/api");
      api.trace.setGlobalTracerProvider(provider);
      const handle: DesktopTelemetryHandle = {
        shutdown: async () => {
          try {
            await provider.shutdown();
          } catch (error) {
            logger?.warn("[telemetry] provider shutdown failed", error);
          }
        },
      };
      activeHandle = handle;
      // will-quit 是同步事件：本波 desktop 不产 span，shutdown 只是清 timer 的
      // best-effort 收口，不 await（不阻塞退出链）。
      options.registerQuitHandler?.(() => {
        void handle.shutdown();
      });
      logger?.info("[telemetry] OTel desktop resource initialized (http/protobuf)");
      return handle;
    } catch (error) {
      initPromise = undefined;
      logger?.warn("[telemetry] OTel initialization failed; continuing without export", error);
      return undefined;
    }
  })();
  return initPromise;
}

/** 当前句柄（诊断用；未启用为 undefined）。 */
export function getDesktopTelemetryHandle(): DesktopTelemetryHandle | undefined {
  return activeHandle;
}
