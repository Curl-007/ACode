// 拆分依据：wsl-backend.ts 超 400 行架构上限。WSL 命令常量、输出解码/规范化、wsl.exe 参数构造、
// UNC 候选路径与文件级回退探测是纯支撑逻辑，与 WSLBackend 类的会话/上传/生命周期编排无关，
// 独立成叶子。quotePosixShellArg 复用 posixShell.ts 的共享实现（与原私有副本逐字节一致）。
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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

export const WSL_COMMAND = "wsl.exe";
export const WSL_EXEC_MAX_BUFFER = 8 * 1024 * 1024;

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
