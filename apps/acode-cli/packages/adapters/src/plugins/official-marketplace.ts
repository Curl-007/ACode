import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ACODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@acode/contracts";
import { resolveBundledOfficialPluginCachePaths } from "@acode/shared";

const BUNDLED_PARTITION_FILE = "bundled-marketplace.json";
const CDN_PARTITION_FILE = "cdn-marketplace.json";
const MERGED_MARKETPLACE_FILE = "marketplace.json";

interface BundledMarketplacePartition {
  manifest: Record<string, unknown>;
  version: 1;
}

export function writeBundledOfficialMarketplacePartitionSync(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Record<string, unknown> {
  assertOfficialManifest(input.manifest);
  writeJsonFileSync(partitionPath(input.storageRoot, BUNDLED_PARTITION_FILE), {
    manifest: input.manifest,
    version: 1,
  } satisfies BundledMarketplacePartition);
  return rebuildOfficialMarketplaceSync(input.storageRoot);
}

export function writeCdnOfficialMarketplacePartitionSync(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Record<string, unknown> {
  assertOfficialManifest(input.manifest);
  writeJsonFileSync(partitionPath(input.storageRoot, CDN_PARTITION_FILE), input.manifest);
  return rebuildOfficialMarketplaceSync(input.storageRoot);
}

export function loadBundledOfficialPluginRootsSync(
  storageRoot: string,
): string[] | undefined {
  const bundledPartition = readBundledPartition(storageRoot);
  if (!bundledPartition) return undefined;

  // M1 契约（specs/plugin-official-cache-authority-m1.md M1-3）：分片解析单点化到 shared
  // 纯函数，services 侧 scanOfficialPluginCacheRoots 消费同一函数，两条管线对同一磁盘
  // 状态不再可能分叉。行为等价重构：undefined（回退全扫）vs []（权威空集）、逐条丢弃、
  // 双重严格后代校验、分片内条目顺序全部由 helper 承接，path 注入 node:path 保持纯度。
  return resolveBundledOfficialPluginCachePaths({
    partition: bundledPartition,
    officialCacheRoot: resolve(storageRoot, "cache", ACODE_OFFICIAL_PLUGIN_MARKETPLACE),
    path: { isAbsolute, relative, resolve, sep },
  });
}

/** 官方市场分片定位到的插件引用对（name@version），cache 清理的权威引用集来源。 */
export interface OfficialMarketplaceCacheReference {
  name: string;
  version: string;
}

/**
 * 只读读取 bundled/cdn 两个官方市场分片的插件引用对，供 bootstrap 的 cache 旧版本
 * 清理判定权威引用集（specs/official-plugin-cache-cleanup.md R2/R5：分片读取归
 * adapters 所有，bootstrap 只组装）。分片解析与 bundled 根解析走同一文件同一组
 * helper（M1 同一解析单点）。任一分片缺失/损坏 → 该来源贡献空数组，绝不抛错
 * （spec R2 fail-safe：单来源权威不明时该来源不产生引用，绝不删除）。
 */
export function loadOfficialMarketplaceCacheReferencesSync(input: {
  storageRoot: string;
}): {
  bundled: OfficialMarketplaceCacheReference[];
  cdn: OfficialMarketplaceCacheReference[];
} {
  const bundledPartition = readBundledPartition(input.storageRoot);
  const bundled = bundledPartition
    ? readPluginEntries(bundledPartition.manifest).flatMap(readReferencePair)
    : [];
  const cdnManifest = readJsonRecord(partitionPath(input.storageRoot, CDN_PARTITION_FILE));
  const cdn = readPluginEntries(cdnManifest).flatMap(readReferencePair);
  return { bundled, cdn };
}

function readReferencePair(
  plugin: Record<string, unknown>,
): OfficialMarketplaceCacheReference[] {
  const name = readPluginName(plugin);
  const version =
    typeof plugin.version === "string" && plugin.version.length > 0 ? plugin.version : undefined;
  // 刻意不要求 cachePath 有效性：引用对多收一条只会让清理更保守（少删），
  // 符合「宁可漏删不可误删」；cachePath 语义校验仍归 bundled 根解析（M1）单点负责。
  return name && version ? [{ name, version }] : [];
}

function rebuildOfficialMarketplaceSync(storageRoot: string): Record<string, unknown> {
  const bundledPartition = readBundledPartition(storageRoot);
  const cdnManifest = readJsonRecord(partitionPath(storageRoot, CDN_PARTITION_FILE));
  const bundledManifest = bundledPartition?.manifest;
  const cdnPlugins = readPluginEntries(cdnManifest);
  const cdnPluginNames = new Set(cdnPlugins.map(readPluginName).filter(isDefined));
  const bundledPlugins = readPluginEntries(bundledManifest).filter((plugin) => {
    const name = readPluginName(plugin);
    return name !== undefined && !cdnPluginNames.has(name);
  });

  // 内置插件与 CDN 插件曾使用两个 marketplace id，UI 会把内置市场当成
  // 无 source 的独立市场并在刷新时报 not found。两个分片必须独立持久化后再合并，
  // 否则应用启动时的 seed 会覆盖 CDN 目录，或 CDN 刷新会覆盖内置目录。同名时以
  // 可刷新的 CDN 市场条目为准，但只过滤合并目录，不删除应用内置缓存。
  const merged = {
    ...(bundledManifest ?? {}),
    ...(cdnManifest ?? {}),
    name: ACODE_OFFICIAL_PLUGIN_MARKETPLACE,
    plugins: [...cdnPlugins, ...bundledPlugins],
  };
  writeJsonFileSync(partitionPath(storageRoot, MERGED_MARKETPLACE_FILE), merged);
  return merged;
}

function readBundledPartition(storageRoot: string): BundledMarketplacePartition | undefined {
  const value = readJsonRecord(partitionPath(storageRoot, BUNDLED_PARTITION_FILE));
  if (!value || value.version !== 1 || !isRecord(value.manifest)) return undefined;
  return {
    manifest: value.manifest,
    version: 1,
  };
}

function readPluginEntries(
  manifest: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  return Array.isArray(manifest?.plugins) ? manifest.plugins.filter(isRecord) : [];
}

function readPluginName(plugin: Record<string, unknown>): string | undefined {
  return typeof plugin.name === "string" && plugin.name.length > 0 ? plugin.name : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function assertOfficialManifest(manifest: Record<string, unknown>): void {
  if (manifest.name !== ACODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    throw new Error(
      `Official marketplace manifest must be named ${ACODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    );
  }
}

function partitionPath(storageRoot: string, fileName: string): string {
  return join(storageRoot, "marketplaces", ACODE_OFFICIAL_PLUGIN_MARKETPLACE, fileName);
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeJsonFileSync(path: string, value: unknown): void {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    // 官方目录在每次启动都会重建；同内容反复写盘会增加 Windows 上
    // marketplace 文件被杀毒/索引器占用的概率。只跳过字节完全相同的单文件写入，
    // 读取失败或内容变化仍执行写入并保留原有失败语义。
    if (readFileSync(path, "utf8") === contents) return;
  } catch {
    // 文件不存在或暂时不可读时继续写，让真实更新失败继续向调用方暴露。
  }
  writeFileSync(path, contents, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
