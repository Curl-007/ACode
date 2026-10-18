import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomically } from "./atomic-directory.js";
import { isNotFoundError } from "./helpers.js";

/**
 * 市场安装事务层（specs/plugin-install-transactions.md R3）。
 *
 * // Mechanism ported from oh-my-pi (MIT) docs/plugin-manager-installer-plumbing.md
 * // （:127 安装前快照 + 失败恢复三件套；:259-267 回滚矩阵，含「回滚失败追加到报告
 * // 错误」语义），Copyright (c) 2025 Mario Zechner & Stencil Labs。仅取机制语义，
 * // 实现为 ACode Node 栈重写；快照/恢复只作用于 marketplace.ts 的既有写路径，
 * // 不引入第二条状态写入路径。
 *
 * 快照范围：
 *  - installed_plugins.json 原始文本（事务开始时，缺失记 null）；
 *  - 每个插件缓存目标目录在首次触碰前（激活前）的存在性 + 有界内容清单。
 * 回滚语义：先让目录级 activation 自行恢复，再由本层恢复注册表原文、核对目标
 * 状态并做可修复修复（rm 多余目录 / rename 回 backup）；任一步失败或核对不匹配
 * → 落 fail-loud 状态文件并把回滚失败追加进抛出的错误。
 */

/** 内容清单上限：防超大气垫目录把快照变成全量拷贝；超限记 truncated 并在核对时放宽。 */
const INVENTORY_MAX_ENTRIES = 4000;
const INVENTORY_MAX_DEPTH = 8;

const INSTALLED_PLUGINS_FILE = "installed_plugins.json";

export interface TargetSnapshot {
  existed: boolean;
  inventory: string[];
  inventoryTruncated: boolean;
}

export interface TargetRollbackOutcome {
  path: string;
  snapshotExisted: boolean;
  /** 回滚后状态：restored（与快照一致）/ repaired / mismatch。 */
  outcome: "restored" | "repaired" | "mismatch";
  detail?: string;
  /** activation backup 仍留在盘上时的人工恢复线索。 */
  backupPath?: string;
}

export interface MarketplaceInstallTransactionFailureReport {
  failedAt: string;
  stage: string;
  originalError: string;
  pluginId?: string;
  rollbackErrors: string[];
  registry: { path: string; hadContent: boolean; restored: boolean };
  targets: TargetRollbackOutcome[];
  startedAt: string;
  transactionId: string;
}

export interface MarketplaceInstallTransaction {
  transactionId: string;
  /** 目标目录首次触碰前快照；重复调用同一目标是幂等的（保留首次快照）。 */
  snapshotTarget(targetPath: string): Promise<void>;
  /**
   * 阶段失败后调用：恢复快照并抛出聚合错误（永不静默吞掉回滚失败）。
   * 回滚完全成功 → 原始错误追加 rolled back 说明后抛出；
   * 回滚失败 → 落 `.install-transactions/failed-<txid>.json` 后抛出聚合错误。
   */
  rollback(input: { error: unknown; pluginId?: string; stage: string }): Promise<never>;
  /** 成功提交：只清理内存态。 */
  finalize(): void;
}

export async function beginMarketplaceInstallTransaction(input: {
  storageRoot: string;
}): Promise<MarketplaceInstallTransaction> {
  const transactionId = randomUUID();
  const startedAt = new Date().toISOString();
  const registryPath = join(input.storageRoot, INSTALLED_PLUGINS_FILE);
  const registryRaw = await readFileOrNull(registryPath);
  const targetSnapshots = new Map<string, TargetSnapshot>();
  let settled = false;

  return {
    transactionId,
    async snapshotTarget(targetPath: string): Promise<void> {
      if (settled) return;
      const key = resolveKey(targetPath);
      if (targetSnapshots.has(key)) return;
      targetSnapshots.set(key, await snapshotDirectory(targetPath));
    },
    async rollback({ error, pluginId, stage }) {
      if (settled) return rethrowAugmented(error, "install rolled back to the pre-install snapshot");
      settled = true;
      const rollbackErrors: string[] = [];
      const targetOutcomes: TargetRollbackOutcome[] = [];

      // 1. 注册表恢复为快照原文（原缺失则删除该文件）。
      let registryRestored = true;
      if (registryRaw === null) {
        try {
          await rm(registryPath, { force: true });
        } catch (cause) {
          registryRestored = false;
          rollbackErrors.push(`registry restore (remove) failed: ${messageOf(cause)}`);
        }
      } else {
        try {
          await writeFileAtomically(registryPath, registryRaw);
        } catch (cause) {
          registryRestored = false;
          rollbackErrors.push(`registry restore (write) failed: ${messageOf(cause)}`);
        }
      }

      // 2. 逐目标核对与可修复修复（倒序，后触碰的先核对）。
      const touched = [...targetSnapshots.entries()].reverse();
      for (const [key, snapshot] of touched) {
        targetOutcomes.push(await restoreTarget(key, snapshot, rollbackErrors, input.storageRoot));
      }

      const augmentedNote = "install rolled back to the pre-install snapshot";
      if (rollbackErrors.length === 0) {
        return rethrowAugmented(error, augmentedNote);
      }

      // 3. fail-loud：回滚失败必须留下可诊断状态文件（spec R3）。
      const report: MarketplaceInstallTransactionFailureReport = {
        transactionId,
        startedAt,
        failedAt: new Date().toISOString(),
        stage,
        ...(pluginId ? { pluginId } : {}),
        originalError: messageOf(error),
        rollbackErrors,
        registry: { path: registryPath, hadContent: registryRaw !== null, restored: registryRestored },
        targets: targetOutcomes,
      };
      const stateFilePath = join(input.storageRoot, ".install-transactions", `failed-${transactionId}.json`);
      let stateFileNote = "";
      try {
        await mkdir(dirname(stateFilePath), { recursive: true });
        await writeFile(stateFilePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
        stateFileNote = ` Rollback failure report: ${stateFilePath}`;
      } catch (cause) {
        stateFileNote = ` Rollback failure report could not be written (${messageOf(cause)}); report payload follows: ${JSON.stringify(report)}`;
      }
      const aggregate = new Error(
        `${messageOf(error)}; install rollback FAILED (${rollbackErrors.length} problem(s)): ` +
          `${rollbackErrors.join("; ")}.${stateFileNote}`,
        { cause: error },
      );
      aggregate.name = "MarketplaceInstallRollbackError";
      throw aggregate;
    },
    finalize() {
      settled = true;
    },
  };
}

function resolveKey(targetPath: string): string {
  // Windows 大小写/分隔符差异归一，避免同一目录被快照两次。
  return targetPath.replace(/[\\/]+/gu, "/").toLowerCase();
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function snapshotDirectory(targetPath: string): Promise<TargetSnapshot> {
  try {
    const info = await stat(targetPath);
    if (!info.isDirectory()) {
      return { existed: true, inventory: [], inventoryTruncated: true };
    }
  } catch {
    return { existed: false, inventory: [], inventoryTruncated: false };
  }
  const inventory: string[] = [];
  let truncated = false;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (truncated || depth > INVENTORY_MAX_DEPTH) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      inventory.push(`<unreadable:${current}>`);
      truncated = true;
      return;
    }
    for (const entry of entries) {
      if (inventory.length >= INVENTORY_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const child = join(current, entry.name);
      inventory.push(entry.isFile() ? entry.name : `${entry.name}/`);
      if (entry.isDirectory()) await walk(child, depth + 1);
    }
  };
  await walk(targetPath, 0);
  return { existed: true, inventory, inventoryTruncated: truncated };
}

async function restoreTarget(
  targetPath: string,
  snapshot: TargetSnapshot,
  rollbackErrors: string[],
  storageRoot: string,
): Promise<TargetRollbackOutcome> {
  const parent = dirname(targetPath);
  const backupPath = join(parent, `.${require_basename(targetPath)}.backup`);
  let postExists = false;
  try {
    postExists = (await stat(targetPath)).isDirectory();
  } catch {
    postExists = false;
  }

  if (!snapshot.existed && !postExists) {
    // activation rollback 已移除目标；它 mkdir(parent, recursive) 留下的空父目录链
    // 仍在快照之外，逐级剪掉到 storageRoot 为止（rmdir 非空即停，不误删既有内容）。
    await pruneEmptyParentChain(dirname(targetPath), storageRoot);
    return { path: targetPath, snapshotExisted: false, outcome: "restored" };
  }
  if (!snapshot.existed && postExists) {
    // activation rollback 缺席时的兜底：删除本轮新建的目录。
    try {
      await rm(targetPath, { force: true, recursive: true });
      if (existsSync(targetPath)) throw new Error("target still present after remove");
      // activation 的 mkdir(parent, recursive) 会在快照之外留下空父目录链；
      // 快照语义是「不存在 → 不存在」，逐级剪掉到 storageRoot 为止（非空即停）。
      await pruneEmptyParentChain(dirname(targetPath), storageRoot);
      return { path: targetPath, snapshotExisted: false, outcome: "repaired" };
    } catch (cause) {
      rollbackErrors.push(`target remove failed for ${targetPath}: ${messageOf(cause)}`);
      return { path: targetPath, snapshotExisted: false, outcome: "mismatch", detail: messageOf(cause) };
    }
  }
  if (snapshot.existed && !postExists) {
    // 快照存在但目录消失：activation 的 backup 恢复失败时 backup 通常仍在，尝试修复。
    if (existsSync(backupPath)) {
      try {
        await rename(backupPath, targetPath);
        return { path: targetPath, snapshotExisted: true, outcome: "repaired", backupPath };
      } catch (cause) {
        rollbackErrors.push(
          `target restore from backup failed for ${targetPath}: ${messageOf(cause)}; backup kept at ${backupPath}`,
        );
        return {
          path: targetPath,
          snapshotExisted: true,
          outcome: "mismatch",
          detail: "previous content stayed in backup",
          backupPath,
        };
      }
    }
    rollbackErrors.push(`target directory vanished during rollback: ${targetPath}`);
    return {
      path: targetPath,
      snapshotExisted: true,
      outcome: "mismatch",
      detail: "previous content is not recoverable from backup",
    };
  }

  // 双方都存在：内容清单核对（快照 truncated 时只核对「目录仍在」，不做逐项对比）。
  if (snapshot.inventoryTruncated) {
    return { path: targetPath, snapshotExisted: true, outcome: "restored" };
  }
  const current = await snapshotDirectory(targetPath);
  const sameInventory =
    !current.inventoryTruncated &&
    current.inventory.length === snapshot.inventory.length &&
    current.inventory.every((item, index) => item === snapshot.inventory[index]);
  if (sameInventory) {
    return { path: targetPath, snapshotExisted: true, outcome: "restored" };
  }
  const detail = existsSync(backupPath)
    ? "content differs from snapshot; previous content kept in backup"
    : "content differs from snapshot and no backup is available";
  rollbackErrors.push(`target content mismatch after rollback: ${targetPath} (${detail})`);
  return {
    path: targetPath,
    snapshotExisted: true,
    outcome: "mismatch",
    detail,
    ...(existsSync(backupPath) ? { backupPath } : {}),
  };
}

function require_basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/**
 * 从 target 的父目录向上逐级删除空目录，到 stopAt（storageRoot）为止。
 * 只删「当前为空」的目录：rmdir 对非空目录抛错即天然终止，不会误删快照外有内容的目录。
 */
async function pruneEmptyParentChain(startDir: string, stopAt: string): Promise<void> {
  const stop = resolveBoundary(stopAt);
  let current = resolveBoundary(startDir);
  while (current.length > stop.length && current.startsWith(stop)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    const parent = resolveBoundary(dirname(current));
    if (parent === current) return;
    current = parent;
  }
}

function resolveBoundary(path: string): string {
  // Windows 大小写与分隔符差异归一，保证前缀比较与循环终止可靠。
  return path.replace(/[\\/]+/gu, "/").replace(/\/$/u, "").toLowerCase();
}

function rethrowAugmented(error: unknown, note: string): never {
  const message = messageOf(error);
  const augmented = new Error(`${message}; ${note}`, { cause: error });
  augmented.name = error instanceof Error ? error.name : "Error";
  throw augmented;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
