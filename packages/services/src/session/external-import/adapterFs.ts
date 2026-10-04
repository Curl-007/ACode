import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * 发现阶段的目录遍历辅助件：只读、深度有界、目录不存在返回空。
 * 不跟随符号链接目录（外部工具目录内的链接不该把导入扫描带出边界）。
 */
export async function collectFilesRecursive(
  rootDir: string,
  matches: (fileName: string) => boolean,
  maxDepth = 8,
): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // 目录不存在/不可读 = 该来源没装或无权限，是常态不是异常（R1）。
      return;
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isFile()) {
        if (matches(entry.name)) {
          files.push(entryPath);
        }
        continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(entryPath, depth + 1);
      }
    }
  }

  await walk(rootDir, 1);
  return files;
}

/** 读取 mtime；失败（文件消失/权限）返回 null，由调用方决定跳过。 */
export async function readFileMtimeMs(filePath: string): Promise<number | null> {
  try {
    const metadata = await stat(filePath);
    return Math.trunc(metadata.mtimeMs);
  } catch {
    return null;
  }
}

/**
 * adapter 默认根目录 + 环境变量覆盖（R1：测试桩需要）。
 * 每次调用时读取 process.env，adapter 自身不持有可变状态。
 */
export function resolveExternalImportRootDir(envVar: string, defaultDir: string): string {
  const override = process.env[envVar]?.trim();
  return override && override.length > 0 ? override : defaultDir;
}
