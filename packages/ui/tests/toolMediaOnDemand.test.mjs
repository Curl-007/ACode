// U11 工具图片按需读取的纯逻辑测试（spec: packages/ui/specs/tool-media-on-demand.md）。
// 无 jsdom：本文件覆盖「字节只在请求时读取」的节流判据、缓存去重、reconnect 换代失效、
// objectURL 生命周期、降级展示态与 sessionId 还原。字节读取用**计数 fetcher**注入证明。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildToolMediaInlineDataUrl,
  createToolMediaLoader,
  decodeToolMediaSessionId,
  resolveToolMediaRenderState,
  shouldFetchToolMediaBytes,
  toolMediaCacheKey,
} from "../src/lib/toolMediaOnDemand.js";

const SESSION = "sess-owner";
const REF = `acode-artifact://${encodeURIComponent(SESSION)}/art-001`;

/** 计数 fetcher：证明「fetch happens 0 times until the image is requested」。 */
function countingFetcher(result = { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" }) {
  const calls = [];
  return {
    calls,
    fetchBytes: (request, signal) => {
      calls.push({ request, signal });
      return Promise.resolve(result);
    },
  };
}

// ── sessionId 还原（fail-closed）──

test("U11-A2: 从 ref authority 还原 owning sessionId", () => {
  assert.equal(decodeToolMediaSessionId(REF), SESSION);
});

test("U11-A3: 形态非法/伪造 ref 还原为 null（fail-closed，不猜 session）", () => {
  assert.equal(decodeToolMediaSessionId("file:///etc/passwd"), null);
  assert.equal(
    decodeToolMediaSessionId(`acode-artifact://${encodeURIComponent(SESSION)}/../x`),
    null,
  );
  assert.equal(decodeToolMediaSessionId("acode-artifact://sess/art:stream"), null);
  assert.equal(decodeToolMediaSessionId(123), null);
  // authority 非法 percent-encoding（%E0%A4%A 截断）→ 拒绝而非抛。
  assert.equal(decodeToolMediaSessionId("acode-artifact://%E0%A4%A/art"), null);
});

// ── 节流判据：只在 ref + 可见/预览 + 无字节 + 未错误 时读取 ──

test("U11-A1: inline 形态永不触发读取（字节已在 row）", () => {
  assert.equal(
    shouldFetchToolMediaBytes({
      kind: "inline",
      hasBytes: false,
      visible: true,
      previewOpen: true,
      errored: false,
    }),
    false,
  );
});

test("U11-A1: ref 形态未进入视口/未打开预览 → 不读取", () => {
  assert.equal(
    shouldFetchToolMediaBytes({
      kind: "ref",
      hasBytes: false,
      visible: false,
      previewOpen: false,
      errored: false,
    }),
    false,
  );
});

test("U11-A2: ref 形态进入视口或打开预览 → 读取", () => {
  assert.equal(
    shouldFetchToolMediaBytes({
      kind: "ref",
      hasBytes: false,
      visible: true,
      previewOpen: false,
      errored: false,
    }),
    true,
  );
  assert.equal(
    shouldFetchToolMediaBytes({
      kind: "ref",
      hasBytes: false,
      visible: false,
      previewOpen: true,
      errored: false,
    }),
    true,
  );
});

test("U11-A2: 已有字节 / 已错误 → 不再自动读取（错误只等显式 retry）", () => {
  assert.equal(
    shouldFetchToolMediaBytes({
      kind: "ref",
      hasBytes: true,
      visible: true,
      previewOpen: true,
      errored: false,
    }),
    false,
  );
  assert.equal(
    shouldFetchToolMediaBytes({
      kind: "ref",
      hasBytes: false,
      visible: true,
      previewOpen: true,
      errored: true,
    }),
    false,
  );
});

// ── 降级展示态 ──

test("U11-A5: 展示态推导——inline/idle/loading/ready/error 各有终态，不静默空白", () => {
  assert.equal(
    resolveToolMediaRenderState({
      kind: "inline",
      requested: false,
      loading: false,
      hasBytes: true,
      error: false,
    }),
    "inline",
  );
  assert.equal(
    resolveToolMediaRenderState({
      kind: "ref",
      requested: false,
      loading: false,
      hasBytes: false,
      error: false,
    }),
    "idle",
  );
  assert.equal(
    resolveToolMediaRenderState({
      kind: "ref",
      requested: true,
      loading: true,
      hasBytes: false,
      error: false,
    }),
    "loading",
  );
  assert.equal(
    resolveToolMediaRenderState({
      kind: "ref",
      requested: true,
      loading: false,
      hasBytes: true,
      error: false,
    }),
    "ready",
  );
  // 错误优先于其它态：即便 requested/loading 也进 error 终态。
  assert.equal(
    resolveToolMediaRenderState({
      kind: "ref",
      requested: true,
      loading: true,
      hasBytes: false,
      error: true,
    }),
    "error",
  );
});

// ── 缓存键含 session/ref/generation（§5.5 不能仅按文件名缓存）──

test("U11-A2: 缓存键包含 session + ref + generation", () => {
  const k0 = toolMediaCacheKey({ sessionId: SESSION, ref: REF }, 0);
  const k1 = toolMediaCacheKey({ sessionId: SESSION, ref: REF }, 1);
  const other = toolMediaCacheKey({ sessionId: "sess-b", ref: REF }, 0);
  assert.notEqual(k0, k1, "generation 变化 → 键变化");
  assert.notEqual(k0, other, "session 变化 → 键变化");
});

// ── loader：按需读取一次 + 去重 + 换代失效 + URL 生命周期 ──

test("U11-A2: loader 未请求时 fetch 0 次；请求后读一次并复用缓存（重复预览不再读）", async () => {
  const fetcher = countingFetcher();
  const loader = createToolMediaLoader({
    fetchBytes: fetcher.fetchBytes,
    createObjectUrl: () => "blob:1",
    revokeObjectUrl: () => {},
  });
  assert.equal(fetcher.calls.length, 0, "构造即读 = 违反按需");

  const first = await loader.load({ sessionId: SESSION, ref: REF });
  assert.equal(fetcher.calls.length, 1);
  assert.equal(first.objectUrl, "blob:1");
  assert.equal(first.mediaType, "image/png");

  // 重复预览：命中缓存，fetch 仍是 1 次。
  const second = await loader.load({ sessionId: SESSION, ref: REF });
  assert.equal(fetcher.calls.length, 1, "重复预览应复用缓存，不再读字节");
  assert.equal(second.objectUrl, "blob:1");
  loader.dispose();
});

test("U11-A2: 并发请求去重（同一 ref 只读一次）", async () => {
  const fetcher = countingFetcher();
  const loader = createToolMediaLoader({
    fetchBytes: fetcher.fetchBytes,
    createObjectUrl: () => "blob:c",
    revokeObjectUrl: () => {},
  });
  const [a, b] = await Promise.all([
    loader.load({ sessionId: SESSION, ref: REF }),
    loader.load({ sessionId: SESSION, ref: REF }),
  ]);
  assert.equal(fetcher.calls.length, 1, "并发应共享同一次 in-flight 读取");
  assert.equal(a.objectUrl, "blob:c");
  assert.equal(b.objectUrl, "blob:c");
  loader.dispose();
});

test("U11-A2: reconnect（bumpGeneration）后重新读取并重新授权，旧缓存失效", async () => {
  const fetcher = countingFetcher();
  const revoked = [];
  const loader = createToolMediaLoader({
    fetchBytes: fetcher.fetchBytes,
    createObjectUrl: () => `blob:gen`,
    revokeObjectUrl: (url) => revoked.push(url),
  });
  await loader.load({ sessionId: SESSION, ref: REF });
  assert.equal(fetcher.calls.length, 1);
  assert.equal(loader.generation(), 0);

  // 模拟重连：换代。旧 objectURL 立即释放。
  loader.bumpGeneration();
  assert.equal(loader.generation(), 1);
  assert.deepEqual(revoked, ["blob:gen"], "换代必须 revoke 旧 objectURL");
  assert.equal(loader.stats().entries, 0, "换代后旧缓存清空");

  // 重连后预览仍能解析：重新读取（重新走 gateway 授权）。
  const after = await loader.load({ sessionId: SESSION, ref: REF });
  assert.equal(fetcher.calls.length, 2, "重连后应重新读取");
  assert.equal(after.objectUrl, "blob:gen");
  loader.dispose();
});

test("U11-A5: 读到一半切换会话/换代 → 旧结果不写入新缓存、不污染新视图", async () => {
  let resolveFetch;
  const loader = createToolMediaLoader({
    fetchBytes: () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    createObjectUrl: () => "blob:stale",
    revokeObjectUrl: () => {},
  });
  const pending = loader.load({ sessionId: SESSION, ref: REF });
  // 在途时换代（切会话/重连）。
  loader.bumpGeneration();
  resolveFetch({ bytes: new Uint8Array([9]), mediaType: "image/png" });
  const stale = await pending;
  // 旧结果不写进新代际缓存：objectUrl 为 null（当前代际无此条目）。
  assert.equal(stale.objectUrl, null, "换代后在途结果不得污染新视图");
  assert.equal(loader.stats().entries, 0);
  loader.dispose();
});

test("U11-A3: fetch 失败 → 拒绝（调用方进 error 终态），不负缓存钉死", async () => {
  const loader = createToolMediaLoader({
    fetchBytes: () => Promise.reject(new Error("fault.attachment.previewRefNotAuthorized")),
    createObjectUrl: () => "blob:x",
    revokeObjectUrl: () => {},
  });
  await assert.rejects(
    () => loader.load({ sessionId: SESSION, ref: REF }),
    /previewRefNotAuthorized/,
  );
  assert.equal(loader.stats().entries, 0, "失败不得写缓存");
  // 显式 retry 可再次尝试（不被负缓存挡住）。
  await assert.rejects(() => loader.load({ sessionId: SESSION, ref: REF }));
  loader.dispose();
});

test("U11-A5: dispose 释放全部 objectURL", () => {
  const revoked = [];
  const loader = createToolMediaLoader({
    fetchBytes: () => Promise.resolve({ bytes: new Uint8Array([1]), mediaType: "image/png" }),
    createObjectUrl: () => "blob:d",
    revokeObjectUrl: (url) => revoked.push(url),
  });
  // 同步塞一条缓存：借 load 的 then 路径。
  return loader.load({ sessionId: SESSION, ref: REF }).then(() => {
    loader.dispose();
    assert.deepEqual(revoked, ["blob:d"]);
    assert.equal(loader.stats().entries, 0);
  });
});

test("U11-A2: 缓存超过 maxEntries 时按最旧访问逐出并 revoke（有界）", async () => {
  const revoked = [];
  let n = 0;
  const loader = createToolMediaLoader({
    fetchBytes: () => Promise.resolve({ bytes: new Uint8Array([1]), mediaType: "image/png" }),
    createObjectUrl: () => `blob:${++n}`,
    revokeObjectUrl: (url) => revoked.push(url),
    maxEntries: 2,
  });
  await loader.load({ sessionId: SESSION, ref: "acode-artifact://sess-owner/a" });
  await loader.load({ sessionId: SESSION, ref: "acode-artifact://sess-owner/b" });
  await loader.load({ sessionId: SESSION, ref: "acode-artifact://sess-owner/c" });
  assert.ok(loader.stats().entries <= 2, "缓存条目受 maxEntries 约束");
  assert.ok(revoked.length >= 1, "逐出即 revoke，不泄漏 URL");
  loader.dispose();
});

// ── inline data URL（向后兼容：旧 inline row 仍渲染）──

test("U11-A4: inline 形态构造 data URL（旧 row 不回归）", () => {
  assert.equal(
    buildToolMediaInlineDataUrl({ base64: "aGVsbG8=", mimeType: "image/png" }),
    "data:image/png;base64,aGVsbG8=",
  );
  // ref 形态没有内联 data URL（字节需按需读取）。
  assert.equal(buildToolMediaInlineDataUrl({ ref: REF, mimeType: "image/png", bytes: 5 }), null);
});
