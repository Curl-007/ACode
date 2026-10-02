import assert from "node:assert/strict";
import test from "node:test";
import { resolveOpenExternalAction } from "../src/lib/openExternalTarget.js";

/**
 * OpenSplitButton「外部打开」路由的回归守护。
 * 核心不变量（specs/electron-hardening.md §4）：本地文件永远不能走 openExternalUrl
 * （裸路径经 new URL() 解析成 c: 协议被 main 白名单拒，是死链路），必须走 openExternalFile；
 * 能力缺失时显式 unsupported，绝不退回死链路。
 */

test("file target with capability routes to openExternalFile, never openExternalUrl", () => {
  const action = resolveOpenExternalAction({ type: "file", path: "C:\\Users\\x\\report.html" }, true);
  assert.equal(action.kind, "openExternalFile");
  assert.equal(action.kind === "openExternalFile" && action.path, "C:\\Users\\x\\report.html");
});

test("file target without capability is unsupported (no silent dead-path fallback)", () => {
  const action = resolveOpenExternalAction({ type: "file", path: "/tmp/a.pdf" }, false);
  assert.equal(action.kind, "unsupportedLocalFile");
  assert.equal(action.kind === "unsupportedLocalFile" && action.path, "/tmp/a.pdf");
});

test("website target with local copy prefers openExternalFile when capable", () => {
  const action = resolveOpenExternalAction(
    { type: "website", url: "https://example.com", localPath: "/cache/page.html" },
    true,
  );
  assert.equal(action.kind, "openExternalFile");
  assert.equal(action.kind === "openExternalFile" && action.path, "/cache/page.html");
});

test("website target with local copy but no capability is unsupported", () => {
  const action = resolveOpenExternalAction(
    { type: "website", url: "https://example.com", localPath: "/cache/page.html" },
    false,
  );
  assert.equal(action.kind, "unsupportedLocalFile");
});

test("website target without local copy opens the URL regardless of capability", () => {
  for (const capable of [true, false]) {
    const action = resolveOpenExternalAction(
      { type: "website", url: "https://example.com/docs" },
      capable,
    );
    assert.equal(action.kind, "openExternalUrl");
    assert.equal(action.kind === "openExternalUrl" && action.url, "https://example.com/docs");
  }
});

test("file target with empty path is unsupported, not a dead openExternalUrl call", () => {
  const action = resolveOpenExternalAction({ type: "file", path: "" }, true);
  assert.equal(action.kind, "unsupportedLocalFile");
});

test("no file-bearing target ever resolves to openExternalUrl (dead-path invariant)", () => {
  const fileBearing = [
    { type: "file", path: "C:\\a.txt" },
    { type: "website", url: "https://e.com", localPath: "/c/e.html" },
  ] as const;
  for (const target of fileBearing) {
    for (const capable of [true, false]) {
      const action = resolveOpenExternalAction({ ...target }, capable);
      assert.notEqual(action.kind, "openExternalUrl", `${target.type} capable=${capable}`);
    }
  }
});
