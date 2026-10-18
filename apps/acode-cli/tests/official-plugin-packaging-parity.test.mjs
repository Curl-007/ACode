import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { test } from "node:test";

/**
 * 三份官方插件 staging 清单的一致性防漂移测试（specs/desktop-official-plugin-packaging.md R5）。
 *
 * 覆盖裁决 D 的执行机制：任何随应用分发的官方插件暂存清单必须覆盖全部 default-enabled
 * 官方插件，staging 路径匹配 definition.rootCandidates 首候选，requiresRuntime 判定与
 * definition 的 dist 钉子互为镜像。清单对象未导出（且桌面脚本 import 即执行打包流程），
 * 故按仓库既有惯例（sea-bundled-skill-assets.test.mjs 同款）做源文本断言。
 *
 * 权威事实源：bootstrap OFFICIAL_PLUGIN_DEFINITIONS（defaultEnabled/rootCandidates/
 * requiredSeedPaths/version），经 `node --import tsx --test` 直接 import TS 源。
 *
 * 断言 A 的落地说明：spec R5 断言 A 字面写 `packages/${name}-plugin`，但 node-repl-host
 * 的包目录（definition.rootCandidates[0] = "packages/node-repl-host"）不带 -plugin 后缀；
 * R1 的真实不变式是「stagedPath === rootCandidates 首候选」，故按首候选等价断言（对 8 个
 * 内容型插件两者逐字相同）。
 */

const { OFFICIAL_PLUGIN_DEFINITIONS } = await import(
  "../packages/bootstrap/src/app/official-plugin-definitions.ts"
);

/** 从脚本源文本中提取 `const <name> = [` ... `\n];` 数组字面量块。 */
async function readScriptArrayBlock(scriptUrl, constName) {
  const source = await readFile(fileURLToPath(scriptUrl), "utf8");
  const start = source.indexOf(`const ${constName} = [`);
  assert.ok(start >= 0, `${constName} 未出现在 ${scriptUrl.pathname}`);
  const end = source.indexOf("\n];", start);
  assert.ok(end > start, `${constName} 数组块未正常闭合`);
  return source.slice(start, end);
}

/** 条目对象内无嵌套花括号（requiredSeedPaths 是纯字符串数组），按花括号配对逐条提取。 */
function parseListEntries(block) {
  const entries = [];
  const entryPattern = /\{([^{}]*)\}/g;
  let match;
  while ((match = entryPattern.exec(block)) !== null) {
    const body = match[1];
    const readString = (field) => {
      const found = body.match(new RegExp(`${field}:\\s*"([^"]+)"`));
      return found ? found[1] : undefined;
    };
    entries.push({
      packageName: readString("packageName"),
      relativePath: readString("relativePath"),
      requiresRuntime: body.match(/requiresRuntime:\s*(true|false)/)?.[1] === "true",
      stagedPath: readString("stagedPath"),
      requiredSeedPaths: (() => {
        const arrayMatch = body.match(/requiredSeedPaths:\s*\[([^\]]*)\]/);
        if (!arrayMatch) return undefined;
        return [...arrayMatch[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
      })(),
    });
  }
  return entries;
}

async function readQuotedStringArray(scriptUrl, constName) {
  const source = await readFile(fileURLToPath(scriptUrl), "utf8");
  const start = source.indexOf(`const ${constName} = [`);
  assert.ok(start >= 0, `${constName} 未出现在 ${scriptUrl.pathname}`);
  const end = source.indexOf("];", start);
  assert.ok(end > start, `${constName} 数组未正常闭合`);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

const desktopScriptUrl = new URL(
  "../../../packages/desktop/scripts/prepare-agent-node-bundle.mjs",
  import.meta.url,
);
const prebuildsScriptUrl = new URL("../../../scripts/prepare-prebuilds.mjs", import.meta.url);
const devScriptUrl = new URL("../../../scripts/build-desktop-agent-cli.mjs", import.meta.url);

const [desktopBlock, prebuildsBlock, devBlock, remoteRequiredPaths] = await Promise.all([
  readScriptArrayBlock(desktopScriptUrl, "officialPluginPackages"),
  readScriptArrayBlock(prebuildsScriptUrl, "remoteOfficialPluginPackages"),
  readScriptArrayBlock(devScriptUrl, "requiredDevPluginRuntimeBuilds"),
  readQuotedStringArray(prebuildsScriptUrl, "remoteOfficialPluginRequiredPaths"),
]);

const desktopEntries = parseListEntries(desktopBlock);
const prebuildsEntries = parseListEntries(prebuildsBlock);

const defaultEnabledDefinitions = OFFICIAL_PLUGIN_DEFINITIONS.filter(
  (definition) => definition.defaultEnabled,
);

function findEntry(entries, definition) {
  const stagedPath = definition.rootCandidates[0];
  const relativePath = `apps/acode-cli/packages/${basename(stagedPath)}`;
  return entries.find(
    (entry) => entry.stagedPath === stagedPath && entry.relativePath === relativePath,
  );
}

/** 已有条目注释/spec R3 声明的非 dist 构建产物（browser-use 的 browser-client）。 */
const DECLARED_RUNTIME_ARTIFACT_PATHS = new Set(["scripts/browser-client.mjs"]);

test("(断言 A) 两份 staging 清单覆盖全部 default-enabled 官方插件，路径镜像 rootCandidates 首候选", () => {
  assert.ok(defaultEnabledDefinitions.length >= 11, "default-enabled 集合意外缩水");
  for (const definition of defaultEnabledDefinitions) {
    const desktopEntry = findEntry(desktopEntries, definition);
    assert.ok(
      desktopEntry,
      `桌面 seed 清单缺 default-enabled 插件 ${definition.name}（stagedPath=${definition.rootCandidates[0]}）`,
    );
    const prebuildsEntry = findEntry(prebuildsEntries, definition);
    assert.ok(
      prebuildsEntry,
      `远端 prebuild 清单缺 default-enabled 插件 ${definition.name}（stagedPath=${definition.rootCandidates[0]}）`,
    );
  }
});

test("(断言 B) 远端 manifest 存在性钉覆盖全部 default-enabled 插件", () => {
  for (const definition of defaultEnabledDefinitions) {
    const requiredPath = `${definition.rootCandidates[0]}/.acode-plugin/plugin.json`;
    assert.ok(
      remoteRequiredPaths.includes(requiredPath),
      `remoteOfficialPluginRequiredPaths 缺 ${definition.name} 的 manifest 钉：${requiredPath}`,
    );
  }
});

test("(断言 C) definition 钉了 dist/ 前缀的 default-enabled 插件必须登记 dev 链 runtime 构建", () => {
  for (const definition of defaultEnabledDefinitions) {
    const hasDistPin = (definition.requiredSeedPaths ?? []).some((path) =>
      path.startsWith("dist/"),
    );
    if (!hasDistPin) continue;
    const stagingEntry =
      findEntry(desktopEntries, definition) ?? findEntry(prebuildsEntries, definition);
    const expectedPackageName = stagingEntry?.packageName ?? `@acode/${definition.name}-plugin`;
    assert.ok(
      devBlock.includes(`"${expectedPackageName}"`),
      `definition ${definition.name} 的 requiredSeedPaths 含 dist/ 钉子，但 dev 链 requiredDevPluginRuntimeBuilds 缺 ${expectedPackageName}（未来新增 dist 钉子必须同步 dev 清单，spec 4 R4/R5）`,
    );
  }
});

test("(断言 D) 内容型插件条目的 requiredSeedPaths 与 definition 逐集合一致", () => {
  for (const entries of [desktopEntries, prebuildsEntries]) {
    for (const entry of entries) {
      if (entry.requiredSeedPaths === undefined) continue; // requiresRuntime 条目走 requiredRuntimePaths 语义（构建产物），不在本断言域
      const definition = OFFICIAL_PLUGIN_DEFINITIONS.find(
        (candidate) => `packages/${candidate.name}-plugin` === entry.stagedPath,
      );
      assert.ok(definition, `条目 ${entry.stagedPath} 找不到对应 definition`);
      assert.deepEqual(
        [...entry.requiredSeedPaths].sort(),
        [...(definition.requiredSeedPaths ?? [])].sort(),
        `条目 ${entry.stagedPath} 的 requiredSeedPaths 与 definition 漂移`,
      );
    }
  }
});

test("(断言 E) requiresRuntime:true 条目的 definition 必须钉了构建产物（防纯资产插件误挂 runtime 构建）", () => {
  for (const entry of desktopEntries) {
    if (!entry.requiresRuntime) continue;
    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find(
      (candidate) => candidate.rootCandidates[0] === entry.stagedPath,
    );
    assert.ok(definition, `requiresRuntime 条目 ${entry.stagedPath} 找不到对应 definition`);
    const hasBuildArtifact = (definition.requiredSeedPaths ?? []).some(
      (path) => path.startsWith("dist/") || DECLARED_RUNTIME_ARTIFACT_PATHS.has(path),
    );
    assert.ok(
      hasBuildArtifact,
      `纯资产插件 ${definition.name} 被误挂 requiresRuntime:true（definition 无 dist/ 钉子与已声明构建产物）`,
    );
  }
});
