// ============================================================
// Todo completion confidence - pure gate & history merge (J2-1)
// ============================================================
// specs/todo-confidence-semantics.md R1–R3：completionConfidence 语义枚举、完成门槛
// （新完成转移受检 + grandfather 豁免）、工具自有 confidenceHistory 的追加规则。
// 机制参照 jcode (MIT) crates/jcode-app-core/src/tool/todo.rs:26-68（history 工具拥有、
// 每写最多一条观测、连续去重）与 crates/jcode-base/src/todo.rs:129-131,690-724
// （完成门槛 ≥Validated、文案不暴露 evaluator 语言/分数/阈值），自撰 TypeScript 实现。
// 与 ./todo-deps.ts 同一纪律：全部纯函数，不读时钟、不做 I/O、不读 DB；
// 单一实现，两处共享（handler 门槛/追加 与 contracts schema 再导出）。
// 物理家独立成文件而不是并入 todo-deps.ts：AGENTS.md 单文件 400 行上限 + 高内聚
// （D4 依赖语义与 J2-1 置信度语义是两组规则）。

import { z } from "zod";
import type { NormalizedTodo } from "./todo-deps.js";

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

/**
 * 有序 rank——**模块私有**：排序与门槛边界是实现细节，不进任何导出面、报错文案或
 * 提示词（R1/R3 保密规则；jcode「阈值与评估器对模型保密」同款）。
 */
const COMPLETION_CONFIDENCE_RANK: Record<TodoCompletionConfidence, number> = {
  speculative: 0,
  plausible: 1,
  validated: 2,
  verified: 3,
};

/** 完成门槛最小值（R3）：私有常量，理由同 rank。 */
const COMPLETION_CONFIDENCE_GATE_MIN: TodoCompletionConfidence = "validated";

/** R3：值在场且 rank ≥ 门槛最小值才过线；缺失 = 不过线（jcode completion_confidence_passes 同款）。 */
export function completionConfidencePassesGate(
  value: TodoCompletionConfidence | undefined,
): boolean {
  return (
    value !== undefined &&
    COMPLETION_CONFIDENCE_RANK[value] >= COMPLETION_CONFIDENCE_RANK[COMPLETION_CONFIDENCE_GATE_MIN]
  );
}

export interface TodoCompletionGateViolation {
  id: string;
  index: number;
}

/**
 * 对抗复核 F1（2026-09-30）：身份匹配谓词——调用方先按 id 命中 priorById，再要求
 * content 逐字相等。R3 grandfather 豁免与 R2 轨迹继承共用这一判据（单一实现，两处共享）。
 * 动机（实证洗白面）：D4 派生 id = `todo-<index>` 位置即身份，「剪掉已完成项 → 后项补位
 * 到同 id」「重排」这类日常列表整理，以及显式 id 换内容重发，在 id-only 匹配下都会让
 * 新完成转移不带任何 completionConfidence 写入成功（洗白完成门槛，显式 id 一旦 completed
 * 即成永久免检令牌），或继承前项轨迹（伪爬升，污染 J2-2 spike 检测数据源）。
 * content 变更 = 新完成转移：重新受检、轨迹从本次观测重新开始；存量 completed 原样重发
 * （content 不变）仍豁免，升级兼容不受影响。
 */
export function isSameTodoContent(submitted: NormalizedTodo, prior: NormalizedTodo): boolean {
  return prior.content === submitted.content;
}

/**
 * R3 完成门槛判定：只检**新完成转移**——旧列表同 id 且同 content（对抗复核 F1 双匹配）
 * 的项已是 completed 的豁免（grandfather：整表替换下已完成项每次重发；重检会让升级前
 * 存量 completed 项永久卡死列表，且违反旧格式兼容基线；content 匹配挡住「剪枝补位/
 * 重排/显式 id 换内容」的洗白面）。其余 completed 项（pending/in_progress→completed、
 * born-completed、重开后再完成、同 id 换内容）要求 completionConfidence 过线。
 * 纯函数，输入均为规范化后列表（id 必在）；调用点在 handler（唯一写入路径）——
 * 门槛需要旧列表，schema superRefine 层无 I/O，放不进 contracts 校验（R3 落点说明）。
 */
export function findCompletionGateViolations(
  submitted: readonly NormalizedTodo[],
  prior: readonly NormalizedTodo[],
): TodoCompletionGateViolation[] {
  const priorById = new Map<string, NormalizedTodo>();
  for (const todo of prior) {
    priorById.set(todo.id, todo);
  }
  const violations: TodoCompletionGateViolation[] = [];
  submitted.forEach((todo, index) => {
    if (todo.status !== "completed") return;
    // 对抗复核 F1：豁免 = id+content 双匹配（isSameTodoContent 单一实现，与 R2 轨迹继承共用）；
    // id-only 匹配会让补位/换内容的新完成转移洗白门槛。
    const priorTodo = priorById.get(todo.id);
    if (
      priorTodo !== undefined &&
      priorTodo.status === "completed" &&
      isSameTodoContent(todo, priorTodo)
    ) {
      return;
    }
    if (completionConfidencePassesGate(todo.completionConfidence)) return;
    violations.push({ id: todo.id, index });
  });
  return violations;
}

/**
 * R3 报错文案：点名全部违规 id；**禁止**出现枚举值单词、threshold/at least、rank/排序、
 * 数值边界——模型应从证据出发重估，而不是瞄准门槛边界报值（jcode
 * build_todo_completion_continuation_message「不暴露 evaluator 语言、分数、阈值」同款）。
 * 「缺失」与「不足」共用单一模板：区分它们等于告诉模型哪个值不够，泄露边界。
 */
export function completionGateErrorMessage(
  violations: readonly TodoCompletionGateViolation[],
): string {
  const named = violations.map((violation) => `"${violation.id}"`).join(", ");
  const subject = violations.length === 1 ? `todo ${named} is` : `todos ${named} are`;
  return `${subject} marked completed without sufficient completion evidence; run the checks that prove the work is done, then report completionConfidence from the evidence you actually have`;
}

/**
 * R2 追加规则（每次 TodoWrite 每项最多一条观测）：观测缺席 → 原样返回
 * （undefined 保持 undefined，不物化空数组——旧格式项读写前后逐字节不变，零回归）；
 * 与末位相同 → 连续去重；不同 → 追加；超窗口 → 滑动保留最新 TODO_CONFIDENCE_HISTORY_MAX 条。
 * 纯函数，不改入参。
 */
export function appendConfidenceObservation(
  priorHistory: readonly TodoCompletionConfidence[] | undefined,
  observation: TodoCompletionConfidence | undefined,
): readonly TodoCompletionConfidence[] | undefined {
  if (observation === undefined) return priorHistory;
  const base = priorHistory ?? [];
  const next = base[base.length - 1] === observation ? [...base] : [...base, observation];
  return next.length > TODO_CONFIDENCE_HISTORY_MAX
    ? next.slice(next.length - TODO_CONFIDENCE_HISTORY_MAX)
    : next;
}
