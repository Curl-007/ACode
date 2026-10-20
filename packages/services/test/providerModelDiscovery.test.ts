import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISCOVERY_MAX_MODELS,
  discoverProviderModelsFromEndpoint,
  extractDiscoveredModelIds,
  resolveDiscoveryEndpoint,
} from "../src/model-provider/providerModelDiscovery.js";

/**
 * 模型发现单测（packages/services/specs/provider-model-discovery.md 验收场景 1）：
 * 端点映射归一、形状容忍、截断、出口纪律、状态映射、鉴权头按 format、key 不进结果。
 */

function jsonResponse(payload: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

function recordingFetch(responder: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url: url.href, headers });
    return responder(url, init ?? {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("端点映射：三档 format 与尾斜杠/已含后缀归一", () => {
  assert.equal(
    resolveDiscoveryEndpoint("https://api.example.com/v1", "openai-chat-completions"),
    "https://api.example.com/v1/models",
  );
  assert.equal(
    resolveDiscoveryEndpoint("https://api.example.com/v1/", "openai-responses"),
    "https://api.example.com/v1/models",
  );
  assert.equal(
    resolveDiscoveryEndpoint("https://api.example.com/v1/models", "openai-chat-completions"),
    "https://api.example.com/v1/models",
  );
  assert.equal(
    resolveDiscoveryEndpoint("https://api.anthropic.com", "anthropic-messages"),
    "https://api.anthropic.com/v1/models",
  );
  assert.equal(
    resolveDiscoveryEndpoint("https://api.anthropic.com/v1", "anthropic-messages"),
    "https://api.anthropic.com/v1/models",
  );
  assert.equal(resolveDiscoveryEndpoint("not-a-url", "openai-chat-completions"), null);
  assert.equal(resolveDiscoveryEndpoint("   ", "openai-chat-completions"), null);
});

test("形状容忍：OpenAI data 形 / object list 形 / 裸数组 / Anthropic 形 / name 兜底 / 非法拒绝", () => {
  assert.deepEqual(extractDiscoveredModelIds({ data: [{ id: "a" }, { id: "b" }] }), ["a", "b"]);
  assert.deepEqual(extractDiscoveredModelIds({ object: "list", data: [{ id: "a" }] }), ["a"]);
  assert.deepEqual(extractDiscoveredModelIds([{ id: "a" }, { name: "n" }]), ["a", "n"]);
  assert.deepEqual(extractDiscoveredModelIds({ data: [{ id: "" }, { id: 7 }, { id: "ok" }] }), [
    "ok",
  ]);
  assert.deepEqual(extractDiscoveredModelIds({ data: [{ id: "a" }, { id: "a" }] }), ["a"]);
  assert.equal(extractDiscoveredModelIds({ models: ["a"] }), null);
  assert.equal(extractDiscoveredModelIds("nope"), null);
});

test("openai 档鉴权头 Bearer；anthropic 档 x-api-key + version；无 key 不带鉴权头", async () => {
  const openai = recordingFetch(() => jsonResponse({ data: [{ id: "m1" }] }));
  const result = await discoverProviderModelsFromEndpoint(
    { baseUrl: "https://api.example.com/v1", apiType: "openai-chat-completions", apiKey: "sk-1" },
    { fetchImpl: openai.fetchImpl },
  );
  assert.equal(result.ok, true);
  assert.equal(openai.calls[0]?.headers.authorization, "Bearer sk-1");

  const anthropic = recordingFetch(() => jsonResponse({ data: [{ id: "m1" }] }));
  await discoverProviderModelsFromEndpoint(
    { baseUrl: "https://api.anthropic.com", apiType: "anthropic-messages", apiKey: "ak-1" },
    { fetchImpl: anthropic.fetchImpl },
  );
  assert.equal(anthropic.calls[0]?.headers["x-api-key"], "ak-1");
  assert.equal(anthropic.calls[0]?.headers["anthropic-version"], "2023-06-01");
  assert.equal(anthropic.calls[0]?.url, "https://api.anthropic.com/v1/models");

  const noKey = recordingFetch(() => jsonResponse({ data: [] }));
  const noKeyResult = await discoverProviderModelsFromEndpoint(
    { baseUrl: "https://api.example.com", apiType: "openai-chat-completions" },
    { fetchImpl: noKey.fetchImpl },
  );
  assert.equal(noKeyResult.ok, true);
  assert.equal(noKey.calls[0]?.headers.authorization, undefined);
});

test("结果只含 id 列表与计数：apiKey 绝不进返回值", async () => {
  const { fetchImpl } = recordingFetch(() => jsonResponse({ data: [{ id: "m1" }, { id: "m2" }] }));
  const result = await discoverProviderModelsFromEndpoint(
    { baseUrl: "https://api.example.com", apiType: "openai-chat-completions", apiKey: "sk-secret" },
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.models, ["m1", "m2"]);
    assert.equal(result.fetchedCount, 2);
    assert.equal(result.truncated, false);
  }
  assert.equal(JSON.stringify(result).includes("sk-secret"), false);
});

test("500 条截断：truncated=true 且 models 封顶", async () => {
  const many = Array.from({ length: DISCOVERY_MAX_MODELS + 7 }, (_, i) => ({ id: `m${i}` }));
  const { fetchImpl } = recordingFetch(() => jsonResponse({ data: many }));
  const result = await discoverProviderModelsFromEndpoint(
    { baseUrl: "https://api.example.com", apiType: "openai-chat-completions" },
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.models.length, DISCOVERY_MAX_MODELS);
    assert.equal(result.truncated, true);
    assert.equal(result.fetchedCount, DISCOVERY_MAX_MODELS + 7);
  }
});

test("出口纪律：非 loopback 明文 http 拒绝；跨 origin 重定向拒绝；同源重定向跟随", async () => {
  const insecure = await discoverProviderModelsFromEndpoint(
    { baseUrl: "http://api.example.com", apiType: "openai-chat-completions" },
    { fetchImpl: (() => jsonResponse({ data: [] })) as typeof fetch },
  );
  assert.deepEqual(insecure, { ok: false, error: { kind: "insecure-url" } });

  const cross = recordingFetch(() =>
    new Response(null, { status: 302, headers: { location: "https://evil.example/models" } }),
  );
  const crossResult = await discoverProviderModelsFromEndpoint(
    { baseUrl: "https://api.example.com", apiType: "openai-chat-completions" },
    { fetchImpl: cross.fetchImpl },
  );
  assert.equal(crossResult.ok, false);
  if (!crossResult.ok) assert.equal(crossResult.error.kind, "redirect-cross-origin");

  let hop = 0;
  const same = recordingFetch((url) => {
    hop += 1;
    if (hop === 1) {
      assert.equal(url.href, "https://api.example.com/models");
      return new Response(null, { status: 301, headers: { location: "/v2/models" } });
    }
    assert.equal(url.href, "https://api.example.com/v2/models");
    return jsonResponse({ data: [{ id: "m1" }] });
  });
  const sameResult = await discoverProviderModelsFromEndpoint(
    { baseUrl: "https://api.example.com", apiType: "openai-chat-completions" },
    { fetchImpl: same.fetchImpl },
  );
  assert.equal(sameResult.ok, true);
});

test("状态映射：401/403/404/其他非 ok", async () => {
  for (const [status, kind] of [
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not-found"],
    [500, "http"],
  ] as const) {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ message: "x" }, { status }));
    const result = await discoverProviderModelsFromEndpoint(
      { baseUrl: "https://api.example.com", apiType: "openai-chat-completions" },
      { fetchImpl },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.kind, kind);
      assert.equal(result.error.httpStatus, status);
    }
  }
});

test("超时：fetch 挂起 → timeout（AbortController 生效）", async () => {
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    await new Promise((resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return resolve(undefined);
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    throw new Error("unreachable");
  }) as typeof fetch;
  const result = await discoverProviderModelsFromEndpoint(
    { baseUrl: "https://api.example.com", apiType: "openai-chat-completions" },
    { fetchImpl },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "timeout");
});

test("网络错误 → network；body 超限 → too-large；非法 JSON → unsupported-shape", async () => {
  const net = recordingFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  const netResult = await discoverProviderModelsFromEndpoint(
    { baseUrl: "https://api.example.com", apiType: "openai-chat-completions" },
    { fetchImpl: net.fetchImpl },
  );
  assert.equal(netResult.ok, false);
  if (!netResult.ok) assert.equal(netResult.error.kind, "network");

  const huge = recordingFetch(
    () => new Response("x".repeat(128), { status: 200, headers: { "content-length": "999999999" } }),
  );
  const hugeResult = await discoverProviderModelsFromEndpoint(
    { baseUrl: "https://api.example.com", apiType: "openai-chat-completions" },
    { fetchImpl: huge.fetchImpl },
  );
  assert.equal(hugeResult.ok, false);
  if (!hugeResult.ok) assert.equal(hugeResult.error.kind, "too-large");

  const bad = recordingFetch(() => new Response("{not json", { status: 200 }));
  const badResult = await discoverProviderModelsFromEndpoint(
    { baseUrl: "https://api.example.com", apiType: "openai-chat-completions" },
    { fetchImpl: bad.fetchImpl },
  );
  assert.equal(badResult.ok, false);
  if (!badResult.ok) assert.equal(badResult.error.kind, "unsupported-shape");
});
