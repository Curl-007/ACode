// 契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md
// provider-import 服务（R5）：单槽缓存（TTL）+ 两个 RPC 方法实现。
//
// 状态所有权：明文候选缓存只在本服务实例内存（宿主内存），随下次扫描重置；
// `provider_config.json` 的唯一写入漏斗仍在 provider-node repository，
// 本服务只把候选 input 交给注入的写入端口（ProviderSettingsFacade.importPersonalProviders）。
import type { PersonalProviderImportOutcome, ProviderImportInput } from "@acode/provider";
import {
  CANDIDATE_ID_PATTERN,
  MAX_CANDIDATE_IDS,
  PROVIDER_IMPORT_CACHE_TTL_MS,
  PROVIDER_IMPORT_SOURCES,
  isProviderImportSource,
  type ProviderImportResult,
  type ProviderImportScanResult,
  type ProviderImportServicePort,
  type ProviderImportSource,
} from "./providerImportTypes.js";
import {
  errorName,
  scanProviderImports,
  type ProviderImportExistingProvider,
  type ProviderImportScannedCandidate,
} from "./scan.js";
import type { ProviderImportScanIo } from "./locate.js";
import type { Env } from "./readers/common.js";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";

export interface ProviderImportServiceDeps {
  readonly home: string;
  /** 注入的 Env（宿主 process.env）；reader 绝不读全局 env。 */
  readonly env: Env;
  readonly io?: ProviderImportScanIo;
  /** 已有 Provider 的比对事实（服务层从 Facade 读取，不登记 RPC、不进日志）。 */
  readonly existing?: () => readonly ProviderImportExistingProvider[];
  /** 写入端口：ProviderSettingsFacade.importPersonalProviders（provider 域单事务）。 */
  readonly importPersonalProviders: (
    inputs: readonly ProviderImportInput[],
  ) => Promise<PersonalProviderImportOutcome>;
  /** 可注入时钟（EI-121 固定时钟测试）。 */
  readonly now?: () => number;
  readonly newId?: () => string;
  /** 测试注入的 logger；缺省懒创建 `createServiceLogger("provider-import")`。 */
  readonly log?: ServiceLogger;
}

interface ProviderImportCache {
  readonly expiresAt: number;
  readonly byId: ReadonlyMap<string, ProviderImportScannedCandidate>;
}

export function createProviderImportService(deps: ProviderImportServiceDeps): ProviderImportServicePort {
  const now = deps.now ?? Date.now;
  let log: ServiceLogger | null = deps.log ?? null;
  const logger = (): ServiceLogger => (log ??= createServiceLogger("provider-import"));
  // 单槽缓存：**不允许**无界缓存；每次扫描重置（R5）。
  let cache: ProviderImportCache | null = null;

  const scanDeps = {
    home: deps.home,
    env: deps.env,
    ...(deps.io ? { io: deps.io } : {}),
    ...(deps.existing ? { existing: deps.existing } : {}),
    ...(deps.newId ? { newId: deps.newId } : {}),
  };

  return {
    async scanProviderImports(input): Promise<ProviderImportScanResult> {
      const sources = validateSources(input?.sources);
      if (sources === null) return { ok: false, error: { code: "invalid-args" } };
      const serviceLog = logger();
      // 重置缓存在扫描之前：本次扫描的候选才是唯一有效集合。
      cache = null;
      const startedAt = now();
      serviceLog.info(undefined, "provider-import 扫描开始", { sources: sources.join(",") });
      let outcome;
      try {
        outcome = await scanProviderImports(scanDeps, { sources });
      } catch (error) {
        serviceLog.warn(undefined, "provider-import 扫描失败", { reason: errorName(error) });
        return { ok: false, error: { code: "scan-failed" } };
      }
      const byId = new Map(outcome.candidates.map((candidate) => [candidate.id, candidate] as const));
      cache = { expiresAt: now() + PROVIDER_IMPORT_CACHE_TTL_MS, byId };
      serviceLog.info(undefined, "provider-import 扫描完成", {
        candidates: outcome.candidates.length,
        warnings: outcome.warnings.length,
        durationMs: now() - startedAt,
      });
      return {
        ok: true,
        candidates: outcome.candidates.map((candidate) => candidate.view),
        warnings: outcome.warnings,
      };
    },

    async importProviderCandidates(input): Promise<ProviderImportResult> {
      const candidateIds = validateCandidateIds(input?.candidateIds);
      if (candidateIds === null) return { ok: false, error: { code: "invalid-args" } };
      const serviceLog = logger();
      const current = cache;
      if (!current || now() >= current.expiresAt) {
        // 过期/从未扫描 → 明确未执行，零写入（EI-11 可安全重试）。
        if (current) cache = null;
        return { ok: false, error: { code: "scan-stale" } };
      }
      const selected: ProviderImportScannedCandidate[] = [];
      const seen = new Set<string>();
      for (const candidateId of candidateIds) {
        if (seen.has(candidateId)) continue;
        const found = current.byId.get(candidateId);
        // 任一候选缺失即整批放弃：先全量解析再写入，不产生部分提交。
        if (!found) return { ok: false, error: { code: "candidate-missing", params: { id: candidateId } } };
        seen.add(candidateId);
        selected.push(found);
      }
      serviceLog.info(undefined, "provider-import 写入开始", { candidates: selected.length });
      let outcome: PersonalProviderImportOutcome;
      try {
        outcome = await deps.importPersonalProviders(selected.map((candidate) => candidate.input));
      } catch (error) {
        serviceLog.warn(undefined, "provider-import 写入失败", { reason: errorName(error) });
        return { ok: false, error: { code: "write-failed" } };
      }
      const imported = outcome.items.map((item, index) => ({
        id: selected[index]?.id ?? "",
        providerId: item.providerId,
        name: item.providerName,
        modelIds: [...item.modelIds],
      }));
      const skipped = outcome.items.flatMap((item, index) =>
        item.skippedModelIds.length === 0
          ? []
          : [{ id: selected[index]?.id ?? "", name: item.providerName, reason: "model-exists" }],
      );
      serviceLog.info(undefined, "provider-import 写入完成", {
        imported: imported.length,
        skipped: skipped.length,
      });
      return { ok: true, imported, skipped };
    },
  };
}

function validateSources(input?: readonly ProviderImportSource[]): ProviderImportSource[] | null {
  if (input === undefined) return [...PROVIDER_IMPORT_SOURCES];
  if (!Array.isArray(input) || input.length === 0) return null;
  const resolved: ProviderImportSource[] = [];
  for (const source of input) {
    if (!isProviderImportSource(source)) return null;
    if (!resolved.includes(source)) resolved.push(source);
  }
  return resolved.length > 0 ? resolved : null;
}

function validateCandidateIds(input?: readonly string[]): string[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  if (input.length > MAX_CANDIDATE_IDS) return null;
  for (const candidateId of input) {
    if (typeof candidateId !== "string" || !CANDIDATE_ID_PATTERN.test(candidateId)) return null;
  }
  return [...input];
}