// ============================================================
// Todo completion confidence - gate & history merge functions (J2-1)
// ============================================================
// 架构断环拆分（specs/architecture-contracts-module.md）：这些纯函数原住在
// todo-confidence.ts，但其中 isSameTodoContent / findCompletionGateViolations 依赖
// todo-deps.ts 的 NormalizedTodo，而 todo-deps.ts 的 TodoItem schema 链又需要
// todo-confidence.ts 的枚举 schema，构成 todo-deps ↔ todo-confidence 文件级 import 环。
// 按「schema 词汇在下、门槛函数在上」分层：本文件只放依赖 NormalizedTodo 的门槛/追加
// 函数；枚举与 JSON 列 schema 留在 todo-confidence.ts（叶子）。todo.ts 对消费方原样
// 再导出，导出面逐名不变。
// 与 todo-deps.ts 同一纪律：全部纯函数，不读时钟、不做 I/O、不读 DB。

import {
  TODO_CONFIDENCE_HISTORY_MAX,
  type TodoCompletionConfidence,
} from "./todo-confidence.js";
import type { NormalizedTodo } from "./todo-deps.js";

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
