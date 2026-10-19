// ============================================================
// 冲突块会话注册表（specs/conflict-uri-resolution.md R2）
// ============================================================
// Mechanism ported from oh-my-pi (MIT) packages/coding-agent/src/tools/
// conflict-detect.ts 的 ConflictHistory 语义, Copyright (c) 2025 Mario
// Zechner & Stencil Labs.
// 会话键控进程级 Map（skill-path-activation.ts 同哲学）：runtime
// beginShutdown 清理本会话；进程亡故=缓存亡故，不持久化。

import { conflictBlockFingerprint, type ConflictBlock } from "./detect.js";

export interface ConflictEntry {
  /** 会话内递增稳定 id（conflict://<id>）。 */
  id: number;
  absolutePath: string;
  block: ConflictBlock;
  fingerprint: string;
}

interface SessionHistory {
  byId: Map<number, ConflictEntry>;
  /** 指纹 → id：同块重复 read 复用 id（内容变即新指纹新 id，旧条目留到失效）。 */
  byFingerprint: Map<string, number>;
  nextId: number;
}

const histories = new Map<string, SessionHistory>();

function sessionHistory(sessionId: string): SessionHistory {
  let history = histories.get(sessionId);
  if (!history) {
    history = { byId: new Map(), byFingerprint: new Map(), nextId: 1 };
    histories.set(sessionId, history);
  }
  return history;
}

/**
 * 注册一次 read 扫出的块。同指纹（同文件同内容块）复用既有 id 并**刷新块数据**
 * （上方编辑会让行号位移，指纹不含行号所以位移仍复用）；新内容 = 新 id。
 * 返回本文件的注册结果（含复用与新建），供 read 尾注渲染。
 */
export function registerConflicts(
  sessionId: string,
  absolutePath: string,
  blocks: readonly ConflictBlock[],
): ConflictEntry[] {
  const history = sessionHistory(sessionId);
  const entries: ConflictEntry[] = [];
  for (const block of blocks) {
    const fingerprint = conflictBlockFingerprint(absolutePath, block);
    const existingId = history.byFingerprint.get(fingerprint);
    if (existingId !== undefined) {
      const existing = history.byId.get(existingId)!;
      // 刷新块数据（行号可能位移）；id 与指纹不变。
      existing.block = block;
      entries.push(existing);
      continue;
    }
    const entry: ConflictEntry = { id: history.nextId, absolutePath, block, fingerprint };
    history.nextId += 1;
    history.byId.set(entry.id, entry);
    history.byFingerprint.set(fingerprint, entry.id);
    entries.push(entry);
  }
  return entries;
}

export function getConflictEntry(sessionId: string, id: number): ConflictEntry | undefined {
  return histories.get(sessionId)?.byId.get(id);
}

/** 本会话全部有效条目（批量 conflict://* 与尾注计数用），按 id 升序。 */
export function listSessionConflicts(sessionId: string): ConflictEntry[] {
  const history = histories.get(sessionId);
  if (!history) return [];
  return [...history.byId.values()].sort((left, right) => left.id - right.id);
}

/** 某文件的条目是否仍有未解决冲突（write 成功后返回剩余计数用）。 */
export function countFileConflicts(sessionId: string, absolutePath: string): number {
  return listSessionConflicts(sessionId).filter((entry) => entry.absolutePath === absolutePath)
    .length;
}

/**
 * 失效某文件全部条目（R5：拼接成功后行号整体位移，旧锚全部作废；外部改动后
 * 重 read 会以新指纹注册新 id）。id 不复用——陈旧 conflict://<id> 写入必须
 * 显式失败而不是拼错位置。
 */
export function invalidateFileEntries(sessionId: string, absolutePath: string): void {
  const history = histories.get(sessionId);
  if (!history) return;
  for (const [id, entry] of history.byId) {
    if (entry.absolutePath === absolutePath) {
      history.byId.delete(id);
      history.byFingerprint.delete(entry.fingerprint);
    }
  }
}

/** runtime beginShutdown 清理点（agent-runtime.ts，clearSkillPathActivations 旁）。 */
export function clearConflictHistories(sessionId: string): void {
  histories.delete(sessionId);
}

/** 测试隔离面：清空全部会话（仅测试使用）。 */
export function clearAllConflictHistories(): void {
  histories.clear();
}
