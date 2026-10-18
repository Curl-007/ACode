// Ported from oh-my-pi (MIT) — packages/coding-agent/src/tools/browser/relay/server.ts,
// Copyright (c) 2025 Mario Zechner & Stencil Labs. 适配：Bun.serve websocket → node:http +
// 自实现最小 RFC6455（websocket.ts）；omp 前缀字段统一为 acode 前缀。
/**
 * browser-relay 的 HTTP + WebSocket 服务端。
 *
 * 伪装 Chrome 的 CDP discovery 端点，让 agent-browser 等 puppeteer 系客户端用普通
 * `browserURL`/`--cdp` 连接：
 * - `GET /json/version` → 扩展连接后 200 + `webSocketDebuggerUrl`；之前 503，body 为
 *   {@link RelayUnavailableInfo}（客户端据此判断是否值得轮询等待）。
 * - `GET /json` / `/json/list` → 可挂载的 page 目标（调试辅助）。
 * - `WS /cdp` → 下游 CDP 客户端（puppeteer 系）。
 * - `WS /ext` → Chrome 扩展（配置了 token 时按 `?token=` 鉴权）。
 *
 * 只绑定回环：能到达该端口的任何进程都能驱动用户已登录的浏览器——这是能力边界本身
 * （specs/browser-relay-inplace-capture.md 安全节）。
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { ACODE_BROWSER_RELAY_VERSION, RelayBridge } from "./bridge.js";
import { upgradeWebSocket, type RelayWebSocket } from "./websocket.js";

/** {@link startRelayServer} 的选项。 */
export interface RelayServerOptions {
  port: number;
  /** 扩展必须以 `?token=` 出示的共享密钥；缺省关闭该校验（仅回环边界）。 */
  token?: string;
  /** 把 agent 主动驱动的标签归入每窗口一个的 Chrome 标签组（缺省开）；`false` 关闭。 */
  group?: boolean | { title: string; color: string };
  /** 生产消费方注入服务日志；缺省静默。禁止携带 token（安全节红线）。 */
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/** 无扩展连接时 503 `/json/version` 的 body。 */
export interface RelayUnavailableInfo {
  /** 本 relay 实现的版本。 */
  acodeRelayVersion: string;
  error: string;
  /** 本服务端存活期内至少一次 hello 握手完成过。 */
  extensionSeen: boolean;
  /** 服务端已监听的毫秒数。 */
  uptimeMs: number;
  /** 当前连接到本 relay 的下游 CDP 客户端数。 */
  acodeRelayCdpClients: number;
  /** 最后一个已连接扩展离开至今的毫秒数；从未连接过则缺省。 */
  disconnectedMs?: number;
}

/** 运行中的 relay 服务端。 */
export interface RelayServer {
  bridge: RelayBridge;
  /** 实际绑定的端口（`whenListening` 落定后读取；支持 0 = 临时端口）。 */
  readonly port: number;
  /** 监听就绪信号，resolve 实际端口；端口被占（EADDRINUSE）时 reject。 */
  readonly whenListening: Promise<number>;
  /** 真实关闭完成信号（server close 事件）；stop 可幂等调用。 */
  readonly whenStopped: Promise<void>;
  stop(): void;
}

/** 被 agent 主动驱动的标签组的缺省外观（用户可见的安全指示）。 */
export const DEFAULT_RELAY_GROUP = { title: "ACode", color: "cyan" } as const;

const WS_KEEPALIVE_MS = 30_000;

/** `raw` 能否作为 `ws://` URL 的 authority：无空白、斜杠、userinfo、fragment、控制字符且可解析。 */
function isWsAuthority(raw: string): boolean {
  // 控制字符正是要拒绝的对象；按字符码显式判断以通过 no-control-regex。
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f) return false;
  }
  if (/[\s/\\@#?]/.test(raw)) return false;
  try {
    return new URL(`ws://${raw}`).host.length > 0;
  } catch {
    return false;
  }
}

interface SocketMeta {
  socket: RelayWebSocket;
  role: "cdp" | "ext";
  connId?: number;
}

/** 在 127.0.0.1 启动 relay 服务端；端口被占即抛。 */
export function startRelayServer(opts: RelayServerOptions): RelayServer {
  const log = opts.log ?? (() => {});
  const group =
    opts.group === false ? null : opts.group === true || opts.group === undefined ? { ...DEFAULT_RELAY_GROUP } : opts.group;
  const bridge = new RelayBridge({ log, group });
  const startedAt = Date.now();
  const metaBySocket = new Map<RelayWebSocket, SocketMeta>();

  const server: HttpServer = createServer((request, response) => {
    void handleHttp(request, response);
  });

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const fallback = `127.0.0.1:${opts.port}`;
      const rawHost = request.headers.host?.trim();
      const host = rawHost && isWsAuthority(rawHost) ? rawHost : fallback;
      const requestUrl = request.url ?? "/";
      const url = new URL(requestUrl, `http://${fallback}`);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/cdp") {
        // 非升级请求：带 Origin 的一律 403（网页不得探测驱动面），其余要求升级。
        if (request.headers.origin) {
          respondJson(response, 403, { error: "Forbidden" });
          return;
        }
        respondJson(response, 426, { error: "websocket upgrade required" });
        return;
      }
      if (path === "/ext") {
        const origin = request.headers.origin;
        if (origin && !origin.startsWith("chrome-extension://")) {
          respondJson(response, 403, { error: "Forbidden" });
          return;
        }
        // token 比较走常量时间路径意义有限（本地面），但绝不记日志（安全节红线）。
        if (opts.token && url.searchParams.get("token") !== opts.token) {
          respondJson(response, 401, { error: "Unauthorized" });
          return;
        }
        respondJson(response, 426, { error: "websocket upgrade required" });
        return;
      }
      if (request.method !== "GET") {
        respondJson(response, 405, { error: "Method not allowed" });
        return;
      }
      if (path === "/json/version") {
        if (!bridge.ready) {
          const disconnectedMs = bridge.extensionGoneForMs;
          const info: RelayUnavailableInfo = {
            acodeRelayVersion: ACODE_BROWSER_RELAY_VERSION,
            error: "relay extension is not connected",
            extensionSeen: bridge.extensionSeen,
            uptimeMs: Date.now() - startedAt,
            acodeRelayCdpClients: bridge.cdpClientCount,
            ...(disconnectedMs === null ? {} : { disconnectedMs }),
          };
          respondJson(response, 503, info);
          return;
        }
        respondJson(response, 200, bridge.versionInfo(`ws://${host}/cdp`));
        return;
      }
      if (path === "/json" || path === "/json/list") {
        respondJson(response, 200, bridge.listTargets());
        return;
      }
      respondJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (!response.headersSent) {
        respondJson(response, 500, { error: "internal error" });
      } else {
        response.end();
      }
      log("relay http handler failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const fallback = `127.0.0.1:${opts.port}`;
    const url = new URL(request.url ?? "/", `http://${fallback}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const fail = (status: number): void => {
      socket.write(`HTTP/1.1 ${status} \r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.end();
    };
    if (path !== "/cdp" && path !== "/ext") {
      fail(404);
      return;
    }
    const role: "cdp" | "ext" = path === "/cdp" ? "cdp" : "ext";
    if (role === "cdp" && request.headers.origin) {
      // 浏览器在 websocket 升级时带 Origin；原生 CDP 客户端不带。拒绝任何 Origin，
      // 让网页无法驱动 relay。
      fail(403);
      return;
    }
    if (role === "ext") {
      const origin = request.headers.origin;
      if (origin && !origin.startsWith("chrome-extension://")) {
        fail(403);
        return;
      }
      // token 不符即 401；token 本体绝不入日志（安全节红线）。
      if (opts.token && url.searchParams.get("token") !== opts.token) {
        fail(401);
        return;
      }
    }
    upgradeWebSocket(request, socket, head, {
      onOpen(ws) {
        const meta: SocketMeta = { socket: ws, role, connId: undefined };
        metaBySocket.set(ws, meta);
        if (role === "ext") bridge.extConnected(ws);
        else meta.connId = bridge.cdpConnected(ws);
      },
      onMessage(ws, text) {
        const meta = metaBySocket.get(ws);
        if (!meta) return;
        if (meta.role === "ext") bridge.extMessage(ws, text);
        else if (meta.connId !== undefined) bridge.cdpMessage(meta.connId, text);
      },
      onClose(ws) {
        const meta = metaBySocket.get(ws);
        if (!meta) return;
        metaBySocket.delete(ws);
        if (meta.role === "ext") bridge.extClosed(ws);
        else if (meta.connId !== undefined) bridge.cdpClosed(meta.connId);
      },
    });
  });

  // Puppeteer 连接在 agent 空闲时静默；协议级 ping 计入活动，避免对端被空闲超时误杀。
  const keepalive = setInterval(() => {
    for (const meta of metaBySocket.values()) meta.socket.ping();
  }, WS_KEEPALIVE_MS);
  keepalive.unref();

  let boundPort = opts.port;
  let stopCalled = false;
  const whenListening = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") boundPort = address.port;
      server.removeListener("error", reject);
      resolve(boundPort);
    });
  });
  const whenStopped = new Promise<void>((resolve) => {
    server.once("close", () => resolve());
  });

  return {
    bridge,
    get port(): number {
      return boundPort;
    },
    whenListening,
    whenStopped,
    stop() {
      if (stopCalled) return;
      stopCalled = true;
      clearInterval(keepalive);
      server.close();
      // 强制收尾既有连接：WS socket 是裸 duplex，close() 只等新连接排空。
      server.closeAllConnections();
      for (const meta of metaBySocket.values()) meta.socket.close(1001, "relay stopping");
      metaBySocket.clear();
    },
  };
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
