// PreviewPane 批次 5 外迁（previewPaneBreadcrumb）的接缝内决策表测试。纯函数、无 DOM。
import assert from "node:assert/strict";
import test from "node:test";

import type { CodeViewerSource } from "../src/lib/codeViewer.js";
import {
  BREADCRUMB_MASK_CLASS_BY_STATE,
  buildCodeViewerBreadcrumb,
  normalizeBreadcrumbPathSegments,
} from "../src/previewPane/previewPaneBreadcrumb.js";

const fileSource = (path: string, title = path): CodeViewerSource => ({
  type: "file",
  title,
  path,
});

test("normalizeBreadcrumbPathSegments：反斜杠归一 + 空段过滤", () => {
  assert.deepEqual(normalizeBreadcrumbPathSegments("a\\b\\c.txt"), ["a", "b", "c.txt"]);
  assert.deepEqual(normalizeBreadcrumbPathSegments("/a//b/"), ["a", "b"]);
  assert.deepEqual(normalizeBreadcrumbPathSegments(""), []);
});

test("buildCodeViewerBreadcrumb：无 path 时按 title 兜底", () => {
  assert.equal(buildCodeViewerBreadcrumb({ type: "text", title: "  ", content: "", language: "plaintext" }), null);
  const byTitle = buildCodeViewerBreadcrumb({
    type: "text",
    title: "Snippet",
    content: "",
    language: "plaintext",
  });
  assert.deepEqual(byTitle, {
    rootLabel: null,
    parentSegments: [],
    fileLabel: "Snippet",
    fileIconSrc: null,
  });
});

test("buildCodeViewerBreadcrumb：workspace 内路径取相对段 + workspace 名作 root", () => {
  const crumb = buildCodeViewerBreadcrumb(
    fileSource("/home/u/proj/src/deep/a.ts"),
    "/home/u/proj",
  );
  assert.equal(crumb?.rootLabel, "proj");
  assert.deepEqual(crumb?.parentSegments, ["src", "deep"]);
  assert.equal(crumb?.fileLabel, "a.ts");
  // workspace 路径带尾斜杠 / 反斜杠也归一。
  const windowsCrumb = buildCodeViewerBreadcrumb(
    fileSource("C:\\ws\\proj\\src\\a.ts"),
    "C:\\ws\\proj\\",
  );
  assert.equal(windowsCrumb?.rootLabel, "proj");
  assert.deepEqual(windowsCrumb?.parentSegments, ["src"]);
  assert.equal(windowsCrumb?.fileLabel, "a.ts");
});

test("buildCodeViewerBreadcrumb：source 恰好是 workspace 根", () => {
  const crumb = buildCodeViewerBreadcrumb(fileSource("/home/u/proj"), "/home/u/proj");
  assert.equal(crumb?.rootLabel, "proj");
  assert.deepEqual(crumb?.parentSegments, []);
  assert.equal(crumb?.fileLabel, "proj");
});

test("buildCodeViewerBreadcrumb：workspace 外 posix 绝对路径以 / 为 root", () => {
  const crumb = buildCodeViewerBreadcrumb(fileSource("/etc/nginx/nginx.conf"), "/home/u/proj");
  assert.equal(crumb?.rootLabel, "/");
  assert.deepEqual(crumb?.parentSegments, ["etc", "nginx"]);
  assert.equal(crumb?.fileLabel, "nginx.conf");
});

test("buildCodeViewerBreadcrumb：workspace 外 windows 路径以盘符为 root", () => {
  const crumb = buildCodeViewerBreadcrumb(fileSource("D:\\tools\\x\\a.log"));
  assert.equal(crumb?.rootLabel, "D:");
  assert.deepEqual(crumb?.parentSegments, ["tools", "x"]);
  assert.equal(crumb?.fileLabel, "a.log");
});

test("BREADCRUMB_MASK_CLASS_BY_STATE 四态齐备且 none 为空串", () => {
  assert.equal(BREADCRUMB_MASK_CLASS_BY_STATE.none, "");
  for (const state of ["left", "right", "both"] as const) {
    assert.match(BREADCRUMB_MASK_CLASS_BY_STATE[state], /mask-image/);
  }
});
