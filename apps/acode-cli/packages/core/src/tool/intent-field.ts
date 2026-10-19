// ============================================================
// 工具调用 intent 字段（specs/tool-intent-field.md）
// ============================================================
// 机制参照 oh-my-pi (MIT) — packages/wire/src/index.ts INTENT_FIELD="i" 与
// packages/coding-agent/src/utils/tool-schema.ts 的注入守卫。单一事实源：
// 字段名、开关、schema 指引文案、注入/剥离纯函数全部在本文件。

import type { JsonSchema } from "@acode/contracts";

/** 顶层意图参数键（omp INTENT_FIELD 同名同义：一句话意图，显示用，不参与执行）。 */
export const TOOL_INTENT_FIELD = "i";
/** 灰度开关：ACODE_TOOL_INTENT=1 显式开启，缺省关闭（spec R1）。 */
export const TOOL_INTENT_ENV = "ACODE_TOOL_INTENT";

export const TOOL_INTENT_PARAMETER_DESCRIPTION =
  "One-sentence intent of this call (what you are doing and why), shown to the user in the transcript; not used for execution. Keep it under ~12 words.";

export function isToolIntentFieldEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[TOOL_INTENT_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 工具 schema 是否自有 `i` 属性（注入让位、剥离豁免的判据，omp schemaDefinesProperty 同款）。 */
export function toolSchemaOwnsIntentField(inputSchema: JsonSchema | undefined): boolean {
  if (!isPlainRecord(inputSchema)) return false;
  return isPlainRecord(inputSchema.properties) && TOOL_INTENT_FIELD in inputSchema.properties;
}

/**
 * R2 注入（纯函数，不改原对象）：非 object 形态 / 无 properties / 已自有 `i` → 原样返回。
 * `i` 不进 required：缺席合法，模型可忽略。
 */
export function injectToolIntentParameter(inputSchema: JsonSchema): JsonSchema {
  if (!isPlainRecord(inputSchema) || inputSchema.type !== "object") return inputSchema;
  const properties = inputSchema.properties;
  if (!isPlainRecord(properties) || TOOL_INTENT_FIELD in properties) return inputSchema;
  return {
    ...inputSchema,
    properties: {
      ...properties,
      [TOOL_INTENT_FIELD]: {
        type: "string",
        description: TOOL_INTENT_PARAMETER_DESCRIPTION,
      },
    },
  };
}

/** R3 剥离：删除顶层 `i` 并返回修剪后的意图；非 record / 无 `i` 原样透传。 */
export function stripToolIntentField(input: unknown): { input: unknown; intent?: string } {
  if (!isPlainRecord(input) || !(TOOL_INTENT_FIELD in input)) return { input };
  const intent = input[TOOL_INTENT_FIELD];
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (key !== TOOL_INTENT_FIELD) rest[key] = input[key];
  }
  return {
    input: rest,
    ...(typeof intent === "string" && intent.trim().length > 0 ? { intent: intent.trim() } : {}),
  };
}
