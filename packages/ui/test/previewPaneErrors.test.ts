// PreviewPane 批次 5 外迁（previewPaneErrors）的接缝内决策表测试。纯函数、无 DOM。
import assert from "node:assert/strict";
import test from "node:test";

import type { CodeViewerSource } from "../src/lib/codeViewer.js";
import {
  getPreviewPaneSafeErrorMessage,
  isPreviewPaneFileTooLargeError,
  isPreviewPaneMissingFileError,
  resolvePptxPreviewReadErrorMessage,
  shouldToastPptxReferenceFileMissing,
} from "../src/previewPane/previewPaneErrors.js";

test("isPreviewPaneMissingFileError：code=ENOENT / 消息匹配 / 其它错误", () => {
  assert.equal(isPreviewPaneMissingFileError(Object.assign(new Error("x"), { code: "ENOENT" })), true);
  assert.equal(isPreviewPaneMissingFileError(new Error("open /a/b: ENOENT")), true);
  assert.equal(isPreviewPaneMissingFileError(new Error("no such file or directory")), true);
  assert.equal(isPreviewPaneMissingFileError(new Error("permission denied")), false);
  assert.equal(isPreviewPaneMissingFileError("ENOENT"), true);
  assert.equal(isPreviewPaneMissingFileError(null), false);
  assert.equal(isPreviewPaneMissingFileError({ code: "EACCES" }), false);
});

test("isPreviewPaneFileTooLargeError 只认固定文案", () => {
  assert.equal(isPreviewPaneFileTooLargeError(new Error("File is too large to preview")), true);
  assert.equal(isPreviewPaneFileTooLargeError(new Error("ENOENT")), false);
  assert.equal(isPreviewPaneFileTooLargeError("file is too large to preview (64 MB)"), true);
});

test("shouldToastPptxReferenceFileMissing：仅 pptx + referenceNavigation + 缺文件", () => {
  const pptxWithRef: CodeViewerSource = {
    type: "pptx",
    title: "p",
    path: "a.pptx",
    referenceNavigation: { requestId: "r", pageIndex: 0, expectedSourceFingerprint: "f" },
  };
  const missing = new Error("ENOENT");
  assert.equal(shouldToastPptxReferenceFileMissing(pptxWithRef, missing), true);
  assert.equal(shouldToastPptxReferenceFileMissing(pptxWithRef, new Error("boom")), false);
  const pptxNoRef: CodeViewerSource = { type: "pptx", title: "p", path: "a.pptx" };
  assert.equal(shouldToastPptxReferenceFileMissing(pptxNoRef, missing), false);
  assert.equal(
    shouldToastPptxReferenceFileMissing({ type: "file", title: "f", path: "a.txt" }, missing),
    false,
  );
  assert.equal(shouldToastPptxReferenceFileMissing(null, missing), false);
});

test("getPreviewPaneSafeErrorMessage：绝对路径脱敏为文件名", () => {
  // 绝对路径：消息里的完整路径（含斜杠两种形态）替换为文件名。
  const posix = getPreviewPaneSafeErrorMessage(
    new Error("cannot read /home/user/secret/report.md: bad"),
    "/home/user/secret/report.md",
  );
  assert.equal(posix.includes("/home/user/secret"), false);
  assert.equal(posix.includes("report.md"), true);
  // 反斜杠变体也被替换。
  const mixed = getPreviewPaneSafeErrorMessage(
    new Error("open \\home\\user\\secret\\report.md failed"),
    "/home/user/secret/report.md",
  );
  assert.equal(mixed.includes("secret"), false);
  // 相对路径不脱敏（消息原样返回）。
  const relative = getPreviewPaneSafeErrorMessage(new Error("bad secret/path"), "report.md");
  assert.equal(relative, "bad secret/path");
  // 非 Error 输入按 String 化。
  assert.equal(getPreviewPaneSafeErrorMessage("plain", "report.md"), "plain");
});

test("resolvePptxPreviewReadErrorMessage：missing > tooLarge > incomplete > safe 兜底", () => {
  const options = {
    sourcePath: "a.pptx",
    fileMissingMessage: "missing",
    legacyFileTooLargeMessage: "too-large",
    incompleteFileMessage: "incomplete",
  };
  assert.equal(resolvePptxPreviewReadErrorMessage(new Error("ENOENT"), options), "missing");
  assert.equal(
    resolvePptxPreviewReadErrorMessage(new Error("file is too large to preview"), options),
    "too-large",
  );
  assert.equal(resolvePptxPreviewReadErrorMessage(new Error("other"), options), "other");
});
