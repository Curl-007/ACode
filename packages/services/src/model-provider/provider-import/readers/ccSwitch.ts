// 契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md
// CC Switch 来源 reader（R1 来源 3）：把 `cc-switch.db` 的 `providers` 行（由 locate 复制后
// 只读读出）解析为候选。claude 行复用来源 1 的 reader；codex 行复用来源 2 的 reader；
// gemini 行跳过 + 结构化告警（ACode 无对应协议值，**不新增第四种协议**，EI-146）。
import type { ProviderApiType } from "@acode/provider";
import type { ProviderImportWarning } from "../providerImportTypes.js";
import { CLAUDE_CODE_DISPLAY, readAnthropicSettings } from "./claudeCode.js";
import { readCodex } from "./codex.js";
import type { DiscoveredProvider, Env, ReaderResult } from "./common.js";
import { isRecord, parseJsonObject, text } from "./common.js";

type CcSwitchAppType = "claude" | "codex" | "gemini";

const APP_TYPE_ORDER: readonly CcSwitchAppType[] = ["claude", "codex", "gemini"];

/** API Format → ACode 协议；认不出返回 null（由 app_type 兜底）。 */
function mapApiFormat(value: string | null): ProviderApiType | null {
  switch (value) {
    case "anthropic":
      return "anthropic-messages";
    case "openai_responses":
      return "openai-responses";
    case "openai_chat":
      return "openai-chat-completions";
    default:
      return null;
  }
}

/** is_current 兼容 SQLite 的 0/1 与文本/布尔形态。 */
function isCurrentValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/** settings_config 可能是 JSON 文本或已是对象（不同版本写入形态不一）。 */
function settingsConfigObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  return parseJsonObject(text(value));
}

function indexOfRow(rows: readonly Record<string, unknown>[]): Map<Record<string, unknown>, number> {
  const map = new Map<Record<string, unknown>, number>();
  rows.forEach((row, index) => map.set(row, index));
  return map;
}

export function readCcSwitch(
  rows: readonly Record<string, unknown>[],
  env: Env,
): ReaderResult {
  const providers: DiscoveredProvider[] = [];
  const warnings: ProviderImportWarning[] = [];
  const positions = indexOfRow(rows);
  const groups: Record<CcSwitchAppType, Record<string, unknown>[]> = {
    claude: [],
    codex: [],
    gemini: [],
  };
  let unsupportedAppTypes = 0;
  for (const row of rows) {
    const appType = text(row.app_type)?.toLowerCase();
    if (appType === "claude" || appType === "codex" || appType === "gemini") {
      groups[appType].push(row);
    } else {
      unsupportedAppTypes += 1;
    }
  }

  let geminiSkipped = 0;
  for (const appType of APP_TYPE_ORDER) {
    const ordered = [...groups[appType]].sort((left, right) => {
      // 组内 is_current 在前，其余按行序（稳定）。
      const delta = Number(isCurrentValue(right.is_current)) - Number(isCurrentValue(left.is_current));
      return delta !== 0 ? delta : (positions.get(left) ?? 0) - (positions.get(right) ?? 0);
    });
    for (const row of ordered) {
      if (appType === "gemini") {
        // gemini 行有 base_url/key，但 ACode 协议枚举无 google 值 → 跳过并聚合告警（不静默）。
        geminiSkipped += 1;
        continue;
      }
      const result = appType === "claude" ? readClaudeRow(row) : readCodexRow(row, env);
      providers.push(...result.providers);
      warnings.push(...result.warnings);
    }
  }

  if (unsupportedAppTypes > 0) {
    warnings.push({ code: "unsupported-app-type", params: { count: unsupportedAppTypes } });
  }
  if (geminiSkipped > 0) {
    warnings.push({ code: "unsupported-api-format", params: { count: geminiSkipped } });
  }
  return { providers, warnings };
}

function readClaudeRow(row: Record<string, unknown>): ReaderResult {
  const settings = settingsConfigObject(row.settings_config);
  if (settings === null) {
    // 单行坏不整源放弃：只告警跳过该行。
    return { providers: [], warnings: [{ code: "config-invalid-json", params: {} }] };
  }
  const read = readAnthropicSettings(settings);
  if (!read.baseUrl && !read.apiKey) return { providers: [], warnings: [] };
  const meta = settingsConfigObject(row.meta) ?? {};
  const api = mapApiFormat(text(meta.apiFormat)) ?? "anthropic-messages";
  const name = text(row.name) ?? read.primaryName ?? CLAUDE_CODE_DISPLAY;
  return {
    providers: [
      {
        source: "cc-switch",
        sourceLabel: `CC Switch · ${name}`,
        name,
        api,
        baseUrl: read.baseUrl ?? "",
        ...(read.apiKey ? { apiKey: read.apiKey } : {}),
        models: read.models,
        isCurrent: isCurrentValue(row.is_current),
      },
    ],
    warnings: [],
  };
}

function readCodexRow(row: Record<string, unknown>, env: Env): ReaderResult {
  const settings = settingsConfigObject(row.settings_config);
  if (settings === null) {
    return { providers: [], warnings: [{ code: "config-invalid-json", params: {} }] };
  }
  const authValue = settings.auth;
  const configText = text(settings.config);
  const authEmpty =
    authValue === undefined ||
    authValue === null ||
    (isRecord(authValue) && Object.keys(authValue).length === 0);
  // 两者都空 → 该行无内容，跳过（正常，不告警）。
  if (!configText && authEmpty) return { providers: [], warnings: [] };
  // 复用来源 2 的解析：config 文本坏 → 返回空 + invalid-toml（该行告警跳过）。
  const result = readCodex({
    config: configText,
    auth: isRecord(authValue) ? authValue : null,
    env,
  });
  const current = isCurrentValue(row.is_current);
  const providers = result.providers.map((provider) => ({
    ...provider,
    source: "cc-switch" as const,
    sourceLabel: `CC Switch · ${provider.name}`,
    isCurrent: current || provider.isCurrent,
  }));
  return { providers, warnings: result.warnings };
}