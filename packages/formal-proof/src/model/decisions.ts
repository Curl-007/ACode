// 2026-12-31 例外债务偿还：自 ../model.ts 按职责拆出——裁决构造层
//（allow/enqueue/choice/reject/systemTransition/undefinedDecision 六个 Decision
// 构造器 + mergeQueue/drainQueueAfterRun 队列状态归并）。原为模块私有函数，
// 拆叶后叶内导出供 ./evaluate.ts 消费，不进 ../model.ts barrel，公开面不变。
// 逐字迁移，零行为改动。

import type { Candidate, Decision, ProductContext, QueueState } from "./types.js";

export function allow(
  context: ProductContext,
  ruleId: string,
  title: string,
  next: ProductContext,
): Decision {
  return {
    kind: "allow",
    ruleId,
    title,
    reason: title,
    next,
    assertion: "动作应生效，并且 UI、消息归属、按钮状态与下一上下文一致。",
  };
}

export function enqueue(
  context: ProductContext,
  candidate: Candidate,
  ruleId: string,
  reason: string,
): Decision {
  const queued =
    candidate.id === "setGoal"
      ? "goal"
      : candidate.id === "compact" || candidate.id === "slashCompact"
        ? "compact"
        : "text";
  return {
    kind: "enqueue",
    ruleId,
    title: queued === "goal" ? "goal 入队" : queued === "compact" ? "compact 入队" : "文字消息入队",
    reason,
    next: {
      ...context,
      queue: mergeQueue(context.queue, queued),
    },
    assertion:
      queued === "goal"
        ? "队列里必须保留 goal 意图。"
        : queued === "compact"
          ? "队列里必须保留 compact 维护意图，且不能生成 user row。"
          : "队列里必须保留用户文字消息。",
  };
}

export function choice(
  context: ProductContext,
  ruleId: string,
  title: string,
  reason: string,
): Decision {
  return {
    kind: "choice",
    ruleId,
    title,
    reason,
    // 无 next：状态直到用户提交 disposition 才推进（clear/keep 都终到 startNow）。
    next: context,
    assertion: "必须呈现明确选择，用户裁决前不得入队、不得发送。",
  };
}

export function reject(
  context: ProductContext,
  ruleId: string,
  title: string,
  reason: string,
): Decision {
  return {
    kind: "reject",
    ruleId,
    title,
    reason,
    assertion: "这条路径必须显示明确反馈，并且不能产生被禁止的副作用。",
    next: context,
  };
}

export function systemTransition(
  context: ProductContext,
  ruleId: string,
  title: string,
  next: ProductContext,
): Decision {
  return {
    kind: "system",
    ruleId,
    title,
    reason: "系统异步事件推进产品状态。",
    next,
    assertion: "系统事件必须按当前 session/run 归属落盘，不能污染其它 trace。",
  };
}

export function undefinedDecision(
  context: ProductContext,
  candidate: Candidate,
  ruleId: string,
): Decision {
  return {
    kind: "undefined",
    ruleId,
    title: "产品预期未定义",
    reason: `模型还不知道 ${context.runPhase} + ${candidate.label} 应该 allow、reject 还是 enqueue。`,
    assertion: "需要人工 review：补产品规则、剪枝为 invalid、或标记可忽略。",
  };
}

export function mergeQueue(queue: QueueState, item: "text" | "goal" | "compact"): QueueState {
  if (queue === "empty") {
    return item;
  }
  if (queue === item) {
    return queue;
  }
  return "mixed";
}

export function drainQueueAfterRun(context: ProductContext): ProductContext {
  if (context.queue === "text") {
    return { ...context, runPhase: "running", queue: "empty" };
  }
  if (context.queue === "goal") {
    return { ...context, runPhase: "completed", queue: "empty", goal: "active" };
  }
  if (context.queue === "compact") {
    return { ...context, runPhase: "compacting", queue: "empty" };
  }
  if (context.queue === "mixed") {
    return { ...context, runPhase: "running", queue: "goal" };
  }
  return {
    ...context,
    runPhase: "completed",
    compactMemory: context.compactMemory === "never" ? "compactable" : context.compactMemory,
  };
}
