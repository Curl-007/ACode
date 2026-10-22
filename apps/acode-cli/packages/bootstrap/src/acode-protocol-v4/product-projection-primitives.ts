// 通用值 helper（product-projection.ts 拆分批次 1，specs/product-projection-structure.md §4）。
// 纯函数叶子：无 this 依赖、无共享状态，被投影各域 helper 复用。抽出不改任何语义。

/** 有限正整数取值，否则回退（用于 attempt/maxAttempts 等计数字段的防御归一）。 */
export function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 有限非负整数取值，否则回退（用于 delayMs/tokens 等非负计数字段）。 */
export function nonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** 纯记录判定（排除 null 与数组）：payload/input 结构收窄的单一谓词。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空字符串取值，否则 undefined（缺席 ≠ 空串语义）。 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
