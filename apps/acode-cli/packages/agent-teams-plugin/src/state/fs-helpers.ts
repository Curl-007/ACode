import { existsSync, readdirSync, readFileSync } from "node:fs";
import { TeamError } from "./types.js";

/**
 * store.ts 的模块级文件系统辅助（架构 ratchet 400 行上限的最小抽取，
 * 行为与拆分前逐字节一致）。锁文件、目录计数与目录名清洗的唯一实现点。
 */

export const TEAM_LOCK_STALE_MS = 5_000;

export function readLockInfo(lockPath: string): { pid: number; at: number } | undefined {
  try {
    if (!existsSync(lockPath)) return undefined;
    const raw = readFileSync(lockPath, "utf8").trim().split(/\s+/u);
    const pid = Number.parseInt(raw[0] ?? "", 10);
    const at = raw[1] ? Date.parse(raw[1]) : NaN;
    if (!Number.isFinite(pid)) return undefined;
    return { pid, at: Number.isFinite(at) ? at : 0 };
  } catch {
    return undefined;
  }
}

export function countJsonFiles(dir: string): number {
  try {
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** 归档目录名与 mailbox 目录名不得逃逸 state root。 */
export function sanitizeMailboxDir(address: string): string {
  const safe = address.replace(/[^a-z0-9-]/giu, "").toLowerCase();
  if (!safe) throw new TeamError("invalid_input", `Invalid mailbox address: ${address}`);
  return safe;
}

export function sanitizeTeamId(teamId: string): string {
  const safe = teamId.replace(/[^a-z0-9-]/giu, "");
  if (!safe) throw new TeamError("invalid_input", `Invalid team id: ${teamId}`);
  return safe;
}
