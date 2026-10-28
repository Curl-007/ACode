// 拆分依据：wsl-backend.ts 超 400 行架构上限。wsl.exe 子进程的 spawn/execFile 包装与「已证明归属」
// 子进程的登记/关闭/kill 生命周期是独立的过程管理逻辑，与 WSLBackend 的探测/路径解析/上传编排无关，
// 独立成叶子后 dispose 语义仍可单独审查。
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { StdioStream } from "@acode/server/remote/backend.js";
import { createCloseEventController } from "@acode/server/remote/closeEvent.js";
import { buildWslArgs, WSL_COMMAND, WSL_EXEC_MAX_BUFFER, decodeWslOutput, normalizeWslOutput } from "@acode/server/remote/wslBackendSupport.js";

export interface WslOwnedChildState {
  closed: Promise<void>;
  resolveClosed: () => void;
}

export type WslOwnedChildren = Map<ChildProcess, WslOwnedChildState>;

export function spawnWslExec(params: {
  command: string;
  distroName: string | null;
  userName: string | null;
  ownedChildren: WslOwnedChildren;
}): Promise<StdioStream> {
  const { command, distroName, userName, ownedChildren } = params;
  return new Promise((resolve, reject) => {
    const child = spawn(
      WSL_COMMAND,
      buildWslArgs(["bash", "-lc", command], distroName, userName),
      {
        stdio: "pipe",
        windowsHide: true,
      },
    );
    trackOwnedChild(child, ownedChildren);

    child.once("error", reject);
    child.once("spawn", () => {
      const stdin = child.stdin;
      const stdout = child.stdout;
      const stderr = child.stderr;
      if (!stdin || !stdout || !stderr) {
        reject(new Error("WSL process stdio is not available"));
        return;
      }

      const onClose = createCloseEventController();
      let fired = false;
      const fireOnce = (code: number) => {
        if (fired) {
          return;
        }
        fired = true;
        onClose.fire(code);
      };

      child.on("exit", (code) => {
        fireOnce(code ?? 0);
      });
      child.on("close", (code) => {
        fireOnce(code ?? 0);
      });

      resolve({
        stdin,
        stdout,
        stderr,
        onClose: onClose.event,
      });
    });
  });
}

export function execWslCommandToBuffer(
  args: string[],
  ownedChildren: WslOwnedChildren,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      WSL_COMMAND,
      args,
      {
        encoding: "buffer",
        maxBuffer: WSL_EXEC_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        const stderrBuffer = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
        const stderrText = normalizeWslOutput(decodeWslOutput(stderrBuffer)).trim();

        if (error) {
          reject(new Error(stderrText || error.message));
          return;
        }

        resolve(stdoutBuffer);
      },
    );
    trackOwnedChild(child, ownedChildren);
  });
}

export function trackOwnedChild(child: ChildProcess, ownedChildren: WslOwnedChildren): void {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const finish = () => {
    const state = ownedChildren.get(child);
    if (!state) {
      return;
    }
    ownedChildren.delete(child);
    state.resolveClosed();
  };
  ownedChildren.set(child, { closed, resolveClosed });
  child.once("error", finish);
  child.once("exit", finish);
  child.once("close", finish);
}

export function endOwnedChildInput(child: ChildProcess): void {
  if (!child.stdin || child.stdin.writableEnded) {
    return;
  }
  try {
    child.stdin.end();
  } catch {
    // stdin 已异常关闭时继续进入本 child 的 kill fallback。
  }
}

export async function waitForOwnedChildClose(
  closed: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return result;
}

export async function disposeWslOwnedChildren(
  ownedChildren: WslOwnedChildren,
  graceTimeoutMs: number,
  killWaitTimeoutMs: number,
): Promise<void> {
  const children = Array.from(ownedChildren.entries());
  // WSL 过去不记录自己 spawn 的 wsl.exe，Host 被强杀时只能寄希望于管道 EOF。
  // 先同步关闭本 backend 子进程 stdin；宽限期后也只 kill 这些已证明归属的 child，绝不 terminate distro。
  for (const [child] of children) {
    endOwnedChildInput(child);
  }
  await Promise.all(
    children.map(async ([child, state]) => {
      if (await waitForOwnedChildClose(state.closed, graceTimeoutMs)) {
        return;
      }
      if (ownedChildren.has(child)) {
        child.kill();
      }
      await waitForOwnedChildClose(state.closed, killWaitTimeoutMs);
    }),
  );
}
