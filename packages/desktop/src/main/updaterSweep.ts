// 更新残留清扫 + pending 目录解析（specs/updater-journal-recovery.md R5）。
//
// Mechanism ported from oh-my-pi (MIT) packages/coding-agent/src/cli/update-cli.ts,
// Copyright (c) 2025 Mario Zechner & Stencil Labs —— 借鉴其 sweepStaleUpdateArtifacts
// 的「模式匹配 + mtime 年龄窗 + best-effort 删除」与 Windows 运行中镜像 .bak
// 延迟回收思想（被占用文件本轮跳过、留待下次清扫）。
//
// electron-updater 差异说明：omp 的 .new/.bak 与正在进行的并发下载同目录，所以
// 只按下载超时窗保护；electron-updater 的 pending 目录只在下载 stage 完成后由
// emptyDir/setDownloadedFile 写入（并发下载的临时文件在上级 cacheDir），这里的
// 新鲜保护窗（minKeepAgeMs）只防「无账本可依时误清刚落地的包」，是保守下限。
//
// 平台语义：Windows 上被运行进程占用的文件 unlink 报 EPERM/EBUSY/EACCES →
// 记入 skipped 留待下次；POSIX 对 open 文件 unlink 本就成功（内核语义），同一
// 代码路径天然覆盖两平台，无需平台分支（spec R5 决策表）。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export const PENDING_DIR_SEGMENT = "pending";
export const UPDATE_INFO_FILE_NAME = "update-info.json";
/** 默认新鲜保护窗：无账本可依时，1h 内的文件不清理（保守下限）。 */
export const DEFAULT_SWEEP_MIN_KEEP_AGE_MS = 60 * 60 * 1000;
/** 默认无条件过期窗：任何文件超过 7 天一律过期清除（含被占用跳过过的残留）。 */
export const DEFAULT_SWEEP_STALE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface UpdaterSweepLogger {
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/**
 * 复刻 electron-updater 的 baseCachePath（AppAdapter.getAppCacheDir）：
 * win32=%LOCALAPPDATA%|~/AppData/Local、darwin=~/Library/Caches、
 * linux=$XDG_CACHE_HOME|~/.cache。
 */
export function resolveUpdaterCacheBasePath(deps: {
  platform: NodeJS.Platform;
  env: { LOCALAPPDATA?: string | undefined; XDG_CACHE_HOME?: string | undefined };
  homeDir: string;
}): string {
  if (deps.platform === "win32") {
    return deps.env.LOCALAPPDATA?.trim() || join(deps.homeDir, "AppData", "Local");
  }
  if (deps.platform === "darwin") {
    return join(deps.homeDir, "Library", "Caches");
  }
  return deps.env.XDG_CACHE_HOME?.trim() || join(deps.homeDir, ".cache");
}

/**
 * 从 app-update.yml 单行解析 updaterCacheDirName（打包版）或 dev-app-update.yml
 * （开发态）。解析失败/字段缺失兜底 `${appName}-updater`（electron-updater 的
 * 同名兜底），前向兼容：任何解析异常都不抛出。
 */
export function parseUpdaterCacheDirName(yamlText: string): string | null {
  const match = /^\s*updaterCacheDirName\s*:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(yamlText);
  const name = match?.[1]?.trim();
  return name ? name : null;
}

export async function resolveUpdaterPendingDir(deps: {
  platform: NodeJS.Platform;
  env: { LOCALAPPDATA?: string | undefined; XDG_CACHE_HOME?: string | undefined };
  homeDir: string;
  isPackaged: boolean;
  /** 打包构建的 resources 目录；非打包传 null。 */
  resourcesPath: string | null;
  /** 非打包构建的 dev-app-update.yml 路径；打包传 null。 */
  devAppUpdateConfigPath: string | null;
  appName: string;
  readTextFile?: (path: string) => Promise<string | null>;
}): Promise<string> {
  const readTextFile =
    deps.readTextFile ?? (async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return null;
      }
    });
  const configPath = deps.isPackaged
    ? deps.resourcesPath !== null
      ? join(deps.resourcesPath, "app-update.yml")
      : null
    : deps.devAppUpdateConfigPath;
  let cacheDirName: string | null = null;
  if (configPath !== null) {
    try {
      const yamlText = await readTextFile(configPath);
      cacheDirName = yamlText !== null ? parseUpdaterCacheDirName(yamlText) : null;
    } catch {
      cacheDirName = null;
    }
  }
  const resolvedName = cacheDirName ?? `${deps.appName}-updater`;
  return join(resolveUpdaterCacheBasePath(deps), resolvedName, PENDING_DIR_SEGMENT);
}

/** 流式 sha512（安装器可达数百 MB，不整读内存）。 */
export async function computeFileSha512(
  filePath: string,
  fs?: { createReadStream?: typeof createReadStream },
): Promise<string> {
  const stream = (fs?.createReadStream ?? createReadStream)(filePath);
  const hash = createHash("sha512");
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

export interface PendingInstallerValidation {
  ok: boolean;
  reason?: string;
}

/**
 * pending 安装器完整性校验（spec R3/R5：区分「完整可留」与「部分下载必清」）：
 * 存在性 → size（实测 stat）逐级短路 → sha512（流式全量）。无期望值字段时
 * 视为无法判伪（ok=true 保守保留）。
 */
export async function validatePendingInstallerFile(deps: {
  filePath: string;
  expectedSha512: string | null;
  expectedSize: number | null;
  fs?: {
    stat?: typeof stat;
    computeFileSha512?: typeof computeFileSha512;
  };
}): Promise<PendingInstallerValidation> {
  const statFn = deps.fs?.stat ?? stat;
  const hashFn = deps.fs?.computeFileSha512 ?? computeFileSha512;
  let stats;
  try {
    stats = await statFn(deps.filePath);
  } catch {
    return { ok: false, reason: "installer file missing" };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: "installer path is not a regular file" };
  }
  if (deps.expectedSize !== null && stats.size !== deps.expectedSize) {
    return {
      ok: false,
      reason: `size mismatch (expected=${deps.expectedSize} actual=${stats.size})`,
    };
  }
  if (deps.expectedSha512 !== null) {
    let actual: string;
    try {
      actual = await hashFn(deps.filePath);
    } catch (error) {
      return {
        ok: false,
        reason: `sha512 unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (actual.toLowerCase() !== deps.expectedSha512.toLowerCase()) {
      return { ok: false, reason: "sha512 mismatch" };
    }
  }
  return { ok: true };
}

export interface SweepCurrentGeneration {
  /** 当前代账本记录的安装器文件名；null = 无法按名匹配（按非 lineage 处理）。 */
  installerFileName: string | null;
  sha512: string | null;
  size: number | null;
  /**
   * preserve=true（outcome ∈ handed-off / install-not-effective / handoff-aborted /
   * unknown）：该代仍可服务 cache-hit 重试，有效安装器与 update-info.json 保留；
   * preserve=false（verified / failed / 无账本）：代已收口，不再服务重试。
   */
  preserve: boolean;
}

export interface SweepStalePendingSummary {
  removed: string[];
  kept: string[];
  /** Windows 被占用等 unlink 失败：本轮跳过留待下次（.bak 延迟回收语义）。 */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * pending 目录残留清扫（spec R5 决策表）。best-effort：任何单文件失败不影响
 * 其余；readdir/目录缺失 → 空清扫；整体不抛出。
 */
export async function sweepStaleUpdatePendingArtifacts(deps: {
  pendingDir: string;
  now: () => number;
  minKeepAgeMs?: number;
  staleRetentionMs?: number;
  currentGeneration: SweepCurrentGeneration | null;
  fs?: {
    readdir?: typeof readdir;
    stat?: typeof stat;
    unlink?: typeof unlink;
    computeFileSha512?: typeof computeFileSha512;
  };
  logger?: UpdaterSweepLogger;
}): Promise<SweepStalePendingSummary> {
  const readdirFn = deps.fs?.readdir ?? readdir;
  const statFn = deps.fs?.stat ?? stat;
  const unlinkFn = deps.fs?.unlink ?? unlink;
  const hashFn = deps.fs?.computeFileSha512 ?? computeFileSha512;
  const minKeepAgeMs = deps.minKeepAgeMs ?? DEFAULT_SWEEP_MIN_KEEP_AGE_MS;
  const staleRetentionMs = deps.staleRetentionMs ?? DEFAULT_SWEEP_STALE_RETENTION_MS;
  const summary: SweepStalePendingSummary = { removed: [], kept: [], skipped: [] };

  let names: string[];
  try {
    const dirents = await readdirFn(deps.pendingDir, { withFileTypes: true });
    names = dirents.filter((dirent) => dirent.isFile()).map((dirent) => dirent.name);
  } catch (error) {
    // 目录缺失/不可读 = 无可清扫（ENOENT 属常态；其它错误留痕即可）。
    deps.logger?.debug?.("[update-sweep] pending dir unreadable, nothing to sweep", {
      event: "update_pending_sweep_unreadable",
      outcome: "absent",
      error: error instanceof Error ? error.message : String(error),
    });
    return summary;
  }

  const nowMs = deps.now();
  for (const name of names) {
    const full = join(deps.pendingDir, name);
    try {
      const stats = await statFn(full);
      const ageMs = nowMs - stats.mtimeMs;

      // 1) 无条件过期窗：超过 staleRetentionMs 一律清除（被占用跳过的残留最终
      //    在此收敛）。mtime 读不到按「不过期」保守处理（stats 失败会在下方分支兜底）。
      if (Number.isFinite(ageMs) && ageMs >= staleRetentionMs) {
        await removeBestEffort(name, full, unlinkFn, summary);
        continue;
      }

      const isUpdateInfo = name === UPDATE_INFO_FILE_NAME;
      const generation = deps.currentGeneration;
      const matchesGeneration =
        generation !== null &&
        generation.installerFileName !== null &&
        name === generation.installerFileName;

      if (matchesGeneration) {
        if (generation.preserve) {
          // 完整可留 / 部分必清：sha512 优先，其次 size，都缺则保守保留。
          const validation = await validatePendingInstallerFile({
            filePath: full,
            expectedSha512: generation.sha512,
            expectedSize: generation.size,
            fs: { stat: statFn, computeFileSha512: hashFn },
          });
          if (validation.ok) {
            summary.kept.push(name);
          } else {
            await removeBestEffort(name, full, unlinkFn, summary, validation.reason);
          }
          continue;
        }
        // 代已收口（verified/failed）：消费完成，不再服务重试。
        await removeBestEffort(name, full, unlinkFn, summary, "generation closed");
        continue;
      }

      if (isUpdateInfo && generation?.preserve === true) {
        // update-info.json 属于被保留代：留（保 cache-hit 重试）。
        summary.kept.push(name);
        continue;
      }

      // 3) 非当前代 lineage：新鲜保护窗内保守保留，超窗清除。
      if (Number.isFinite(ageMs) && ageMs < minKeepAgeMs) {
        summary.kept.push(name);
        continue;
      }
      await removeBestEffort(name, full, unlinkFn, summary, "not current lineage");
    } catch (error) {
      // stat 等意外失败：保守保留本轮，留痕。
      summary.skipped.push({
        name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}

async function removeBestEffort(
  name: string,
  full: string,
  unlinkFn: typeof unlink,
  summary: SweepStalePendingSummary,
  reason = "stale",
): Promise<void> {
  try {
    await unlinkFn(full);
    summary.removed.push(name);
  } catch (error) {
    // Windows 被占用（EPERM/EBUSY/EACCES 等）：跳过留待下次（延迟回收）。
    summary.skipped.push({
      name,
      reason: `${reason}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}
