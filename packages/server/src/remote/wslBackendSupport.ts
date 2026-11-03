// 拆分依据：wsl-backend.ts 超 400 行架构上限。WSL 命令常量、输出解码/规范化、wsl.exe 参数构造、
// UNC 候选路径与文件级回退探测是纯支撑逻辑，与 WSLBackend 类的会话/上传/生命周期编排无关，
// 独立成叶子。quotePosixShellArg 复用 posixShell.ts 的共享实现（与原私有副本逐字节一致）。
import { constants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ResolvedWSLInfo {
  distroName: string | null;
  userName: string | null;
  version: 1 | 2 | null;
  homeDir: string;
}

export interface ResolvedWSLIdentity {
  distro: string;
  user: string;
}

/** wsl.exe 的裸名。**只应作为 `resolveWslCommand()` 的回退**，不要直接拿去 spawn。 */
export const WSL_COMMAND = "wsl.exe";
export const WSL_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

// Windows CreateProcess 解析裸名的搜索顺序是「调用方 exe 所在目录 → **当前目录** → System32 →
// 16 位系统目录 → Windows 目录 → PATH」——当前目录排在 System32 **之前**。于是在进程 cwd（或
// node.exe 所在目录）里放一个 wsl.exe 就会顶替真的那个，与 agent-teams-plugin 的 run_checks 已
// 明确排除的「工作目录二进制种植」同类（docs/security/mimosa-findings-triage-2026-11.md §6.1 ④）。
// 故一律先解析到 System32 的绝对路径；解析不出来才回退裸名，保持既有行为不因加固而变砖。
// 规则见 specs/remote-deploy-hardening.md R4。
let resolvedWslCommand: Promise<string> | null = null;

/** wsl.exe 的可执行路径（memoized：SystemRoot 在进程生命周期内不变，无需每次 spawn 都 stat）。 */
export function resolveWslCommand(): Promise<string> {
  resolvedWslCommand ??= resolveWslCommandOnce();
  return resolvedWslCommand;
}

async function resolveWslCommandOnce(): Promise<string> {
  if (process.platform !== "win32") {
    return WSL_COMMAND;
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) {
    return WSL_COMMAND;
  }
  const candidate = join(systemRoot, "System32", WSL_COMMAND);
  try {
    await access(candidate, constants.X_OK);
    return candidate;
  } catch {
    return WSL_COMMAND;
  }
}

export function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length === 0) {
    return "";
  }

  if (buffer.includes(0)) {
    return buffer.toString("utf16le");
  }

  return buffer.toString("utf8");
}

export function normalizeWslOutput(raw: string): string {
  return raw
    .replaceAll("\u0000", "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "");
}

export function buildWslArgs(
  commandArgs: string[],
  distroName?: string | null,
  userName?: string | null,
): string[] {
  const args: string[] = [];
  if (distroName) {
    args.push("-d", distroName);
  }
  if (userName) {
    args.push("-u", userName);
  }

  args.push("--", ...commandArgs);
  return args;
}

export function toWslUncCandidates(linuxPath: string, distroName: string): string[] {
  const normalizedPath = linuxPath.replaceAll("\\", "/");
  const pathSegments = normalizedPath.split("/").filter(Boolean);
  const suffix = pathSegments.length > 0 ? `\\${pathSegments.join("\\")}` : "";
  return [`\\\\wsl.localhost\\${distroName}${suffix}`, `\\\\wsl$\\${distroName}${suffix}`];
}

export async function accessAnyPath(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // 继续尝试下一个候选路径。
    }
  }

  return null;
}

export async function copyFileToAnyPath(sourcePath: string, targetPaths: string[]): Promise<boolean> {
  for (const targetPath of targetPaths) {
    try {
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      return true;
    } catch {
      // WSL 1 / 某些 Windows 版本可能不支持当前 UNC 前缀，继续回退。
    }
  }

  return false;
}
