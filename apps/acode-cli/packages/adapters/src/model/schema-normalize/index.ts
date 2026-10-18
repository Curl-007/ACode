// ============================================================
// 工具 schema 多方言归一化 · 统一入口（spec R2/R6）
// ============================================================
// spec: apps/acode-cli/specs/tool-schema-normalize.md。
// 静态导出面只含**有消费者**的入口（MCP ingest、Responses、MFJS、strict 管线、
// 分发计划）；google/cca/ollama/grammar/cursor/apple 六个无消费者方言不进静态
// import 图，经 loadSchemaDialect 动态 import 按名加载（懒加载，启动路径零新增）。
// 内核全部纯函数（无 IO/无日志/无 SDK 依赖）；fail-closed 包装由插点
// （tool-transform.ts / mcp/descriptor.ts）负责，语义见 spec R4。

export type { JsonObject } from "./types.js";
export { isJsonObject, isJsonObjectEmpty } from "./types.js";

// ---- 统一入口：MCP ingest（descriptor 物化点消费） ----
export { normalizeSchemaForMCP } from "./dialect-mcp.js";

// ---- 统一入口：模型请求方言分发（tool-transform 发送点消费） ----
export {
  planHasDialectWork,
  resolveModelToolSchemaPlan,
  toolSchemaWireOfProviderKind,
  type ModelToolSchemaPlan,
  type ModelToolSchemaPlanInput,
  type ToolSchemaWire,
} from "./dialect-plan.js";

// ---- Responses 方言（必做路径） ----
export {
  normalizeSchemaForOpenAIResponses,
  sanitizeSchemaForOpenAIResponses,
} from "./dialect-openai-responses.js";

// ---- MFJS 方言（requiresMfjsToolSchema 标志路由） ----
export { normalizeSchemaForMoonshot } from "./dialect-moonshot.js";

// ---- OpenAI strict 管线（Responses strict 路径） ----
export { adaptSchemaForStrict, isStrictToolSchemaBypassed } from "./adapt.js";
export { sanitizeSchemaForStrictMode } from "./strict-sanitize.js";
export { enforceStrictSchema, StrictSchemaEnforcementError, tryEnforceStrictSchema } from "./strict-enforce.js";

// ---- 内核原语（单测与未来方言接线消费） ----
export { normalizeSchema, type NormalizeSchemaOptions } from "./normalize-core.js";
export { upgradeJsonSchemaTo202012, schemaNeedsDraft202012Upgrade } from "./draft.js";
export { dereferenceJsonSchema } from "./dereference.js";
export { isValidJsonSchema } from "./meta-validator.js";
export { spillToDescription, type DescriptionSpillFormat } from "./spill.js";
export { areJsonValuesEqual, mergeCompatibleEnumSchemas, mergePropertySchemas } from "./equality.js";

import { sanitizeSchemaForOpenAIResponses } from "./dialect-openai-responses.js";
import { normalizeSchemaForMoonshot } from "./dialect-moonshot.js";
import { planHasDialectWork, type ModelToolSchemaPlan } from "./dialect-plan.js";
import { isJsonObject, type JsonObject } from "./types.js";

/**
 * 按分发计划应用方言归一（每工具一次）。顺序照抄 omp openai-responses.ts:1920-1930
 * 的论证：**Responses sanitize → MFJS**——sanitizer 把 {} 归一为布尔 true
 * （grammar 采样器语义），Moonshot 校验器拒绝布尔子 schema，MFJS 的 permissive
 * 折叠必须最后把它重新对象化。
 *
 * 纯函数：无改写时返回原引用；归一器意外抛出**向上传播**，由发送点插点
 * （tool-transform.ts）包装为 InvalidModelRequest 拒绝发送（spec R4 fail-closed）。
 */
export function applyModelToolSchemaDialect(plan: ModelToolSchemaPlan, schema: JsonObject): JsonObject {
  if (!planHasDialectWork(plan)) return schema;
  let current: unknown = schema;
  if (plan.responsesSanitize) {
    current = sanitizeSchemaForOpenAIResponses(current as JsonObject);
  }
  if (plan.mfjs) {
    current = normalizeSchemaForMoonshot(current);
  }
  // 两个方言的产物对 JSON 对象输入恒为对象（walker 对根节点的对象性保持），
  // 防御性兜底：非对象结果按 fail-closed 语义抛出，交给插点拒绝发送。
  if (!isJsonObject(current)) {
    throw new TypeError("tool schema dialect normalization produced a non-object schema");
  }
  return current;
}

/** 无消费者方言的懒加载名录（spec R6：不进启动路径，按名动态 import）。 */
export const LAZY_SCHEMA_DIALECTS = [
  "google",
  "cca",
  "ollama",
  "grammar",
  "cursor",
  "apple-foundation-models",
] as const;

export type LazySchemaDialectName = (typeof LAZY_SCHEMA_DIALECTS)[number];

/**
 * 按名懒加载无消费者方言模块（未来接线点零重构；单测直接 import 方言文件，
 * 不经本函数）。未知名字抛错（fail-closed，不静默返回空面）。
 */
export async function loadSchemaDialect(name: LazySchemaDialectName): Promise<Record<string, unknown>> {
  switch (name) {
    case "google":
    case "cca":
      return await import("./dialect-google.js");
    case "ollama":
    case "grammar":
      return await import("./dialect-ollama-grammar.js");
    case "cursor":
      return await import("./dialect-cursor.js");
    case "apple-foundation-models":
      return await import("./apple-foundation-models.js");
  }
}
