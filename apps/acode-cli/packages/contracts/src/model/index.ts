// ============================================================
// Model Protocol - provider-neutral model contracts
// ============================================================
// 架构断环下沉（specs/architecture-contracts-module.md）：被 model/model.ts、
// model/invocation-context.ts、telemetry/index.ts 反向引用的基础类型与请求治理类型
// 分别下沉到 ./protocol-types.ts 与 ./request-status.ts（本文件对两者 `export *`，
// 公开导出面逐名不变）。禁止在本文件新增对 telemetry/index.ts 或 session/events 桶文件的导入。
//
// 例外偿还（contracts-onboarding-max-file-lines-model-index + disable-count-model-index）：
// 本文件原为 541 行单体（行 1 的 max-lines 禁用头注已随拆分删除），
// 已把错误/工厂、usage 投影与请求聚合、JSON schema 常量分别拆到 model-errors、
// model-usage、model-json-schema 三个叶子；本文件降为纯 barrel，公开导出面逐名不变。
// 依赖单向：叶子只引用 protocol-types / request-status 基础叶，无叶子回边。
// 拆分前的头注注释保留原意：错误/工厂、usage 投影函数、请求聚合类型与 JSON schema 常量
// 只被上游（events/session、tools、core 消费方）引用，不构成回边。

export * from "./protocol-types.js";
export * from "./request-status.js";
export * from "./image-media.js";
export * from "./model.js";
export * from "./invocation-context.js";

// —— 例外偿还批次 A 新叶子（与上方基础叶符号不相交）——
export * from "./model-errors.js";
export * from "./model-usage.js";
export * from "./model-json-schema.js";

// Re-export for backwards compatibility with code using ToolCall
export type { ModelToolCall as ToolCall } from "./protocol-types.js";

export * from "./content-protection.js";
