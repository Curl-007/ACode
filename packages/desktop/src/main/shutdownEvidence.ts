// 退出证据链（specs/shutdown-keepawake-containment.md R4/R5）：
// - 关停各阶段把 {completed, timed_out, watchdog_fired, pending_handlers, ts, stage}
//   持久化到 userData 下的 JSON（temp+rename 原子写）。
// - 下次启动读回并消费（读后即删），派生 previous_quit_clean 供启动异常关联归因。
// - stage=boot 打点让「进程被强杀/崩溃」也留下非干净证据，消除读到更早一次
//   干净记录的误归因。
//
// 写盘使用同步 IO：这是退出路径，异步写在 app.exit(0) 竞态下不保证落盘；载荷 <1KB，
// 属于 spec R4 登记的「异步 IO」纪律例外。读回（启动期）仍为异步。
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";

export const SHUTDOWN_EVIDENCE_FILE_NAME = "last-shutdown-evidence.json";
/** 关停任务名单项的封闭字符集：进日志、进证据文件，禁止空白与控制字符。 */
export const SHUTDOWN_HANDLER_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const APP_VERSION_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:[-+][0-9A-Za-z.+-]{1,32})?$/;
const MAX_PENDING_HANDLERS = 100;

export type ShutdownEvidenceStage = "boot" | "cleanup-start" | "final" | "watchdog";

export interface ShutdownEvidenceRecord {
  completed: boolean;
  cleanup_ms: number | null;
  handler_count: number;
  slowest_handler: string | null;
  slowest_ms: number | null;
  timed_out: boolean;
  pending_handlers: string[];
  watchdog_fired: boolean;
  for_update: boolean;
  quit_app_version: string;
  quit_epoch_ms: number;
  /** 记录落盘时刻（墙钟）。 */
  ts: number;
  stage: ShutdownEvidenceStage;
}

export interface ShutdownEvidenceLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** 同步 fs 面，测试可整体注入内存实现。 */
export interface ShutdownEvidenceSyncFs {
  writeFileSync: (path: string, data: string, encoding: "utf8") => void;
  renameSync: (from: string, to: string) => void;
}

export interface ShutdownCleanupSummaryInput {
  handlerNames: string[];
  durationsMs: Map<string, number>;
  elapsedMs: number;
  pendingAtAbort: string[] | null;
}

export interface ShutdownCleanupSummary {
  cleanup_ms: number;
  handler_count: number;
  slowest_handler: string | null;
  slowest_ms: number | null;
  timed_out: boolean;
  pending_handlers: string[];
}

/** 汇总逐 handler 记账：abort 快照里的名字即使后来补上时长也不算 slowest。 */
export function summarizeShutdownCleanup(
  input: ShutdownCleanupSummaryInput,
): ShutdownCleanupSummary {
  const pending = new Set(input.pendingAtAbort ?? []);
  let slowestHandler: string | null = null;
  let slowestMs: number | null = null;
  for (const [name, durationMs] of input.durationsMs) {
    if (pending.has(name)) {
      continue;
    }
    if (slowestMs === null || durationMs > slowestMs) {
      slowestHandler = name;
      slowestMs = Math.round(durationMs);
    }
  }
  return {
    cleanup_ms: Math.round(input.elapsedMs),
    handler_count: input.handlerNames.length,
    slowest_handler: slowestHandler,
    slowest_ms: slowestMs,
    timed_out: input.pendingAtAbort !== null,
    pending_handlers: input.pendingAtAbort
      ? input.pendingAtAbort.slice(0, MAX_PENDING_HANDLERS)
      : [],
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseHandlerName(value: unknown): string | null {
  return typeof value === "string" && SHUTDOWN_HANDLER_NAME_PATTERN.test(value) ? value : null;
}

const KNOWN_STAGES = ["boot", "cleanup-start", "final", "watchdog"] as const;

/** 读回校验：任何字段不合法整条判 null（fail-closed），不做部分修复。 */
export function parseShutdownEvidenceRecord(value: unknown): ShutdownEvidenceRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const handlerCount = isFiniteNumber(raw.handler_count) ? raw.handler_count : null;
  const quitEpochMs = isFiniteNumber(raw.quit_epoch_ms) ? raw.quit_epoch_ms : null;
  const ts = isFiniteNumber(raw.ts) ? raw.ts : null;
  const cleanupMs =
    raw.cleanup_ms === null ? null : isFiniteNumber(raw.cleanup_ms) ? raw.cleanup_ms : undefined;
  if (
    typeof raw.completed !== "boolean" ||
    handlerCount === null ||
    quitEpochMs === null ||
    ts === null ||
    cleanupMs === undefined ||
    (raw.completed && cleanupMs === null) ||
    typeof raw.timed_out !== "boolean" ||
    typeof raw.watchdog_fired !== "boolean" ||
    typeof raw.for_update !== "boolean" ||
    typeof raw.quit_app_version !== "string" ||
    !APP_VERSION_PATTERN.test(raw.quit_app_version) ||
    !Array.isArray(raw.pending_handlers) ||
    typeof raw.stage !== "string" ||
    !(KNOWN_STAGES as readonly string[]).includes(raw.stage)
  ) {
    return null;
  }
  const pendingHandlers: string[] = [];
  for (const entry of raw.pending_handlers) {
    const name = parseHandlerName(entry);
    if (name === null) {
      return null;
    }
    pendingHandlers.push(name);
  }
  const slowestHandler =
    raw.slowest_handler === null ? null : parseHandlerName(raw.slowest_handler);
  const slowestMs =
    raw.slowest_ms === null ? null : isFiniteNumber(raw.slowest_ms) ? raw.slowest_ms : undefined;
  if (slowestMs === undefined) {
    return null;
  }
  // slowest_handler / slowest_ms 必须同时在场或同时缺席。
  if ((slowestHandler === null) !== (slowestMs === null)) {
    return null;
  }
  return {
    completed: raw.completed,
    cleanup_ms: cleanupMs,
    handler_count: handlerCount,
    slowest_handler: slowestHandler,
    slowest_ms: slowestMs,
    timed_out: raw.timed_out,
    pending_handlers: pendingHandlers.slice(0, MAX_PENDING_HANDLERS),
    watchdog_fired: raw.watchdog_fired,
    for_update: raw.for_update,
    quit_app_version: raw.quit_app_version,
    quit_epoch_ms: quitEpochMs,
    ts,
    stage: raw.stage as ShutdownEvidenceStage,
  };
}

/** previous_quit_clean 三态：true 干净 / false 非干净 / null 无记录（首启或损坏）。 */
export function previousQuitClean(record: ShutdownEvidenceRecord | null): boolean | null {
  if (record === null) {
    return null;
  }
  return record.completed && !record.timed_out && !record.watchdog_fired;
}

export interface ShutdownEvidenceStore {
  /** 启动打点：本次运行先留下 completed:false 记录，强杀/崩溃时即为证据。 */
  recordBoot(meta: { appVersion: string; epochMs: number }): void;
  /** runShutdown 开始：handler 名单先落盘，进程中途死亡也能看到 attempted 名单。 */
  recordCleanupStart(meta: {
    handlerNames: string[];
    forUpdate: boolean;
    appVersion: string;
    startedEpochMs: number;
  }): void;
  /** runShutdown 收口：合并逐 handler 记账与 abort 快照，写 final 记录。 */
  recordCleanupFinished(
    meta: {
      forUpdate: boolean;
      appVersion: string;
      startedEpochMs: number;
    } & ShutdownCleanupSummaryInput,
  ): ShutdownEvidenceRecord;
  /** 看门狗触发：把当前记录改写为 watchdog_fired=true, stage=watchdog。 */
  markWatchdogFired(epochMs: number): void;
  getCurrent(): ShutdownEvidenceRecord | null;
}

export function createShutdownEvidenceStore(deps: {
  filePath: string;
  logger: ShutdownEvidenceLogger;
  fs?: Partial<ShutdownEvidenceSyncFs>;
  wallNow?: () => number;
}): ShutdownEvidenceStore {
  const writeFileSyncFn = deps.fs?.writeFileSync ?? writeFileSync;
  const renameSyncFn = deps.fs?.renameSync ?? renameSync;
  const wallNow = deps.wallNow ?? Date.now;
  let current: ShutdownEvidenceRecord | null = null;

  function persist(record: ShutdownEvidenceRecord): void {
    current = record;
    const payload = JSON.stringify(record);
    const tempPath = `${deps.filePath}.${process.pid}.tmp`;
    try {
      writeFileSyncFn(tempPath, payload, "utf8");
      try {
        renameSyncFn(tempPath, deps.filePath);
      } catch {
        // rename 被杀软/备份工具短暂锁住时退化为直写：证据尽力落盘优先于原子性。
        writeFileSyncFn(deps.filePath, payload, "utf8");
        try {
          rmSync(tempPath, { force: true });
        } catch {
          // 残留 temp 文件无害，下次写会覆盖同名 temp。
        }
      }
    } catch (error) {
      // 证据写失败不能反过来阻断退出流程，只留痕。
      deps.logger.warn("[shutdown-evidence] failed to persist record", {
        event: "shutdown_evidence_write_failed",
        outcome: "write_error",
        stage: record.stage,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function baseRecord(meta: { appVersion: string; epochMs: number }): ShutdownEvidenceRecord {
    return {
      completed: false,
      cleanup_ms: null,
      handler_count: 0,
      slowest_handler: null,
      slowest_ms: null,
      timed_out: false,
      pending_handlers: [],
      watchdog_fired: false,
      for_update: false,
      quit_app_version: meta.appVersion,
      quit_epoch_ms: meta.epochMs,
      ts: wallNow(),
      stage: "boot",
    };
  }

  return {
    recordBoot(meta) {
      persist(baseRecord(meta));
    },
    recordCleanupStart(meta) {
      persist({
        ...baseRecord({ appVersion: meta.appVersion, epochMs: meta.startedEpochMs }),
        handler_count: meta.handlerNames.length,
        pending_handlers: [],
        for_update: meta.forUpdate,
        stage: "cleanup-start",
      });
    },
    recordCleanupFinished(meta) {
      const summary = summarizeShutdownCleanup(meta);
      const record: ShutdownEvidenceRecord = {
        ...baseRecord({ appVersion: meta.appVersion, epochMs: meta.startedEpochMs }),
        completed: true,
        for_update: meta.forUpdate,
        stage: "final",
        ...summary,
      };
      persist(record);
      return record;
    },
    markWatchdogFired(epochMs) {
      if (current === null) {
        // 看门狗只由 runShutdown arm，正常不会没有当前记录；防御性留痕。
        deps.logger.warn("[shutdown-evidence] watchdog fired without an active record", {
          event: "shutdown_evidence_watchdog_orphan",
          outcome: "no_active_record",
        });
        return;
      }
      persist({ ...current, watchdog_fired: true, stage: "watchdog", ts: epochMs });
    },
    getCurrent() {
      return current;
    },
  };
}

export interface PreviousShutdownEvidence {
  record: ShutdownEvidenceRecord;
  previousQuitClean: boolean;
}

/** 启动期读回并消费（读后即删）；缺失/损坏/读失败一律 null，不影响启动。 */
export async function loadPreviousShutdownEvidence(deps: {
  filePath: string;
  logger: ShutdownEvidenceLogger;
}): Promise<PreviousShutdownEvidence | null> {
  let raw: string;
  try {
    raw = await readFile(deps.filePath, "utf8");
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "ENOENT") {
      deps.logger.warn("[shutdown-evidence] previous record unreadable", {
        event: "shutdown_evidence_read_failed",
        outcome: "read_error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
  // 消费语义：读后即删，避免同一条记录被多次启动重复归因。
  try {
    await rm(deps.filePath, { force: true });
  } catch (error) {
    deps.logger.warn("[shutdown-evidence] previous record could not be consumed", {
      event: "shutdown_evidence_consume_failed",
      outcome: "rm_error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    deps.logger.warn("[shutdown-evidence] ignoring malformed previous record (invalid json)", {
      event: "shutdown_evidence_malformed",
      outcome: "invalid_json",
    });
    return null;
  }
  const record = parseShutdownEvidenceRecord(parsed);
  if (record === null) {
    deps.logger.warn("[shutdown-evidence] ignoring malformed previous record (schema)", {
      event: "shutdown_evidence_malformed",
      outcome: "schema_mismatch",
    });
    return null;
  }
  return { record, previousQuitClean: previousQuitClean(record) === true };
}

let previousEvidenceCache: PreviousShutdownEvidence | null | undefined;

/**
 * 唯一初始化入口：读回上一条记录 → 消费 → 为本次运行打 boot 点。
 * 顺序内聚在单函数里，避免接线侧先写后读造成证据被覆盖。
 */
export async function initializeShutdownEvidence(deps: {
  filePath: string;
  logger: ShutdownEvidenceLogger;
  appVersion: string;
  fs?: Partial<ShutdownEvidenceSyncFs>;
}): Promise<{ store: ShutdownEvidenceStore; previous: PreviousShutdownEvidence | null }> {
  const previous = await loadPreviousShutdownEvidence(deps);
  const store = createShutdownEvidenceStore(deps);
  store.recordBoot({ appVersion: deps.appVersion, epochMs: Date.now() });
  previousEvidenceCache = previous;
  if (previous !== null) {
    deps.logger.info("[shutdown-evidence] previous quit record loaded", {
      event: "shutdown_evidence_previous",
      outcome: previous.previousQuitClean ? "clean" : "unclean",
      previous_quit_clean: previous.previousQuitClean,
      stage: previous.record.stage,
      timed_out: previous.record.timed_out,
      watchdog_fired: previous.record.watchdog_fired,
      pending_handlers: previous.record.pending_handlers,
      quit_epoch_ms: previous.record.quit_epoch_ms,
    });
  }
  return { store, previous };
}

/** 只读查询接口：启动异常（登录态丢失等）关联归因用；未初始化时返回 null。 */
export function getPreviousShutdownEvidence(): PreviousShutdownEvidence | null {
  return previousEvidenceCache ?? null;
}

/** 仅供测试：清空模块级缓存，避免用例间串扰。 */
export function resetShutdownEvidenceCacheForTest(): void {
  previousEvidenceCache = undefined;
}
