import { execFile } from "node:child_process";
import type { WSLDistro } from "@acode/shared";
import { resolveWslCommand, WSL_EXEC_MAX_BUFFER } from "@acode/server/remote/wslBackendSupport.js";
export type { WSLDistro } from "@acode/shared";

// WSL_COMMAND 与 WSL_EXEC_MAX_BUFFER 此前在本文件另有一份副本，与 wslBackendSupport.ts 并存
// ——同一个「用哪个 wsl.exe」的事实有两处写入路径，加固时只会改到其中一处。现统一从
// wslBackendSupport.ts 取，并改用 resolveWslCommand() 拿到绝对路径（裸名会让 CreateProcess
// 把 cwd 排在 System32 之前，见该处注释与 specs/remote-deploy-hardening.md R4）。
// decodeWslOutput 的同名重复属既有问题、与本次加固无关，登记在 tech-debt-backlog 未顺手重构。

export const WSL_DISCOVERY_CACHE_TTL_MS = 5_000;

function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }

  // `wsl.exe -l -v` 在 Windows 上常返回 UTF-16LE。
  // 如果这里直接按 UTF-8 解码，行内会夹满 `\0`，distro 解析会全部失效。
  // 通过检测 NUL 字节优先走 UTF-16LE，可以同时兼容 UTF-8/UTF-16LE 两种输出。
  if (buffer.includes(0)) {
    return buffer.toString("utf16le");
  }

  return buffer.toString("utf8");
}

function normalizeWslOutput(raw: string): string {
  return raw
    .replaceAll("\u0000", "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "");
}

export function parseWSLDistroList(rawOutput: string): WSLDistro[] {
  const lines = normalizeWslOutput(rawOutput)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  const distros: WSLDistro[] = [];
  for (const line of lines) {
    const parts = line
      .trim()
      .split(/\s{2,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 3) {
      continue;
    }

    const versionToken = parts.at(-1) ?? "";
    const parsedVersion = Number.parseInt(versionToken, 10);
    if (!Number.isFinite(parsedVersion)) {
      continue;
    }

    const state = parts.at(-2) ?? "";
    const nameToken = parts.slice(0, -2).join(" ").trim();
    const isDefault = nameToken.startsWith("*");
    const name = nameToken.replace(/^\*\s*/, "").trim();
    if (!name) {
      continue;
    }

    distros.push({
      name,
      isDefault,
      state,
      version: parsedVersion === 1 || parsedVersion === 2 ? parsedVersion : null,
    });
  }

  return distros;
}

async function execWslForBuffer(args: string[]): Promise<Buffer> {
  // 绝对路径后再 execFile，理由同 wslBackendProcess.ts 的两处 spawn。
  const wslCommand = await resolveWslCommand();
  return new Promise((resolve, reject) => {
    execFile(
      wslCommand,
      args,
      {
        encoding: "buffer",
        maxBuffer: WSL_EXEC_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        const stderrBuffer = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");

        if (error) {
          const stderrText = normalizeWslOutput(decodeWslOutput(stderrBuffer)).trim();
          reject(new Error(stderrText || error.message));
          return;
        }

        resolve(stdoutBuffer);
      },
    );
  });
}

export type WSLBufferExecutor = (args: string[]) => Promise<Buffer>;

interface WSLDiscoveryCacheEntry<T> {
  expiresAt: number;
  promise: Promise<T>;
}

let availabilityCache = new WeakMap<WSLBufferExecutor, WSLDiscoveryCacheEntry<boolean>>();
let distroListCache = new WeakMap<WSLBufferExecutor, WSLDiscoveryCacheEntry<WSLDistro[]>>();

function getCachedDiscovery<T>(
  cache: WeakMap<WSLBufferExecutor, WSLDiscoveryCacheEntry<T>>,
  executor: WSLBufferExecutor,
  load: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(executor);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const entry: WSLDiscoveryCacheEntry<T> = {
    expiresAt: Date.now() + WSL_DISCOVERY_CACHE_TTL_MS,
    promise: Promise.resolve().then(load),
  };
  cache.set(executor, entry);
  void entry.promise.catch(() => {
    // 临时 WSL CLI 错误不能把 rejected Promise 固化到 TTL 结束，
    // 后续显式重试需要立刻重新执行探测。
    if (cache.get(executor) === entry) {
      cache.delete(executor);
    }
  });
  return entry.promise;
}

export function invalidateWSLDiscoveryCache(executor?: WSLBufferExecutor): void {
  if (executor) {
    availabilityCache.delete(executor);
    distroListCache.delete(executor);
    return;
  }
  availabilityCache = new WeakMap();
  distroListCache = new WeakMap();
}

export async function isWSLAvailable(
  executor: WSLBufferExecutor = execWslForBuffer,
): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }

  return getCachedDiscovery(availabilityCache, executor, async () => {
    try {
      await executor(["--status"]);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return !/not recognized|enoent/i.test(message);
    }
  });
}

export async function listWSLDistros(
  executor: WSLBufferExecutor = execWslForBuffer,
): Promise<WSLDistro[]> {
  if (process.platform !== "win32") {
    return [];
  }

  return getCachedDiscovery(distroListCache, executor, async () => {
    const output = await executor(["-l", "-v", "--all"]);
    return parseWSLDistroList(decodeWslOutput(output));
  });
}
