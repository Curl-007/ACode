import assert from "node:assert/strict";
import test from "node:test";
import {
  extractAssistantVisualizeReferences,
  projectAssistantVisualizeReferences,
} from "../src/lib/assistantVisualizeReference.js";
import {
  buildVisualizationSandboxDocument,
  fetchVisualizationFragment,
  isOversizedVisualization,
  isVisualizationArtifactRow,
  parseVisualizationArtifactRef,
  VISUALIZATION_CHUNK_BYTES,
  VISUALIZATION_CSP_DIRECTIVE,
  VISUALIZATION_IFRAME_SANDBOX,
  VISUALIZATION_REF_PREFIX,
} from "../src/lib/visualizationSandbox.js";
import { VISUALIZATION_LIMITS } from "@acode/shared/acode-protocol-v4";
import type { ConversationVisualizationReadChunk } from "../src/v4/conversationRowContext.js";

/**
 * 对话内可视化卡片（specs/gen-ui-visualize-card.md）的安全回归守护。
 * 组件渲染没有 DOM 测试先例（包内测试全部是纯逻辑 node:test），这里守护同规格
 * 列出的可断言不变量：CSP 串、sandbox 能力面、ref 解析、正文剥离与分块读取纪律。
 */

const CSP_CDN_SOURCES = [
  "cdnjs.cloudflare.com",
  "esm.sh",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "fonts.bunny.net",
];

function chunk(
  bytes: Uint8Array,
  totalBytes: number,
  nextOffset: number | null,
): ConversationVisualizationReadChunk {
  return { bytes, mediaType: "text/html", totalBytes, nextOffset };
}

const encoder = new TextEncoder();

test("sandbox 能力面只有 allow-scripts，绝不出现 allow-same-origin", () => {
  assert.equal(VISUALIZATION_IFRAME_SANDBOX, "allow-scripts");
  assert.ok(!VISUALIZATION_IFRAME_SANDBOX.includes("allow-same-origin"));
  assert.ok(!VISUALIZATION_IFRAME_SANDBOX.includes("allow-popups"));
  assert.ok(!VISUALIZATION_IFRAME_SANDBOX.includes("allow-forms"));
  assert.ok(!VISUALIZATION_IFRAME_SANDBOX.includes("allow-top-navigation"));
});

test("CSP 拦截外联数据通道（connect-src 'none'）且默认全拒", () => {
  assert.ok(VISUALIZATION_CSP_DIRECTIVE.includes("default-src 'none'"));
  assert.ok(VISUALIZATION_CSP_DIRECTIVE.includes("connect-src 'none'"));
  assert.ok(VISUALIZATION_CSP_DIRECTIVE.includes("form-action 'none'"));
  assert.ok(VISUALIZATION_CSP_DIRECTIVE.includes("base-uri 'none'"));
  // 白名单 CDN 只出现在 script/style/img/font 四个面；connect 面不得携带任何主机。
  const connectDirective = VISUALIZATION_CSP_DIRECTIVE.split("; ").find((directive) =>
    directive.startsWith("connect-src"),
  );
  assert.equal(connectDirective, "connect-src 'none'");
  for (const source of CSP_CDN_SOURCES) {
    assert.ok(VISUALIZATION_CSP_DIRECTIVE.includes(source));
  }
});

test("沙箱文档注入 meta CSP、主题变量、widgetState shim 与高度上报脚本", () => {
  const document = buildVisualizationSandboxDocument(
    '<div id="app">hello</div>',
    "--background:#fff;--foreground:#111",
  );
  assert.ok(
    document.includes(
      `<meta http-equiv="Content-Security-Policy" content="${VISUALIZATION_CSP_DIRECTIVE}">`,
    ),
  );
  assert.ok(document.includes("--background:#fff;--foreground:#111"));
  assert.ok(document.includes("window.acodeViz"));
  assert.ok(document.includes("acode-viz-height"));
  // widgetState shim 必须先于 fragment，高度脚本必须在 fragment 之后（body 已存在）。
  assert.ok(document.indexOf("window.acodeViz") < document.indexOf('<div id="app">'));
  assert.ok(document.indexOf("acode-viz-height") > document.indexOf('<div id="app">'));
});

test("解析 visualization ref：sessionId/name 切分与形状校验", () => {
  assert.deepEqual(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}s1/chart-a`), {
    sessionId: "s1",
    name: "chart-a",
  });
  assert.deepEqual(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}s1/chart.a.b`), {
    sessionId: "s1",
    name: "chart.a.b",
  });
  // 大写 / 斜杠 / 空段 / 非 html 前缀都不认。
  assert.equal(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}s1/Bad`), null);
  assert.equal(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}s1/a/b`), null);
  assert.equal(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}s1/`), null);
  assert.equal(parseVisualizationArtifactRef(`${VISUALIZATION_REF_PREFIX}/x`), null);
  assert.equal(parseVisualizationArtifactRef("acode-artifact://s1/x"), null);
});

test("分派判据：只有 html + 可视化 ref 的 artifactRow 进沙箱卡", () => {
  const base = {
    rowId: 1,
    turnId: "t",
    createdAt: 0,
    createdAtSeq: 0,
    kind: "artifact",
    artifactVersionId: "v1",
    logicalArtifactKey: "k",
    displayName: "demo",
    mimeType: "text/html",
    sizeBytes: 3,
    sha256: "0".repeat(64),
    state: "current",
  } as const;
  assert.equal(
    isVisualizationArtifactRow({ ...base, artifactType: "html", ref: "acode-visualization://s/x" }),
    true,
  );
  assert.equal(
    isVisualizationArtifactRow({ ...base, artifactType: "pdf", ref: "acode-visualization://s/x" }),
    false,
  );
  assert.equal(
    isVisualizationArtifactRow({ ...base, artifactType: "html", ref: "acode-artifact://s/x" }),
    false,
  );
});

test("正文剥离：指令变等长空白且行结构保持，坏引用原样保留", () => {
  const content = [
    "第一段",
    '::visualize{"name":"chart-a","mode":"wide"}',
    "第二段",
    '::visualize{"name":"bad name"}',
    "结尾",
  ].join("\n");
  const references = extractAssistantVisualizeReferences(content);
  assert.equal(references.length, 1);
  assert.equal(references[0]?.name, "chart-a");
  assert.equal(references[0]?.mode, "wide");
  const projected = projectAssistantVisualizeReferences(content, { streaming: false });
  const lines = projected.visibleText.split("\n");
  // 指令行只剩空白；行数不变；非法 name 的指令按原文保留（与 CLI「降级可见」同语义）。
  assert.equal(lines.length, 5);
  assert.equal(lines[1]?.trim(), "");
  assert.equal(lines[1]?.length, '::visualize{"name":"chart-a","mode":"wide"}'.length);
  assert.equal(lines[3], '::visualize{"name":"bad name"}');
});

test("流式尾部：半截指令整体隐藏，代码块内的协议样例不参与解析", () => {
  const streamingTail = '说明文字\n::visualize{"name":"char';
  assert.equal(
    projectAssistantVisualizeReferences(streamingTail, { streaming: true }).visibleText,
    // 与 citation 的尾部语义一致：切到指令起点，指令前的换行保留。
    "说明文字\n",
  );
  const codeSample = '```html\n::visualize{"name":"chart-a"}\n```';
  assert.equal(extractAssistantVisualizeReferences(codeSample).length, 0);
  assert.equal(
    projectAssistantVisualizeReferences(codeSample, { streaming: false }).visibleText,
    codeSample,
  );
});

test("读取循环：多块拼装逐字节等于原片段，块参数按 512KiB 游标推进", async () => {
  const fragment = "图表内容 ABC-123，跨越两块。".repeat(60_000);
  const bytes = encoder.encode(fragment);
  assert.ok(bytes.byteLength > VISUALIZATION_CHUNK_BYTES);
  const calls: Array<{ offset: number; limit: number }> = [];
  const readChunk = async (params: { offset: number; limit: number }) => {
    calls.push({ offset: params.offset, limit: params.limit });
    const end = Math.min(params.offset + params.limit, bytes.byteLength);
    const nextOffset = end >= bytes.byteLength ? null : end;
    return chunk(bytes.subarray(params.offset, end), bytes.byteLength, nextOffset);
  };
  const settled = await fetchVisualizationFragment(
    readChunk,
    { sessionId: "s1", name: "chart-a" },
    new AbortController().signal,
  );
  assert.ok("fragment" in settled);
  if ("fragment" in settled) {
    assert.equal(settled.fragment, fragment);
  }
  // 游标逐块 +512KiB 推进，最后一块 nextOffset 收敛为 null。
  for (let index = 1; index < calls.length; index += 1) {
    assert.equal(calls[index]?.offset, calls[index - 1]?.offset! + VISUALIZATION_CHUNK_BYTES);
  }
  assert.equal(calls[0]?.offset, 0);
  assert.ok(calls.length >= 2);
});

test("读取循环：总字节超读取契约上限判 oversized，不再继续读第二块", async () => {
  let reads = 0;
  const readChunk = async () => {
    reads += 1;
    return chunk(new Uint8Array(16), VISUALIZATION_LIMITS.maxBytes + 1, 16);
  };
  // 上限以 shared 的读取契约为准（VISUALIZATION_LIMITS.maxBytes，与线上 schema 同源）；
  // 写入侧另有 1 MiB 拒收门（CLI 工具），读取端不重复铸阈值。
  assert.ok(isOversizedVisualization(VISUALIZATION_LIMITS.maxBytes + 1));
  assert.ok(!isOversizedVisualization(VISUALIZATION_LIMITS.maxBytes));
  const settled = await fetchVisualizationFragment(
    readChunk,
    { sessionId: "s1", name: "chart-a" },
    new AbortController().signal,
  );
  assert.ok("oversized" in settled);
  assert.equal(reads, 1);
});

test("读取循环：读取失败抛错（卡片据此进 loadFailed 降级态）", async () => {
  const readChunk = async () => {
    throw new Error("fault.visualization.readUnavailable");
  };
  await assert.rejects(
    fetchVisualizationFragment(
      readChunk,
      { sessionId: "s1", name: "chart-a" },
      new AbortController().signal,
    ),
    { message: "fault.visualization.readUnavailable" },
  );
});
