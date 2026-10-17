// specs/plugin-marketplace-defaults.md 验收场景 1：种子集条目与开关门控钉住。
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getOfficialServiceSwitches,
  setOfficialServiceSwitches,
} from "../src/officialPlatformPolicy.js";
import {
  ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  DEFAULT_PLUGIN_MARKETPLACES,
  WASP_NEST_MARKETPLACE_ID,
  resolveDefaultPluginMarketplaces,
} from "../src/plugin-marketplaces.js";

describe("plugin-marketplace-defaults（预置市场种子集）", () => {
  const savedSwitches = getOfficialServiceSwitches();
  // 开关是模块级状态：每用例还原，避免跨用例泄漏影响同进程其它测试。
  afterEach(() => setOfficialServiceSwitches(savedSwitches));

  it("wasp-nest 条目：canonical id、GitHub 源与 manifest 事实字段", () => {
    const entry = DEFAULT_PLUGIN_MARKETPLACES.find((m) => m.id === WASP_NEST_MARKETPLACE_ID);
    assert.ok(entry, "种子表必须含 wasp-nest");
    // id/name 与其 .claude-plugin/marketplace.json 的 name 一致（spec 规则 2：
    // 不一致会让注册表出现同来源双条目）。source 用 owner/repo 简写——种子解析器
    // 只把简写归为 github 源，完整 URL 会被误当直指 JSON 的 url 源。
    assert.equal(entry.name, "wasp-nest");
    assert.equal(entry.source, "legioncodeinc/vibe-coding-tools");
    assert.equal(entry.pluginCount, 21);
  });

  it("marketplace 开关关闭时不 seed 任何远程市场（审计版默认断连）", () => {
    setOfficialServiceSwitches({ marketplace: false });
    assert.deepEqual(resolveDefaultPluginMarketplaces(), []);
  });

  it("marketplace 开关开启时官方与 wasp-nest 全部进入种子集", () => {
    setOfficialServiceSwitches({ marketplace: true });
    assert.deepEqual(
      resolveDefaultPluginMarketplaces().map((m) => m.id),
      [ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID, WASP_NEST_MARKETPLACE_ID],
    );
  });

  it("官方市场条目原样保留（CDN canonical id 约束不变）", () => {
    const official = DEFAULT_PLUGIN_MARKETPLACES.find(
      (m) => m.id === ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    );
    assert.ok(official);
    assert.equal(official.name, ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID);
    assert.equal(official.source, "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json");
  });
});
