// ============================================================
// jcode 桥接：真子进程 spawn + 进程树终止（唯一触碰 child_process / process.env 的文件）
// spec: apps/acode-cli/specs/jcode-agent-bridge.md R1/R4/R6
//
// 根 AGENTS.md「外部 I/O 边界收敛」：spawn、env 读取、进程树终止、fs 探测全部收敛在
// 这里；acp-client.ts 只依赖本文件暴露的 JcodeChildHandle，其余模块连本文件都不 import。
//
// 跨平台（apps/acode-cli/AGENTS.md「与操作系统交互前需考虑 Win/mac/Linux」）：
// - spawn 用参数数组形式不经 shell（防注入，避开 Windows .cmd/.exe 与空格路径坑）。
// - detached 按平台分：POSIX 独立进程组（-pid 整组终止），Windows 不用 detached
//   （taskkill /T 走父子树）。对齐 node-execution-adapter-process.ts:136 的既有裁决。
// - 进程树终止自包含（TERM→宽限→KILL / taskkill /T→/T /F 波次），语义对齐
//   adapters 的取消波次，但不 import 其 module-private 原语（未从公开入口导出）。
//
// spike §4.4 实测：Windows 上 jcode acp 子进程的 server 是进程内起的，kill 子进程即
// 全退（0 残留、servers.json 空），故 Windows 终止 acp 子进程树即可。Unix 的 setsid
// 常驻 daemon 生命周期不在本次实测范围（spec「未做与取舍」）。
// ============================================================

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";
import type { Logger } from "@acode/contracts";

import { createStreamLineSink, createStreamLineSource } from "../acp/protocol.js";
import type { AcpTransport, JcodeChildHandle, SpawnJcodeOptions } from "./acp-client.js";
import { assertNotJcodeRepo, buildJcodeSpawnSpec } from "./acp-client.js";

/** 进程树终止的宽限（wave1 优雅 → wave2 强制）。对齐 cancellation-wave 的 Windows 5s / POSIX 2s。 */
const TERMINATION_GRACE_MS_WINDOWS = 5_000;
const TERMINATION_GRACE_MS_POSIX = 2_000;

/** selfdev-guard 的依赖注入点：生产用 node:fs，测试用内存假件。 */
function createNodeFsProbe(): Parameters<typeof assertNotJcodeRepo>[1] {
  return {
    exists: (path) => {
      try {
        accessSync(path);
        return true;
      } catch {
        return false;
      }
    },
    readTextOrNull: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    join: (dir, child) => nodePath.join(dir, child),
  };
}

/**
 * spawn jcode 子进程并返回句柄。
 *
 * 失败路径全部 throw（不返回 null）：self-dev 防护命中、stdio 不可用。
 * 调用方（entry.ts）捕获后按 spec R5 翻成 v4 ACK 的 failed + reasonCode，不悬挂。
 */
export async function spawnJcodeProcess(options: SpawnJcodeOptions): Promise<JcodeChildHandle> {
  const logger = options.logger;
  // R4-3：spawn 前的 self-dev 防护闸。命中即抛 JcodeSpawnRejectedError，绝不 spawn。
  assertNotJcodeRepo(options.cwd, createNodeFsProbe());

  const platform = process.platform;
  const spec = buildJcodeSpawnSpec(options, process.env as Record<string, string | undefined>);

  logger?.info("jcode bridge spawning agent", {
    cwd: options.cwd,
    // 不打印完整 env（可能含凭据）；只打印强制关闭的遥测开关状态供审计（R4-2）。
    telemetryOff: spec.env.JCODE_NO_TELEMETRY === "1" && spec.env.DO_NOT_TRACK === "1",
    args: spec.args.join(" "),
  });

  const child: ChildProcess = spawn(options.binaryPath, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    // POSIX：独立进程组，便于 -pid 整组终止；Windows：不用 detached（taskkill /T 走树）。
    detached: platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  // stderr 是 jcode 的诊断通道（ACP 纪律：stdout 只走协议帧）。转成日志，不当协议读。
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    const text = chunk.trimEnd();
    if (text.length > 0) logger?.debug("jcode stderr", { text: text.slice(0, 500) });
  });

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal: signal ?? null }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });

  // 传输层复用现有 NDJSON 帧循环（StringDecoder 多字节安全 + 行长治理），
  // 与 K8 acp-command 同一套 createStreamLineSource/Sink，不自造分帧。
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (!stdout || !stdin) {
    // stdio 配了 pipe 却没有流——理论上不可达；防御性失败，不返回半死句柄。
    child.kill("SIGKILL");
    throw new Error("jcode bridge: child stdio streams unavailable");
  }
  const source = createStreamLineSource(stdout);
  const sink = createStreamLineSink(stdin);
  const transport: AcpTransport = {
    writeLine: (line) => sink.writeLine(line),
    lines: () => source.lines(),
    close: () => {
      try {
        stdin.end();
      } catch {
        // stdin 已关时 end 抛；收尾路径不上抛。
      }
    },
  };

  let killStarted = false;
  const kill = (): void => {
    if (killStarted) return;
    killStarted = true;
    terminateJcodeTree(child, platform, logger);
  };

  return { transport, exited, kill };
}

/**
 * 进程树终止：wave1 优雅（POSIX SIGTERM 组 / Windows taskkill /T）→ 宽限 →
 * wave2 强制（POSIX SIGKILL 组 / Windows taskkill /T /F）。子进程在波次间自然退出
 * 即撤销 wave2。幂等（killStarted 闸在调用方）。
 */
function terminateJcodeTree(child: ChildProcess, platform: NodeJS.Platform, logger?: Logger): void {
  if (!child.pid) {
    child.kill("SIGTERM");
    return;
  }
  const rootPid = child.pid;
  const graceMs = platform === "win32" ? TERMINATION_GRACE_MS_WINDOWS : TERMINATION_GRACE_MS_POSIX;
  let settled = false;

  const onExit = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(forceTimer);
  };
  child.once("exit", onExit);

  // wave1：优雅终止。
  if (platform === "win32") {
    void runWindowsTaskKill(rootPid, false, logger);
  } else {
    signalPosixGroup(rootPid, "SIGTERM");
  }

  // wave2：宽限到期后强制（子进程已自然退出则 onExit 已清定时器）。
  const forceTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (platform === "win32") {
      void runWindowsTaskKill(rootPid, true, logger);
    } else {
      signalPosixGroup(rootPid, "SIGKILL");
    }
  }, graceMs);
  (forceTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
}

/** POSIX：向进程组发信号（detached spawn 使 child 成为组长，-pid 覆盖整组）。 */
function signalPosixGroup(rootPid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-rootPid, signal);
  } catch {
    // 组已空/无权限：退回单进程 kill，best effort。
    try {
      process.kill(rootPid, signal);
    } catch {
      // 已退出：忽略。
    }
  }
}

/**
 * Windows：taskkill 终止进程树。/T = 含子进程；force=true 加 /F 强制。
 * 用参数数组形式 spawn，不经 shell（防 pid 之外的注入面）。
 */
function runWindowsTaskKill(rootPid: number, force: boolean, logger?: Logger): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/pid", String(rootPid), "/t"];
    if (force) args.push("/f");
    let killer: ChildProcess;
    try {
      killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    } catch (error) {
      logger?.warn("jcode bridge taskkill spawn failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      resolve();
      return;
    }
    killer.once("exit", () => resolve());
    killer.once("error", () => resolve());
  });
}
