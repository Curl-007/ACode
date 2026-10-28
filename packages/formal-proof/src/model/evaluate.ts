// 2026-12-31 例外债务偿还：自 ../model.ts 按职责拆出——裁决表层
//（evaluate 入口 + runPhase 分派族 evaluateRunning/Compacting/GoalVerifying/
// Completed/Idle/System + isSystemCandidateApplicable 适用性判定）。
// 逐字迁移，零行为改动；isSystemCandidateApplicable 原为模块私有，拆叶后
// 叶内导出供 ./trace.ts 的 enumerateCandidates 消费，不进 ../model.ts barrel。

import {
  allow,
  choice,
  drainQueueAfterRun,
  enqueue,
  reject,
  systemTransition,
  undefinedDecision,
} from "./decisions.js";
import type { Candidate, Decision, ProductContext } from "./types.js";

// 导出为可执行裁决表（02-projection「规则模块下沉」）：
// CLI 投影的 guard 派生必须与本函数逐条一致。注意：旧注释宣称的
// formal-proof-consistency 黄金测试从未建成（2026-10-05 全仓 grep 核实），
// 该一致性目前仅由人工维护——修改任一侧裁决表必须人工核对另一侧，
// 或先补建机械对照测试再改。
export function evaluate(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.kind === "system") {
    return evaluateSystem(context, candidate);
  }

  if (context.runPhase === "running") {
    return evaluateRunning(context, candidate);
  }
  if (context.runPhase === "compacting") {
    return evaluateCompacting(context, candidate);
  }
  if (context.runPhase === "goalVerifying") {
    return evaluateGoalVerifying(context, candidate);
  }
  if (context.runPhase === "completed") {
    return evaluateCompleted(context, candidate);
  }
  return evaluateIdle(context, candidate);
}

function evaluateRunning(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "sendText") {
    return enqueue(
      context,
      candidate,
      "queueTextWhileRunning",
      "running 时继续发文字进入消息队列。",
    );
  }
  if (candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "queueGoalWhileRunning",
      "running 时设置 goal 进入消息队列。",
    );
  }
  if (candidate.id === "slashCompact" || candidate.id === "compact") {
    return enqueue(
      context,
      candidate,
      "runningCompactQueues",
      "running 时 compact 作为维护意图进入 FIFO。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(context, "runningCannotFork", "运行中不能 fork", "最新轮次和老轮次都不能 fork。");
  }
  if (candidate.id === "editLatest" || candidate.id === "editOld") {
    return reject(
      context,
      "runningCannotEditQuery",
      "运行中不能编辑 query",
      "发送过程中最新 query 和历史 query 都不能编辑。",
    );
  }
  return undefinedDecision(context, candidate, "runningUnhandled");
}

function evaluateCompacting(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return reject(
      context,
      "compactingCannotCompact",
      "正在 compact，不能再次 compact",
      "必须去重或禁用入口。",
    );
  }
  // 重裁决（compactingAcceptsFutureInput）：
  // compact 是维护步骤，用户输入是未来意图 → 入队，不打断 compact。
  if (candidate.id === "sendText" || candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "compactingAcceptsFutureInput",
      "compacting 时输入追加 queue，不打断 compact。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "compactingCannotFork",
      "正在 compact，不能 fork",
      "避免 fork 到半压缩上下文。",
    );
  }
  return undefinedDecision(context, candidate, "compactingUnhandled");
}

function evaluateGoalVerifying(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return enqueue(
      context,
      candidate,
      "goalVerifierAcceptsFutureInput",
      "goal verifier 中 compact 追加 queue，不打断验证。",
    );
  }
  if (candidate.id === "sendText" || candidate.id === "setGoal") {
    return enqueue(
      context,
      candidate,
      "goalVerifierAcceptsFutureInput",
      "goal verifier 中输入追加 queue，不打断验证。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(
      context,
      "goalVerifyingCannotFork",
      "goal 验证中不能 fork",
      "验证阶段 fork 会破坏结果归属。",
    );
  }
  return undefinedDecision(context, candidate, "goalVerifyingUnhandled");
}

function evaluateCompleted(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return allow(context, "completedCanFork", "完成后可以 fork", {
      ...context,
      forked: true,
      selectedTurn: candidate.target,
    });
  }
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    if (context.queue !== "empty") {
      return enqueue(
        context,
        candidate,
        "heldCompactQueues",
        "held queue 下 compact 追加队尾，不绕过未来意图。",
      );
    }
    if (context.compactMemory === "justCompacted" && !context.canCompactAgain) {
      return reject(
        context,
        "justCompactedNoNeed",
        "刚压缩完，不需要压缩",
        "compact 可以被点击，但模型返回 noop 提示。",
      );
    }
    return allow(context, "completedCanCompact", "完成后可以 compact", {
      ...context,
      runPhase: "compacting",
      compactMemory: "compactable",
    });
  }
  // held 判定：completed 下仍滞留的 queue 只可能是 autoDrain=false 的 held queue
  // （autoDrain=true 时 assistantComplete 即消费，completed+queue>0 不持久存在）。
  // 重裁决（heldQueueInputRequiresChoice，替代原 heldQueueCapturesNewInput）：
  // held 下输入不静默入队，由用户选择 clear/keep queue 后发送。
  if (candidate.id === "sendText") {
    if (context.queue !== "empty") {
      return choice(
        context,
        "heldQueueInputRequiresChoice",
        "held queue 下发送需用户裁决",
        "呈现「清空 queue 后发送 / 保留 queue 立即发送」，disposition 随 command 上行。",
      );
    }
    return allow(context, "completedCanSend", "完成后继续发送", {
      ...context,
      runPhase: "running",
      queue: "empty",
    });
  }
  if (candidate.id === "setGoal") {
    if (context.queue !== "empty") {
      return choice(
        context,
        "heldQueueInputRequiresChoice",
        "held queue 下设置 goal 需用户裁决",
        "同 sendText：composer 输入统一走 choice。",
      );
    }
    return allow(context, "completedCanSetGoal", "完成后可以设置 goal", {
      ...context,
      goal: "active",
    });
  }
  return undefinedDecision(context, candidate, "completedUnhandled");
}

function evaluateIdle(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "sendText") {
    return allow(context, "idleCanSend", "idle 时发送消息", {
      ...context,
      runPhase: "running",
      queue: "empty",
    });
  }
  if (candidate.id === "setGoal") {
    return allow(context, "idleCanSetGoal", "idle 时设置 goal", {
      ...context,
      goal: "active",
    });
  }
  if (candidate.id === "compact" || candidate.id === "slashCompact") {
    return reject(
      context,
      "idleCannotCompact",
      "没有可压缩上下文",
      "没有完成消息时 compact 应禁用或提示。",
    );
  }
  if (candidate.id === "forkLatest" || candidate.id === "forkOld") {
    return reject(context, "idleCannotFork", "没有可 fork 轮次", "没有完成轮次时 fork 应禁用。");
  }
  if (candidate.id === "editLatest" || candidate.id === "editOld") {
    return reject(
      context,
      "idleCannotEdit",
      "没有可编辑 query",
      "没有 query 时编辑入口不应该出现。",
    );
  }
  return undefinedDecision(context, candidate, "idleUnhandled");
}

function evaluateSystem(context: ProductContext, candidate: Candidate): Decision {
  if (candidate.id === "assistantComplete") {
    return systemTransition(
      context,
      "assistantComplete",
      "assistant 完成",
      drainQueueAfterRun(context),
    );
  }
  if (candidate.id === "compactComplete") {
    return systemTransition(context, "compactComplete", "compact 完成", {
      ...context,
      runPhase: "completed",
      compactMemory: "justCompacted",
      canCompactAgain: true,
    });
  }
  if (candidate.id === "compactNoop") {
    return systemTransition(context, "compactNoop", "compact 判断无需继续", {
      ...context,
      runPhase: "completed",
      compactMemory: "justCompacted",
      canCompactAgain: false,
    });
  }
  if (candidate.id === "goalVerifyStart") {
    return systemTransition(context, "goalVerifyStart", "进入 goal 验证", {
      ...context,
      runPhase: "goalVerifying",
      goal: "verifying",
    });
  }
  if (candidate.id === "goalVerifyPass") {
    return systemTransition(context, "goalVerifyPass", "goal 验证通过", {
      ...context,
      runPhase: "completed",
      goal: "verified",
    });
  }
  return systemTransition(context, "goalVerifyFail", "goal 验证失败", {
    ...context,
    runPhase: "completed",
    goal: "failed",
  });
}

export function isSystemCandidateApplicable(
  context: ProductContext,
  candidate: Candidate,
): boolean {
  if (candidate.id === "assistantComplete") {
    return context.runPhase === "running";
  }
  if (candidate.id === "compactComplete" || candidate.id === "compactNoop") {
    return context.runPhase === "compacting";
  }
  if (candidate.id === "goalVerifyStart") {
    return context.runPhase === "completed" && context.goal === "active";
  }
  if (candidate.id === "goalVerifyPass" || candidate.id === "goalVerifyFail") {
    return context.runPhase === "goalVerifying";
  }
  return false;
}
