import type { ProviderApiType, ProviderDiscoveryInput } from "@acode/provider";
import { createServiceLogger } from "../logger/serviceLogger.js";

// 模型发现（packages/services/specs/provider-model-discovery.md）：按 provider 已配置
// baseUrl + api 类型向模型列表端点发一次请求并归一模型 id 列表。
// 宿主侧单点：UI 只拿 id 列表与结构化错误，apiKey 只进请求头、绝不进日志/返回值/RPC 视图。
// 出口纪律：只请求配置 baseUrl 同源；跨 origin 重定向一律拒绝；http 仅 loopback。
//
// logger 必须懒创建：本模块经 services 包根进入 renderer 模块图（descriptor 伴生导入），
// 顶层调用 createServiceLogger 会在浏览器 import 期执行并触 process is not defined
// 炸掉整个渲染模块图（D-C1 同款缺陷，2026-10-19 灰屏实证）。发现请求只在 host 执行，
// 懒创建保证浏览器侧 import 零副作用。
let discoveryLog: ReturnType<typeof createServiceLogger> | null = null;
function log(): ReturnType<typeof createServiceLogger> {
  discoveryLog ??= createServiceLogger("provider-model-discovery");
  return discoveryLog;
}

export const DISCOVERY_TIMEOUT_MS = 10_000;
export const DISCOVERY_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DISCOVERY_MAX_MODELS = 500;
const MAX_SAME_ORIGIN_REDIRECTS = 3;

export type ProviderModelDiscoveryErrorKind =
  | "network"
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "unsupported-shape"
  | "too-large"
  | "insecure-url"
  | "redirect-cross-origin"
  | "no-base-url"
  | "http";

export type ProviderModelDiscoveryResult =
  | {
      ok: true;
      models: string[];
      truncated: boolean;
      fetchedCount: number;
      durationMs: number;
    }
  | { ok: false; error: { kind: ProviderModelDiscoveryErrorKind; httpStatus?: number } };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""));
}

/** 端点映射单点（spec 产品规则 3）：归一尾斜杠与已含后缀的 baseUrl，不重复拼段、不产双斜杠。 */
export function resolveDiscoveryEndpoint(baseUrl: string, apiType: ProviderApiType): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // 根路径 pathname="/" 与 origin 拼接会产双斜杠；归一为空段再拼。
  const base = `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
  if (apiType === "anthropic-messages") {
    return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
  }
  return base.endsWith("/models") ? base : `${base}/models`;
}

function discoveryHeaders(apiType: ProviderApiType, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) {
    if (apiType === "anthropic-messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${apiKey}`;
    }
  }
  return headers;
}

/** 响应形状容忍（spec 产品规则 4）：OpenAI {data:[{id}]} / {object:"list",data} / 裸数组 / Anthropic {data:[{id}]}。 */
export function extractDiscoveredModelIds(payload: unknown): string[] | null {
  const items: unknown[] | null = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data)
      : null;
  if (!items) return null;
  const ids: string[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const record = item as { id?: unknown; name?: unknown };
    const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : null;
    if (id && id.trim().length > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface DiscoverProviderModelsOptions {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export async function discoverProviderModelsFromEndpoint(
  input: ProviderDiscoveryInput,
  options: DiscoverProviderModelsOptions = {},
): Promise<ProviderModelDiscoveryResult> {
  const startedAt = (options.nowMs ?? Date.now)();
  const endpoint = resolveDiscoveryEndpoint(input.baseUrl, input.apiType);
  if (!endpoint) {
    return { ok: false, error: { kind: "no-base-url" } };
  }
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    return { ok: false, error: { kind: "no-base-url" } };
  }
  if (endpointUrl.protocol === "http:" && !isLoopbackUrl(endpointUrl)) {
    log().warn("发现请求拒绝非 loopback 明文 http", { baseUrl: redactBaseUrl(endpoint) });
    return { ok: false, error: { kind: "insecure-url" } };
  }
  if (endpointUrl.protocol !== "https:" && endpointUrl.protocol !== "http:") {
    return { ok: false, error: { kind: "insecure-url" } };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  let target = endpointUrl;
  try {
    for (let hop = 0; ; hop++) {
      const response = await fetchImpl(target, {
        method: "GET",
        headers: discoveryHeaders(input.apiType, input.apiKey),
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || hop >= MAX_SAME_ORIGIN_REDIRECTS) {
          return { ok: false, error: { kind: "redirect-cross-origin", httpStatus: response.status } };
        }
        const next = new URL(location, target);
        if (next.origin !== target.origin) {
          log().warn("发现请求拒绝跨 origin 重定向", {
            from: redactBaseUrl(target.href),
            to: redactBaseUrl(next.href),
          });
          return { ok: false, error: { kind: "redirect-cross-origin", httpStatus: response.status } };
        }
        target = next;
        continue;
      }
      if (!response.ok) {
        return { ok: false, error: { kind: mapHttpStatus(response.status), httpStatus: response.status } };
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > DISCOVERY_MAX_BODY_BYTES) {
        return { ok: false, error: { kind: "too-large" } };
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > DISCOVERY_MAX_BODY_BYTES) {
        return { ok: false, error: { kind: "too-large" } };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(buffer));
      } catch {
        return { ok: false, error: { kind: "unsupported-shape" } };
      }
      const ids = extractDiscoveredModelIds(payload);
      if (!ids) {
        log().warn("发现响应形状不匹配", { baseUrl: redactBaseUrl(target.href) });
        return { ok: false, error: { kind: "unsupported-shape" } };
      }
      const truncated = ids.length > DISCOVERY_MAX_MODELS;
      log().info("模型发现完成", {
        baseUrl: redactBaseUrl(target.href),
        status: response.status,
        fetchedCount: ids.length,
        durationMs: (options.nowMs ?? Date.now)() - startedAt,
      });
      return {
        ok: true,
        models: ids.slice(0, DISCOVERY_MAX_MODELS),
        truncated,
        fetchedCount: ids.length,
        durationMs: (options.nowMs ?? Date.now)() - startedAt,
      };
    }
  } catch (error) {
    const timedOut = controller.signal.aborted;
    log().warn("模型发现请求失败", {
      baseUrl: redactBaseUrl(target.href),
      kind: timedOut ? "timeout" : "network",
    });
    return { ok: false, error: { kind: timedOut ? "timeout" : "network" } };
  } finally {
    clearTimeout(timer);
  }
}

function mapHttpStatus(status: number): ProviderModelDiscoveryErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  return "http";
}

/** 日志脱敏：只保留 origin+path，去 query（可能含凭据/签名）。 */
function redactBaseUrl(href: string): string {
  try {
    const url = new URL(href);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}
