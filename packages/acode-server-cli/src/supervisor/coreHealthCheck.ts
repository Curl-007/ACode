// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ./supervisor.ts 拆出。
// 职责：Core 心跳健康巡检调度（间隔钳制、世代/状态门、健康迁移时的日志与状态落盘）。
// CoreHealthMonitor 实例仍由 Supervisor 持有（status/ready/heartbeat 共用），本类只
// 拥有巡检定时器；对 Supervisor 私有状态的读取经构造注入的闭包完成，闭包捕获
// 关系与拆前方法内直接访问 this 等价。
import { type ChildProcess } from "node:child_process";
import { createServiceLogger } from "@acode/services/node";
import { type CoreHealthMonitor } from "./coreHealth.js";

// 与 supervisor.ts 同一 scope：健康迁移是运维排障判据，用 warn；高频明细走 debug。
const log = createServiceLogger("server-supervisor");

export interface CoreHealthCheckHost {
  /** 原 this.core !== child || this.generation !== generation 判定。 */
  isCurrentCore(child: ChildProcess, generation: number): boolean;
  /** 原 this.state === "stopping" | "stopped" | "stop-failed" 判定。 */
  isLifecycleBlockingCheck(): boolean;
  /** 健康迁移后的状态落盘（原 void this.persistStatusSnapshot()）。 */
  onHealthTransition(): void;
}

export class CoreHealthCheckScheduler {
  private timer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly options: {
      health: CoreHealthMonitor;
      heartbeatTimeoutMs?: number;
      checkIntervalMs?: number;
      now?: () => number;
      host: CoreHealthCheckHost;
    },
  ) {}

  public schedule(child: ChildProcess, generation: number): void {
    if (this.timer) clearTimeout(this.timer);
    const timeoutMs = this.options.heartbeatTimeoutMs ?? 30_000;
    const intervalMs = Math.max(50, Math.min(this.options.checkIntervalMs ?? 1_000, timeoutMs / 2));
    const check = (): void => {
      if (!this.options.host.isCurrentCore(child, generation)) return;
      if (this.options.host.isLifecycleBlockingCheck()) return;
      const before = this.options.health.currentHealth();
      const after = this.options.health.evaluate(this.options.now?.() ?? Date.now());
      if (before !== after.health) {
        log.warn(undefined, "server core heartbeat health changed", {
          health: after.health,
          generation,
          lastHeartbeatAt: after.lastHeartbeatAt,
        });
        this.options.host.onHealthTransition();
      }
      this.timer = setTimeout(check, intervalMs);
      this.timer.unref();
    };
    this.timer = setTimeout(check, intervalMs);
    this.timer.unref();
  }

  public clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
