import { spawn, type ChildProcess } from "node:child_process";

const BROWSER_OPEN_SETTLE_TIMEOUT_MS = 1_000;

export interface BrowserOpenResult {
  command: string;
  opened: boolean;
  reason?: string;
}

export interface BrowserOpenOptions {
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
}

export async function openUrlInBrowser(
  url: string,
  options: BrowserOpenOptions = {},
): Promise<BrowserOpenResult> {
  const platform = options.platform ?? process.platform;
  const command = browserOpenCommand(platform, url);
  const spawnProcess = options.spawnProcess ?? spawn;

  try {
    const child = spawnProcess(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    return await waitForBrowserSpawn(child, command.executable, options.timeoutMs);
  } catch (error) {
    return {
      command: command.executable,
      opened: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { args: string[]; executable: string } {
  if (platform === "darwin") {
    return { executable: "open", args: [url] };
  }

  if (platform === "win32") {
    // 修复依据（R2-01，命令注入；同 bootstrap/src/app/platform-open-port.ts 的 H1 模式，
    // 2026-10-04 已修一处，本文件是漏修的第二副本）：
    // 原写法 `cmd.exe /c start "" <url>` 中，cmd.exe 按 `"` 切换引号态——网络返回的
    // authorize_url 只要内嵌裸双引号即可逃逸引号态，其后 `&calc&` 作为新命令在 CLI 用户
    // 上下文执行。spawn 的参数数组只保证 argv 边界；当 executable 本身是 shell（cmd.exe）时，
    // 数组形态不构成防线（元字符由 shell 二次解释）。
    // 改用 explorer.exe 直传：非 shell，argv 经 CreateProcess 传递，无元字符解释层，内嵌
    // `"`/`&`/`^`/`%` 不被解释。`explorer.exe <url>` 用系统默认浏览器打开 URL。
    // 纵深防御另见 cli-oauth.ts parseInitData（校验层拒绝含裸双引号的 authorize_url）。
    return { executable: "explorer.exe", args: [url] };
  }

  return { executable: "xdg-open", args: [url] };
}

function waitForBrowserSpawn(
  child: ChildProcess,
  command: string,
  timeoutMs = BROWSER_OPEN_SETTLE_TIMEOUT_MS,
): Promise<BrowserOpenResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (result: BrowserOpenResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners("error");
      child.removeAllListeners("spawn");
      if (result.opened) {
        child.unref();
      }
      resolve(result);
    };
    timeout = setTimeout(() => {
      settle({ command, opened: true });
    }, timeoutMs);

    child.once("spawn", () => {
      settle({ command, opened: true });
    });
    child.once("error", (error) => {
      settle({
        command,
        opened: false,
        reason: error.message,
      });
    });
  });
}
