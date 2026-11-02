// 契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md
// provider-config-import 的宿主服务层契约族（docs/specs/provider-config-import.md R4/R5）：
// 来源枚举、脱敏候选视图、结构化 warning/error、结果类型、常量与 RPC 面端口。
//
// 本文件是**纯类型/常量**模块：刻意不引入任何 node: 依赖，使 browser-safe 的
// providerFacadeServices（descriptor/validators）可以只做 type-only 引用而不把
// node:sqlite / node:fs 带进 renderer 模块图。
import type { ProviderApiType } from "@acode/provider";

/** 导入来源；数组顺序即指纹去重优先级（R1/R3）。 */
export type ProviderImportSource = "claude-code" | "codex" | "cc-switch";

export const PROVIDER_IMPORT_SOURCES = [
  "claude-code",
  "codex",
  "cc-switch",
] as const satisfies readonly ProviderImportSource[];

/**
 * ACode 实际协议枚举真源见 packages/provider/src/config/provider-data-schema.ts；
 * `satisfies` 保证与服务层使用保持同集合——**不得**新增 google/gemini 第四值（EI-146）。
 */
export const PROVIDER_API_TYPES = [
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
] as const satisfies readonly ProviderApiType[];

/** 明文候选缓存 TTL（R5）：缓存只在服务进程内存，随下次扫描重置。 */
export const PROVIDER_IMPORT_CACHE_TTL_MS = 10 * 60_000;
export const MAX_CANDIDATE_IDS = 500;
export const MAX_SCAN_CANDIDATES = 500;
export const MAX_FILE_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_DB_COPY_BYTES = 256 * 1024 * 1024;
/**
 * 候选名称展示上限（R4）。实测 provider 域 schema（config/ids.ts）没有名称长度限制，
 * 故本常量是**导入侧**展示与落名归一上限，不冒充 provider 域既有约束。
 */
export const MAX_PROVIDER_NAME_CHARS = 128;
/** 候选 id 形态（randomUUID v4 及任意 UUID 都接受）。 */
export const CANDIDATE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProviderImportSource(value: unknown): value is ProviderImportSource {
  return (
    typeof value === "string" &&
    (PROVIDER_IMPORT_SOURCES as readonly string[]).includes(value)
  );
}

export type ProviderImportWarningCode =
  | "source-read-failed"
  | "invalid-json"
  | "invalid-toml"
  | "no-table"
  | "auth-ignored"
  | "env-missing-key"
  | "config-invalid-json"
  | "unsupported-api-format"
  | "unsupported-app-type"
  | "file-too-large"
  | "db-too-large"
  | "candidate-invalid"
  | "candidates-truncated";

/**
 * 结构化告警：服务层只回 `code + params`，zh/en 文案由 renderer 在 i18n 映射（EI-2）。
 * params 只允许来源名/文件名/计数/行号等非 secret 值——**绝不含明文 key 或原文片段**。
 */
export interface ProviderImportWarning {
  readonly code: ProviderImportWarningCode;
  readonly params: Readonly<Record<string, string | number>>;
}

export type ProviderImportErrorCode =
  | "invalid-args"
  | "scan-stale"
  | "candidate-missing"
  | "scan-failed"
  | "write-failed";

export interface ProviderImportError {
  readonly code: ProviderImportErrorCode;
  readonly params?: Readonly<Record<string, string | number>>;
}

export interface ProviderImportCandidateModelView {
  readonly id: string;
  readonly name: string;
}

/** 逐字段构造的脱敏候选视图（R4）：`Object.keys` 不含 apiKey，`JSON.stringify` 不含明文。 */
export interface ProviderImportCandidateView {
  readonly id: string;
  readonly source: ProviderImportSource;
  readonly sourceLabel: string;
  readonly name: string;
  readonly api: ProviderApiType;
  /** baseUrl 非 secret，按 Q6 裁决展示，辅助用户判断来源与去重依据。 */
  readonly baseUrl?: string;
  readonly models: readonly ProviderImportCandidateModelView[];
  readonly hasApiKey: boolean;
  /** 仅末 4 位；长度 < 12 时只给掩码（R4）。 */
  readonly apiKeyHint?: string;
  readonly isCurrent: boolean;
  readonly duplicate?: "existing" | "candidate";
  /** duplicate 为 existing 时是已有 providerName；为 candidate 时是先出现的 sourceLabel。 */
  readonly duplicateOf?: string;
}

export interface ProviderImportImportedItem {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly modelIds: readonly string[];
}

export interface ProviderImportSkippedItem {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

export type ProviderImportScanResult =
  | {
      readonly ok: true;
      readonly candidates: readonly ProviderImportCandidateView[];
      readonly warnings: readonly ProviderImportWarning[];
    }
  | { readonly ok: false; readonly error: ProviderImportError };

export type ProviderImportResult =
  | {
      readonly ok: true;
      readonly imported: readonly ProviderImportImportedItem[];
      readonly skipped: readonly ProviderImportSkippedItem[];
    }
  | { readonly ok: false; readonly error: ProviderImportError };

/**
 * provider-import 服务的 RPC 面端口（R5）。实现落在 host 侧
 * `provider-import/providerImporterService.ts`；providerFacadeServices 只依赖此接口。
 * 两个方法都不接受 workspacePath/workspaceIdentity——provider 配置是环境级而非工作区级。
 */
export interface ProviderImportServicePort {
  scanProviderImports(input?: {
    readonly sources?: readonly ProviderImportSource[];
  }): Promise<ProviderImportScanResult>;
  importProviderCandidates(input: {
    readonly candidateIds: readonly string[];
  }): Promise<ProviderImportResult>;
}