const CONTEXT_USAGE_TOP_CONTRIBUTOR_LIMIT = 5;

/**
 * P5 占比判据的分子类目（specs/tools-schema-token-metrics.md R2）：schema 本体两类。
 * `tool_prompt`（工具相关提示词段）刻意不计入——判据对象是 tools schema，提示词段的
 * 承载层去重归 P1/P2 治理。
 */
const TOOL_SCHEMA_CATEGORY_SOURCES = new Set(["system_tool_schemas", "mcp_tool_schemas"]);

export function compactContextUsageSnapshot(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const toolSchemaRatioPercent = computeToolSchemaRatioPercent(snapshot);
  return {
    tokenMethod: snapshot.tokenMethod,
    confidence: snapshot.confidence,
    tokenizer: snapshot.tokenizer,
    totalChars: snapshot.totalChars,
    totalTokens: snapshot.totalTokens,
    model: snapshot.model,
    // P5 判据字段（R2）：两类 tools schema token 占本请求总上下文 token 的百分比，
    // 「>15% 才立项 ToolSearch」的直接可读形态。只在日志投影层派生——快照本体
    // （buildContextUsageSnapshot 返回值）与它的既有消费者形状零变化。
    ...(toolSchemaRatioPercent === undefined ? {} : { toolSchemaRatioPercent }),
    categories: snapshot.categories,
    categoryBreakdown: compactCategoryBreakdown(snapshot.categoryBreakdown),
    messageBreakdown: snapshot.messageBreakdown,
    mcpToolCount: arrayLength(snapshot.mcpTools),
    skillCount: arrayLength(snapshot.skills),
    systemPromptSectionCount: arrayLength(snapshot.systemPromptSections),
    systemToolCount: arrayLength(snapshot.systemTools),
    warningCount: arrayLength(snapshot.warnings),
  };
}

/**
 * `(system_tool_schemas.tokens + mcp_tool_schemas.tokens) / totalTokens × 100`。
 * 分母非法（缺席/非有限/≤0）时返回 undefined——除零不产出假数字（R2），字段缺席。
 */
function computeToolSchemaRatioPercent(snapshot: Record<string, unknown>): number | undefined {
  const totalTokens = snapshot.totalTokens;
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens <= 0) {
    return undefined;
  }
  const categories = Array.isArray(snapshot.categories) ? snapshot.categories.filter(isRecord) : [];
  const schemaTokens = categories.reduce((sum, category) => {
    const source = category.source;
    const tokens = category.tokens;
    if (typeof source !== "string" || !TOOL_SCHEMA_CATEGORY_SOURCES.has(source)) {
      return sum;
    }
    return typeof tokens === "number" && Number.isFinite(tokens) ? sum + tokens : sum;
  }, 0);
  return (schemaTokens / totalTokens) * 100;
}

function compactCategoryBreakdown(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(isRecord).map((category) => {
    const contributors = Array.isArray(category.contributors)
      ? category.contributors.filter(isRecord)
      : [];
    return {
      ...pickDefined(category, [
        "chars",
        "confidence",
        "name",
        "percentTokens",
        "source",
        "tokenMethod",
        "tokens",
        "tokenizer",
      ]),
      contributorCount: contributors.length,
      contributors: contributors
        .toSorted((left, right) => contributorSortValue(right) - contributorSortValue(left))
        .slice(0, CONTEXT_USAGE_TOP_CONTRIBUTOR_LIMIT)
        .map(compactContextUsageContributor),
    };
  });
}

function compactContextUsageContributor(
  contributor: Record<string, unknown>,
): Record<string, unknown> {
  return pickDefined(contributor, [
    "cacheHint",
    "categorySource",
    "chars",
    "confidence",
    "count",
    "injectionTarget",
    "kind",
    "label",
    "name",
    "path",
    "readOnly",
    "role",
    "scope",
    "serverName",
    "sideEffectScope",
    "source",
    "tokenMethod",
    "tokens",
    "tokenizer",
  ]);
}

function pickDefined(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

function contributorSortValue(contributor: Record<string, unknown>): number {
  const tokens = contributor.tokens;
  if (typeof tokens === "number" && Number.isFinite(tokens)) {
    return tokens;
  }
  const chars = contributor.chars;
  if (typeof chars === "number" && Number.isFinite(chars)) {
    return chars;
  }
  const count = contributor.count;
  return typeof count === "number" && Number.isFinite(count) ? count : 0;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
