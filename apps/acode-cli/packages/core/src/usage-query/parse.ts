// /usage 参数解析（闭集）。裁决记录：
// - `models[:N]` 的 N = 天数（spec 括注「按天模型细分」把该 scope 绑在天维度上；
//   模型条目本身不设上限——dayModels 聚合后模型数天然很小）。
// - `days:N` 上限 365：usage 账本保留 30 天（adapters repositories/usage.ts
//   USAGE_RETENTION_DAYS），更大窗口只是空桶，但仍允许查询（如实呈现空数据）。
// - N=0 与超上限一律走可读回执（outOfRange），不静默 clamp——闭集参数不允许二义。
import type {
  UsageQueryParseError,
  UsageQueryParseResult,
  UsageQueryScope,
} from "./types.js";

export const CURRENT_WINDOW_MINUTES = 30;

export const USAGE_DAYS_RANGE = { min: 1, max: 365 } as const;
export const USAGE_SESSIONS_LIMIT_RANGE = { min: 1, max: 100 } as const;
export const USAGE_MODELS_DAYS_RANGE = { min: 1, max: 90 } as const;
export const USAGE_SESSIONS_DEFAULT_LIMIT = 10;
export const USAGE_MODELS_DEFAULT_DAYS = 7;

const COLON_SCOPES = ["days", "sessions", "models", "workspace", "session"] as const;

export function parseUsageQueryArgs(rawArgs: string): UsageQueryParseResult {
  const token = rawArgs.trim();
  if (token.length === 0) {
    return { ok: true, scope: { kind: "range", range: "today", days: 1 } };
  }

  const lower = token.toLowerCase();
  if (lower === "today") return { ok: true, scope: { kind: "range", range: "today", days: 1 } };
  if (lower === "week") return { ok: true, scope: { kind: "range", range: "week", days: 7 } };
  if (lower === "current") return { ok: true, scope: { kind: "current" } };
  // `sessions` / `models` 不带 N 时的默认值在解析层给出，取数层不再兜底。
  if (lower === "sessions") {
    return { ok: true, scope: { kind: "sessions", limit: USAGE_SESSIONS_DEFAULT_LIMIT } };
  }
  if (lower === "models") {
    return { ok: true, scope: { kind: "models", days: USAGE_MODELS_DEFAULT_DAYS } };
  }

  const colonIndex = token.indexOf(":");
  if (colonIndex > 0) {
    const head = token.slice(0, colonIndex).toLowerCase();
    if ((COLON_SCOPES as readonly string[]).includes(head)) {
      const rest = token.slice(colonIndex + 1).trim();
      return parseColonScope(head, rest, token);
    }
  }

  // 无冒号且非关键词：带空格说明用户给了多个参数，单独给更贴切的回执。
  if (/\s/.test(token)) {
    return { ok: false, error: { code: "multipleArgs", value: token } };
  }
  return { ok: false, error: { code: "unknownScope", value: token } };
}

function parseColonScope(
  head: string,
  rest: string,
  token: string,
): UsageQueryParseResult {
  if (head === "workspace") {
    // 关键词允许含空格（目录名可能带空格），整个剩余段都是关键词。
    if (rest.length === 0) {
      return { ok: false, error: { code: "emptyKeyword", value: token } };
    }
    return { ok: true, scope: { kind: "workspace", keyword: rest } };
  }
  if (head === "session") {
    if (rest.length === 0) {
      return { ok: false, error: { code: "emptyPrefix", value: token } };
    }
    return { ok: true, scope: { kind: "session", prefix: rest } };
  }
  if (/\s/.test(rest)) {
    return { ok: false, error: { code: "multipleArgs", value: token } };
  }
  const parsed = parseCount(rest, head === "days" ? "days" : "limit");
  if (!parsed.ok) return parsed;
  if (head === "days") {
    return boundScope(parsed.value, USAGE_DAYS_RANGE, "days", token, (days) => ({
      kind: "range",
      range: "days",
      days,
    }));
  }
  if (head === "sessions") {
    return boundScope(
      parsed.value,
      USAGE_SESSIONS_LIMIT_RANGE,
      "limit",
      token,
      (limit) => ({ kind: "sessions", limit }),
    );
  }
  return boundScope(parsed.value, USAGE_MODELS_DAYS_RANGE, "days", token, (days) => ({
    kind: "models",
    days,
  }));
}

function parseCount(
  rest: string,
  field: "days" | "limit",
): { ok: true; value: number } | { ok: false; error: UsageQueryParseError } {
  // 只接受十进制整数（拒绝 +3 / 3.5 / ３ 等形态），超大数字走 outOfRange 回执。
  if (!/^\d{1,12}$/.test(rest)) {
    return { ok: false, error: { code: "invalidNumber", value: rest, field } };
  }
  return { ok: true, value: Number(rest) };
}

function boundScope(
  value: number,
  range: { min: number; max: number },
  field: "days" | "limit",
  token: string,
  build: (value: number) => UsageQueryScope,
): UsageQueryParseResult {
  if (value < range.min || value > range.max) {
    return {
      ok: false,
      error: { code: "outOfRange", value: token, field, min: range.min, max: range.max },
    };
  }
  return { ok: true, scope: build(value) };
}
