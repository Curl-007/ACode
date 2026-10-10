/**
 * 模型选项映射模块清单。
 *
 * 编译后的表达式与求值结果由本模块唯一拥有；消费者只能通过 contract.ts
 *（或保持兼容的 index.ts 包根入口）使用公开 API，不读取 parser/evaluator 内部实现。
 */
export const modelOptionMapModule = {
  id: "model-option-map",
  requires: [],
  provides: ["model-option-map-compiler", "model-option-map-evaluator"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
