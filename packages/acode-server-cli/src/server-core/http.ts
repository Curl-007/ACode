import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { WebSocket } from "ws";
import type { WebSocketServer } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@acode/rpc";
import {
  createACodeAgentConnectionScope,
  IACodeAgentService,
  ServiceCollection,
} from "@acode/services";
import { createServiceLogger } from "@acode/services/node";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  ACODE_RPC_HOST_CAPABILITY_HEADER,
  ACODE_VERSION,
  type ServerRemoteInfo,
} from "@acode/shared";
import {
  assertServerAuthInvariant,
  createHostCapabilityStore,
  resolveHostCapabilityBinding,
  resolveRequestOriginTrust,
  type HostCapabilityStore,
} from "@acode/shared/node";

interface CoreHttpServer {
  host: string;
  port: number;
  close: () => Promise<void>;
}

const WEBSOCKET_DRAIN_TIMEOUT_MS = 250;
const log = createServiceLogger("server-core");

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    // HTTP server.close() 不会收敛已经 upgrade 的 WebSocket，活跃 desktop
    // continuous 连接会让 Core 的 shutdown ack 永远发不出去。先发 close frame 给正常
    // 客户端一个短暂排空窗口，再 terminate 兜底，保证 Supervisor 能在预算内释放资源。
    client.close(1001, "Server shutting down");
  }
  const deadline = Date.now() + WEBSOCKET_DRAIN_TIMEOUT_MS;
  while (wss.clients.size > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve, reject) => {
    wss.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}

function wrapWebSocket(ws: WebSocket): ISocket {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw) =>
    data.fire(VSBuffer.wrap(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))),
  );
  ws.on("close", () => close.fire());
  ws.on("error", () => close.fire());
  return {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

function exposeWebSocket(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
): void {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  const server = new LoggingChannelServer(rawServer, (...args) => log.debug(undefined, ...args));
  const agentService = services.getOptional(IACodeAgentService);
  const scope = agentService
    ? createACodeAgentConnectionScope(agentService, {
        connectionId: `server-core-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  services.exposeOnChannelServer(
    server,
    scope ? new Map([[IACodeAgentService.channelName, scope.service]]) : new Map(),
  );
  socket.onClose(() => {
    void scope?.dispose();
    rawServer.dispose();
  });
}

export async function createCoreHttpServer(
  services: ServiceCollection,
  options: {
    host?: string;
    port?: number;
    serverId?: string;
    hostCapabilityStore?: HostCapabilityStore;
    /** `/ws/host` 升级允许的非 loopback Origin 白名单（与 packages/server 同源语义）。 */
    allowedOrigins?: string[];
  } = {},
): Promise<CoreHttpServer> {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app });
  const host = options.host ?? "127.0.0.1";
  // P0-1/P0-2：fail-closed 不变量与 packages/server 共用同一实现（`@acode/shared/node`），
  // 不再在本包内维护第二份 loopback 判定与抛错，避免两条 server 实现行为分叉。
  // Core 当前只有本机/SSH 隧道入口、尚未接入 token middleware，故 authRequired 为 false，
  // 非 loopback host 会在 listen 前抛错。
  assertServerAuthInvariant({ host, authRequired: false });
  const info: ServerRemoteInfo = {
    serverId: options.serverId ?? hostname() ?? "acode-server",
    version: ACODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: false,
    workspaces: [],
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
    },
  };
  // 裸 Set 无法落实 expiresAt，未消费的 capability 会一直有效并持续累积。
  // 使用与 packages/server 同源的 TTL 一次性 + 主体绑定 store，使有效期和消费语义一致。
  const capabilities = options.hostCapabilityStore ?? createHostCapabilityStore();
  app.get("/api/server-info", (context) => context.json(info));
  // P0-3：普通 `/ws` 升级与 `/ws/host`、以及 packages/server 同源同规则的 Origin/Host 裁决。
  // WebSocket 握手不受 CORS 限制：Core 恒 loopback 且无 token（authRequired 恒 false），
  // 恶意网页（DNS-rebinding / 本机恶意页面）可直连 ws://127.0.0.1:<port>/ws 以 terminal-client
  // 身份调用全部暴露服务，Origin 裁决是该姿态下唯一的浏览器侧屏障；原生客户端（Node `ws` /
  // SSH 隧道）不带 Origin，放行。判定必须复用同一个 resolveRequestOriginTrust（@acode/shared/node），
  // 不允许另起兜底分支。Core 没有 `/ws/remote/:id` 端点，无需另挂。
  app.use("/ws", async (context, next) => {
    const trust = resolveRequestOriginTrust({
      origin: context.req.header("origin"),
      host: context.req.header("host"),
      allowedOrigins: options.allowedOrigins,
    });
    if (!trust.allowed) {
      // 安全拒绝是生产可用事件（AGENTS.md 日志分级），记 warn 且不打敏感数据。
      log.warn(undefined, `SECURITY: WebSocket upgrade to /ws rejected: untrusted ${trust.reason}`);
      return context.json({ error: `Upgrade rejected: untrusted ${trust.reason}` }, 403);
    }
    await next();
  });
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );
  app.use("/ws/host", async (context, next) => {
    // P0-1：兑换 trusted-host 能力前先做 Origin/Host 校验，拒绝携带浏览器 Origin 但非白名单
    // 的升级请求（DNS-rebinding / 恶意网页驱动 loopback WS）。原生客户端不带 Origin，放行。
    const trust = resolveRequestOriginTrust({
      origin: context.req.header("origin"),
      host: context.req.header("host"),
      allowedOrigins: options.allowedOrigins,
    });
    if (!trust.allowed) {
      return context.json({ error: `Upgrade rejected: untrusted ${trust.reason}` }, 403);
    }
    const capability = context.req.header(ACODE_RPC_HOST_CAPABILITY_HEADER);
    const principal = capabilities.consume(capability);
    if (!principal) {
      return context.json({ error: "Invalid or expired host capability" }, 401);
    }
    // P0-1：与 packages/server 同源的主体绑定校验（共享 helper，避免两套实现分叉）。
    // Core 目前无 token 概念（authRequired 恒 false、经 assertServerAuthInvariant 限定 loopback），
    // 故 configuredToken / presentedToken 都传字面量 null → 该校验恒放行，**当前不提供任何屏障**。
    // Core 场景的真实边界是 loopback 绑定本身 + fail-closed 不变量 + Origin 校验。
    // 注意：这两个 null 是字面量，Core 将来接入 token middleware 时**必须同步改这两个实参**
    // 才会让绑定生效——保留调用点的意义是让该路径与 packages/server 结构一致、不易被漏改，
    // 而不是「自动生效」。
    const binding = resolveHostCapabilityBinding({
      boundPrincipal: principal,
      configuredToken: null,
      presentedToken: null,
    });
    if (!binding.allowed) {
      return context.json({ error: `Host capability rejected: ${binding.reason}` }, 403);
    }
    await next();
  });
  app.get(
    "/ws/host",
    upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        exposeWebSocket(socket.raw as WebSocket, services, "desktop-continuous");
      },
    })),
  );
  // Core 无 token 配置，主体为 anonymous；仍受非 loopback fail-closed 与 Origin 校验约束。
  // P0-1：存活能力达上限即拒绝铸造（见 MAX_LIVE_HOST_CAPABILITIES），堵住无鉴权端点内存耗尽 DoS。
  app.post("/api/rpc-host-capability", (context) => {
    // 与 /ws/host 升级、以及 packages/server 的铸造端点同源：先做 Origin 裁决**再** issue()。
    // server-core 恒 loopback 且无 token，恶意网页的跨源 simple POST（无需 CORS 预检）是这里
    // 唯一现实的远程攻击面；不拦 Origin 的话它可灌满能力槽位，让合法桌面 host 铸造就吃 503。
    // 原生客户端（Node ws / 进程内 fetch）不带 Origin，放行。
    const mintTrust = resolveRequestOriginTrust({
      origin: context.req.header("origin"),
      host: context.req.header("host"),
      allowedOrigins: options.allowedOrigins,
    });
    if (!mintTrust.allowed) {
      return context.json({ error: `Mint rejected: untrusted ${mintTrust.reason}` }, 403);
    }
    const issued = capabilities.issue();
    if (!issued) {
      return context.json({ error: "Host capability budget exhausted; retry later" }, 503);
    }
    return context.json(issued);
  });
  let resolveListening: (value: { port: number }) => void = () => undefined;
  const listening = new Promise<{ port: number }>((resolve) => {
    resolveListening = resolve;
  });
  const server = serve({ fetch: app.fetch, hostname: host, port: options.port ?? 0 }, () => {
    const address = server.address();
    resolveListening({
      port: typeof address === "object" && address ? address.port : (options.port ?? 0),
    });
  });
  injectWebSocket(server);
  const { port } = await listening;
  return {
    host,
    port,
    close: async () => {
      await closeWebSocketServer(wss);
      await new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
