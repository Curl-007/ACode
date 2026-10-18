// specs/skills-bundled-visibility-and-official-cache-authority.md §七 S1-S7：
// services 侧 bundled scope 行为（S1-S4）与官方 cache 分片权威消费（S5-S7）。
// S5-S7 经导出的 scanOfficialPluginCacheRoots 直接注入 tmp fixture：pluginStorageRoot
// 由 readCliConfigFile()（真实 HOME）推导，list() 全链无法注入，数据源层语义以此覆盖
// （诚实登记：未走 list() 端到端；接线由 S1-S4 + typecheck 覆盖）。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createSkillsService, scanOfficialPluginCacheRoots } from "../src/skills/skillsService.js";

const OFFICIAL_MARKETPLACE_DIR = "acode-plugins-official";

function bundledSkillMarkdown(name: string): string {
  return `---
name: ${name}
description: Bundled fixture skill ${name}.
---

${name} fixture body.
`;
}

async function writeSkillDir(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "SKILL.md"), bundledSkillMarkdown(name), "utf-8");
}

async function writeOfficialCacheFixture(params: {
  pluginStorageRoot: string;
  /** cache/<plugin>/<version> 形状的目录列表。 */
  versionDirs: string[];
}): Promise<string> {
  const cacheRoot = join(params.pluginStorageRoot, "cache", OFFICIAL_MARKETPLACE_DIR);
  for (const versionDir of params.versionDirs) {
    await mkdir(join(cacheRoot, versionDir), { recursive: true });
  }
  return cacheRoot;
}

async function writePartition(pluginStorageRoot: string, content: string): Promise<void> {
  const partitionDir = join(pluginStorageRoot, "marketplaces", OFFICIAL_MARKETPLACE_DIR);
  await mkdir(partitionDir, { recursive: true });
  await writeFile(join(partitionDir, "bundled-marketplace.json"), content, "utf-8");
}

describe("skillsService bundled scope（S1-S4）", () => {
  let tmpRoot: string;
  let bundledRoot: string;
  let workspacePath: string;

  // 每用例独立 fixture：list/setEnabled/deleteSkill 共享模块级真实 HOME 配置读取，
  // 断言只针对 bundled 条目，不依赖真实环境的 user/plugin 技能集合。
  const cleanup: (() => Promise<void>)[] = [];
  after(async () => {
    for (const dispose of cleanup.reverse()) {
      await dispose();
    }
  });

  async function setupFixture(): Promise<void> {
    tmpRoot = await mkdtemp(join(tmpdir(), "acode-skills-bundled-"));
    cleanup.push(async () => rm(tmpRoot, { recursive: true, force: true }));
    bundledRoot = join(tmpRoot, "bundled-skills");
    workspacePath = join(tmpRoot, "workspace");
    await writeSkillDir(bundledRoot, "bundled-alpha-fixture");
    await writeSkillDir(bundledRoot, "bundled-beta-fixture");
  }

  it("S1：注入 bundledSkillsRoot → list 含 scope:bundled、enabled:true、无 pluginName/pluginId 条目", async () => {
    await setupFixture();
    const service = createSkillsService({
      isDesktopRuntime: true,
      bundledSkillsRoot: bundledRoot,
    });
    const { skills } = await service.list({ workspacePath });
    const bundled = skills.filter((skill) => skill.scope === "bundled");
    assert.deepEqual(
      bundled.map((skill) => skill.name).sort(),
      ["bundled-alpha-fixture", "bundled-beta-fixture"],
    );
    for (const skill of bundled) {
      assert.equal(skill.enabled, true);
      assert.equal(skill.pluginName, undefined);
      assert.equal(skill.pluginId, undefined);
      assert.ok(skill.path.startsWith(bundledRoot));
    }
  });

  it("S2：未注入或目录缺席 → 无 bundled 条目、不报错（R1 降级）", async () => {
    await setupFixture();
    for (const bundledSkillsRoot of [undefined, join(tmpRoot, "missing-root")]) {
      const service = createSkillsService({ isDesktopRuntime: true, bundledSkillsRoot });
      const { skills } = await service.list({ workspacePath });
      assert.equal(skills.filter((skill) => skill.scope === "bundled").length, 0);
    }
  });

  it("S3：setEnabled 与 deleteSkill 对 bundled 条目 fail-closed（I3.2/I3.3）", async () => {
    await setupFixture();
    const service = createSkillsService({
      isDesktopRuntime: true,
      bundledSkillsRoot: bundledRoot,
    });
    const { skills } = await service.list({ workspacePath });
    const bundled = skills.find((skill) => skill.scope === "bundled");
    assert.ok(bundled, "S1 已保证 bundled 条目存在");
    await assert.rejects(
      service.setEnabled({
        workspacePath,
        skillId: bundled.id,
        enabled: false,
      }),
      /内置技能不可启停/,
    );
    await assert.rejects(
      service.deleteSkill({ workspacePath, skillId: bundled.id }),
      /内置技能不可删除/,
    );
  });

  it("S4：buildPromptContext 的 $name 匹配排除 bundled（I3.4）", async () => {
    await setupFixture();
    const service = createSkillsService({
      isDesktopRuntime: true,
      bundledSkillsRoot: bundledRoot,
    });
    const context = await service.buildPromptContext({
      workspacePath,
      prompt: "请参考 $bundled-alpha-fixture 处理",
    });
    assert.deepEqual(context.activatedSkillNames, []);
    assert.ok(!context.prompt.includes("<available_skills>"));
    assert.equal(context.prompt, "请参考 $bundled-alpha-fixture 处理");
  });
});

describe("scanOfficialPluginCacheRoots 分片权威消费（S5-S7）", () => {
  let tmpRoot: string;
  const cleanup: (() => Promise<void>)[] = [];
  after(async () => {
    for (const dispose of cleanup.reverse()) {
      await dispose();
    }
  });

  async function setupFixture(): Promise<string> {
    tmpRoot = await mkdtemp(join(tmpdir(), "acode-official-cache-"));
    cleanup.push(async () => rm(tmpRoot, { recursive: true, force: true }));
    return tmpRoot;
  }

  it("S5：分片权威优先——分片只列 p1 时，cache 下的 p2 不产出候选根", async () => {
    const pluginStorageRoot = await setupFixture();
    const cacheRoot = await writeOfficialCacheFixture({
      pluginStorageRoot,
      versionDirs: ["p1/0.1.0", "p2/0.2.0"],
    });
    await writePartition(
      pluginStorageRoot,
      JSON.stringify({
        version: 1,
        manifest: {
          name: OFFICIAL_MARKETPLACE_DIR,
          plugins: [{ name: "p1", cachePath: join(cacheRoot, "p1", "0.1.0") }],
        },
      }),
    );
    const roots = await scanOfficialPluginCacheRoots(pluginStorageRoot);
    assert.deepEqual(roots, [join(cacheRoot, "p1", "0.1.0")]);
  });

  it("S6：分片缺失/坏 JSON/version≠1 → 回退全扫 + 规则 V2 组内择优（每插件仅最高版本出根）", async () => {
    const pluginStorageRoot = await setupFixture();
    const cacheRoot = await writeOfficialCacheFixture({
      pluginStorageRoot,
      versionDirs: ["p1/0.1.0", "p2/0.2.0"],
    });
    const expectedRoots = [join(cacheRoot, "p1", "0.1.0"), join(cacheRoot, "p2", "0.2.0")];
    // 分片缺失。
    assert.deepEqual((await scanOfficialPluginCacheRoots(pluginStorageRoot)).sort(), expectedRoots.sort());
    // 坏 JSON。
    await writePartition(pluginStorageRoot, "{not-valid-json");
    assert.deepEqual((await scanOfficialPluginCacheRoots(pluginStorageRoot)).sort(), expectedRoots.sort());
    // version !== 1。
    await writePartition(
      pluginStorageRoot,
      JSON.stringify({ version: 2, manifest: { name: OFFICIAL_MARKETPLACE_DIR, plugins: [] } }),
    );
    assert.deepEqual((await scanOfficialPluginCacheRoots(pluginStorageRoot)).sort(), expectedRoots.sort());
  });

  it("S6a：分片缺失 + 同名插件多版本目录 → 仅 semver 最高版本产出候选根；不可解析名与并列 tie-break（规则 V2/V3）", async () => {
    const pluginStorageRoot = await setupFixture();
    const cacheRoot = await writeOfficialCacheFixture({
      pluginStorageRoot,
      versionDirs: [
        // 多版本：0.10.0 > 0.9.0（数值比较，非字典序）。
        "acode-guide/0.2.0",
        "acode-guide/0.3.0",
        "sample/0.10.0",
        "sample/0.9.0",
        // 不可解析形状：事务过渡目录与非版本名，不产出候选根。
        "acode-guide/.tmp-123",
        "acode-guide/.backup-0.1.0",
        "acode-guide/.seed-lock",
        "acode-guide/not-a-version",
        // 同版本并列：取目录名字典序较大者（确定性 tie-break）。
        "twin/1.0.0",
        "twin/1.0.0-copy", // 不可解析，不参与并列——真正的并列见 unique 组。
        "unique/2.0",
      ],
    });
    const roots = await scanOfficialPluginCacheRoots(pluginStorageRoot);
    assert.deepEqual(roots.sort((left, right) => left.localeCompare(right)), [
      join(cacheRoot, "acode-guide", "0.3.0"),
      join(cacheRoot, "sample", "0.10.0"),
      // twin 组仅 1.0.0 可解析（1.0.0-copy 不可解析不参与），正常产出根。
      join(cacheRoot, "twin", "1.0.0"),
      join(cacheRoot, "unique", "2.0"),
    ]);

    // tie-break 直接验证：同版本并列取字典序较大者。
    const tieRoot = await mkdtemp(join(tmpdir(), "acode-official-cache-tie-"));
    cleanup.push(async () => rm(tieRoot, { recursive: true, force: true }));
    const tieCache = await writeOfficialCacheFixture({
      pluginStorageRoot: tieRoot,
      versionDirs: ["dup/1.2.0", "dup/v1.2.0"],
    });
    assert.deepEqual(await scanOfficialPluginCacheRoots(tieRoot), [
      join(tieCache, "dup", "v1.2.0"),
    ]);
  });

  it("S7：分片有效但 plugins 为空数组 → 返回空数组且不回退全扫（undefined vs [] 语义区分）", async () => {
    const pluginStorageRoot = await setupFixture();
    const cacheRoot = await writeOfficialCacheFixture({
      pluginStorageRoot,
      versionDirs: ["p1/0.1.0"],
    });
    await writePartition(
      pluginStorageRoot,
      JSON.stringify({
        version: 1,
        manifest: { name: OFFICIAL_MARKETPLACE_DIR, plugins: [] },
      }),
    );
    const roots = await scanOfficialPluginCacheRoots(pluginStorageRoot);
    assert.deepEqual(roots, []);
    assert.notEqual(roots, undefined);
    assert.ok(!roots.includes(join(cacheRoot, "p1", "0.1.0")));
  });
});
