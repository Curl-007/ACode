import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// tests 目录解析不到 @acode/contracts 包名（依赖声明在 adapters），按本仓库测试惯例
// 直接 import contracts TS 源，保证断言的就是 adapters 守卫使用的同一常量。
const { ACODE_OFFICIAL_PLUGIN_MARKETPLACE } = await import(
  "../packages/contracts/src/plugins/index.ts"
);

/**
 * 官方市场清单别名容忍测试（specs/plugin-official-marketplace-alias.md 验收场景 1-5）。
 *
 * 官方 CDN 目录返回的顶层 name 是历史别名 zcode-plugins-official，直接刷新会撞
 * trustedId 守卫。修复：受信任内部刷新链（trustedId===official 的全部调用方——懒加载
 * ensureMarketplaceManifestAvailable 与 updateMarketplace）在守卫前单一收口把别名归一
 * 回 canonical；用户侧新增 / 非官方刷新 / 未知 name 一律不放宽（R2 负向边界）。
 * 全部用临时 storageRoot + 本地 file source，不依赖真实 CDN。
 */

const { addMarketplace, updateMarketplace } = await import(
  "../packages/adapters/src/plugins/marketplace.ts"
);
const {
  ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  ACODE_OFFICIAL_PLUGIN_MARKETPLACE_MANIFEST_ALIASES,
  resolveOfficialMarketplaceAliasCanonicalId,
} = await import("../../../packages/shared/src/plugin-marketplaces.ts");

const cleanupTasks = [];
after(async () => {
  await Promise.all(cleanupTasks.map((task) => task()));
});

async function createTempStorageRoot() {
  const storageRoot = await mkdtemp(join(tmpdir(), "acode-alias-test-"));
  cleanupTasks.push(() => rm(storageRoot, { force: true, recursive: true }));
  return storageRoot;
}

/** 写一个本地目录市场 source：manifest.json 顶层 name 可指定（默认官方 canonical）。 */
async function createFileSource(manifestName = "zcode-plugins-official") {
  const dir = await mkdtemp(join(tmpdir(), "acode-alias-src-"));
  cleanupTasks.push(() => rm(dir, { force: true, recursive: true }));
  const manifestPath = join(dir, "marketplace.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      name: manifestName,
      description: "fixture marketplace",
      plugins: [{ name: "fixture-plugin", description: "fixture" }],
    }),
    "utf8",
  );
  return { source: { source: "file", path: manifestPath }, dir };
}

async function readKnownRecords(storageRoot) {
  const raw = JSON.parse(
    await readFile(join(storageRoot, "known_marketplaces.json"), "utf8"),
  );
  return raw.marketplaces;
}

test("(附断言) shared 别名表闭集：每个别名都解析到官方 canonical id", () => {
  assert.deepEqual([...ACODE_OFFICIAL_PLUGIN_MARKETPLACE_MANIFEST_ALIASES], [
    "zcode-plugins-official",
  ]);
  for (const alias of ACODE_OFFICIAL_PLUGIN_MARKETPLACE_MANIFEST_ALIASES) {
    assert.equal(
      resolveOfficialMarketplaceAliasCanonicalId(alias),
      ACODE_OFFICIAL_PLUGIN_MARKETPLACE,
      `别名 ${alias} 必须解析到 contracts 官方 id（防别名表写错目标）`,
    );
  }
  assert.equal(resolveOfficialMarketplaceAliasCanonicalId(ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID), undefined, "canonical id 本身不是别名");
  assert.equal(resolveOfficialMarketplaceAliasCanonicalId("some-other-market"), undefined);
});

/** 生产官方源是 URL（无 sourceRoot，不触发目录激活）。离线等价物是 settings source：
 * 同样没有 sourceRoot，cdn 分片与 merged 落盘后不会被 activateDirectoryAtomically 整目录替换。 */
function createSettingsSource(manifestName = "zcode-plugins-official") {
  const manifest = {
    name: manifestName,
    description: "fixture marketplace",
    plugins: [{ name: "fixture-plugin", description: "fixture", raw: { name: "fixture-plugin" } }],
    raw: { name: manifestName, plugins: [{ name: "fixture-plugin", description: "fixture" }] },
  };
  return { source: "settings", marketplace: manifest };
}

test("(场景 1) 别名接受：受信任刷新成功且 record/分片/merged 全部为 canonical", async () => {
  const storageRoot = await createTempStorageRoot();
  const record = await addMarketplace({
    source: createSettingsSource("zcode-plugins-official"),
    storageRoot,
    trustedId: ACODE_OFFICIAL_PLUGIN_MARKETPLACE,
  });
  assert.equal(record.id, "acode-plugins-official");
  assert.equal(record.name, "acode-plugins-official");

  const known = await readKnownRecords(storageRoot);
  const officialRecord = known.find((item) => item.id === "acode-plugins-official");
  assert.ok(officialRecord, "known 记录 id 必须是 canonical");
  assert.equal(officialRecord.name, "acode-plugins-official");
  assert.equal(officialRecord.lastRefreshFailure, undefined);

  // CDN 分片 raw.name 已归一（assertOfficialManifest 读的就是 raw）：
  const cdnPartition = JSON.parse(
    await readFile(
      join(storageRoot, "marketplaces", "acode-plugins-official", "cdn-marketplace.json"),
      "utf8",
    ),
  );
  assert.equal(cdnPartition.name, "acode-plugins-official");
  // merged marketplace 落盘且为 canonical：
  const merged = JSON.parse(
    await readFile(
      join(storageRoot, "marketplaces", "acode-plugins-official", "marketplace.json"),
      "utf8",
    ),
  );
  assert.equal(merged.name, "acode-plugins-official");
});

test("(场景 2) 非官方市场不放宽：官方 id 冒用仍拒绝；别名 name 不归一、按原名走守卫", async () => {
  // 非官方刷新把 manifest 改名成官方 id：reserved 守卫照抛（既有错误逐字一致）。
  const storageRoot = await createTempStorageRoot();
  await assert.rejects(
    () =>
      addMarketplace({
        source: createSettingsSource("acode-plugins-official"),
        storageRoot,
        trustedId: "wasp-nest",
      }),
    /Cannot add a marketplace named "acode-plugins-official": that id is reserved/,
  );
  // 别名 name 出现在非官方刷新：不做归一（归一只属于 trustedId===official 链），
  // 按原名走既有守卫——别名不是 exact official id，守卫放行，record 保持别名 id。
  const aliasStorageRoot = await createTempStorageRoot();
  const record = await addMarketplace({
    source: createSettingsSource("zcode-plugins-official"),
    storageRoot: aliasStorageRoot,
    trustedId: "wasp-nest",
  });
  assert.equal(record.id, "zcode-plugins-official", "非官方刷新的别名 name 不得被归一");
});

test("(场景 3) 未知 name 仍拒绝：官方受信任刷新遇到闭集外的 name → trustedId 守卫照抛", async () => {
  const storageRoot = await createTempStorageRoot();
  const { source } = await createFileSource("some-other-market");
  await assert.rejects(
    () =>
      addMarketplace({
        source,
        storageRoot,
        trustedId: ACODE_OFFICIAL_PLUGIN_MARKETPLACE,
      }),
    (error) => {
      assert.equal(
        error.message,
        "Official marketplace source must provide acode-plugins-official, received some-other-market",
      );
      return true;
    },
  );
});

test("(场景 4) 用户侧新增不放宽：官方 id 逐字拒绝；别名 name 不归一、维持现状", async () => {
  const storageRoot = await createTempStorageRoot();
  const officialIdSource = await createFileSource("acode-plugins-official");
  await assert.rejects(
    () => addMarketplace({ source: officialIdSource.source, storageRoot }),
    /Cannot add a marketplace named "acode-plugins-official": that id is reserved for the official marketplace\./,
  );
  // 别名容忍只属于受信任刷新链。用户侧（trustedId 缺失）加别名 name 走既有守卫：
  // reserved 守卫只认 exact canonical id，别名不是官方 id → 维持现状**成功且不归一**
  //（R2「全部维持现状」；既不放宽守卫，也不新增拒绝）。
  const aliasStorageRoot = await createTempStorageRoot();
  const aliasSource = await createFileSource("zcode-plugins-official");
  const record = await addMarketplace({ source: aliasSource.source, storageRoot: aliasStorageRoot });
  assert.equal(
    record.id,
    "zcode-plugins-official",
    "用户侧别名 name 不得被归一成 canonical id",
  );
});

test("(场景 5) 幂等自愈：预置 lastRefreshFailure 一次成功刷新即剥离；再次刷新零 diff", async () => {
  const storageRoot = await createTempStorageRoot();
  const { source } = await createFileSource("zcode-plugins-official");
  const now = new Date().toISOString();
  await writeFile(
    join(storageRoot, "known_marketplaces.json"),
    JSON.stringify({
      version: 1,
      marketplaces: [
        {
          id: "acode-plugins-official",
          source,
          name: "acode-plugins-official",
          description: "Official ACode plugins marketplace.",
          addedAt: now,
          lastUpdated: now,
          lastRefreshFailure: {
            code: "plugin_root_not_found",
            failedAt: now,
            message: "Official marketplace source must provide acode-plugins-official, received zcode-plugins-official",
          },
          pluginCount: 0,
        },
      ],
    }),
    "utf8",
  );

  const updated = await updateMarketplace({
    marketplace: "acode-plugins-official",
    storageRoot,
  });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, "acode-plugins-official");

  const knownAfterFirst = await readKnownRecords(storageRoot);
  const officialAfterFirst = knownAfterFirst.find((item) => item.id === "acode-plugins-official");
  assert.ok(officialAfterFirst, "官方记录仍在");
  assert.equal(
    officialAfterFirst.lastRefreshFailure,
    undefined,
    "刷新成功后 lastRefreshFailure 必须经 upsertKnownMarketplace 剥离（自愈，R4）",
  );

  // 幂等：间隔无失败的第二次刷新不产生逻辑 diff。lastUpdated/cacheTransactionId 是
  // 每次刷新的生命周期元数据（崩溃恢复代际，协议/UI 投影不暴露），不在 R4 语义域内。
  const logicalFields = (record) =>
    JSON.stringify({ ...record, lastUpdated: undefined, cacheTransactionId: undefined });
  await updateMarketplace({ marketplace: "acode-plugins-official", storageRoot });
  const knownAfterSecond = await readKnownRecords(storageRoot);
  const officialAfterSecond = knownAfterSecond.find((item) => item.id === "acode-plugins-official");
  assert.equal(
    logicalFields(officialAfterSecond),
    logicalFields(officialAfterFirst),
    "连续成功刷新之间 known 记录（除生命周期元数据）不应产生 diff",
  );
  assert.equal(officialAfterSecond.lastRefreshFailure, undefined);
});
