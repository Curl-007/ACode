import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  defaultSessionWorktreeDataRoot,
  sessionWorktreeLedgerPath,
} from "./session-worktree-paths.js";

/**
 * 会话↔worktree 映射台账（specs/session-worktree-lifecycle.md R3）。
 *
 * 形态：**追加式 JSONL**（先例 core/src/ambient/usage-ledger.ts）。选追加式而非单
 * JSON 文档的理由：桌面 host 一进程多会话、CLI 多进程可并发绑定，读-改-写文档会
 * 互相覆盖丢条目；追加行 + 读时折叠天然多写方安全（appendFile O_APPEND，单行短）。
 *
 * tombstone 语义（spec R3/R6）：worktree 目录被收割/丢失后，条目不删除而是转为
 * tombstone——**保留 branch 映射**供会话重开时重挂（材料在分支 tip 上），台账绝不
 * 触碰会话/对话数据（那在别处，不归本台账管）。
 *
 * 损坏语义与 ambient usage-ledger 刻意不同：那里「整本作废」（速率查询宁保守），
 * 这里**逐行跳过坏行**——丢一条绑定只影响该会话的重挂便利（enter 会新建），整本
 * 作废则会让收割面看不见所有历史绑定，方向上更危险。
 */

export type SessionWorktreeTombstoneReason = "reaped" | "worktree-missing" | "released";

export interface SessionWorktreeBindEvent {
  v: 1;
  event: "bind";
  sessionId: string;
  repoFingerprint: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  sourceBranch?: string;
  at: number;
}

export interface SessionWorktreeTouchEvent {
  v: 1;
  event: "touch";
  sessionId: string;
  repoFingerprint: string;
  at: number;
}

export interface SessionWorktreeTombstoneEvent {
  v: 1;
  event: "tombstone";
  sessionId: string;
  repoFingerprint: string;
  reason: SessionWorktreeTombstoneReason;
  at: number;
}

export type SessionWorktreeLedgerEvent =
  | SessionWorktreeBindEvent
  | SessionWorktreeTouchEvent
  | SessionWorktreeTombstoneEvent;

export interface SessionWorktreeBinding {
  sessionId: string;
  repoFingerprint: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  sourceBranch?: string;
  createdAt: number;
  lastUsedAt: number;
  state: "active" | "tombstone";
  tombstoneReason?: SessionWorktreeTombstoneReason;
  tombstonedAt?: number;
}

export interface SessionWorktreeLedgerDeps {
  /** 数据根（services paths.getACodeDataRootDir 的值）；缺省按 env 兜底解析（spec R3）。 */
  dataRootDir?: string;
  /** 直接指定台账文件（测试注入优先于 dataRootDir）。 */
  filePath?: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export interface SessionWorktreeFoldResult {
  bindings: Map<string, SessionWorktreeBinding>;
  lineCount: number;
  skippedLines: number;
}

export function sessionWorktreeBindingKey(sessionId: string, fingerprint: string): string {
  return `${sessionId}\u0000${fingerprint}`;
}

/** 纯函数折叠：事件序 → 每 (sessionId, repoFingerprint) 一条绑定。坏行跳过并计数。 */
export function foldSessionWorktreeEvents(text: string): SessionWorktreeFoldResult {
  const bindings = new Map<string, SessionWorktreeBinding>();
  let lineCount = 0;
  let skippedLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    lineCount += 1;
    let event: SessionWorktreeLedgerEvent;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isLedgerEvent(parsed)) {
        skippedLines += 1;
        continue;
      }
      event = parsed;
    } catch {
      skippedLines += 1;
      continue;
    }
    const key = sessionWorktreeBindingKey(event.sessionId, event.repoFingerprint);
    if (event.event === "bind") {
      bindings.set(key, {
        sessionId: event.sessionId,
        repoFingerprint: event.repoFingerprint,
        repoRoot: event.repoRoot,
        worktreePath: event.worktreePath,
        branch: event.branch,
        baseRef: event.baseRef,
        ...(event.sourceBranch === undefined ? {} : { sourceBranch: event.sourceBranch }),
        createdAt: event.at,
        lastUsedAt: event.at,
        state: "active",
      });
      continue;
    }
    const existing = bindings.get(key);
    if (event.event === "touch") {
      // touch 只推进 lastUsedAt；对未知键的 touch（台账被压实过/外部截断）忽略。
      if (existing) {
        existing.lastUsedAt = Math.max(existing.lastUsedAt, event.at);
      }
      continue;
    }
    if (existing) {
      existing.state = "tombstone";
      existing.tombstoneReason = event.reason;
      existing.tombstonedAt = event.at;
      existing.lastUsedAt = Math.max(existing.lastUsedAt, event.at);
    } else {
      // tombstone 先于 bind 到场（异常序）：记一个只有身份的墓碑，保证「收过」可见。
      bindings.set(key, {
        sessionId: event.sessionId,
        repoFingerprint: event.repoFingerprint,
        repoRoot: "",
        worktreePath: "",
        branch: "",
        baseRef: "",
        createdAt: event.at,
        lastUsedAt: event.at,
        state: "tombstone",
        tombstoneReason: event.reason,
        tombstonedAt: event.at,
      });
    }
  }
  return { bindings, lineCount, skippedLines };
}

function isLedgerEvent(value: unknown): value is SessionWorktreeLedgerEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.v !== 1) return false;
  if (typeof candidate.sessionId !== "string" || candidate.sessionId === "") return false;
  if (typeof candidate.repoFingerprint !== "string") return false;
  if (typeof candidate.at !== "number") return false;
  return (
    candidate.event === "bind" || candidate.event === "touch" || candidate.event === "tombstone"
  );
}

/** 机会式压实阈值：行数 > 4×键数 + 64 时读后重写（spec R3，best-effort）。 */
export const SESSION_WORKTREE_LEDGER_COMPACT_THRESHOLD_LINES = 64;
export const SESSION_WORKTREE_LEDGER_COMPACT_FACTOR = 4;

export class SessionWorktreeLedger {
  readonly #filePath: string;
  readonly #now: () => number;
  /** 进程内压实互斥：并发 load 只允许一个在飞压实。 */
  #compacting: Promise<void> = Promise.resolve();

  constructor(deps: SessionWorktreeLedgerDeps = {}) {
    const dataRoot = deps.dataRootDir ?? defaultSessionWorktreeDataRoot(deps.env);
    this.#filePath = deps.filePath ?? sessionWorktreeLedgerPath(dataRoot);
    this.#now = deps.now ?? Date.now;
  }

  get filePath(): string {
    return this.#filePath;
  }

  async append(event: SessionWorktreeLedgerEvent): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await appendFile(this.#filePath, `${JSON.stringify(event)}\n`, "utf-8");
  }

  async bind(input: {
    sessionId: string;
    repoFingerprint: string;
    repoRoot: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
    sourceBranch?: string;
  }): Promise<void> {
    await this.append({
      v: 1,
      event: "bind",
      ...input,
      ...(input.sourceBranch === undefined ? {} : { sourceBranch: input.sourceBranch }),
      at: this.#now(),
    });
  }

  async touch(sessionId: string, repoFingerprintInput: string): Promise<void> {
    await this.append({
      v: 1,
      event: "touch",
      sessionId,
      repoFingerprint: repoFingerprintInput,
      at: this.#now(),
    });
  }

  async tombstone(
    sessionId: string,
    repoFingerprintInput: string,
    reason: SessionWorktreeTombstoneReason,
  ): Promise<void> {
    await this.append({
      v: 1,
      event: "tombstone",
      sessionId,
      repoFingerprint: repoFingerprintInput,
      reason,
      at: this.#now(),
    });
  }

  /** 读取并折叠；顺带机会式压实（失败不影响读结果）。 */
  async load(): Promise<SessionWorktreeBinding[]> {
    let text: string;
    try {
      text = await readFile(this.#filePath, "utf-8");
    } catch {
      return []; // 台账不存在 = 还没有任何绑定。
    }
    const folded = foldSessionWorktreeEvents(text);
    const threshold =
      SESSION_WORKTREE_LEDGER_COMPACT_FACTOR * folded.bindings.size +
      SESSION_WORKTREE_LEDGER_COMPACT_THRESHOLD_LINES;
    if (folded.lineCount > threshold) {
      this.#compacting = this.#compacting.then(() => this.#compact(folded)).catch(() => undefined);
    }
    return Array.from(folded.bindings.values());
  }

  async #compact(folded: SessionWorktreeFoldResult): Promise<void> {
    // 压实 = 把折叠终态重写为一行一绑定（active 重写为 bind，tombstone 保留终态）。
    // temp + rename 原子替换；并发追加的窗口损失由「压实只在读后触发、行数远超键数」
    // 兜住——丢的至多是压缩窗口内的心跳（touch），bind/tombstone 终态在折叠里。
    const lines: string[] = [];
    for (const binding of folded.bindings.values()) {
      if (binding.state === "tombstone") {
        lines.push(
          JSON.stringify({
            v: 1,
            event: "tombstone",
            sessionId: binding.sessionId,
            repoFingerprint: binding.repoFingerprint,
            reason: binding.tombstoneReason ?? "released",
            at: binding.tombstonedAt ?? binding.lastUsedAt,
          } satisfies SessionWorktreeTombstoneEvent),
        );
        continue;
      }
      lines.push(
        JSON.stringify({
          v: 1,
          event: "bind",
          sessionId: binding.sessionId,
          repoFingerprint: binding.repoFingerprint,
          repoRoot: binding.repoRoot,
          worktreePath: binding.worktreePath,
          branch: binding.branch,
          baseRef: binding.baseRef,
          ...(binding.sourceBranch === undefined ? {} : { sourceBranch: binding.sourceBranch }),
          at: binding.createdAt,
        } satisfies SessionWorktreeBindEvent),
      );
      if (binding.lastUsedAt > binding.createdAt) {
        lines.push(
          JSON.stringify({
            v: 1,
            event: "touch",
            sessionId: binding.sessionId,
            repoFingerprint: binding.repoFingerprint,
            at: binding.lastUsedAt,
          } satisfies SessionWorktreeTouchEvent),
        );
      }
    }
    const tempPath = `${this.#filePath}.${process.pid}.compact.tmp`;
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(tempPath, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf-8");
    await rename(tempPath, this.#filePath);
  }
}
