// ============================================================
// Run 观察面：列表 / 详情截面与会话摘要（自 dynamic-workflow-run-observation.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 613 行超过 400 行门禁。本叶承载除快照外的全部合成：列表/详情共用的
// journal / registry 截面、终态字段（result / error）、日志映射、会话摘要。依赖方向：
// observation-registry（状态合成核）← 本叶；observation-snapshot 取本叶的 terminalErrorField
// （单向，本叶不依赖快照叶）。叶子不反向 import 原文件（原文件降为桶，原样再导出）。
//
// 本文件同样是 @acode/workflow-run-read 契约的调用点：label / lineage 的归并住在读模型包里。

import type { DwfRunListItem, DwfRunSessionListItem } from "@acode/adapters/storage";
import { lineageFields, resolveDynamicWorkflowRunLabel, supersededByOf } from "@acode/workflow-run-read/contract";
import { boundDynamicWorkflowRunEventPayload } from "@acode/contracts";
import type {
  DynamicWorkflowRunError,
  DynamicWorkflowRunLogEntry,
  DynamicWorkflowRunSessionSummary,
  DynamicWorkflowRunSummary,
} from "@acode/contracts";
import type {
  RunStatus,
  StoredEvent,
  WorkflowErrorJson,
} from "@acode/dynamic-workflow";
import {
  TERMINAL_RUN_STATUSES,
  isResumableSettlement,
  stopReasonOf,
  synthesizeRunStatus,
  type RunRegistryEntry,
} from "./observation-registry.js";

/**
 * journal 行（+ 可选的内存条目）→ 列表与详情的共同截面。
 *
 * 时间戳**直读 journal 行**，刻意绕开 {@link snapshotOf} 的 `new Date(0)` 兜底：内存条目被
 * 逐出后那个起始时间是假的，而内省面的时间是模型据以判断"多久以前"的依据。
 */
export function journalRunSummary(
  row: DwfRunListItem,
  entry: RunRegistryEntry | undefined,
  ownerSessionId: string,
): DynamicWorkflowRunSummary {
  const ownedByThisSession = entry !== undefined || row.parentSessionId === ownerSessionId;
  // 读的是 **journal 的** status 而不是合成后的：语义就是「journal 说它还没结束，而本会话无法证实」。
  // （这个分支上两者必然相等——非本会话、不在注册表，就没有内存终态可以覆盖 journal——按字面写是为了将来新增真相源时这条断言依然成立。）
  const possiblyInterrupted = !TERMINAL_RUN_STATUSES.has(row.status) && !ownedByThisSession;
  const stopReason = stopReasonOf(entry, row);
  return {
    runId: row.runId,
    ...resolveDynamicWorkflowRunLabel({
      runId: row.runId,
      ...(row.name === undefined ? {} : { name: row.name }),
      ...(row.scriptText === undefined ? {} : { scriptText: row.scriptText }),
    }),
    status: synthesizeRunStatus(entry, row.status),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...lineageFields(entry?.resumedFrom ?? row.resumedFrom, supersededByOf(entry, row)),
    ownedByThisSession,
    // 为真时才在场：缺席读作「没有这个疑虑」，而 `false` 会让每一行都带一个噪音字段。
    ...(possiblyInterrupted ? { possiblyInterrupted: true } : {}),
    createdAt: row.timeCreated,
    updatedAt: row.timeUpdated,
  };
}

/**
 * 只有内存条目的 run（submit → createRun 的微任务间隙）→ 共同截面。
 *
 * 归属恒为真（它就在本会话的注册表里），因此也永远不带 `possiblyInterrupted`。时间戳取自
 * 注册时刻——这不是兜底猜测，而是这个 run 真实的提交时间（journal 行落下时写的是同一毫秒级 `Date.now()`）。
 */
export function registryRunSummary(runId: string, entry: RunRegistryEntry): DynamicWorkflowRunSummary {
  return {
    runId,
    ...resolveDynamicWorkflowRunLabel({
      runId,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      scriptText: entry.scriptText,
    }),
    status: synthesizeRunStatus(entry, undefined),
    ...(entry.terminal?.status === "stopped" ? { stopReason: entry.terminal.reason } : {}),
    ...lineageFields(entry.resumedFrom, supersededByOf(entry, undefined)),
    ownedByThisSession: true,
    createdAt: entry.startedAt.getTime(),
    updatedAt: (entry.completedAt ?? entry.startedAt).getTime(),
  };
}

/**
 * completed 的 run 才带产物，且 `undefined` 产物 = **整字段缺席**（与完成通知同规）。
 *
 * 优先级同 {@link snapshotOf}：内存终态的 artifact 是本进程刚从引擎手里接过的**原值**，journal 的
 * result_json 是它经过一次 JSON 往返后的形态；条目被逐出后才退到后者。值本身**原样交出、不序列化**——面向模型的文本投影在 core 有唯一实现，端口再做一次就会出现「同一个产物在通知里和在工具里长得不一样」。
 */
export function terminalResultField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { result?: unknown },
): { result?: unknown } {
  if (status !== "completed") return {};
  if (entry?.terminal?.status === "completed" && entry.terminal.artifact !== undefined) {
    return { result: entry.terminal.artifact };
  }
  // `result: null` 是合法产物（`ask<T | null>` 会返回它），所以判据是 `!== undefined` 而不是真值性——解码侧同样只在列非 NULL 时才写出这个键。
  return row?.result === undefined ? {} : { result: row.result };
}

/**
 * errored 恒带失败；stopped 只对 provider / interrupted 带（user / model 停下没有失败可言）。
 * journal 的 `failure_json` 是**权威**：它带结构化 code，`Interrupted`（进程死了）、`ProviderStop`
 * （模型侧确定性错误）与 `DriverError`（脚本真失败）因此可以被模型分辨——所以这里原样透出 code，绝不折叠成一个通用失败；`ProviderStop` 的结构化明细一并透出。
 */
export function terminalErrorField(
  status: RunStatus,
  entry: RunRegistryEntry | undefined,
  row?: { failure?: WorkflowErrorJson },
): { error?: DynamicWorkflowRunError } {
  if (status !== "errored" && status !== "stopped") return {};
  // 内存终态优先：本进程刚从引擎手里接过的结算带原值（ProviderStop 明细齐全），journal 行是它经一次 JSON 往返后的形态；条目被逐出后才退到后者。
  const memoryError =
    entry?.terminal?.status === "errored"
      ? entry.terminal.error
      : entry?.terminal?.status === "stopped"
        ? entry.terminal.error
        : undefined;
  if (memoryError !== undefined) {
    // 引擎构造之前就失败的路径（子进程无法 spawn、构造抛错）在注册表里放的是一个包装过的普通 Error——运行时可能没有 code。归到 DriverError 而不是编一个新码：那条路径的失败确实来自引擎之外的驱动层。
    const code = typeof memoryError.code === "string" ? memoryError.code : "DriverError";
    const providerStop = (memoryError as { providerStop?: WorkflowErrorJson["providerStop"] })
      .providerStop;
    return {
      error: {
        code,
        message: memoryError.message,
        ...(providerStop === undefined ? {} : { providerStop }),
      },
    };
  }
  if (row?.failure !== undefined) {
    return {
      error: {
        code: row.failure.code,
        message: row.failure.message,
        ...(row.failure.providerStop === undefined
          ? {}
          : { providerStop: row.failure.providerStop }),
      },
    };
  }
  return {};
}

/**
 * 一条 journal 里的 `log` 事件 → 端口的 logTail 项。
 *
 * 消息经 {@link boundDynamicWorkflowRunEventPayload} 有界化而不是自己 slice：字符串上限（2048）与代理项安全的截断规则已经在端口那一侧写过一遍，抄第二遍就会在某次调参时分叉。查询已按 `type='log'` 下推过滤，所以非 log 事件只可能来自实现漂移——此时给空消息而不是崩掉整个详情面。
 */
export function toLogTailEntry(stored: StoredEvent): DynamicWorkflowRunLogEntry {
  const message = stored.event.type === "log" ? stored.event.message : "";
  const { payload } = boundDynamicWorkflowRunEventPayload({ message });
  return {
    sequence: stored.sequence,
    message: typeof payload.message === "string" ? payload.message : "",
    // 落库时刻原样过界；没有这一列的老 journal 上缺席（读侧据此不给年龄）。
    ...(stored.timeCreated === undefined ? {} : { at: stored.timeCreated }),
  };
}

/**
 * 枚举行 → 会话枚举摘要。三件事都刻意与别处同源：
 *   - `resumable` 用 resume 门的同一个谓词（{@link isResumableSettlement}）；
 *   - `label` 用两条读面共用的那条派生链（{@link resolveDynamicWorkflowRunLabel}）——枚举面自己拼一次兜底，同一个 run 就会在 `/dwf list` 与工具卡上显示不同的名字；
 *   - `updatedAt` 直读 journal 行的 `timeUpdated`（`RunRecord` 不带时间，故入参是枚举行）。
 */
export function toSessionSummary(
  row: DwfRunSessionListItem,
  entry?: RunRegistryEntry,
): DynamicWorkflowRunSessionSummary {
  const { label } = resolveDynamicWorkflowRunLabel({
    runId: row.runId,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.scriptText === undefined ? {} : { scriptText: row.scriptText }),
  });
  // 第四条读面也走同一条优先级（{@link synthesizeRunStatus}）：活条目下行上的终态是外来写入，状态报 running，停止原因与失败一并不出。少了这一支，会话列表会独自显示一个已经「停下」的 run，而快照 / 列表 / 详情三处都说它在跑。
  const status = synthesizeRunStatus(entry, row.status);
  const stopReason = stopReasonOf(entry, row);
  const live = entry !== undefined && entry.terminal === undefined;
  return {
    runId: row.runId,
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
    label,
    updatedAt: row.timeUpdated,
    status,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...lineageFields(row.resumedFrom, supersededByOf(entry, row)),
    ...(live || row.failure?.code === undefined ? {} : { failureCode: row.failure.code }),
    ...(live || row.failure?.message === undefined ? {} : { failureMessage: row.failure.message }),
    resumable: isResumableSettlement(status, stopReason),
  };
}
