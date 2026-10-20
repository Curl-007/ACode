import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataBaseDir, initializeDataRoot, setDataBaseDir } from "@acode/services/node";

function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  return join(homePath, ".acode", "v2", "setting.json");
}

function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  // 数据根四态判定（spec: packages/services/specs/data-root-ownership.md）必须在
  // setDataBaseDir 之前完成：冲突目录备份让路与归属文件落盘都发生在这里，
  // 保证判定前正式根零写入。此时 getDataBaseDir() 尚未被 setDataBaseDir 覆盖，
  // 返回 ACODE_DATA_BASE_DIR 或 HOME，E2E/dev 隔离 base 同样经过判定。
  try {
    initializeDataRoot({ baseDir: dataBaseDir ?? getDataBaseDir(), createdBy: "desktop" });
  } catch (error) {
    // 初始化器异常不阻断启动：早期阶段不能用 main/logger（其落盘路径依赖尚未确定的
    // 数据根），只走 console；本次按原路径继续，下次启动重试判定。
    console.error("[desktopDataBaseDirBootstrap] initializeDataRoot failed:", error);
  }
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  return dataBaseDir;
}
