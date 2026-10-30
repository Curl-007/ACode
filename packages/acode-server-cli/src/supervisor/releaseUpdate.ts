// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ./supervisor.ts 拆出。
// 职责：apply-update 更新/回滚状态机（原 Supervisor.applyUpdate 与
// enterUpdateRollback）。ReleaseManager 由 Supervisor 构造后注入；对 Supervisor
// 私有状态（state/core/activeRelease/runningTaskCount/lastExitReason）与私有方法
// （stopCore/launchCore/persistStatusSnapshot）的访问经构造注入的闭包完成，
// 闭包捕获关系与拆前方法内直接访问 this 等价，操作顺序逐字保留。
import { createServiceLogger } from "@acode/services/node";
import { type LifecycleState, type ReleaseManifest } from "../contracts.js";
import { type ReleaseManager } from "../runtime/releaseManager.js";
import { waitForUpdateReady } from "../runtime/updateReadiness.js";
import { createRollbackFailure, updateErrorMessage } from "../runtime/updateErrors.js";

// 与 supervisor.ts 同一 scope：更新/回滚事件按运维排障判据用 info/warn/error。
const log = createServiceLogger("server-supervisor");

export interface ReleaseUpdateHost {
  getRunningTaskCount(): number;
  stopCore(reason: string): Promise<void>;
  getState(): LifecycleState;
  setState(state: LifecycleState): void;
  persistStatusSnapshot(): Promise<void>;
  launchCore(): void;
  /** 原 this.core 真值判定（catch 段两次实时读取）。 */
  hasCore(): boolean;
  getActiveRelease(): ReleaseManifest | null;
  setActiveRelease(release: ReleaseManifest | null): void;
  setLastExitReason(reason: string): void;
}

export class ReleaseUpdater {
  public constructor(
    private readonly options: {
      releaseManager: ReleaseManager;
      host: ReleaseUpdateHost;
      coreReadyTimeoutMs?: number;
    },
  ) {}

  public async apply(force: boolean): Promise<unknown> {
    const pending = await this.options.releaseManager.readPending();
    if (!pending) throw new Error("No pending release is prepared");
    if (this.options.host.getRunningTaskCount() > 0 && !force) {
      throw new Error("Running tasks require --force for update");
    }
    const previous = await this.options.releaseManager.readCurrent();
    log.info(undefined, "applying pending release", { version: pending.version, force });
    await this.options.host.stopCore("update");
    this.options.host.setState("updating");
    await this.options.host.persistStatusSnapshot();
    try {
      await this.options.releaseManager.applyPendingWithTransaction(previous);
      this.options.host.setActiveRelease(pending);
      this.options.host.setState("starting");
      this.options.host.launchCore();
      await waitForUpdateReady(
        () => this.options.host.getState(),
        this.options.coreReadyTimeoutMs ?? 15_000,
      );
      await this.options.releaseManager.completeUpdate();
      log.info(undefined, "release applied", { version: pending.version });
      return { applied: true, version: pending.version };
    } catch (error) {
      this.enterUpdateRollback();
      // 更新后的 Core 未 ready 时必须先停止仍存活的子进程，再恢复 current 指针。
      // 否则 timeout 路径会覆盖 this.core 引用后遗留新 Core，与回滚后的旧 Core 并存。
      if (this.options.host.hasCore()) {
        try {
          await this.options.host.stopCore("update-rollback");
        } catch (stopError) {
          log.error(undefined, "failed to stop unhealthy release during rollback", stopError);
          await this.options.host.persistStatusSnapshot();
          throw stopError;
        }
      }
      // 恢复 current 指针，避免下一次启动继续使用坏 release。
      log.error(undefined, "release apply failed, restoring previous current pointer", error);
      try {
        await this.options.releaseManager.restoreCurrent(previous);
        await this.options.releaseManager.completeUpdate();
      } catch (rollbackError: unknown) {
        this.options.host.setState("stop-failed");
        this.options.host.setLastExitReason(
          `rollback pointer restore failed: ${updateErrorMessage(rollbackError)}`,
        );
        await this.options.host.persistStatusSnapshot();
        throw createRollbackFailure(error, rollbackError);
      }
      this.options.host.setActiveRelease(previous);
      // 回滚不仅恢复 pointer，还要立即拉起旧 release；否则 daemon 会以 stopped 留在
      // 不可用状态，用户必须手工 restart 才能恢复服务。
      this.options.host.setState("stopped");
      if (previous) {
        this.options.host.setState("starting");
        this.options.host.launchCore();
        try {
          await waitForUpdateReady(
            () => this.options.host.getState(),
            this.options.coreReadyTimeoutMs ?? 15_000,
          );
        } catch (rollbackError) {
          log.error(undefined, "previous release rollback failed", rollbackError);
          // 旧 release ready 超时只改状态会让仍存活的 Core、PID 和 lock 与 stopped 脱节；复用 stopCore 等待 exit/close，失败则保持 stop-failed。
          if (this.options.host.hasCore()) await this.options.host.stopCore("update-rollback");
          this.options.host.setState("stopped");
        }
      }
      await this.options.host.persistStatusSnapshot();
      throw error;
    }
  }

  private enterUpdateRollback(): void {
    // 候选 Core 崩溃后 handleTerminal 会将状态置为 crashed 并安排自动重启；
    // 回滚文件操作期间必须先离开 crashed，否则定时器会用坏的 activeRelease 再次拉起 Core。
    if (this.options.host.getState() === "crashed") this.options.host.setState("updating");
  }
}
