import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { test } from "node:test";

/**
 * 商店描述与同名技能双拷贝的一致性守护（specs/skill-seeding-registration.md R3/R4，
 * 验收场景 6/7）。
 *
 * R3：plugin.json 是商店描述的事实源；definitions 的 listing.description_i18n 只是
 * 回退文案——两源都声明同一 locale 时必须逐字一致（外部范式「两处冗余逐字相同」）。
 * R4：一个技能名不得同时由 bundled 技能包与官方插件包携带（单源，避免陈旧副本继续
 * 进模型技能列表且路由文本矛盾）。dynamic-workflows 的双拷贝漂移已于 2026-10-15 按
 * 方案 b 裁决修复：删除 acode-guide-plugin 的陈旧副本，bundled 技能包成为唯一来源
 * （安装版技能列表实际指向 bundled 侧内容，且 bundled 副本与当前工具集吻合）。本测试
 * 钉住该裁决：任何 bundled∩官方插件的同名技能即红，并显式断言已删副本不得复活。
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliRoot = join(repoRoot, "apps", "acode-cli");
const packagesRoot = join(cliRoot, "packages");
const bundledSkillsRoot = join(packagesRoot, "bundled-skills", "skills");

const { OFFICIAL_PLUGIN_DEFINITIONS } =
  await import("../packages/bootstrap/src/app/official-plugin-definitions.ts");

/**
 * 已裁决单源化的技能名（2026-10-15 方案 b）：bundled 是唯一来源，官方插件不得再携带
 * 同名副本。用于对已删副本做显式防复活断言。
 */
const SINGLE_SOURCE_SKILLS = new Set(["dynamic-workflows"]);

function pluginPackageDir(definition) {
  return join(cliRoot, definition.rootCandidates[0]);
}

function readPluginManifest(definition) {
  return JSON.parse(
    readFileSync(join(pluginPackageDir(definition), ".acode-plugin", "plugin.json"), "utf8"),
  );
}

test("definitions listing 与 plugin.json 的 description_i18n 同 locale 逐字一致（spec R3）", () => {
  let compared = 0;
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    const listingI18n = definition.listing?.description_i18n ?? {};
    const manifestI18n = readPluginManifest(definition).description_i18n ?? {};
    for (const [locale, listingText] of Object.entries(listingI18n)) {
      const manifestText = manifestI18n[locale];
      if (manifestText === undefined) continue; // 包内未声明该 locale：listing 是唯一来源，无冗余
      compared += 1;
      assert.equal(
        listingText,
        manifestText,
        `${definition.name} [${locale}]: definitions listing 与 plugin.json description_i18n 漂移（事实源是 plugin.json）`,
      );
    }
  }
  // 漂移修复后此处应 ≥6：agent-teams、image-search、documents/pdf/presentations/spreadsheets。
  assert.ok(
    compared >= 6,
    `同 locale 对照数量异常（${compared}），检查 listing/manifest 结构是否变化`,
  );
});

function listSkillDirectories(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test("技能名单源：bundled∩官方插件无同名技能，已删副本不复活（spec R4）", () => {
  const bundledSkillNames = new Set(listSkillDirectories(bundledSkillsRoot));
  assert.ok(bundledSkillNames.size > 0, "bundled 技能包为空，检查仓库布局");

  // 已裁决单源化的技能必须在 bundled 侧存在（唯一来源），否则 /workflow 无技能可挂载。
  for (const skillName of SINGLE_SOURCE_SKILLS) {
    assert.ok(
      bundledSkillNames.has(skillName),
      `${skillName} 必须存在于 bundled 技能包（单源，spec R4）`,
    );
  }

  const overlaps = [];
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    const packageDir = pluginPackageDir(definition);
    const dirName = relative(packagesRoot, packageDir).split(/[/\\]/u).join("/");
    for (const skillName of listSkillDirectories(join(packageDir, "skills"))) {
      // 官方插件携带与 bundled 同名的技能 = 双源，违反 R4（陈旧副本会进模型技能列表且路由矛盾）。
      if (bundledSkillNames.has(skillName)) overlaps.push(`${dirName}/skills/${skillName}`);
    }
  }
  assert.deepEqual(
    overlaps,
    [],
    `官方插件不得携带与 bundled 技能包同名的技能（单源，spec R4）。发现双拷贝：${overlaps.join(", ")}`,
  );
});
