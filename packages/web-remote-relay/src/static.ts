import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve, extname, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// 手机页的静态托管。
//
// 单独成模块是因为它有两个消费方：relay 的独立入口（`main.ts`）与**桌面进程内托管的
// 本地 relay**（`packages/desktop/src/main/webRemoteControl/localRelay.ts`）。
// 后者才是默认路径——用户不该为了扫码去部署一个服务器。

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

const MISSING_BUILD_MESSAGE =
  "手机页构建产物不存在。\n请先执行 pnpm --filter @acode/web build，或用 ACODE_WEB_REMOTE_RELAY_STATIC_ROOT 指定目录。\n";

function respondMissingBuild(response: ServerResponse): void {
  response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  response.end(MISSING_BUILD_MESSAGE);
}

// FIX-H4：createReadStream(...).pipe(response) 不监听源流 error 时，ENOENT/EACCES（文件在
// existsSync 与打开之间被删除/替换、权限变化）会变成 uncaughtException——桌面形态下直接打崩
// Electron main。这里按错误类型回 404/500；响应头已发出时只能 destroy 连接。
function pipeFile(
  filePath: string,
  response: ServerResponse,
  headers: Record<string, string>,
): void {
  const stream = createReadStream(filePath);
  stream.once("open", () => {
    response.writeHead(200, headers);
    stream.pipe(response);
  });
  stream.once("error", (error: NodeJS.ErrnoException) => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    const notFound = error.code === "ENOENT" || error.code === "EISDIR" || error.code === "ENOTDIR";
    response.writeHead(notFound ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    response.end(notFound ? "Not Found" : "Internal Server Error");
  });
  response.once("close", () => stream.destroy());
}

export type WebRemoteRelayStaticHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

/**
 * 生成手机页的请求处理器。
 *
 * `staticRoot` 为 undefined 时返回一个只解释「为什么没有页面」的处理器——把「手机页还没
 * 构建」说清楚，比 404 有用得多。
 */
export function createWebRemoteRelayStaticHandler(
  staticRoot: string | undefined,
): WebRemoteRelayStaticHandler {
  const root = staticRoot ? resolve(staticRoot) : undefined;
  const indexPath = root ? join(root, "index.html") : undefined;

  return (request, response) => {
    if (!root || !indexPath) {
      respondMissingBuild(response);
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    // 手机页入口：二维码指向 /m?sid=..&hash=..，这里把 / 与 /m 下的路径都落到 index.html，
    // 让前端自己解析 query。
    const requested =
      url.pathname === "/" || url.pathname.startsWith("/m") ? "/index.html" : url.pathname;
    const candidate = resolve(join(root, normalize(requested).replace(/^(\.\.[/\\])+/, "")));

    // 目录穿越防护：normalize 之后仍必须落在 staticRoot 内（带分隔符比较，避免 root 同名前缀目录绕过）。
    if (candidate !== root && !candidate.startsWith(root.endsWith(sep) ? root : root + sep)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    if (existsSync(candidate) && statSync(candidate).isFile()) {
      pipeFile(candidate, response, {
        "content-type": CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream",
        // 带内容 hash 的资源可以长缓存；index.html 不能缓存，否则发新版后手机拿到旧壳。
        "cache-control": candidate.endsWith("index.html") ? "no-cache" : "public, max-age=31536000",
      });
      return;
    }

    // SPA fallback：构建产物里没有的路径交给 index.html，由前端路由处理。
    // FIX-H4：目录存在但缺 index.html 时回 503 说明原因，而不是去读一个不存在的文件。
    if (!existsSync(indexPath)) {
      respondMissingBuild(response);
      return;
    }
    pipeFile(indexPath, response, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
  };
}
