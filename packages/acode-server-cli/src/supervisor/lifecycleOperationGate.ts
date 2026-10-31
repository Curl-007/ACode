// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ./supervisor.ts 拆出。
// 职责：生命周期操作互斥门（同一时刻只允许一个 stop/restart/update/uninstall，
// ack 型请求回包前的 gate 检查与后台失败的日志记录）。状态全部封装在本类内，
// Supervisor 以同名私有方法委托，调用点保持逐字不变。
import { createServiceLogger } from "@acode/services/node";
import { ControlRequestError } from "../ipc/controlError.js";

// 与 supervisor.ts 同一 scope：生命周期事件按运维排障判据用 info/warn/error。
const log = createServiceLogger("server-supervisor");

export type LifecycleOperationKind = "stop" | "restart" | "update" | "uninstall";

export class LifecycleOperationGate {
  private operation: { kind: LifecycleOperationKind; promise: Promise<unknown> } | undefined;

  /** 供 Supervisor 的就绪/崩溃守卫读取当前是否有生命周期操作（原 this.lifecycleOperation 真值判定）。 */
  public get active(): { kind: LifecycleOperationKind; promise: Promise<unknown> } | undefined {
    return this.operation;
  }

  public run<T>(kind: LifecycleOperationKind, operation: () => Promise<T>): Promise<T> {
    this.assertCanStart(kind);
    const active = this.operation;
    if (active) {
      return active.promise as Promise<T>;
    }
    const promise = Promise.resolve().then(operation);
    this.operation = { kind, promise };
    void promise.then(
      () => {
        if (this.operation?.promise === promise) this.operation = undefined;
      },
      () => {
        if (this.operation?.promise === promise) this.operation = undefined;
      },
    );
    return promise;
  }

  public startAcknowledged(kind: LifecycleOperationKind, operation: () => Promise<unknown>): void {
    // ack 型请求也必须在回包前检查 gate；后台 Promise 再 reject 会让客户端误以为
    // restart/uninstall 已受理，实际却只在 Supervisor 日志里留下冲突。
    this.assertCanStart(kind);
    const started = this.run(kind, async () => {
      // control response 必须先写回原 socket；直接关闭 control server 会与 dispatch 互等。
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await operation();
    });
    void started.catch((error: unknown) => {
      log.error(undefined, `lifecycle operation ${kind} failed`, error);
    });
  }

  private assertCanStart(kind: LifecycleOperationKind): void {
    const active = this.operation;
    if (!active || (kind === "stop" && active.kind === "stop")) return;
    throw new ControlRequestError(
      "operation-in-progress",
      `Lifecycle operation ${active.kind} is already in progress`,
      true,
    );
  }
}
