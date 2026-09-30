// ============================================================
// Provider Doctor 覆盖账本（J3-1 / spec R5 + R6）
// 机制参照 jcode (MIT, github.com/1jehuang/jcode) crates/jcode-provider-doctor，自撰实现。
// ============================================================
//
// 本地 JSONL，追加写。三条硬约束：
//   1) **绝不上传**——本文件不得出现任何网络出口（specs/no-telemetry.md）；
//   2) **绝不写凭据**——事件字段是白名单，写入前再过一次 `findCredentialLikeKeys` 自检；
//   3) 损坏行只跳过并计数，不让一次半截写入毁掉整份历史证据。

import { mkdir, readFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  PROVIDER_DOCTOR_CHECKPOINT_COUNT,
  isProviderDoctorCheckpointId,
  providerDoctorCheckpointLabel,
} from "./checkpoints.js";
import { findCredentialLikeKeys } from "./redaction.js";
import { EMPTY_PROVIDER_DOCTOR_SPEND, summarizeProviderDoctorSpend } from "./spend.js";
import {
  PROVIDER_DOCTOR_DEFAULT_RETEST_DAYS,
  PROVIDER_DOCTOR_LEDGER_SCHEMA_VERSION,
  type ProviderDoctorCoverageRow,
  type ProviderDoctorCoverageSummary,
  type ProviderDoctorLedgerCheck,
  type ProviderDoctorLedgerEvent,
  type ProviderDoctorLedgerPort,
  type ProviderDoctorSpend,
  type ProviderDoctorTier,
} from "./types.js";

export const PROVIDER_DOCTOR_LEDGER_ENV = "ACODE_PROVIDER_DOCTOR_LEDGER";
export const PROVIDER_DOCTOR_LEDGER_RELATIVE_PATH = join(
  ".acode",
  "cli",
  "provider-doctor",
  "coverage.jsonl",
);

/** 与 CLI 既有本地数据同域（`.acode/cli/...`），并尊重 ACODE_DATA_BASE_DIR。 */
export function resolveProviderDoctorLedgerPath(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly filePath?: string;
  readonly baseDir?: string;
} = {}): string {
  const env = options.env ?? process.env;
  const explicit = options.filePath ?? env[PROVIDER_DOCTOR_LEDGER_ENV]?.trim();
  if (explicit) return resolve(explicit);
  const baseDir = options.baseDir ?? env.ACODE_DATA_BASE_DIR?.trim() ?? homedir();
  return join(resolveUserPath(baseDir), PROVIDER_DOCTOR_LEDGER_RELATIVE_PATH);
}

export interface FileProviderDoctorLedgerOptions {
  readonly filePath: string;
  readonly now?: () => Date;
}

export function createFileProviderDoctorLedger(
  options: FileProviderDoctorLedgerOptions,
): ProviderDoctorLedgerPort {
  return {
    async record(event): Promise<void> {
      // 写入前的结构性自检：白名单之外夹带凭据字段宁可拒绝写入，也不能落盘。
      const credentialKeys = findCredentialLikeKeys(event);
      if (credentialKeys.length > 0) {
        throw new Error(
          `Provider doctor 账本拒绝写入含凭据字段的事件: ${credentialKeys.join(", ")}`,
        );
      }
      await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
      await appendFile(options.filePath, `${JSON.stringify(event)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
    async read(): Promise<{
      events: readonly ProviderDoctorLedgerEvent[];
      corruptLines: number;
    }> {
      return readProviderDoctorLedgerFile(options.filePath);
    },
  };
}

export async function readProviderDoctorLedgerFile(
  filePath: string,
): Promise<{ events: readonly ProviderDoctorLedgerEvent[]; corruptLines: number }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { events: [], corruptLines: 0 };
    throw error;
  }
  return parseProviderDoctorLedger(raw);
}

export function parseProviderDoctorLedger(
  raw: string,
): { events: readonly ProviderDoctorLedgerEvent[]; corruptLines: number } {
  const events: ProviderDoctorLedgerEvent[] = [];
  let corruptLines = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const event = parseProviderDoctorLedgerEvent(trimmed);
    if (!event) {
      corruptLines += 1;
      continue;
    }
    events.push(event);
  }
  return { events, corruptLines };
}

/** 测试与 dry-run 用：同一 Port 契约，零文件副作用。 */
export function createInMemoryProviderDoctorLedger(): ProviderDoctorLedgerPort & {
  readonly events: readonly ProviderDoctorLedgerEvent[];
} {
  const events: ProviderDoctorLedgerEvent[] = [];
  return {
    events,
    async record(event): Promise<void> {
      events.push(event);
    },
    async read(): Promise<{
      events: readonly ProviderDoctorLedgerEvent[];
      corruptLines: number;
    }> {
      return { events: [...events], corruptLines: 0 };
    },
  };
}

export function createProviderDoctorLedgerEvent(input: {
  readonly recordedAt: Date;
  readonly tier: ProviderDoctorTier;
  readonly providerId: string;
  readonly providerLabel?: string;
  readonly modelId?: string;
  readonly endpointHost?: string;
  readonly result: ProviderDoctorLedgerEvent["result"];
  readonly checks: readonly ProviderDoctorLedgerCheck[];
  readonly firstFailure?: ProviderDoctorLedgerEvent["firstFailure"];
  readonly spend: ProviderDoctorSpend;
  readonly runner?: ProviderDoctorLedgerEvent["runner"];
  readonly retestDays?: number;
  readonly eventId?: string;
}): ProviderDoctorLedgerEvent {
  const retestDays = input.retestDays ?? PROVIDER_DOCTOR_DEFAULT_RETEST_DAYS;
  const retestAfter = new Date(input.recordedAt.getTime() + retestDays * 24 * 60 * 60 * 1000);
  return Object.freeze({
    schemaVersion: PROVIDER_DOCTOR_LEDGER_SCHEMA_VERSION,
    eventId: input.eventId ?? randomUUID(),
    recordedAt: input.recordedAt.toISOString(),
    tier: input.tier,
    providerId: input.providerId,
    ...(input.providerLabel ? { providerLabel: input.providerLabel } : {}),
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.endpointHost ? { endpointHost: input.endpointHost } : {}),
    result: input.result,
    checks: Object.freeze(input.checks.map((check) => Object.freeze({ ...check }))),
    ...(input.firstFailure ? { firstFailure: Object.freeze({ ...input.firstFailure }) } : {}),
    spend: Object.freeze({ ...input.spend }),
    ...(input.runner ? { runner: Object.freeze({ ...input.runner }) } : {}),
    retestAfter: retestAfter.toISOString(),
  });
}

export function summarizeProviderDoctorCoverage(input: {
  readonly events: readonly ProviderDoctorLedgerEvent[];
  readonly corruptLines?: number;
  readonly now?: Date;
}): ProviderDoctorCoverageSummary {
  const now = input.now ?? new Date();
  const latestByKey = new Map<string, ProviderDoctorLedgerEvent>();
  for (const event of input.events) {
    const key = `${event.providerId}\u0000${event.modelId ?? ""}`;
    const current = latestByKey.get(key);
    // 同一时间戳时后写入的证据更新（追加式账本，文件顺序即因果顺序）。
    if (!current || Date.parse(event.recordedAt) >= Date.parse(current.recordedAt)) {
      latestByKey.set(key, event);
    }
  }

  const rows: ProviderDoctorCoverageRow[] = [];
  for (const event of latestByKey.values()) {
    const cleared = event.checks.filter((check) => check.status === "passed").length;
    const blocker = event.checks.find(
      (check) => check.status === "failed" || check.status === "blocked",
    );
    rows.push({
      providerId: event.providerId,
      ...(event.providerLabel ? { providerLabel: event.providerLabel } : {}),
      ...(event.modelId ? { modelId: event.modelId } : {}),
      ready: event.result === "ready",
      clearedCheckpoints: cleared,
      totalCheckpoints: PROVIDER_DOCTOR_CHECKPOINT_COUNT,
      ...(blocker ? { firstBlockerId: blocker.id } : {}),
      ...(event.firstFailure?.hint ? { nextCommand: event.firstFailure.hint } : {}),
      recordedAt: event.recordedAt,
      tier: event.tier,
      ...(event.runner ? { runner: event.runner } : {}),
      spend: event.spend,
      stale: isStaleEvidence(event, now),
    });
  }
  rows.sort((a, b) =>
    `${a.providerId}/${a.modelId ?? ""}`.localeCompare(`${b.providerId}/${b.modelId ?? ""}`),
  );

  return Object.freeze({
    rows: Object.freeze(rows),
    recordedSpend: summarizeProviderDoctorSpend(rows.map((row) => row.spend)),
    corruptLines: input.corruptLines ?? 0,
  });
}

/** 覆盖行的人类可读状态：`READY` 或 `N/12`（与 jcode 的 coverage 视图同构）。 */
export function formatCoverageStatusToken(row: ProviderDoctorCoverageRow): string {
  return row.ready ? "READY" : `${row.clearedCheckpoints}/${row.totalCheckpoints}`;
}

export function formatCoverageBlocker(row: ProviderDoctorCoverageRow): string | undefined {
  if (row.ready || !row.firstBlockerId) return undefined;
  const label = isProviderDoctorCheckpointId(row.firstBlockerId)
    ? providerDoctorCheckpointLabel(row.firstBlockerId)
    : row.firstBlockerId;
  return row.nextCommand ? `卡在「${label}」；${row.nextCommand}` : `卡在「${label}」`;
}

function isStaleEvidence(event: ProviderDoctorLedgerEvent, now: Date): boolean {
  const retestAfter = Date.parse(event.retestAfter);
  if (Number.isNaN(retestAfter)) return true;
  return now.getTime() > retestAfter;
}

function parseProviderDoctorLedgerEvent(line: string): ProviderDoctorLedgerEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.eventId !== "string" || typeof value.recordedAt !== "string") return null;
  if (typeof value.providerId !== "string") return null;
  const tier = value.tier;
  if (tier !== "offline" && tier !== "catalog" && tier !== "live") return null;
  const result = value.result;
  if (result !== "ready" && result !== "tier-passed" && result !== "failed") return null;

  const checks = parseLedgerChecks(value.checks);
  const firstFailure = parseFirstFailure(value.firstFailure);
  const runner = parseRunner(value.runner);
  return Object.freeze({
    schemaVersion:
      typeof value.schemaVersion === "number"
        ? value.schemaVersion
        : PROVIDER_DOCTOR_LEDGER_SCHEMA_VERSION,
    eventId: value.eventId,
    recordedAt: value.recordedAt,
    tier,
    providerId: value.providerId,
    ...(typeof value.providerLabel === "string" ? { providerLabel: value.providerLabel } : {}),
    ...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
    ...(typeof value.endpointHost === "string" ? { endpointHost: value.endpointHost } : {}),
    result,
    checks,
    ...(firstFailure ? { firstFailure } : {}),
    spend: parseSpend(value.spend),
    ...(runner ? { runner } : {}),
    retestAfter: typeof value.retestAfter === "string" ? value.retestAfter : value.recordedAt,
  });
}

function parseLedgerChecks(value: unknown): readonly ProviderDoctorLedgerCheck[] {
  if (!Array.isArray(value)) return [];
  const checks: ProviderDoctorLedgerCheck[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const check = item as Record<string, unknown>;
    // 版本演进容忍：未知检查点 id 直接丢弃该条，而不是让整份账本读不出来。
    if (!isProviderDoctorCheckpointId(check.id)) continue;
    const status = check.status;
    if (
      status !== "passed" &&
      status !== "failed" &&
      status !== "skipped" &&
      status !== "blocked"
    ) {
      continue;
    }
    checks.push(
      Object.freeze({
        id: check.id,
        status,
        ...(typeof check.detail === "string" ? { detail: check.detail } : {}),
      }),
    );
  }
  return Object.freeze(checks);
}

function parseFirstFailure(
  value: unknown,
): ProviderDoctorLedgerEvent["firstFailure"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const failure = value as Record<string, unknown>;
  if (!isProviderDoctorCheckpointId(failure.id) || typeof failure.hint !== "string") {
    return undefined;
  }
  return Object.freeze({ id: failure.id, hint: failure.hint });
}

function parseSpend(value: unknown): ProviderDoctorSpend {
  if (typeof value !== "object" || value === null) return EMPTY_PROVIDER_DOCTOR_SPEND;
  const spend = value as Record<string, unknown>;
  const number = (key: string): number =>
    typeof spend[key] === "number" && Number.isFinite(spend[key] as number)
      ? Math.max(0, Math.trunc(spend[key] as number))
      : 0;
  return Object.freeze({
    billableCalls: number("billableCalls"),
    catalogCalls: number("catalogCalls"),
    promptTokens: number("promptTokens"),
    outputTokens: number("outputTokens"),
    totalTokens: number("totalTokens"),
    hasTokenData: spend.hasTokenData === true,
  });
}

function parseRunner(value: unknown): ProviderDoctorLedgerEvent["runner"] | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const runner = value as Record<string, unknown>;
  if (runner.actor !== "user" && runner.actor !== "developer") return undefined;
  if (typeof runner.cliVersion !== "string") return undefined;
  return Object.freeze({
    actor: runner.actor,
    cliVersion: runner.cliVersion,
    platform: typeof runner.platform === "string" ? runner.platform : "unknown",
    arch: typeof runner.arch === "string" ? runner.arch : "unknown",
    node: typeof runner.node === "string" ? runner.node : "unknown",
    sea: runner.sea === true,
    pid: typeof runner.pid === "number" ? runner.pid : 0,
  });
}

function resolveUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return resolve(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}
