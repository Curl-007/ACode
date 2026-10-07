import type {
  DynamicWorkflowRunSessionSummary,
  ScriptWorkflowRunRecord,
} from "@acode/contracts";
import {
  logicalScriptWorkflowStatus,
  type ScriptWorkflowLogicalStatus,
} from "./script-workflow-run-status.js";

/**
 * 脚本工作流的 run 记录 → run 目录摘要。
 *
 * ## 为什么目录页需要它
 *
 * `WorkflowRunDirectorySidePane` 的清单来自 v4 查询 `conversationWorkflowRuns`，而那个查询
 * 此前只有一个来源：dwf 的 journal（`listDynamicWorkflowRuns` → `listRunsForSession`）。
 * 脚本工作流的 run 不在那份 journal 里，所以目录页根本看不见它们——即使投影里有、
 * 侧栏能打开。目录是「这个会话跑过哪些工作流」的发现面，少一半就是少一半。
 *
 * ## 状态词的翻译
 *
 * 两套系统各有自己的终态词表，目录摘要用的是 dwf 那一套（`completed | errored | pending |
 * running | stopped`，与投影同一个五值词汇）。逐条对应：
 *
 *   completed            → completed
 *   failed               → errored
 *   cancelled            → stopped + stopReason:"user"
 *   pending/running/paused → running
 *
 * `cancelled → stopped/user` 与实时投影走的是同一笔语义（`workflow_cancelled` 那条映射）：
 * 用户停下不是脚本崩了，两者在渲染侧颜色与文案都不同。`paused` 归进 running 是因为目录只有
 * 五值词汇可说，而 paused 的 run 确实还活着——把它说成 stopped 会让读者以为可以不管了。
 *
 * ## resumable 恒 false
 *
 * 脚本工作流确实能按 `resumeFromRunId` 续跑，但那是模型经 `RunWorkflow` 走的路，用户面前
 * 没有任何一条 `/dwf resume` 式的命令能续它（`/dwf resume` 打到 dwf 的 run service，
 * 对 `wf_` 前缀的 run 必然失败）。亮起一个按不动的 Resume 比不亮更糟。
 * 这与适配器、`isWorkflowRunResumable` 的方言门是**同一条裁决的第三处**，三处必须同结论。
 *
 * ## toolCallId 缺席
 *
 * run 记录里没有这一列，所以目录行联不回发起它的那行工具调用。后果与冷回放同款：
 * 不出现在聊天里的工具卡上，但目录、状态面板与侧栏都按 runId 工作，照旧能开。
 */
export function toScriptWorkflowRunSummary(
  row: ScriptWorkflowRunRecord,
): DynamicWorkflowRunSessionSummary {
  // 按**逻辑**状态翻译，不是物理状态：物理词 `cancelled` 同时承载「用户停的」与「宿主没了」，
  // 两者在目录页必须是两句话（stopped by you / stopped process exited）。
  const { status, stopReason } = toDirectoryStatus(logicalScriptWorkflowStatus(row));
  const failure = readFailureMessage(row.failure);
  return {
    dialect: "script",
    label: row.name,
    runId: row.id,
    resumable: false,
    status,
    updatedAt: row.updatedAt,
    // 目录页把缺 toolCallId 的摘要整条剔除（workflowRunDirectoryModel.ts 的 hasDetailAnchor），
    // 所以这一位是脚本 run 能不能出现在目录里的**决定条件**。migration 0027 之前的存量行
    // 没有这个事实，照旧会被剔除——与 dwf 那些 `tool_call_id` 落库之前的老 run 同一个处境。
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(failure === undefined ? {} : { failureMessage: failure }),
  };
}

function toDirectoryStatus(status: ScriptWorkflowLogicalStatus): {
  status: DynamicWorkflowRunSessionSummary["status"];
  stopReason?: DynamicWorkflowRunSessionSummary["stopReason"];
} {
  switch (status) {
    case "completed":
      return { status: "completed" };
    case "failed":
      return { status: "errored" };
    case "cancelled":
      return { status: "stopped", stopReason: "user" };
    // 宿主进程死了：与 dwf 的孤儿收敛逐字同一个词（stopped + interrupted），
    // 于是两套 run 在目录页对同一件事说同一句话，渲染成「stopped (process exited)」。
    case "interrupted":
      return { status: "stopped", stopReason: "interrupted" };
    default:
      // pending / running / paused：都还活着。
      return { status: "running" };
  }
}

/** 失败原文只在 errored 时有话说；形状与工具端口的 failureMessage 同款（字符串或带 message 的对象）。 */
function readFailureMessage(failure: unknown): string | undefined {
  if (!failure) return undefined;
  if (typeof failure === "string") return failure.slice(0, 2048) || undefined;
  if (typeof failure === "object" && "message" in failure) {
    const message = (failure as { message?: unknown }).message;
    return typeof message === "string" && message.length > 0 ? message.slice(0, 2048) : undefined;
  }
  return undefined;
}
