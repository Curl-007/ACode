// 契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md
// scan 层（R2 三层结构的编排层）：并行读取各来源 → 逐条校验 → 指纹去重 →
// 逐字段构造脱敏视图。逐来源失败隔离（单个来源失败只产该来源的 warning，不影响其它来源）。
//
// 明文边界：`DiscoveredProvider`（含明文 key）与候选 `input` 只在宿主内存；
// 出函数的一律是逐字段构造的脱敏 `view`。指纹是 sha256 摘要，不打印明文输入。
import { createHash, randomUUID } from "node:crypto";
import type { ProviderImportInput } from "@acode/provider";
import {
  CANDIDATE_ID_PATTERN,
  MAX_DB_COPY_BYTES,
  MAX_FILE_TEXT_BYTES,
  MAX_PROVIDER_NAME_CHARS,
  MAX_SCAN_CANDIDATES,
  PROVIDER_IMPORT_SOURCES,
  isProviderImportSource,
  type ProviderImportCandidateView,
  type ProviderImportSource,
  type ProviderImportWarning,
} from "./providerImportTypes.js";
import { createProviderImportScanIo, locateProviderImportSources, type ProviderImportScanIo } from "./locate.js";
import { isProviderApiType, type DiscoveredProvider, type Env, type ReaderResult } from "./readers/common.js";
import { readClaudeCode } from "./readers/claudeCode.js";
import { readCodex } from "./readers/codex.js";
import { readCcSwitch } from "./readers/ccSwitch.js";

/** 已有 Provider 的比对事实（由服务层经 ProviderSettingsFacade.readProviderDiscoveryInput 提供）。 */
export interface ProviderImportExistingProvider {
  readonly providerName: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
}

/** 单次扫描的候选：view 可出宿主，input 含明文只在宿主内存。 */
export interface ProviderImportScannedCandidate {
  readonly id: string;
  readonly view: ProviderImportCandidateView;
  readonly input: ProviderImportInput;
}

export interface ProviderImportScanOutcome {
  readonly candidates: readonly ProviderImportScannedCandidate[];
  readonly warnings: readonly ProviderImportWarning[];
}

export interface ProviderImportScanDeps {
  readonly home: string;
  /** 注入的 Env（宿主 process.env）；reader 绝不读全局 env（R1/R2）。 */
  readonly env: Env;
  readonly io?: ProviderImportScanIo;
  readonly existing?: () => readonly ProviderImportExistingProvider[];
  readonly newId?: () => string;
}

export function normalizeProviderImportBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** sha256(normalizeBaseUrl + "\n" + key)；只为可比较/可日志，日志里只允许短摘要（R3）。 */
export function providerImportFingerprint(input: {
  readonly baseUrl: string;
  readonly apiKey?: string;
}): string {
  return createHash("sha256")
    .update(`${normalizeProviderImportBaseUrl(input.baseUrl)}\n${input.apiKey ?? ""}`)
    .digest("hex");
}

/** 明文长度 ≥ 12 取「••••+末 4 位」，否则只给掩码（不给任何可拼接片段）。全仓唯一实现（R4）。 */
export function providerImportApiKeyHint(apiKey: string): string {
  return apiKey.length >= 12 ? `••••${apiKey.slice(-4)}` : "••••";
}

export { isProviderImportSource };
export { CANDIDATE_ID_PATTERN };

export async function scanProviderImports(
  deps: ProviderImportScanDeps,
  input?: { readonly sources?: readonly ProviderImportSource[] },
): Promise<ProviderImportScanOutcome> {
  const io = deps.io ?? createProviderImportScanIo();
  const sources = resolveRequestedSources(input?.sources);
  const located = new Map(
    locateProviderImportSources(deps.home).map((entry) => [entry.source, entry.paths] as const),
  );
  const results = await Promise.all(
    sources.map((source) => readSource(source, located.get(source) ?? [], deps, io)),
  );

  const warnings: ProviderImportWarning[] = results.flatMap((result) => result.warnings);
  const existingFingerprints = buildExistingFingerprints(deps.existing?.() ?? []);
  const candidateFingerprints = new Map<string, string>();
  const candidates: ProviderImportScannedCandidate[] = [];
  let truncated = 0;

  for (const provider of results.flatMap((result) => result.providers)) {
    if (candidates.length >= MAX_SCAN_CANDIDATES) {
      truncated += 1;
      continue;
    }
    const invalidity = validateDiscoveredProvider(provider);
    if (invalidity) {
      warnings.push({ code: "candidate-invalid", params: { source: provider.source, reason: invalidity } });
      continue;
    }
    const fingerprint = providerImportFingerprint({
      baseUrl: provider.baseUrl,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    });
    const existingName = existingFingerprints.get(fingerprint);
    const earlierCandidate = candidateFingerprints.get(fingerprint);
    if (!candidateFingerprints.has(fingerprint)) {
      candidateFingerprints.set(fingerprint, provider.sourceLabel);
    }
    const id = deps.newId?.() ?? randomUUID();
    candidates.push({
      id,
      view: toCandidateView({
        id,
        provider,
        ...(existingName
          ? { duplicate: "existing" as const, duplicateOf: existingName }
          : earlierCandidate
            ? { duplicate: "candidate" as const, duplicateOf: earlierCandidate }
            : {}),
      }),
      input: {
        providerName: truncateName(provider.name),
        api: { type: provider.api, baseUrl: provider.baseUrl },
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        modelIds: provider.models.map((model) => model.id),
        useRecommendedConfig: true,
      },
    });
  }

  if (truncated > 0) warnings.push({ code: "candidates-truncated", params: { count: truncated } });
  return { candidates, warnings };
}

/** 逐字段构造的脱敏视图（R4）：**绝不** `...input` 后再删 key。 */
function toCandidateView(args: {
  readonly id: string;
  readonly provider: DiscoveredProvider;
  readonly duplicate?: "existing" | "candidate";
  readonly duplicateOf?: string;
}): ProviderImportCandidateView {
  const { provider } = args;
  return {
    id: args.id,
    source: provider.source,
    sourceLabel: provider.sourceLabel,
    name: truncateName(provider.name),
    api: provider.api,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    models: provider.models.map((model) => ({ id: model.id, name: model.name })),
    hasApiKey: Boolean(provider.apiKey),
    ...(provider.apiKey ? { apiKeyHint: providerImportApiKeyHint(provider.apiKey) } : {}),
    isCurrent: provider.isCurrent,
    ...(args.duplicate
      ? { duplicate: args.duplicate, ...(args.duplicateOf ? { duplicateOf: args.duplicateOf } : {}) }
      : {}),
  };
}

function truncateName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > MAX_PROVIDER_NAME_CHARS ? trimmed.slice(0, MAX_PROVIDER_NAME_CHARS) : trimmed;
}

function validateDiscoveredProvider(provider: DiscoveredProvider): string | null {
  if (!isProviderApiType(provider.api)) return "api";
  const baseUrl = normalizeProviderImportBaseUrl(provider.baseUrl);
  if (!baseUrl) return "baseUrl";
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "baseUrl";
  } catch {
    return "baseUrl";
  }
  if (!provider.name.trim()) return "name";
  return null;
}

function buildExistingFingerprints(
  existing: readonly ProviderImportExistingProvider[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const provider of existing) {
    if (!normalizeProviderImportBaseUrl(provider.baseUrl)) continue;
    const fingerprint = providerImportFingerprint({
      baseUrl: provider.baseUrl,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    });
    if (!result.has(fingerprint)) result.set(fingerprint, provider.providerName);
  }
  return result;
}

function resolveRequestedSources(
  requested?: readonly ProviderImportSource[],
): readonly ProviderImportSource[] {
  if (!requested) return PROVIDER_IMPORT_SOURCES;
  const seen = new Set<ProviderImportSource>();
  const resolved: ProviderImportSource[] = [];
  for (const source of requested) {
    if (isProviderImportSource(source) && !seen.has(source)) {
      seen.add(source);
      resolved.push(source);
    }
  }
  return resolved.length > 0 ? resolved : PROVIDER_IMPORT_SOURCES;
}

async function readSource(
  source: ProviderImportSource,
  paths: readonly string[],
  deps: ProviderImportScanDeps,
  io: ProviderImportScanIo,
): Promise<ReaderResult> {
  try {
    if (source === "claude-code") {
      const read = await io.readTextFile(paths[0] ?? "", MAX_FILE_TEXT_BYTES);
      if (read.tooLarge) {
        return {
          providers: [],
          warnings: [{ code: "file-too-large", params: { source, file: paths[0] ?? source } }],
        };
      }
      return withSource(readClaudeCode({ settingsText: read.text }), source);
    }
    if (source === "codex") {
      const configRead = await io.readTextFile(paths[0] ?? "", MAX_FILE_TEXT_BYTES);
      if (configRead.tooLarge) {
        return {
          providers: [],
          warnings: [{ code: "file-too-large", params: { source, file: paths[0] ?? source } }],
        };
      }
      // auth.json 单独隔离：它读失败/过大只丢 key，不整源放弃。
      let authText: string | null = null;
      const authWarnings: ProviderImportWarning[] = [];
      try {
        const authRead = await io.readTextFile(paths[1] ?? "", MAX_FILE_TEXT_BYTES);
        if (authRead.tooLarge) {
          authWarnings.push({ code: "file-too-large", params: { source, file: paths[1] ?? source } });
        } else {
          authText = authRead.text;
        }
      } catch (error) {
        authWarnings.push({
          code: "source-read-failed",
          params: { source, file: paths[1] ?? source, reason: errorName(error) },
        });
      }
      const result = readCodex({ config: configRead.text, auth: authText, env: deps.env });
      const tagged = withSource(result, source);
      return { providers: tagged.providers, warnings: [...tagged.warnings, ...authWarnings] };
    }
    const dbRead = await io.readCcSwitchRows(paths[0] ?? "", MAX_DB_COPY_BYTES);
    if (dbRead.tooLarge) {
      return {
        providers: [],
        warnings: [{ code: "db-too-large", params: { source, file: paths[0] ?? source } }],
      };
    }
    return withSource(readCcSwitch(dbRead.rows, deps.env), source);
  } catch (error) {
    // 逐来源隔离：任一来源（或它的一个文件）失败只产该来源的一条 warning。
    return {
      providers: [],
      warnings: [
        {
          code: "source-read-failed",
          params: { source, file: paths[0] ?? source, reason: errorName(error) },
        },
      ],
    };
  }
}

function withSource(result: ReaderResult, source: ProviderImportSource): ReaderResult {
  return {
    providers: result.providers.map((provider) =>
      provider.source === source ? provider : { ...provider, source },
    ),
    warnings: withSourceWarnings(result.warnings, source),
  };
}

/** 统一给 reader 产出的 warning 补 source 维度（params 只含非 secret 值）。 */
function withSourceWarnings(
  warnings: readonly ProviderImportWarning[],
  source: ProviderImportSource,
): readonly ProviderImportWarning[] {
  return warnings.map((warning) => ({ code: warning.code, params: { source, ...warning.params } }));
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}