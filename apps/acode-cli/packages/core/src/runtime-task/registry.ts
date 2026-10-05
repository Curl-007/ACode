import type {
  ModelUsage,
  SessionId,
  SubagentTaskSnapshot,
  TraceContext,
  TurnId,
} from "@acode/contracts";
import type { AgentOutput } from "@acode/contracts";

// local_dynamic_workflow 与 local_workflow 刻意分开：后者是 legacy `Workflow` 工具（不可取消），
// 前者是 workflow run（经 DynamicWorkflowRunPort.cancel 可取消）。合成一个类型，取消分派就无法区分。
export type RuntimeTaskType =
  | "local_agent"
  | "local_bash"
  | "local_workflow"
  | "local_dynamic_workflow"
  | "monitor_mcp"
  // K3 overnight run（specs/overnight-execution.md 接口节）：run 的唯一 UI 投影面，
  // 与 local_* 工具任务区分——它不是工具派生的，生命周期绑定 supervisor（R1）。
  | "overnight"
  // K2 对话内 swarm plan（specs/swarm-task-graph.md R4）：plan 的 runtime-task 投影。
  // 不并入 local_workflow（legacy Workflow 工具，不可取消）也不并入 local_dynamic_workflow
  // （dwf run，端口取消）：本联合按「取消语义」分组（见顶部注释），plan 的停止面是
  // PlanControl 工具（模型侧 retry/cancel），GUI TaskStop 分派对它应答 not supported
  // 而不是误路由到任何 workflow 停止分支——overnight 新增成员的同款先例。
  | "swarm_plan"
  // K6 ambient cycle（specs/ambient-budget-scheduler.md R3）：AmbientRunner fork 的隐藏
  // 后台周期任务。非工具派生（runner 驱动），生命周期绑定 runner cycle——overnight 的
  // 同款先例（本批写面内允许的唯一联合扩展：一行成员 + 两处 exhaustive switch 标签）。
  | "ambient";

export interface RuntimeTaskUsageSnapshot {
  durationMs?: number;
  modelUsage?: ModelUsage;
  toolUseCount?: number;
  totalTokens?: number;
}

export interface RuntimeTaskPendingMessage {
  id: string;
  isMeta?: boolean;
  message: string;
  origin?: {
    kind: "coordinator";
    toolCallId?: string;
  };
  queuedAt: Date;
  summary?: string;
  traceContext?: TraceContext;
}

export interface RuntimeTaskMessageSink {
  send(message: RuntimeTaskPendingMessage): Promise<"queued" | "steered">;
}

export interface RuntimeTaskSnapshot extends SubagentTaskSnapshot {
  /** task 注册时所属 active conversation branch；用于迟到 completion fencing。 */
  branchGeneration?: number;
  exitCode?: number;
  type: RuntimeTaskType;
  isBackgrounded?: boolean;
  messageSink?: RuntimeTaskMessageSink;
  output?: AgentOutput;
  parentSessionId?: SessionId;
  pendingMessages?: RuntimeTaskPendingMessage[];
  prompt?: string;
  /**
   * workflow run 产物的序列化文本。TaskOutput 的投影只读得到 registry 条目（dwf 从不写
   * outputFile），所以产物必须在终态更新时就存到条目上。
   */
  resultText?: string;
  /**
   * 是谁请求停止这个任务（"user" = GUI / 后台面板，"model" = TaskStop）。dwf 停止分支在调
   * 端口 cancel 之前写下它；终态通知稍后由 waiter 结算时读它。重臂（resume 新生命）随结算面复位。
   */
  stopInitiator?: "user" | "model";
  taskType?: RuntimeTaskType;
  traceContext?: TraceContext;
  turnId?: TurnId;
  usage?: RuntimeTaskUsageSnapshot;
  /**
   * K3 overnight run 的运行面摘要（specs/overnight-execution.md R2/R4/R5）：
   * phase / 任务卡片计数 / 内存趋势。registry 只存储不解释——它是通用投影面，
   * overnight 语义归 supervisor 所有；类型收窄为 string 以免 runtime-task 反向依赖
   * overnight 模块的相位枚举（依赖方向：overnight → runtime-task，单向）。
   */
  overnight?: {
    runId: string;
    phase: string;
    cardCount?: number;
    memoryTrend?: {
      samples: number;
      firstRssBytes?: number;
      lastRssBytes?: number;
    };
  };
}

export interface RuntimeTaskRegistry {
  all(): Record<string, RuntimeTaskSnapshot>;
  get(id: string): RuntimeTaskSnapshot | undefined;
  drainMessages(id: string): RuntimeTaskPendingMessage[];
  queueMessage(
    id: string,
    message: RuntimeTaskPendingMessage,
  ): RuntimeTaskSnapshot | undefined;
  register(task: RuntimeTaskSnapshot): void;
  remove(id: string): void;
  requestBackground(id: string): boolean;
  setActiveBranchGeneration?(generation: number): void;
  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined;
  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
}

interface RuntimeTaskWaiter {
  onAbort?: () => void;
  reject: (error: unknown) => void;
  resolve: (task: RuntimeTaskSnapshot | undefined) => void;
  signal?: AbortSignal;
}

const TERMINAL_STATUSES = new Set<RuntimeTaskSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
]);

export class InMemoryRuntimeTaskRegistry implements RuntimeTaskRegistry {
  private activeBranchGeneration = 0;
  private readonly backgroundWaiters = new Map<string, Set<RuntimeTaskWaiter>>();
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();
  private readonly terminalWaiters = new Map<string, Set<RuntimeTaskWaiter>>();

  register(task: RuntimeTaskSnapshot): void {
    const stamped = {
      ...task,
      branchGeneration: task.branchGeneration ?? this.activeBranchGeneration,
    };
    this.tasks.set(stamped.taskId, stamped);
    this.resolveIfTerminal(stamped.taskId, stamped);
    this.resolveIfBackgrounded(stamped.taskId, stamped);
  }

  setActiveBranchGeneration(generation: number): void {
    this.activeBranchGeneration = generation;
  }

  /**
   * 终态 **first-wins**：条目一旦进入 TERMINAL_STATUSES，它的 status 就不得被**另一个终态**
   * 覆盖——第一个写下终态的路径就是赢家。
   *
   * 为什么是 first-wins：终态是已经对外承诺过的事实。`waitForTerminal` 的等待方
   * （resolveWaiters 首次结算即删除整组 waiter，本身就是 first-wins）、
   * `BackgroundTaskCompleted` 事件、模型通知都可能已经基于第一个终态发出；后写者覆盖会让
   * 「已收到 completed 的等待方」与「随后 get() 到 killed 的轮询方」互相矛盾，且通知收不回来。
   * 守卫落在原语层是因为 subagent 的三条 finalize 路径（runner.ts 的
   * finalizeBackgroundCompletion / finalizeBackgroundFailure / finalizeBackgroundStopped）
   * 都是「读快照判终态 → await 真实文件 I/O → 写快照」，守卫与写入之间的窗口客观存在，
   * 靠调用方各自判终态兜不住并发方向。表达强度对齐
   * dynamic-workflow/src/engine/engine-settlement.ts:7 的 first-wins 约定。
   *
   * 只拦「终态 → 另一个终态」，以下必须放行（都是既有语义）：
   * - 不改 status 的字段写入：notified 认领/释放、messageSink、pendingMessages、usage 补齐；
   * - 终态 → 非终态：background-task-registry.ts 的晚挂载合并（Bash/Agent 的 task id 一轮即弃，
   *   但 tracker 晚挂载会撞上已认领的终态条目）；
   * - 重臂（resume 新生命）与 finalizeBackgroundStopped 的回滚走 register()，不经这里。
   *
   * 返回 `current`（而不是 undefined）表示「写入被拒，这是赢家快照」：undefined 在本接口里的
   * 既有含义是条目不存在，调用方据此走 task_missing 分支，不能把两件事混成一个信号。
   */
  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined {
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const next = patcher(current);
    if (
      next.status !== current.status &&
      isTerminalRuntimeTask(current) &&
      isTerminalRuntimeTask(next)
    ) {
      return current;
    }
    this.tasks.set(id, next);
    this.resolveIfTerminal(id, next);
    this.resolveIfBackgrounded(id, next);
    return next;
  }

  requestBackground(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminalRuntimeTask(task)) return false;
    const next: RuntimeTaskSnapshot = { ...task, isBackgrounded: true };
    this.tasks.set(id, next);
    this.resolveBackgroundWaiters(id, next);
    return true;
  }

  remove(id: string): void {
    this.tasks.delete(id);
    this.resolveTerminalWaiters(id, undefined);
    this.resolveBackgroundWaiters(id, undefined);
  }

  get(id: string): RuntimeTaskSnapshot | undefined {
    return this.tasks.get(id);
  }

  all(): Record<string, RuntimeTaskSnapshot> {
    return Object.fromEntries(this.tasks);
  }

  queueMessage(
    id: string,
    message: RuntimeTaskPendingMessage,
  ): RuntimeTaskSnapshot | undefined {
    return this.update(id, (task) => ({
      ...task,
      pendingMessages: [...(task.pendingMessages ?? []), message],
    }));
  }

  drainMessages(id: string): RuntimeTaskPendingMessage[] {
    const task = this.tasks.get(id);
    if (!task || !task.pendingMessages || task.pendingMessages.length === 0) return [];
    const messages = task.pendingMessages;
    this.tasks.set(id, { ...task, pendingMessages: [] });
    return messages;
  }

  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || current.isBackgrounded || isTerminalRuntimeTask(current)) {
      return Promise.resolve(current?.isBackgrounded ? current : undefined);
    }
    return this.waitFor(this.backgroundWaiters, id, options);
  }

  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || isTerminalRuntimeTask(current)) return Promise.resolve(current);
    return this.waitFor(this.terminalWaiters, id, options);
  }

  private waitFor(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const waiter: RuntimeTaskWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waitersByTask, id, waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      let waiters = waitersByTask.get(id);
      if (!waiters) {
        waiters = new Set();
        waitersByTask.set(id, waiters);
      }
      waiters.add(waiter);
    });
  }

  private resolveIfBackgrounded(id: string, task: RuntimeTaskSnapshot): void {
    if (task.isBackgrounded) {
      this.resolveBackgroundWaiters(id, task);
    }
  }

  private resolveIfTerminal(id: string, task: RuntimeTaskSnapshot): void {
    if (isTerminalRuntimeTask(task)) {
      this.resolveTerminalWaiters(id, task);
      this.resolveBackgroundWaiters(id, undefined);
    }
  }

  private resolveBackgroundWaiters(
    id: string,
    task: RuntimeTaskSnapshot | undefined,
  ): void {
    this.resolveWaiters(this.backgroundWaiters, id, task);
  }

  private resolveTerminalWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.terminalWaiters, id, task);
  }

  private resolveWaiters(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    task: RuntimeTaskSnapshot | undefined,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waitersByTask.delete(id);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(task);
    }
  }

  private removeWaiter(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    waiter: RuntimeTaskWaiter,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) waitersByTask.delete(id);
  }
}

export function isTerminalRuntimeTask(task: Pick<RuntimeTaskSnapshot, "status">): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

export function hasRunningBackgroundRuntimeTask(registry: RuntimeTaskRegistry): boolean {
  return Object.values(registry.all()).some(
    (task) => task.isBackgrounded === true && task.status === "running",
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Runtime task wait aborted");
}
