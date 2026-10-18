// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/types.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// schema-normalize 内核基础类型
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md R7。
// JsonObject 与 contracts 的 JsonSchema（Record<string, unknown>）同构：
// omptype/TSchema 依赖降解为普通 JSON Schema 对象表示。

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** value 是无自有可枚举键的普通 JSON 对象（空 schema `{}`）。 */
export function isJsonObjectEmpty(value: JsonObject): boolean {
  return Object.keys(value).length === 0;
}
