// 关停任务注册表 + 退出看门狗（specs/shutdown-keepawake-containment.md R1-R3/R6/R7）。
//
// 三名单语义：注册时一次分派到 all / beforeInstall 段 / stopsChildProcesses 段。
// runShutdown("normal") 执行全部名单；runShutdown("update-install") 只执行
// beforeInstall ∪ stopsChildProcesses 段（更新器重启安装前的收敛面，调用方在
// autoUpdater 侧），其余任务留给随后的 normal 关停，已执行的按 name 跳过。
//
// 逐 handler 记账 → 超时 abort 记 pending_handlers → 证据经 shutdownEvidence 落盘 →
// arm 看门狗：事件循环在清理收口后仍存活超过 policy.watchdogDelayMs 即标记
// watchdog_fired 并强制退出。本文件不 import electron，退出动作由 deps.forceExit 注入。
import type { AppShutdownKind, AppShutdownPolicy } from "./appShutdownPolicy.js";
import {
  SHUTDOWN_HANDLER_NAME_PATTERN,
  summarizeShutdownCleanup,
  type ShutdownEvidenceRecord,
  type ShutdownEvidenceStore,
} from "./shutdownEvidence.js";

export interface ShutdownTask {
  /** 记账键，封闭字符集 ^[A-Za-z0-9_.-]{1,64}$；重名拒绝注册。 */
  name: string;
  /** 必须幂等：update-install 段执行后，normal 关停可能对同名单再次调度（已执行的会跳过，但注册方不应依赖该保护）。 */
  fn: () => void | Promise<void>;
  /** 更新器重启安装前必须完成（flush/persist 类）。 */
  beforeInstall?: boolean;
  /** 会停止子进程（pty/MCP/预览类），更新安装前的资源锁收敛面。 */
  stopsChildProcesses?: boolean;
}

export interface ShutdownRunResult {
  kind: AppShutdownKind;
  attempted: string[];
  skipped: string[];
  durationsMs: Record<string, number>;
  timedOut: boolean;
  pendingHandlers: string[];
  cleanupMs: number;
  evidence: ShutdownEvidenceRecord;
}

export interface ShutdownTaskLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface ShutdownTaskRegistryDeps {
  evidence: ShutdownEvidenceStore;
  logger: ShutdownTaskLogger;
  /** 与 prepareAppQuit 共用同一分档策略来源（appShutdownPolicy.ts）。 */
  resolvePolicy: (kind: AppShutdownKind) => AppShutdownPolicy;
  appVersion: () => string;
  /** 看门狗最终动作；接线注入 (reason) => app.exit(0)。 */
  forceExit: (reason: string) => void;
  /** 单调时钟（计时），默认 performance.now。 */
  now?: () => number;
  /** 墙钟（证据 ts/epoch），默认 Date.now。 */
  wallNow?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface ShutdownTaskRegistry {
  register(task: ShutdownTask): boolean;
  listTasks(): readonly ShutdownTask[];
  /** 进程内已执行过的任务名（update-install → normal 两段调度的去重依据）。 */
  listExecuted(): readonly string[];
  runShutdown(kind: AppShutdownKind, options?: { reason?: string }): Promise<ShutdownRunResult>;
}

export function createShutdownTaskRegistry(deps: ShutdownTaskRegistryDeps): ShutdownTaskRegistry {
  const allTasks: ShutdownTask[] = [];
  const beforeInstallTasks: ShutdownTask[] = [];
  const stopsChildProcessesTasks: ShutdownTask[] = [];
  const tasksByName = new Map<string, ShutdownTask>();
  const executedNames = new Set<string>();
  const now = deps.now ?? (() => performance.now());
  const wallNow = deps.wallNow ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  let running: Promise<ShutdownRunResult> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  function selectTasks(kind: AppShutdownKind): ShutdownTask[] {
    if (kind !== "update-install") {
      return [...allTasks];
    }
    // beforeInstall ∪ stopsChildProcesses，按注册序去重。
    const selected = new Set<ShutdownTask>();
    for (const task of beforeInstallTasks) {
      selected.add(task);
    }
    for (const task of stopsChildProcessesTasks) {
      selected.add(task);
    }
    return allTasks.filter((task) => selected.has(task));
  }

  function armWatchdog(kind: AppShutdownKind, policy: AppShutdownPolicy): void {
    if (watchdogTimer !== null) {
      // update-install 与 normal 两段调度都可能 arm；以最后一次清理收口重新计时。
      clearTimeoutFn(watchdogTimer);
    }
    watchdogTimer = setTimeoutFn(() => {
      watchdogTimer = null;
      deps.evidence.markWatchdogFired(wallNow());
      // 结构化日志：status 是保留闭集键，自定义状态一律走 outcome（spec R7）。
      deps.logger.error("[shutdown] quit watchdog fired — event loop still alive, forcing exit", {
        event: "shutdown_watchdog_fired",
        outcome: "forced_exit",
        kind,
        timeout_ms: policy.watchdogDelayMs,
        pending_handlers: deps.evidence.getCurrent()?.pending_handlers ?? [],
      });
      deps.forceExit("shutdown-watchdog");
    }, policy.watchdogDelayMs);
    watchdogTimer.unref?.();
  }

  async function executeShutdown(
    kind: AppShutdownKind,
    options?: { reason?: string },
  ): Promise<ShutdownRunResult> {
    const policy = deps.resolvePolicy(kind);
    const reason = options?.reason ?? kind;
    const selected = selectTasks(kind);
    const attempted = selected.filter((task) => !executedNames.has(task.name));
    const skipped = selected
      .filter((task) => executedNames.has(task.name))
      .map((task) => task.name);
    const attemptedNames = attempted.map((task) => task.name);
    const forUpdate = kind === "update-install";
    const startedEpochMs = wallNow();
    const startedAt = now();

    deps.evidence.recordCleanupStart({
      handlerNames: attemptedNames,
      forUpdate,
      appVersion: deps.appVersion(),
      startedEpochMs,
    });

    const durationsMs = new Map<string, number>();
    let pendingAtAbort: string[] | null = null;

    if (attempted.length > 0) {
      deps.logger.info("[shutdown] running cleanup tasks", {
        event: "shutdown_cleanup_started",
        outcome: "started",
        kind,
        reason,
        handler_count: attemptedNames.length,
        handlers: attemptedNames,
        skipped,
        cleanup_budget_ms: policy.cleanupBudgetMs,
      });
      let resolveAborted: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        resolveAborted = resolve;
      });
      const budgetTimer = setTimeoutFn(() => {
        // abort 只停止等待，不取消 handler（无法安全取消）；名单快照即证据。
        pendingAtAbort = attemptedNames.filter((name) => !durationsMs.has(name));
        deps.logger.error("[shutdown] cleanup budget exhausted, aborting wait and quitting", {
          event: "shutdown_cleanup_timeout",
          outcome: "aborted",
          kind,
          timeout_ms: policy.cleanupBudgetMs,
          pending_handlers: pendingAtAbort,
        });
        resolveAborted?.();
      }, policy.cleanupBudgetMs);
      budgetTimer.unref?.();

      await Promise.race([
        aborted,
        Promise.allSettled(
          attempted.map(async (task) => {
            const taskStartedAt = now();
            try {
              await task.fn();
            } catch (error) {
              // 抛错也计入时长：任务已执行（executed），只是结果失败。
              durationsMs.set(task.name, now() - taskStartedAt);
              deps.logger.error(
                `[shutdown] cleanup task failed: ${task.name} (${Math.round(now() - taskStartedAt)}ms)`,
                {
                  event: "shutdown_task_failed",
                  outcome: "failed",
                  kind,
                  handler: task.name,
                  error: error instanceof Error ? error.message : String(error),
                },
              );
              return;
            }
            const durationMs = now() - taskStartedAt;
            durationsMs.set(task.name, durationMs);
            deps.logger.info(
              `[shutdown] cleanup task done: ${task.name} (${Math.round(durationMs)}ms)`,
              {
                event: "shutdown_task_done",
                outcome: "completed",
                kind,
                handler: task.name,
                duration_ms: Math.round(durationMs),
              },
            );
          }),
        ),
      ]);
      clearTimeoutFn(budgetTimer);
    }

    for (const task of attempted) {
      executedNames.add(task.name);
    }
    const elapsedMs = now() - startedAt;
    const evidence = deps.evidence.recordCleanupFinished({
      handlerNames: attemptedNames,
      durationsMs,
      elapsedMs,
      pendingAtAbort,
      forUpdate,
      appVersion: deps.appVersion(),
      startedEpochMs,
    });
    const summary = summarizeShutdownCleanup({
      handlerNames: attemptedNames,
      durationsMs,
      elapsedMs,
      pendingAtAbort,
    });
    deps.logger.info(
      `[shutdown] cleanup finished (${summary.cleanup_ms}ms across ${summary.handler_count} tasks${
        summary.timed_out ? `, timed out waiting on ${summary.pending_handlers.join(", ")}` : ""
      })`,
      {
        event: "shutdown_cleanup_finished",
        outcome: summary.timed_out ? "timed_out" : "completed",
        kind,
        reason,
        cleanup_ms: summary.cleanup_ms,
        handler_count: summary.handler_count,
        slowest_handler: summary.slowest_handler,
        slowest_ms: summary.slowest_ms,
        pending_handlers: summary.pending_handlers,
      },
    );

    armWatchdog(kind, policy);
    return {
      kind,
      attempted: attemptedNames,
      skipped,
      durationsMs: Object.fromEntries(durationsMs),
      timedOut: evidence.timed_out,
      pendingHandlers: evidence.pending_handlers,
      cleanupMs: evidence.cleanup_ms ?? 0,
      evidence,
    };
  }

  return {
    register(task) {
      if (typeof task?.fn !== "function") {
        deps.logger.warn("[shutdown] rejected task without callable fn", {
          event: "shutdown_task_rejected",
          outcome: "missing_fn",
        });
        return false;
      }
      if (!SHUTDOWN_HANDLER_NAME_PATTERN.test(task.name)) {
        deps.logger.warn(
          `[shutdown] rejected task with invalid name: ${JSON.stringify(task.name)}`,
          {
            event: "shutdown_task_rejected",
            outcome: "invalid_name",
          },
        );
        return false;
      }
      if (tasksByName.has(task.name)) {
        // 记账以 name 为键，重名会让 durations/pending 名单失真：拒绝并留痕。
        deps.logger.warn(`[shutdown] rejected duplicate task name: ${task.name}`, {
          event: "shutdown_task_rejected",
          outcome: "duplicate_name",
          handler: task.name,
        });
        return false;
      }
      tasksByName.set(task.name, task);
      allTasks.push(task);
      if (task.beforeInstall) {
        beforeInstallTasks.push(task);
      }
      if (task.stopsChildProcesses) {
        stopsChildProcessesTasks.push(task);
      }
      return true;
    },
    listTasks() {
      return [...allTasks];
    },
    listExecuted() {
      return [...executedNames];
    },
    runShutdown(kind, options) {
      if (running !== null) {
        // 并发关停请求共享同一轮执行（before-quit/will-quit/updater 可能先后触发）。
        deps.logger.info(`[shutdown] shutdown already running, joining in-flight run (${kind})`, {
          event: "shutdown_join_inflight",
          outcome: "joined",
          kind,
        });
        return running;
      }
      const run = executeShutdown(kind, options).finally(() => {
        running = null;
      });
      running = run;
      return run;
    },
  };
}
