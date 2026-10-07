import type { ScriptWorkflowRunStatus } from "@acode/contracts";

/**
 * 脚本工作流 run 状态的**物理 ↔ 逻辑**映射，全仓只有这一份。
 *
 * ## 为什么需要两层词汇
 *
 * `workflow_run.status` 列带建表 CHECK 约束，物理词汇固定是六个词
 * （`SCRIPT_WORKFLOW_RUN_STATUSES`），放宽它要重建整张表（`workflow_activity` /
 * `workflow_event` / `session_task_link` 三张表外键引用它）。而业务上需要区分**三件**终态：
 *
 *   1. 脚本自己错了 → 物理 `failed`
 *   2. 用户停的     → 物理 `cancelled`，且**不写** failure
 *   3. 宿主进程没了 → 物理 `cancelled`，failure 带 {@link SCRIPT_WORKFLOW_INTERRUPTED_CODE}
 *
 * 2 与 3 共用一个物理词，靠 `failure_json` 里的**结构化 code** 分辨——不是靠 message 文本。
 * dwf 对同一件事的裁决写得很硬（`dynamic-workflow-run-reconcile.ts`）：「同码就只能靠 message
 * 文本区分『进程被杀』与『脚本真失败』」是被明确拒绝的做法。dwf 自己的落法也同构：
 * `dwf_run.status` 的 CHECK 集同样不含 `stopped`，逻辑态 `stopped{reason}` 编码成物理
 * `cancelled` + `{"stopReason": …}` 信封，映射只活在 `dwf-journal-codecs.ts` 一个文件里。
 *
 * ## 走过的弯路（留着以防有人再走一次）
 *
 * 曾经直接往 `SCRIPT_WORKFLOW_RUN_STATUSES` 加了一个 `interrupted`。类型全绿、假 store 的
 * 单测全绿，直到对着**真实库**跑一遍才炸：`CHECK constraint failed: status in (...)`。
 * 存储层的约束是单测桩替不了的那一类事实——这也是本仓「真实面验证」不可替代的一个具体例子。
 */

/** 孤儿收敛写进 `failure_json` 的结构化 code。改它等于改一份落库契约，要连解码一起改。 */
export const SCRIPT_WORKFLOW_INTERRUPTED_CODE = "ScriptWorkflowInterrupted";

/** 逻辑词汇 = 物理词汇 + `interrupted`（宿主进程在 run 结算前退出）。 */
export type ScriptWorkflowLogicalStatus = ScriptWorkflowRunStatus | "interrupted";

/** 带 code 的 failure 形状；只认 `code`，绝不解析 message 文本。 */
function readFailureCode(failure: unknown): string | undefined {
  if (!failure || typeof failure !== "object") return undefined;
  const code = (failure as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/**
 * 一行 run 的逻辑状态。
 *
 * 判据只有两条，且都是结构化的：物理词，以及 failure 上的 code。
 * `cancelled` 且 code 命中 → `interrupted`；`cancelled` 而 code 不命中 → 就是用户取消。
 * 其余物理词原样透传（它们本来就一一对应）。
 */
export function logicalScriptWorkflowStatus(row: {
  failure?: unknown;
  status: ScriptWorkflowRunStatus;
}): ScriptWorkflowLogicalStatus {
  if (row.status !== "cancelled") return row.status;
  return readFailureCode(row.failure) === SCRIPT_WORKFLOW_INTERRUPTED_CODE
    ? "interrupted"
    : "cancelled";
}

/** 孤儿收敛要写的那份 failure。code 是判据，message 只给人读。 */
export function interruptedRunFailure(runId: string): { code: string; message: string } {
  return {
    code: SCRIPT_WORKFLOW_INTERRUPTED_CODE,
    message: `script workflow run ${runId} was interrupted: the owning process exited before the run settled`,
  };
}
