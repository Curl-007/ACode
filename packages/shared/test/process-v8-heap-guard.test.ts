import assert from "node:assert/strict";
import test from "node:test";
import {
  appendMaxOldSpaceToNodeOptions,
  DEFAULT_AGENT_MAX_OLD_SPACE_MB,
  DEFAULT_HOST_MAX_OLD_SPACE_MB,
  resolveMaxOldSpaceMb,
} from "../src/process-v8-heap-guard.js";

test("resolveMaxOldSpaceMb: 缺省回落 fallback(护栏不因缺配置解除)", () => {
  assert.equal(resolveMaxOldSpaceMb(undefined, DEFAULT_HOST_MAX_OLD_SPACE_MB), 2048);
  assert.equal(resolveMaxOldSpaceMb(undefined, DEFAULT_AGENT_MAX_OLD_SPACE_MB), 3072);
});

test("resolveMaxOldSpaceMb: 0 显式关闭(逃生门)", () => {
  assert.equal(resolveMaxOldSpaceMb("0", DEFAULT_HOST_MAX_OLD_SPACE_MB), 0);
  assert.equal(resolveMaxOldSpaceMb(" 0 ", DEFAULT_HOST_MAX_OLD_SPACE_MB), 0);
});

test("resolveMaxOldSpaceMb: 正整数生效,容忍空白", () => {
  assert.equal(resolveMaxOldSpaceMb("1024", 2048), 1024);
  assert.equal(resolveMaxOldSpaceMb(" 512 ", 2048), 512);
});

test("resolveMaxOldSpaceMb: 非法值回落 fallback(与 idle-exit 的 fail-safe 方向相反)", () => {
  for (const raw of ["abc", "-1", "1.5", "", "1e3"]) {
    assert.equal(resolveMaxOldSpaceMb(raw, 2048), 2048, `raw=${raw}`);
  }
});

test("appendMaxOldSpaceToNodeOptions: 空值直接生成 flag", () => {
  assert.equal(appendMaxOldSpaceToNodeOptions(undefined, 3072), "--max-old-space-size=3072");
  assert.equal(appendMaxOldSpaceToNodeOptions("  ", 3072), "--max-old-space-size=3072");
});

test("appendMaxOldSpaceToNodeOptions: 既有片段空格合并不覆盖(coverage preload 兼容)", () => {
  assert.equal(
    appendMaxOldSpaceToNodeOptions("--require /tmp/preload.cjs", 2048),
    "--require /tmp/preload.cjs --max-old-space-size=2048",
  );
});

test("appendMaxOldSpaceToNodeOptions: mb<=0 原样返回(不注入不破坏)", () => {
  assert.equal(appendMaxOldSpaceToNodeOptions("--require /tmp/p.cjs", 0), "--require /tmp/p.cjs");
  assert.equal(appendMaxOldSpaceToNodeOptions(undefined, 0), undefined);
  assert.equal(appendMaxOldSpaceToNodeOptions(undefined, -1), undefined);
});
