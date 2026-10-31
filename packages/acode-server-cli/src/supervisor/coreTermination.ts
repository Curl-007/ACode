// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ./supervisor.ts 拆出。
// 职责：stopCore 的 Core 进程终态等待原语——先 IPC shutdown，宽限期后 SIGKILL，
// 只有 exit/close 能证明进程已收口；强杀后仍无终态必须失败。状态与锁的收尾
// 仍由 Supervisor.stopCore 包装方法负责（逐字保留）。
import { type ChildProcess } from "node:child_process";
import { createServiceLogger } from "@acode/services/node";

// 与 supervisor.ts 同一 scope：生命周期事件按运维排障判据用 info/warn/error。
const log = createServiceLogger("server-supervisor");

export async function waitForCoreTermination(
  core: ChildProcess,
  options: { graceTimeoutMs: number; killTimeoutMs: number },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // 发出 SIGKILL 后不能最多等两秒便无条件返回：未观察到子进程终态
    // 也会释放 data-root lock，随后可启动第二个 Core。只有 exit/close 能证明进程
    // 已收口；强杀后仍无终态必须失败并保留 Core 引用和锁。
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);
      core.off("exit", finish);
      core.off("close", finish);
      core.off("error", handleError);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Server Core pid ${core.pid ?? "unknown"} did not terminate after SIGKILL`));
    };
    const handleError = (error: Error): void => {
      log.warn(
        undefined,
        "server core emitted an error while stopping; awaiting exit or close",
        error,
      );
    };
    const forceKill = (): void => {
      log.warn(undefined, "server core did not exit within grace period, sending SIGKILL", {
        pid: core.pid,
      });
      core.kill("SIGKILL");
      if (!settled) killTimer = setTimeout(fail, options.killTimeoutMs);
    };
    const graceTimer = setTimeout(() => {
      forceKill();
    }, options.graceTimeoutMs);
    core.once("exit", finish);
    core.once("close", finish);
    core.once("error", handleError);
    try {
      core.send({ command: "shutdown" });
    } catch {
      // IPC 已关闭不代表 OS 进程已退出，直接强杀后仍等待 exit/close 终态。
      clearTimeout(graceTimer);
      forceKill();
    }
  });
}
