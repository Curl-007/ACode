import { existsSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  loadOfficialMarketplaceCacheReferencesSync,
  tryReadInstalledPluginRecordsForCleanupSync,
} from "@acode/adapters";
import { ACODE_OFFICIAL_PLUGIN_MARKETPLACE, type Logger } from "@acode/contracts";
import {
  compareOfficialPluginVersionDirNames,
  parseOfficialPluginVersionDirName,
} from "@acode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  isNotFoundFsError,
  removeOfficialPluginCacheDirectory,
} from "./official-plugin-cache-fs.js";

/**
 * 官方插件 cache 旧版本残留清理（specs/official-plugin-cache-cleanup.md）。
 *
 * 定位：seed 升级会保留旧版本缓存目录（cache/<marketplace>/<name>/<version>/），残留
 * 既占磁盘又携带已删除资产（如 acode-guide/0.2.0 的 dynamic-workflows 技能副本）。
 * 清理是删除性操作，规则宁可漏删不可误删（R1 四条件 AND 闭集）、失败不阻断启动（R6）、
 * 进程内至多一次（R5）。
 *
 * 依赖方向：bootstrap → adapters（分片引用对 + installed 记录只读导出）与
 * bootstrap → shared（版本判据单点，与 M1 回退择优共享同一比较函数）均合法。
 */

/** 已执行过清理的 storageRoot：进程内至多一次（桌面会并发预热多个 workspace Agent）。 */
const cleanedStorageRoots = new Set<string>();

export function cleanupStaleOfficialPluginCacheVersions(input: {
  logger?: Logger;
  storageRoot: string;
}): void {
  if (cleanedStorageRoots.has(input.storageRoot)) return;
  cleanedStorageRoots.add(input.storageRoot);
  try {
    cleanupStaleVersionsOnce(input);
  } catch (error) {
    // R6 失败安全：清理整体 try/catch 包裹，任何异常只告警不阻断启动。
    input.logger?.warn("Official plugin stale version cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
      module: "bootstrap.official_plugin_cache",
      operation: "stale_version_cleanup",
    });
  }
}

function cleanupStaleVersionsOnce(input: {
  logger?: Logger;
  storageRoot: string;
}): void {
  // R2（必改项 5）：installed_plugins.json 缺失/损坏 → 「installed 记录永不删」保护的
  // 唯一事实源失效，跳过本次清理整体（比贡献空集更保守：bundled 恰好引用同名更新版本
  // 时，用户显式安装的回滚旧版本绝不能被当残留删掉）。
  const installedRecords = tryReadInstalledPluginRecordsForCleanupSync(input.storageRoot);
  if (!installedRecords) return;

  const partitionReferences = loadOfficialMarketplaceCacheReferencesSync({
    storageRoot: input.storageRoot,
  });
  // R2 权威引用集：bundled 分片 + cdn 分片 + installed 记录（仅官方市场）三类之并。
  // 分片解析失败已在上游按「该来源贡献空集」降级；三类全空 → 删除集必为空集（fail-safe）。
  const referencedVersionsByPlugin = new Map<string, Set<string>>();
  const addReference = (name: string, version: string): void => {
    let versions = referencedVersionsByPlugin.get(name);
    if (!versions) {
      versions = new Set<string>();
      referencedVersionsByPlugin.set(name, versions);
    }
    versions.add(version);
  };
  for (const reference of partitionReferences.bundled) {
    addReference(reference.name, reference.version);
  }
  for (const reference of partitionReferences.cdn) {
    addReference(reference.name, reference.version);
  }
  for (const record of installedRecords) {
    if (record.marketplace === ACODE_OFFICIAL_PLUGIN_MARKETPLACE) {
      addReference(record.name, record.version);
    }
  }
  if (referencedVersionsByPlugin.size === 0) return;

  const cacheRoot = join(input.storageRoot, "cache", ACODE_OFFICIAL_PLUGIN_MARKETPLACE);
  let pluginEntries: Dirent[];
  try {
    pluginEntries = readdirSync(cacheRoot, { withFileTypes: true });
  } catch (error) {
    // 官方 cache 根不存在 = 没有可清理对象，不是错误。
    if (isNotFoundFsError(error)) return;
    throw error;
  }

  const budget = createOfficialPluginCacheRetryBudget();
  const removed: Array<{ pluginId: string; version: string }> = [];
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) continue;
    const referencedVersions = referencedVersionsByPlugin.get(pluginEntry.name);
    // 引用集中没有该插件名 → 不存在「被引用的更新版本」前提（R1 条件 2 恒假），永不删。
    if (!referencedVersions || referencedVersions.size === 0) continue;
    const pluginDir = join(cacheRoot, pluginEntry.name);
    let versionEntries: Dirent[];
    try {
      versionEntries = readdirSync(pluginDir, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundFsError(error)) continue;
      throw error;
    }
    for (const versionEntry of versionEntries) {
      if (!versionEntry.isDirectory()) continue;
      // R1 条件 4：目录名必须是纯版本形状；`.backup*`/`.tmp-*`/`.seed-lock*` 等事务
      // 过渡目录以 "." 开头，形状上即不可解析，双重排除；不可解析名永不删除。
      if (!parseOfficialPluginVersionDirName(versionEntry.name)) continue;
      // R1 条件 1：当前版本被任一权威来源引用 → 不是残留。
      if (referencedVersions.has(versionEntry.name)) continue;
      // R1 条件 2+3：必须存在同名「被引用且在场完整」的更新版本，旧版本才是可删残留；
      // 被引用版本不在场/残缺时旧版本可能正承担 seed fallback 降级退路，绝不删。
      if (
        !hasReferencedNewerCompleteVersion({
          cacheRoot,
          pluginDirName: pluginEntry.name,
          referencedVersions,
          staleVersionDirName: versionEntry.name,
        })
      ) {
        continue;
      }
      const targetRoot = join(pluginDir, versionEntry.name);
      try {
        removeOfficialPluginCacheDirectory(targetRoot, budget);
        removed.push({
          pluginId: `${pluginEntry.name}@${ACODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
          version: versionEntry.name,
        });
      } catch (error) {
        // R6：单目录删除失败（Windows EBUSY/EPERM 杀软占用常见）→ warn 跳过该目录，
        // 继续其余，绝不向上抛（删除重试预算已耗尽按失败跳过处理）。
        input.logger?.warn("Official plugin stale version cleanup skipped a directory", {
          error: error instanceof Error ? error.message : String(error),
          module: "bootstrap.official_plugin_cache",
          operation: "stale_version_cleanup",
          pluginId: `${pluginEntry.name}@${ACODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
          targetRoot,
        });
      }
    }
  }
  // R7：removed 为空时不打 info（避免每次启动噪音）；有删除动作才 info 一条汇总。
  if (removed.length > 0) {
    input.logger?.info("Official plugin stale version cleanup completed", {
      module: "bootstrap.official_plugin_cache",
      operation: "stale_version_cleanup",
      removed,
    });
  }
}

/**
 * R1 条件 2+3 的合并判定：引用集中是否存在一个「更新且在场完整」的同名版本。
 * 条件 2（在场完整）：`.acode-plugin/plugin.json` 存在——与 seed fallback 的
 * isSeedUsable 同判据的存在性面（requiredSeedPaths 语义属 seed 定义域，本清理器
 * 不依赖 OFFICIAL_PLUGIN_DEFINITIONS，回滚引用的旧 definition 也要能护住）。
 * 条件 3（更旧）：`compareOfficialPluginVersionDirNames(ref, stale) > 0`；任一侧
 * 不可解析 → undefined → 不参与比较，永不删（§R4 判据单点）。
 */
function hasReferencedNewerCompleteVersion(input: {
  cacheRoot: string;
  pluginDirName: string;
  referencedVersions: ReadonlySet<string>;
  staleVersionDirName: string;
}): boolean {
  for (const referencedVersion of input.referencedVersions) {
    const ordering = compareOfficialPluginVersionDirNames(
      referencedVersion,
      input.staleVersionDirName,
    );
    if (ordering === undefined || ordering <= 0) continue;
    const referencedRoot = join(input.cacheRoot, input.pluginDirName, referencedVersion);
    if (!existsSync(join(referencedRoot, ".acode-plugin", "plugin.json"))) continue;
    return true;
  }
  return false;
}
