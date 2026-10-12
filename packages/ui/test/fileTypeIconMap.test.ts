import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FILE_TYPE_ICON_KIND,
  resolveFileTypeIconKind,
} from "../src/components/fileTypeIconMap.js";

/**
 * 文件类型图标的解析规则（packages/ui/specs/chat-small-ux-file-icons.md §2）：
 * 扩展名命中、点文件全名命中、带尾巴的点文件前缀命中、未命中回退通用图标。
 */

test("常见扩展名命中各自的图标组", () => {
  assert.equal(resolveFileTypeIconKind("main.ts"), "typescript");
  assert.equal(resolveFileTypeIconKind("App.tsx"), "typescript");
  assert.equal(resolveFileTypeIconKind("index.js"), "javascript");
  assert.equal(resolveFileTypeIconKind("pkg.json"), "json");
  assert.equal(resolveFileTypeIconKind("README.md"), "markdown");
  assert.equal(resolveFileTypeIconKind("main.py"), "python");
  assert.equal(resolveFileTypeIconKind("main.go"), "code");
  assert.equal(resolveFileTypeIconKind("lib.rs"), "code");
  assert.equal(resolveFileTypeIconKind("build.sh"), "shell");
  assert.equal(resolveFileTypeIconKind("query.sql"), "sql");
  assert.equal(resolveFileTypeIconKind("data.csv"), "spreadsheet");
  assert.equal(resolveFileTypeIconKind("report.pdf"), "pdf");
  assert.equal(resolveFileTypeIconKind("photo.png"), "image");
  assert.equal(resolveFileTypeIconKind("clip.mp4"), "video");
  assert.equal(resolveFileTypeIconKind("song.mp3"), "audio");
  assert.equal(resolveFileTypeIconKind("bundle.zip"), "archive");
  assert.equal(resolveFileTypeIconKind("config.yaml"), "settings");
  assert.equal(resolveFileTypeIconKind("pnpm-lock.yaml"), "lock");
});

test("路径带目录时只看叶子", () => {
  assert.equal(resolveFileTypeIconKind("src/components/Button.tsx"), "typescript");
  assert.equal(resolveFileTypeIconKind("C:\\out\\report.pdf"), "pdf");
});

test("大小写不敏感", () => {
  assert.equal(resolveFileTypeIconKind("MAIN.TS"), "typescript");
  assert.equal(resolveFileTypeIconKind("Photo.PNG"), "image");
});

test("点文件按全名与前缀命中", () => {
  assert.equal(resolveFileTypeIconKind(".env"), "settings");
  assert.equal(resolveFileTypeIconKind(".env.local"), "settings");
  assert.equal(resolveFileTypeIconKind(".gitignore"), "settings");
});

test("惯用全名（可带扩展名尾巴）命中", () => {
  assert.equal(resolveFileTypeIconKind("Dockerfile"), "container");
  assert.equal(resolveFileTypeIconKind("Dockerfile.dev"), "container");
  assert.equal(resolveFileTypeIconKind("Makefile"), "container");
  assert.equal(resolveFileTypeIconKind("yarn.lock"), "lock");
  assert.equal(resolveFileTypeIconKind("package-lock.json"), "lock");
});

test("未命中回退通用文件图标，空名不抛错", () => {
  assert.equal(resolveFileTypeIconKind("unknown.xyzabc"), DEFAULT_FILE_TYPE_ICON_KIND);
  assert.equal(resolveFileTypeIconKind("no-extension"), DEFAULT_FILE_TYPE_ICON_KIND);
  assert.equal(resolveFileTypeIconKind(""), DEFAULT_FILE_TYPE_ICON_KIND);
  assert.equal(resolveFileTypeIconKind("   "), DEFAULT_FILE_TYPE_ICON_KIND);
});
