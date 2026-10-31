// 2026-12-31 例外债务偿还：model.ts（原 920 行）按职责拆为 ./model/ 五叶——
// types（类型定义）/ profiles（静态数据）/ decisions（裁决构造器）/
// evaluate（裁决表）/ trace（trace 构建与统计）。本文件保留为公开入口 barrel，
// 逐名转发与原导出面逐名一致（25 个符号），消费方（contract.ts、main.ts、
// test/model.test.ts）零改动。

export type {
  Candidate,
  CandidateKind,
  CompactMemory,
  Decision,
  DecisionKind,
  GoalState,
  ModelProfile,
  NodeKind,
  ProductContext,
  QueueState,
  RunPhase,
  TraceNode,
  TraceStats,
  TurnTarget,
} from "./model/types.js";

export { profiles, userCandidates } from "./model/profiles.js";

export { evaluate } from "./model/evaluate.js";

export {
  buildTraceTree,
  collectStats,
  contextKey,
  contextLabel,
  decisionLabel,
  enumerateCandidates,
  flatten,
  resetIds,
} from "./model/trace.js";
