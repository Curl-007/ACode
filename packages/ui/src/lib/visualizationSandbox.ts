// 对话内可视化（::visualize → artifactRow html）沙箱文档的纯逻辑层。
//
// 组件（v4/VisualizationArtifactRow.tsx）只做状态与 DOM；本文件集中放可独立断言的
// 安全边界：iframe sandbox 能力、srcdoc 自身的 CSP、主题变量映射、ref 解析与
// 分块读取循环。安全设计依据 packages/ui/specs/gen-ui-visualize-card.md：
// sandbox 只开 allow-scripts（绝无 allow-same-origin），网络/表单/导航面由 srcdoc
// 内的 meta CSP 收口（connect-src 'none' 拦 fetch/XHR/WebSocket），不依赖应用 CSP。
// mermaid/chart.js 等钉版渲染库走本地资产（lib/visualizationVendor.ts）：CSP 只加
// script-src 本地窄源，connect-src 'none' 与 sandbox 面红线不动。
import {
  PROTOCOL_V4_LIMITS,
  VISUALIZATION_LIMITS,
  type ArtifactRow,
} from "@acode/shared/acode-protocol-v4";
import type {
  ConversationVisualizationReadChunk,
  ConversationVisualizationReadRequest,
} from "@/v4/conversationRowContext.js";
import {
  rewriteVisualizationVendorReferences,
  type VisualizationVendorRuntime,
} from "@/lib/visualizationVendor.js";

/** artifactRow.ref 的协议前缀；后接 `<sessionId>/<name>`。 */
export const VISUALIZATION_REF_PREFIX = "acode-visualization://";

/** sandbox 唯一允许的能力：脚本。不得追加 allow-same-origin / popups / forms / top-navigation。 */
export const VISUALIZATION_IFRAME_SANDBOX = "allow-scripts";

/** CSP 白名单 CDN（与 CLI 技能教的是同一张表，见 apps/acode-cli/specs/gen-ui-visualize.md）。 */
const CSP_CDN_SOURCES = [
  "cdnjs.cloudflare.com",
  "esm.sh",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "fonts.bunny.net",
] as const;

/**
 * srcdoc 文档自身的 CSP。default-src 'none' 让任何未列出的面默认拒绝；
 * connect-src 'none' 是关键防线——沙箱挡不住 fetch 本身，片段里的外联数据通道
 * 必须在这里掐断（vendored 钉版库进来后这条红线不动：本地库走 script-src，
 * 与 connect 面无关）。
 *
 * vendorScriptSources：本地 vendored 渲染库源（lib/visualizationVendor.ts 解析），
 * 只进 script-src，且是「源+目录前缀」或桌面自定义 scheme 的窄面；CDN 白名单
 * 保留为回退但不再是唯一路径。
 */
export function buildVisualizationCspDirective(
  vendorScriptSources: readonly string[] = [],
): string {
  const scriptSources = [...vendorScriptSources, ...CSP_CDN_SOURCES].join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' blob: data: ${scriptSources}`,
    `style-src 'unsafe-inline' data: blob: ${CSP_CDN_SOURCES.join(" ")}`,
    `img-src data: blob: ${CSP_CDN_SOURCES.join(" ")}`,
    `font-src data: ${CSP_CDN_SOURCES.join(" ")}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/** 无本地 vendor 源时的基线 CSP（测试与静态分析引用的稳定常量）。 */
export const VISUALIZATION_CSP_DIRECTIVE = buildVisualizationCspDirective();

/** 一块的字节数与块数刹车：1 MiB / 512 KiB = 2 块，余量防不收敛实现。 */
export const VISUALIZATION_CHUNK_BYTES = PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes;
const MAX_CHUNKS = 8;

export interface VisualizationArtifactIdentity {
  sessionId: string;
  name: string;
}

/**
 * 解析 artifactRow.ref（`acode-visualization://<sessionId>/<name>`）。
 * name 形状与写入侧清洗规则同源（`^[a-z0-9-]+(\.[a-z0-9-]+)*$`，不含 `/`，≤80 字符），
 * 在第一个 `/` 处切分；sessionId 是 opaque ID 不做形状假设，只要求非空。
 */
export function parseVisualizationArtifactRef(ref: string): VisualizationArtifactIdentity | null {
  if (!ref.startsWith(VISUALIZATION_REF_PREFIX)) return null;
  const rest = ref.slice(VISUALIZATION_REF_PREFIX.length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex <= 0 || slashIndex === rest.length - 1) return null;
  const sessionId = rest.slice(0, slashIndex);
  const name = rest.slice(slashIndex + 1);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/u.test(name) && name.length <= 80
    ? { sessionId, name }
    : null;
}

/** 分派判据：html artifact 且 ref 是可视化协议——其余 artifact 走既有文件摘要卡。 */
export function isVisualizationArtifactRow(row: ArtifactRow): boolean {
  return row.artifactType === "html" && parseVisualizationArtifactRef(row.ref) !== null;
}

/** 片段总字节超过读取契约上限（1 MiB）时不再读，卡片进入 oversized 降级态。 */
export function isOversizedVisualization(totalBytes: number): boolean {
  return totalBytes > VISUALIZATION_LIMITS.maxBytes;
}

/**
 * 目标变量表 → 卡片容器上的语义 token 来源。片段侧约定使用上游技能的
 * --background/--foreground/... 命名（见 gen-ui-visualize-card.md），这里把仓库
 * token 映射过去；仓库没有同名 token 的（muted/blue 等）取语义最接近项。
 */
const THEME_TOKEN_SOURCES: readonly (readonly [target: string, source: string])[] = [
  ["--background", "--color-background"],
  ["--foreground", "--color-foreground"],
  ["--card", "--color-card"],
  ["--muted", "--color-surface"],
  ["--muted-foreground", "--color-foreground-subtle"],
  ["--primary", "--color-primary"],
  ["--border", "--color-border"],
  ["--destructive", "--color-destructive"],
  ["--blue", "--color-terminal-blue"],
  ["--green", "--color-success"],
  ["--red", "--color-destructive"],
  ["--yellow", "--color-warning"],
];

/** computed token 值只放行纯 CSS 颜色语法字符，防 `;}` 注入进 :root 变量块。 */
function sanitizeThemeTokenValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[^a-zA-Z0-9#%().,/+\-\s]/u.test(trimmed)) return null;
  return trimmed;
}

/** 从卡片容器的 computed style 读当前主题 token（容器随 .dark 切换取到当前值）。 */
export function readVisualizationThemeTokens(element: Element): string {
  const computed = getComputedStyle(element);
  const declarations: string[] = [];
  for (const [target, source] of THEME_TOKEN_SOURCES) {
    const value = sanitizeThemeTokenValue(computed.getPropertyValue(source));
    if (value) declarations.push(`${target}:${value}`);
  }
  return declarations.join(";");
}

/**
 * 高度上报脚本：ResizeObserver 观察 documentElement/body，变化即向 parent
 * postMessage。`*` 目标是刻意的——沙箱文档是不透明源，targetOrigin 无法提供更强
 * 约束，父侧靠 event.source === iframe.contentWindow 校验收件人身份。
 */
const HEIGHT_REPORT_SCRIPT = `
(function () {
  var last = -1;
  function report() {
    var height = Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0
    );
    if (!isFinite(height) || height < 0) return;
    height = Math.ceil(height);
    if (height === last) return;
    last = height;
    try { parent.postMessage({ type: "acode-viz-height", height: height }, "*"); } catch (error) {}
  }
  if (window.ResizeObserver) {
    var observer = new ResizeObserver(report);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  }
  document.addEventListener("DOMContentLoaded", report);
  window.addEventListener("load", report);
  report();
})();
`;

/** widgetState 内存 shim：生命周期 = 卡片挂载期（v1 不持久化，见 spec 的后续项）。 */
const WIDGET_STATE_SCRIPT = `
(function () {
  var state = {};
  function clone(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (error) { return value; }
  }
  window.acodeViz = {
    widgetState: state,
    getWidgetState: function (key) {
      if (arguments.length === 0) return clone(state);
      return Object.prototype.hasOwnProperty.call(state, key) ? clone(state[key]) : undefined;
    },
    setWidgetState: function (key, value) {
      if (typeof key === "string") { state[key] = clone(value); return; }
      if (key && typeof key === "object") {
        for (var name in key) {
          if (Object.prototype.hasOwnProperty.call(key, name)) state[name] = clone(key[name]);
        }
      }
    },
  };
})();
`;

/**
 * fragment（无 doctype/html/head/body 的 HTML 片段）→ 可独立渲染的沙箱文档。
 * 顺序约束：widgetState shim 必须先于 fragment 执行（片段脚本依赖它）；高度上报
 * 脚本必须后于 fragment（需要 body 存在才能挂 ResizeObserver）。
 *
 * vendor：本地钉版渲染库运行态（lib/visualizationVendor.ts）。提供时：
 * 1. CSP script-src 增加对应本地源（origin 目录前缀或 acode-viz-vendor: scheme）；
 * 2. 桌面生产（file: 页面）把片段里的规范相对引用重写为 scheme URL——
 *    opaque-origin 沙箱 iframe 加载 file: 子资源会被 Chromium 拒绝，重写是
 *    桌面离线可用的唯一通路（实验判决见 specs/gen-ui-visualize-card.md）。
 */
export function buildVisualizationSandboxDocument(
  fragment: string,
  themeVariables: string,
  vendor?: VisualizationVendorRuntime,
): string {
  const resolvedFragment = vendor
    ? rewriteVisualizationVendorReferences(fragment, vendor)
    : fragment;
  const cspDirective = buildVisualizationCspDirective(vendor ? [vendor.cspSource] : []);
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="',
    cspDirective,
    '">',
    "<style>",
    ":root{",
    themeVariables,
    "}",
    "html,body{margin:0;padding:0;background:var(--background,transparent);color:var(--foreground,inherit);font-family:system-ui,-apple-system,'Segoe UI',sans-serif;}",
    "</style>",
    "<script>",
    WIDGET_STATE_SCRIPT,
    "</script>",
    "</head>",
    "<body>",
    resolvedFragment,
    "<script>",
    HEIGHT_REPORT_SCRIPT,
    "</script>",
    "</body>",
    "</html>",
  ].join("");
}

export type ReadVisualizationChunk = (
  params: ConversationVisualizationReadRequest,
) => Promise<ConversationVisualizationReadChunk>;

/**
 * 读取 visualization 片段字节：分块（≤512KiB/块）拼装，总字节 >1MiB 判 oversized、
 * 任一块失败即抛错（卡片据此降级）。与 attachmentRead 的分块纪律逐字对齐：
 * totalBytes 漂移 / offset 不收敛 / 尾块截断都按协议错误处理，不渲染半份字节。
 */
export async function fetchVisualizationFragment(
  readChunk: ReadVisualizationChunk,
  identity: VisualizationArtifactIdentity,
  signal: AbortSignal,
): Promise<{ fragment: string } | { oversized: true }> {
  const chunks: Uint8Array[] = [];
  let totalBytes: number | null = null;
  let offset = 0;
  for (let chunkIndex = 0; ; chunkIndex += 1) {
    signal.throwIfAborted();
    if (chunkIndex >= MAX_CHUNKS) throw new Error("fault.visualization.tooManyChunks");
    const result = await readChunk({
      sessionId: identity.sessionId,
      name: identity.name,
      offset,
      limit: VISUALIZATION_CHUNK_BYTES,
      signal,
    });
    signal.throwIfAborted();
    totalBytes ??= result.totalBytes;
    // 同名再写 = 更新：读取过程中 totalBytes 变化说明跨了版本，拼出的字节不属于任何完整版本。
    if (result.totalBytes !== totalBytes) throw new Error("fault.visualization.changedDuringRead");
    if (isOversizedVisualization(totalBytes)) return { oversized: true };
    const chunk = result.bytes;
    const nextOffset = offset + chunk.byteLength;
    if (nextOffset > totalBytes) throw new Error("fault.visualization.sizeMismatch");
    if (result.nextOffset !== null && result.nextOffset !== nextOffset) {
      throw new Error("fault.visualization.offsetMismatch");
    }
    chunks.push(chunk);
    if (result.nextOffset === null) {
      if (nextOffset !== totalBytes) throw new Error("fault.visualization.truncated");
      const bytes = new Uint8Array(totalBytes);
      let writeOffset = 0;
      for (const part of chunks) {
        bytes.set(part, writeOffset);
        writeOffset += part.byteLength;
      }
      // 写入侧强制 UTF-8；解码失败让卡片走 loadFailed 而不是渲染乱码。
      return { fragment: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    }
    if (chunk.byteLength === 0) throw new Error("fault.visualization.emptyChunk");
    offset = result.nextOffset;
  }
}
