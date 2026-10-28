// ============================================================
// ScriptWorkflowRuntime：只读查询面（validate / list / status）
// ============================================================
// script-workflow-runtime.ts 偿还 W1-R3 max-lines 例外：把与 run 生命周期无关的三条只读查询拆到本文件。
// 对 store 与 deps 的全部触碰经 {@link ScriptWorkflowQueryHost} 显式递进来；原方法体逐字保留。
// 公开类形状不变，主类只做薄委托。
//
// 依赖方向（无运行时环）：本文件 → meta / format / session-store.port（类型）；主类 → 本文件。
// 依赖注入：查询函数只经 {@link ScriptWorkflowQueryHost} 接触 runtime 状态；主类构造时构造一个满足本接口的宿主对象传入。
// 编排纪律：validate/list/status 不触 agentCallCounts 与 statsWrites（validate 不派生 agent，
// 去碰只会清掉某个在飞 run 的额度，见 agentCallCounts 字段注释）。

import type { ScriptWorkflowRunStatus, ScriptWorkflowStorePort } from "@acode/contracts";
import { formatScriptWorkflowList, formatScriptWorkflowRun, formatScriptWorkflowValidation } from "./script-workflow-format.js";
import { readWorkflowScriptDocument } from "./script-workflow-meta.js";
import type { ScriptWorkflowRuntimeDeps } from "./script-workflow-runtime-deps.js";

/** 查询面经此接触 runtime 的私有状态：依赖与 store 窄化。 */
export interface ScriptWorkflowQueryHost {
  readonly deps: ScriptWorkflowRuntimeDeps;
  store(): ScriptWorkflowStorePort;
}

/** 校验一个工作流脚本（原 validate 方法体）。 */
export async function validateWorkflowScript(
  host: ScriptWorkflowQueryHost,
  input: { scriptPath: string },
): Promise<{ response: string; traceId: string }> {
  const document = await readWorkflowScriptDocument({
    fileSystemPort: host.deps.fileSystemPort,
    scriptPath: input.scriptPath,
    traceContext: host.deps.traceContext,
  });
  // 刻意不碰 agentCallCounts：validate 不派生任何 agent，它去重置计数只会清掉某个在飞 run
  // 的额度（见字段注释）。
  return {
    response: formatScriptWorkflowValidation({
      meta: document.meta,
      scriptHash: document.hash,
      scriptPath: document.path,
    }),
    traceId: host.deps.traceContext.traceId,
  };
}

/** 列出本工作区的工作流 run（原 list 方法体）。 */
export async function listWorkflowRuns(
  host: ScriptWorkflowQueryHost,
  input: { limit?: number } = {},
): Promise<{ response: string; traceId: string }> {
  const runs = await host.store().listScriptWorkflowRuns({
    cwd: host.deps.workingDirectory,
    limit: input.limit ?? 20,
  });
  return {
    response: formatScriptWorkflowList(runs),
    traceId: host.deps.traceContext.traceId,
  };
}

/** 单个 run 的状态（原 status 方法体；runId 缺席时取最近一条）。 */
export async function getWorkflowRunStatus(
  host: ScriptWorkflowQueryHost,
  input: { runId?: string } = {},
): Promise<{
  response: string;
  runId?: string;
  status?: ScriptWorkflowRunStatus;
  traceId: string;
}> {
  const run = input.runId
    ? await host.store().getScriptWorkflowRun(input.runId)
    : (
        await host.store().listScriptWorkflowRuns({
          cwd: host.deps.workingDirectory,
          limit: 1,
        })
      )[0];
  if (!run) {
    return {
      response: "No workflow run found.",
      traceId: host.deps.traceContext.traceId,
    };
  }
  const activities = await host.store().listScriptWorkflowActivities({ runId: run.id });
  return {
    response: formatScriptWorkflowRun({ activities, run }),
    runId: run.id,
    status: run.status,
    traceId: host.deps.traceContext.traceId,
  };
}
