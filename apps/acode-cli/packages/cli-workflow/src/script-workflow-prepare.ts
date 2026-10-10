import type { ScriptWorkflowRunRecord, ScriptWorkflowStorePort, SessionId } from "@acode/contracts";
import type { readWorkflowScriptDocument } from "./script-workflow-meta.js";
import { stableHash } from "./script-workflow-meta.js";
import { emptyScriptWorkflowStats } from "./script-workflow-format.js";
import { inferScriptWorkflowScope } from "./script-workflow-utils.js";

export async function prepareScriptWorkflowRun(input: {
  args?: unknown;
  document: Awaited<ReturnType<typeof readWorkflowScriptDocument>>;
  parentSessionId: SessionId;
  ownerGeneration?: number;
  ownerToken?: string;
  remoteSessionId?: string;
  resumeFromRunId?: string;
  runId?: string;
  store: ScriptWorkflowStorePort;
  /**
   * 发起这次 run 的工具调用 id。存下来是因为它是两条联接的键：run 目录页把缺它的摘要整条
   * 剔除，冷恢复的 run 也靠它联回发起它的那一行工具调用（详见 contracts 侧字段注释）。
   * resume 路径不传：复用既有行，那一行的 toolCallId 是它自己出生时的事实，不该被改写。
   */
  toolCallId?: string;
  workspaceIdentity?: string;
  workingDirectory: string;
}): Promise<ScriptWorkflowRunRecord> {
  const definition = await input.store.upsertScriptWorkflowDefinition({
    id: `script_${stableHash(`${input.document.path}:${input.document.hash}`).slice(0, 24)}`,
    meta: input.document.meta,
    name: input.document.meta.name,
    scope: inferScriptWorkflowScope(input.document.path, input.workingDirectory),
    scriptHash: input.document.hash,
    scriptPath: input.document.path,
    source: "user",
  });
  if (input.resumeFromRunId) {
    const existing = await input.store.getScriptWorkflowRun(input.resumeFromRunId);
    if (!existing) throw new Error(`Workflow run not found: ${input.resumeFromRunId}`);
    return existing;
  }
  return input.store.createScriptWorkflowRun({
    args: input.args,
    argsHash: input.args === undefined ? undefined : stableHash(input.args),
    cwd: input.workingDirectory,
    definitionId: definition.id,
    id: input.runId ?? `wf_${crypto.randomUUID()}`,
    name: input.document.meta.name,
    parentSessionId: input.parentSessionId,
    ...(input.ownerGeneration === undefined ? {} : { ownerGeneration: input.ownerGeneration }),
    ...(input.ownerToken === undefined ? {} : { ownerToken: input.ownerToken }),
    ...(input.remoteSessionId === undefined ? {} : { remoteSessionId: input.remoteSessionId }),
    scriptHash: input.document.hash,
    scriptPath: input.document.path,
    stats: emptyScriptWorkflowStats(),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    // 本地调用方可以不提供稳定 identity；cwd 是同一套 owner 规则的兼容 fallback，
    // 但仍把事实落下来，避免新行再次回到“只按全局 runId”状态。
    workspaceIdentity: input.workspaceIdentity?.trim() || input.workingDirectory,
  });
}
