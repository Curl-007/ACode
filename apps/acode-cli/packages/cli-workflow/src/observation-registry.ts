// ============================================================
// Run 观察面：注册表条目 + 状态真相合成核心（自 dynamic-workflow-run-observation.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 613 行超过 400 行门禁。按「共享状态核 → 快照面 → 详情面」拆成三叶：
//   - observation-registry.ts（本叶）：注册表条目类型、终态集、状态合成优先级（四档）、
//     resume 谓词、结算等待——快照与详情两叶都只向前依赖本叶；
//   - observation-snapshot.ts：快照合成（依赖本叶与 detail 叶的 terminalErrorField，单向）；
//   - observation-detail.ts：列表/详情截面、日志映射、会话摘要。
// 叶子不反向 import 原文件（原文件降为桶，原样再导出全部 17 个导出符号 + artifactsOf）。

import type {
  DynamicWorkflowRunSnapshot,
  DynamicWorkflowRunStopReason,
} from "@acode/contracts";
import type {
  RunRecord,
  RunSettlement,
  RunStatus,
  RunStopReason,
  WorkflowErrorCode,
} from "@acode/dynamic-workflow";
import type { ActorSessionQuiescence } from "./workflow-driver-types.js";
import type { WorkflowRunControl } from "./workflow-run-control.js";

/** 注册表条目：一个在飞或近期结算的 run。 */
export interface RunRegistryEntry {
  controller: AbortController;
  startedAt: Date;
  toolCallId?: string;
  parentSessionId?: string;
  /**
   * 三个 submit 时元数据的内存副本，只服务于 **submit → createRun 的微任务间隙**：那一刻
   * journal 里还没有行，而枚举面必须能把这个 run 按项目过滤（cwd）并给出标签（name /
   * 脚本首行）。行一旦出现，journal 就是这三者的权威，内存副本不再被读。
   */
  cwd: string;
  name?: string;
  scriptText: string;
  /**
   * 本 run 实际生效的并发上界（`dwf_run.caps_max_concurrency` 的内存副本，同一条间隙论证）。
   * submit / amend 落值，**resume 不落**——那条路沿用 journal 记录里的 caps，而它的行早就在了。
   */
  maxConcurrency?: number;
  /**
   * 本 run 的活体控制面。与 {@link controller} 并列而非合并：那个是「停下这个 run」的唯一通道，
   * 这个是「改这个 run 的一项设置」的唯一通道，两者的收件人（harness 的 signal / 引擎与座位闸门）
   * 也不是同一个。
   *
   * 三条建条目的路都造一个（submit / amend / resume），launch 把它的两端接上。条目在、句柄的
   * `setMaxConcurrency` 却回 false，就是「run 在这两步之间结算了」——`retuneConcurrency` 据此
   * 回 `not_live`。
   */
  control?: WorkflowRunControl;
  /**
   * 本 run 的子代理模型（`run-launched` 事件上那个规范 picker 串
   * `providerId/modelId[$reasoningLevel]` 的内存副本）。
   * 同一条间隙论证：`AmendWorkflow` 的 resolveInput 读快照判「沿用什么」，而修订一个刚起步的
   * run 恰好落在 submit → 引擎记事件的那几个微任务里。
   *
   * **三条建条目的路都落值**：submit / amend 用刚归一出来的那个串，resume 读一次事件头抄过来。
   * 值在建 run 那一世写死、本 run 余生不变，所以副本与事件不可能分叉——读面因此只剩一条规则：
   * 有条目就读条目，只有冷行（本进程没有条目）才去扫事件。缺席即子代理跑在会话模型上。
   */
  subagentModel?: string;
  /**
   * 本 run 的脚本文件（`run-launched` 事件上那个绝对路径的内存副本）。与 {@link subagentModel} 逐条同规：
   * 三条建条目的路都落值（submit / amend 用入参给的那一个，resume 读一次事件头抄过来），
   * 值在建 run 那一世写死、余生不变，所以副本与事件不可能分叉。缺席即这个 run 没有文件。
   */
  scriptPath?: string;
  /** 修订 run 的前驱（`dwf_run.resumed_from` 的内存副本，journal 行出现之前枚举面唯一能读到的地方）。 */
  resumedFrom?: string;
  /**
   * 本 run 的用量起点（前驱结算后的 `spentTokens`）。同一条间隙论证：行落库之前两条读面只能从条目读用量，
   * 而修订一个刚起步的 run 恰好落在那几个微任务里。**只有 amend 路落值**：全新 submit 从零起账，
   * resume 的行早就在了。
   */
  inheritedTokens?: number;
  /**
   * 本 run 的 driver 交出来的**会话静默探针**（workflow-driver-quiescence.ts）。driver 构造时
   * 回填，所以刚建好的条目上还没有——那个间隙里这个 run 连一个 actor 会话都还没建，问它也无话可说。
   *
   * 唯一的读者是 amend：取代一个在飞前驱之后，它要先确认那些会话已经写完，才谈得上接续那条
   * 未完的 ask（`inFlight`）。探针的所有权就在这个条目上——一个 run 一份，随 driver 生灭，
   * 不另立进程级注册表。
   */
  quiescence?: ActorSessionQuiescence;
  /** 结算 promise；waitForTask 等它。fire-and-forget 的那条链就挂在这里。 */
  settlement: Promise<RunSettlement>;
  /** 已结算时的终态（产物/错误只在这里，journal 不存脚本返回值）。 */
  terminal?: RunSettlement;
  completedAt?: Date;
  /**
   * 已经为这个条目记过一次「journal 行是外来终态」的日志（见 {@link synthesizeRunStatus} 的
   * 优先级说明）。追踪器每秒轮询一次，不记这个标记就会每秒一条同样的 warn。
   */
  foreignTerminalLogged?: true;
}

/**
 * run 的终态集（不含 pending / running）。
 * 这里是「什么算终态」的**唯一权威**：journal 侧的 SQL 只做索引友好的预筛，收敛前按本集合
 * 再判一次，好让将来新增一个非终态状态时只有这一处要改。
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "errored",
  "stopped",
]);

/**
 * **状态真相合成的唯一实现**，优先级四档：
 *   内存终态 > 活条目（journal 状态只在非终态时采信）> journal 状态 > 「在注册表里但还没有行」。
 *
 * 本进程引擎仍存活时，journal 中的终态行可能来自另一实例的孤儿收敛，不能据此结束本地追踪。
 * 本地已结算时优先使用内存终态；第二档处理尚未结算的活条目，忽略外部终态行并等待引擎结算，
 * 避免提前通知模型、标完任务后丢弃真正的完成结果。
 *
 * 三个读面（快照、列表、详情）共用它。之所以返回 journal 的 {@link RunStatus} 词汇表而不是
 * 快照的：那一档最细——`pending`（已提交、引擎还没建行）在内省面上是模型看得懂的区别，而
 * 快照面把它折进 `running` 只是它自己的词汇表限制（{@link runStatusToTaskStatus} 负责折叠）。
 * 反过来（先折叠再想办法还原）就得在下游猜"这个 running 到底是哪一种"。
 *
 * （住在本叶：三个读面叶都依赖它；放快照叶会逼出详情→快照的反向边。）
 */
export function synthesizeRunStatus(
  entry: RunRegistryEntry | undefined,
  journalStatus: RunStatus | undefined,
): RunStatus {
  // 内存终态优先：本进程刚从引擎手里接过的结算，比 journal 行（可能还没写完）更新。
  if (entry?.terminal !== undefined) return terminalRunStatus(entry.terminal);
  // 走到这里 `entry !== undefined` 即「本服务持有的活 run」：行上的终态只可能是外来写入，
  // 忽略它、照实说在跑。非终态的行（pending / running）照常采信——它们本就是引擎自己写的。
  // 刻意只拦终态：`journalStatus` 缺席的间隙仍要落到下面的 `pending`（那一档更细，
  // 且内省面把它当成模型看得懂的区别）。
  if (
    entry !== undefined &&
    journalStatus !== undefined &&
    TERMINAL_RUN_STATUSES.has(journalStatus)
  ) {
    return "running";
  }
  if (journalStatus !== undefined) return journalStatus;
  // 注册表有、journal 无：submit → createRun 的微任务间隙。`pending` 是这一刻**唯一诚实**的
  // 状态——run 已被接受，但引擎还没落下任何一行。
  return "pending";
}

function terminalRunStatus(settlement: RunSettlement): RunStatus {
  switch (settlement.status) {
    case "completed":
      return "completed";
    case "stopped":
      return "stopped";
    default:
      return "errored";
  }
}

/**
 * 逻辑终态 → 后台任务追踪器的通用词汇。追踪器（与 bash / subagent 任务共用）不认识
 * stopped / errored：stopped 折成 `cancelled`、errored 折成 `failed`；真实词经快照的
 * `runStatus` / `stopReason` 另行透出。
 */
export function runStatusToTaskStatus(status: RunStatus): DynamicWorkflowRunSnapshot["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
      return "failed";
    case "stopped":
      return "cancelled";
    // pending / running 都还在跑。
    default:
      return "running";
  }
}

/**
 * 停止原因：内存终态优先（本进程刚从引擎手里接过的结算），其次 journal 行。只对 stopped 有意义；
 * 其余状态返回 undefined。
 *
 * 与 {@link synthesizeRunStatus} 同一条优先级：**活条目下没有停止原因**。行上写着一个，只能是
 * 外来写入，而三个读面必须给出同一个答案——状态说「在跑」、
 * 原因却说「被打断了」，比两者都错更难查。
 */
export function stopReasonOf(
  entry: RunRegistryEntry | undefined,
  record: { status?: RunStatus; stopReason?: RunStopReason } | undefined,
): DynamicWorkflowRunStopReason | undefined {
  if (entry?.terminal !== undefined) {
    return entry.terminal.status === "stopped" ? entry.terminal.reason : undefined;
  }
  if (entry !== undefined) return undefined;
  if (record?.status === "stopped") return record.stopReason ?? "user";
  return undefined;
}

/** 等结算，但尊重调用方的 signal（等待被打断不等于 run 被取消）。 */
export async function settleOrAbort(
  settlement: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) {
    await settlement;
    return;
  }
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    void settlement.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
    );
  });
}

/**
 * 孤儿收敛写入的失败编码（宿主级成员，引擎自身永不产出）。随 `stopped(interrupted)` 一起落库：
 * status + stopReason 已经说明「进程死亡打断」，这条 code 是同一事实的第二证据（老行只有它）。
 */
export const INTERRUPTED_FAILURE_CODE: WorkflowErrorCode = "Interrupted";

/**
 * resume 门的唯一谓词：**stopped 即可恢复**，
 * 除了 `superseded`——它的未完结工作已归后继所有，重放等于对着后继正在改的工作区把同一件事做两遍；
 * errored / completed 不可。`DynamicWorkflowRunSessionSummary.resumable` 用同一个——
 * UI 若自行按 status 重新推导，两处谓词总有一天不一致：按钮亮着但命令被拒。
 */
export function isResumableRecord(record: Pick<RunRecord, "status" | "stopReason">): boolean {
  return isResumableSettlement(record.status, record.stopReason);
}

/**
 * 同一个谓词的「结算事实」形态：`run-settled` 载荷上的 `resumable` 位由它算（live 由
 * toProgressPayload 按引擎事件算，冷回放由补种按 journal 行算），reducer 只搬运。
 */
export function isResumableSettlement(status: RunStatus, stopReason?: RunStopReason): boolean {
  return status === "stopped" && stopReason !== "superseded";
}
