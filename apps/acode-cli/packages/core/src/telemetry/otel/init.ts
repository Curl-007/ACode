/**
 * OTel 遥测懒加载入口（specs/otel-telemetry.md「懒加载时序」）。
 *
 * 机制参照 oh-my-pi（MIT）telemetry-export.ts 的 initTelemetryExport：
 * 门禁不过 = 完全 no-op，`./impl.js` 与整个 @opentelemetry/* 模块图不加载，
 * 默认启动路径零开销。本文件位于静态图，只允许 import 纯 env 判定（env-gate）
 * 与类型；任何 @opentelemetry/* 运行时 import 都必须留在 impl/spans/attributes
 * 的懒加载图内。
 *
 * 幂等：一个进程只装配一次（contracts AgentTelemetryRuntimeOwner 注释同款约束）；
 * 失败 containment：装配异常降级 no-op + warn，绝不阻断 app 启动。
 */
import {
  describeOtelGateRejection,
  resolveOtelTraceGate,
  type OtelTraceGateDecision,
} from "./env-gate.js";
import type { TelemetryLogSink } from "./logger-sink.js";
import type { OtelAgentTelemetryPort } from "./impl-types.js";

export type { OtelTraceGateDecision };

export interface OtelTelemetryInitOptions {
  /** 缺省 process.env；显式传入便于测试与宿主 env 投影。 */
  env?: Readonly<Record<string, string | undefined>>;
  logger?: TelemetryLogSink;
  /** 缺省 "acode-cli"。 */
  serviceName?: string;
  serviceVersion?: string;
  /** CLI=app sessionId；进程级 Resource 身份。 */
  serviceInstanceId?: string;
  /** 缺省 process.platform。 */
  platform?: string;
}

export interface OtelTelemetryHandle {
  readonly port: OtelAgentTelemetryPort;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** 懒加载探针：impl 模块是否已被 init 动态加载（诊断/单测断言零开销门禁用）。 */
let implLoaded = false;
let initPromise: Promise<OtelTelemetryHandle | undefined> | undefined;

export function isOtelImplLoaded(): boolean {
  return implLoaded;
}

/** 门禁判定结果透出（诊断/单测用；不触发任何加载）。 */
export function inspectOtelTraceGate(
  env: Readonly<Record<string, string | undefined>>,
): OtelTraceGateDecision {
  return resolveOtelTraceGate(env);
}

/**
 * 门禁通过时动态装配 OTel trace 运行时并返回 handle；否则返回 undefined 且
 * 不 import impl（无端点零开销零上报）。重复调用返回同一装配结果。
 */
export function initOtelTelemetry(
  options: OtelTelemetryInitOptions = {},
): Promise<OtelTelemetryHandle | undefined> {
  if (initPromise) return initPromise;

  const env = options.env ?? process.env;
  const decision = resolveOtelTraceGate(env);
  if (!decision.enabled) {
    const rejection = describeOtelGateRejection(decision);
    if (rejection) {
      // 只有「显式拒绝」类原因需要用户可见告警（协议误路由/exporter 不实现）；
      // 默认 no-op（无端点）与用户主动关闭保持静默。
      options.logger?.warn(rejection, {
        event: "telemetry.otel.gate.rejected",
        module: "core.telemetry",
        reason: decision.reason,
      });
    }
    return Promise.resolve(undefined);
  }

  initPromise = (async () => {
    try {
      // 分支内动态 import：OTel SDK + OTLP exporter 模块图只在启用态加载。
      const impl = await import("./impl.js");
      implLoaded = true;
      const runtime = impl.createOtelTraceRuntime({
        serviceName: options.serviceName ?? "acode-cli",
        ...(options.serviceVersion ? { serviceVersion: options.serviceVersion } : {}),
        ...(options.serviceInstanceId ? { serviceInstanceId: options.serviceInstanceId } : {}),
        platform: options.platform ?? process.platform,
        ...(options.logger ? { logger: options.logger } : {}),
      });
      options.logger?.info("OTel trace export enabled (http/protobuf)", {
        event: "telemetry.otel.enabled",
        module: "core.telemetry",
        serviceName: options.serviceName ?? "acode-cli",
      });
      const handle: OtelTelemetryHandle = {
        port: runtime.port,
        flush: () => runtime.flush(),
        shutdown: () => runtime.shutdown(),
      };
      return handle;
    } catch (error) {
      // 装配失败降级 no-op：遥测绝不阻断启动（spec 失败 containment）。
      initPromise = undefined;
      options.logger?.warn("OTel telemetry initialization failed; continuing without export", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "telemetry.otel.init.failed",
        module: "core.telemetry",
      });
      return undefined;
    }
  })();
  return initPromise;
}

/**
 * 测试缝：重置幂等装配状态。仅测试使用——生产进程一次装配终身有效，
 * reset 不会卸载已加载的 impl 模块（isOtelImplLoaded 探针保持单调）。
 */
export function resetOtelTelemetryInitForTest(): void {
  initPromise = undefined;
}
