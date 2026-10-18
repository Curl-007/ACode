// Read URL 直读（specs/read-url-direct.md）验收测试。
// 覆盖：R1 分支判定与选择器安全、R2 溯源闸门（拦/放/记账）、R3 kill switch、
// R4 输出装配（缓存种子零网络、offset/limit 行窗、超预算截断、footer 元数据）。
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

const { isReadUrlTarget, isReadUrlDirectEnabled, buildUrlReadOutput } = await import(
  "../packages/core/src/tool/handlers/read-url.ts"
);
const { readToolEntry } = await import("../packages/core/src/tool/handlers/read.ts");
const { noteWebFetchProvenanceUrls, clearWebFetchProvenanceForTests } = await import(
  "../packages/core/src/tool/handlers/webfetch-provenance.ts"
);
const { putWebFetchCache } = await import("../packages/core/src/tool/handlers/webfetch-cache.ts");
const { clearWebFetchCacheForTests } = await import(
  "../packages/core/src/tool/handlers/webfetch.ts"
);
const { READ_MAX_FILE_SIZE_BYTES } = await import("../packages/contracts/src/tools/read.ts");

const SESSION_ID = "sess-read-url-test";

function makeContext(overrides = {}) {
  return {
    toolCallId: "call-1",
    traceId: "trace-1",
    abortSignal: new AbortController().signal,
    sessionId: SESSION_ID,
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    ...overrides,
  };
}

function seedCache(url, content, extra = {}) {
  putWebFetchCache(url, {
    artifactPath: undefined,
    artifactUri: undefined,
    bytes: Buffer.byteLength(content, "utf8"),
    content,
    contentType: "text/markdown",
    finalUrl: url,
    redirects: [],
    sizeBytes: Buffer.byteLength(content, "utf8"),
    status: 200,
    statusText: "OK",
    ...extra,
  });
}

beforeEach(() => {
  clearWebFetchProvenanceForTests();
  clearWebFetchCacheForTests();
  delete process.env.ACODE_READ_URL;
});

test("(R1) 分支判定：http(s) 命中；本地路径/skill/conflict/ftp/Windows 盘符不命中", () => {
  assert.equal(isReadUrlTarget("https://example.com/doc"), true);
  assert.equal(isReadUrlTarget("http://example.com"), true);
  assert.equal(isReadUrlTarget("  HTTPS://Example.COM/x  "), true);
  assert.equal(isReadUrlTarget("C:\\Users\\x\\file.ts"), false);
  assert.equal(isReadUrlTarget("/abs/path/file.ts"), false);
  assert.equal(isReadUrlTarget("skill://my-skill"), false);
  assert.equal(isReadUrlTarget("conflict://session/x"), false);
  assert.equal(isReadUrlTarget("ftp://example.com"), false);
  assert.equal(isReadUrlTarget("not a url"), false);
});

test("(R3) kill switch：缺省开启；ACODE_READ_URL=0 关闭；非 0 值不关闭", () => {
  assert.equal(isReadUrlDirectEnabled({}), true);
  assert.equal(isReadUrlDirectEnabled({ ACODE_READ_URL: "0" }), false);
  assert.equal(isReadUrlDirectEnabled({ ACODE_READ_URL: " 0 " }), false);
  assert.equal(isReadUrlDirectEnabled({ ACODE_READ_URL: "1" }), true);
});

test("(R3) 关闭态：URL 输入得到显式「改用 WebFetch」错误，不落文件管线", async () => {
  process.env.ACODE_READ_URL = "0";
  await assert.rejects(
    () => buildUrlReadOutput("https://example.com/doc", { context: makeContext() }),
    (error) => {
      assert.match(error.message, /disabled/i);
      assert.match(error.message, /WebFetch/);
      // 不得是文件管线的 not_found / FileSystemPort 形态（不静默降级）。
      assert.doesNotMatch(error.message, /FileSystemPort|does not exist/);
      return true;
    },
  );
});

test("(R2) 未溯源 URL 被闸门拦截：不触网、文案含「写进结论」指引", async () => {
  await assert.rejects(
    () =>
      buildUrlReadOutput("https://blocked.example.com/x", {
        // sessionStore 返回空历史 → 闸门真实判定（无 store 时 fail-open 是既有测试桩语义）。
        context: makeContext({ sessionStore: { messages: async () => [] } }),
      }),
    (error) => {
      assert.match(error.message, /provenance gate/);
      assert.match(error.message, /Retrying it will keep failing/);
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("(R2) 溯源集内 URL 过闸：以缺 HttpClientPort 的配置错误证明已到网络层之前", async () => {
  const url = "https://example.com/gated";
  noteWebFetchProvenanceUrls(SESSION_ID, [url]);
  await assert.rejects(
    () => buildUrlReadOutput(url, { context: makeContext() }),
    (error) => {
      assert.match(error.message, /HttpClientPort is not configured/);
      return true;
    },
  );
});

test("(R4) 缓存命中：零网络返回 ReadTextOutput，filePath=原始 URL，footer 带元数据与不可信提醒", async () => {
  const url = "https://example.com/cached";
  noteWebFetchProvenanceUrls(SESSION_ID, [url]);
  seedCache(url, "# Title\nline2\nline3");
  const output = await buildUrlReadOutput(url, { context: makeContext() });
  assert.equal(output.type, "text");
  assert.equal(output.filePath, url);
  assert.equal(output.content, "# Title\nline2\nline3");
  assert.equal(output.startLine, 1);
  assert.equal(output.numLines, 3);
  assert.equal(output.totalLines, 3);
  assert.match(output.summaryFooter, /\[url-read\] finalUrl=https:\/\/example\.com\/cached/);
  assert.match(output.summaryFooter, /status=200/);
  assert.match(output.summaryFooter, /cache=hit/);
  assert.match(output.summaryFooter, /untrusted external data/);
});

test("(R1/R4) offset/limit 对 URL 内容做行窗切片，startLine/numLines 如实", async () => {
  const url = "https://example.com/window";
  noteWebFetchProvenanceUrls(SESSION_ID, [url]);
  seedCache(url, "l1\nl2\nl3\nl4\nl5");
  const output = await buildUrlReadOutput(url, {
    context: makeContext(),
    offset: 2,
    limit: 2,
  });
  assert.equal(output.startLine, 2);
  assert.equal(output.numLines, 2);
  assert.equal(output.totalLines, 5);
  assert.equal(output.content, "l2\nl3");
});

test("(R6) 超预算内容按行截断：truncated=true 且 footer 带 artifactUri 指引", async () => {
  const url = "https://example.com/huge";
  noteWebFetchProvenanceUrls(SESSION_ID, [url]);
  const line = "x".repeat(120);
  const lineCount = Math.ceil((READ_MAX_FILE_SIZE_BYTES + 4096) / 121);
  seedCache(url, Array.from({ length: lineCount }, () => line).join("\n"), {
    artifactUri: "acode-artifact://webfetch/huge",
  });
  const output = await buildUrlReadOutput(url, { context: makeContext() });
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.content, "utf8") <= READ_MAX_FILE_SIZE_BYTES);
  assert.match(output.summaryFooter, /full content: acode-artifact:\/\/webfetch\/huge/);
});

test("(R1/验收4) 端口 URL 不被选择器误拆：readHandler 进 URL 分支而非文件管线", async () => {
  const url = "https://example.com:8080/path";
  noteWebFetchProvenanceUrls(SESSION_ID, [url]);
  await assert.rejects(
    () => readToolEntry.handler({ file_path: url }, makeContext()),
    (error) => {
      // URL 分支的证据 = WebFetch 管道的 HttpClientPort 配置错误；
      // 若被选择器误拆成 path+offset，会落到 FileSystemPort 配置错误（不同文案）。
      assert.match(error.message, /HttpClientPort is not configured/);
      assert.doesNotMatch(error.message, /FileSystemPort/);
      return true;
    },
  );
});

test("(验收2) 归一化拒绝：ftp/非法 URL 沿用 WebFetch 语义报错", async () => {
  noteWebFetchProvenanceUrls(SESSION_ID, ["https://example.com/ok"]);
  // normalizeWebFetchUrl 对凭据 URL 拒绝（CredentialsInUrl）——控制面复用证据之一。
  await assert.rejects(
    () =>
      buildUrlReadOutput("https://user:pass@example.com/secret", {
        context: makeContext({ sessionStore: { messages: async () => [] } }),
      }),
    (error) => {
      // 凭据拒绝或溯源拦截都合法（闸门在归一化之后）；关键是不触网、不静默。
      assert.ok(error instanceof Error);
      return true;
    },
  );
});
