import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

/**
 * bundled 内容包三形态分发脚本侧验收（specs/builtin-subagent-catalog.md R1 / 验收场景 1）。
 *
 * bootstrap 侧（BUNDLED_SKILL_PACK_REQUIRED_PATHS 常量本身、pack root 解析）由
 * builtin-subagent-catalog.test.mjs 覆盖；本文件覆盖三个**非 dev 形态**的分发脚本：
 * - SEA 资产收集（packages/cli/scripts/sea-bundled-skill-assets.mjs）：产物含 agents/*.md，
 *   required-paths 镜像与 bootstrap 常量同集合（脚本以纯 node 运行，无法 import TS 源，
 *   镜像理由见脚本内注释——本测试即其漂移防护）；
 * - 远端 stage（scripts/prepare-prebuilds.mjs）与桌面 seed
 *   （packages/desktop/scripts/prepare-agent-node-bundle.mjs）：topLevelPaths 含 "agents"、
 *   requiredPaths 与 bootstrap 常量同集合。两个脚本的清单对象未导出（且桌面脚本 import 即执行
 *   打包流程），故按仓库既有惯例（bundled-verify-run-skills.test.mjs 同款）做源文本断言。
 *
 * 缺任一 required 文件时 SEA 收集必须拒绝产出（all-or-nothing），否则残缺包会在运行时被
 * bootstrap 完整性门整包拒绝，技能与预置 agent 一起降级。
 */

const { BUNDLED_SKILL_PACK_REQUIRED_PATHS } = await import(
  "../packages/bootstrap/src/app/bundled-skills.ts"
);
const {
  bundledSkillPackRequiredPaths,
  collectSeaBundledSkillAssets,
  seaBundledSkillAssetPrefix,
  seaBundledSkillManifestAssetKey,
} = await import("../packages/cli/scripts/sea-bundled-skill-assets.mjs");

const bootstrapRequiredPaths = [...BUNDLED_SKILL_PACK_REQUIRED_PATHS];
const cliRoot = fileURLToPath(new URL("..", import.meta.url));

function assertSameSet(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label} 与 bootstrap 常量漂移`);
}

/** 从脚本源文本中提取 `const <name> = { ... };` 对象字面量块。 */
async function readPackListBlock(scriptUrl, constName) {
  const source = await readFile(scriptUrl, "utf8");
  const start = source.indexOf(`const ${constName} = {`);
  assert.ok(start >= 0, `${constName} 未出现在 ${scriptUrl.pathname}`);
  const end = source.indexOf("\n};", start);
  assert.ok(end > start, `${constName} 对象块未正常闭合`);
  return source.slice(start, end);
}

function extractQuotedArray(block, fieldName) {
  const match = block.match(new RegExp(`${fieldName}:\\s*\\[([^\\]]*)\\]`));
  assert.ok(match, `${fieldName} 数组未出现在清单块中`);
  const entries = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert.ok(entries.length > 0, `${fieldName} 数组为空`);
  return entries;
}

test("(R1) SEA required-paths 镜像与 bootstrap 常量同集合，含三个 agents/*.md", () => {
  assertSameSet(bundledSkillPackRequiredPaths, bootstrapRequiredPaths, "SEA 镜像清单");
  for (const name of ["Plan", "Verify", "Review"]) {
    assert.ok(
      bootstrapRequiredPaths.includes(`agents/${name}.md`),
      `bootstrap 常量缺 agents/${name}.md（前置事实复核）`,
    );
  }
});

test("(R1) prepare-prebuilds 远端 stage 清单：topLevelPaths 含 agents，requiredPaths 同集合", async () => {
  const block = await readPackListBlock(
    new URL("../../../scripts/prepare-prebuilds.mjs", import.meta.url),
    "remoteBundledSkillPack",
  );
  assertSameSet(extractQuotedArray(block, "requiredPaths"), bootstrapRequiredPaths, "远端 requiredPaths");
  const topLevelPaths = extractQuotedArray(block, "topLevelPaths");
  assert.ok(topLevelPaths.includes("skills"), "远端 topLevelPaths 缺 skills");
  assert.ok(topLevelPaths.includes("agents"), "远端 topLevelPaths 缺 agents（上传前会裁掉预置 agent）");
});

test("(R1) prepare-agent-node-bundle 桌面 seed 清单：topLevelPaths 含 agents，requiredPaths 同集合", async () => {
  const block = await readPackListBlock(
    new URL("../../../packages/desktop/scripts/prepare-agent-node-bundle.mjs", import.meta.url),
    "bundledSkillPack",
  );
  assertSameSet(extractQuotedArray(block, "requiredPaths"), bootstrapRequiredPaths, "桌面 requiredPaths");
  const topLevelPaths = extractQuotedArray(block, "topLevelPaths");
  assert.ok(topLevelPaths.includes("skills"), "桌面 topLevelPaths 缺 skills");
  assert.ok(topLevelPaths.includes("agents"), "桌面 topLevelPaths 缺 agents（首启 seed 会缺预置 agent）");
});

test("(场景1) collectSeaBundledSkillAssets 对真实包产出 agents/*.md 资产与 manifest 条目", async () => {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "acode-sea-bundled-skills-"));
  try {
    const { assets, manifest } = await collectSeaBundledSkillAssets({
      root: cliRoot,
      stagingDirectory,
    });
    const manifestPaths = manifest.files.map((file) => file.path);
    for (const requiredPath of bootstrapRequiredPaths) {
      assert.ok(
        manifestPaths.includes(requiredPath),
        `SEA manifest 缺 bootstrap 必需路径 ${requiredPath}`,
      );
      assert.ok(
        assets[`${seaBundledSkillAssetPrefix}${requiredPath}`],
        `SEA 资产缺 ${seaBundledSkillAssetPrefix}${requiredPath}`,
      );
    }
    // manifest 结构不变：version 1、资产前缀不变、条目只来自 skills/ 与 agents/ 两个顶层目录。
    assert.equal(manifest.version, 1);
    assert.equal(seaBundledSkillAssetPrefix, "acode-bundled-skills/");
    for (const path of manifestPaths) {
      assert.match(path, /^(skills|agents)\//, `意外顶层目录进入 SEA 资产: ${path}`);
    }
    // manifest 本体写入 staging 并挂到约定 asset key（bootstrap materialize 的读取面）。
    assert.equal(seaBundledSkillManifestAssetKey, `${seaBundledSkillAssetPrefix}manifest.json`);
    const stagedManifest = JSON.parse(
      await readFile(assets[seaBundledSkillManifestAssetKey], "utf8"),
    );
    assert.equal(stagedManifest.hash, manifest.hash);
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
});

test("(场景1) 缺任一 required 资产时 SEA 收集拒绝产出（all-or-nothing）", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "acode-sea-bundled-skills-fixture-"));
  const stagingDirectory = join(fixtureRoot, "staging");
  const packRoot = join(fixtureRoot, "packages", "bundled-skills");
  try {
    for (const relativePath of bootstrapRequiredPaths) {
      if (relativePath === "agents/Verify.md") continue; // 故意缺一个 agents 文件
      const filePath = join(packRoot, ...relativePath.split("/"));
      await mkdir(join(filePath, ".."), { recursive: true });
      await writeFile(filePath, `fixture for ${relativePath}\n`, "utf8");
    }
    await assert.rejects(
      collectSeaBundledSkillAssets({ root: fixtureRoot, stagingDirectory }),
      /Missing bundled skill pack required asset/u,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});
