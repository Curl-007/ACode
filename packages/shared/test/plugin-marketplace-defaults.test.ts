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
  ZCODE_PRO_MARKETPLACE_ID,
  ZH_MIRROR_CLAUDE_CODE_MARKETPLACE_ID,
  ZH_MIRROR_CLAUDE_OFFICIAL_MARKETPLACE_ID,
  ZH_MIRROR_CODEX_MARKETPLACE_ID,
  resolveDefaultPluginMarketplaces,
} from "../src/plugin-marketplaces.js";

const ZH_MIRROR_RAW_BASE =
  "https://raw.githubusercontent.com/chen-da-pang/zcode-marketplace-zh/main/dist";

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

  it("zcode-plugins 条目：canonical id、GitHub 简写源与 manifest 事实字段", () => {
    const entry = DEFAULT_PLUGIN_MARKETPLACES.find((m) => m.id === ZCODE_PRO_MARKETPLACE_ID);
    assert.ok(entry, "种子表必须含 zcode-plugins（ZcodePro）");
    // id/name 与仓库根 marketplace.json 的 name 一致（不是仓库名 ZcodePro）。
    assert.equal(entry.name, "zcode-plugins");
    assert.equal(entry.source, "luxi233/ZcodePro");
    assert.equal(entry.pluginCount, 13);
  });

  it("zh 镜像三条目：raw URL 直指 dist JSON、id 与清单顶层 name 一致", () => {
    const expected: Array<[string, string, number]> = [
      [ZH_MIRROR_CLAUDE_OFFICIAL_MARKETPLACE_ID, "claude-plugins-official.json", 315],
      [ZH_MIRROR_CLAUDE_CODE_MARKETPLACE_ID, "claude-code-plugins.json", 13],
      [ZH_MIRROR_CODEX_MARKETPLACE_ID, "codex-official.json", 65],
    ];
    for (const [id, file, pluginCount] of expected) {
      const entry = DEFAULT_PLUGIN_MARKETPLACES.find((m) => m.id === id);
      assert.ok(entry, `种子表必须含 zh 镜像 ${id}`);
      assert.equal(entry.name, id);
      // url 源必须直指 manifest JSON（raw dist 地址）；写仓库页会被解析器当成
      // 直指 JSON 的 url 源而拉取失败（spec 规则 3）。
      assert.equal(entry.source, `${ZH_MIRROR_RAW_BASE}/${file}`);
      assert.equal(entry.pluginCount, pluginCount);
    }
  });

  it("marketplace 开关关闭时不 seed 任何远程市场（审计版默认断连）", () => {
    setOfficialServiceSwitches({ marketplace: false });
    assert.deepEqual(resolveDefaultPluginMarketplaces(), []);
  });

  it("marketplace 开关开启时官方与全部第三方条目按序进入种子集", () => {
    setOfficialServiceSwitches({ marketplace: true });
    assert.deepEqual(
      resolveDefaultPluginMarketplaces().map((m) => m.id),
      [
        ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
        WASP_NEST_MARKETPLACE_ID,
        ZCODE_PRO_MARKETPLACE_ID,
        ZH_MIRROR_CLAUDE_OFFICIAL_MARKETPLACE_ID,
        ZH_MIRROR_CLAUDE_CODE_MARKETPLACE_ID,
        ZH_MIRROR_CODEX_MARKETPLACE_ID,
      ],
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
