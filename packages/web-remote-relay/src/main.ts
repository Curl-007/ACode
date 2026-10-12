import { createServer } from "node:http";
import { join, resolve } from "node:path";

import {
  attachWebRemoteRelayToHttpServer,
  createWebRemoteRelayServer,
  createWebRemoteRelayStaticHandler,
} from "./index.js";

// relay 的独立部署入口：一个进程同时提供
//   - /ws  → 远控 WebSocket（配对 + 转发）
//   - /m   → 手机页（packages/web 的构建产物，SPA fallback）
//
// 手机页与 relay 同源是刻意的：二维码里只有一个 URL，同源省掉了 CORS 与
// 「手机该连哪个 ws 地址」的二次协商。
//
// **这条路径只用于跨网络场景**（手机与电脑不在同一局域网）。同一 Wi-Fi 下桌面会自己
// 托管 relay（见 packages/desktop/src/main/webRemoteControl/localRelay.ts），无需部署。

const PORT = Number(process.env.ACODE_WEB_REMOTE_RELAY_PORT ?? 8787);
const HOST = process.env.ACODE_WEB_REMOTE_RELAY_HOST?.trim() || "0.0.0.0";
const STATIC_ROOT = resolve(
  process.env.ACODE_WEB_REMOTE_RELAY_STATIC_ROOT?.trim() ||
    join(import.meta.dirname, "..", "..", "web", "dist"),
);

const relay = createWebRemoteRelayServer({
  logger: {
    info: (message, ...args) => console.log(`[relay] ${message}`, ...args),
    warn: (message, ...args) => console.warn(`[relay] ${message}`, ...args),
  },
});
const serveStatic = createWebRemoteRelayStaticHandler(STATIC_ROOT);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, ...relay.getStats() }));
    return;
  }
  serveStatic(request, response);
});

attachWebRemoteRelayToHttpServer(server, relay);

server.listen(PORT, HOST, () => {
  console.log(`[relay] listening on http://${HOST}:${PORT}`);
  console.log(`[relay] mobile page root: ${STATIC_ROOT}`);
  console.log(
    `[relay] 桌面侧设置 ACODE_WEB_REMOTE_CONTROL_RELAY_WS_URL=ws://<this-host>:${PORT}/ws 即可使用`,
  );
});

function shutdown(): void {
  relay.close();
  server.close(() => process.exit(0));
  // 兜底：连接未及时关闭时不要卡住退出。
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
