import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPORT_TITLE_MAX_CODE_POINTS,
  buildConversationExportFilename,
  formatExportTimestampForFilename,
  sanitizeExportTitle,
} from "./conversationExportFilename.js";

test("Windows 非法字符被替换为连字符", () => {
  assert.equal(sanitizeExportTitle('a/b\\c:d*e?f"g<h>i|j'), "a-b-c-d-e-f-g-h-i-j");
  assert.equal(sanitizeExportTitle("路径/下的:标题"), "路径-下的-标题");
});

test("前后空白与点被去除", () => {
  assert.equal(sanitizeExportTitle("  ..标题..  "), "标题");
  assert.equal(sanitizeExportTitle("..."), "session");
});

test("空标题回退为 session", () => {
  assert.equal(sanitizeExportTitle(""), "session");
  assert.equal(sanitizeExportTitle("   "), "session");
});

test("超长标题截断到 60 个 code point", () => {
  const long = "a".repeat(500);
  assert.equal(Array.from(sanitizeExportTitle(long)).length, EXPORT_TITLE_MAX_CODE_POINTS);
});

test("含 emoji 的标题截断不产生半个代理对", () => {
  // 每个 emoji 占 2 个 UTF-16 code unit；直接 slice(0, 60) 会在边界切出孤立代理项。
  const title = "🚀".repeat(200);
  const sanitized = sanitizeExportTitle(title);
  assert.equal(Array.from(sanitized).length, EXPORT_TITLE_MAX_CODE_POINTS);
  // 无孤立代理项：任何 UTF-16 长度都应为偶数（全部是完整代理对）。
  assert.equal(sanitized.length % 2, 0);
  assert.ok(
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(sanitized),
  );
});

test("文件名含时间戳且格式为 yyyyMMdd-HHmmss", () => {
  const now = new Date(2026, 8, 26, 9, 8, 7);
  assert.equal(formatExportTimestampForFilename(now), "20260926-090807");
  assert.equal(
    buildConversationExportFilename({ title: "会话标题", extension: "md", now }),
    "会话标题-20260926-090807.md",
  );
  assert.equal(
    buildConversationExportFilename({ title: "会话标题", extension: "html", now }),
    "会话标题-20260926-090807.html",
  );
});

test("不含路径分隔符与 ..", () => {
  const name = buildConversationExportFilename({
    title: "../../etc/passwd",
    extension: "md",
    now: new Date(2026, 0, 1, 0, 0, 0),
  });
  assert.ok(!name.includes("/"), name);
  assert.ok(!name.includes("\\"), name);
  assert.ok(!name.includes(".."), name);
});
