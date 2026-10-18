// Ported from oh-my-pi (MIT) — packages/coding-agent/src/lsp/utils.ts（URI/读取切片）, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// URI 换算与磁盘文本读取（Bun.pathToFileURL/fileURLToPath → node:url 降解点）
// ============================================================

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 文件路径 → file:// URI。走 URL 机制做百分号编码（`%`/`#`/`?`/空格），
 * 并正确处理 Windows 盘符——纯字符串拼接产生过破坏往返的 URI。
 */
export function fileToUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

/**
 * file:// URI → 文件路径。容忍百分号编码 URI 与发原始路径的宽松服务器；
 * Windows 盘符正确处理。
 */
export function uriToFile(uri: string): string {
  if (!uri.startsWith("file://")) return uri;

  // 裸 `#`/`?` 会被 URL 解析成 fragment/query 而静默截断路径。LSP 的 file URI
  // 不使用 fragment/query（编码形是 %23/%3F），出现裸字符说明是宽松服务器发了
  // 未编码路径，走宽松手工换算。
  if (uri.includes("#") || uri.includes("?")) return laxUriToFile(uri);

  try {
    return fileURLToPath(uri);
  } catch {
    return laxUriToFile(uri);
  }
}

function laxUriToFile(uri: string): string {
  let filePath = uri.slice(7);
  try {
    filePath = decodeURIComponent(filePath);
  } catch {
    // 非法百分号编码——按字面路径处理。
  }
  // Windows: file:///C:/path → C:/path（剥掉盘符前的斜杠）。
  if (process.platform === "win32" && filePath.startsWith("/") && /^[A-Za-z]:/.test(filePath.slice(1))) {
    filePath = filePath.slice(1);
  }
  return filePath;
}

/** 等价文件 URI 视作同键的 Map（Windows 大小写不敏感归一）。 */
export class EquivalentUriMap<Value> extends Map<string, Value> {
  #key(uri: string): string {
    if (!uri.startsWith("file://")) return uri;
    const filePath = path.normalize(uriToFile(uri));
    return process.platform === "win32" ? filePath.toLowerCase() : filePath;
  }

  override delete(uri: string): boolean {
    return super.delete(this.#key(uri));
  }

  override get(uri: string): Value | undefined {
    return super.get(this.#key(uri));
  }

  override has(uri: string): boolean {
    return super.has(this.#key(uri));
  }

  override set(uri: string, value: Value): this {
    return super.set(this.#key(uri), value);
  }
}

/** 读文件文本；拒绝非普通文件（FIFO/设备/socket 的读取可能永久阻塞）。 */
export async function readTextFromDisk(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Cannot open '${filePath}': it is not a regular file.`);
  }
  return fs.readFile(filePath, "utf8");
}

// 扩展名 → LSP languageId（覆盖内置服务器的语言面）。
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".rs": "rust",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".html": "html",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "shellscript",
};

/** 按文件路径推断 didOpen 的 languageId；未知扩展名回退 plaintext。 */
export function detectLanguageId(filePath: string): string {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "plaintext";
}

export function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
