import { basename, relative, sep } from "node:path";
import type { FileSystemPort } from "@acode/contracts";
import { parse as parseYaml } from "yaml";

import { MEMORY_RECALL_TYPES, type MemoryRecallType } from "./types.js";

/** 单次召回最多收录的记忆文件数（specs/memory-injection-fail-closed.md R10 常量表）。 */
export const MANIFEST_FILE_LIMIT = 200;

/**
 * 递归收集 rootDir 下的记忆候选文件路径。
 *
 * 与旧的清单扫描实现（已删除，见 specs/memory-injection-fail-closed.md R10）不同：
 * **列目录失败会抛出**而不是被吞成空清单。
 * 召回是 fail-closed 协议（specs/memory-injection-fail-closed.md R4），
 * 「存储不可读」必须与「目录里确实没有记忆」可区分，否则一次 IO 故障会被渲染成
 * 「你没有任何既有记忆」，直接诱导模型新建重复记忆。
 */
export async function collectMemoryFilePaths(
  fileSystem: FileSystemPort,
  directory: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const listed = await fileSystem.listDirectory({ path: directory }, { signal });
  const paths: string[] = [];

  for (const entry of listed.entries) {
    if (entry.kind === "directory") {
      paths.push(...(await collectMemoryFilePaths(fileSystem, entry.path, signal)));
      continue;
    }
    if (entry.kind === "file") {
      if (isMemoryCandidate(entry.path)) paths.push(entry.path);
      continue;
    }
    if (entry.kind !== "symlink" || !isMemoryCandidate(entry.path)) continue;

    try {
      const target = await fileSystem.stat({ path: entry.path }, { signal });
      if (target.kind === "file") paths.push(entry.path);
    } catch {
      // 单个失效的文件 symlink 与单个无法读取的事实文件一样，不影响其他 manifest 项。
    }
  }

  return paths;
}

/** 记忆文件在注入文本与去重账本里使用的稳定相对名（正斜杠，跨平台一致）。 */
export function memoryFileRelativeName(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join("/");
}

function isMemoryCandidate(filePath: string): boolean {
  return filePath.endsWith(".md") && basename(filePath) !== "MEMORY.md";
}

export function parseMemoryFrontmatter(content: string): {
  description?: string;
  name?: string;
  type?: MemoryRecallType;
} {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") return {};

  const end = lines.indexOf("---", 1);
  if (end < 0) return {};
  let parsed: unknown;
  try {
    parsed = parseYaml(lines.slice(1, end).join("\n"));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};

  const description = typeof parsed.description === "string" ? parsed.description : undefined;
  const name = typeof parsed.name === "string" ? parsed.name : undefined;
  const metadata = isRecord(parsed.metadata) ? parsed.metadata : undefined;
  const typeCandidate = metadata?.type ?? parsed.type;
  const type = isMemoryRecallType(typeCandidate) ? typeCandidate : undefined;
  return {
    ...(description ? { description } : {}),
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMemoryRecallType(value: unknown): value is MemoryRecallType {
  return typeof value === "string" && (MEMORY_RECALL_TYPES as readonly string[]).includes(value);
}
