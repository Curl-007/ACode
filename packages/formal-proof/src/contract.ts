/**
 * formal-proof 的唯一公开契约（架构治理登记面）。
 *
 * 逐名转发 model.ts（包导出 `@acode/formal-proof/model`）的公开面；两者同时
 * 登记为 publicEntrypoints。main.ts（d3 渲染）与 styles.css 是 vite 应用内部
 * 实现，不出包、不入契约。
 *
 * 模型不变量（类型之外的部分见 CONTRACT.md）：evaluate 是纯函数裁决表——
 * 同一 (context, candidate) 恒得同一 Decision；held 状态输入不静默入队，
 * 由用户选择「清空 queue 后发送 / 保留 queue 立即发送」。trace 节点编号是
 * 模型唯一可变状态，buildTraceTree 入口先 resetIds，输出对同一输入确定。
 */

// 核心词汇：运行阶段 / 队列 / 压缩记忆 / 目标 / 选中回合 / 裁决类别 / 节点类别
export type {
  RunPhase,
  QueueState,
  CompactMemory,
  GoalState,
  TurnTarget,
  CandidateKind,
  DecisionKind,
  NodeKind,
} from "./model.js";

// 模型数据结构：产品上下文、候选输入、裁决结果、trace 树与统计
export type {
  ProductContext,
  Candidate,
  Decision,
  TraceNode,
  TraceStats,
  ModelProfile,
} from "./model.js";

// 模型数据：预置上下文剖面与用户候选输入
export { profiles, userCandidates } from "./model.js";

// 裁决与 trace：纯函数（evaluate 裁决表、buildTraceTree/collectStats/flatten、标签与 key 工具）
export {
  resetIds,
  contextLabel,
  contextKey,
  enumerateCandidates,
  buildTraceTree,
  collectStats,
  flatten,
  decisionLabel,
  evaluate,
} from "./model.js";
