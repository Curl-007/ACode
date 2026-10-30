// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ./supervisor.ts 拆出。
// 职责：start() 启动临界区失败时的收口——按序停止可能已启动的 Core、关闭 control
// server，只有两者都收口才落盘 stopped 并释放 data-root lock，否则置 stop-failed
// 保留锁。Supervisor.start 的 catch 仅委托本函数后原样 rethrow。
import { createServiceLogger } from "@acode/services/node";
import { type LifecycleState } from "../contracts.js";

// 与 supervisor.ts 同一 scope：启动失败收口事件按运维排障判据用 warn/error。
const log = createServiceLogger("server-supervisor");

export interface StartupFailureHost {
  getState(): LifecycleState;
  setState(state: LifecycleState): void;
  /** 原 this.core 真值判定。 */
  hasCore(): boolean;
  stopCore(reason: string): Promise<void>;
  /** 原 this.control（control server 句柄，仅消费 close）。 */
  getControl(): { close(): Promise<void> } | undefined;
  /** 原 this.control = undefined。 */
  clearControl(): void;
  persistStatusSnapshot(): Promise<void>;
  releaseLock(): Promise<void>;
}

export async function cleanupFailedStartup(host: StartupFailureHost): Promise<void> {
  // 只在 recovery 失败时释放锁是不够的：mkdir、control server、Core 启动或
  // 初始状态落盘失败会留下锁（以及可能已启动的 Core），同一 Supervisor 重试会把
  // 自己识别成另一个实例。启动临界区必须在确认 Core/control 都收口后才释放锁。
  const recoveryFailed = host.getState() === "stop-failed";
  let coreStopped = !host.hasCore();
  if (host.hasCore()) {
    try {
      await host.stopCore("startup-failed");
      coreStopped = true;
    } catch (stopError) {
      log.error(undefined, "failed to stop Core after supervisor startup failure", stopError);
    }
  }

  const control = host.getControl();
  let controlClosed = control === undefined;
  if (control) {
    try {
      await control.close();
      host.clearControl();
      controlClosed = true;
    } catch (closeError) {
      log.error(
        undefined,
        "failed to close control server after supervisor startup failure",
        closeError,
      );
    }
  }

  if (coreStopped && controlClosed) {
    // 恢复失败本身已经写入 stop-failed；即使没有 Core/control 需要收口，也保留该
    // 状态，让 status 继续暴露待人工处理的事务，同时释放锁允许同实例稍后重试。
    host.setState(recoveryFailed ? "stop-failed" : "stopped");
    await host.persistStatusSnapshot().catch((snapshotError) => {
      log.warn(
        undefined,
        "failed to persist stopped state after supervisor startup failure",
        snapshotError,
      );
    });
    await host.releaseLock();
  } else {
    host.setState("stop-failed");
    await host.persistStatusSnapshot().catch((snapshotError) => {
      log.warn(
        undefined,
        "failed to persist stop-failed state after supervisor startup failure",
        snapshotError,
      );
    });
  }
}
