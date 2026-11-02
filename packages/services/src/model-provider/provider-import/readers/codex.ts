// 契约形状参照 Fynvra（Apache-2.0），见 docs/specs/provider-config-import.md
// Codex 来源 reader（R1 来源 2）：解析 `~/.codex/config.toml` 的 `[model_providers.*]`
// 与 `~/.codex/auth.json` 的 OPENAI_API_KEY（env 由 scan 注入，reader 不读 process.env）。
import type { ProviderApiType } from "@acode/provider";
import type { ProviderImportWarning } from "../providerImportTypes.js";
import type { DiscoveredProvider, Env, ReaderResult } from "./common.js";
import {
  baseUrlOf,
  isRecord,
  parseJsonObject,
  parseTomlObject,
  text,
  tomlErrorLine,
} from "./common.js";

/** Codex 内置 OpenAI 端点（config.toml 未声明 base_url 时的官方默认）。 */
export const CODEX_BUILTIN_OPENAI_BASE_URL = "https://api.openai.com/v1";

function wireApiToProviderApi(wire: unknown): ProviderApiType {
  // `responses` → openai-responses；`chat` 与其余/缺省 → openai-chat-completions。
  return text(wire) === "responses" ? "openai-responses" : "openai-chat-completions";
}

/**
 * provider 表内的字面 bearer token 字段（2026-11 本机实配核实，spec 附录 A）。
 * 只认实测存在的字段名与其直接近义写法；不做宽泛猜测，避免把无关字段当密钥读。
 * 返回值是明文，只在宿主内存里流向候选 input（R4：不进视图/日志/结果）。
 */
function readProviderScopedToken(value: Record<string, unknown>): string | null {
  return text(value.experimental_bearer_token) ?? text(value.bearer_token);
}

export function readCodex(source: {
  readonly config: string | null;
  /** auth.json 文本或已解析对象（CC Switch 的 codex 行直接给对象）。 */
  readonly auth: string | Record<string, unknown> | null;
  readonly env: Env;
}): ReaderResult {
  const warnings: ProviderImportWarning[] = [];

  const configObject = source.config === null ? {} : parseTomlObject(source.config);
  if (configObject === null) {
    // TOML 解析失败 → 整个来源跳过，只给行号（smol-toml 的 message 含源码片段，绝不外泄）。
    return {
      providers: [],
      warnings: [
        {
          code: "invalid-toml",
          params: tomlErrorLine(source.config) === null ? {} : { line: tomlErrorLine(source.config)! },
        },
      ],
    };
  }

  const authObject = isRecord(source.auth)
    ? source.auth
    : source.auth === null
      ? {}
      : (parseJsonObject(source.auth) ?? {});
  if (typeof source.auth === "string" && parseJsonObject(source.auth) === null) {
    // auth.json 坏 → 只丢 key，来源与 provider 仍保留（用户可在设置页补 key）。
    warnings.push({ code: "auth-ignored", params: {} });
  }
  const authApiKey = text(authObject.OPENAI_API_KEY);

  const selectedKey = text(configObject.model_provider) ?? "openai";
  const topLevelModel = text(configObject.model);

  const rawTable = configObject.model_providers;
  if (rawTable !== undefined && !isRecord(rawTable)) {
    warnings.push({ code: "no-table", params: {} });
  }
  const table = isRecord(rawTable) ? rawTable : {};

  const providers: DiscoveredProvider[] = [];
  const entryKeys = new Set<string>();
  for (const [key, value] of Object.entries(table)) {
    if (!isRecord(value)) continue;
    // base_url 缺席即跳过该条（无法定位端点，导入没有意义）。
    const baseUrl = baseUrlOf(value.base_url);
    if (!baseUrl) continue;
    entryKeys.add(key);
    const name = text(value.name) ?? key;
    const envKey = text(value.env_key);
    let apiKey: string | undefined;
    if (envKey) {
      apiKey = text(source.env[envKey]) ?? undefined;
      // env_key 未设置 → 保留该 provider（无 key）+ 一条 warning（用户可在设置页补 key）。
      if (!apiKey) warnings.push({ code: "env-missing-key", params: { key: envKey } });
    } else if (readProviderScopedToken(value)) {
      // 2026-11 本机实配核实：真实 `[model_providers.*]` 存在的第三种 key 形态——
      // 直接在 provider 表内落一个 bearer token 字段（实测 `experimental_bearer_token`）。
      // 该字段是**本 provider 专属**凭据，比全局 auth.json 的 OPENAI_API_KEY 更具体，
      // 故优先于 requires_openai_auth；明文只进内存，绝不进视图/日志（R4）。
      apiKey = readProviderScopedToken(value) ?? undefined;
    } else if (value.requires_openai_auth === true) {
      // 不把 OpenAI 的 key 带给不需要它的端点；只有显式声明要求才复用。
      apiKey = authApiKey ?? undefined;
    }
    const isCurrent = key === selectedKey;
    providers.push({
      source: "codex",
      sourceLabel: `Codex · ${name}`,
      name,
      api: wireApiToProviderApi(value.wire_api),
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      // 顶层 model 只归属活动项。
      models: isCurrent && topLevelModel ? [{ id: topLevelModel, name: topLevelModel }] : [],
      isCurrent,
    });
  }

  if (selectedKey === "openai" && authApiKey && !entryKeys.has("openai")) {
    providers.push({
      source: "codex",
      sourceLabel: "Codex · OpenAI",
      name: "OpenAI",
      api: "openai-responses",
      baseUrl: CODEX_BUILTIN_OPENAI_BASE_URL,
      apiKey: authApiKey,
      models: topLevelModel ? [{ id: topLevelModel, name: topLevelModel }] : [],
      isCurrent: true,
    });
  }

  // 活动项在前；稳定排序保留同组原顺序。
  const ordered = providers
    .map((provider, index) => ({ provider, index }))
    .sort((left, right) => {
      const delta = Number(right.provider.isCurrent) - Number(left.provider.isCurrent);
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map((entry) => entry.provider);
  return { providers: ordered, warnings };
}