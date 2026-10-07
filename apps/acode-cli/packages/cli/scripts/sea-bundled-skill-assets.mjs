import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// 随 CLI 内置的技能包（apps/acode-cli/packages/bundled-skills）。它不是官方插件：不进市场目录、
// 没有版本身份，运行时按内容 hash 解压到 `<cli storage>/bundled-skills/<hash>/`
// （bootstrap/src/app/bundled-skills.ts）。这里的 manifest 形状与那边的读取逐字对应。
export const seaBundledSkillAssetPrefix = "acode-bundled-skills/";
export const seaBundledSkillManifestAssetKey = `${seaBundledSkillAssetPrefix}manifest.json`;
export const bundledSkillPackRootPath = join("packages", "bundled-skills");
export const bundledSkillPackSkillsDirectory = "skills";
// 内容包顶层内容目录：skills（技能）之外还有 agents（官方预置子代理，
// specs/builtin-subagent-catalog.md R1，与 skills/ 平级、共用同一分发通道）。
// 两个目录都必须进 SEA 资产：bootstrap 的完整性门按 BUNDLED_SKILL_PACK_REQUIRED_PATHS
// 拒绝缺文件的物化包，agents/ 缺席会让技能与预置 agent 一起降级。
export const bundledSkillPackContentDirectories = ["skills", "agents"];
// 与 bootstrap 的 BUNDLED_SKILL_PACK_REQUIRED_PATHS 对齐：缺任一项即中止 SEA 构建，
// 不把一个引用文件残缺的技能包发进正式二进制。
// 为什么是本地镜像而不是直接 import @acode/bootstrap：本脚本以纯 node ESM 运行
// （build-sea.mjs 同款，全部兄弟 sea-*.mjs 只依赖 node 内置与相对 .mjs），而
// @acode/bootstrap 公开入口指向 dist/index.js —— 需要完整 workspace 构建在场，
// 且会连带加载 core/adapters/provider 整个依赖图；`pnpm sea` 直跑链路会因 dist
// 缺席在 import 阶段崩溃。漂移防护由 apps/acode-cli/tests/sea-bundled-skill-assets.test.mjs
// 的一致性断言承担（tsx 下直接 import bootstrap TS 源比对同集合）。
export const bundledSkillPackRequiredPaths = [
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/patterns.md",
  "skills/dynamic-workflows/examples.md",
  "agents/Plan.md",
  "agents/Verify.md",
  "agents/Review.md",
];

export const collectSeaBundledSkillAssets = async ({ root, stagingDirectory }) => {
  const packRoot = resolve(root, bundledSkillPackRootPath);
  assertBundledSkillPack(packRoot);

  await rm(stagingDirectory, { force: true, recursive: true });

  const files = [];
  const assets = {};
  for (const contentDirectory of bundledSkillPackContentDirectories) {
    for await (const sourcePath of walkFiles(join(packRoot, contentDirectory))) {
      const relativePath = relative(packRoot, sourcePath);
      if (!shouldIncludeFile(relativePath)) continue;
      const bytes = await readFile(sourcePath);
      const sourceStats = await stat(sourcePath);
      const posixPath = toPosixPath(relativePath);
      assets[`${seaBundledSkillAssetPrefix}${posixPath}`] = sourcePath;
      files.push({
        mode: modeForFile(sourceStats.mode),
        path: posixPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    hash: createHash("sha256")
      .update(JSON.stringify(files.map(({ path, sha256, mode }) => [path, sha256, mode])))
      .digest("hex"),
    files,
    version: 1,
  };
  const manifestPath = resolve(stagingDirectory, "bundled-skills-manifest.json");
  await mkdir(stagingDirectory, { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  assets[seaBundledSkillManifestAssetKey] = manifestPath;

  return { assets, manifest };
};

function assertBundledSkillPack(packRoot) {
  if (!existsSync(join(packRoot, bundledSkillPackSkillsDirectory))) {
    throw new Error(`Missing bundled skill pack at ${packRoot}`);
  }
  for (const relativePath of bundledSkillPackRequiredPaths) {
    const assetPath = join(packRoot, ...relativePath.split("/"));
    if (!existsSync(assetPath)) {
      throw new Error(`Missing bundled skill pack required asset at ${assetPath}`);
    }
  }
}

async function* walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".turbo") continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile()) yield fullPath;
  }
}

const shouldIncludeFile = (relativePath) => !relativePath.split(sep).includes(".DS_Store");

const toPosixPath = (value) => value.split(sep).join("/");

const modeForFile = (sourceMode) => ((sourceMode & 0o111) !== 0 ? 0o755 : 0o644);
