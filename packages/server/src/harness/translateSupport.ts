// 拆分依据：translate.ts 超 400 行架构上限。方法级错误类型、not_supported 降级构造、
// 翻译上下文与方法入参校验（H2：schema safeParse + 未知字段剥离）是翻译桥的地基，
// 不依赖事件投影 / run 等待 / 方法分发表，独立成叶子。
import type { ServiceCollection } from "@acode/services";
import type { z } from "zod";
import { harnessMethodParamsSchemas } from "@acode/shared/harness-api";

/** 方法级错误：server.ts 捕获后落 response.error 帧。 */
export class HarnessMethodError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function notSupported(
  method: string,
  reason: string,
  alternative?: string,
): HarnessMethodError {
  return new HarnessMethodError(
    "not_supported",
    `harness method '${method}' is not supported: ${reason}`,
    {
      method,
      reason,
      ...(alternative ? { alternative } : {}),
    },
  );
}

export interface HarnessTranslateContext {
  /** 取 ServiceCollection；懒构造让握手/降级路径不必初始化完整服务面。 */
  getServices(): Promise<ServiceCollection>;
  /** run 轮询等待 turn 终态的预算；缺省 10 分钟。 */
  runTimeoutMs?: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type Handler = (params: unknown) => Promise<unknown>;

/**
 * H2：入参经 shared 方法面 schema（harnessMethodParamsSchemas）safeParse。
 * 错误形状稳定：code=invalid_params + message + details.issues[{path,message}]
 * （字段路径点分，如 "content" / "model.modelId"）。
 * 兼容铁律对齐 parseFrameLoose：校验前剥离未知字段（additive 演进的新客户端字段
 * 不打坏老服务端），已声明字段做严格类型校验（终结 String(undefined) 变形透传）。
 */
export function parseHarnessMethodParams<M extends keyof typeof harnessMethodParamsSchemas>(
  method: M,
  params: unknown,
): z.output<(typeof harnessMethodParamsSchemas)[M]> {
  const schema = harnessMethodParamsSchemas[method];
  const shape =
    schema && typeof schema === "object" && "shape" in schema
      ? Object.keys((schema as z.ZodObject<z.ZodRawShape>).shape)
      : undefined;
  const stripped: Record<string, unknown> = {};
  if (isRecord(params)) {
    if (shape) {
      for (const key of shape) {
        if (key in params) stripped[key] = params[key];
      }
    } else {
      Object.assign(stripped, params);
    }
  } else if (params !== undefined) {
    throw new HarnessMethodError(
      "invalid_params",
      `params of '${method}' must be an object`,
      { method, issues: [{ path: "", message: "params must be an object" }] },
    );
  }
  const result = schema.safeParse(stripped);
  if (!result.success) {
    // 字段路径点分化（zod path 可能含 number/symbol 段，显式 String 化）。
    const pathOf = (path: PropertyKey[]): string =>
      path.map((segment) => String(segment)).join(".") || "(root)";
    throw new HarnessMethodError(
      "invalid_params",
      `invalid params for '${method}': ${result.error.issues
        .map((issue) => `${pathOf(issue.path)} ${issue.message}`)
        .join("; ")}`,
      {
        method,
        issues: result.error.issues.map((issue) => ({
          path: pathOf(issue.path),
          message: issue.message,
        })),
      },
    );
  }
  return result.data as z.output<(typeof harnessMethodParamsSchemas)[M]>;
}
