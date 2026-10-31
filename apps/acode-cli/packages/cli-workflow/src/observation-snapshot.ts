// ============================================================
// Run 观察面：快照合成（自 dynamic-workflow-run-observation.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 613 行超过 400 行门禁。本叶只承载 `getTask` 快照的合成（纯规则，无 I/O、
// 无状态）。依赖方向：observation-registry（状态合成核）← observation-snapshot（本叶）与
// observation-detail 两叶；本叶另从 detail 叶取 `terminalErrorField`（单向，detail 不反向依赖本叶）。
// 叶子不反向 import 原文件（原文件降为桶，原样再导出）。
//
// 本文件是 `@acode/workflow-run-read` 契约的调用点之一：lineage / artifacts / activeMs 的
// 归并都住在读模型包里，本叶只合成它们。
//
// ⚠ 术语：这里的 artifact 是**用户面产物**（脚本经 `artifact.*` 发布给用户看的字节），
// 与 `output`（脚本顶层返回值，引擎内部也叫 artifact）是两件不同的东西。

import {
  artifactsOf,
  lineageFields,
  runLineageActiveMs,
  supersededByOf,
} from "@acode/workflow-run-read/contract";
import type {
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunSnapshot,
} from "@acode/contracts";
import type { JournalStorePort, NodeRecord } from "@acode/dynamic-workflow";
import { readRunScriptPath, readRunSubagentModel } from "./dynamic-workflow-run-launch-anchor.js";
import { terminalErrorField } from "./observation-detail.js";
import {
  TERMINAL_RUN_STATUSES,
  runStatusToTaskStatus,
  stopReasonOf,
  synthesizeRunStatus,
  type RunRegistryEntry,
} from "./observation-registry.js";

/**
 * 由 journal 记录 + 活注册表合成快照。两者都没有该 run 时返回 undefined（上层归一成 lost）。
 *
 * `pendingQuestions` 由调用方从**内存的**升级停驻表投影好再传进来（本文件的纪律是无 I/O、
 * 无状态）。传空数组即「此刻没有待答问题」，字段整个缺席——不发空数组。
 *
 * `concurrencyCeiling` 同理由调用方给（读它要探进程核数 = I/O）：缺席即「本次读不判天花板」，
 * `maxConcurrency` 整字段不出——见 {@link runConcurrencyField}。
 */
export function snapshotOf(
  taskId: string,
  runs: Map<string, RunRegistryEntry>,
  journal: JournalStorePort,
  pendingQuestions: readonly DynamicWorkflowRunPendingQuestion[] = [],
  concurrencyCeiling?: number,
): DynamicWorkflowRunSnapshot | undefined {
  const entry = runs.get(taskId);
  const record = journal.getRun(taskId);
  if (entry === undefined && record === undefined) return undefined;

  // 状态合成的唯一实现（见 {@link synthesizeRunStatus}）。快照面的词汇表没有 pending，
  // 所以在最后一步折叠：runStatusToTaskStatus 把 pending 与 running 一起报成 running——
  // 这正是"在注册表里就是在跑"的既有行为（缺了它，刚 submit 的 run 第一次轮询就被判成 lost）。
  const status: DynamicWorkflowRunSnapshot["status"] = runStatusToTaskStatus(
    synthesizeRunStatus(entry, record?.status),
  );

  // 节点行只扫**一次**，reports 与 artifacts 共用（两者都只在终态取数，见各自的注释）。
  // 分别 listNodes 就是把一个 256 节点 run 的全表解码做两遍。
  const nodes = status === "running" ? undefined : journal.listNodes(taskId);

  // lineage 的活动时长：
  // 与 nodes 同一道终态闸门、同一条论证——它的唯一消费者是终态通知，而快照被后台追踪器反复轮询。
  const activeDurationMs = status === "running" ? undefined : runLineageActiveMs(journal, taskId);

  // 真实终态词 + 停止原因 + 结构化失败：快照基类的 `status` 是后台任务追踪器的通用词汇（stopped 折成
  // cancelled、errored 折成 failed），通知要说真话只能读这三个字段。终态之前不带（还没有可说的终局）。
  const runStatus = synthesizeRunStatus(entry, record?.status);
  const terminal = TERMINAL_RUN_STATUSES.has(runStatus);
  const stopReason = terminal ? stopReasonOf(entry, record) : undefined;
  const failure = terminal ? terminalErrorField(runStatus, entry, record).error : undefined;
  const error = failure?.message;
  // 归属：AmendWorkflow 的 resolveInput 读快照判「是不是本会话的 run」；lineage 两端指针见 lineageFields。
  const parentSessionId = entry?.parentSessionId ?? record?.parentSessionId;

  return {
    runId: taskId,
    taskId,
    startedAt: entry?.startedAt ?? new Date(0),
    status,
    ...(terminal ? { runStatus } : {}),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...lineageFields(entry?.resumedFrom ?? record?.resumedFrom, supersededByOf(entry, record)),
    // 内存副本优先于 journal，与上面每一个间隙字段同规：submit → createRun 的那几个微任务里
    // 行还不存在，而 AmendWorkflow 的 resolveInput 恰好会在那时读这张快照。
    ...runConcurrencyField(
      entry?.maxConcurrency ?? record?.caps.maxConcurrency,
      concurrencyCeiling,
    ),
    // 子代理模型：**有条目就读条目**（三条建条目的路都落值，见 RunRegistryEntry.subagentModel），
    // 只有冷行——本进程没有条目——才去扫一次事件头（八条的有界扫描，不是整条 journal）。
    // 它没有并发上界那道「值不值得一提」的判据：只在用户显式设过时才存在，在场本身就是全部
    // 的信息。缺席即跑在会话模型上。
    ...runSubagentModelField(
      entry === undefined ? readRunSubagentModel(journal, taskId) : entry.subagentModel,
    ),
    // 脚本文件：与子代理模型逐条同规（有条目就读条目，只有冷行才扫一次事件头），同样「记过才在场」。
    // 终态通知据它把下一步说成「就地编辑那个文件」，所以快照必须带上它。
    ...runScriptPathField(
      entry === undefined ? readRunScriptPath(journal, taskId) : entry.scriptPath,
    ),
    ...(failure === undefined ? {} : { failure }),
    ...(activeDurationMs === undefined ? {} : { activeDurationMs }),
    ...(entry?.completedAt === undefined ? {} : { completedAt: entry.completedAt }),
    ...(error === undefined ? {} : { error }),
    // 零条时整字段缺席（与 reports 同规）：读侧据此让整块 pending 区消失，不渲染空节。
    ...(pendingQuestions.length === 0 ? {} : { pendingQuestions }),
    ...reportsOf(nodes),
    // 用户面产物。⚠ 与紧邻的 `output`（`entry.terminal.artifact` = 脚本顶层返回值，引擎内部也叫
    // artifact）是**两件不同的东西**：这里是脚本经 `artifact.*` 发布给用户看的产出，那里是给模型看
    // 的返回值。
    ...(nodes === undefined ? {} : artifactsOf(taskId, journal, nodes)),
    ...(entry?.terminal?.status === "completed"
      ? { output: entry.terminal.artifact }
      : // 重启后本进程的注册表是空的，产物只能从 journal 记录取（journal 行的 result_json）。内存终态在上一支里优先——
        // 它是本进程刚从引擎手里接过的原值。
        record?.status === "completed" && record.result !== undefined
        ? { output: record.result }
        : {}),
  };
}

/**
 * 两条读面（`getTask` 快照与 `getRunDetail` 详情）上的 `maxConcurrency`
 *
 * **只在低于当前天花板时在场**：跑在天花板上的 run 没有可说的——它就是默认行为，而每一行都带一个等于默认值的数，只会让模型把「没设限」读成「设了个限」。
 * 天花板缺席（调用方没给）时同样整字段不出：判据都没有，报一个数就是在猜。
 *
 * 一处实现供两条读面共用：两处各判一次，「等于天花板算不算在场」迟早会在某一次调参时分叉。
 */
export function runConcurrencyField(
  applied: number | undefined,
  ceiling: number | undefined,
): { maxConcurrency?: number } {
  if (applied === undefined || ceiling === undefined || applied >= ceiling) return {};
  return { maxConcurrency: applied };
}

/**
 * 两条读面（`getTask` 快照与 `getRunDetail` 详情）上的 `subagentModel`
 *
 * 规则只有一条：**设过才在场**。与 {@link runConcurrencyField} 不同，这里没有可比的默认值——「跑在会话模型上」不是一个能写进这个字段的字符串，而把当前会话模型填进去会让读侧把「没设」读成「设了，正好等于会话模型」，两者在 amend 的三态里是不同的意思。
 *
 * 一处实现供两条读面共用，与并发上界同一条论证。
 */
export function runSubagentModelField(subagentModel: string | undefined): {
  subagentModel?: string;
} {
  return subagentModel === undefined ? {} : { subagentModel };
}

/**
 * 两条读面上的 `scriptPath`。规则与 {@link runSubagentModelField} 逐字相同：**记过才在场**，没有可比的默认值——「这个 run 没有脚本文件」不是一个能写进这个字段的路径，而填一个猜出来的路径会让模型去编辑一个与本 run 无关的文件。一处实现供两条读面共用。
 */
export function runScriptPathField(scriptPath: string | undefined): { scriptPath?: string } {
  return scriptPath === undefined ? {} : { scriptPath };
}

/**
 * 终态快照上的 `reports`：journal 里 `kind = "report"` 的节点行（一次写入、恒 `completed`、
 * 被报告的 item 就在 `result` 上），按插入顺序 = 报告顺序。
 *
 * 为什么从 journal 读而不是从投影读：`workflowRuns.reports` 是有界的 memory-only 展示面（冷恢复后为空），而这些行是那些条目的**持久家**。完成通知要在 failed / cancelled 上一样携带产物——一个死在第 12 个 ask 上的 run 仍然做完了 11 个 ask 的活，捞回它正是 `report` 存在的理由——所以它读的必须是持久那一份。
 *
 * 只在**终态**读：`getTask` 会被后台追踪器反复轮询，而 `listNodes` 是一次全表扫（一个 256 节点的 run 每次轮询都要解码 256 行）。唯一的消费者是终态通知与终态 TaskOutput，在飞时读它没有读者，只有成本。这条判据现在由调用方执行——`nodes` 缺席即「在飞，别读」，好让同一次扫描同时喂 {@link artifactsOf}。
 */
function reportsOf(nodes: readonly NodeRecord[] | undefined): { reports?: readonly unknown[] } {
  if (nodes === undefined) return {};
  const items = nodes.filter((node) => node.kind === "report").map((node) => node.result);
  // 零条时整字段缺席：通知端据此让整节 `<reports>` 消失，不发空节。
  return items.length === 0 ? {} : { reports: items };
}
