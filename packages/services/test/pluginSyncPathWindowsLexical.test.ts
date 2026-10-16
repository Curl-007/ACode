import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  normalizePluginSyncRelativePath,
  resolvePluginSyncPathWithin,
} from "../src/plugin-sync/pluginSyncPath.js";

/**
 * pluginSyncPath 词法层加固守护（价值提取第二轮 T1-m1 消费点接入）。
 * 规格：packages/services/specs/file-containment-trust-tiers.md R1/R6.2。
 * Windows 段级规则默认跟随运行平台，测试显式传 windowsRules 保证跨平台确定性。
 */

test("既有词法拒绝语义保留：..、绝对路径、反斜杠、盘符、空段", () => {
  for (const path of ["../escape", "a/../..", "/abs/path", "/leading/slash/", "C:\\abs", "C:/abs", "a\\b", "", "a//b", "./x"]) {
    assert.throws(
      () => normalizePluginSyncRelativePath(path),
      /unsafe plugin sync path/u,
      `应拒绝: ${JSON.stringify(path)}`,
    );
  }
  assert.equal(normalizePluginSyncRelativePath("plugin-dir/sub/file.json"), "plugin-dir/sub/file.json");
  assert.equal(normalizePluginSyncRelativePath("trailing/slash/"), "trailing/slash");
});

test("新增：NUL 字节一律拒绝（两种平台规则下）", () => {
  for (const windowsRules of [true, false]) {
    assert.throws(
      () => normalizePluginSyncRelativePath("dir/na\0me", { windowsRules }),
      /unsafe plugin sync path/u,
    );
  }
});

test("新增：Windows 段级规则——DOS 设备名（含上标变体）/尾点尾空格/段内冒号 ADS", () => {
  const windowsDangerous = [
    "con",
    "dir/NUL.txt",
    "PRN",
    "aux.log",
    "com¹/x",
    "COM9",
    "lpt³/y",
    "LPT1",
    "trail./x",
    "trail /x",
    "ads/a:b",
  ];
  for (const path of windowsDangerous) {
    assert.throws(
      () => normalizePluginSyncRelativePath(path, { windowsRules: true }),
      /unsafe plugin sync path/u,
      `windows 规则下应拒绝: ${JSON.stringify(path)}`,
    );
  }
  // POSIX 语义不受影响：冒号/设备名/尾点是合法文件名字符。
  for (const path of ["dir/con", "ads/a:b", "trail./x"]) {
    assert.equal(
      normalizePluginSyncRelativePath(path, { windowsRules: false }),
      path,
      `POSIX 规则下应放行: ${path}`,
    );
  }
  // 不误伤普通名字。
  for (const path of ["console/log.md", "comma,a/b", "nulk/x"]) {
    assert.equal(normalizePluginSyncRelativePath(path, { windowsRules: true }), path);
  }
});

test("自定义 unsafePathLabel 保留", () => {
  assert.throws(
    () => normalizePluginSyncRelativePath("con", { unsafePathLabel: "custom label", windowsRules: true }),
    /custom label: con/u,
  );
});

test("resolvePluginSyncPathWithin：合法路径落根内，越界与 Windows 危险名拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "acode-plugin-sync-path-"));
  const resolved = resolvePluginSyncPathWithin(root, "plugin/dir.md");
  assert.equal(resolved, join(root, "plugin", "dir.md"));

  assert.throws(
    () => resolvePluginSyncPathWithin(root, "../escape.md"),
    /unsafe plugin sync path/u,
  );
  assert.throws(
    () => resolvePluginSyncPathWithin(root, "ads/a:b", { windowsRules: true }),
    /unsafe plugin sync path/u,
  );
  assert.throws(() => resolvePluginSyncPathWithin(root, root), /unsafe plugin sync path/u);
});
