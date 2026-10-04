// 机制参照 jcode (MIT)：crates/jcode-app-core/src/ambient/runner.rs（runner 循环、
// 活跃暂停、wake nudge、单例锁），自撰 TypeScript 实现
// （apps/acode-cli/specs/ambient-budget-scheduler.md R3）。
//
// 与 jcode 的两点刻意差异（spec 登记）：
// 1. 单例锁不用 PID 文件，改用队列文件的 claim 时间戳（services 定时任务域
//    CLAIM_STALE_MS 的同款语义，不复制其实现）——ACode 宿主可多窗口并存，进程存活
//    不等于 runner 存活，claim 更贴；
// 2. cycle 的 fork 走端口注入（AmbientCyclePort），真实绑定在 bootstrap 装配处接
//    session fork 链（overnight coordinator 的同款接缝形态）——本文件不触碰
//    bootstrap/runtime 装配面。
import {
  AMBIENT_BUSY_RECHECK_MS,
  AMBIENT_CLAIM_RENEW_SEGMENT_MS,
  AMBIENT_MAX_INTERVAL_MS,
  AMBIENT_TICK_FLOOR_MS,
} from "./constants.js";
import type { AdaptiveScheduler, AmbientIntervalDecision } from "./scheduler.js";
import { parseAmbientScheduleProposal } from "./proposal.js";
import { buildAmbientCyclePrompt } from "./cycle-prompt.js";
import type { AmbientScheduleQueue, ScheduledItem } from "./queue.js";

/** R4：ambient cycle 的 fork 请求携带的非交互权限上下文。 */
export interface AmbientPermissionContext {
  /**
   * 非交互标记：绑定层把它映射到 fork configOverrides 的最小拒绝面——confirm 及
   * 以上级别的操作直接拒绝（不排队等审批；无人值守拒绝是诚实行为，拒绝事件经
   * AmbientCycleResult.deniedOperations 写回 cycle 结果，用户回来可见）。
   */
  nonInteractive: true;
}

export interface AmbientCycleRequest {
  cycleId: string;
  prompt: string;
  permission: AmbientPermissionContext;
  /** 本轮到期的 ambient 项（断言/可观测面；内容已并入 prompt）。 */
  items: ScheduledItem[];
}

export interface AmbientCycleResult {
  status: "completed" | "failed";
  responseText: string;
  /** R4：本 cycle 内被非交互权限面拒绝的操作清单。 */
  deniedOperations?: string[];
}

/** cycle 执行端口：绑定层 fork 隐藏 ambient 任务（taskType "ambient"）并驱动一轮 turn。 */
export interface AmbientCyclePort {
  runAmbientCycle(request: AmbientCycleRequest): Promise<AmbientCycleResult>;
}

/** direct-delivery 投递端口（target=session/spawn；不走预算调度，到点即投）。 */
export interface AmbientDirectDeliveryPort {
  deliverReminder(item: ScheduledItem): Promise<void>;
  spawnTask(item: ScheduledItem): Promise<void>;
}

export type AmbientRunnerStatus = "scheduled" | "paused" | "idle" | "stopped";

export type AmbientRunnerEvent =
  | { type: "started"; ownerId: string }
  | { type: "degraded-quota" }
  | { type: "claim-lost"; ownerId: string }
  | { type: "cycle-started"; cycleId: string; itemCount: number }
  | { type: "cycle-completed"; cycleId: string; hadProposal: boolean }
  | { type: "cycle-failed"; cycleId: string; backoff: number }
  | { type: "proposal-scheduled"; scheduleId: string; wakeInMinutes: number }
  | { type: "idle" }
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "reminder-delivered"; scheduleId: string }
  | { type: "spawn-dispatched"; scheduleId: string }
  | { type: "denied"; cycleId: string; operations: string[] }
  | { type: "stopped" };

export interface AmbientRunnerLogger {
  warn(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
}

export interface AmbientRunnerDeps {
  /** feature flag（config.ambient.enabled，缺省 false）。注入形态：config schema 扩展不在本批写面。 */
  enabled: boolean;
  /** claim owner 标识；缺省进程内生成。 */
  ownerId?: string;
  queue: AmbientScheduleQueue;
  scheduler: AdaptiveScheduler;
  cyclePort: AmbientCyclePort;
  deliveryPort: AmbientDirectDeliveryPort;
  /** host 活跃信号（CommandInbox/attachment busy 面）——用户会话活跃 → Paused。 */
  isBusy(): boolean;
  now(): number;
  /** 可注入 sleep（测试时钟）；缺省真实 setTimeout。 */
  sleep?(ms: number): Promise<void>;
  /** workspace 状态摘要（cycle prompt 的第三段）；缺省省略。 */
  getWorkspaceSummary?(): Promise<string>;
  logger?: AmbientRunnerLogger;
  onEvent?(event: AmbientRunnerEvent): void;
}

export interface AmbientRunnerHandle {
  readonly ownerId: string;
  getStatus(): AmbientRunnerStatus;
  /** wake nudge：任何时刻可提前唤醒（新 direct 项创建时由 handler 侧调用）。 */
  nudge(): void;
  /** 停止循环并释放 claim（幂等）。 */
  dispose(): Promise<void>;
  /** 循环终态（idle/stopped）promise。 */
  settled: Promise<AmbientRunnerStatus>;
}

const DEFAULT_SLEEP_MS = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 迭代级容错上限：连续这么多次迭代异常视为不可恢复（真·死循环防护，不是重试装饰）。 */
const MAX_ITERATION_ERRORS = 5;

export class AmbientRunner implements AmbientRunnerHandle {
  readonly ownerId: string;
  private readonly deps: AmbientRunnerDeps;
  private status: AmbientRunnerStatus = "scheduled";
  private disposed = false;
  private lastCycleAtMs: number;
  private cycleCounter = 0;
  private degradedWarned = false;
  private nudgeResolve: (() => void) | null = null;
  /** F2：nudge 在非睡眠窗口到达时的记忆位——下一个心跳段边界立即中断整段睡眠。 */
  private nudged = false;
  private settleResolve!: (status: AmbientRunnerStatus) => void;
  readonly settled: Promise<AmbientRunnerStatus>;

  constructor(deps: AmbientRunnerDeps, ownerId: string) {
    this.deps = deps;
    this.ownerId = ownerId;
    this.lastCycleAtMs = deps.now();
    this.settled = new Promise<AmbientRunnerStatus>((resolve) => {
      this.settleResolve = resolve;
    });
  }

  getStatus(): AmbientRunnerStatus {
    return this.status;
  }

  nudge(): void {
    // F2：置记忆位——nudge 可能在段间文件 IO（非睡眠窗口）到达，此时 nudgeResolve
    // 为 null，不置位的话该信号会丢失（睡眠总长不受影响地睡满 = 提前唤醒语义失效）。
    this.nudged = true;
    this.nudgeResolve?.();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.nudgeResolve?.();
    await this.deps.queue.releaseClaim(this.ownerId);
    this.setStatus("stopped");
    this.emit({ type: "stopped" });
    this.settleResolve("stopped");
  }

  private setStatus(next: AmbientRunnerStatus): void {
    this.status = next;
  }

  private emit(event: AmbientRunnerEvent): void {
    try {
      this.deps.onEvent?.(event);
    } catch {
      // 观测面异常不反噬循环。
    }
  }

  private warnDegradedQuotaOnce(decision: AmbientIntervalDecision): void {
    if (this.degradedWarned || !decision.degraded) return;
    this.degradedWarned = true;
    // 降级不静默（spec R3 条款）：配额面不可用时明确告知约束已退化。
    this.deps.logger?.warn(
      "Ambient quota face unavailable; falling back to rate-margin-only constraint (max interval)",
      { event: "ambient.quota.degraded" },
    );
    this.emit({ type: "degraded-quota" });
  }

  /**
   * F2（批次C）：claim 已被其他 owner 接管（renewClaim=false）→ 立即停循环（dispose
   * 语义）。原实现忽略 renewClaim 返回值，claim 过期被接管后原 runner 继续消费（双跑，
   * POC 实证）。此处**不** releaseClaim——claim 已属新 owner，释放会误抢对方的锁；
   * 也不走 dispose()（它面向宿主主动关停，这里是被接管后的让位，语义分开记录）。
   */
  private stopForLostClaim(): void {
    this.deps.logger?.warn(
      "Ambient queue claim was taken over by another owner; stopping this runner",
      { event: "ambient.claim.lost", ownerId: this.ownerId },
    );
    this.emit({ type: "claim-lost", ownerId: this.ownerId });
    this.setStatus("stopped");
    this.settleResolve("stopped");
    this.emit({ type: "stopped" });
  }

  /** 活着证明：续租并检测被接管。返回 true 表示 claim 已丢失、循环必须终止。 */
  private async renewOrLoseClaim(): Promise<boolean> {
    const renewed = await this.deps.queue.renewClaim(this.ownerId, this.deps.now());
    if (!renewed) {
      this.stopForLostClaim();
      return true;
    }
    return false;
  }

  /** 主循环：迭代级容错——瞬态文件错误退避重试，连续不可恢复错误才停。 */
  async run(): Promise<void> {
    this.emit({ type: "started", ownerId: this.ownerId });
    let consecutiveErrors = 0;
    for (;;) {
      if (this.disposed) return;
      try {
        const idle = await this.runIteration();
        consecutiveErrors = 0;
        if (idle) return;
      } catch (error) {
        // 单次迭代异常（Windows 上原子 rename 的瞬态锁、端口抖动等）：不终结 runner，
        // 按 cycle 失败退避 + tick floor 短睡后重试——队列写失败时项仍在盘上（原子性），
        // 下一次迭代自然重做。连续 MAX_ITERATION_ERRORS 次仍失败视为不可恢复，停循环。
        consecutiveErrors += 1;
        this.deps.logger?.warn("Ambient runner iteration failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          consecutiveErrors,
          event: "ambient.runner.iteration.failed",
        });
        if (consecutiveErrors >= MAX_ITERATION_ERRORS) {
          this.deps.logger?.warn("Ambient runner loop failing repeatedly; stopping", {
            event: "ambient.runner.loop.failed",
          });
          this.setStatus("stopped");
          await this.deps.queue.releaseClaim(this.ownerId).catch(() => undefined);
          this.settleResolve("stopped");
          this.emit({ type: "stopped" });
          return;
        }
        this.deps.scheduler.reportCycleFailure();
        await this.waitSleep(AMBIENT_TICK_FLOOR_MS).catch(() => undefined);
      }
    }
  }

  /**
   * 单次迭代：投递 direct 项 → busy 判定 → idle 判定 → 预算交集计算 →（条件满足时）
   * 跑一个 ambient cycle → 睡到下一个唤醒点。返回 true 表示循环应终止（idle/dispose）。
   */
  private async runIteration(): Promise<boolean> {
    const nowMs = this.deps.now();

    // 1) direct-delivery 到点即投（R2：不走预算、不受 busy 约束——用户显式定时语义）。
    await this.deliverDueDirectItems(nowMs);
    if (this.disposed) return true;

    // 2) busy 判定：用户会话活跃 → Paused（60s 后重查；零 ambient cycle）。
    if (this.deps.isBusy()) {
      if (this.status !== "paused") {
        this.setStatus("paused");
        this.emit({ type: "paused" });
      }
      await this.waitSleep(AMBIENT_BUSY_RECHECK_MS);
      return false;
    }
    if (this.status === "paused") {
      this.status = "scheduled";
      this.emit({ type: "resumed" });
    }

    // 3) 两层交集与 Idle 判定。
    const pendingAmbient = await this.deps.queue.countPending(
      (item) => item.target === "ambient",
    );
    const pendingDirect = await this.deps.queue.countPending(
      (item) => item.target !== "ambient",
    );
    if (pendingAmbient === 0 && pendingDirect === 0) {
      // Idle：无待办唤醒（含「cycle 完成且无自提议」路径在 pop 后自然落到这里）。
      // 停循环直到新 schedule 创建（handler 创建面重新 startAmbientRunner）。
      this.setStatus("idle");
      this.emit({ type: "idle" });
      await this.deps.queue.releaseClaim(this.ownerId);
      this.settleResolve("idle");
      return true;
    }

    // 活着证明：每次循环边界续租 claim（跨进程互斥的存活性依据）。
    // F2（批次C）：续租失败 = claim 已被其他 owner 接管 → 立即让位停循环（原先
    // 忽略 renewClaim 返回值，接管后原 runner 继续消费 = 双跑，POC 实证）。
    if (await this.renewOrLoseClaim()) return true;

    const decision = await this.deps.scheduler.calculateBaseInterval();
    this.warnDegradedQuotaOnce(decision);
    const intervalMs = Number.isFinite(decision.intervalMs)
      ? decision.intervalMs * this.deps.scheduler.currentBackoff()
      : Number.POSITIVE_INFINITY;
    // cycle 间隔锚定上一 cycle 完成时刻（不是 runner 启动时刻）——退避与预算都
    // 是「两次 cycle 之间的最小距离」语义。
    const nextAllowedCycleAt = this.lastCycleAtMs + intervalMs;
    const earliestAmbientDueMs =
      pendingAmbient > 0
        ? await this.deps.queue.nextDueMs(this.deps.now(), (item) => item.target === "ambient")
        : undefined;

    if (
      earliestAmbientDueMs !== undefined &&
      this.deps.now() >= nextAllowedCycleAt &&
      earliestAmbientDueMs <= this.deps.now()
    ) {
      await this.runAmbientCycle();
      return false;
    }

    // 两层交集：实际唤醒 = max(系统 interval 边界, agent 提议到期)（R3/场景 4——
    // agent 提议 5min、系统算 30min → 30min 醒；提议更晚则尊重提议）。
    const ambientDelayMs =
      earliestAmbientDueMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(nextAllowedCycleAt, earliestAmbientDueMs) - this.deps.now();
    const directDelayMs = await this.nextDirectDelayMs(this.deps.now());
    // sleep 下限 30s（AMBIENT_TICK_FLOOR_MS，spec R3「下限30s」——防忙轮询）；
    // 上限 120min——预算判定为不可跑（Infinity）时仍周期性重算（速率窗口滚动、
    // 配额会刷新，判定必须可恢复而不是永久停摆）。
    const sleepMs = Math.max(
      AMBIENT_TICK_FLOOR_MS,
      Math.min(directDelayMs ?? Number.POSITIVE_INFINITY, ambientDelayMs, AMBIENT_MAX_INTERVAL_MS),
    );
    // F2（批次C）：长 sleep 按 claim 心跳分段（AMBIENT_CLAIM_RENEW_SEGMENT_MS），每段
    // 醒先续租再睡剩余——单段最长 120min 时 claim（10min 过期）会在睡梦中被接管。
    // 返回 true = claim 丢失或已 dispose，循环终止。
    if (await this.sleepWithHeartbeat(sleepMs)) return true;
    return false;
  }

  /**
   * F2（批次C）：分段心跳睡眠。把 totalMs 拆成 ≤ AMBIENT_CLAIM_RENEW_SEGMENT_MS 的段，
   * 每段醒先续租（claim 被接管 → 让位停循环）再继续剩余睡眠。nudge 信号照常打断整段
   * 睡眠（打断后由主循环重算）。段以**绝对截止时刻**锚定（deadline = now + totalMs），
   * 段醒发生迟到（宿主定时器抖动/暂停）时后续段自动收窄，最终唤醒点不漂移。
   * 返回 true 表示循环应终止（claim 丢失 / dispose），false 表示睡满或被 nudge 打断。
   */
  private async sleepWithHeartbeat(totalMs: number): Promise<boolean> {
    const deadline = this.deps.now() + totalMs;
    for (;;) {
      if (this.nudged) {
        this.nudged = false;
        return false;
      }
      const remaining = deadline - this.deps.now();
      if (remaining <= 0) return false;
      await this.waitSleep(Math.min(remaining, AMBIENT_CLAIM_RENEW_SEGMENT_MS));
      if (this.disposed) return true;
      if (this.nudged) {
        this.nudged = false;
        return false;
      }
      if (this.deps.now() >= deadline) return false;
      if (await this.renewOrLoseClaim()) return true;
    }
  }

  private async deliverDueDirectItems(nowMs: number): Promise<void> {
    const ready = await this.deps.queue.popReady(
      nowMs,
      (item) => item.target !== "ambient",
    );
    for (const item of ready) {
      try {
        if (item.target === "session") {
          await this.deps.deliveryPort.deliverReminder(item);
          this.emit({ type: "reminder-delivered", scheduleId: item.scheduleId });
        } else {
          await this.deps.deliveryPort.spawnTask(item);
          this.emit({ type: "spawn-dispatched", scheduleId: item.scheduleId });
        }
      } catch (error) {
        // 投递失败不重投（项已 pop）：direct 项是一次性语义，失败记录在事件面，
        // 消息丢失比反复打扰用户更可接受；周期性需求应走 cron。
        this.deps.logger?.warn("Ambient direct delivery failed", {
          scheduleId: item.scheduleId,
          target: item.target,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "ambient.delivery.failed",
        });
      }
    }
  }

  private async nextDirectDelayMs(nowMs: number): Promise<number | undefined> {
    const due = await this.deps.queue.nextDueMs(nowMs, (item) => item.target !== "ambient");
    return due === undefined ? undefined : Math.max(0, due - nowMs);
  }

  private async runAmbientCycle(): Promise<void> {
    const nowMs = this.deps.now();
    const items = await this.deps.queue.popReady(nowMs, (item) => item.target === "ambient");
    if (items.length === 0) return;
    this.cycleCounter += 1;
    const cycleId = `ambient-cycle-${this.cycleCounter}`;
    const workspaceSummary = await this.deps.getWorkspaceSummary?.().catch(() => undefined);
    const prompt = buildAmbientCyclePrompt(items, workspaceSummary);
    this.emit({ type: "cycle-started", cycleId, itemCount: items.length });
    let result: AmbientCycleResult;
    try {
      result = await this.deps.cyclePort.runAmbientCycle({
        cycleId,
        prompt,
        permission: { nonInteractive: true },
        items,
      });
    } catch (error) {
      result = {
        status: "failed",
        responseText: error instanceof Error ? error.message : String(error),
      };
    }
    // cycle 耗时计入间隔锚点：下一次 cycle 至少在一个完整 interval 之后。
    this.lastCycleAtMs = this.deps.now();

    if (result.deniedOperations && result.deniedOperations.length > 0) {
      // R4：拒绝事件写入 cycle 结果（用户回来可见）。
      this.emit({ type: "denied", cycleId, operations: result.deniedOperations });
    }

    if (result.status === "failed") {
      const backoff = this.deps.scheduler.reportCycleFailure();
      this.emit({ type: "cycle-failed", cycleId, backoff });
      return;
    }
    this.deps.scheduler.reportCycleSuccess();
    const proposal = parseAmbientScheduleProposal(result.responseText);
    if (proposal) {
      // Complete + 有提议 → 保持 Scheduled：提议以新 ambient 项落队列（target 固定
      // ambient——自提议就是「下次还叫醒我」，session/spawn 是用户侧语义）。
      const item = await this.deps.queue.create({
        wakeAtMs: this.deps.now() + proposal.wakeInMinutes * 60_000,
        priority: proposal.priority ?? "normal",
        target: "ambient",
        taskDescription: proposal.taskDescription,
        createdBySession: `ambient:${cycleId}`,
      });
      this.emit({
        type: "proposal-scheduled",
        scheduleId: item.scheduleId,
        wakeInMinutes: proposal.wakeInMinutes,
      });
    }
    this.emit({ type: "cycle-completed", cycleId, hadProposal: proposal !== null });
    // 无提议时是否停循环由主循环的 Idle 判定决定（还有其他待办 ambient 项就继续）。
  }

  private waitSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.nudgeResolve = null;
        resolve();
      };
      this.nudgeResolve = finish;
      const sleeper = this.deps.sleep ?? DEFAULT_SLEEP_MS;
      void sleeper(ms).then(finish);
    });
  }
}

// ---------------------------------------------------------------------------
// 启动面：feature flag + 模块级单例 guard + 队列 claim（R3）。
// ---------------------------------------------------------------------------

let activeAmbientRunner: AmbientRunner | null = null;

export interface StartAmbientRunnerResult {
  handle: AmbientRunnerHandle | null;
  reason?: "disabled" | "already-running" | "claim-held";
}

/**
 * 启动 ambient runner（唯一入口）。
 *
 * - enabled=false → 零 runner（flag 缺省 false，R3/场景 10）；
 * - 同进程已有活跃 runner → 拒绝第二次启动（模块级 guard，R5 不变量「runner 唯一消费者」）；
 * - 队列 claim 被其他 owner 持有且未过期 → 拒绝（跨进程防双跑，场景 9）。
 *
 * idle 终态的 runner 会被下一次启动替换（「新 schedule 创建可重启」路径）：调用方在
 * handler 创建成功后重新调用本函数即可。
 */
export async function startAmbientRunner(deps: AmbientRunnerDeps): Promise<StartAmbientRunnerResult> {
  if (!deps.enabled) return { handle: null, reason: "disabled" };
  const activeStatus = activeAmbientRunner?.getStatus();
  if (activeAmbientRunner && (activeStatus === "scheduled" || activeStatus === "paused")) {
    deps.logger?.warn("Ambient runner already active in this process; refusing second start", {
      event: "ambient.runner.duplicate_start",
    });
    return { handle: null, reason: "already-running" };
  }
  if (activeAmbientRunner) {
    // idle/stopped 的旧实例：释放后替换。
    await activeAmbientRunner.dispose();
    activeAmbientRunner = null;
  }
  const ownerId =
    deps.ownerId ?? `ambient-runner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!(await deps.queue.tryClaim(ownerId))) {
    deps.logger?.warn("Ambient queue claim held by another owner; refusing to start runner", {
      ownerId,
      event: "ambient.runner.claim_held",
    });
    return { handle: null, reason: "claim-held" };
  }
  const runner = new AmbientRunner(deps, ownerId);
  activeAmbientRunner = runner;
  // 异步驱动；循环错误自兜底（run 内 catch），启动面不 await——宿主关停走 dispose。
  void runner.run();
  return { handle: runner };
}

/** 当前进程的活跃 runner（可观测/测试面）。 */
export function getActiveAmbientRunner(): AmbientRunnerHandle | null {
  return activeAmbientRunner;
}

/** 测试隔离：清空模块级单例（生产路径不调用）。 */
export function resetActiveAmbientRunnerForTests(): void {
  activeAmbientRunner = null;
}
