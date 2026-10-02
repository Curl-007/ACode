// ============================================================
// Provider Doctor 实时目录探测（J3-1 / spec R3 #8-#9 + R4）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 只经既有 HttpClientPort 出网（`egressPolicy:"public"` 的 DNS 预检 + 过检建连由适配器负责），
// 本模块不写裸 fetch；发请求前再做一次本地 host 字面校验，保证「先校验后连接」。
// 响应体是不可信输入：只提取模型 id 字符串，其余一律丢弃，且详情文本会再过 redactor。

import {
  buildProviderCatalogHeaders,
  buildProviderCatalogUrl,
  inspectProviderEndpoint,
} from "./endpoint-policy.js";
import type {
  ProviderDoctorHttpPort,
  ProviderDoctorProviderFacts,
} from "./types.js";

const DEFAULT_CATALOG_TIMEOUT_MS = 15_000;
const MAX_CATALOG_MODEL_IDS = 500;

export type ProviderDoctorCatalogProbeStatus = "ok" | "unsupported" | "failed";

export interface ProviderDoctorCatalogProbeResult {
  readonly status: ProviderDoctorCatalogProbeStatus;
  readonly modelIds: readonly string[];
  readonly detail: string;
  readonly httpStatus?: number;
}

export interface ProviderDoctorCatalogProbeInput {
  readonly provider: ProviderDoctorProviderFacts;
  readonly http: ProviderDoctorHttpPort;
  /** 运行期 API Key（内存态）；调用方必须已把它登记进 redactor 的已知真值集合。 */
  readonly apiKey?: string;
  /** 账号型 provider 的请求头鉴权（同样只在内存态流转）。 */
  readonly authHeaders?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** 每次真的发出请求都要计数（花费跟踪，spec R6）。 */
  readonly onNetworkCall?: () => void;
}

export async function probeProviderModelCatalog(
  input: ProviderDoctorCatalogProbeInput,
): Promise<ProviderDoctorCatalogProbeResult> {
  const { provider } = input;
  const url = buildProviderCatalogUrl(provider.baseUrl ?? "", provider.apiType);
  if (!url) {
    return {
      status: "unsupported",
      modelIds: [],
      detail: `api type ${provider.apiType ?? "未知"} 没有可探测的公开目录端点`,
    };
  }

  // 先校验后连接：本地字面判定不通过就绝不发请求（DNS 层校验是检查点 #7 的职责）。
  const verdict = inspectProviderEndpoint(provider.baseUrl);
  if (!verdict.ok) {
    return { status: "failed", modelIds: [], detail: verdict.reason };
  }

  const apiKey = input.apiKey?.trim();
  if (!apiKey && !input.authHeaders) {
    return {
      status: "failed",
      modelIds: [],
      detail: "没有可用于目录请求的凭据（先修 credential_available）",
    };
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    ...(apiKey ? buildProviderCatalogHeaders(provider.apiType, apiKey) : {}),
    ...(input.authHeaders ? input.authHeaders : {}),
  };

  let response: { status: number; bodyText: string };
  try {
    input.onNetworkCall?.();
    response = await input.http.request({
      url,
      headers,
      timeoutMs: input.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    return {
      status: "failed",
      modelIds: [],
      detail: `目录端点请求失败: ${describeError(error)}`,
    };
  }

  if (response.status === 404 || response.status === 405 || response.status === 501) {
    return {
      status: "unsupported",
      modelIds: [],
      detail: `端点不支持目录列举（HTTP ${response.status}）`,
      httpStatus: response.status,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      status: "failed",
      modelIds: [],
      detail: `目录端点返回 HTTP ${response.status}`,
      httpStatus: response.status,
    };
  }

  const parsedCatalog = parseCatalogModelIds(response.bodyText);
  const modelIds = parsedCatalog.ids;
  // 对抗复核 F4：过滤计数进 detail，让「目录 id 与目录样本不一致」可审计。
  const filteredNote =
    parsedCatalog.filteredUnsafeIds > 0
      ? `（过滤 ${parsedCatalog.filteredUnsafeIds} 个含控制字符/反引号/空白的非法 id）`
      : "";
  if (modelIds.length === 0) {
    return {
      status: "failed",
      modelIds: [],
      detail: `目录端点返回 2xx 但没有解析出任何可用模型 id${filteredNote}`,
      httpStatus: response.status,
    };
  }
  return {
    status: "ok",
    modelIds,
    detail: `目录端点返回 ${modelIds.length} 个模型${filteredNote}`,
    httpStatus: response.status,
  };
}

/**
 * 目录 id 的不安全形态：控制字符 / 反引号 / 空白。对抗复核 F4——目录 id 本就不该含
 * 这些（过滤即安全收敛）；被过滤的 id 不进目录样本、不进替代模型建议。命令构造处
 * （checkpoints.providerDoctorCommand）另有字符集白名单兜底。
 */
// 有意匹配控制字符本身（no-control-regex）：目录 id 的不安全形态就是控制字符/反引号/
// 空白，这里必须逐字面拒绝（对抗复核 F4）。
// oxlint-disable-next-line no-control-regex
const UNSAFE_CATALOG_ID_PATTERN = /[\u0000-\u001f\u007f`\s]/;

/** OpenAI 与 Anthropic 的目录响应都是 `{ data: [{ id }] }`；同时容忍裸数组形态。 */
export function parseCatalogModelIds(bodyText: string): {
  ids: readonly string[];
  filteredUnsafeIds: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ids: Object.freeze([]), filteredUnsafeIds: 0 };
  }
  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { data?: unknown } | null)?.data)
      ? ((parsed as { data: unknown[] }).data)
      : [];
  const ids: string[] = [];
  let filteredUnsafeIds = 0;
  for (const item of candidates) {
    const raw =
      typeof item === "string"
        ? item
        : typeof item === "object" && item !== null
          ? (item as { id?: unknown }).id
          : undefined;
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (id.length === 0) continue;
    if (UNSAFE_CATALOG_ID_PATTERN.test(id)) {
      filteredUnsafeIds += 1;
      continue;
    }
    ids.push(id);
    if (ids.length >= MAX_CATALOG_MODEL_IDS) break;
  }
  return { ids: Object.freeze(ids), filteredUnsafeIds };
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  return `${code ? `${code}: ` : ""}${message.replace(/\s+/g, " ").trim().slice(0, 140)}`;
}
