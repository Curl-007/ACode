// PreviewPane 批次 5 外迁（previewPaneSources）的接缝内决策表测试。
// 纯函数、无 DOM；source 对象按 CodeViewerSource 判别联合的最小形状构造。
import assert from "node:assert/strict";
import test from "node:test";

import type { BundledLanguage } from "shiki";

import type { CodeViewerSource } from "../src/lib/codeViewer.js";
import {
  getPreviewPaneDisplayOptions,
  isMarkdownFilePath,
  isMarkdownSource,
  isPlainCodeSource,
  isPptxPreviewFileTooLarge,
  isSvgFilePath,
  isSvgSource,
  PPTX_MAX_FILE_BYTES,
  resolveMediaPlaybackErrorMessageId,
  resolvePreviewPaneImageSource,
  resolvePreviewPaneMediaSource,
  resolvePreviewPanePdfSource,
  resolvePreviewPanePptxSource,
  resolvePreviewPaneTextFileResult,
  shouldShowPreviewPaneHeaderDivider,
} from "../src/previewPane/previewPaneSources.js";

const fileSource = (path: string): CodeViewerSource => ({ type: "file", title: path, path });
const textSource = (language: BundledLanguage, path?: string): CodeViewerSource => ({
  type: "text",
  title: "t",
  language,
  path,
  content: "",
});

test("isMarkdownSource / isSvgSource 只对 text 形态生效", () => {
  assert.equal(isMarkdownSource(textSource("markdown")), true);
  assert.equal(isMarkdownSource(textSource("plaintext")), false);
  assert.equal(isMarkdownSource(fileSource("a.md")), false);
  assert.equal(isSvgSource(textSource("xml", "/x/y.svg")), true);
  assert.equal(isSvgSource(textSource("xml", "/x/y.SVG")), true);
  assert.equal(isSvgSource(textSource("xml", "/x/y.png")), false);
  assert.equal(isSvgSource(fileSource("a.svg")), false);
});

test("isMarkdownFilePath / isSvgFilePath 路径判定大小写不敏感且容忍缺省", () => {
  assert.equal(isMarkdownFilePath("README.md"), true);
  assert.equal(isMarkdownFilePath("docs/a.MARKDOWN"), true);
  assert.equal(isMarkdownFilePath("a.txt"), false);
  assert.equal(isMarkdownFilePath(undefined), false);
  assert.equal(isSvgFilePath("icon.svg"), true);
  assert.equal(isSvgFilePath("icon.SVG"), true);
  assert.equal(isSvgFilePath(undefined), false);
  assert.equal(isSvgFilePath("icon.png"), false);
});

test("resolvePreviewPaneTextFileResult：binary 直通 / truncated 判过大 / 常规透传", () => {
  const base = { path: "a.txt", content: "x", truncated: false, isBinary: false };
  assert.deepEqual(resolvePreviewPaneTextFileResult({ ...base, isBinary: true }), {
    filePreview: { ...base, isBinary: true },
    fileTooLarge: false,
  });
  assert.deepEqual(resolvePreviewPaneTextFileResult({ ...base, truncated: true }), {
    filePreview: null,
    fileTooLarge: true,
  });
  assert.deepEqual(resolvePreviewPaneTextFileResult(base), {
    filePreview: base,
    fileTooLarge: false,
  });
});

test("resolvePreviewPaneImageSource：image 直通 / file+图片类型转换 / 其它 null", () => {
  const image: CodeViewerSource = { type: "image", title: "i", path: "a.png", mediaType: "image/png" };
  assert.equal(resolvePreviewPaneImageSource(image), image);
  assert.deepEqual(resolvePreviewPaneImageSource(fileSource("a.png")), {
    type: "image",
    title: "a.png",
    path: "a.png",
    mediaType: "image/png",
  });
  // svg 不走 image 预览（走文本/code 预览）。
  assert.equal(resolvePreviewPaneImageSource(fileSource("a.svg")), null);
  assert.equal(resolvePreviewPaneImageSource(fileSource("a.txt")), null);
  assert.equal(resolvePreviewPaneImageSource(textSource("plaintext")), null);
  assert.equal(resolvePreviewPaneImageSource(null), null);
});

test("resolvePreviewPaneMediaSource：media 直通 / file+音视频推断 / 其它 null", () => {
  const media: CodeViewerSource = {
    type: "media",
    title: "m",
    path: "a.mp4",
    mediaType: "video/mp4",
    kind: "video",
  };
  assert.equal(resolvePreviewPaneMediaSource(media), media);
  const resolved = resolvePreviewPaneMediaSource(fileSource("a.mp4"));
  assert.equal(resolved?.type, "media");
  assert.equal(resolved?.kind, "video");
  assert.equal(resolvePreviewPaneMediaSource(fileSource("a.txt")), null);
  assert.equal(resolvePreviewPaneMediaSource(null), null);
});

test("resolveMediaPlaybackErrorMessageId：MEDIA_ERR_SRC_NOT_SUPPORTED(4)/③ → unsupported", () => {
  assert.equal(resolveMediaPlaybackErrorMessageId(3), "codeViewer.mediaUnsupported");
  assert.equal(resolveMediaPlaybackErrorMessageId(4), "codeViewer.mediaUnsupported");
  assert.equal(resolveMediaPlaybackErrorMessageId(2), "codeViewer.mediaLoadFailed");
  assert.equal(resolveMediaPlaybackErrorMessageId(undefined), "codeViewer.mediaLoadFailed");
});

test("resolvePreviewPanePdfSource / resolvePreviewPanePptxSource：专用类型直通 + file 路径推断", () => {
  const pdf: CodeViewerSource = { type: "pdf", title: "p", path: "a.pdf" };
  assert.equal(resolvePreviewPanePdfSource(pdf), pdf);
  assert.deepEqual(resolvePreviewPanePdfSource(fileSource("a.pdf")), {
    type: "pdf",
    title: "a.pdf",
    path: "a.pdf",
  });
  assert.equal(resolvePreviewPanePdfSource(fileSource("a.txt")), null);
  assert.equal(resolvePreviewPanePdfSource(null), null);

  const pptx = fileSource("a.pptx");
  const resolvedPptx = resolvePreviewPanePptxSource(pptx);
  assert.equal(resolvedPptx?.type, "pptx");
  assert.equal(resolvedPptx?.path, "a.pptx");
  assert.equal(resolvePreviewPanePptxSource(fileSource("a.pdf")), null);
  assert.equal(resolvePreviewPanePptxSource(null), null);
});

test("isPptxPreviewFileTooLarge 阈值边界", () => {
  assert.equal(isPptxPreviewFileTooLarge(PPTX_MAX_FILE_BYTES), false);
  assert.equal(isPptxPreviewFileTooLarge(PPTX_MAX_FILE_BYTES + 1), true);
});

test("shouldShowPreviewPaneHeaderDivider：pdf/pptx/media/office file 为真", () => {
  assert.equal(shouldShowPreviewPaneHeaderDivider({ type: "pdf", title: "p", path: "a.pdf" }), true);
  assert.equal(shouldShowPreviewPaneHeaderDivider(fileSource("a.pptx")), true);
  assert.equal(shouldShowPreviewPaneHeaderDivider(fileSource("a.mp4")), true);
  assert.equal(shouldShowPreviewPaneHeaderDivider(fileSource("a.docx")), true);
  assert.equal(shouldShowPreviewPaneHeaderDivider(fileSource("a.txt")), false);
  assert.equal(shouldShowPreviewPaneHeaderDivider(null), false);
});

test("isPlainCodeSource 决策矩阵", () => {
  assert.equal(isPlainCodeSource(textSource("typescript")), true);
  assert.equal(isPlainCodeSource(textSource("markdown")), false);
  assert.equal(isPlainCodeSource(textSource("xml", "a.svg")), false);
  assert.equal(isPlainCodeSource(fileSource("a.ts")), true);
  assert.equal(isPlainCodeSource(fileSource("a.md")), false);
  assert.equal(isPlainCodeSource(fileSource("a.svg")), false);
  assert.equal(isPlainCodeSource(fileSource("a.png")), false);
  assert.equal(isPlainCodeSource(fileSource("a.pdf")), false);
  assert.equal(isPlainCodeSource(fileSource("a.docx")), false);
  assert.equal(isPlainCodeSource(fileSource("a.pptx")), false);
  assert.equal(
    isPlainCodeSource({ type: "media", title: "m", path: "a.mp4", mediaType: "video/mp4", kind: "video" }),
    false,
  );
  assert.equal(
    isPlainCodeSource({
      type: "code-review",
      title: "r",
      path: "a.ts",
      review: { requestId: "r1", title: "t", body: "b" },
    }),
    true,
  );
  assert.equal(isPlainCodeSource(null), false);
});

test("getPreviewPaneDisplayOptions：切换能力与 more 菜单派生", () => {
  // markdown 源码：可切 markdown 视图；preview 态无 code wrap，code 态有。
  const md = textSource("markdown");
  assert.deepEqual(getPreviewPaneDisplayOptions(md), {
    canToggleCodeWrap: false,
    canToggleMarkdownView: true,
    canToggleSvgView: false,
    hasMoreMenu: true,
  });
  assert.equal(
    getPreviewPaneDisplayOptions(md, { markdownViewMode: "code" }).canToggleCodeWrap,
    true,
  );
  // svg 文件：可切 svg 视图；code 态可 wrap。
  const svg = fileSource("icon.svg");
  const svgOptions = getPreviewPaneDisplayOptions(svg, { svgViewMode: "code" });
  assert.equal(svgOptions.canToggleSvgView, true);
  assert.equal(svgOptions.canToggleCodeWrap, true);
  // 纯代码：只有 wrap。
  const ts = fileSource("a.ts");
  assert.deepEqual(getPreviewPaneDisplayOptions(ts), {
    canToggleCodeWrap: true,
    canToggleMarkdownView: false,
    canToggleSvgView: false,
    hasMoreMenu: true,
  });
  // 无 source：全无。
  assert.deepEqual(getPreviewPaneDisplayOptions(null), {
    canToggleCodeWrap: false,
    canToggleMarkdownView: false,
    canToggleSvgView: false,
    hasMoreMenu: false,
  });
});
