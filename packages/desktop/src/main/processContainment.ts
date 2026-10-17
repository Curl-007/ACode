// Windows 孤儿进程围堵接线层（specs/shutdown-keepawake-containment.md R14/R17/R18，台账形态）。
// FFI 判决：desktop 声明依赖树无 FFI 能力（根 node_modules 的 koffi 属于 CLI adapters，
// 未进 desktop 的 tsup external 与 electron-builder 打包面），native Job Object 登记为
// 条件触发项（spec「登记项」），本轮实现替代形态：diagnostics_channel "child_process"
// 订阅 → spawn 台账（核心逻辑在 processContainmentCore.ts），退出/崩溃路径用台账做
// 进程树清理强化（对照 taskkill 兜底：那边按资源句柄实时扫描，这边按「main 亲手
// spawn 且未退出」收敛）。outcome 闭集：not_windows/disabled/no_capability/joined|tracked|
// failed。仅 win32 生效；非 Windows 返回 inert 控制器（POSIX 依赖既有 SIGTERM/SIGKILL
// 屏障与进程组语义）。测试经 deps.platform 注入跨平台驱动 win32 分支。
import { spawn as nodeSpawn } from "node:child_process";
import * as nodeDiagnosticsChannel from "node:diagnostics_channel";

import {
  commandBasename,
  CONTAINMENT_TOOL_BASENAMES,
  createSpawnLedger,
  type ChildProcessLike,
  type ProcessContainmentJobObjectPort,
  type ProcessContainmentLogger,
  type ProcessContainmentOutcome,
  type SpawnLedgerEntry,
} from "./processContainmentCore.js";

export interface ProcessContainmentDeps {
  logger: ProcessContainmentLogger;
  /** 默认 process.platform；测试注入 "win32" 跨平台驱动。 */
  platform?: NodeJS.Platform;
  /** 接线读 ACODE_PROCESS_CONTAINMENT !== "0"；false → outcome=disabled。 */
  enabled?: boolean;
  /** 接线读 ACODE_PROCESS_CONTAINMENT_JOB === "1"：显式要求 job 形态。 */
  requireJobObject?: boolean;
  jobObject?: ProcessContainmentJobObjectPort | null;
  /** 默认 node:diagnostics_channel；测试注入假频道。 */
  channel?: Pick<typeof nodeDiagnosticsChannel, "subscribe" | "unsubscribe">;
  now?: () => number;
  /** 崩溃 exit 钩子用，默认 process.kill。 */
  kill?: (pid: number, signal: string) => void;
  /** win32 优雅退出树杀，默认 taskkill /PID x /T /F（detached+unref，不阻塞退出）。 */
  runTreeKill?: (pid: number) => void;
  /** 默认 process.on("exit", listener)；测试注入捕获。 */
  registerExitListener?: (listener: () => void) => void;
  maxLedgerEntries?: number;
}

export interface ProcessContainmentSweepResult {
  reason: string;
  pids: number[];
  skippedToolPids: number[];
}

export interface ProcessContainmentController {
  readonly outcome: ProcessContainmentOutcome;
  getLedger(): readonly SpawnLedgerEntry[];
  listLivePids(): number[];
  /** 优雅退出路径：对台账存活项做树杀（win32 taskkill /T /F）。 */
  sweepOrphanedChildProcesses(reason: string): ProcessContainmentSweepResult;
  /** 崩溃路径：process exit 同步钩子，SIGKILL 直接子进程（无树语义，见 spec R17）。 */
  installExitHook(): void;
  dispose(): void;
}

export function installProcessContainment(
  deps: ProcessContainmentDeps,
): ProcessContainmentController {
  const platform = deps.platform ?? process.platform;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal as NodeJS.Signals));
  const runTreeKill =
    deps.runTreeKill ??
    ((pid: number) => {
      const killer = nodeSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref();
    });

  let outcome: ProcessContainmentOutcome = "failed";
  let subscribed = false;

  const ledger = createSpawnLedger({
    logger: deps.logger,
    now: deps.now ?? Date.now,
    parentPid: process.pid,
    maxEntries: deps.maxLedgerEntries,
    jobObject: deps.jobObject ?? null,
  });

  const channelListener = (message: unknown): void => {
    const child = (message as { process?: ChildProcessLike } | null)?.process;
    if (child === undefined || child === null || typeof child.once !== "function") {
      return;
    }
    // publish 时 pid 尚未就绪（Electron Node 24 实测 undefined），一律等 spawn 事件。
    child.once("spawn", () => {
      const pid = child.pid;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
        return;
      }
      ledger.recordSpawn(pid, child);
      ledger.verifyFirstSpawn(pid);
    });
  };

  function buildController(): ProcessContainmentController {
    return {
      get outcome() {
        return outcome;
      },
      getLedger() {
        return ledger.entries();
      },
      listLivePids() {
        return ledger.livePids();
      },
      sweepOrphanedChildProcesses(reason) {
        const pids: number[] = [];
        const skippedToolPids: number[] = [];
        for (const entry of ledger.liveEntries()) {
          if (CONTAINMENT_TOOL_BASENAMES.has(commandBasename(entry.command))) {
            skippedToolPids.push(entry.pid);
            continue;
          }
          pids.push(entry.pid);
          try {
            // 模块 win32 门控（R14），sweep 一律走树杀；exit 钩子才是 SIGKILL 直杀。
            runTreeKill(entry.pid);
          } catch (error) {
            deps.logger.warn(`[process-containment] sweep kill failed for pid=${entry.pid}`, {
              event: "process_containment_sweep_kill_failed",
              outcome: "kill_error",
              pid: entry.pid,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        deps.logger.info(
          `[process-containment] sweep (${reason}): killed=${pids.length} skippedTool=${skippedToolPids.length}`,
          {
            event: "process_containment_sweep",
            outcome: pids.length > 0 ? "killed" : "none_live",
            reason,
            pids,
            skipped_tool_pids: skippedToolPids,
          },
        );
        return { reason, pids, skippedToolPids };
      },
      installExitHook() {
        const listener = (): void => {
          // 崩溃/退出路径的同步兜底：SIGKILL 直接子进程（无树语义，树级连坐属于
          // native Job Object 条件触发项）。logger 为同步落盘实现，exit 钩子内可用。
          const pids: number[] = [];
          for (const entry of ledger.liveEntries()) {
            if (CONTAINMENT_TOOL_BASENAMES.has(commandBasename(entry.command))) {
              continue;
            }
            pids.push(entry.pid);
            try {
              kill(entry.pid, "SIGKILL");
            } catch {
              // 进程可能已退出/pid 已回收，exit 钩子里不追错。
            }
          }
          if (pids.length > 0) {
            deps.logger.info("[process-containment] exit hook killed live children", {
              event: "process_containment_exit_sweep",
              outcome: "killed",
              pids,
            });
          }
        };
        const register = deps.registerExitListener ?? ((fn: () => void) => process.on("exit", fn));
        register(listener);
      },
      dispose() {
        if (subscribed) {
          try {
            channel.unsubscribe("child_process", channelListener);
          } catch {
            // 退订失败不阻断关停。
          }
          subscribed = false;
        }
      },
    };
  }

  const channel = deps.channel ?? nodeDiagnosticsChannel;
  const skipReason: ProcessContainmentOutcome | null =
    platform !== "win32" ? "not_windows" : deps.enabled === false ? "disabled" : null;
  if (skipReason !== null) {
    outcome = skipReason;
    deps.logger.info(`[process-containment] skipped (${skipReason})`, {
      event: "process_containment_installed",
      outcome: skipReason,
    });
    return buildController();
  }

  // job 形态（条件触发项）：有 native 能力注入才走；join 失败仍装台账辅助 sweep。
  if (deps.jobObject) {
    try {
      deps.jobObject.join();
      outcome = "joined";
    } catch (error) {
      outcome = "failed";
      deps.logger.error("[process-containment] job object join failed", {
        event: "process_containment_installed",
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (deps.requireJobObject) {
    outcome = "no_capability";
    deps.logger.warn(
      "[process-containment] native job object requested but no FFI capability is registered; falling back to spawn ledger (see spec conditional item)",
      { event: "process_containment_installed", outcome: "no_capability" },
    );
  } else {
    outcome = "tracked";
  }

  try {
    channel.subscribe("child_process", channelListener);
    subscribed = true;
  } catch (error) {
    outcome = "failed";
    deps.logger.error("[process-containment] child_process channel subscribe failed", {
      event: "process_containment_installed",
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (outcome !== "failed") {
    deps.logger.info(`[process-containment] installed (${outcome})`, {
      event: "process_containment_installed",
      outcome,
      ledger_subscribed: subscribed,
    });
  }
  return buildController();
}
