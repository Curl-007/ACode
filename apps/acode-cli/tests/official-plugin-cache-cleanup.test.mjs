import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

/**
 * 官方插件 cache 旧版本残留清理测试（specs/official-plugin-cache-cleanup.md 验收场景
 * 1-11，含必改项 5 的场景 11）。临时 storageRoot 构造分片文件 + cache 目录 +
 * installed_plugins.json；版本判据单点的表驱动样本见
 * packages/shared/test/pluginOfficialCacheVersion.test.ts（同一组样本防判据漂移）。
 */

const { writeBundledOfficialMarketplacePartitionSync } = await import(
  "../packages/adapters/src/plugins/official-marketplace.ts"
);
const { cleanupStaleOfficialPluginCacheVersions } = await import(
  "../packages/bootstrap/src/app/official-plugin-cache-cleanup.ts"
);

const cleanupTasks = [];
after(async () => {
  await Promise.all(cleanupTasks.map((task) => task()));
});

const OFFICIAL = "acode-plugins-official";

function createLoggerStub() {
  const logs = { info: [], warn: [] };
  return {
    logs,
    error() {},
    info(message, details) {
      logs.info.push({ details, message });
    },
    warn(message, details) {
      logs.warn.push({ details, message });
    },
  };
}

async function createTempStorageRoot() {
  const storageRoot = await mkdtemp(join(tmpdir(), "acode-cleanup-test-"));
  cleanupTasks.push(() => rm(storageRoot, { force: true, recursive: true }));
  return storageRoot;
}

const cacheRoot = (storageRoot) => join(storageRoot, "cache", OFFICIAL);
const versionDir = (storageRoot, pluginName, version) =>
  join(cacheRoot(storageRoot), pluginName, version);

/** 造一个「在场完整」的版本目录（.acode-plugin/plugin.json 存在）。 */
async function seedVersionDir(storageRoot, pluginName, version, { complete = true } = {}) {
  const root = versionDir(storageRoot, pluginName, version);
  if (complete) {
    await mkdir(join(root, ".acode-plugin"), { recursive: true });
    await writeFile(
      join(root, ".acode-plugin", "plugin.json"),
      JSON.stringify({ name: pluginName, version }),
      "utf8",
    );
  } else {
    await mkdir(root, { recursive: true });
  }
  return root;
}

async function writeBundledPartition(storageRoot, references) {
  writeBundledOfficialMarketplacePartitionSync({
    manifest: {
      name: OFFICIAL,
      plugins: references.map(({ name, version }) => ({
        cachePath: versionDir(storageRoot, name, version),
        name,
        source: "filesystem",
        version,
      })),
    },
    storageRoot,
  });
}

async function writeCdnPartition(storageRoot, references) {
  await mkdir(join(storageRoot, "marketplaces", OFFICIAL), { recursive: true });
  await writeFile(
    join(storageRoot, "marketplaces", OFFICIAL, "cdn-marketplace.json"),
    JSON.stringify({
      name: OFFICIAL,
      plugins: references.map(({ name, version }) => ({ name, version })),
    }),
    "utf8",
  );
}

async function writeInstalledPlugins(storageRoot, records, { raw } = {}) {
  await writeFile(
    join(storageRoot, "installed_plugins.json"),
    raw ?? JSON.stringify({ plugins: records, version: 1 }),
    "utf8",
  );
}

const installedRecord = (name, version) => ({
  id: `${name}@${OFFICIAL}`,
  // 清理器只消费 name/version 引用对，installPath 不参与判定，占位即可。
  installPath: `/unused/${name}/${version}`,
  installedAt: "2026-01-01T00:00:00.000Z",
  marketplace: OFFICIAL,
  name,
  scope: "user",
  version,
});

function removedVersions(logger) {
  const entry = logger.logs.info.find(
    (item) => item.details?.operation === "stale_version_cleanup",
  );
  return (entry?.details?.removed ?? []).map((item) => item.version);
}

async function listVersionDirs(storageRoot, pluginName) {
  try {
    const entries = await readdir(versionDir(storageRoot, pluginName, ""), {
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

test("(场景 1) bundled 引用 0.3.0 在场完整 → 0.2.0 删除、0.3.0 保留、info 汇总一条", async () => {
  const storageRoot = await createTempStorageRoot();
  await seedVersionDir(storageRoot, "acode-guide", "0.2.0");
  await seedVersionDir(storageRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(storageRoot, [{ name: "acode-guide", version: "0.3.0" }]);
  // installed_plugins.json 是引用集第三来源；缺失/损坏即整体跳过（必改项 5），
  // 因此正删除场景必须提供该文件（空记录 = 事实源在场且有效）。
  await writeInstalledPlugins(storageRoot, []);
  const logger = createLoggerStub();

  cleanupStaleOfficialPluginCacheVersions({ logger, storageRoot });

  assert.deepEqual(await listVersionDirs(storageRoot, "acode-guide"), ["0.3.0"]);
  const summary = logger.logs.info.find(
    (item) => item.details?.operation === "stale_version_cleanup",
  );
  assert.ok(summary, "有删除动作必须打一条 info 汇总（R7）");
  assert.deepEqual(removedVersions(logger), ["0.2.0"]);
  assert.equal(logger.logs.warn.length, 0);
});

test("(场景 2) 被引用版本缺失/残缺 → 旧版本保留（fallback 退路不摧毁）", async () => {
  // 残缺变体：0.3.0 在场但没有 .acode-plugin/plugin.json。
  const incompleteRoot = await createTempStorageRoot();
  await seedVersionDir(incompleteRoot, "acode-guide", "0.2.0");
  await seedVersionDir(incompleteRoot, "acode-guide", "0.3.0", { complete: false });
  await writeBundledPartition(incompleteRoot, [{ name: "acode-guide", version: "0.3.0" }]);
  cleanupStaleOfficialPluginCacheVersions({ logger: createLoggerStub(), storageRoot: incompleteRoot });
  assert.deepEqual(
    await listVersionDirs(incompleteRoot, "acode-guide"),
    ["0.2.0", "0.3.0"],
    "残缺引用版本在场时旧版本必须保留",
  );

  // 缺失变体：0.3.0 目录整体不在场。
  const missingRefRoot = await createTempStorageRoot();
  await seedVersionDir(missingRefRoot, "acode-guide", "0.2.0");
  await writeBundledPartition(missingRefRoot, [{ name: "acode-guide", version: "0.3.0" }]);
  cleanupStaleOfficialPluginCacheVersions({
    logger: createLoggerStub(),
    storageRoot: missingRefRoot,
  });
  assert.deepEqual(
    await listVersionDirs(missingRefRoot, "acode-guide"),
    ["0.2.0"],
    "被引用版本整体缺失时旧版本承担 seed fallback，绝不删",
  );
});

test("(场景 3) installed 记录 acode-guide@0.2.0 → 永不删除（显式安装的回滚版本合法）", async () => {
  const storageRoot = await createTempStorageRoot();
  await seedVersionDir(storageRoot, "acode-guide", "0.2.0");
  await seedVersionDir(storageRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(storageRoot, [{ name: "acode-guide", version: "0.3.0" }]);
  await writeInstalledPlugins(storageRoot, [installedRecord("acode-guide", "0.2.0")]);
  cleanupStaleOfficialPluginCacheVersions({ logger: createLoggerStub(), storageRoot });
  assert.deepEqual(await listVersionDirs(storageRoot, "acode-guide"), ["0.2.0", "0.3.0"]);
});

test("(场景 4) cdn 分片含 acode-guide@0.2.0 → 不删（引用集含 CDN 条目）", async () => {
  const storageRoot = await createTempStorageRoot();
  await seedVersionDir(storageRoot, "acode-guide", "0.2.0");
  await seedVersionDir(storageRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(storageRoot, [{ name: "acode-guide", version: "0.3.0" }]);
  await writeCdnPartition(storageRoot, [{ name: "acode-guide", version: "0.2.0" }]);
  cleanupStaleOfficialPluginCacheVersions({ logger: createLoggerStub(), storageRoot });
  assert.deepEqual(await listVersionDirs(storageRoot, "acode-guide"), ["0.2.0", "0.3.0"]);
});

test("(场景 5) bundled 回滚引用 0.2.0、磁盘有 0.3.0 → 0.3.0 保留（「更旧」条件不满足）", async () => {
  const storageRoot = await createTempStorageRoot();
  await seedVersionDir(storageRoot, "acode-guide", "0.2.0");
  await seedVersionDir(storageRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(storageRoot, [{ name: "acode-guide", version: "0.2.0" }]);
  cleanupStaleOfficialPluginCacheVersions({ logger: createLoggerStub(), storageRoot });
  assert.deepEqual(await listVersionDirs(storageRoot, "acode-guide"), ["0.2.0", "0.3.0"]);
});

test("(场景 6) 非官方市场 cache 零接触", async () => {
  const storageRoot = await createTempStorageRoot();
  const foreignRoot = join(storageRoot, "cache", "wasp-nest", "some-plugin", "0.1.0");
  await mkdir(join(foreignRoot, ".acode-plugin"), { recursive: true });
  await writeFile(
    join(foreignRoot, ".acode-plugin", "plugin.json"),
    JSON.stringify({ name: "some-plugin" }),
    "utf8",
  );
  await seedVersionDir(storageRoot, "acode-guide", "0.2.0");
  await seedVersionDir(storageRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(storageRoot, [{ name: "acode-guide", version: "0.3.0" }]);
  cleanupStaleOfficialPluginCacheVersions({ logger: createLoggerStub(), storageRoot });
  assert.ok(existsSync(foreignRoot), "非官方市场 cache 绝不进入扫描");
});

test("(场景 7) 事务目录与不可解析名零接触", async () => {
  const storageRoot = await createTempStorageRoot();
  for (const name of [".backup-0.1.0", ".tmp-123", ".seed-lock", ".seed-lock.stale-1", "latest"]) {
    await seedVersionDir(storageRoot, "acode-guide", name);
  }
  await seedVersionDir(storageRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(storageRoot, [{ name: "acode-guide", version: "0.3.0" }]);
  cleanupStaleOfficialPluginCacheVersions({ logger: createLoggerStub(), storageRoot });
  const remaining = await listVersionDirs(storageRoot, "acode-guide");
  for (const name of [".backup-0.1.0", ".tmp-123", ".seed-lock", ".seed-lock.stale-1", "latest"]) {
    assert.ok(remaining.includes(name), `${name} 必须保留（形状上排除，双重保障）`);
  }
});

test("(场景 8) 单目录删除失败 → warn 一条、其余目录继续、不抛出", async () => {
  const { spawn } = await import("node:child_process");
  const storageRoot = await createTempStorageRoot();
  const blocked = await seedVersionDir(storageRoot, "acode-guide", "0.2.0");
  await seedVersionDir(storageRoot, "acode-guide", "0.3.0");
  const other = await seedVersionDir(storageRoot, "documents", "0.1.6");
  await seedVersionDir(storageRoot, "documents", "0.1.7");
  await writeBundledPartition(storageRoot, [
    { name: "acode-guide", version: "0.3.0" },
    { name: "documents", version: "0.1.7" },
  ]);
  await writeInstalledPlugins(storageRoot, []);
  const logger = createLoggerStub();

  // 删除失败注入（Windows 机制，对齐真实「杀软/索引器占用」故障源）：子进程把 cwd
  // 钉在目标目录内，rmdir 返回 EBUSY/EPERM（transient，重试预算耗尽后按失败跳过）。
  // POSIX 机制用目录去写位（unlink 需要目录 w+x）→ EACCES，同为 transient。
  const blocker = spawn(
    process.execPath,
    ["-e", `process.chdir(${JSON.stringify(blocked)}); setInterval(() => {}, 1000);`],
    { stdio: "ignore" },
  );
  const isPosix = process.platform !== "win32";
  if (isPosix) await chmod(blocked, 0o500);
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    cleanupStaleOfficialPluginCacheVersions({ logger, storageRoot });
    assert.ok(
      logger.logs.warn.some((item) => item.details?.operation === "stale_version_cleanup"),
      "删除失败必须 warn（R6）",
    );
    assert.deepEqual(removedVersions(logger), ["0.1.6"], "其余可删目录继续清理");
    assert.ok(existsSync(blocked), "失败目录按跳过保留");
    assert.ok(!existsSync(other), "其余目录确实被删");
  } finally {
    blocker.kill();
    await new Promise((resolve) => {
      blocker.once("exit", resolve);
      setTimeout(resolve, 1000);
    });
    if (isPosix) await chmod(blocked, 0o700).catch(() => {});
    await rm(blocked, { force: true, recursive: true }).catch(() => {});
  }
});

test("(场景 9) 幂等：对清理后的状态二次运行删除集为空、无 info 动作", async () => {
  // 进程内至多一次（R5）由 cleanedStorageRoots 去重保证；这里验证的是规则的幂等性：
  // 已清理状态（仅剩被引用版本）再跑一遍，删除集必为空。
  const storageRoot = await createTempStorageRoot();
  await seedVersionDir(storageRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(storageRoot, [{ name: "acode-guide", version: "0.3.0" }]);
  const logger = createLoggerStub();
  cleanupStaleOfficialPluginCacheVersions({ logger, storageRoot });
  assert.deepEqual(removedVersions(logger), [], "无残留可删时不得有删除动作");
  assert.equal(
    logger.logs.info.filter((item) => item.details?.operation === "stale_version_cleanup").length,
    0,
    "removed 为空时不打 info（R7，避免每次启动噪音）",
  );
});

test("(场景 10) 分片全损坏 → 清理空转（无删除）、无异常抛出", async () => {
  const storageRoot = await createTempStorageRoot();
  await seedVersionDir(storageRoot, "acode-guide", "0.2.0");
  await seedVersionDir(storageRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(storageRoot, [{ name: "acode-guide", version: "0.3.0" }]);
  await writeFile(
    join(storageRoot, "marketplaces", OFFICIAL, "bundled-marketplace.json"),
    "{corrupt",
    "utf8",
  );
  await writeCdnPartition(storageRoot, []);
  await writeFile(
    join(storageRoot, "marketplaces", OFFICIAL, "cdn-marketplace.json"),
    "{corrupt",
    "utf8",
  );
  await writeInstalledPlugins(storageRoot, []);
  const logger = createLoggerStub();
  cleanupStaleOfficialPluginCacheVersions({ logger, storageRoot });
  assert.deepEqual(await listVersionDirs(storageRoot, "acode-guide"), ["0.2.0", "0.3.0"]);
});

test("(场景 11，必改项 5) installed_plugins.json 损坏 → 整体跳过，0.2.0 保留", async () => {
  const storageRoot = await createTempStorageRoot();
  await seedVersionDir(storageRoot, "acode-guide", "0.2.0");
  await seedVersionDir(storageRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(storageRoot, [{ name: "acode-guide", version: "0.3.0" }]);
  await writeInstalledPlugins(storageRoot, [], { raw: "{invalid json" });
  cleanupStaleOfficialPluginCacheVersions({ logger: createLoggerStub(), storageRoot });
  assert.deepEqual(
    await listVersionDirs(storageRoot, "acode-guide"),
    ["0.2.0", "0.3.0"],
    "installed 事实源失效即不删（比贡献空集更保守）",
  );

  // 缺失同理：文件不存在 → 跳过整体。
  const missingRoot = await createTempStorageRoot();
  await seedVersionDir(missingRoot, "acode-guide", "0.2.0");
  await seedVersionDir(missingRoot, "acode-guide", "0.3.0");
  await writeBundledPartition(missingRoot, [{ name: "acode-guide", version: "0.3.0" }]);
  cleanupStaleOfficialPluginCacheVersions({ logger: createLoggerStub(), storageRoot: missingRoot });
  assert.deepEqual(await listVersionDirs(missingRoot, "acode-guide"), ["0.2.0", "0.3.0"]);
});
