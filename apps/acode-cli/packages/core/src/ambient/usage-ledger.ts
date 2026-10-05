// 机制参照 jcode (MIT)：crates/jcode-app-core/src/ambient/persistence.rs 的 UsageLog
// （滚动 24h 磁盘日志、每 10 条落盘），自撰 TypeScript 实现
// （apps/acode-cli/specs/ambient-budget-scheduler.md R1 前置子项）。
//
// 形态对齐 K1 R8 账本：追加写 JSONL、无凭据无内容只有计数、启动裁剪旧段。
// 失败语义 fail-closed：读失败（损坏）→ 查询全部按最保守值（用户速率=无穷大 →
// ambient 不跑）——宁可不振醒，不可吃配额。
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  USAGE_LEDGER_FLUSH_EVERY,
  USAGE_LEDGER_MAX_PENDING_LINES,
  USAGE_LEDGER_TRIM_REWRITE_THRESHOLD,
  USAGE_LEDGER_WINDOW_MS,
} from "./constants.js";
import type { AmbientUsageKind } from "./session-kind.js";

export interface AmbientUsageRecord {
  /** epoch ms。 */
  ts: number;
  tokensIn: number;
  tokensOut: number;
  /** 产生用量的任务标识；turn 计量点传 sessionId（会话即任务的容器）。 */
  taskId: string;
  kind: AmbientUsageKind;
}

export interface AmbientUsageLedgerDeps {
  /** 数据根目录（services paths.getACodeDataRootDir 的值）；账本落在 `<root>/cli/ambient/`。 */
  dataRootDir: string;
  now?(): number;
  warn?(message: string, details?: Record<string, unknown>): void;
}

/**
 * core 不依赖 @acode/services，无法直接引用 getACodeDataRootDir；这里镜像
 * services/src/paths.ts 的 getDataBaseDir 优先级（setDataBaseDir 进程内覆盖是
 * services 实例私有状态，core 侧无法读它，只能退到 env > HOME > homedir）。
 * bootstrap/测试应显式传 dataRootDir，本默认值只是兜底。
 */
export function defaultAmbientDataRootDir(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.ACODE_DATA_BASE_DIR?.trim() || env.HOME?.trim() || homedir();
  return join(base, ".acode");
}

export function ambientDirPath(dataRootDir: string): string {
  return join(dataRootDir, "cli", "ambient");
}

export function usageLedgerPath(dataRootDir: string): string {
  return join(ambientDirPath(dataRootDir), "usage.jsonl");
}

interface ParsedLine {
  ts: number;
  tokensIn: number;
  tokensOut: number;
  taskId: string;
  kind: AmbientUsageKind;
}

/**
 * usage 滚动账本（R1）。
 *
 * 内存是唯一读源：append 即刻进内存（查询永远含未落盘缓冲），每
 * USAGE_LEDGER_FLUSH_EVERY 条 appendFile 落盘一次；启动（或首次使用前）调
 * loadAndTrim 做 24h 裁剪。损坏语义是**整本作废**而不是跳坏行：部分跳行会让
 * 「1h 速率」偏小（少算用户消耗），方向上更激进——宁可整本按保守值处理。
 * 唯一例外（F7，批次C）：无换行结尾的半截尾行按多写方追加写的天然中间态丢弃，
 * 不判 corrupted——半截读永久停跑比丢一行更伤。
 */
export class AmbientUsageLedger {
  private readonly deps: AmbientUsageLedgerDeps;
  private records: AmbientUsageRecord[] = [];
  private pendingLines: string[] = [];
  private loaded = false;
  private corrupted = false;
  private corruptedWarned = false;

  constructor(deps: AmbientUsageLedgerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private warn(message: string, details?: Record<string, unknown>): void {
    this.deps.warn?.(message, details);
  }

  private get filePath(): string {
    return usageLedgerPath(this.deps.dataRootDir);
  }

  /** 追加一条用量记录（缓冲写；每 N 条触发落盘）。永不抛错——旁路写不能阻断 turn。 */
  async append(record: AmbientUsageRecord): Promise<void> {
    try {
      await this.ensureLoaded();
      this.records.push(record);
      this.pendingLines.push(JSON.stringify(record));
      if (this.pendingLines.length >= USAGE_LEDGER_FLUSH_EVERY) {
        await this.flush();
      }
    } catch (error) {
      // 账本写失败只 warn：观测/预算数据缺失的代价由 fail-closed 查询兜住，
      // 不能反噬 turn 主路径（与 usage-observability 的旁路保护哲学一致）。
      this.warn("Ambient usage ledger append failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 把缓冲行落到磁盘（dispose/关停路径显式调用）。
   * F8（批次C）：失败把行回填 pendingLines 头部 + warn（下次 flush 重试），并成为
   * 全函数（不再向上抛错——dispose 路径调用它，抛错会打断 app 关停）。有界：回填后
   * 仍超 USAGE_LEDGER_MAX_PENDING_LINES 才丢最旧（防持续失败下内存无界增长）。
   */
  async flush(): Promise<void> {
    if (this.pendingLines.length === 0) return;
    const lines = this.pendingLines;
    this.pendingLines = [];
    try {
      await mkdir(ambientDirPath(this.deps.dataRootDir), { recursive: true });
      await appendFile(this.filePath, lines.map((line) => `${line}\n`).join(""), "utf8");
    } catch (error) {
      this.pendingLines = [...lines, ...this.pendingLines];
      const overflow = this.pendingLines.length - USAGE_LEDGER_MAX_PENDING_LINES;
      if (overflow > 0) {
        this.pendingLines = this.pendingLines.slice(overflow);
      }
      this.warn("Ambient usage ledger flush failed; buffered lines re-queued for retry", {
        errorMessage: error instanceof Error ? error.message : String(error),
        lineCount: lines.length,
        overflowDropped: Math.max(0, overflow),
      });
    }
  }

  /**
   * 启动裁剪：加载全量、丢弃 24h 窗口外的旧段、（条件满足时）重写文件（R1 滚动语义）。
   * F7（批次C）：重写窗口缩小——仅当裁剪量占行数比例 > USAGE_LEDGER_TRIM_REWRITE_THRESHOLD
   * 才重写；小裁剪只改内存（多进程并发下全量重写会截掉他进程刚 append 的行，缩小窗口）。
   */
  async loadAndTrim(): Promise<void> {
    const nowMs = this.now();
    const loaded = await this.readAll();
    this.loaded = true;
    if (this.corrupted) {
      // 损坏时不重写文件：保留现场供排查（fail-closed 只作用在内存查询语义上），
      // 且覆盖写会把「损坏证据」抹成空文件，下一次启动又当空账本静默通过。
      this.records = [];
      return;
    }
    const trimmed = loaded.filter((record) => nowMs - record.ts < USAGE_LEDGER_WINDOW_MS);
    this.records = trimmed;
    const dropped = loaded.length - trimmed.length;
    if (dropped === 0 || dropped <= loaded.length * USAGE_LEDGER_TRIM_REWRITE_THRESHOLD) {
      // F7：小裁剪不重写（内存已正确；磁盘旧段下次大裁剪或滚过窗口再收）。
      return;
    }
    await mkdir(ambientDirPath(this.deps.dataRootDir), { recursive: true });
    await writeFile(
      this.filePath,
      trimmed.length === 0 ? "" : `${trimmed.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    // 首次使用即裁剪（等价「启动时裁剪」——共享实例由 turn 旁路写惰性创建，
    // 装配层不必显式调用 loadAndTrim；显式调用仍然幂等安全）。
    await this.loadAndTrim();
  }

  private async readAll(): Promise<AmbientUsageRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      // 缺失文件 = 空账本（正常首启），不是失败；损坏才 fail-closed。
      return [];
    }
    const lines = raw.split("\n");
    // F7（批次C）：半截尾行宽容——追加写的天然中间态是「尾段无换行符且 JSON 不完整」
    //（本账本写方永远以 \n 收行，完整文件必以 \n 结尾）。丢弃该行不判 corrupted；
    // 文件以 \n 结尾时任何坏行都是真损坏，fail-closed 语义不变。
    let tornTail = "";
    if (!raw.endsWith("\n") && lines.length > 0) {
      tornTail = lines.pop() ?? "";
    }
    const parsed: AmbientUsageRecord[] = [];
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      const candidate = parseRecordLine(line);
      if (!candidate) {
        this.corrupted = true;
        if (!this.corruptedWarned) {
          this.corruptedWarned = true;
          this.warn("Ambient usage ledger is corrupted; treating as unreadable (fail-closed)", {
            path: this.filePath,
          });
        }
        return [];
      }
      parsed.push(candidate);
    }
    if (tornTail.trim().length > 0) {
      const candidate = parseRecordLine(tornTail);
      if (candidate) {
        parsed.push(candidate); // 尾段恰好完整（写方写了一半但 JSON 已闭合）：保留。
      } else {
        this.warn("Ambient usage ledger has a torn tail line; dropping it (multi-writer mid-state)", {
          path: this.filePath,
        });
      }
    }
    return parsed;
  }

  /**
   * 用户 1h 滚动速率（tokens/hour），排除 ambient kind（R1——ambient 自身消耗
   * 不占用户速率）。损坏 → Infinity（最保守：ambient 不跑）。
   */
  getHourlyRate(nowMs: number): number {
    if (this.corrupted) return Number.POSITIVE_INFINITY;
    const windowStart = nowMs - 60 * 60_000;
    let total = 0;
    for (const record of this.records) {
      if (record.kind !== "user") continue;
      if (record.ts < windowStart || record.ts > nowMs) continue;
      total += record.tokensIn + record.tokensOut;
    }
    return total;
  }

  /**
   * 近 n 个 ambient cycle 的平均消耗（tokens/cycle）；无历史或损坏 → null，
   * 调用方按 AMBIENT_CYCLE_TOKEN_FALLBACK 保守处理。
   */
  getRecentCycles(n: number): number | null {
    if (this.corrupted) return null;
    const cycles = this.records.filter((record) => record.kind === "ambient");
    if (cycles.length === 0) return null;
    const recent = cycles.slice(-n);
    const total = recent.reduce((sum, record) => sum + record.tokensIn + record.tokensOut, 0);
    return total / recent.length;
  }

  /** 测试/观测面：当前内存视图。 */
  getRecords(): readonly AmbientUsageRecord[] {
    return this.records;
  }

  /** 损坏标记（测试断言 fail-closed 状态用）。 */
  isCorrupted(): boolean {
    return this.corrupted;
  }

  /** 测试/观测面：flush 失败回填后的待落盘行数（F8 有界断言用）。 */
  getPendingLineCount(): number {
    return this.pendingLines.length;
  }
}

function parseRecordLine(line: string): AmbientUsageRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<ParsedLine>;
  if (
    typeof candidate.ts !== "number" ||
    !Number.isFinite(candidate.ts) ||
    typeof candidate.tokensIn !== "number" ||
    typeof candidate.tokensOut !== "number" ||
    typeof candidate.taskId !== "string" ||
    (candidate.kind !== "user" && candidate.kind !== "ambient")
  ) {
    return null;
  }
  return {
    ts: candidate.ts,
    tokensIn: candidate.tokensIn,
    tokensOut: candidate.tokensOut,
    taskId: candidate.taskId,
    kind: candidate.kind,
  };
}

// ---------------------------------------------------------------------------
// 进程内共享实例：turn 计量旁路写的写入点（单一 ledger 实例，避免多个缓冲写面
// 各自计数导致落盘交错）。setSharedAmbientUsageLedger 是 bootstrap/测试的注入缝
// （真实装配可传 workspace 感知的数据根；缺省走 defaultAmbientDataRootDir）。
// ---------------------------------------------------------------------------

let sharedLedger: AmbientUsageLedger | null = null;

export function getSharedAmbientUsageLedger(): AmbientUsageLedger {
  if (!sharedLedger) {
    sharedLedger = new AmbientUsageLedger({ dataRootDir: defaultAmbientDataRootDir() });
  }
  return sharedLedger;
}

export function setSharedAmbientUsageLedger(ledger: AmbientUsageLedger | null): void {
  sharedLedger = ledger;
}
