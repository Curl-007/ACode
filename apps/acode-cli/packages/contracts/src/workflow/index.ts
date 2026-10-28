// Workflow Protocol —— 工作流的契约桶。
//
// 例外偿还（contracts-onboarding-max-file-lines-workflow-index + disable-count-workflow-index）：
// 本文件原为 892 行单体（行 1 的 max-lines 禁用头注已随拆分删除），
// 已拆为 5 个叶子并降为纯 barrel，公开导出面逐名不变：
//   - workflow-core-schema：kind/phase/status 枚举、strategy、phase 定义、definition 校验
//   - workflow-artifact-schema：typed artifact 档位、产物、阶段快照、活动种类
//   - workflow-graph-schema：节点/边/集合、planner 输出、seed、critic、图变更记录
//   - workflow-session-link-schema：会话链接、失败、事件、run snapshot 与存储端口
//   - workflow-scheduler：scheduler 状态 schema 与三个纯推导函数（依赖图末端）
// 依赖单向：core ← artifact/graph ← session-link ← scheduler；叶子只向前指，
// 本文件只 re-export，无叶子回边。
// 跨叶符号不相交（`export *` 静默丢弃重名，拆分时已逐名核对）。

export * from "./script.js";

export * from "./workflow-core-schema.js";
export * from "./workflow-artifact-schema.js";
export * from "./workflow-graph-schema.js";
export * from "./workflow-session-link-schema.js";
export * from "./workflow-scheduler.js";
