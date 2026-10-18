/**
 * bundled-marketplace.json 分片的权威解析（M1 契约单点）。
 *
 * 官方插件 cache 有两条消费管线：CLI 插件解析（apps/acode-cli adapters `scanOfficialCache`）
 * 与设置页数据源（packages/services `scanOfficialPluginCacheRoots`）。解析逻辑以前在
 * adapters 内私有，两条管线对同一磁盘状态可能产出不同的插件根集合（分叉）。
 * 本 helper 把 adapters 的既有语义提取为 shared 纯函数，双方消费同一份解析结果。
 *
 * 契约：apps/acode-cli/specs/plugin-official-cache-authority-m1.md M1-1/M1-2 与
 * packages/services/specs/skills-bundled-visibility-and-official-cache-authority.md §四（同文）。
 * 纯函数、零 IO、零 `node:*` import：shared 主入口跨端（浏览器构建不可被 node 模块污染），
 * 文件读取与路径能力由调用方注入（Node 调用方传 `node:path`）。
 */

/** 路径操作注入：Node 调用方传 node:path（resolve/relative/isAbsolute/sep），保持 helper 纯度与跨端安全。 */
export interface OfficialMarketplacePartitionPathOps {
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
  resolve(...segments: string[]): string;
  sep: string;
}

/**
 * bundled-marketplace.json 分片的权威解析（线 A/M1 spec §四）。
 * 返回 undefined：分片缺失/损坏/version !== 1 → 调用方回退 readdir 全扫；
 * 返回数组（可为空）：权威结果，空数组 = 权威声明无内置插件，调用方不得回退。
 * 单条记录无效（name/cachePath 非串、cachePath 越界）时丢弃该条，不影响其余条目。
 */
export function resolveBundledOfficialPluginCachePaths(params: {
  partition: unknown;
  officialCacheRoot: string;
  path: OfficialMarketplacePartitionPathOps;
}): string[] | undefined {
  const { partition, officialCacheRoot, path } = params;
  if (!isRecord(partition) || partition.version !== 1) {
    return undefined;
  }
  const manifest = partition.manifest;
  if (!isRecord(manifest)) {
    return undefined;
  }
  // 现实现 readPluginEntries 对非数组 plugins 返回 []（有效分片 + 空条目集 = 空权威集）。
  const rawPlugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  const results: string[] = [];
  for (const rawPlugin of rawPlugins) {
    if (!isRecord(rawPlugin)) {
      continue;
    }
    const name = typeof rawPlugin.name === "string" && rawPlugin.name.length > 0 ? rawPlugin.name : undefined;
    const cachePath =
      typeof rawPlugin.cachePath === "string" && rawPlugin.cachePath.length > 0
        ? rawPlugin.cachePath
        : undefined;
    if (!name || !cachePath) {
      continue;
    }
    const pluginCacheRoot = path.resolve(officialCacheRoot, name);
    const resolvedCachePath = path.resolve(cachePath);
    // 双重严格后代校验：officialCacheRoot ⊋ pluginCacheRoot ⊋ resolvedCachePath，
    // 防 `../` 越界与指向分片外的路径（对齐现实现 isStrictDescendant 语义）。
    if (
      !isStrictDescendant(officialCacheRoot, pluginCacheRoot, path) ||
      !isStrictDescendant(pluginCacheRoot, resolvedCachePath, path)
    ) {
      continue;
    }
    results.push(resolvedCachePath);
  }
  return results;
}

function isStrictDescendant(
  parentPath: string,
  childPath: string,
  path: OfficialMarketplacePartitionPathOps,
): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath.length > 0 &&
    !path.isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
