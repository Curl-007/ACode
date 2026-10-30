// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ../cli.ts 拆出。
// 职责：uninstall 子命令——二次确认、安装归属核验、confirm-uninstall 转发、
// OS service 注销与 server-root allowlist 清理（含 uninstalled marker 落盘）。
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ACODE_VERSION } from "@acode/shared";
import { resolveServerLayout, validateUninstallTarget } from "../runtime/paths.js";
import { validateServerInstallOwnership } from "../runtime/installationOwnership.js";
import { DataRootLock } from "../runtime/lock.js";
import {
  acquireUninstallLock,
  describeLockInspection,
  removeRunContentsExceptLock,
} from "../runtime/uninstallGuard.js";
import { readPersistedStatusDetailed } from "../runtime/statusSnapshot.js";
import { waitForServerStopped } from "../runtime/shutdownWait.js";
import { unregisterInstalledService } from "../runtime/serviceInstallation.js";
import { runControl } from "./control.js";
import { stdout, type CliIO } from "./io.js";

export async function runUninstall(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
): Promise<number> {
  const first = await (io.confirm?.("Type DELETE to uninstall ACode Server: ") ??
    Promise.resolve(""));
  if (first !== "DELETE") throw new Error("Uninstall cancelled");
  const second = await (io.confirm?.("Type DELETE again to confirm: ") ?? Promise.resolve(""));
  if (second !== "DELETE") throw new Error("Uninstall cancelled");
  // 不能把同一个 --server-root 同时作为 allowlist 根和删除目标：包含关系
  // 恒成立，任何绝对目录都能被卸载流程递归删除。停止服务前必须先验证安装归属。
  const ownership = await validateServerInstallOwnership(layout);
  try {
    await runControl("confirm-uninstall", io, json, { confirmation: "DELETE" }, layout);
  } catch (error: unknown) {
    const persisted = await readPersistedStatusDetailed(layout);
    if (persisted.status?.state === "stopped" || persisted.status?.state === "uninstalled")
      return await finishUninstall(io, json, layout, ownership);
    const lockInspection = await new DataRootLock(layout.lockFile).inspect();
    if (lockInspection.state === "active") {
      throw new Error(`Cannot uninstall while Server lock is held by pid ${lockInspection.pid}`, {
        cause: error,
      });
    }
    if (lockInspection.state === "invalid" || lockInspection.state === "unreadable") {
      throw new Error(
        `Cannot verify Server shutdown before uninstall (${describeLockInspection(lockInspection)})`,
        { cause: error },
      );
    }
  }
  await waitForServerStopped(layout);
  return await finishUninstall(io, json, layout, ownership);
}

async function finishUninstall(
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  ownership: Awaited<ReturnType<typeof validateServerInstallOwnership>>,
): Promise<number> {
  await unregisterInstalledService(layout);
  const uninstallLock = await acquireUninstallLock(layout);
  const uninstallEntries = [
    "releases",
    "run",
    "cache",
    "bin",
    "service",
    "current.json",
    "pending.json",
    "install.json",
    "uninstalled.json",
    "update-transaction.json",
  ] as const;
  try {
    for (const entry of uninstallEntries) {
      const target = validateUninstallTarget(
        ownership.canonicalServerRoot,
        join(ownership.canonicalServerRoot, entry),
      );
      if (!target.ok || !target.canonicalPath) {
        throw new Error(`Unsafe uninstall target: ${target.reason ?? "unknown"}`);
      }
      if (entry === "run") {
        await removeRunContentsExceptLock(layout);
      } else {
        await rm(target.canonicalPath, { recursive: true, force: true });
      }
    }
    const preservedPaths = (await readdir(ownership.canonicalServerRoot))
      .filter((entry) => entry !== "run")
      .sort();
    // server root 允许用户显式指定，不能递归删除未知内容。卸载只清理上面的
    // ACode allowlist，并把保留项写入结果供用户审计。先落盘 marker，再释放 lock，
    // 让并发 Supervisor 在删除 run 目录的最后窗口也会 fail-closed。
    await writeFile(
      layout.uninstalledFile,
      `${JSON.stringify({ uninstalled: true, uninstalledAt: Date.now(), version: ACODE_VERSION, preservedPaths }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await uninstallLock.release();
    await rm(layout.runDir, { recursive: true, force: true });
    if (json) stdout(io, { uninstalled: true, preservedPaths });
    else stdout(io, "uninstalled");
    return 0;
  } catch (error: unknown) {
    await uninstallLock.release().catch(() => undefined);
    throw error;
  }
}
