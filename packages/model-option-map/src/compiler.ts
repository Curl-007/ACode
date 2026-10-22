import { evaluateRestrictedCel } from "./evaluator.js";
import { parseRestrictedCel, type RestrictedCelExpression } from "./parser.js";
import { tokenizeRestrictedCel } from "./tokenizer.js";
import { createBoundedCache } from "./bounded-cache.js";
import {
  RestrictedCelError,
  type JsonObject,
  type ModelOptionName,
  type ModelOptionMapProgram,
  type RestrictedCelProgram,
  type RestrictedCelValue,
} from "./types.js";

/**
 * 编译缓存的条目上限。
 *
 * 根因（review 测试专项 P3）：原来三个缓存是裸 `new Map()`，按「源码字符串 + 变量名」为键，
 * 且模块级永不淘汰。虽然生产中模型选项映射数量有限，但键空间由**外部可控的源码字符串**
 * 组成（每个 Provider/Model 的 map 源、任意历史版本、错误配置），进程长生命周期下只增不减，
 * 构成无界内存增长。上限取 512：远高于任何现实配置规模（数十个 Provider），又能把最坏
 * 驻留量钉死在常量级；超限按 LRU 淘汰最久未用条目。淘汰不影响语义——未命中只是重新
 * parse/compile，结果与缓存命中逐字节一致（compileRestrictedCel 等对同一输入是纯函数）。
 */
const CACHE_MAX_ENTRIES = 512;

const programCache = createBoundedCache<RestrictedCelProgram>(CACHE_MAX_ENTRIES);
const optionMapCache = createBoundedCache<ModelOptionMapProgram>(CACHE_MAX_ENTRIES);
const expressionCache = createBoundedCache<RestrictedCelExpression>(CACHE_MAX_ENTRIES);

export function compileRestrictedCel(
  source: string,
  variableName: ModelOptionName,
): RestrictedCelProgram {
  const normalizedSource = normalizeSource(source);
  const cacheKey = createCacheKey(normalizedSource, variableName);
  const cached = programCache.get(cacheKey);
  if (cached) return cached;

  const expression = parseExpression(normalizedSource, variableName);
  const program: RestrictedCelProgram = Object.freeze({
    source: normalizedSource,
    evaluate: (input: RestrictedCelValue) => evaluateRestrictedCel(expression, input),
  });
  programCache.set(cacheKey, program);
  return program;
}

export function compileModelOptionMap(
  source: string,
  variableName: ModelOptionName,
): ModelOptionMapProgram {
  const normalizedSource = normalizeSource(source);
  const cacheKey = createCacheKey(normalizedSource, variableName);
  const cached = optionMapCache.get(cacheKey);
  if (cached) return cached;
  const expression = parseExpression(normalizedSource, variableName);
  assertObjectResultExpression(expression);
  const program: ModelOptionMapProgram = Object.freeze({
    source: normalizedSource,
    evaluate(input: RestrictedCelValue): JsonObject {
      const result = evaluateRestrictedCel(expression, input);
      if (!isJsonObject(result)) {
        throw new RestrictedCelError("model option map must return a JSON object", 0);
      }
      return result;
    },
  });
  optionMapCache.set(cacheKey, program);
  return program;
}

function normalizeSource(source: string): string {
  const normalizedSource = source.trim();
  if (normalizedSource.length === 0) {
    throw new RestrictedCelError("expression must not be empty", 0);
  }
  return normalizedSource;
}

function parseExpression(source: string, variableName: ModelOptionName): RestrictedCelExpression {
  const cacheKey = createCacheKey(source, variableName);
  const cached = expressionCache.get(cacheKey);
  if (cached) return cached;
  const expression = parseRestrictedCel(tokenizeRestrictedCel(source), variableName);
  expressionCache.set(cacheKey, expression);
  return expression;
}

function createCacheKey(source: string, variableName: ModelOptionName): string {
  return `${variableName}\0${source}`;
}

function assertObjectResultExpression(expression: RestrictedCelExpression): void {
  if (expression.type === "object") return;
  if (expression.type === "conditional") {
    assertObjectResultExpression(expression.whenTrue);
    assertObjectResultExpression(expression.whenFalse);
    return;
  }
  throw new RestrictedCelError("model option map must return a JSON object", expression.offset);
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
