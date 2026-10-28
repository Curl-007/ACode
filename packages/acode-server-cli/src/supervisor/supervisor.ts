import { type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServiceLogger } from "@acode/services/node";
import {
  coreMessageSchema,
  SERVER_CLI_PROTOCOL_VERSION,
  type ControlRequest,
  type LifecycleState,
  type ReleaseManifest,
  type ServerStatus,
} from "../contracts.js";
import { createControlServer, type ControlHandler } from "../ipc/controlServer.js";
import { DataRootLock } from "../runtime/lock.js";
import { resolveServerLayout, type ServerLayout } from "../runtime/paths.js";
import { ReleaseManager } from "../runtime/releaseManager.js";
import { createStatusPersister } from "../runtime/statusSnapshot.js";
import { recoverSupervisorStartup } from "../runtime/startupRecovery.js";
import { updateErrorMessage } from "../runtime/updateErrors.js";
import { CrashBudget } from "./crashBudget.js";
import { CoreHealthMonitor } from "./coreHealth.js";
// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自包含方法族拆为同目录
// helper 叶子——lifecycleOperationGate（互斥门）、coreTermination（Core 终态等待）、
// coreHealthCheck（心跳巡检调度）、releaseUpdate（更新/回滚状态机）、
// automaticRecovery（崩溃自动恢复与 ready 死线）、startupFailure（启动失败收口）。
// 私有状态/方法经构造注入的闭包访问，闭包捕获关系与拆前等价；本类保留的私有
// 委托方法让 handleControl/launchCore 等调用点逐字不变。
import { LifecycleOperationGate, type LifecycleOperationKind } from "./lifecycleOperationGate.js";
import { waitForCoreTermination } from "./coreTermination.js";
import { CoreHealthCheckScheduler } from "./coreHealthCheck.js";
import { ReleaseUpdater } from "./releaseUpdate.js";
import { AutomaticRecovery } from "./automaticRecovery.js";
import { cleanupFailedStartup } from "./startupFailure.js";
import { dispatchControlRequest, type ControlDispatchHost } from "./controlDispatch.js";
import { type SupervisorOptions } from "./supervisorOptions.js";

// 生命周期事件按运维排障判据用 info/warn/error（出问题时运维要能在日志里看到）；
// 高频 heartbeat/task-activity 明细走 debug，避免生产日志膨胀。
const log = createServiceLogger("server-supervisor");

export class Supervisor {
  private readonly layout: ServerLayout;
  private readonly lock: DataRootLock;
  private readonly crashBudget: CrashBudget;
  private readonly coreHealth: CoreHealthMonitor;
  private readonly releaseManager: ReleaseManager;
  private readonly lifecycleGate = new LifecycleOperationGate();
  private readonly healthChecks: CoreHealthCheckScheduler;
  private readonly updateFlow: ReleaseUpdater;
  private readonly automaticRecovery: AutomaticRecovery;
  private readonly controlHost: ControlDispatchHost;
  private core: ChildProcess | undefined;
  private control: Awaited<ReturnType<typeof createControlServer>> | undefined;
  private state: LifecycleState = "stopped";
  private generation = 0;
  private host: string | null = null;
  private port: number | null = null;
  private startedAt: number | null = null;
  private runningTaskCount = 0;
  private lastExitReason: string | null = null;
  private readonly persistStatusSnapshot: () => Promise<void>;
  private activeRelease: ReleaseManifest | null = null;

  public constructor(private readonly options: SupervisorOptions) {
    this.layout = options.layout ?? resolveServerLayout();
    this.lock = new DataRootLock(this.layout.lockFile);
    this.crashBudget = new CrashBudget({ now: options.now });
    this.coreHealth = new CoreHealthMonitor({
      timeoutMs: options.coreHeartbeatTimeoutMs ?? 30_000,
      now: options.now,
    });
    this.releaseManager = new ReleaseManager(this.layout);
    this.persistStatusSnapshot = createStatusPersister(
      this.layout.statusFile,
      () => this.status(),
      (error) => log.warn(undefined, "failed to persist status snapshot", error),
    );
    // helper 叶子的宿主闭包统一惰性读取 this.*，求值时点与拆前方法内直接访问一致。
    this.healthChecks = new CoreHealthCheckScheduler({
      health: this.coreHealth,
      heartbeatTimeoutMs: options.coreHeartbeatTimeoutMs,
      checkIntervalMs: options.coreHeartbeatCheckIntervalMs,
      now: options.now,
      host: {
        isCurrentCore: (child, generation) => this.core === child && this.generation === generation,
        isLifecycleBlockingCheck: () =>
          this.state === "stopping" || this.state === "stopped" || this.state === "stop-failed",
        onHealthTransition: () => void this.persistStatusSnapshot(),
      },
    });
    this.updateFlow = new ReleaseUpdater({
      releaseManager: this.releaseManager,
      coreReadyTimeoutMs: options.coreReadyTimeoutMs,
      host: {
        getRunningTaskCount: () => this.runningTaskCount,
        stopCore: (reason) => this.stopCore(reason),
        getState: () => this.state,
        setState: (state) => {
          this.state = state;
        },
        persistStatusSnapshot: () => this.persistStatusSnapshot(),
        launchCore: () => this.launchCore(),
        hasCore: () => this.core !== undefined,
        getActiveRelease: () => this.activeRelease,
        setActiveRelease: (release) => {
          this.activeRelease = release;
        },
        setLastExitReason: (reason) => {
          this.lastExitReason = reason;
        },
      },
    });
    this.automaticRecovery = new AutomaticRecovery({
      crashBudget: this.crashBudget,
      lifecycleGate: this.lifecycleGate,
      coreReadyTimeoutMs: options.coreReadyTimeoutMs,
      host: {
        getState: () => this.state,
        setState: (state) => {
          this.state = state;
        },
        getGeneration: () => this.generation,
        isCurrentCore: (child, generation) => this.core === child && this.generation === generation,
        stopCore: (reason) => this.stopCore(reason),
        launchCore: (automaticRestart) => this.launchCore(automaticRestart),
        status: () => this.status(),
        setLastExitReason: (reason) => {
          this.lastExitReason = reason;
        },
        persistStatusSnapshot: () => this.persistStatusSnapshot(),
      },
    });
    this.controlHost = {
      status: () => this.status(),
      stopInternal: (reason) => this.stopInternal(reason),
      start: () => this.start(),
      applyUpdate: (force) => this.updateFlow.apply(force),
      getRunningTaskCount: () => this.runningTaskCount,
      runLifecycleOperation: (kind, operation) => this.lifecycleGate.run(kind, operation),
      startAcknowledgedLifecycleOperation: (kind, operation) =>
        this.lifecycleGate.startAcknowledged(kind, operation),
    };
  }

  public async start(): Promise<ServerStatus> {
    if (this.state === "ready" || this.state === "starting") return this.status();
    await this.releaseManager.ensure();
    await this.lock.acquire();
    try {
      // 启动恢复会回写 current.json 并删除 update-transaction.json，必须先取得
      // data-root 单实例锁；否则存活 Supervisor 的 apply-update 会与第二个启动者竞态，
      // 造成内存继续运行新 release、磁盘 current pointer 却被回滚到旧 release。
      await recoverSupervisorStartup(
        this.releaseManager,
        this.layout.uninstalledFile,
        this.layout.serverRoot,
        async (error) => {
          this.state = "stop-failed";
          this.lastExitReason = `update rollback recovery failed: ${updateErrorMessage(error)}`;
          await this.persistStatusSnapshot();
        },
      );
      // recovery 可能已经恢复 current pointer；必须在恢复后读取，避免启动已回滚的 candidate。
      this.activeRelease = await this.releaseManager.readCurrentForExecution();
      await mkdir(this.layout.runDir, { recursive: true, mode: 0o700 });
      const handler: ControlHandler = (request) => this.handleControl(request);
      this.control = await createControlServer(this.layout.controlEndpoint, handler);
      this.state = "starting";
      log.info(undefined, "supervisor started", {
        serverRoot: this.layout.serverRoot,
        version: this.options.version,
      });
      this.launchCore();
      await this.persistStatusSnapshot();
      return this.status();
    } catch (error) {
      await cleanupFailedStartup({
        getState: () => this.state,
        setState: (state) => {
          this.state = state;
        },
        hasCore: () => this.core !== undefined,
        stopCore: (reason) => this.stopCore(reason),
        getControl: () => this.control,
        clearControl: () => {
          this.control = undefined;
        },
        persistStatusSnapshot: () => this.persistStatusSnapshot(),
        releaseLock: () => this.lock.release(),
      });
      throw error;
    }
  }

  public async stop(reason = "requested"): Promise<ServerStatus> {
    return await this.runLifecycleOperation("stop", () => this.stopInternal(reason));
  }

  private async stopInternal(reason: string): Promise<ServerStatus> {
    if (!this.core) {
      this.state = "stopped";
      await this.persistStatusSnapshot();
      await this.control?.close();
      this.control = undefined;
      await this.lock.release();
      if (reason !== "restart") this.options.onStopped?.();
      return this.status();
    }
    await this.stopCore(reason);
    this.state = "stopped";
    await this.persistStatusSnapshot();
    await this.control?.close();
    this.control = undefined;
    await this.lock.release();
    log.info(undefined, "supervisor stopped", { reason });
    if (reason !== "restart") this.options.onStopped?.();
    return this.status();
  }

  public async restart(): Promise<ServerStatus> {
    return await this.runLifecycleOperation("restart", async () => {
      await this.stopInternal("restart");
      return await this.start();
    });
  }

  private async stopCore(reason: string): Promise<void> {
    if (!this.core) return;
    this.state = "stopping";
    this.lastExitReason = reason;
    log.info(undefined, "stopping server core", { reason, pid: this.core.pid });
    const core = this.core;
    try {
      await waitForCoreTermination(core, {
        graceTimeoutMs: this.options.coreStopGraceTimeoutMs ?? 5_000,
        killTimeoutMs: this.options.coreKillTimeoutMs ?? 2_000,
      });
    } catch (error) {
      if (this.core === core) {
        this.state = "stop-failed";
        this.lastExitReason = error instanceof Error ? error.message : String(error);
        await this.persistStatusSnapshot();
      }
      throw error;
    }
    if (this.core === core) {
      this.core = undefined;
      this.clearCoreScopedStatus();
    }
  }

  public status(): ServerStatus {
    return {
      protocolVersion: SERVER_CLI_PROTOCOL_VERSION,
      state: this.state,
      pid: this.core?.pid ?? null,
      port: this.port,
      host: this.host,
      version: this.options.version,
      generation: this.generation,
      startedAt: this.startedAt,
      lastExitReason: this.lastExitReason,
      serviceRegistered: this.options.serviceRegistered ?? false,
      runningTaskCount: this.runningTaskCount,
      coreHealth: this.coreHealth.snapshot(this.options.now?.() ?? Date.now()).health,
      lastHeartbeatAt: this.coreHealth.snapshot().lastHeartbeatAt,
      crashBudget: this.crashBudget.snapshot(),
      updatedAt: Date.now(),
    };
  }

  private launchCore(automaticRestart = false): void {
    const generation = ++this.generation;
    const child = this.options.launcher.launch(generation, this.activeRelease);
    this.core = child;
    this.clearCoreScopedStatus();
    this.healthChecks.schedule(child, generation);
    log.info(undefined, "launching server core", { generation, pid: child.pid });
    child.on("message", (raw: unknown) => this.handleCoreMessage(child, generation, raw));
    let terminalObserved = false;
    let spawnErrorReason: string | undefined;
    const handleTerminal = (reason: string): void => {
      if (terminalObserved) return;
      terminalObserved = true;
      if (this.core !== child || this.state === "stopping" || this.state === "stopped") return;
      if (this.state === "stop-failed") {
        // stop 已失败时继续保留锁；迟到的终态只清除已死亡 child，不得计入 crash budget
        // 或启动替代 Core。用户重试 stop 后再释放 control socket 与 data-root lock。
        this.core = undefined;
        this.clearCoreScopedStatus();
        this.lastExitReason = reason;
        void this.persistStatusSnapshot();
        return;
      }
      this.core = undefined;
      this.clearCoreScopedStatus();
      this.automaticRecovery.recordCoreFailure(reason);
    };
    // fork 的 execPath 不存在/不可执行时 Node 只发 error + close，不发 exit。
    // error 与 exit 必须共用一次性终态，否则未处理的 error 会杀死 Supervisor，并让更新
    // 已写入的新 current pointer 绕过 catch/rollback。
    child.once("error", (error: Error & { code?: string }) => {
      spawnErrorReason = `core spawn error code=${error.code ?? "unknown"}: ${error.message}`;
      this.lastExitReason = spawnErrorReason;
      log.error(undefined, "server core process error", error);
      void this.persistStatusSnapshot();
    });
    child.once("exit", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core exited code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
    child.once("close", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core closed code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
    if (automaticRestart) this.automaticRecovery.scheduleReadyDeadline(child, generation);
  }

  private handleCoreMessage(child: ChildProcess, expectedGeneration: number, raw: unknown): void {
    // 旧 child 的 message listener 会跨 generation 存活，延迟 heartbeat/ready
    // 可覆盖当前 Core 的状态。消息必须同时绑定当前 child；ready 还需匹配启动 generation。
    if (this.core !== child) return;
    const parsed = coreMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.type === "ready") {
      // ready 只对当前 starting 的 Core 有效；stopping/stopped/stop-failed 阶段的迟到消息
      // 不能复活已经收口或进入不确定终态的 Supervisor。
      if (message.generation !== expectedGeneration || this.state !== "starting") return;
      this.state = "ready";
      this.automaticRecovery.clearReadyDeadline();
      this.host = message.host;
      this.port = message.port;
      this.generation = message.generation;
      this.startedAt = Date.now();
      this.coreHealth.markReady(this.options.now?.() ?? Date.now());
      log.info(undefined, "server core ready", {
        host: this.host,
        port: this.port,
        generation: this.generation,
      });
    } else if (message.type === "heartbeat" || message.type === "task-activity") {
      // 心跳只能刷新已 ready 的 Core；提前或停止中的迟到消息不能把 unknown
      // 变成 healthy，也不能在停止期间重新写入已经收口的任务计数。
      if (this.state !== "ready") return;
      this.runningTaskCount = message.runningTaskCount;
      this.coreHealth.markHeartbeat(this.options.now?.() ?? Date.now());
      log.debug(undefined, "core activity snapshot", {
        type: message.type,
        runningTaskCount: message.runningTaskCount,
      });
    } else if (message.type === "fatal") {
      this.lastExitReason = message.message;
      log.error(undefined, "server core reported fatal error", { message: message.message });
    } else if (message.type === "exit") {
      this.lastExitReason = message.reason;
      log.info(undefined, "server core reported exit", { reason: message.reason });
    }
    void this.persistStatusSnapshot();
  }

  private clearCoreScopedStatus(): void {
    this.automaticRecovery.clearReadyDeadline();
    this.healthChecks.clear();
    this.coreHealth.reset();
    this.host = null;
    this.port = null;
    this.startedAt = null;
    this.runningTaskCount = 0;
  }

  private async handleControl(request: ControlRequest): Promise<unknown> {
    return await dispatchControlRequest(this.controlHost, request);
  }

  private runLifecycleOperation<T>(
    kind: LifecycleOperationKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.lifecycleGate.run(kind, operation);
  }
}
