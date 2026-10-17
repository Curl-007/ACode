import { join } from "node:path";
import type { WorkspaceFileEntry } from "@acode/shared";
import {
  isWorkspaceFileSearchPathIgnored,
  loadWorkspaceFileSearchIgnoreRules,
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
} from "./workspaceFileIgnore.js";
import type { WorkspaceFileSearchFilter } from "./workspaceFileMentionFilter.js";

/**
 * git 清单 → workspace 文件索引 entries 的组装与缓存成本策略（纯函数层）。
 * 产品规则见 specs/file-index-degradation.md R4/R5；采集与冷却见
 * workspaceGitFileListing.ts。
 */

/**
 * 换行注入过滤（spec R5）：含 \n/\r 的路径剔除并计数，防任何按行拼接的
 * 下游清单被病态文件名注入。纯函数导出供测试（Windows 无法创建含 \n 的
 * 文件名，集成段用例在 Win32 会 skip，这里保证全平台可验证）。
 */
export function filterGitListingNewlinePaths(records: string[]): {
  paths: string[];
  droppedNewlinePaths: number;
} {
  const paths: string[] = [];
  let droppedNewlinePaths = 0;
  for (const record of records) {
    if (record.includes("\n") || record.includes("\r")) {
      droppedNewlinePaths += 1;
      continue;
    }
    paths.push(record);
  }
  return { paths, droppedNewlinePaths };
}

export interface WorkspaceGitListingEntryContext {
  rootPath: string;
  ignoreRules: Awaited<ReturnType<typeof loadWorkspaceFileSearchIgnoreRules>>;
  filter: WorkspaceFileSearchFilter;
}

/**
 * git 清单（相对 rootPath 的 posix 分隔路径）→ WorkspaceFileEntry[]。
 * 与全量扫描语义对齐（spec R5）：逐路径过 .acodeignore 规则与注入过滤器；
 * 目录条目由祖先合成，被 ignore 或 traverse=false 的祖先整枝剪掉；
 * include=false/traverse=true 的目录（隐藏目录）不出条目但子文件保留；
 * 根级 .acodeignore 自身剔除。排序由调用方与扫描路径共用同一比较器。
 */
export function buildWorkspaceFileEntriesFromGitListing(
  paths: string[],
  context: WorkspaceGitListingEntryContext,
): WorkspaceFileEntry[] {
  const entries: WorkspaceFileEntry[] = [];
  // 三类祖先目录记忆化：已出条目 / 可遍历但不出条目 / 已剪枝。
  const emittedDirs = new Set<string>();
  const traversableDirs = new Set<string>();
  const prunedDirs = new Set<string>();

  for (const relativePath of paths) {
    if (relativePath.length === 0 || relativePath === WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME) {
      continue;
    }
    const segments = relativePath.split("/");
    let pruned = false;
    for (let depth = 1; depth < segments.length; depth += 1) {
      const dirRelativePath = segments.slice(0, depth).join("/");
      if (emittedDirs.has(dirRelativePath) || traversableDirs.has(dirRelativePath)) {
        continue;
      }
      if (prunedDirs.has(dirRelativePath)) {
        pruned = true;
        break;
      }
      if (isWorkspaceFileSearchPathIgnored(context.ignoreRules, dirRelativePath, "directory")) {
        prunedDirs.add(dirRelativePath);
        pruned = true;
        break;
      }
      const dirName = segments[depth - 1]!;
      const dirAbsolutePath = join(context.rootPath, ...segments.slice(0, depth));
      const decision = context.filter.evaluate(
        { name: dirName, path: dirAbsolutePath, relativePath: dirRelativePath, type: "directory" },
        { ignoreRulesActive: true },
      );
      if (!decision.traverse) {
        prunedDirs.add(dirRelativePath);
        pruned = true;
        break;
      }
      if (decision.include) {
        emittedDirs.add(dirRelativePath);
        entries.push({
          name: dirName,
          path: dirAbsolutePath,
          relativePath: dirRelativePath,
          type: "directory",
        });
      } else {
        traversableDirs.add(dirRelativePath);
      }
    }
    if (pruned) {
      continue;
    }
    if (isWorkspaceFileSearchPathIgnored(context.ignoreRules, relativePath, "file")) {
      continue;
    }
    const name = segments[segments.length - 1]!;
    const absolutePath = join(context.rootPath, ...segments);
    const decision = context.filter.evaluate(
      { name, path: absolutePath, relativePath, type: "file" },
      { ignoreRulesActive: true },
    );
    if (decision.include) {
      entries.push({ name, path: absolutePath, relativePath, type: "file" });
    }
  }

  return entries;
}

export const WORKSPACE_FILE_INDEX_CACHE_MIN_COST_MS = 250;
export const WORKSPACE_FILE_INDEX_CACHE_MIN_ENTRIES = 50_000;
export const WORKSPACE_FILE_INDEX_CACHE_TTL_MULTIPLIER = 20;
export const WORKSPACE_FILE_INDEX_CACHE_TTL_MIN_MS = 30_000;
export const WORKSPACE_FILE_INDEX_CACHE_TTL_MAX_MS = 120_000;

/**
 * 成本比例 TTL（替换 60s 固定 TTL，spec R4）：
 * 仅当完整清单耗时 ≥250ms 且 ≥5 万条才值得缓存，TTL=耗时×20 clamp 到 30s-120s；
 * 返回 0 表示不缓存（小仓重建成本低于陈旧收益，有意取舍）。
 */
export function computeWorkspaceFileIndexReuseMs(elapsedMs: number, entryCount: number): number {
  if (elapsedMs < WORKSPACE_FILE_INDEX_CACHE_MIN_COST_MS) {
    return 0;
  }
  if (entryCount < WORKSPACE_FILE_INDEX_CACHE_MIN_ENTRIES) {
    return 0;
  }
  return Math.min(
    WORKSPACE_FILE_INDEX_CACHE_TTL_MAX_MS,
    Math.max(
      WORKSPACE_FILE_INDEX_CACHE_TTL_MIN_MS,
      Math.round(elapsedMs * WORKSPACE_FILE_INDEX_CACHE_TTL_MULTIPLIER),
    ),
  );
}
