// 更新交接账本的 schema 与解析面（specs/updater-journal-recovery.md R6，自
// updaterJournal.ts 拆分以满足 400 行 ratchet；存储/恢复计划面留在原文件）。
//
// Mechanism ported from oh-my-pi (MIT) packages/coding-agent/src/cli/update-cli.ts,
// Copyright (c) 2025 Mario Zechner & Stencil Labs —— omp.dist 的未知值保守兜底
// 契约：未知字段忽略、未知枚举归一 "unknown"、畸形整体降级为无账本，绝不阻断
// 更新检查。

export const UPDATE_JOURNAL_FILE_NAME = "update-journal.json";
/** journal 自身按代数上限截断（spec R5）：超出裁最旧，generation 保留原值。 */
export const UPDATE_JOURNAL_MAX_ENTRIES = 8;
export const UPDATE_JOURNAL_SCHEMA_VERSION = 1;

export type UpdateJournalOutcome =
  | "handed-off"
  | "verified"
  | "failed"
  | "install-not-effective"
  | "handoff-aborted";

export type UpdateJournalExitSweepHandoff = "pending" | "completed" | "failed" | "absent";

/** 解析面允许的全部 outcome 词面（含未来未知值的归一目标）。 */
const KNOWN_OUTCOMES: readonly UpdateJournalOutcome[] = [
  "handed-off",
  "verified",
  "failed",
  "install-not-effective",
  "handoff-aborted",
];
const KNOWN_EXIT_SWEEP_VALUES: readonly UpdateJournalExitSweepHandoff[] = [
  "pending",
  "completed",
  "failed",
  "absent",
];

export interface UpdateJournalEntry {
  generation: number;
  fromVersion: string;
  toVersion: string;
  outcome: UpdateJournalOutcome | "unknown";
  handedOffAt: number;
  exitSweepHandoff: UpdateJournalExitSweepHandoff | "unknown";
  installerPath: string | null;
  installerFileName: string | null;
  sha512: string | null;
  size: number | null;
  pendingReleaseName: string | null;
  channel: string | null;
  platform: string | null;
  outcomeAt: number | null;
}

export interface UpdateJournalLogger {
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

/** 版本词面校验：宽松 semver 形（主.次.补丁 + 可选 prerelease/build），拒绝空白与控制字符。 */
const JOURNAL_VERSION_PATTERN =
  /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
const SHA512_PATTERN = /^[0-9a-f]{128}$/i;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
}

function normalizeOptionalVersion(value: unknown): string | null {
  const normalized = normalizeOptionalString(value, 128);
  return normalized !== null && JOURNAL_VERSION_PATTERN.test(normalized) ? normalized : null;
}

function normalizeOptionalSha512(value: unknown): string | null {
  const normalized = normalizeOptionalString(value, 128);
  return normalized !== null && SHA512_PATTERN.test(normalized) ? normalized : null;
}

function normalizeOptionalSize(value: unknown): number | null {
  return isFiniteNumber(value) && value > 0 && Number.isSafeInteger(value) ? value : null;
}

/**
 * 前向兼容解析单条 entry（spec R6）：
 * - 未知字段忽略不报错（只挑已知闭集字段，不做往返保留）；
 * - outcome / exitSweepHandoff 未知枚举值归一为 "unknown"（保守不解读）；
 * - 闭集必填字段缺失/非法 → 整条判 null（丢弃 + warn），不做部分修复。
 */
export function parseUpdateJournalEntry(value: unknown): UpdateJournalEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const generation = isFiniteNumber(value.generation) ? value.generation : null;
  const handedOffAt = isFiniteNumber(value.handedOffAt) ? value.handedOffAt : null;
  const fromVersion = normalizeOptionalVersion(value.fromVersion);
  const toVersion = normalizeOptionalVersion(value.toVersion);
  if (
    generation === null ||
    generation <= 0 ||
    handedOffAt === null ||
    fromVersion === null ||
    toVersion === null
  ) {
    return null;
  }
  const rawOutcome = typeof value.outcome === "string" ? value.outcome : "";
  const outcome = (KNOWN_OUTCOMES as readonly string[]).includes(rawOutcome)
    ? (rawOutcome as UpdateJournalOutcome)
    : "unknown";
  const rawExitSweep =
    typeof value.exitSweepHandoff === "string" ? value.exitSweepHandoff : "";
  // 旧记录可能没有该字段（本字段后加）：缺省按 "unknown" 保守处理，不判整条无效。
  const exitSweepHandoff = (KNOWN_EXIT_SWEEP_VALUES as readonly string[]).includes(rawExitSweep)
    ? (rawExitSweep as UpdateJournalExitSweepHandoff)
    : "unknown";
  const outcomeAt = isFiniteNumber(value.outcomeAt) ? value.outcomeAt : null;
  return {
    generation,
    fromVersion,
    toVersion,
    outcome,
    handedOffAt,
    exitSweepHandoff,
    installerPath: normalizeOptionalString(value.installerPath, 1024),
    installerFileName: normalizeOptionalString(value.installerFileName, 255),
    sha512: normalizeOptionalSha512(value.sha512),
    size: normalizeOptionalSize(value.size),
    pendingReleaseName: normalizeOptionalString(value.pendingReleaseName, 512),
    channel: normalizeOptionalString(value.channel, 32),
    platform: normalizeOptionalString(value.platform, 32),
    outcomeAt,
  };
}

/**
 * 解析整份 journal（spec R6）：JSON 非法 / 顶层结构缺失 → null（无账本路径）；
 * 单条损坏丢弃 + warn，全部损坏 → 空数组（等效无条目）。顶层 version 是未来
 * 大版本号时仍按宽松规则尝试读 entries（读不到的闭集字段走条目丢弃路径），
 * 不因版本号整体拒绝。
 */
export function parseUpdateJournal(
  raw: string,
  logger: UpdateJournalLogger,
): UpdateJournalEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("[update-journal] ignoring malformed journal (invalid json)", {
      event: "update_journal_malformed",
      outcome: "invalid_json",
    });
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) {
    logger.warn("[update-journal] ignoring malformed journal (structure)", {
      event: "update_journal_malformed",
      outcome: "structure_mismatch",
    });
    return null;
  }
  const entries: UpdateJournalEntry[] = [];
  for (const candidate of parsed.entries) {
    const entry = parseUpdateJournalEntry(candidate);
    if (entry === null) {
      logger.warn("[update-journal] dropping malformed journal entry", {
        event: "update_journal_malformed",
        outcome: "entry_dropped",
      });
      continue;
    }
    entries.push(entry);
  }
  return entries;
}
