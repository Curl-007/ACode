// ACode 适配（无上游对应物）：omp 用全局 daemon broker 跨进程保活 relay 并按消费者租约
// 启停；ACode wave 1 没有该 broker，租约语义降为进程内（specs「集成与共享桶申请」第 3 条）。
/**
 * 按消费者租约计数启停 relay 服务端的进程内管理器。
 *
 * - 首个 `acquire()` 启动服务端（singleflight：并发首租共享同一启动 promise）；
 * - 重复 `acquire()` 复用运行中的服务端，不重复 bind；
 * - 最后一个 `lease.release()` 计数归零即 `stop()`；
 * - release 与在途 acquire/start 交叠时以计数为准，不复活已停实例；
 * - 端口是键：不同端口各自一个管理器实例，互不影响。
 */
import { deferred, type Deferred } from "./internal.js";
import { startRelayServer, type RelayServer, type RelayServerOptions } from "./server.js";

/** 服务端工厂 seam：测试注入假服务端，验证启停时序而不绑定端口。 */
export type RelayServerFactory = (opts: RelayServerOptions) => RelayServer;

export interface RelayLeaseManagerOptions extends RelayServerOptions {
  serverFactory?: RelayServerFactory;
}

export interface RelayLease {
  release(): void;
}

interface ManagedServer {
  server: RelayServer;
  leases: number;
  /** 归零后的停止完成信号；交叠的 acquire 等它结束后重新走启动路径。 */
  stopped: Promise<void> | null;
}

export class RelayLeaseManager {
  readonly #options: RelayLeaseManagerOptions;
  readonly #factory: RelayServerFactory;
  #managed: ManagedServer | null = null;
  /** singleflight：首个 acquire 的启动 promise；后到者等待同一结果。 */
  #starting: Deferred<RelayServer> | null = null;

  constructor(options: RelayLeaseManagerOptions) {
    this.#options = options;
    this.#factory = options.serverFactory ?? startRelayServer;
  }

  /** 当前租约数（测试与诊断面）。 */
  get leaseCount(): number {
    return this.#managed?.leases ?? 0;
  }

  /** 是否已有运行中的服务端（测试与诊断面）。 */
  get running(): boolean {
    return this.#managed !== null && this.#managed.stopped === null;
  }

  /**
   * 取一个消费者租约；首个租约启动服务端。端口被非 relay 进程占用时启动失败并拒绝
   * 本次 acquire（错误原样上抛，不静默吞掉——调用方要能区分「没起来」）。
   */
  async acquire(): Promise<RelayLease> {
    for (;;) {
      if (this.#managed) {
        // 上一代已归零、正在关闭：等真实关闭完成再走全新启动，同端口不会 EADDRINUSE。
        if (this.#managed.stopped) {
          const stopped = this.#managed.stopped;
          await stopped;
          // 关闭完成后清掉旧代（并发重启者可能已抢先清空，幂等处理）。
          if (this.#managed?.stopped === stopped) this.#managed = null;
          continue;
        }
        this.#managed.leases += 1;
        return this.#lease();
      }
      if (this.#starting) {
        await this.#starting.promise;
        continue;
      }
      const starting = deferred<RelayServer>();
      this.#starting = starting;
      // 无并发等待者时启动失败不能成为 unhandledRejection；真实等待者 await 的是
      // 同一 promise（分支挂各自的 handler）。
      starting.promise.catch(() => {});
      try {
        const server = this.#factory({
          port: this.#options.port,
          ...(this.#options.token ? { token: this.#options.token } : {}),
          ...(this.#options.group !== undefined ? { group: this.#options.group } : {}),
          ...(this.#options.log ? { log: this.#options.log } : {}),
        });
        // acquire 的后条件是「已在服务」：等绑定完成，端口被占在此显式失败。
        await server.whenListening;
        this.#managed = { server, leases: 1, stopped: null };
        starting.resolve(server);
      } catch (error) {
        this.#starting = null;
        starting.reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      this.#starting = null;
      return this.#lease();
    }
  }

  #lease(): RelayLease {
    let released = false;
    return {
      release: () => {
        if (released) return; // 幂等边界：重复 release 是调用方 bug，但不放大伤害。
        released = true;
        this.#releaseOne();
      },
    };
  }

  #releaseOne(): void {
    const managed = this.#managed;
    if (!managed) return;
    managed.leases -= 1;
    if (managed.leases > 0) return;
    // 条目保留到真实关闭完成（server close 事件）：期间的新 acquire 排队在其后，
    // 同端口重启不会与上一代的关闭竞速出 EADDRINUSE。
    managed.stopped = managed.server.whenStopped;
    try {
      managed.server.stop();
    } catch {
      // 停止失败不回滚租约清零：服务端已不可复用。
    }
  }
}
