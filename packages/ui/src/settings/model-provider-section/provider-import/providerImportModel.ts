import type { ProviderApiType } from "@acode/provider";
import type {
  ProviderImportCandidateView,
  ProviderImportErrorCode,
  ProviderImportResult,
  ProviderImportScanResult,
  ProviderImportSource,
  ProviderImportWarning,
} from "@acode/services";

/**
 * Provider 导入向导的纯决策模型（docs/specs/provider-config-import.md R8）。
 *
 * 纯函数，无 React/DOM/服务依赖，可直接单测（含 R8 的负向断言：本层只做**白名单投影**，
 * 即使上游视图未来多带字段，渲染行也不会携带 apiKey 等任何未列字段）。
 */

export type ProviderImportStep = "sources" | "scanning" | "preview" | "importing" | "result";

/** 来源顺序与服务端 PROVIDER_IMPORT_SOURCES 一致（顺序即指纹去重优先级）。 */
export const PROVIDER_IMPORT_SOURCE_ORDER: readonly ProviderImportSource[] = [
  "claude-code",
  "codex",
  "cc-switch",
];

export interface ProviderImportSourcePresentation {
  source: ProviderImportSource;
  labelId: string;
  /** 静态 `~` 形式标签；实际路径由 host 定位，UI 不拼路径（R8）。 */
  pathLabel: string;
}

export const PROVIDER_IMPORT_SOURCE_PRESENTATIONS: readonly ProviderImportSourcePresentation[] = [
  {
    source: "claude-code",
    labelId: "settings.modelProvider.import.source.claudeCode",
    pathLabel: "~/.claude/settings.json",
  },
  {
    source: "codex",
    labelId: "settings.modelProvider.import.source.codex",
    pathLabel: "~/.codex/config.toml · ~/.codex/auth.json",
  },
  {
    source: "cc-switch",
    labelId: "settings.modelProvider.import.source.ccSwitch",
    pathLabel: "~/.cc-switch/cc-switch.db",
  },
];

/** 渲染行的**白名单投影**：只列展示所需字段，绝不透传上游对象（R4 的 UI 层等价断言）。 */
export interface ProviderImportCandidateRow {
  id: string;
  name: string;
  sourceLabel: string;
  api: ProviderApiType;
  baseUrl: string | null;
  modelCount: number;
  /** 前若干个模型 id（非凭据，可展示）。 */
  modelPreview: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  isCurrent: boolean;
  duplicate: "existing" | "candidate" | null;
  duplicateOf: string | null;
  /** 默认勾选资格：已存在的重复项默认不勾（R8）。 */
  selectable: boolean;
}

const MODEL_PREVIEW_LIMIT = 3;

export function buildProviderImportCandidateRows(
  candidates: readonly ProviderImportCandidateView[],
): ProviderImportCandidateRow[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    name: candidate.name,
    sourceLabel: candidate.sourceLabel,
    api: candidate.api,
    baseUrl: candidate.baseUrl ?? null,
    modelCount: candidate.models.length,
    modelPreview: candidate.models
      .slice(0, MODEL_PREVIEW_LIMIT)
      .map((model) => model.id)
      .join(", "),
    hasApiKey: candidate.hasApiKey === true,
    apiKeyHint: candidate.apiKeyHint ?? null,
    isCurrent: candidate.isCurrent === true,
    duplicate: candidate.duplicate ?? null,
    duplicateOf: candidate.duplicateOf ?? null,
    // 去重标签是建议不是门禁（R3）：仍可手动勾选 candidate 重复项，仅 existing 默认不勾。
    selectable: candidate.duplicate !== "existing",
  }));
}

/** 默认勾选集：全部可勾选（非 existing 重复）的候选 id。 */
export function defaultProviderImportSelection(
  candidates: readonly ProviderImportCandidateView[],
): string[] {
  return candidates.filter((candidate) => candidate.duplicate !== "existing").map(({ id }) => id);
}

export function isProviderImportCandidateSelectable(candidate: ProviderImportCandidateView): boolean {
  return candidate.duplicate !== "existing";
}

export function toggleProviderImportSource(
  current: readonly ProviderImportSource[],
  source: ProviderImportSource,
  checked: boolean,
): ProviderImportSource[] {
  if (checked) {
    return PROVIDER_IMPORT_SOURCE_ORDER.filter((item) => item === source || current.includes(item));
  }
  return current.filter((item) => item !== source);
}

export function toggleProviderImportCandidateIds(
  current: readonly string[],
  ids: readonly string[],
  checked: boolean,
): string[] {
  const next = new Set(current);
  for (const id of ids) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return [...next];
}

export function providerImportWarningMessageId(code: ProviderImportWarning["code"]): string {
  return `settings.modelProvider.import.warning.${code}`;
}

export function providerImportErrorMessageId(code: ProviderImportErrorCode): string {
  return `settings.modelProvider.import.error.${code}`;
}

/** 扫描失败的结构化错误码（ok:false 时）；用于文案与「重新扫描」分流。 */
export function providerImportScanErrorCode(
  result: ProviderImportScanResult | null,
): ProviderImportErrorCode | null {
  return result && !result.ok ? result.error.code : null;
}

/** 缓存过期需要重扫（R8 失败态：提示重新扫描）。 */
export function isProviderImportRescanRequired(code: ProviderImportErrorCode | null): boolean {
  return code === "scan-stale";
}

export interface ProviderImportOutcomeSummary {
  imported: number;
  skipped: number;
}

export function summarizeProviderImportResult(
  result: ProviderImportResult | null,
): ProviderImportOutcomeSummary | null {
  return result?.ok
    ? { imported: result.imported.length, skipped: result.skipped.length }
    : null;
}

export function providerImportImportedCount(result: ProviderImportResult | null): number {
  return result?.ok ? result.imported.length : 0;
}