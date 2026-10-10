import { compileModelOptionMaps, type JsonObject } from "./contract.js";

/**
 * 最小消费示例：在模型创建阶段编译一次，随后为请求绑定本轮选项。
 * 示例不持有第二份编译缓存，也不绕过模块契约访问 parser/evaluator。
 */
export function applyModelOptions(body: JsonObject): JsonObject {
  const maps = compileModelOptionMaps({
    reasoningLevel: { map: '{"reasoning_effort": reasoningLevel}' },
    maxOutputTokens: { map: '{"max_output_tokens": maxOutputTokens}' },
  });
  return maps.apply(body, { reasoningLevel: "high", maxOutputTokens: 4096 });
}
