import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

const { isNodePtyRuntimePath } = await import("../src/packaging/stageRuntimeAssets.ts");

test("isNodePtyRuntimePath keeps package metadata, lib, typings, and license files", () => {
  assert.equal(isNodePtyRuntimePath("", "linux-x64"), true);
  assert.equal(isNodePtyRuntimePath("package.json", "linux-x64"), true);
  assert.equal(isNodePtyRuntimePath("LICENSE", "linux-x64"), true);
  assert.equal(isNodePtyRuntimePath("LICENSE.md", "linux-x64"), true);
  assert.equal(isNodePtyRuntimePath(join("lib", "index.js"), "linux-x64"), true);
  assert.equal(isNodePtyRuntimePath(join("typings", "node-pty.d.ts"), "linux-x64"), true);
});

test("isNodePtyRuntimePath drops host build artifacts and foreign prebuilds", () => {
  assert.equal(isNodePtyRuntimePath("build", "linux-x64"), false);
  assert.equal(isNodePtyRuntimePath(join("build", "Release", "pty.node"), "linux-x64"), false);
  assert.equal(isNodePtyRuntimePath("prebuilds", "linux-x64"), true);
  assert.equal(isNodePtyRuntimePath(join("prebuilds", "linux-x64", "pty.node"), "linux-x64"), true);
  assert.equal(
    isNodePtyRuntimePath(join("prebuilds", "darwin-arm64", "pty.node"), "linux-x64"),
    false,
  );
  assert.equal(isNodePtyRuntimePath(join("src", "index.ts"), "linux-x64"), false);
});
