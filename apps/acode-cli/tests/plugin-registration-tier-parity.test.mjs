import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 官方插件 manifest tier parity（specs/skill-seeding-registration.md R1，验收场景 1/2）。
 *
 * tier 是包内自描述的默认启停声明（闭集 always/default_false），过渡期与
 * official-plugin-definitions.ts 的 defaultEnabled 双源并存——本测试机械对照两处，
 * 漂移即红。同时单测 adapters 的 resolvePluginDefaultEnabled 派生顺序：
 * 官方市场 tier 优先于 bootstrap 默认名单；inline/第三方市场忽略 tier；
 * 非法 tier 出 warning 诊断并按缺省语义；用户显式配置永远最高。
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliRoot = join(repoRoot, "apps", "acode-cli");

const { OFFICIAL_PLUGIN_DEFINITIONS } =
  await import("../packages/bootstrap/src/app/official-plugin-definitions.ts");
const { PLUGIN_MANIFEST_TIERS, resolvePluginDefaultEnabled } =
  await import("../packages/adapters/src/plugins/manifest-tier.ts");
const { resolveEnabled } = await import("../packages/adapters/src/plugins/manifest-tier.ts");

const OFFICIAL_MARKETPLACE = "acode-plugins-official";

/**
 * 例外登记（spec R1）：plugin.json 被第三方发布台账 sha256 逐字钉住
 * （third-party/inventory.json，L01 门禁）的插件，加 tier 必须同批再生台账，
 * 期间在此登记豁免。baseline 只许缩小：computer-use 已于批 2 补 tier
 * （default_false）并同批再生台账，baseline 现为空——机制保留给未来同类例外。
 */
const TIER_PENDING_LEDGER_REGENERATION = new Set([]);

function readPluginManifest(definition) {
  // rootCandidates 首项恒为 "packages/<dir>"，相对 apps/acode-cli 根。
  const manifestPath = join(cliRoot, definition.rootCandidates[0], ".acode-plugin", "plugin.json");
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

test("全部官方插件声明合法 tier，且与 definitions.defaultEnabled 真值一致（spec R1）", () => {
  assert.ok(OFFICIAL_PLUGIN_DEFINITIONS.length >= 15, "官方插件定义数量异常，检查是否漏改");
  const definitionNames = new Set(OFFICIAL_PLUGIN_DEFINITIONS.map((item) => item.name));
  for (const pending of TIER_PENDING_LEDGER_REGENERATION) {
    assert.ok(definitionNames.has(pending), `例外 baseline 含未知插件 ${pending}，请清理`);
  }
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    const manifest = readPluginManifest(definition);
    if (TIER_PENDING_LEDGER_REGENERATION.has(definition.name)) {
      assert.equal(
        manifest.tier,
        undefined,
        `${definition.name}: 台账例外插件补上 tier 后必须缩小 TIER_PENDING_LEDGER_REGENERATION baseline`,
      );
      assert.notEqual(
        definition.defaultEnabled,
        true,
        `${definition.name}: 无 tier 的例外插件必须保持非默认启用（缺省=现状）`,
      );
      continue;
    }
    assert.ok(
      PLUGIN_MANIFEST_TIERS.includes(manifest.tier),
      `${definition.name}: plugin.json tier 缺失或非法（${JSON.stringify(manifest.tier)}），闭集 ${PLUGIN_MANIFEST_TIERS.join("|")}`,
    );
    assert.equal(
      manifest.tier === "always",
      definition.defaultEnabled === true,
      `${definition.name}: tier 与 definitions.defaultEnabled 漂移（过渡期必须同真值）`,
    );
  }
});

function decide({
  candidateDefaultEnabled = false,
  marketplace = OFFICIAL_MARKETPLACE,
  officialPluginsEnabledByDefault,
  tier,
}) {
  return resolvePluginDefaultEnabled({
    candidateDefaultEnabled,
    manifest: tier === undefined ? { name: "p" } : { name: "p", tier },
    manifestPath: "/fake/.acode-plugin/plugin.json",
    marketplace,
    officialPluginsEnabledByDefault,
    pluginId: `p@${marketplace}`,
  });
}

test("官方市场：tier=always 单独即默认开；default_false 压过 bootstrap 默认名单（tier 优先）", () => {
  assert.equal(decide({ tier: "always" }).defaultEnabled, true);
  const overridden = decide({
    officialPluginsEnabledByDefault: new Set([`p@${OFFICIAL_MARKETPLACE}`]),
    tier: "default_false",
  });
  assert.equal(overridden.defaultEnabled, false);
  assert.equal(overridden.diagnostic, undefined);
});

test("缺省 tier 保持现状语义：candidate.defaultEnabled || bootstrap 默认名单", () => {
  assert.equal(decide({}).defaultEnabled, false);
  assert.equal(decide({ candidateDefaultEnabled: true }).defaultEnabled, true);
  assert.equal(
    decide({ officialPluginsEnabledByDefault: new Set([`p@${OFFICIAL_MARKETPLACE}`]) })
      .defaultEnabled,
    true,
  );
});

test("非官方市场忽略 tier：第三方插件不得自我声明默认启用", () => {
  const inline = decide({ marketplace: "inline", tier: "always" });
  assert.equal(inline.defaultEnabled, false);
  assert.equal(inline.diagnostic, undefined);
  const thirdParty = decide({ marketplace: "some-market", tier: "always" });
  assert.equal(thirdParty.defaultEnabled, false);
});

test("非法 tier：warning 诊断（plugin_manifest_invalid）并按缺省语义处理", () => {
  for (const invalid of ["ALWAYS", "default-true", "", 42, null, { tier: "always" }]) {
    const decision = decide({
      officialPluginsEnabledByDefault: new Set([`p@${OFFICIAL_MARKETPLACE}`]),
      tier: invalid,
    });
    // null 经 JSON manifest 不出现（undefined 才是缺省）；此处按非法值处理。
    assert.equal(
      decision.defaultEnabled,
      true,
      `非法 tier ${JSON.stringify(invalid)} 应回退名单语义`,
    );
    assert.ok(decision.diagnostic, `非法 tier ${JSON.stringify(invalid)} 必须出诊断`);
    assert.equal(decision.diagnostic.code, "plugin_manifest_invalid");
    assert.equal(decision.diagnostic.severity, "warning");
  }
});

test("用户显式配置永远最高：enabledPlugins[id] 压过 tier 与默认名单", () => {
  const config = { enabledPlugins: { [`p@${OFFICIAL_MARKETPLACE}`]: false }, options: {} };
  assert.equal(
    resolveEnabled(config, `p@${OFFICIAL_MARKETPLACE}`, decide({ tier: "always" }).defaultEnabled),
    false,
  );
  const configOn = { enabledPlugins: { [`p@${OFFICIAL_MARKETPLACE}`]: true }, options: {} };
  assert.equal(
    resolveEnabled(
      configOn,
      `p@${OFFICIAL_MARKETPLACE}`,
      decide({ tier: "default_false" }).defaultEnabled,
    ),
    true,
  );
});
