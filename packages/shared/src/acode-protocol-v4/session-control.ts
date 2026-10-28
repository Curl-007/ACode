// M2-2 session 控制面的 command result variants（spec apps/acode-cli/specs/m2-2-session-control.md）。
// 独立成叶的原因与 script-workflow-management.ts 同：command.ts 受 max-lines 400 门禁约束，
// result variant 实体放本叶，command.ts 的 commandResultSchema 仅列引用。
import { z } from "zod";
// goal wire 形态复用 legacy-types 叶（M4 后唯一幸存面；符号已在 scripts/architecture/
// protocol-boundary.mjs 白名单显式登记）。
import { acodeSessionGoalSchema } from "../acode-protocol-legacy-types.js";

/**
 * goal 控制四命令（sendGoalCommand/pauseGoal/resumeGoal/clearGoal）原地执行后的结构化回执
 * ——legacy session/goal 的 {response, startedTurn} 契约等价物。无本地投影的 host facade
 * 据此推导 legacy 回执文案（"No goal to …" / formatGoalChanged），不必用 ACK 后读回快照
 * 竞态猜目标在裁决时刻的存在性。入队收口（busy 时 sendGoalCommand 走 FIFO）不带本
 * variant——facade 按 startedTurn=false 收口（v4 原生排队语义）。
 */
export const goalControlResultSchema = z.object({
  type: z.literal("goalControl"),
  action: z.enum(["set", "pause", "resume", "clear"]),
  // 裁决前目标存在性（clear/pause/resume 的 "No goal to …" 判据；set 时 =
  // replacesExistingGoal——旧重复 set 收敛 replace 的广播 reason 分支）。
  hadTarget: z.boolean(),
  // 裁决后目标 wire 态（clear 恒 null；pause/resume 无目标恒 null）。
  target: acodeSessionGoalSchema.nullable(),
  // = legacy continueGoalAfterChange 的 canContinue（!isPlanMode && !activeAbortController）；
  // pause/clear 恒 false。
  startedTurn: z.boolean(),
  // set 落库遇 plan 模式未续跑（legacy 在 response 尾部追加
  // 「Plan mode 下已记录 goal，但不会自动继续。」的事实源）。
  planContinuationSkipped: z.boolean().optional(),
});
export type GoalControlResult = z.infer<typeof goalControlResultSchema>;

/**
 * closeSession 的 expectedPersistence 断言裁决结果（closed:false = 断言不匹配 graceful
 * no-op；closed:true = 已执行关闭）。deleteSession 无本 variant（无条件关闭）。
 */
export const closeSessionResultSchema = z.object({
  type: z.literal("closeSession"),
  closed: z.boolean(),
});
export type CloseSessionResult = z.infer<typeof closeSessionResultSchema>;
