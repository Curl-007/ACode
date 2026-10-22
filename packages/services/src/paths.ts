/* path 规则集中维护：旧 task 快照与 provider 配置路径仍在这里收口。 */
import { lstatSync } from "node:fs";
import { chmod, cp, lstat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, win32 } from "node:path";
import { homedir } from "node:os";
import {
  DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE,
  resolveWorkspaceKey,
} from "@acode/shared";
import { ACODE_DATA_ROOT_DIR_NAME } from "./data-root/types.js";

let _dataBaseDir: string | null = null;
export const ACODE_WINDOWS_APP_INSTALL_DIR_ENV = "ACODE_WINDOWS_APP_INSTALL_DIR";
const envDataBaseDir = process.env.ACODE_DATA_BASE_DIR?.trim() || null;
const defaultDataBaseDir = process.env.HOME?.trim() || homedir();

interface DataBaseDirTargetValidationOptions {
  platform?: NodeJS.Platform | string;
  env?: Record<string, string | undefined>;
  appInstallDir?: string | null;
}

type DataBaseDirTargetValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: typeof DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE;
      forbiddenDir: string;
    };

/** Set the base directory for app data (replaces homedir() prefix). */
export function setDataBaseDir(dir: string | null): void {
  _dataBaseDir = dir?.trim() || null;
}

/** Get the current base directory. Priority: setDataBaseDir() > env ACODE_DATA_BASE_DIR > homedir(). */
export function getDataBaseDir(): string {
  if (_dataBaseDir) return _dataBaseDir;
  if (envDataBaseDir) return envDataBaseDir;
  // 服务实例会启动后台刷新任务；若每次调用都动态读取 HOME，
  // 测试或宿主切换环境变量后，旧实例可能把数据写到新实例目录。
  return defaultDataBaseDir;
}

/** {dataBaseDir}/.acode（目录名与 data-root 归属模块共用单一常量） */
export function getACodeDataRootDir(): string {
  return join(getDataBaseDir(), ACODE_DATA_ROOT_DIR_NAME);
}

/** 非项目对话共享的真实工作目录；默认 ~/.acode/workspace/default。 */
export function getConversationWorkspaceDir(): string {
  return join(getACodeDataRootDir(), "workspace", "default");
}

/** {dataBaseDir}/.acode/v2 */
export function getAppConfigDir(): string {
  return join(getACodeDataRootDir(), "v2");
}

function readEnvValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const direct = env[key]?.trim();
  if (direct) {
    return direct;
  }

  const lowerKey = key.toLowerCase();
  for (const [candidateKey, value] of Object.entries(env)) {
    if (candidateKey.toLowerCase() !== lowerKey) {
      continue;
    }
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function normalizeWindowsComparablePath(pathValue: string): string | null {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = win32.normalize(trimmed).replace(/[\\/]+$/, "");
  if (!normalized) {
    return null;
  }

  return win32
    .resolve(normalized)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isWindowsPathEqualOrInside(pathValue: string, rootValue: string): boolean {
  const normalizedPath = normalizeWindowsComparablePath(pathValue);
  const normalizedRoot = normalizeWindowsComparablePath(rootValue);
  if (!normalizedPath || !normalizedRoot) {
    return false;
  }

  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`);
}

function collectWindowsForbiddenAppInstallDirs(
  options: Required<Pick<DataBaseDirTargetValidationOptions, "env">> &
    Pick<DataBaseDirTargetValidationOptions, "appInstallDir">,
): string[] {
  const env = options.env;
  const programFiles = readEnvValue(env, "ProgramFiles");
  const programFilesX86 = readEnvValue(env, "ProgramFiles(x86)");
  const programW6432 = readEnvValue(env, "ProgramW6432");
  const localAppData = readEnvValue(env, "LOCALAPPDATA");
  const candidates = [
    options.appInstallDir,
    readEnvValue(env, ACODE_WINDOWS_APP_INSTALL_DIR_ENV),
    programFiles ? win32.join(programFiles, "ACode") : null,
    programFilesX86 ? win32.join(programFilesX86, "ACode") : null,
    programW6432 ? win32.join(programW6432, "ACode") : null,
    localAppData ? win32.join(localAppData, "Programs", "ACode") : null,
  ];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const normalized =
      typeof candidate === "string" ? normalizeWindowsComparablePath(candidate) : null;
    if (!candidate || !normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(candidate);
  }

  return result;
}

export function validateDataBaseDirTarget(
  targetBaseDir: string,
  options: DataBaseDirTargetValidationOptions = {},
): DataBaseDirTargetValidationResult {
  if ((options.platform ?? process.platform) !== "win32") {
    return { ok: true };
  }

  for (const forbiddenDir of collectWindowsForbiddenAppInstallDirs({
    env: options.env ?? process.env,
    appInstallDir: options.appInstallDir ?? null,
  })) {
    if (isWindowsPathEqualOrInside(targetBaseDir, forbiddenDir)) {
      return {
        ok: false,
        code: DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE,
        forbiddenDir,
      };
    }
  }

  return { ok: true };
}

export function getExportLogStageDir(): string {
  return join(getACodeDataRootDir(), "export-log-stage");
}

export function getExportLogDir(): string {
  return join(getACodeDataRootDir(), "export-log");
}

export function getFeedbackRootDir(): string {
  return join(getACodeDataRootDir(), "feedback");
}

export function getFeedbackAttachmentDir(): string {
  return join(getFeedbackRootDir(), "attachments");
}

export function getFeedbackLogArchiveDir(): string {
  return join(getFeedbackRootDir(), "logs");
}

export function getGitCheckpointIndexRootDir(): string {
  return join(getACodeDataRootDir(), "git-checkpoint-index");
}

/** ~/.acode/v2/tasks-index.sqlite */
export function getTasksIndexDatabasePath(): string {
  return join(getAppConfigDir(), "tasks-index.sqlite");
}

/**
 * workspace 级身份键：远程优先使用 workspaceIdentity，本地回退 workspacePath。
 * 修复原因（review R3 EI-2 身份 key 重复实现）：此前内联手写「trim identity，空则回退 path」，
 * 与 shared 的 resolveWorkspaceKey（唯一权威实现）语义重复。改为薄封装复用，避免漏 trim/改判空静默分叉。
 */
function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return resolveWorkspaceKey({ workspacePath, workspaceIdentity });
}

/** 与 ACode session 持久化一致：使用 workspaceKey 的 SHA-256 前 12 位 */
export function getWorkspaceHash(workspacePath: string, workspaceIdentity?: string): string {
  return createHash("sha256")
    .update(getWorkspaceKey(workspacePath, workspaceIdentity))
    .digest("hex")
    .slice(0, 12);
}

/** ~/.acode/v2/sessions/{workspaceHash} */
function getTaskSessionDir(workspacePath: string, workspaceIdentity?: string): string {
  return join(getAppConfigDir(), "sessions", getWorkspaceHash(workspacePath, workspaceIdentity));
}

/** ~/.acode/v2/sessions/{workspaceHash}/{taskId}.json */
export function getLegacyTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.json`);
}

/** ~/.acode/v2/sessions/{workspaceHash}/{taskId}.deleted.json */
export function getLegacyDeletedTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.deleted.json`);
}

/** 与 copyDataDirectory 的 cp filter 一致：setting.json 及其原子写临时兄弟不迁移。 */
function isExcludedFromDataCopy(sourceName: string): boolean {
  return sourceName === "setting.json" || sourceName.startsWith("setting.json.");
}

/**
 * POSIX 权限补强：复制后遍历源树，目标条目 mode 与源不一致时 chmod 回源值，
 * 保证凭据类文件 0600 不被迁移放宽（fs.cp 通常已保留 mode，此处为不依赖
 * Node 版本内部行为的保障性兜底；mode 一致时零额外 syscall）。
 * Windows 无 POSIX 权限位（stat mode 为合成值、chmod 只影响只读属性），不适用，直接跳过。
 */
async function preserveCopiedTreePermissions(oldDir: string, newDir: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  const walk = async (relative: string): Promise<void> => {
    const sourcePath = relative ? join(oldDir, relative) : oldDir;
    const targetPath = relative ? join(newDir, relative) : newDir;
    let sourceStat;
    try {
      sourceStat = await lstat(sourcePath);
    } catch {
      // 源条目在复制期间被删除（tmp/lock 类瞬时文件），跳过。
      return;
    }
    if (sourceStat.isSymbolicLink()) {
      // 与 cp filter 一致：符号链接未被复制，无需补强。
      return;
    }
    try {
      const targetStat = await lstat(targetPath);
      const sourceMode = sourceStat.mode & 0o7777;
      if ((targetStat.mode & 0o7777) !== sourceMode) {
        await chmod(targetPath, sourceMode);
      }
    } catch {
      // 目标缺失或文件系统不支持 chmod：不阻断迁移主流程。
    }
    if (!sourceStat.isDirectory()) {
      return;
    }
    let entries: string[];
    try {
      entries = await readdir(sourcePath);
    } catch {
      return;
    }
    for (const name of entries) {
      if (isExcludedFromDataCopy(name)) {
        continue;
      }
      await walk(relative ? join(relative, name) : name);
    }
  };
  await walk("");
}

/**
 * Copy the .acode/v2 data directory from one base dir to another.
 * Excludes setting.json and its transient atomic-write siblings — bootstrap
 * state must only live at the default homedir location.
 */
export async function copyDataDirectory(oldBaseDir: string, newBaseDir: string): Promise<void> {
  const oldDir = join(oldBaseDir, ACODE_DATA_ROOT_DIR_NAME, "v2");
  const newDir = join(newBaseDir, ACODE_DATA_ROOT_DIR_NAME, "v2");
  await cp(oldDir, newDir, {
    recursive: true,
    force: false,
    filter: (source) => {
      const sourceName = basename(source);
      if (isExcludedFromDataCopy(sourceName)) {
        // setting.json.lock 和 setting.json.*.tmp 由原子写入短暂创建/删除，
        // 复制过程中扫描到已消失的 lock 会触发 ENOENT，并让数据目录迁移失败。
        // 这些文件都属于 bootstrap 写入中间态，不能迁移到新数据根。
        return false;
      }
      // Windows 非提权环境下 fs.cp 无法复制符号链接（EPERM）。
      // 跳过符号链接可避免 Windows 非提权环境下 fs.cp 报 EPERM。
      try {
        if (lstatSync(source).isSymbolicLink()) return false;
      } catch {
        // lstat 失败时放行，让 cp 自行处理
      }
      return true;
    },
  });
  // spec: packages/services/specs/data-root-ownership.md「迁移权限补强」。
  await preserveCopiedTreePermissions(oldDir, newDir);
}
