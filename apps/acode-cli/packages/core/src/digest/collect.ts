// ============================================================
// Digest 采集（specs/periodic-digest.md R1/R3/R4/R5）
// ============================================================
// 纯函数：无 IO、无时钟（now 入参）、不新建查询面——输入袋由 handler 从既有端口
// 取好后交给这里做分节/排序/截断/降级警告归并。外部文本（标题/描述/error）一律
// sanitizeDigestText 单行化 + 截断（R3）；prompt 原文、路径、凭据类字段根本不入袋
//（R4 由字段白名单承载：本文件只挑 id/title/状态/计数/时间戳）。

import type { CronAutomation } from "@acode/contracts";
import { isTerminalRuntimeTask, type RuntimeTaskSnapshot } from "../runtime-task/contract.js";
import { describeAutomationCadence } from "./cadence.js";
import {
  DIGEST_ERROR_MAX_CHARS,
  DIGEST_LIMITS,
  DIGEST_SOURCE_WARNING_CODES,
  DIGEST_TITLE_MAX_CHARS,
  type DigestArtifactItem,
  type DigestAttentionItem,
  type DigestDocument,
  type DigestInProgressItem,
  type DigestRoutineItem,
  type DigestRoutineState,
  type DigestSourceSnapshots,
  type DigestSourceWarningCode,
} from "./types.js";

/** 外部文本纪律（R3）：单行化 + 截断。渲染层再做一次防御性同款处理。 */
export function sanitizeDigestText(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars)}…` : singleLine;
}

function humanDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** attn 的任务终态子集：用户主动停的（cancelled/stopped）与正常完成不算「需要注意」。 */
const ATTENTION_TASK_STATUSES = new Set(["failed", "killed", "lost"]);

function taskInProgressItem(task: RuntimeTaskSnapshot, now: number): DigestInProgressItem {
  const detailParts: string[] = [task.type];
  if (task.overnight?.phase) detailParts.push(`phase ${task.overnight.phase}`);
  if (typeof task.overnight?.cardCount === "number")
    detailParts.push(`${task.overnight.cardCount} cards`);
  const startedMs = task.startedAt instanceof Date ? task.startedAt.getTime() : undefined;
  if (typeof startedMs === "number")
    detailParts.push(`running for ${humanDuration(now - startedMs)}`);
  return {
    kind: "task",
    id: task.taskId,
    title: sanitizeDigestText(task.description || task.taskId, DIGEST_TITLE_MAX_CHARS),
    state: task.status,
    detail: detailParts.join(", "),
  };
}

function taskAttentionItem(task: RuntimeTaskSnapshot): DigestAttentionItem {
  const completedMs = task.completedAt instanceof Date ? task.completedAt.getTime() : undefined;
  return {
    kind: "task",
    id: task.taskId,
    title: sanitizeDigestText(task.description || task.taskId, DIGEST_TITLE_MAX_CHARS),
    reason: task.error
      ? sanitizeDigestText(task.error, DIGEST_ERROR_MAX_CHARS)
      : `ended as ${task.status}`,
    ...(typeof completedMs === "number" ? { since: completedMs } : {}),
  };
}

function routineStateOf(automation: {
  enabled: boolean;
  lifecycleStatus: "active" | "completed" | "failed" | "paused";
}): DigestRoutineState {
  // enabled=false 是用户暂停；lifecycleStatus=paused 是服务侧暂停态——两者都呈现 paused。
  if (!automation.enabled || automation.lifecycleStatus === "paused") return "paused";
  return automation.lifecycleStatus;
}

function routineItemOf(automation: CronAutomation): DigestRoutineItem {
  return {
    automationId: automation.automationId,
    title: sanitizeDigestText(automation.title || automation.automationId, DIGEST_TITLE_MAX_CHARS),
    cadence: describeAutomationCadence(automation.scheduleRule, automation.cronExpr),
    state: routineStateOf(automation),
    ...(typeof automation.nextRunAt === "number" ? { nextRunAt: automation.nextRunAt } : {}),
    ...(typeof automation.lastRunAt === "number" ? { lastRunAt: automation.lastRunAt } : {}),
    runCount: automation.runCount,
    ...(typeof automation.maxRuns === "number" ? { maxRuns: automation.maxRuns } : {}),
  };
}

function withOverflow<T>(items: T[], limit: number): { kept: T[]; dropped: number } {
  return items.length > limit
    ? { kept: items.slice(0, limit), dropped: items.length - limit }
    : { kept: items, dropped: 0 };
}

/** 警告归一：去重 + 按闭集声明序排列（handler 的 artifact 后置警告复用同一口径）。 */
export function normalizeDigestSourceWarnings(
  warnings: readonly DigestSourceWarningCode[],
): DigestSourceWarningCode[] {
  const present = new Set(warnings);
  return DIGEST_SOURCE_WARNING_CODES.filter((code) => present.has(code));
}

/**
 * 采集主函数：sources 的每个键都是「查询成功」的事实，缺席 = 不可得（原因已在
 * warnings）。四节 + overflow + 警告全部有界（R5），空源产出空节而不是失败——
 * 「全部源缺席」的业务失败判定在 handler（它才知道端口面全貌）。
 */
export function collectDigestDocument(sources: DigestSourceSnapshots, now: number): DigestDocument {
  const inProgress: DigestInProgressItem[] = [];
  const attention: DigestAttentionItem[] = [];
  const artifacts: DigestArtifactItem[] = [];

  // ---- runtime 任务（本 CLI 进程内存面 = 「进行中」的正确口径）----
  const tasks = sources.tasks ?? [];
  const activeTasks = tasks
    .filter((task) => !isTerminalRuntimeTask(task))
    .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
  const failedTasks = tasks.filter(
    (task) => isTerminalRuntimeTask(task) && ATTENTION_TASK_STATUSES.has(task.status),
  );
  const taskProgress = withOverflow(
    activeTasks.map((task) => taskInProgressItem(task, now)),
    DIGEST_LIMITS.inProgressTasks,
  );
  inProgress.push(...taskProgress.kept);
  attention.push(...failedTasks.map(taskAttentionItem));
  // registry 终态 workflow 任务的 resultText：只报字节数不复制内容（R1 artifacts 节）。
  for (const task of tasks) {
    if (!task.resultText) continue;
    artifacts.push({
      runId: task.taskId,
      runLabel: sanitizeDigestText(task.description || task.taskId, DIGEST_TITLE_MAX_CHARS),
      artifactId: `${task.taskId}:result-text`,
      kind: "result_text",
      title: `${Buffer.byteLength(task.resultText, "utf8")} bytes`,
      version: 1,
    });
  }

  // ---- 闲时任务 ----
  const offPeak = sources.offPeakTasks ?? [];
  const offPeakInFlight = offPeak
    .filter(
      (task) => task.status === "queued" || task.status === "running" || task.status === "paused",
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const offPeakProgress = withOverflow(
    offPeakInFlight.map((task) => ({
      kind: "offpeak" as const,
      id: task.offPeakTaskId,
      title: sanitizeDigestText(task.title || task.offPeakTaskId, DIGEST_TITLE_MAX_CHARS),
      state: task.status,
      ...(typeof task.queuePosition === "number" ? { detail: `queue #${task.queuePosition}` } : {}),
    })),
    DIGEST_LIMITS.inProgressOffPeak,
  );
  inProgress.push(...offPeakProgress.kept);
  attention.push(
    ...offPeak
      .filter((task) => task.status === "failed")
      .map((task) => ({
        kind: "offpeak" as const,
        id: task.offPeakTaskId,
        title: sanitizeDigestText(task.title || task.offPeakTaskId, DIGEST_TITLE_MAX_CHARS),
        reason: "idle-time task failed",
        since: task.createdAt,
      })),
  );

  // ---- 近况会话线程（todos 完成度 = 进度态）----
  const sessions = [...(sources.sessions ?? [])].sort(
    (a, b) => (b.info.time?.updated ?? 0) - (a.info.time?.updated ?? 0),
  );
  const sessionProgress = withOverflow(
    sessions.map((session) => {
      const todos = session.todos ?? [];
      const done = todos.filter((todo) => todo.status === "completed").length;
      const detailParts: string[] = [];
      if (todos.length > 0) detailParts.push(`${done}/${todos.length} todos done`);
      const updatedMs = session.info.time?.updated;
      if (typeof updatedMs === "number")
        detailParts.push(`updated ${humanDuration(now - updatedMs)} ago`);
      return {
        kind: "session" as const,
        id: session.info.id,
        title: sanitizeDigestText(session.info.title || session.info.id, DIGEST_TITLE_MAX_CHARS),
        state: "recent",
        ...(detailParts.length > 0 ? { detail: detailParts.join(", ") } : {}),
      };
    }),
    DIGEST_LIMITS.inProgressSessions,
  );
  inProgress.push(...sessionProgress.kept);

  // ---- automation：routines 全量 + failed 进 attn ----
  const automations = sources.automations ?? [];
  const routines = withOverflow(automations.map(routineItemOf), DIGEST_LIMITS.routines);
  attention.push(
    ...automations
      .filter((automation) => automation.lifecycleStatus === "failed")
      .map((automation) => ({
        kind: "automation" as const,
        id: automation.automationId,
        title: sanitizeDigestText(
          automation.title || automation.automationId,
          DIGEST_TITLE_MAX_CHARS,
        ),
        reason: "scheduled automation failed",
        ...(typeof automation.lastRunAt === "number" ? { since: automation.lastRunAt } : {}),
      })),
  );

  // ---- workflow run：errored 进 attn；用户面产物进 artifacts ----
  const runs = sources.workflowRuns ?? [];
  attention.push(
    ...runs
      .filter((run) => run.summary.status === "errored")
      .map((run) => ({
        kind: "workflow_run" as const,
        id: run.summary.runId,
        title: sanitizeDigestText(run.summary.label || run.summary.runId, DIGEST_TITLE_MAX_CHARS),
        reason: "workflow run errored",
        ...(typeof run.summary.updatedAt === "number" ? { since: run.summary.updatedAt } : {}),
      })),
  );
  for (const run of runs.slice(0, DIGEST_LIMITS.artifactRuns)) {
    for (const artifact of (run.artifacts ?? []).slice(0, DIGEST_LIMITS.artifactsPerRun)) {
      artifacts.push({
        runId: run.summary.runId,
        runLabel: sanitizeDigestText(
          run.summary.label || run.summary.runId,
          DIGEST_TITLE_MAX_CHARS,
        ),
        artifactId: artifact.id,
        kind: artifact.kind,
        ...(artifact.title
          ? { title: sanitizeDigestText(artifact.title, DIGEST_TITLE_MAX_CHARS) }
          : {}),
        version: artifact.version,
        ...(artifact.primary === true ? { primary: true } : {}),
      });
    }
  }

  const attentionBounded = withOverflow(attention, DIGEST_LIMITS.attention);
  const artifactsBounded = withOverflow(
    artifacts,
    DIGEST_LIMITS.artifactRuns * DIGEST_LIMITS.artifactsPerRun,
  );
  const overflow: DigestDocument["overflow"] = {};
  const dropped = taskProgress.dropped + offPeakProgress.dropped + sessionProgress.dropped;
  if (dropped > 0) overflow.inProgress = dropped;
  if (attentionBounded.dropped > 0) overflow.attention = attentionBounded.dropped;
  if (artifactsBounded.dropped > 0) overflow.artifacts = artifactsBounded.dropped;

  return {
    generatedAt: now,
    sections: {
      inProgress,
      attention: attentionBounded.kept,
      routines: routines.kept,
      artifacts: artifactsBounded.kept,
    },
    ...(Object.keys(overflow).length > 0 ? { overflow } : {}),
    sourceWarnings: normalizeDigestSourceWarnings(sources.warnings ?? []),
  };
}
