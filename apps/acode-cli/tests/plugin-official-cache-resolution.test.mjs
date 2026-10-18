import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * 官方 cache 解析单点（M1）与回退分支 V2 择优的 adapters 侧测试
 * （specs/plugin-official-cache-authority-m1.md 验收场景 1-5）。
 *
 * - M1-2 语义在真实 loadBundledOfficialPluginRootsSync 接线下的等价断言：
 *   undefined（回退）vs []（权威空集）、逐条丢弃、双重严格后代校验、条目顺序保持。
 * - scanOfficialCache 回退分支的 V2 fixture 经真实 NodePluginAdapter.discoverPluginsSync
 *   打通（多版本目录 + 不可解析名 + .backup/.tmp 干扰项）。
 */

const { loadBundledOfficialPluginRootsSync } = await import(
  "../packages/adapters/src/plugins/official-marketplace.ts"
);
const { NodePluginAdapter } = await import("../packages/adapters/src/plugins/index.ts");

const cleanupTasks = [];
after(async () => {
  await Promise.all(cleanupTasks.map((task) => task()));
});

async function createTempStorageRoot() {
  const storageRoot = await mkdtemp(join(tmpdir(), "acode-m1-test-"));
  cleanupTasks.push(() => rm(storageRoot, { force: true, recursive: true }));
  return storageRoot;
}

const partitionDir = (storageRoot) =>
  join(storageRoot, "marketplaces", "acode-plugins-official");

async function writeBundledPartition(storageRoot, payload) {
  await mkdir(partitionDir(storageRoot), { recursive: true });
  await writeFile(
    join(partitionDir(storageRoot), "bundled-marketplace.json"),
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "utf8",
  );
}

async function createVersionDir(storageRoot, pluginName, versionDirName) {
  const root = join(storageRoot, "cache", "acode-plugins-official", pluginName, versionDirName);
  await mkdir(join(root, ".acode-plugin"), { recursive: true });
  await writeFile(
    join(root, ".acode-plugin", "plugin.json"),
    JSON.stringify({ description: "fixture", name: pluginName, version: versionDirName }),
    "utf8",
  );
  return root;
}

const officialCacheRoot = (storageRoot) =>
  join(storageRoot, "cache", "acode-plugins-official");

test("(M1 验收 1) 分片权威：分片只列 P1 → 真实接线只返回 P1 根", async () => {
  const storageRoot = await createTempStorageRoot();
  const p1 = await createVersionDir(storageRoot, "acode-guide", "0.3.0");
  const p2 = await createVersionDir(storageRoot, "documents", "0.1.7");
  await writeBundledPartition(storageRoot, {
    manifest: {
      name: "acode-plugins-official",
      plugins: [
        {
          cachePath: p1,
          name: "acode-guide",
          source: "filesystem",
          version: "0.3.0",
        },
      ],
    },
    version: 1,
  });
  assert.deepEqual(loadBundledOfficialPluginRootsSync(storageRoot), [p1]);
  assert.notEqual(p1, p2);
});

test("(M1 验收 2) 分片缺失/坏 JSON/version≠1 → undefined（调用方回退全扫）", async () => {
  const missing = await createTempStorageRoot();
  assert.equal(loadBundledOfficialPluginRootsSync(missing), undefined);

  const corrupt = await createTempStorageRoot();
  await writeBundledPartition(corrupt, "{not json");
  assert.equal(loadBundledOfficialPluginRootsSync(corrupt), undefined);

  const wrongVersion = await createTempStorageRoot();
  await writeBundledPartition(wrongVersion, { manifest: { name: "x", plugins: [] }, version: 2 });
  assert.equal(loadBundledOfficialPluginRootsSync(wrongVersion), undefined);
});

test("(M1 验收 3) 分片有效但 plugins: [] → 空数组（权威空集，不回退）", async () => {
  const storageRoot = await createTempStorageRoot();
  await createVersionDir(storageRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(storageRoot, {
    manifest: { name: "acode-plugins-official", plugins: [] },
    version: 1,
  });
  assert.deepEqual(loadBundledOfficialPluginRootsSync(storageRoot), []);
});

test("(M1 验收 4) 逐条丢弃语义：非串/越界/出根 cachePath 丢弃该条，其余保留且顺序保持", async () => {
  const storageRoot = await createTempStorageRoot();
  const good1 = await createVersionDir(storageRoot, "acode-guide", "0.3.0");
  const good2 = await createVersionDir(storageRoot, "documents", "0.1.7");
  await writeBundledPartition(storageRoot, {
    manifest: {
      name: "acode-plugins-official",
      plugins: [
        { name: "", cachePath: good1 }, // 非法 name → 丢弃
        { cachePath: good1, name: "no-cache-path" }, // cachePath 非串 → 丢弃
        { cachePath: "", name: "empty-cache-path" }, // 空 cachePath → 丢弃
        { cachePath: join(officialCacheRoot(storageRoot), "..", "..", "escape"), name: "escape" }, // 越界 → 丢弃
        { cachePath: join(tmpdir(), "outside-root"), name: "absolute-out" }, // 绝对路径出根 → 丢弃
        { cachePath: good2, name: "documents", version: "0.1.7" },
        { cachePath: good1, name: "acode-guide", version: "0.3.0" },
      ],
    },
    version: 1,
  });
  // 保持分片内条目顺序（有效条目相对顺序不变）。
  assert.deepEqual(loadBundledOfficialPluginRootsSync(storageRoot), [good2, good1]);
});

test("(V2 验收 2) 回退分支组内择优：多版本只出 semver 最高者；干扰项不出现；无重复 id 诊断", async () => {
  const storageRoot = await createTempStorageRoot();
  const stale020 = await createVersionDir(storageRoot, "acode-guide", "0.2.0");
  const current030 = await createVersionDir(storageRoot, "acode-guide", "0.3.0");
  // 干扰项：带完整 manifest 的事务目录（修复前可能被当插件根加载）。
  await createVersionDir(storageRoot, "acode-guide", ".backup-0.1.0");
  await createVersionDir(storageRoot, "acode-guide", ".tmp-123");
  // 不可解析版本名与九/十位数值序验证。
  const solo = await createVersionDir(storageRoot, "solo-plugin", "0.10.0");
  await createVersionDir(storageRoot, "solo-plugin", "0.9.0");

  const outcome = new NodePluginAdapter({ storageRoot }).discoverPluginsSync({
    config: {
      dirs: [],
      enabled: true,
      enabledPlugins: {},
      extraKnownMarketplaces: {},
      options: {},
      suppressedBuiltins: [],
    },
    officialPluginRoots: [],
    storageRoot,
  });
  const officialPlugins = outcome.plugins.filter((plugin) => plugin.source === "official");
  const byName = new Map(officialPlugins.map((plugin) => [plugin.name, plugin]));
  assert.equal(byName.size, 2, "每个插件名只出一个候选根");
  assert.equal(
    byName.get("acode-guide")?.rootPath,
    current030,
    "组内择优取 0.3.0 而非 0.2.0/事务目录",
  );
  assert.equal(byName.get("acode-guide")?.version, "0.3.0");
  assert.equal(byName.get("solo-plugin")?.rootPath, solo, "0.10.0 > 0.9.0 数值序择优");
  for (const plugin of officialPlugins) {
    assert.notEqual(plugin.rootPath, stale020);
    assert.ok(!plugin.rootPath.includes(".backup-"), "事务目录不得产出候选根");
    assert.ok(!plugin.rootPath.includes(".tmp-"), "事务目录不得产出候选根");
  }
  assert.equal(
    outcome.diagnostics.filter((diagnostic) => diagnostic.code === "plugin_duplicate_id").length,
    0,
    "组内单候选后 seen 去重应零触发",
  );
});

test("(V1) 分片分支不做择优：分片指向旧版本时按权威结果加载（回滚语义）", async () => {
  const storageRoot = await createTempStorageRoot();
  const stale020 = await createVersionDir(storageRoot, "acode-guide", "0.2.0");
  await createVersionDir(storageRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(storageRoot, {
    manifest: {
      name: "acode-plugins-official",
      plugins: [{ cachePath: stale020, name: "acode-guide", version: "0.2.0" }],
    },
    version: 1,
  });
  const outcome = new NodePluginAdapter({ storageRoot }).discoverPluginsSync({
    config: {
      dirs: [],
      enabled: true,
      enabledPlugins: {},
      extraKnownMarketplaces: {},
      options: {},
      suppressedBuiltins: [],
    },
    officialPluginRoots: [],
    storageRoot,
  });
  const official = outcome.plugins.filter((plugin) => plugin.source === "official");
  assert.equal(official.length, 1);
  assert.equal(official[0].rootPath, stale020, "分片权威优先，磁盘上的 0.3.0 被屏蔽");
});
