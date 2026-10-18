import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 智谱 BigModel 技能集 8 个分类插件的入库守护
 * （specs/bigmodel-skills-marketplace-plugins.md R1/R2/R5/R6）。
 *
 * 钉住四件事：
 * 1. 包与注册面一致：plugin.json（name/tier/version）↔ definition ↔ 磁盘锚点；
 * 2. 全部技能可被 adapters 加载器接受：frontmatter name/description 齐备、
 *    description ≤ 上限、无 SAFE_FRONTMATTER_KEYS 之外的键（保 safeToAutoLoad=true）；
 * 3. 技能名全局唯一：8 包之间、与 bundled 技能包、与其余官方插件互不冲突
 *    （frontmatter name 与目录名两个维度，扩展 skill-seeding-registration.md R4 单源守护）；
 * 4. 覆盖完整：125 技能一个不多一个不少，重命名映射（R3）显式钉住。
 */

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const cliRoot = join(repoRoot, "apps", "acode-cli");
const packagesRoot = join(cliRoot, "packages");

const { OFFICIAL_PLUGIN_DEFINITIONS } = await import(
  "../packages/bootstrap/src/app/official-plugin-definitions.ts"
);
const { SAFE_FRONTMATTER_KEYS } = await import(
  "../packages/adapters/src/skills/frontmatter-governance.ts"
);
const { extractFrontmatter, parseFlatYaml } = await import(
  "../packages/adapters/src/skills/frontmatter-text.ts"
);

/** adapters/src/skills/index.ts MAX_DESCRIPTION_LENGTH 的本地镜像（超限即拒绝加载）。 */
const MAX_DESCRIPTION_LENGTH = 1024;

/** [包后缀, 期望技能数]（spec R1 表；总数 125 = 源离线包全量）。 */
const EXPECTED_PACKAGES = [
  ["dev", 28],
  ["data", 21],
  ["office", 16],
  ["management", 15],
  ["sales", 14],
  ["content", 12],
  ["product", 12],
  ["ops", 7],
];

function packageDir(suffix) {
  return join(packagesRoot, `bigmodel-skills-${suffix}-plugin`);
}

function skillDirectories(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** 解析技能 frontmatter；无围栏时按加载器同款回退（目录名当 name，不判失败）。 */
function readSkillFrontmatter(skillMdPath) {
  const frontmatter = extractFrontmatter(readFileSync(skillMdPath, "utf8"));
  if (!frontmatter) return { values: {}, keys: [] };
  const diagnostics = [];
  const parsed = parseFlatYaml(frontmatter, skillMdPath, diagnostics);
  return { values: parsed.values, keys: parsed.keys };
}

test("(R1/R5) 8 包 manifest 与 definition 一致且默认关闭", () => {
  for (const [suffix] of EXPECTED_PACKAGES) {
    const dir = packageDir(suffix);
    const manifestPath = join(dir, ".acode-plugin", "plugin.json");
    assert.ok(existsSync(manifestPath), `缺 manifest: ${manifestPath}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const pluginName = `bigmodel-skills-${suffix}`;
    assert.equal(manifest.name, pluginName, `${pluginName}: manifest name 必须等于目录名去后缀`);
    assert.equal(manifest.tier, "default_false", `${pluginName}: 必须默认关闭（spec R5）`);
    assert.equal(manifest.skills, "skills", `${pluginName}: skills 必须声明为 skills 目录`);
    assert.ok(existsSync(join(dir, "skills")), `${pluginName}: 缺 skills 目录`);

    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find(
      (candidate) => candidate.name === pluginName,
    );
    assert.ok(definition, `${pluginName}: 缺 official plugin definition`);
    assert.equal(
      definition.version,
      manifest.version,
      `${pluginName}: definition 与 plugin.json 版本漂移（R7 三处一致）`,
    );
    assert.equal(
      definition.defaultEnabled,
      undefined,
      `${pluginName}: tier=default_false 的插件不得声明 defaultEnabled（R5 parity）`,
    );
    // seed 完整性门锚点必须真实在盘（staging 脚本打包时才校验，这里提前钉住）。
    for (const seedPath of definition.requiredSeedPaths ?? []) {
      assert.ok(
        existsSync(join(dir, ...seedPath.split("/"))),
        `${pluginName}: requiredSeedPaths 锚点缺失: ${seedPath}`,
      );
    }
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.name, `@acode/bigmodel-skills-${suffix}-plugin`);
    assert.equal(pkg.version, manifest.version, `${pluginName}: package.json 版本漂移`);
  }
});

test("(R6) 125 技能全部可加载：name/description 齐备、长度合规、无未知 frontmatter 键", () => {
  let total = 0;
  for (const [suffix, expectedCount] of EXPECTED_PACKAGES) {
    const skillsRoot = join(packageDir(suffix), "skills");
    const dirs = skillDirectories(skillsRoot);
    assert.equal(
      dirs.length,
      expectedCount,
      `bigmodel-skills-${suffix}: 技能数 ${dirs.length} ≠ 期望 ${expectedCount}（spec R1）`,
    );
    total += dirs.length;
    for (const dir of dirs) {
      const skillMd = join(skillsRoot, dir, "SKILL.md");
      assert.ok(existsSync(skillMd), `缺 SKILL.md: ${skillMd}`);
      const { values, keys } = readSkillFrontmatter(skillMd);
      const label = `bigmodel-skills-${suffix}/${dir}`;
      assert.ok(values.name?.trim(), `${label}: frontmatter 缺 name`);
      assert.ok(values.description?.trim(), `${label}: frontmatter 缺 description`);
      assert.ok(
        values.description.length <= MAX_DESCRIPTION_LENGTH,
        `${label}: description ${values.description.length} 超过加载器上限 ${MAX_DESCRIPTION_LENGTH}`,
      );
      for (const key of keys) {
        assert.ok(
          SAFE_FRONTMATTER_KEYS.has(key),
          `${label}: 未知 frontmatter 键 "${key}" 会置 safeToAutoLoad=false（spec R3/R6）`,
        );
      }
      // R2：逐技能署名文件不得在收录时丢失。
      assert.ok(
        existsSync(join(skillsRoot, dir, "LICENSE")),
        `${label}: 缺 LICENSE（spec R2 署名纪律）`,
      );
    }
  }
  assert.equal(total, 125, `技能总数 ${total} ≠ 125（源离线包全量，spec R6/4）`);
});

test("(R6) 技能名全局唯一：8 包 ∪ bundled ∪ 其余官方插件无同名（name 与目录双维度）", () => {
  const nameOwner = new Map();
  const dirOwner = new Map();
  const collect = (skillsRoot, owner) => {
    for (const dir of skillDirectories(skillsRoot)) {
      const skillMd = join(skillsRoot, dir, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const { values } = readSkillFrontmatter(skillMd);
      const name = values.name ?? dir;
      assert.ok(
        !nameOwner.has(name),
        `技能名冲突: "${name}" 同时出现在 ${nameOwner.get(name)} 与 ${owner}/${dir}`,
      );
      nameOwner.set(name, `${owner}/${dir}`);
      assert.ok(
        !dirOwner.has(dir),
        `技能目录名冲突: "${dir}" 同时出现在 ${dirOwner.get(dir)} 与 ${owner}`,
      );
      dirOwner.set(dir, owner);
    }
  };

  collect(join(packagesRoot, "bundled-skills", "skills"), "bundled-skills");
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    // definition.rootCandidates[0] 是 monorepo 布局（packages/<dir>），测试环境唯一可解析项。
    const skillsRoot = join(cliRoot, definition.rootCandidates[0], "skills");
    collect(skillsRoot, definition.name);
  }
  assert.ok(nameOwner.size >= 125 + 7, "收集面异常缩水，检查扫描逻辑");
});

test("(R3) 重命名映射钉住：slug 目录在位，含空格/大写的源目录名不得出现", () => {
  const dataSkills = join(packageDir("data"), "skills");
  const salesSkills = join(packageDir("sales"), "skills");
  assert.ok(existsSync(join(dataSkills, "excel-analysis", "SKILL.md")), "excel-analysis 缺失");
  const { values } = readSkillFrontmatter(join(dataSkills, "excel-analysis", "SKILL.md"));
  assert.equal(values.name, "excel-analysis", "excel-analysis frontmatter name 未同步 slug");
  assert.ok(
    existsSync(join(salesSkills, "lead-research-assistant", "SKILL.md")),
    "lead-research-assistant 缺失",
  );
  for (const [suffix] of EXPECTED_PACKAGES) {
    for (const dir of skillDirectories(join(packageDir(suffix), "skills"))) {
      assert.match(
        dir,
        /^[a-z0-9][a-z0-9-]*$/,
        `bigmodel-skills-${suffix}: 技能目录 "${dir}" 不符合 slug 惯例（spec R3）`,
      );
    }
  }
});
