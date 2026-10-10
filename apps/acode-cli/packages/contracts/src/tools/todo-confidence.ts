// ============================================================
// Todo completion confidence - schema vocabulary (J2-1)
// ============================================================
// specs/todo-confidence-semantics.md R1–R3：completionConfidence 语义枚举与
// confidence_json 持久化列 schema。
// 机制参照 jcode (MIT) crates/jcode-app-core/src/tool/todo.rs:26-68（history 工具拥有、
// 每写最多一条观测、连续去重）与 crates/jcode-base/src/todo.rs:129-131,690-724
// （完成门槛 ≥Validated、文案不暴露 evaluator 语言/分数/阈值），自撰 TypeScript 实现。
// 架构断环拆分（specs/architecture-contracts-module.md）：依赖 NormalizedTodo 的门槛/
// 追加纯函数已拆到 ./todo-confidence-gate.ts——todo-deps.ts 的 TodoItem schema 链需要
// 本文件的枚举 schema，本文件若再引用 todo-deps 的类型即成 todo-deps ↔ todo-confidence
// 文件级 import 环。本文件保持叶子地位：只依赖 zod，不导入任何内部模块。
// todo.ts 对消费方原样再导出两个文件，导出面与 spec「接口」节一致。

import { z } from "zod";

/**
 * 工具自有 confidenceHistory 的滑动窗口上界（R2）：超限保留最新观测。
 * 与 metadata 的「超限报错不截断」不同——history 是工具自有数据，报错会让模型为
 * 工具自己的累积负责（无法通过修改提交来修复）；4 个枚举值 + 连续去重下，
 * 溢出需要 ≥16 次震荡改写，属病态路径，窗口保存储有界（≈200B/项）。
 */
export const TODO_CONFIDENCE_HISTORY_MAX = 16;

/**
 * R1 语义有序枚举（替代 jcode 的 legacy 0-100 数值分；ACode 无数值分历史，不做映射）。
 * 成员顺序即语义强度：speculative < plausible < validated < verified。
 */
export const TodoCompletionConfidenceSchema = z.enum([
  "speculative",
  "plausible",
  "validated",
  "verified",
]);

export type TodoCompletionConfidence = z.infer<typeof TodoCompletionConfidenceSchema>;

/**
 * confidence_json 持久化列的形状（adapters 编解码共用；R5，与 deps_json 同款做法）。
 * strict：未来新成员必须由新版本代码显式加宽，旧代码 safeParse 失败即整列忽略
 * （= 回滚策略「忽略该列」，不牵连 deps_json 的既有承诺）。
 */
export const TodoConfidenceJsonSchema = z
  .object({
    completionConfidence: TodoCompletionConfidenceSchema.optional(),
    confidenceHistory: z
      .array(TodoCompletionConfidenceSchema)
      .max(TODO_CONFIDENCE_HISTORY_MAX)
      .optional(),
  })
  .strict();

export type TodoConfidenceJson = z.infer<typeof TodoConfidenceJsonSchema>;
