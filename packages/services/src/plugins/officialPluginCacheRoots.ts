/**
 * 官方插件 cache 候选根扫描（services 侧单点）。
 *
 * 官方 cache 有三条消费管线：CLI 插件解析（apps/acode-cli adapters `scanOfficialCache`）、
 * 设置页 skills 数据源（skillsService）与设置页 commands 数据源（commandsService）。此前
 * commandsService 内残留第三份私有实现（readdir 全版本目录 + 下游字典序先到先得），会加载
 * 被权威分片屏蔽的旧版插件贡献的命令/技能，与 bundled-marketplace.json 分片的权威解析
 * （specs/skills-bundled-visibility-and-official-cache-authority.md §四 R3/M1-3，
 * 判据单点在 @acode/shared `resolveBundledOfficialPluginCachePaths` /
 * `selectBestOfficialPluginVersionDirName`）分叉。本模块把 services 侧的权威消费收敛为
 * 单一实现，skills 与 commands 两条管线共同 import；adapters 侧归 plugin-release-fixer，
 * 经同一 shared 纯函数对齐。
 *
 * 语义（与 adapters 逐条对齐，见 shared helper 契约）：
 * - 分片有效 → helper 结果直接作为官方 cache roots；空数组 = 权威声明「无内置插件」，不回退。
 * - 分片缺失/读失败/坏 JSON/version≠1（helper 返回 undefined）→ 回退 readdir 全扫 +
 *   规则 V2 组内 semver 择优（每插件仅最高版本产出候选根；不可解析目录名含
 *   `.backup*`/`.tmp-*`/`.seed-lock*` 不产出；同版本并列取目录名字典序较大者）。
 */
import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  resolveBundledOfficialPluginCachePaths,
  selectBestOfficialPluginVersionDirName,
} from "@acode/shared";

const ACODE_OFFICIAL_PLUGIN_MARKETPLACE = "acode-plugins-official";

/**
 * 读取 bundled-marketplace.json 分片的 JSON.parse 产物（M1-3 services 侧）。
 * 文件缺失、读失败（Windows 杀软占用等瞬态 IO 错误）与 JSON.parse 失败同按 undefined 处理，
 * 与 adapters 侧 readJsonRecord 的容错语义一致（plugin-release-fixer 对表确认）；
 * undefined 交由 resolveBundledOfficialPluginCachePaths 判定为「损坏」→ 调用方回退全扫。
 */
async function readBundledOfficialMarketplacePartition(
  pluginStorageRoot: string,
): Promise<unknown> {
  const partitionPath = join(
    pluginStorageRoot,
    "marketplaces",
    ACODE_OFFICIAL_PLUGIN_MARKETPLACE,
    "bundled-marketplace.json",
  );
  try {
    return JSON.parse(await readFile(partitionPath, "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * 官方 cache 候选根集合（分片权威优先，回退全扫 + 组内择优）。
 * 仅供测试注入 tmp fixture：pluginStorageRoot 由真实 HOME 的 CLI config 推导，
 * list() 全链不可注入，数据源层语义以本函数为覆盖面（诚实登记：未走 list() 端到端）。
 */
export async function scanOfficialPluginCacheRoots(pluginStorageRoot: string): Promise<string[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ACODE_OFFICIAL_PLUGIN_MARKETPLACE);
  // M1 分片权威优先（specs/skills-bundled-visibility-and-official-cache-authority.md §四 R3）：
  // 分片有效 → helper 结果直接作为官方 cache roots（空数组 = 权威声明无内置插件，不回退），
  // 与 CLI 插件解析管线消费同一份解析结果，消除「数据源层含、UI 层过滤」的分裂。
  // helper 返回 undefined（分片缺失/损坏/version≠1）→ 回退下方 readdir 全扫。
  const partition = await readBundledOfficialMarketplacePartition(pluginStorageRoot);
  const authoritativeRoots = resolveBundledOfficialPluginCachePaths({
    partition,
    officialCacheRoot: cacheRoot,
    path: { isAbsolute, relative, resolve, sep },
  });
  if (authoritativeRoots !== undefined) {
    return authoritativeRoots;
  }
  // 回退分支：readdir 全扫 + 规则 V2 组内择优（apps/acode-cli/specs/plugin-official-cache-authority-m1.md
  // 规则 V，spec §四 M1-3）。相对现状的显式行为变更（规则 V4）：此前把同名插件全部版本目录
  // 收进候选，下游 seen 去重按字典序先到先得，降级态会加载 stale 旧版（如 acode-guide/0.2.0
  // 排在 0.3.0 前）；现改为组内仅保留 semver 最高版本作为候选根。不可解析目录名（含
  // `.backup*`/`.tmp-*`/`.seed-lock*` 事务过渡形状）不产出候选根；同版本并列取目录名字典序
  // 较大者——判据消费 shared 单点 selectBestOfficialPluginVersionDirName（规则 V3），
  // 与 adapters 回退分支、D2 清理判定共用同一函数，两管线输出对同一磁盘状态确定且一致。
  let pluginEntries: Dirent[] = [];
  try {
    pluginEntries = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const versionsByPlugin = new Map<string, string[]>();
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) {
      continue;
    }
    let versionEntries: Dirent[] = [];
    try {
      versionEntries = await readdir(join(cacheRoot, pluginEntry.name), { withFileTypes: true });
    } catch {
      continue;
    }
    const versions = versionsByPlugin.get(pluginEntry.name) ?? [];
    for (const versionEntry of versionEntries) {
      if (versionEntry.isDirectory()) {
        versions.push(versionEntry.name);
      }
    }
    versionsByPlugin.set(pluginEntry.name, versions);
  }
  const roots: string[] = [];
  for (const [pluginName, versions] of versionsByPlugin) {
    const bestVersion = selectBestOfficialPluginVersionDirName(versions);
    if (bestVersion !== undefined) {
      roots.push(join(cacheRoot, pluginName, bestVersion));
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}
