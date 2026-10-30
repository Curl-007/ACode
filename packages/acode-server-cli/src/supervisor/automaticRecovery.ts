// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ./supervisor.ts 拆出。
// 职责：崩溃自动恢复——recordCoreFailure（crash budget 记账、crash-loop-stopped
// 进入、退避重启调度）与 scheduleAutomaticReadyDeadline（自动拉起 Core 的 ready
// 死线）。CrashBudget 实例仍由 Supervisor 持有（status 快照共用），本类拥有
// automaticReadyTimer；对 Supervisor 私有状态/方法的访问经构造注入的闭包完成，
// 闭包捕获关系与拆前等价。
import { type ChildProcess } from "node:child_process";
import { createServiceLogger } from "@acode/services/node";
import { type LifecycleState, type ServerStatus } from "../contracts.js";
import { type CrashBudget } from "./crashBudget.js";
import { type LifecycleOperationGate } from "./lifecycleOperationGate.js";

// 与 supervisor.ts 同一 scope：崩溃预算耗尽用 error，重启调度用 warn。
const log = createServiceLogger("server-supervisor");

export interface AutomaticRecoveryHost {
  getState(): LifecycleState;
  setState(state: LifecycleState): void;
  /** 原 this.generation 实时读取。 */
  getGeneration(): number;
  /** 原 this.core !== child || this.generation !== generation 判定。 */
  isCurrentCore(child: ChildProcess, generation: number): boolean;
  stopCore(reason: string): Promise<void>;
  launchCore(automaticRestart?: boolean): void;
  status(): ServerStatus;
  setLastExitReason(reason: string): void;
  persistStatusSnapshot(): Promise<void>;
}

export class AutomaticRecovery {
  private readyTimer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly options: {
      crashBudget: CrashBudget;
      lifecycleGate: LifecycleOperationGate;
      host: AutomaticRecoveryHost;
      coreReadyTimeoutMs?: number;
    },
  ) {}

  public recordCoreFailure(reason: string): void {
    const failedGeneration = this.options.host.getGeneration();
    this.options.host.setState("crashed");
    this.options.host.setLastExitReason(reason);
    const decision = this.options.crashBudget.recordCrash();
    if (!decision.shouldRestart) {
      this.options.host.setState("crash-loop-stopped");
      log.error(undefined, "server core crash budget exhausted, entering crash-loop-stopped", {
        lastExitReason: reason,
      });
      void this.options.host.persistStatusSnapshot();
      return;
    }
    log.warn(undefined, "server core failed, scheduling restart", {
      reason,
      delayMs: decision.delayMs,
    });
    void this.options.host.persistStatusSnapshot();
    setTimeout(() => {
      if (
        this.options.host.getState() !== "crashed" ||
        this.options.host.getGeneration() !== failedGeneration ||
        this.options.lifecycleGate.active
      )
        return;
      this.options.host.setState("starting");
      this.options.host.launchCore(true);
      void this.options.host.persistStatusSnapshot();
    }, decision.delayMs).unref();
  }

  public scheduleReadyDeadline(child: ChildProcess, generation: number): void {
    this.readyTimer = setTimeout(() => {
      if (!this.options.host.isCurrentCore(child, generation)) return;
      if (this.options.host.getState() !== "starting") return;
      if (this.options.lifecycleGate.active) return;
      // 自动恢复以前只等 exit，活着但从未 ready 的 Core 会永久占住 starting。
      // 复用已有启动上界与 lifecycle gate，先证明 OS 终态，再消费 crash budget；不能丢引用另起进程。
      void this.options.lifecycleGate
        .run("restart", async () => {
          const reason = "automatic restart Core ready deadline exceeded";
          await this.options.host.stopCore(reason);
          this.recordCoreFailure(reason);
          return this.options.host.status();
        })
        .catch((error) =>
          log.error(undefined, "automatic restart Core failed to stop after ready timeout", error),
        );
    }, this.options.coreReadyTimeoutMs ?? 15_000);
    this.readyTimer.unref();
  }

  /** 原拆散在 handleCoreMessage / clearCoreScopedStatus 的 automaticReadyTimer 清理。 */
  public clearReadyDeadline(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
  }
}
