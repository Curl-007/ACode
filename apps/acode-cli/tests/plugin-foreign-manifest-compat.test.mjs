import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * 跨厂商插件清单兼容的源码不变量守护（spec: apps/acode-cli/specs/plugin-foreign-manifest-compat.md）。
 *
 * 背景：技能发现层自初始提交起就接受 .cursor-plugin/plugin.json，但插件发现/市场/zip
 * 安装层长期缺这一候选——同一目录约定在不同层判定不一致，Cursor 约定打包的插件
 * 「skills 能被发现、插件本体装不进」。本测试锁定 R1 候选集与 R2 发现点清单：
 * 任一发现点漏掉 .cursor-plugin、或优先级顺序被改（acode > claude > codex > cursor），
 * 即失败。新增发现点时必须同步更新 spec 与本测试。
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

/** 断言 candidates 文本片段中四个约定按 R1 优先级出现（首个存在者生效 ⇒ 顺序即优先级）。 */
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

test("plugins/index.ts：findManifest 候选含 .cursor-plugin 且优先级顺序正确", () => {
  const source = read("../packages/adapters/src/plugins/index.ts");
  assertAllConventionsPresent(source, "plugins/index.ts");
  const fn = extractBlock(
    source,
    "function findManifest(",
    "\n}\n",
    "plugins/index.ts",
    "findManifest",
  );
  // findManifest 以常量表达候选：按常量名断言顺序，并核对常量定义映射到正确目录。
  const order = [
    "ACODE_MANIFEST_PATH",
    "CLAUDE_MANIFEST_PATH",
    "CODEX_MANIFEST_PATH",
    "CURSOR_MANIFEST_PATH",
  ];
  let previous = -1;
  for (const name of order) {
    const index = fn.indexOf(name);
    assert.ok(index >= 0, `plugins/index.ts 的 findManifest 缺少 ${name}`);
    assert.ok(index > previous, `plugins/index.ts 的候选优先级被改：${name} 顺序错误`);
    previous = index;
  }
  for (const [name, convention] of [
    ["ACODE_MANIFEST_PATH", ".acode-plugin"],
    ["CLAUDE_MANIFEST_PATH", ".claude-plugin"],
    ["CODEX_MANIFEST_PATH", ".codex-plugin"],
    ["CURSOR_MANIFEST_PATH", ".cursor-plugin"],
  ]) {
    assert.ok(
      source.includes(`const ${name} = join("${convention}", "plugin.json")`),
      `plugins/index.ts 的 ${name} 必须指向 ${convention}/plugin.json`,
    );
  }
});

test("plugins/marketplace.ts：findPluginManifestPath 候选含 .cursor-plugin 且优先级顺序正确", () => {
  const source = read("../packages/adapters/src/plugins/marketplace.ts");
  const fn = extractBlock(
    source,
    "function findPluginManifestPath(",
    "\n}\n",
    "plugins/marketplace.ts",
    "findPluginManifestPath",
  );
  // marketplace.ts 以常量数组表达候选：按常量名断言顺序，并核对常量定义映射到正确目录。
  const order = [
    "ACODE_MANIFEST_PATH",
    "CLAUDE_MANIFEST_PATH",
    "CODEX_MANIFEST_PATH",
    "CURSOR_MANIFEST_PATH",
  ];
  let previous = -1;
  for (const name of order) {
    const index = fn.indexOf(name);
    assert.ok(index >= 0, `plugins/marketplace.ts 的 findPluginManifestPath 缺少 ${name}`);
    assert.ok(index > previous, `plugins/marketplace.ts 的候选优先级被改：${name} 顺序错误`);
    previous = index;
  }
  for (const [name, convention] of [
    ["ACODE_MANIFEST_PATH", ".acode-plugin"],
    ["CLAUDE_MANIFEST_PATH", ".claude-plugin"],
    ["CODEX_MANIFEST_PATH", ".codex-plugin"],
    ["CURSOR_MANIFEST_PATH", ".cursor-plugin"],
  ]) {
    assert.ok(
      source.includes(`const ${name} = join("${convention}", "plugin.json")`),
      `plugins/marketplace.ts 的 ${name} 必须指向 ${convention}/plugin.json`,
    );
  }
});

test("plugins/zip-source.ts：hasPluginManifest 候选含 .cursor-plugin 且优先级顺序正确", () => {
  const source = read("../packages/adapters/src/plugins/zip-source.ts");
  const fn = extractBlock(
    source,
    "function hasPluginManifest(",
    "\n}\n",
    "plugins/zip-source.ts",
    "hasPluginManifest",
  );
  assertPriorityOrder(fn, "plugins/zip-source.ts", "hasPluginManifest");
});

test("skills/index.ts：PLUGIN_MANIFEST_RELATIVE_PATHS 保持四约定同序（既有先例，防回归）", () => {
  const source = read("../packages/adapters/src/skills/index.ts");
  const block = extractBlock(
    source,
    "const PLUGIN_MANIFEST_RELATIVE_PATHS = [",
    "] as const;",
    "skills/index.ts",
    "PLUGIN_MANIFEST_RELATIVE_PATHS",
  );
  assertPriorityOrder(block, "skills/index.ts", "PLUGIN_MANIFEST_RELATIVE_PATHS");
});
