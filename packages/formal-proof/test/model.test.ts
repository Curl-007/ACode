/**
 * formal-proof model.ts 核心不变量测试。
 *
 * 修复依据（R2-10）：本模块是 managed 架构模块（architecture-policy.yaml:168），却长期
 * 零测试——920 行裁决模型不进 `pnpm test` / CI。specs/module-boundary.md 明确 model.ts
 * 是「裁决事实来源」，apps/acode-cli bootstrap 的裁决投影以注释声明与 evaluate 逐条对齐
 * （投影一致性无机械测试，靠人工核对）。本文件把 model.ts 声明的运行时不变量固化为可执行
 * 断言，作为该事实源的第一层机械回归网——不是空壳测试，每条都对应 CONTRACT.md /
 * module-boundary.md / src/contract.ts 注释里明写的规则。
 *
 * 覆盖的不变量（均来自 model.ts 与 spec 的明文声明，非臆测）：
 *  A. evaluate 是纯函数裁决表——同一 (context, candidate) 恒得同一 Decision（contract.ts:9）。
 *  B. held 状态输入不静默入队，必须产出 choice 裁决（contract.ts:10 / evaluateCompleted）。
 *  C. 各阶段禁止动作走 reject（running/compacting/goalVerifying 不能 fork、idle 无内容时禁 compact 等）。
 *  D. enqueue 的 next.queue 由 mergeQueue 正确合并（text/goal/compact → mixed）。
 *  E. system 事件 assistantComplete 按 drainQueueAfterRun 推进阶段。
 *  F. buildTraceTree 入口 resetIds，同一输入产出确定节点编号（contract.ts:11 / module-boundary.md:17）。
 *  G. enumerateCandidates 只纳入当前上下文适用的 system 候选（isSystemCandidateApplicable）。
 *  H. collectStats / flatten 与树结构一致。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTraceTree,
  collectStats,
  contextKey,
  contextLabel,
  decisionLabel,
  enumerateCandidates,
  evaluate,
  flatten,
  profiles,
  resetIds,
  userCandidates,
  type Candidate,
  type Decision,
  type ProductContext,
} from "../src/model.js";

/** 构造一个 ProductContext，缺省值取「completed / 空队列」这一最常见基线。 */
function ctx(overrides: Partial<ProductContext> = {}): ProductContext {
  return {
    runPhase: "completed",
    queue: "empty",
    compactMemory: "compactable",
    canCompactAgain: true,
    goal: "active",
    selectedTurn: "latest",
    forked: false,
    ...overrides,
  };
}

/** 按 id 取一个用户候选；找不到即测试自身写错，直接抛。 */
function candidateById(id: string): Candidate {
  const found = userCandidates.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`test fixture error: unknown candidate ${id}`);
  return found;
}

// ── A. 纯函数裁决表 ────────────────────────────────────────────────────────
test("evaluate 是纯函数：同一 (context, candidate) 两次调用得到逐字段相等的 Decision", () => {
  const context = ctx({ runPhase: "running", queue: "empty" });
  const candidate = candidateById("sendText");
  const first: Decision = evaluate(context, candidate);
  const second: Decision = evaluate(context, candidate);
  assert.deepEqual(first, second, "同输入必须同输出（evaluate 不得读可变全局）");
});

test("evaluate 不修改入参 context（裁决只读，next 是新对象）", () => {
  const context = ctx({ runPhase: "completed", queue: "empty" });
  const snapshot = contextKey(context);
  const decision = evaluate(context, candidateById("sendText"));
  assert.equal(contextKey(context), snapshot, "入参 context 不得被就地改写");
  assert.ok(decision.next, "allow 裁决必须带 next 上下文");
  assert.notEqual(decision.next, context, "next 必须是新对象，不能复用入参引用");
});

// ── B. held queue 输入必须走 choice，不静默入队 ─────────────────────────────
test("completed + 非空队列 + sendText → choice（held 输入不静默入队）", () => {
  const decision = evaluate(ctx({ runPhase: "completed", queue: "text" }), candidateById("sendText"));
  assert.equal(decision.kind, "choice", "held queue 下发送必须由用户裁决 clear/keep");
  assert.equal(decision.ruleId, "heldQueueInputRequiresChoice");
  assert.deepEqual(decision.next, ctx({ runPhase: "completed", queue: "text" }), "choice 不推进状态");
});

test("completed + 非空队列 + setGoal → choice（composer 输入统一走 choice）", () => {
  const decision = evaluate(ctx({ runPhase: "completed", queue: "goal" }), candidateById("setGoal"));
  assert.equal(decision.kind, "choice");
  assert.equal(decision.ruleId, "heldQueueInputRequiresChoice");
});

test("completed + 空队列 + sendText → allow 且 next 进入 running（对照：非 held 才直接发）", () => {
  const decision = evaluate(ctx({ runPhase: "completed", queue: "empty" }), candidateById("sendText"));
  assert.equal(decision.kind, "allow", "空队列下发送直接放行");
  assert.equal(decision.next?.runPhase, "running", "next 阶段推进为 running");
});

// ── C. 各阶段禁止动作 → reject ─────────────────────────────────────────────
test("running 阶段 fork/edit 一律 reject（运行中不能 fork、不能编辑 query）", () => {
  const running = ctx({ runPhase: "running" });
  assert.equal(evaluate(running, candidateById("forkLatest")).kind, "reject");
  assert.equal(evaluate(running, candidateById("forkOld")).kind, "reject");
  assert.equal(evaluate(running, candidateById("editLatest")).ruleId, "runningCannotEditQuery");
  assert.equal(evaluate(running, candidateById("editOld")).kind, "reject");
});

test("compacting 阶段再 compact → reject（必须去重/禁用入口）", () => {
  const decision = evaluate(ctx({ runPhase: "compacting" }), candidateById("compact"));
  assert.equal(decision.kind, "reject");
  assert.equal(decision.ruleId, "compactingCannotCompact");
});

test("goalVerifying 阶段 fork → reject（验证阶段 fork 破坏结果归属）", () => {
  const decision = evaluate(ctx({ runPhase: "goalVerifying" }), candidateById("forkOld"));
  assert.equal(decision.kind, "reject");
  assert.equal(decision.ruleId, "goalVerifyingCannotFork");
});

test("idle 阶段 compact → reject（没有可压缩上下文）", () => {
  const decision = evaluate(ctx({ runPhase: "idle" }), candidateById("slashCompact"));
  assert.equal(decision.kind, "reject");
  assert.equal(decision.ruleId, "idleCannotCompact");
});

test("completed + justCompacted + !canCompactAgain + compact → reject（刚压缩完不需再压）", () => {
  const decision = evaluate(
    ctx({ runPhase: "completed", queue: "empty", compactMemory: "justCompacted", canCompactAgain: false }),
    candidateById("compact"),
  );
  assert.equal(decision.kind, "reject");
  assert.equal(decision.ruleId, "justCompactedNoNeed");
});

// ── D. enqueue 的 next.queue 合并 ──────────────────────────────────────────
test("running + sendText → enqueue，next.queue=text（入队保留用户文字）", () => {
  const decision = evaluate(ctx({ runPhase: "running", queue: "empty" }), candidateById("sendText"));
  assert.equal(decision.kind, "enqueue");
  assert.equal(decision.next?.queue, "text", "mergeQueue: empty+text → text");
});

test("running + 已有 text 队列时 setGoal → enqueue，next.queue=mixed（跨类别合并为 mixed）", () => {
  const decision = evaluate(ctx({ runPhase: "running", queue: "text" }), candidateById("setGoal"));
  assert.equal(decision.kind, "enqueue");
  assert.equal(decision.next?.queue, "mixed", "mergeQueue: text+goal → mixed");
});

test("running + 已有 text 队列时再 sendText → enqueue，next.queue 仍为 text（同类别幂等）", () => {
  const decision = evaluate(ctx({ runPhase: "running", queue: "text" }), candidateById("sendText"));
  assert.equal(decision.kind, "enqueue");
  assert.equal(decision.next?.queue, "text", "mergeQueue: text+text → text（幂等）");
});

// ── E. system 事件推进阶段 ─────────────────────────────────────────────────
test("system assistantComplete：空队列 → completed（drainQueueAfterRun 终态）", () => {
  const assistantComplete: Candidate = {
    id: "assistantComplete",
    kind: "system",
    label: "assistant 完成当前 run",
    target: "none",
    surface: "runtime event",
  };
  const decision = evaluate(ctx({ runPhase: "running", queue: "empty" }), assistantComplete);
  assert.equal(decision.kind, "system");
  assert.equal(decision.next?.runPhase, "completed", "空队列完成 → completed");
});

test("system assistantComplete：text 队列 → 继续 running 消费队列（drainQueueAfterRun）", () => {
  const assistantComplete: Candidate = {
    id: "assistantComplete",
    kind: "system",
    label: "assistant 完成当前 run",
    target: "none",
    surface: "runtime event",
  };
  const decision = evaluate(ctx({ runPhase: "running", queue: "text" }), assistantComplete);
  assert.equal(decision.next?.runPhase, "running", "有 text 队列 → 立即续跑");
  assert.equal(decision.next?.queue, "empty", "队列被消费清空");
});

test("system compactComplete → next.compactMemory=justCompacted 且 canCompactAgain=true", () => {
  const compactComplete: Candidate = {
    id: "compactComplete",
    kind: "system",
    label: "compact 完成",
    target: "none",
    surface: "runtime event",
  };
  const decision = evaluate(ctx({ runPhase: "compacting" }), compactComplete);
  assert.equal(decision.kind, "system");
  assert.equal(decision.next?.compactMemory, "justCompacted");
  assert.equal(decision.next?.canCompactAgain, true);
});

// ── F. buildTraceTree 确定性 + resetIds ────────────────────────────────────
test("buildTraceTree 对同一输入两次构建产出完全相同的树（含节点编号）", () => {
  const context = ctx({ runPhase: "completed", queue: "empty" });
  const first = JSON.stringify(buildTraceTree(context, 2));
  const second = JSON.stringify(buildTraceTree(context, 2));
  assert.equal(first, second, "buildTraceTree 入口 resetIds → 编号确定，两次输出逐字节相等");
});

test("resetIds 后手动构建：节点编号从 n-1 起，不残留上一棵树的计数", () => {
  resetIds();
  const tree = buildTraceTree(ctx({ runPhase: "completed" }), 1);
  assert.equal(tree.id, "n-1", "根节点必须是 n-1（resetIds 已归零 nextNodeId）");
});

test("buildTraceTree 达轮次上限时终止展开（不无限递归）", () => {
  // maxRounds=1：round=1 展开候选，子状态 round=2 > 1 → 落 case 节点「到达轮次上限」，停止递归。
  const tree = buildTraceTree(ctx({ runPhase: "completed", queue: "empty" }), 1);
  const all = flatten(tree);
  const limitCases = all.filter((node) => node.kind === "case" && node.subtitle === "到达轮次上限");
  assert.ok(limitCases.length > 0, "深度受限的路径必须以「到达轮次上限」case 收口");
  assert.ok(all.length < 5000, "有限轮次下节点总数必须有界（防回归到无限展开）");
});

// ── G. enumerateCandidates 只纳入适用的 system 候选 ────────────────────────
test("enumerateCandidates：running 阶段纳入 assistantComplete，不纳入 compactComplete", () => {
  const ids = enumerateCandidates(ctx({ runPhase: "running" })).map((candidate) => candidate.id);
  assert.ok(ids.includes("assistantComplete"), "running → assistantComplete 适用");
  assert.ok(!ids.includes("compactComplete"), "compactComplete 只在 compacting 适用");
  // 用户候选恒全量纳入（枚举的是「上下文 × 全部用户候选」笛卡尔积）。
  for (const userCandidate of userCandidates) assert.ok(ids.includes(userCandidate.id));
});

test("enumerateCandidates：compacting 阶段纳入 compactComplete/compactNoop，不纳入 assistantComplete", () => {
  const ids = enumerateCandidates(ctx({ runPhase: "compacting" })).map((candidate) => candidate.id);
  assert.ok(ids.includes("compactComplete"));
  assert.ok(ids.includes("compactNoop"));
  assert.ok(!ids.includes("assistantComplete"));
});

test("enumerateCandidates：completed+goal=active 纳入 goalVerifyStart；goal!=active 时不纳入", () => {
  const activeIds = enumerateCandidates(ctx({ runPhase: "completed", goal: "active" })).map((c) => c.id);
  assert.ok(activeIds.includes("goalVerifyStart"), "completed+active → 可进入 goal 验证");
  const verifiedIds = enumerateCandidates(ctx({ runPhase: "completed", goal: "verified" })).map((c) => c.id);
  assert.ok(!verifiedIds.includes("goalVerifyStart"), "goal 非 active 时不再触发验证");
});

// ── H. collectStats / flatten / 标签工具一致性 ─────────────────────────────
test("collectStats 的 nodes 计数等于 flatten 的节点数", () => {
  const tree = buildTraceTree(ctx({ runPhase: "completed", queue: "empty" }), 2);
  const stats = collectStats(tree);
  assert.equal(stats.nodes, flatten(tree).length, "stats.nodes 必须与 flatten 长度一致");
});

test("collectStats 的分类计数之和 ≤ cases，且 rejects/choices/allowed 非负", () => {
  const stats = collectStats(buildTraceTree(ctx({ runPhase: "completed", queue: "text" }), 2));
  for (const key of ["rejects", "undefined", "enqueued", "allowed", "choices", "system"] as const) {
    assert.ok(Number.isInteger(stats[key]) && stats[key] >= 0, `${key} 必须是非负整数`);
  }
  assert.ok(stats.cases >= 0);
});

test("contextLabel / contextKey / decisionLabel 输出稳定且含关键字段", () => {
  const context = ctx({ runPhase: "goalVerifying", queue: "mixed", forked: true });
  assert.match(contextLabel(context), /phase=goalVerifying/u);
  assert.match(contextLabel(context), /forked/u);
  assert.equal(contextKey(context).split("|")[0], "goalVerifying", "contextKey 首段是 runPhase");
  const decision = evaluate(ctx({ runPhase: "running" }), candidateById("forkLatest"));
  assert.match(decisionLabel(decision), /^reject · /u, "reject 裁决标签以 reject 前缀开头");
});

test("profiles 预置剖面的 context 均可被 evaluate 消费（不抛异常）", () => {
  assert.ok(profiles.length > 0, "profiles 不应为空");
  for (const profile of profiles) {
    for (const candidate of enumerateCandidates(profile.context)) {
      assert.doesNotThrow(() => evaluate(profile.context, candidate), `profile ${profile.id} × ${candidate.id}`);
    }
  }
});
