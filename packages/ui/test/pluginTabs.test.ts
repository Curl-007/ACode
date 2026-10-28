// PluginsSection 批次 4 helper 外迁（settings/plugins/pluginTabs.ts）的接缝内决策表单测：
//   - normalizePluginTab：commands → plugins 归一 + plugins/mcps/skills 原样保留；
//   - getPluginTabCountClass：选中/未选中 4×4 全矩阵（subtle vs subtlest）。
// 原本地 workspaceKey 系 PluginScopeMenu.getPluginWorkspaceKey 的纯委托别名（函数体仅一行
// 转发），外迁时已去重删除、调用点统一改用 getPluginWorkspaceKey，故不迁移也不在此测。
import assert from "node:assert/strict";
import test from "node:test";
import {
  getPluginTabCountClass,
  normalizePluginTab,
  type PluginTab,
  type PluginTabTarget,
} from "../src/settings/plugins/pluginTabs.js";

test("normalizePluginTab：commands 归一为 plugins", () => {
  assert.equal(normalizePluginTab("commands"), "plugins");
});

test("normalizePluginTab：plugins/mcps/skills 原样保留", () => {
  const passthrough: readonly (readonly [PluginTabTarget, PluginTab])[] = [
    ["plugins", "plugins"],
    ["mcps", "mcps"],
    ["skills", "skills"],
  ];
  for (const [input, expected] of passthrough) {
    assert.equal(normalizePluginTab(input), expected);
  }
});

test("getPluginTabCountClass：选中用 foreground-subtle，未选中用 foreground-subtlest（4×4 矩阵）", () => {
  const tabs = ["plugins", "mcps", "skills", "commands"] as const;
  for (const tab of tabs) {
    for (const selected of tabs) {
      assert.equal(
        getPluginTabCountClass(tab, selected),
        tab === selected
          ? "text-ui-sm text-foreground-subtle"
          : "text-ui-sm text-foreground-subtlest",
        `tab=${tab} selected=${selected}`,
      );
    }
  }
});
