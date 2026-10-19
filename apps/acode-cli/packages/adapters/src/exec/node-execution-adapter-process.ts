import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { applyBashSourcesToExecutionRequest } from "./bash-startup-script.js";
import { createBashResourceTelemetry } from "./bash-resource-telemetry.js";
import { createCwdCapturePlan } from "./cwd-capture.js";
import {
  cancellationGraceMs,
  startCancellationWave,
  type CancellationCause,
} from "./cancellation-wave.js";
import { createBoundedOutputPump } from "./output-pump.js";
import {
  applyResolvedShellCommand,
  buildExecutionEnv,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "./execution-command.js";
import { NodeExecutionAdapterResults } from "./node-execution-adapter-results.js";
import { createExecutionOutputStreamDecoder } from "./outputEncoding.js";
import type { OutputCollector } from "./output-collector.js";
import { signalPosixProcessTree, terminateGenericPosixProcessGroup } from "./process-tree.js";
import {
  revalidateShellInitSnapshotForExecution,
  supportsShellInitSnapshot,
} from "./shell-init-snapshot.js";
import {
  IO_DRAIN_TIMEOUT_MS,
  resolveDefaultOutputRootDir,
  sanitizePathSegment,
  waitForPromise,
} from "./execution-utils.js";
import type {
  ExitState,
  InternalExecutionRunOptions,
  PreparedChildSpawn,
} from "./execution-adapter-types.js";
import type { ExecutionRequest, ExecutionRunOptions } from "@acode/contracts";

export class NodeExecutionAdapterProcess extends NodeExecutionAdapterResults {
  protected trackBashResources(
    child: ChildProcess,
    isBash: boolean,
    stopState: () => { timedOut: boolean; killed: boolean },
  ): (state: ExitState) => void {
    if (!isBash || !this.options.onToolExecResource) return () => {};
    const telemetry = createBashResourceTelemetry({
      platform: this.platform,
      processGroupId: child.pid,
      onComplete: this.options.onToolExecResource,
    });
    return (state) => {
      const stop = stopState();
      telemetry.finish(
        stop.timedOut
          ? "timeout"
          : stop.killed || state.signal
            ? "killed"
            : state.error
              ? "error"
              : "completed",
      );
    };
  }

  protected async prepareChildSpawn(request: ExecutionRequest): Promise<PreparedChildSpawn> {
    // 会话 worktree 写围栏缝（specs/session-worktree-lifecycle.md R7-5）：provider 在场
    // 即已接线——按本次执行的 cwd 取边界 env；缺席键由 buildExecutionEnv 从继承 env
    // 删除。provider 未注入（bootstrap 未接线）时 undefined = 零行为变化。
    const sessionWorktreeEnv = this.options.sessionWorktreeEnv
      ? (this.options.sessionWorktreeEnv(request.cwd) ?? {})
      : undefined;
    const env = buildExecutionEnv(request.env, {
      network: this.options.network,
      platform: this.platform,
      processEnv: this.processEnv,
      ...(sessionWorktreeEnv === undefined ? {} : { sessionWorktree: sessionWorktreeEnv }),
    });
    const resolvedCommand = resolveExecutionCommand(request.command, {
      cwd: request.cwd,
      env,
      platform: this.platform,
    });
    const rootDir =
      this.options.outputRootDir ?? resolveDefaultOutputRootDir(this.options.processEnv);
    const sessionId = sanitizePathSegment(String(request.trace?.sessionId ?? "unknown-session"));
    const snapshotEnv = resolvedCommand.envOverlay
      ? { ...env, ...resolvedCommand.envOverlay }
      : env;
    const shellInitSnapshot =
      request.command.mode === "shell" &&
      request.command.shellProfile === "posix-bash" &&
      resolvedCommand.shell === false &&
      supportsShellInitSnapshot(resolvedCommand.cwdDialect)
        ? await revalidateShellInitSnapshotForExecution(
            await this.shellInitSnapshots.getOrCreate({
              env: snapshotEnv,
              rootDir,
              shellDialect: resolvedCommand.cwdDialect,
              shellPath: resolvedCommand.file,
            }),
          )
        : undefined;
    const useLoginShell = shellInitSnapshot ? false : true;
    const resolvedShell = setResolvedShellLoginMode(resolvedCommand, useLoginShell);
    const requestWithSources = applyBashSourcesToExecutionRequest(request, {
      leadingSources: shellInitSnapshot
        ? [
            {
              optional: true,
              path: shellInitSnapshot.path,
              shellPath: shellInitSnapshot.shellPath,
            },
          ]
        : [],
      rootDir,
      sessionId,
      shellDialect: resolvedCommand.cwdDialect,
    });
    const capturePlan = createCwdCapturePlan(requestWithSources, {
      dialect: resolvedCommand.cwdDialect,
      platform: this.platform,
    });
    const command =
      capturePlan.command === requestWithSources.command
        ? requestWithSources.command.mode === "shell"
          ? applyResolvedShellCommand(resolvedShell, requestWithSources.command.command)
          : resolvedShell
        : resolveExecutionCommand(capturePlan.command, {
            cwd: request.cwd,
            env,
            platform: this.platform,
            resolvedShell,
          });
    const spawnEnv = command.envOverlay ? { ...env, ...command.envOverlay } : env;
    const baseOptions = {
      cwd: request.cwd,
      detached: this.platform !== "win32",
      env: spawnEnv,
      shell: command.shell,
      stdio: [
        request.stdin === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
      ] satisfies StdioOptions,
      windowsHide: true,
    };

    return {
      command,
      cwdDialect: command.cwdDialect,
      cwdFilePath: capturePlan.cwdFilePath,
      spawnOptions: baseOptions,
    };
  }

  protected terminateProcessTree(
    child: ChildProcess,
    useBashProcessTreeStop: boolean,
    cause: CancellationCause = "user",
  ): void {
    if (!child.pid) {
      child.kill("SIGTERM");
      return;
    }

    if (this.platform === "win32") {
      // specs/fs-hotpath-mechanisms.md R4：TERM→KILL 波次替代一次性 taskkill /T /F。
      // wave1 = taskkill /T（无 /F）优雅尝试 → Windows 5s 宽限 → wave2 = taskkill /T /F。
      const rootPid = child.pid;
      let forceKiller: ChildProcess | undefined;
      const wave = startCancellationWave(
        {
          gracefulStop: async () => {
            await runWindowsTaskKill(rootPid, false);
          },
          forceStop: async () => {
            forceKiller = await runWindowsTaskKill(rootPid, true);
          },
        },
        { cause, graceMs: cancellationGraceMs(this.platform) },
      );
      if (useBashProcessTreeStop) {
        // 直写后不再等待 pipe EOF，shutdown 必须显式等待 wave2 收尾，避免提前释放资源。
        const completion = wave.completion;
        this.pendingBashProcessTreeKills.set(completion, { ref: () => forceKiller?.ref() });
        void completion.finally(() => this.pendingBashProcessTreeKills.delete(completion));
      }
      return;
    }

    if (!useBashProcessTreeStop) {
      // PPID 后代枚举只修复 Bash job-control 的跨 PGID 清理；通用 hook、
      // shell 和 argv execution 必须保留既有进程组边界，避免修复能力扩散到其它调用方。
      terminateGenericPosixProcessGroup(child);
      return;
    }

    // specs/fs-hotpath-mechanisms.md R4：POSIX bash 取消 = SIGTERM 组+树 → 2s 宽限
    // → SIGKILL 组+树（宽限从 1.5s 对齐 omp 到 2s）。两波各自快照当时的 PPID 后代，
    // 不跨阶段记忆进程身份。
    const rootPid = child.pid;
    let graceTimer: NodeJS.Timeout | undefined;
    const wave = startCancellationWave(
      {
        gracefulStop: () => signalPosixProcessTree(rootPid, "SIGTERM"),
        forceStop: async () => {
          try {
            process.kill(-rootPid, "SIGKILL");
          } catch {
            // 直接的 force group kill 只做 best effort，随后仍会执行完整杀树。
          }
          await signalPosixProcessTree(rootPid, "SIGKILL");
        },
        scheduleTimer: (callback, ms) => {
          const timer = setTimeout(callback, ms);
          timer.unref?.();
          graceTimer = timer;
          return { cancel: () => clearTimeout(timer) };
        },
      },
      { cause, graceMs: cancellationGraceMs(this.platform) },
    );
    // shutdown 等待实际查表与信号发送，不能在异步杀树刚启动时就释放清理所有权。
    const completion = wave.completion;
    this.pendingBashProcessTreeKills.set(completion, { ref: () => graceTimer?.ref?.() });
    void completion.finally(() => this.pendingBashProcessTreeKills.delete(completion));
  }

  protected destroyChildOutputStreams(child: ChildProcess): void {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  protected attachPipedOutput(
    child: ChildProcess,
    stdout: OutputCollector,
    stderr: OutputCollector,
    encoding: string | null,
    options: ExecutionRunOptions,
  ): void {
    const decoder = createExecutionOutputStreamDecoder(encoding);
    // specs/fs-hotpath-mechanisms.md R4：64-chunk 有界队列背压 + coalesce，微任务
    // 批量派发（事件形状不变）。core 侧只消费 progress 事件，原始 chunk 事件合并安全。
    const pump = createBoundedOutputPump({
      decode: (buffer) => decoder.write(buffer),
      flush: (items) => {
        for (const item of items) {
          this.emit(options, {
            type: item.stream,
            chunk: item.buffer,
            text: item.text,
            timestamp: new Date(),
          });
        }
      },
    });
    for (const [name, collector] of [
      ["stdout", stdout],
      ["stderr", stderr],
    ] as const) {
      const stream = child[name];
      stream?.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        collector.append(buffer, stream);
        pump.append(name, buffer);
      });
      // drain/destroy 后同步冲刷队列，避免结果结算后还有迟到事件。
      stream?.once("close", () => pump.flushSync());
    }
  }

  protected writeChildInput(
    child: ChildProcess,
    input: ExecutionRequest["stdin"],
  ): () => Error | undefined {
    let failure: Error | undefined;
    if (input !== undefined && child.stdin) {
      const capture = (error: Error) => {
        failure ??= error;
      };
      // Hook 可以提前关闭 stdin，异步 EPIPE 必须有监听，不能让 Agent 崩溃。
      child.stdin.on("error", capture);
      try {
        child.stdin.end(input);
      } catch (error) {
        capture(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return () => failure;
  }

  protected async drainChildOutput(
    child: ChildProcess,
    closed: Promise<void>,
    options: InternalExecutionRunOptions,
    terminationRequested: boolean,
  ): Promise<void> {
    if (await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS)) return;
    // 通用 argv/Hook 保留 pipe EOF 所有权；Bash 直写文件不会进入此路径。
    if (options.shouldRetainExecutionAfterRootExit?.() === true) {
      await closed;
      return;
    }
    if (!terminationRequested) this.terminateProcessTree(child, false);
    if (!(await waitForPromise(closed, IO_DRAIN_TIMEOUT_MS))) this.destroyChildOutputStreams(child);
  }
}

/** Windows taskkill 波次执行：force=false 优雅（无 /F），force=true 强制（/T /F）。 */
function runWindowsTaskKill(pid: number, force: boolean): Promise<ChildProcess> {
  const args = force ? ["/pid", String(pid), "/T", "/F"] : ["/pid", String(pid), "/T"];
  const killer = spawn("taskkill", args, {
    stdio: "ignore",
    windowsHide: true,
  });
  return new Promise<ChildProcess>((resolve) => {
    // wave1 对已退出/无窗口进程失败属常态；失败不升级（wave2 才强制）。
    killer.once("error", () => resolve(killer));
    killer.once("close", () => resolve(killer));
  });
}
