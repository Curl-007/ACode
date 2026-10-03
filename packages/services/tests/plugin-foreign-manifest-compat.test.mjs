import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * 跨厂商插件清单兼容（桌面 services 侧）的源码不变量守护。
 * spec: apps/acode-cli/specs/plugin-foreign-manifest-compat.md（R2 发现点清单 #5–#9）。
 *
 * services 五个发现点必须与 CLI adapters 层接受同一候选集且同优先级
 * （.acode-plugin > .claude-plugin > .codex-plugin > .cursor-plugin），否则桌面
 * 同步/命令/技能/子代理层会与 CLI 发现层对同一插件根判定分叉。
 */

// 仓库 .ts 文件行尾混合（部分 CRLF），统一归一化为 LF 再做结构截取，避免按检出环境误报。
const read = (rel) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const CONVENTIONS = [".acode-plugin", ".claude-plugin", ".codex-plugin", ".cursor-plugin"];

function assertAllConventionsPresent(source, file) {
  for (const convention of CONVENTIONS) {
    assert.ok(
      source.includes(`"${convention}"`),
      `${file} 缺少插件清单目录约定 ${convention}（见 spec R1/R2）`,
    );
  }
}

function assertPriorityOrder(segment, file, what) {
  let previous = -1;
  for (const convention of CONVENTIONS) {
    const index = segment.indexOf(convention);
    assert.ok(index >= 0, `${file} 的 ${what} 缺少 ${convention}`);
    assert.ok(
      index > previous,
      `${file} 的 ${what} 候选优先级被改：${convention} 必须排在前一约定之后（spec R1）`,
    );
    previous = index;
  }
}

function extractBlock(source, startMarker, endMarker, file, what) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${file} 找不到 ${what}（源码结构变了？同步更新本测试与 spec）`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `${file} 的 ${what} 无法截取结束边界`);
  return source.slice(start, end);
}

test("pluginSyncService：PLUGIN_MANIFEST_RELATIVE_PATHS 四约定同序", () => {
  const source = read("../src/plugin-sync/pluginSyncService.ts");
  const block = extractBlock(
    source,
    "const PLUGIN_MANIFEST_RELATIVE_PATHS = [",
    "] as const;",
    "pluginSyncService.ts",
    "PLUGIN_MANIFEST_RELATIVE_PATHS",
  );
  assertPriorityOrder(block, "pluginSyncService.ts", "PLUGIN_MANIFEST_RELATIVE_PATHS");
});

test("commandsService：findPluginManifestPath 候选含 .cursor-plugin 且同序", () => {
  const source = read("../src/commands/commandsService.ts");
  assertAllConventionsPresent(source, "commandsService.ts");
  const fn = extractBlock(
    source,
    "async function findPluginManifestPath(",
    "\n}\n",
    "commandsService.ts",
    "findPluginManifestPath",
  );
  const order = [
    "ACODE_PLUGIN_MANIFEST_PATH",
    "CLAUDE_PLUGIN_MANIFEST_PATH",
    "CODEX_PLUGIN_MANIFEST_PATH",
    "CURSOR_PLUGIN_MANIFEST_PATH",
  ];
  let previous = -1;
  for (const name of order) {
    const index = fn.indexOf(name);
    assert.ok(index >= 0, `commandsService.ts 的 findPluginManifestPath 缺少 ${name}`);
    assert.ok(index > previous, `commandsService.ts 的候选优先级被改：${name} 顺序错误`);
    previous = index;
  }
});

test("settingsSyncService：findPluginManifestPath 候选含 .cursor-plugin 且同序", () => {
  const source = read("../src/settings-sync/settingsSyncService.ts");
  assertAllConventionsPresent(source, "settingsSyncService.ts");
  const fn = extractBlock(
    source,
    "async function findPluginManifestPath(",
    "\n}\n",
    "settingsSyncService.ts",
    "findPluginManifestPath",
  );
  const order = [
    "ACODE_PLUGIN_MANIFEST_PATH",
    "CLAUDE_PLUGIN_MANIFEST_PATH",
    "CODEX_PLUGIN_MANIFEST_PATH",
    "CURSOR_PLUGIN_MANIFEST_PATH",
  ];
  let previous = -1;
  for (const name of order) {
    const index = fn.indexOf(name);
    assert.ok(index >= 0, `settingsSyncService.ts 的 findPluginManifestPath 缺少 ${name}`);
    assert.ok(index > previous, `settingsSyncService.ts 的候选优先级被改：${name} 顺序错误`);
    previous = index;
  }
});

test("skillsService：findPluginManifestPath 候选含 .cursor-plugin 且同序", () => {
  const source = read("../src/skills/skillsService.ts");
  assertAllConventionsPresent(source, "skillsService.ts");
  const fn = extractBlock(
    source,
    "async function findPluginManifestPath(",
    "\n}\n",
    "skillsService.ts",
    "findPluginManifestPath",
  );
  const order = [
    "ACODE_PLUGIN_MANIFEST_PATH",
    "CLAUDE_PLUGIN_MANIFEST_PATH",
    "CODEX_PLUGIN_MANIFEST_PATH",
    "CURSOR_PLUGIN_MANIFEST_PATH",
  ];
  let previous = -1;
  for (const name of order) {
    const index = fn.indexOf(name);
    assert.ok(index >= 0, `skillsService.ts 的 findPluginManifestPath 缺少 ${name}`);
    assert.ok(index > previous, `skillsService.ts 的候选优先级被改：${name} 顺序错误`);
    previous = index;
  }
});

test("subagentsService：PLUGIN_MANIFEST_PATHS 四约定同序", () => {
  const source = read("../src/subagents/subagentsService.ts");
  const block = extractBlock(
    source,
    "const PLUGIN_MANIFEST_PATHS = [",
    "] as const;",
    "subagentsService.ts",
    "PLUGIN_MANIFEST_PATHS",
  );
  assertPriorityOrder(block, "subagentsService.ts", "PLUGIN_MANIFEST_PATHS");
});
