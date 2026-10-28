// 2026-12-31 例外债务偿还：原 629 行 model-config.ts 按职责拆为 3 个叶子（均 <400 行），
// 本文件降级为 barrel 保持导出面逐名不变，首行 oxlint max-lines 抑制头注随拆分删除：
// - model-option-specs.ts        Option Spec 与输入/输出格式配置族（Enum/Speed/Limit/InputFormat/OutputFormat）
// - model-properties-config.ts   Model 嵌套配置聚合族（ModelPropertiesConfig/ModelOptionSpecsConfig）
// - model-config-rules.ts        ModelConfig 与有序规则族（ModelConfigRule 联合/ModelConfigRules）
export * from "./model-option-specs.js";
export * from "./model-properties-config.js";
export * from "./model-config-rules.js";
