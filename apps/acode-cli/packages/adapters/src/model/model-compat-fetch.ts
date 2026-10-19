// ============================================================
// compat 转换管道 fetch 包装（omp 价值提取波 2 · WI-12）
// ============================================================
// spec: apps/acode-cli/specs/model-compat-flags.md R4/R5。
// 链路位置（结构修补先、字段 patch 后写入）：
//   SDK → sdk-compat fetch（response 侧） → 本管道 → option-map fetch（CEL 字段 patch）
//       → business-error fetch → gateway/proxy transport
// 与 model-option-map-fetch 的 fail 语义刻意不同：option-map 是 reasoning/maxOutput
// 字段的唯一权威，非文本 body 必须 fail-closed（静默跳过 = 丢选项）；compat 修补失败
// 会被 provider 显式 4xx / SSE 业务码接住并进入既有 failure-classifier/retry 轨道，
// 因此非文本 / 非 JSON body 一律 fail-open 直通（保持无管道时的字节级行为）。

import type { JsonObject } from "@acode/model-option-map";
import type { ResolvedModelCompatData } from "@acode/shared/model-config";
import { hasCompatFlags } from "./model-compat-rules.js";
import { applyCompatTransforms } from "./model-compat-transforms.js";

type ProviderFetch = typeof globalThis.fetch;

export function createCompatTransformFetch(input: {
  readonly fetch: ProviderFetch;
  readonly flags: ResolvedModelCompatData;
}): ProviderFetch {
  return async (request, init) => {
    // 无任何已启用标志：不读 body 直接直通（零开销 + 字节级零变化，验收锚点）。
    if (!hasCompatFlags(input.flags)) {
      return input.fetch(request, init);
    }
    const bodyText = await readRequestBody(request, init);
    if (bodyText === undefined) {
      return input.fetch(request, init);
    }
    const body = tryParseJsonObject(bodyText);
    if (body === undefined) {
      return input.fetch(request, init);
    }
    const transformed = applyCompatTransforms(body, input.flags);
    if (transformed === body) {
      // 全部转换器 no-op：转发原 request，不重新序列化（字节不变）。
      return input.fetch(request, init);
    }
    const transformedBody = JSON.stringify(transformed);
    if (request instanceof Request) {
      return input.fetch(new Request(request, { ...init, body: transformedBody }));
    }
    return input.fetch(request, { ...init, body: transformedBody });
  };
}

async function readRequestBody(
  request: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  // 非文本 body（流/FormData 等）不做结构修补：直通保持既有行为（fail-open，见头注）。
  if (init?.body !== undefined && init.body !== null) return undefined;
  if (request instanceof Request) return await request.clone().text();
  return undefined;
}

function tryParseJsonObject(body: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as JsonObject;
  } catch {
    return undefined;
  }
}
