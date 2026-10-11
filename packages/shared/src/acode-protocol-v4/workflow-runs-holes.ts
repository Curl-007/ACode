// ============================================================
// workflowRuns 归约里的 hole（挖洞-填充）部分
// ============================================================
// 从 workflow-runs-reducer.ts 拆出（max-lines 门，先例：workflow-runs-concurrency.ts /
// workflow-runs-phases.ts）：主归约只剩 switch 的分派，`hole-reached` / `hole-filled`
// 的规则住在这里。与主归约同一条纪律：纯函数、无时钟——`askedAt` 只能由事件携带。
//
// 语义权威在 apps/acode-cli/specs/workflow-holes.md：hole 欠的是**代码**（脚本进程停在
// 洞站点等 FillWorkflowHole 提交函数体），与 pendingQuestions 欠**值**（actor 停在 ask 里
// 等一句话）是两张表、两条 doctrine 相同的链。

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunPendingHole,
  type WorkflowRunState,
} from "./workflow-runs.js";

/**
 * `hole-reached` → `run.pendingHoles` 的 upsert。
 *
 * 与 escalation-raised 同一条 doctrine：不碰 `nodes[]` 与 actor 状态——等代码不是工作量。
 * 身份是 `holeId`（站点 id + 首达 ordinal 拼成）而不是裸站点 id：循环里同一洞的后续
 * 到达**不再停驻**（filled-once-run-per-reach），所以一个身份一辈子只 upsert 一次，
 * 重放天然幂等（同一条事件再来一次得到逐字节相同的表）。
 */
export function reduceHoleReached(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const holeId = nonEmptyString(payload.holeId);
  const stage = nonEmptyString(payload.stage);
  const prompt = nonEmptyString(payload.prompt);
  // holeId 是身份；stage/prompt 是这条记录存在的全部理由；ordinal 进引擎 nextOrdinal
  // 体系、事件侧必填。缺任一即无从展示，整条丢弃（与 escalation-raised 的兜底同档）。
  const ordinal = payload.ordinal;
  if (
    holeId === undefined ||
    stage === undefined ||
    prompt === undefined ||
    typeof ordinal !== "number" ||
    !Number.isFinite(ordinal) ||
    ordinal < 0
  ) {
    return run;
  }
  const askedAt =
    typeof payload.askedAt === "number" && Number.isFinite(payload.askedAt)
      ? payload.askedAt
      : undefined;
  const hole: WorkflowRunPendingHole = {
    holeId,
    ordinal,
    stage: boundedText(stage),
    prompt: boundedText(prompt),
    ...(askedAt === undefined ? {} : { askedAt }),
  };
  const current = run.pendingHoles ?? [];
  // upsert 而非 push：重放幂等的支点（见头注）。
  const upserted = [...current.filter((candidate) => candidate.holeId !== holeId), hole];
  if (upserted.length > WORKFLOW_RUNS_LIMITS.maxPendingHoles) {
    return {
      ...run,
      pendingHoles: upserted.slice(upserted.length - WORKFLOW_RUNS_LIMITS.maxPendingHoles),
      truncated: true,
    };
  }
  return { ...run, pendingHoles: upserted };
}

/**
 * `hole-filled` → 把洞从「欠填」表划掉。
 *
 * 填充语句本身活在 fill 文件与新 run 的草稿里（审计面），投影只关心「现在还欠谁」。
 * 终态清空（run-settled）走 withoutPendingHoles 的 keep=() => false，与
 * pendingQuestions 的终态清空同一形态。
 */
export function reduceHoleFilled(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const holeId = nonEmptyString(payload.holeId);
  if (holeId === undefined) return run;
  return withoutPendingHoles(run, (hole) => hole.holeId !== holeId);
}

/**
 * 按谓词保留停驻 hole，一条不剩时把整个键摘掉（而不是留一个空数组）。
 * 「零条 ⇒ 键缺席」与幂等支点的论证逐字见 reducer 侧 withoutPendingQuestions 的注释。
 */
export function withoutPendingHoles(
  run: WorkflowRunState,
  keep: (hole: WorkflowRunPendingHole) => boolean,
): WorkflowRunState {
  const current = run.pendingHoles;
  if (current === undefined) return run;
  const remaining = current.filter(keep);
  if (remaining.length === current.length) return run;
  if (remaining.length > 0) return { ...run, pendingHoles: remaining };
  const { pendingHoles: _emptied, ...withoutKey } = run;
  return withoutKey;
}

// 两个小助手与 reducer 侧同名私有函数逐字相同而不是共享导出：reducer 不导出它们，
// import 它会成环（reducer → 本模块）。先例与论证见 workflow-artifacts.ts 的
// decodedBase64ByteLength 注释（「十行纯算术复制一份，比为它开一个新的公共模块便宜」）。
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 展示上界。省略号让截断可见，与 report 预览同一个习语。 */
function boundedText(text: string): string {
  const limit = WORKFLOW_RUNS_LIMITS.maxQuestionLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
