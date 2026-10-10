import type {
  ScriptWorkflowActivityRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStats,
  WorkflowScriptMeta,
} from "@acode/contracts";

export function emptyScriptWorkflowStats(): ScriptWorkflowRunStats {
  return {
    agentCalls: 0,
    cachedAgentCalls: 0,
    failedAgentCalls: 0,
    toolCalls: 0,
    tokens: {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      total: 0,
    },
  };
}

export function mergeScriptWorkflowStats(
  left: ScriptWorkflowRunStats,
  right: ScriptWorkflowRunStats,
): ScriptWorkflowRunStats {
  return {
    agentCalls: left.agentCalls + right.agentCalls,
    cachedAgentCalls: left.cachedAgentCalls + right.cachedAgentCalls,
    failedAgentCalls: left.failedAgentCalls + right.failedAgentCalls,
    toolCalls: left.toolCalls + right.toolCalls,
    tokens: {
      cacheRead: left.tokens.cacheRead + right.tokens.cacheRead,
      cacheWrite: left.tokens.cacheWrite + right.tokens.cacheWrite,
      input: left.tokens.input + right.tokens.input,
      output: left.tokens.output + right.tokens.output,
      reasoning: left.tokens.reasoning + right.tokens.reasoning,
      total: left.tokens.total + right.tokens.total,
    },
  };
}

export function formatScriptWorkflowValidation(input: {
  meta: WorkflowScriptMeta;
  scriptHash: string;
  scriptPath: string;
}): string {
  const phases =
    input.meta.phases.length === 0
      ? "none"
      : input.meta.phases.map((phase) => phase.title).join(", ");
  return [
    `Workflow script is valid: ${input.meta.name}`,
    `Description: ${input.meta.description}`,
    `Script: ${input.scriptPath}`,
    `Hash: ${input.scriptHash.slice(0, 12)}`,
    `Phases: ${phases}`,
  ].join("\n");
}

export function formatScriptWorkflowRun(input: {
  activities: ScriptWorkflowActivityRecord[];
  run: ScriptWorkflowRunRecord;
  /**
   * 脚本 `return` 的值。只有刚跑完的那次调用手上有它——run 记录里没有这一列，值只落在
   * `workflow_completed` 事件的载荷里，而事件表当前没有读路径。所以它是可选的：
   * 事后 `status()` 查一条历史 run 时缺席，那一节就不印（不编造、也不去猜）。
   */
  result?: unknown;
}): string {
  const { run } = input;
  const usageIncomplete = input.activities.some((activity) => {
    const result = activity.result as { usageAccounting?: { status?: string } } | undefined;
    return result?.usageAccounting?.status === "incomplete";
  });
  const lines = [
    `workflow ${run.status} · ${run.name}`,
    `runId: ${run.id}`,
    `script: ${run.scriptPath ?? "(inline)"}`,
    formatStats(run.stats ?? emptyScriptWorkflowStats(), usageIncomplete),
  ];
  const tree = formatActivities(input.activities);
  if (tree.length > 0) lines.push("", tree);
  const result = formatRunResult(input.result);
  if (result !== undefined) lines.push("", result);
  if (run.failure) lines.push("", `failure: ${formatUnknown(run.failure)}`);
  return lines.join("\n");
}

/**
 * 脚本返回值的可回传上限。
 *
 * 为什么要有界：这段文本进的是工具响应，而响应有模型字节预算。一个 `return` 了整张表或
 * 整个文件内容的脚本会把自己的结果挤成截断噪音，连带把同一响应里的状态与活动树一起冲掉。
 * 超界时保留头部并**明说**被截断——静默截断会让调用方以为拿到的就是全部。
 */
const RUN_RESULT_MAX_LENGTH = 8_000;

function formatRunResult(result: unknown): string | undefined {
  // 缺席与 undefined 是同一件事：脚本没有 return，或这是事后查一条历史 run。
  if (result === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(result) ?? String(result);
  } catch {
    // 循环引用之类：退到 String()，绝不因为格式化失败而丢掉整条响应。
    text = String(result);
  }
  if (text.length <= RUN_RESULT_MAX_LENGTH) return `result: ${text}`;
  return `result: ${text.slice(0, RUN_RESULT_MAX_LENGTH)}… (truncated from ${text.length} chars)`;
}

export function formatScriptWorkflowList(runs: ScriptWorkflowRunRecord[]): string {
  if (runs.length === 0) return "No workflow runs found.";
  return [
    "Workflow runs:",
    ...runs.map((run) => {
      const stats = run.stats ?? emptyScriptWorkflowStats();
      return [
        `- ${run.id}`,
        `${run.status}`,
        run.name,
        `${stats.agentCalls} agents`,
        `${stats.toolCalls} tools`,
      ].join(" · ");
    }),
  ].join("\n");
}

function formatActivities(activities: ScriptWorkflowActivityRecord[]): string {
  if (activities.length === 0) return "";
  return [
    "Activities:",
    ...activities.map((activity) => {
      const label = activity.label ?? activity.phase ?? activity.type;
      const session = activity.childSessionId ? ` · ${activity.childSessionId}` : "";
      return `- ${activity.status} · ${label}${session}`;
    }),
  ].join("\n");
}

function formatStats(stats: ScriptWorkflowRunStats, usageIncomplete = false): string {
  return [
    `agents: ${stats.agentCalls}`,
    `cached: ${stats.cachedAgentCalls}`,
    `failed: ${stats.failedAgentCalls}`,
    usageIncomplete
      ? `tools: unknown (known subtotal: ${stats.toolCalls})`
      : `tools: ${stats.toolCalls}`,
    usageIncomplete
      ? `tokens: unknown (known subtotal: ${stats.tokens.total}; usage accounting incomplete)`
      : `tokens: ${stats.tokens.total}`,
  ].join(" · ");
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
