// 契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md
// Claude Code 来源 reader（R1 来源 1）：解析 `~/.claude/settings.json` 的 anthropic 配置。
// 该 reader 同时被 CC Switch 的 `claude` 行复用（R1 来源 3 明令复用同一解析，不写第二份）。
import type { ProviderImportSource } from "../providerImportTypes.js";
import type { DiscoveredProviderModel, ReaderResult } from "./common.js";
import {
  baseUrlOf,
  emptyReaderResult,
  isRecord,
  modelEntries,
  parseJsonObject,
  text,
} from "./common.js";

export const CLAUDE_CODE_LABEL: ProviderImportSource = "claude-code";
export const CLAUDE_CODE_DISPLAY = "Claude Code";

/** 模型别名一律忽略（仅小写比较）：指向哪个模型取决于端点，不是可移植的模型 id。 */
const CLAUDE_MODEL_ALIASES = new Set([
  "default",
  "best",
  "fable",
  "opus",
  "sonnet",
  "haiku",
  "opusplan",
]);

/** 匹配 env 中的模型键：`ANTHROPIC_MODEL` 与 `ANTHROPIC_DEFAULT_<X>_MODEL`。 */
const ANTHROPIC_MODEL_KEY = /^ANTHROPIC_(?:DEFAULT_[A-Z0-9_]+_)?MODEL$/;

export interface AnthropicSettingsRead {
  readonly baseUrl: string | null;
  readonly apiKey?: string;
  readonly models: readonly DiscoveredProviderModel[];
  /** 首个 `<键>_NAME` 显示名（有则覆盖目录名）；无则 null。 */
  readonly primaryName: string | null;
}

/**
 * 归一单个 anthropic 模型 id：剥离 `[..]` 后缀 → trim → 空/含空白/别名一律丢弃。
 * 先剥后缀再判别名，避免 `sonnet[1m]` 绕过别名过滤。
 */
function normalizeClaudeModelId(raw: string): string | null {
  const withoutSuffix = raw.replace(/\[[^\]]*\]/g, "").trim();
  if (!withoutSuffix) return null;
  if (/\s/.test(withoutSuffix)) return null;
  if (CLAUDE_MODEL_ALIASES.has(withoutSuffix.toLowerCase())) return null;
  return withoutSuffix;
}

export function readAnthropicSettings(settings: Record<string, unknown>): AnthropicSettingsRead {
  const env = isRecord(settings.env) ? settings.env : {};
  const baseUrl = baseUrlOf(env.ANTHROPIC_BASE_URL);
  // 优先级：AUTH_TOKEN 先于 API_KEY（与 Claude Code 本机实测口径一致）。
  const apiKey = text(env.ANTHROPIC_AUTH_TOKEN) ?? text(env.ANTHROPIC_API_KEY);

  const names = new Map<string, string>();
  const rawIds: string[] = [];
  const topLevelModel = text(settings.model);
  if (topLevelModel) rawIds.push(topLevelModel);
  for (const [key, value] of Object.entries(env)) {
    if (!ANTHROPIC_MODEL_KEY.test(key)) continue;
    const raw = text(value);
    if (raw) rawIds.push(raw);
    const id = raw ? normalizeClaudeModelId(raw) : null;
    const displayName = text(env[`${key}_NAME`]) ?? text(settings[`${key}_NAME`]);
    if (id && displayName) names.set(id, displayName);
  }

  const normalizedIds: string[] = [];
  for (const raw of rawIds) {
    const id = normalizeClaudeModelId(raw);
    if (id) normalizedIds.push(id);
  }
  const models = modelEntries(normalizedIds, names);
  let primaryName: string | null = null;
  for (const model of models) {
    if (model.name !== model.id) {
      primaryName = model.name;
      break;
    }
  }
  return { baseUrl, ...(apiKey ? { apiKey } : {}), models, primaryName };
}

export function readClaudeCode(source: { readonly settingsText: string | null }): ReaderResult {
  if (source.settingsText === null) return emptyReaderResult();
  const settings = parseJsonObject(source.settingsText);
  if (!settings) {
    // settings.json 坏内容只丢该来源；不整源放弃语义由 scan 的逐来源隔离承担。
    return { providers: [], warnings: [{ code: "invalid-json", params: {} }] };
  }
  const read = readAnthropicSettings(settings);
  // 既无 baseUrl 又无 key（官方账号登录 / 空占位）→ 不产出该来源，正常不告警。
  if (!read.baseUrl && !read.apiKey) return emptyReaderResult();
  return {
    providers: [
      {
        source: CLAUDE_CODE_LABEL,
        sourceLabel: CLAUDE_CODE_DISPLAY,
        name: read.primaryName ?? CLAUDE_CODE_DISPLAY,
        api: "anthropic-messages",
        baseUrl: read.baseUrl ?? "",
        ...(read.apiKey ? { apiKey: read.apiKey } : {}),
        models: read.models,
        isCurrent: false,
      },
    ],
    warnings: [],
  };
}