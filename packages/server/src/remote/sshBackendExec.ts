// 拆分依据：ssh-backend.ts 超 400 行架构上限。SSH exec channel 的创建（流式 stdio）与简单命令的
// stdout 收集、以及基于 exec 的远端环境探测（uname/ostype）是独立的命令执行层，与连接握手、
// 上传降级编排无关，独立成叶子。行为逐点等价（含 exit/close 双事件与短命令 data 晚发修复）。
import type { Client as SSHClient } from "ssh2";
import type { RemoteEnvironment, StdioStream } from "@acode/server/remote/backend.js";
import { createCloseEventController } from "@acode/server/remote/closeEvent.js";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@acode/server/remote/detectEnv.js";
import { buildPosixShellExecCommand } from "@acode/server/remote/posixShell.js";

export function execSshCommand(client: SSHClient, command: string): Promise<StdioStream> {
  return new Promise((resolve, reject) => {
    // SSH exec 会先交给远端用户的默认 shell；fish 会把部署脚本里的 `download=` 等 POSIX 语法当成错误。
    // 在 SSH 边界统一进入 /bin/sh，保证 remote deploy、preflight 和 server 启动脚本都按项目声明的 POSIX shell 语义执行。
    client.exec(buildPosixShellExecCommand(command), (err, channel) => {
      if (err) return reject(err);

      const onClose = createCloseEventController();
      let fired = false;
      const fireOnce = (code: number) => {
        if (fired) return;
        fired = true;
        // remote deploy 会执行大量短命令，成功退出的 code=0 日志没有排查价值且会刷屏。
        // 这里只保留失败退出码，正常流程由上层的阶段日志和进度日志表达。
        if (code !== 0) {
          console.warn(`[ssh] exec channel failed: code=${code}`);
        }
        onClose.fire(code ?? 0);
      };

      // ssh2 channels may fire 'exit' before 'close', or sometimes
      // only one of them. Listen to both to be safe.
      channel.on("exit", (code: number | null) => {
        fireOnce(code ?? 0);
      });
      channel.on("close", () => {
        fireOnce(0);
      });

      resolve({
        stdin: channel.stdin,
        stdout: channel,
        stderr: channel.stderr,
        onClose: onClose.event,
      });
    });
  });
}

export function execSshCommandSimple(client: SSHClient, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // execSimple 同样会执行 POSIX 片段（例如 `[ -r ... ]`、变量展开）。
    // 这里和 exec 保持同一层 shell 策略，避免 detect/exists/readFile 在 fish 默认 shell 下先于部署失败。
    client.exec(buildPosixShellExecCommand(command), (err, channel) => {
      if (err) return reject(err);
      let stdout = "";
      let stderr = "";
      let done = false;
      let exitCode: number | null = null;

      channel.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      channel.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const finish = (code: number) => {
        if (done) return;
        done = true;
        if (code !== 0) {
          reject(new Error(`Command failed (code ${code}): ${stderr || stdout}`));
        } else {
          resolve(stdout);
        }
      };

      // ssh2 在短命令场景下可能先发 exit，再异步派发 stdout data。
      // 不能在 exit 事件直接 finish：会把后续 data 丢掉，导致 platform/arch 偶发识别为空。
      // 这里改为只在 close 统一收尾，并优先使用 exit 记录的真实退出码，避免误判成功。
      channel.on("exit", (code: number | null) => {
        exitCode = code ?? 0;
      });
      channel.on("close", (code: number | null) => {
        const resolvedCode = exitCode ?? code ?? 0;
        finish(resolvedCode);
      });
    });
  });
}

export async function detectRemoteEnvironmentViaSsh(
  execSimple: (command: string) => Promise<string>,
): Promise<RemoteEnvironment> {
  const reportedPlatform = normalizeRemotePlatform(await execSimple("uname -s"));
  const arch = normalizeRemoteArch(await execSimple("uname -m"));
  const kernelOstype = await readKernelOstypeViaSsh(execSimple);
  const platform = resolveRemotePlatform(reportedPlatform, kernelOstype);

  if (platform !== reportedPlatform) {
    console.warn(
      `[ssh] detect: uname reported ${reportedPlatform}, but kernel ostype is ${kernelOstype}; fallback to ${platform}`,
    );
  }

  return { platform, arch };
}

export async function readKernelOstypeViaSsh(
  execSimple: (command: string) => Promise<string>,
): Promise<string> {
  try {
    return (
      await execSimple("if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; fi")
    ).trim();
  } catch {
    return "";
  }
}

export interface SshHomeDirResolver {
  resolve: () => Promise<string>;
  reset: () => void;
}

/** 远端 $HOME 只解析一次；断连后调用 reset 失效缓存（与原 homeDirPromise 语义逐点等价）。 */
export function createSshHomeDirResolver(
  execSimple: (command: string) => Promise<string>,
): SshHomeDirResolver {
  let homeDirPromise: Promise<string> | null = null;
  return {
    resolve: () => {
      if (homeDirPromise) {
        return homeDirPromise;
      }
      homeDirPromise = execSimple('printf %s "$HOME"').then((homeDir) => homeDir.trim());
      return homeDirPromise;
    },
    reset: () => {
      homeDirPromise = null;
    },
  };
}
