import type { ScriptWorkflowRunRecord, ScriptWorkflowStorePort } from "@acode/contracts";
import { interruptedRunFailure } from "./script-workflow-run-status.js";

/**
 * 构造时收敛本会话的孤儿脚本工作流 run。
 *
 * ## 被修的问题
 *
 * run 起跑之后宿主进程被关掉（崩溃、外部 kill、机器睡眠后失联），`workflow_run` 行就
 * **永远停在 `running`**。而每个读面都照行回答：`scriptWorkflowStatus` 说「还在跑」、
 * 后台任务快照说「还在跑」、冷回放把这条行原样投影出来于是卡片亮着灯、Cancel 可点
 * 而后端无事可取消。永不自愈。
 *
 * 实测这个状态真实存在：库里就有一条 `wf_a33b872a…` 停在 `running`，是宿主被外部 timeout
 * 打死的遗物。
 *
 * ## 与 dwf 的同款裁决（`dynamic-workflow-run-reconcile.ts`）
 *
 *   - **时机是构造**：这一刻本实例名下零个在飞 run，所以属于本会话的任何非终态行都只可能是
 *     死进程的遗物。二次构造因此天然幂等（已无非终态项）。
 *   - **只收敛本会话**（`parentSessionId`）。全局清扫会把同进程兄弟会话正在飞的 run 标死。
 *   - **不合成事件**。事件表的契约是「运行期真发过什么」，状态权威在 run 行上；
 *     终态结算是 runtime 的收口，不是清扫者的。冷回放因此按**行**铸造结算
 *     （见 script-workflow-replay.ts），与 dwf「结算以行为准」同一条纪律。
 *   - **不让收敛失败拖垮构造**。收敛是自愈动作而不是 run 的前提：查询或写入失败时记 warn
 *     并继续（后果只是那行谎言还在），绝不把一次 app 构造变成启动失败。
 *
 * ## 收敛成哪个词
 *
 * 物理词是 `cancelled`，逻辑上是 `interrupted`——由 `failure_json` 里的结构化 code 分辨
 * （`script-workflow-run-status.ts` 是这份映射的唯一所有者）。
 *
 * 为什么不直接给物理词表加一个 `interrupted`：`workflow_run.status` 带建表 CHECK 约束，
 * 放宽它要重建整张表（三张表外键引用它）。本批**试过**加词，类型与假 store 单测全绿，
 * 直到对着真实库跑才炸出 `CHECK constraint failed: status in (...)`。dwf 面对同一个约束
 * 的做法也逐字同构：`dwf_run.status` 的 CHECK 集不含 `stopped`，逻辑态 `stopped{reason}`
 * 编码成物理 `cancelled` + `{"stopReason": …}` 信封。
 *
 * 三件终态因此都可分辨，且判据全是结构化的、不读 message 文本：
 * 脚本自己错了（物理 `failed`）、用户停了（物理 `cancelled` 且无 failure）、
 * 宿主没了（物理 `cancelled` 且 failure.code = ScriptWorkflowInterrupted）。
 */
export interface ScriptWorkflowOrphanReconcileDeps {
  logger?: {
    warn?: (message: string, context?: Record<string, unknown>) => void;
  };
  parentSessionId: string;
  store: ScriptWorkflowStorePort;
  ownerGeneration?: number;
  ownerToken?: string;
}

/** 非终态：进程死亡时会停在这三个词上。`interrupted` 本身是终态，所以二次构造幂等。 */
const NON_TERMINAL_STATUSES = ["pending", "running", "paused"] as const;

/** 收敛上界：一次构造不该因为一张病态的历史表而无限写下去。 */
const RECONCILE_MAX_ROWS = 64;

export async function reconcileOrphanScriptWorkflowRuns(
  deps: ScriptWorkflowOrphanReconcileDeps,
): Promise<void> {
  let orphans: ScriptWorkflowRunRecord[];
  try {
    orphans = await deps.store.listScriptWorkflowRuns({
      limit: RECONCILE_MAX_ROWS,
      parentSessionId: deps.parentSessionId,
      statuses: NON_TERMINAL_STATUSES,
    });
  } catch (error) {
    deps.logger?.warn?.("Script workflow orphan run query failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "script_workflow.run.reconcile_query_failed",
      module: "bootstrap.app",
    });
    return;
  }

  for (const row of orphans) {
    if (
      deps.ownerToken !== undefined &&
      deps.ownerGeneration !== undefined &&
      row.ownerToken !== undefined &&
      row.ownerGeneration !== undefined &&
      row.ownerToken === deps.ownerToken &&
      row.ownerGeneration === deps.ownerGeneration
    ) {
      continue;
    }
    try {
      await deps.store.updateScriptWorkflowRun({
        completedAt: Date.now(),
        // 物理词是 `cancelled`（CHECK 约束里没有 interrupted，也不为它重建整张表），
        // 逻辑上的「宿主没了」由 failure 里的**结构化 code** 承载——解码只有
        // script-workflow-run-status.ts 一处，与 dwf 的 dwf-journal-codecs.ts 同构。
        failure: interruptedRunFailure(row.id),
        id: row.id,
        ...(deps.ownerToken === undefined || deps.ownerGeneration === undefined
          ? {}
          : { ownerToken: deps.ownerToken, ownerGeneration: deps.ownerGeneration }),
        ownerTakeover: deps.ownerToken !== undefined && deps.ownerGeneration !== undefined,
        status: "cancelled",
      });
    } catch (error) {
      // 单行失败不牵连其余：一行写不动（只读库、并发写锁）不该让整个自愈动作放弃。
      deps.logger?.warn?.("Script workflow orphan run reconciliation failed for one run", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "script_workflow.run.reconcile_row_failed",
        module: "bootstrap.app",
        runId: row.id,
      });
    }
  }
}
