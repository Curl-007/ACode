// 2026-12-31 例外债务偿还（onboard-server-cli-over-limit）：自 ../cli.ts 拆出。
// 职责：serve 子命令编排（daemon service 注册 / fallback fork、前台 Supervisor
// 运行）与 persisted status / Supervisor ready 等待循环。
// 迁移依据：import.meta.url 派生的 CLI 入口解析（fork 自身、stable launcher entry、
// ./server-core.js 相对定位）改为由 ../cli.ts 以 cliEntryUrl 显式传入，保证叶子
// 移动后取值与拆前逐点一致。
import { fork } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ACODE_VERSION } from "@acode/shared";
import { serverStatusSchema, type ServerStatus } from "../contracts.js";
import { requestControl } from "../ipc/controlClient.js";
import { resolveServerLayout } from "../runtime/paths.js";
import { createReleaseAgentWiring } from "../runtime/agentWiring.js";
import { writeStableLauncher } from "../runtime/stableLauncher.js";
import { readPersistedStatus, readPersistedStatusDetailed } from "../runtime/statusSnapshot.js";
import { waitForServerStopped } from "../runtime/shutdownWait.js";
import {
  hasLegacyServiceRegistration,
  unregisterLegacyServiceForRoot,
} from "../runtime/serviceInstallation.js";
import {
  daemonStartupMode,
  isRegisteredServiceEntry,
  SERVER_SERVICE_ARGS,
  shouldRegisterService,
} from "./serviceRegistration.js";
import { stdout, type CliIO, type ServerCliRuntimeOptions } from "./io.js";

export async function runServe(
  args: readonly string[],
  io: CliIO,
  json: boolean,
  layout: ReturnType<typeof resolveServerLayout>,
  runtimeOptions: ServerCliRuntimeOptions,
  cliEntryUrl: string,
): Promise<number> {
  const daemonRequested = args.includes("--daemon");
  const supervisorProcess = args.includes("--supervisor");
  if (shouldRegisterService(daemonRequested, supervisorProcess)) {
    const startupMode = daemonStartupMode();
    const legacyIdentityMigration =
      startupMode === "service" && (await hasLegacyServiceRegistration(layout));
    const existing = await readControlStatus(layout, 500);
    if (existing && (existing.state === "ready" || existing.state === "starting")) {
      if ((existing.serviceRegistered && !legacyIdentityMigration) || startupMode === "fallback") {
        if (json) stdout(io, existing);
        else
          stdout(
            io,
            `ACode Server ${existing.state} at ${existing.host ?? ""}:${existing.port ?? ""}`,
          );
        return 0;
      }
      if (existing.runningTaskCount > 0) {
        throw new Error(
          `Cannot replace fallback daemon while ${existing.runningTaskCount} task(s) are running; stop the server first`,
        );
      }
      // 旧 fallback 会持有 data-root lock，直接注册并启动 OS service 只能
      // 拉起一个立即锁冲突的 Supervisor。空闲时先收口 fallback，再重试真实注册。
      const persistedBeforeStop = await readPersistedStatusDetailed(layout);
      if (persistedBeforeStop.state === "invalid" || persistedBeforeStop.state === "unreadable") {
        throw new Error("Cannot verify fallback Server status before migration");
      }
      const stopBaselineUpdatedAt = persistedBeforeStop.status?.updatedAt ?? 0;
      await requestControl(layout.controlEndpoint, { command: "stop" });
      await waitForServerStopped(layout, stopBaselineUpdatedAt, true);
    }
    const baselineUpdatedAt = (await readPersistedStatus(layout))?.updatedAt ?? 0;
    let serviceStarted = false;
    let childEarlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    if (startupMode === "service") {
      const { createDaemonServiceDescriptor, registerService, serviceDescriptorPath } =
        await import("../platform/serviceManager.js");
      const platform =
        process.platform === "darwin" || process.platform === "linux" ? process.platform : "win32";
      await writeStableLauncher(layout, platform, {
        command: process.execPath,
        entry: process.argv[1] ?? fileURLToPath(cliEntryUrl),
      });
      const descriptor = createDaemonServiceDescriptor({ platform, layout });
      await mkdir(layout.serviceDir, { recursive: true, mode: 0o700 });
      const descriptorPath = serviceDescriptorPath(layout, descriptor);
      await writeFile(descriptorPath, descriptor.content, "utf8");
      await unregisterLegacyServiceForRoot(layout);
      // 注册失败必须向调用方返回真实错误；只有显式 opt-out 才允许 detached fallback。
      await registerService(descriptor, descriptorPath);
      serviceStarted = true;
    }
    if (!serviceStarted) {
      const child = fork(
        fileURLToPath(cliEntryUrl),
        [...SERVER_SERVICE_ARGS, "--server-root", layout.serverRoot],
        {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            ACODE_DATA_BASE_DIR: layout.dataBaseDir,
            ACODE_SERVER_ROOT: layout.serverRoot,
          },
        },
      );
      child.unref();
      // Supervisor 是独立 daemon，不需要保留 CLI↔Supervisor 的 IPC 通道；关闭该通道
      // 才能让一次性的 `serve --daemon` CLI 在返回 ready 后真正退出。
      child.disconnect();
      // 子 Supervisor 以 detached + stdio ignore 启动，锁冲突等启动失败时静默退出；
      // 记录早退信息让等待循环立即报告真实原因。
      child.once("exit", (code, signal) => {
        childEarlyExit = { code, signal };
      });
    }
    const started = await waitForPersistedStatus(
      layout,
      "ready",
      baselineUpdatedAt,
      () => {
        if (childEarlyExit) {
          throw new Error(
            `ACode Server daemon exited before ready (code=${childEarlyExit.code ?? "null"} signal=${childEarlyExit.signal ?? "none"}); check ${layout.statusFile} for details`,
          );
        }
      },
      serviceStarted,
    );
    if (json) stdout(io, started);
    else stdout(io, `ACode Server ${started.state} at ${started.host ?? ""}:${started.port ?? ""}`);
    process.stdin.pause();
    process.stdin.destroy();
    return 0;
  }
  const daemon = supervisorProcess;
  const { Supervisor } = await import("../supervisor/supervisor.js");
  const serviceRegistered = supervisorProcess && isRegisteredServiceEntry(args);
  let foregroundStopped: (() => void) | undefined;
  const supervisor = new Supervisor({
    layout,
    launcher: {
      launch: (generation, release) => {
        const runtimeRoot = release?.releaseDir ? join(release.releaseDir, "runtime") : null;
        const corePath = runtimeRoot
          ? join(runtimeRoot, "server-core.js")
          : fileURLToPath(new URL("./server-core.js", cliEntryUrl));
        const runtimeNode = runtimeRoot
          ? join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node")
          : process.execPath;
        const inheritedEnv = {
          ...process.env,
          ACODE_DATA_BASE_DIR: layout.dataBaseDir,
          ACODE_SERVER_ROOT: layout.serverRoot,
        };
        const releaseWiring = runtimeRoot
          ? createReleaseAgentWiring(runtimeRoot, runtimeNode, inheritedEnv)
          : runtimeOptions.bundledAgentWiring;
        return fork(corePath, [String(generation)], {
          execPath: runtimeNode,
          env: {
            ...inheritedEnv,
            ...releaseWiring,
            ...(runtimeRoot ? { ACODE_SERVER_RUNTIME_ROOT: runtimeRoot } : {}),
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
      },
    },
    version: ACODE_VERSION,
    serviceRegistered,
    onStopped: () => {
      process.stdin.pause();
      foregroundStopped?.();
      if (supervisorProcess) process.disconnect?.();
    },
  });
  await supervisor.start();
  let status: ServerStatus;
  try {
    status = await waitForSupervisorReady(supervisor);
  } catch (error) {
    // Core 进入 crash-loop 时不能把错误直接抛给 CLI 顶层返回：control
    // socket 仍持有事件循环导致前台进程假死；用户 Ctrl+C（此时信号 handler 尚未注册，
    // 走默认强杀）后锁文件与 socket 残留，后续 serve 永远报 "already running"。
    // 启动失败必须先停 Supervisor 收口锁与 socket，再上抛错误。
    await supervisor.stop("startup-failed").catch(() => undefined);
    throw error;
  }
  if (json) stdout(io, status);
  else stdout(io, `ACode Server ${status.state} at ${status.host ?? ""}:${status.port ?? ""}`);
  await new Promise<void>((resolve) => {
    foregroundStopped = resolve;
    if (!daemon) {
      const finish = () => {
        void supervisor.stop("signal").then(() => resolve());
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    }
  });
  return 0;
}

async function waitForPersistedStatus(
  layout: ReturnType<typeof resolveServerLayout>,
  expectedState: "ready" | "stopped",
  minUpdatedAt = 0,
  assertStillWaiting?: () => void,
  expectedServiceRegistered?: boolean,
): Promise<ServerStatus> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await readPersistedStatus(layout);
    if (
      status?.state === expectedState &&
      status.updatedAt > minUpdatedAt &&
      (expectedServiceRegistered === undefined ||
        status.serviceRegistered === expectedServiceRegistered)
    )
      return status;
    assertStillWaiting?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Server ${expectedState}`);
}

async function waitForSupervisorReady(supervisor: {
  status: () => ServerStatus;
}): Promise<ServerStatus> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = supervisor.status();
    if (status.state === "ready") return status;
    if (status.state === "crash-loop-stopped")
      throw new Error("Server Core entered crash-loop-stopped");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for Server Core ready");
}

async function readControlStatus(
  layout: ReturnType<typeof resolveServerLayout>,
  timeoutMs: number,
): Promise<ServerStatus | null> {
  try {
    const result = await requestControl(layout.controlEndpoint, { command: "status" }, timeoutMs);
    return serverStatusSchema.parse(result);
  } catch {
    return null;
  }
}
