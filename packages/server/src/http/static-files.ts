import { stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { isTokenProtectedPathname } from "@acode/shared/node";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPathname(pathname);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  // M10 修复：Windows 上 path.win32.relative 在 root 与 candidate 位于**不同盘符根**时
  // 原样返回 candidate 的绝对路径（如 relative("D:\\web", "C:\\Windows\\win.ini") ===
  // "C:\\Windows\\win.ini"），它不以 ".." 开头——旧判定 !startsWith("..") 会把
  // `GET /C:/Windows/win.ini` 这类跨盘符请求误判为「目录内」，而静态路由匿名可达
  // （不在 token 保护面），等于任意文件读取。relative() 的合法结果只可能是空串、
  // 目录内相对路径或 ".." 逃逸；出现绝对路径必然是跨盘符/跨根逃逸，一律拒绝。
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !isAbsolute(diff));
}

export async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  // R2 finding 2：畸形百分号编码（`/%`、`/%zz`、`/%e0%a4`）会让 decodeURIComponent 抛
  // URIError。此前 try/catch 只包住 stat，decode 异常冒泡成 500。decode 失败等价于
  //「该 pathname 不可能命中任何真实文件」，按未命中返回 null（→ 上层 404），不进 SPA fallback。
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

export function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
