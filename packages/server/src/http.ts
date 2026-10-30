import { readFile } from "node:fs/promises";
import { Hono, type MiddlewareHandler } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  ServiceCollection,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
} from "@acode/services";
import { formatZodError, remoteTargetSchema, ACODE_RPC_HOST_CAPABILITY_HEADER } from "@acode/shared";
import { connectRemote, createRemoteBackend } from "./remote/index.js";
import {
  ANONYMOUS_HOST_CAPABILITY_PRINCIPAL,
  assertServerAuthInvariant,
  createHostCapabilityStore,
  describeNoAuthLoopbackWarning,
  fingerprintPrincipal,
  isTokenProtectedPathname,
  readPresentedServerToken,
  resolveHostCapabilityBinding,
  resolveRequestOriginTrust,
  resolveServerTokenAuth,
} from "@acode/shared/node";
import { log, warn } from "./http/log.js";
import { setupChannelServer } from "./http/channel-server.js";
import {
  MAX_PENDING_REMOTE_CONNECTIONS,
  PENDING_REMOTE_CONNECTION_TTL_MS,
  claimPendingConnection,
  generateId,
  getPendingConnectionCount,
  pruneExpiredPendingConnections,
  registerPendingConnection,
} from "./http/pending-connections.js";
import { createServerInfo, type HttpServerOptions } from "./http/server-info.js";
import { resolveStaticFile, staticContentType } from "./http/static-files.js";
import { createBotCallbackHandlers } from "./http/bot-callbacks.js";
import { serverTokenRequestView, warnDeprecatedQueryTokenOnce } from "./http/token-request-view.js";

/**
 * HTTP/WS 路由注册本体（2026-10-30 拆分：辅助族迁 `src/http/` 七叶，本文件只保留
 * 路由注册与安全裁决——token 中间件、Origin 信任、host 能力铸造/消费/绑定、预算门——
 * 保证「同一鉴权顺序」在单文件内可审）。叶子清单与安全测试断言面见
 * specs/module-boundary.md「Registered debt」。
 */
export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();
  // 待认领连接惰性过期的时钟与 TTL：默认真实时钟 + 有界常量，测试可注入虚拟时间/更小 TTL。
  const pendingClock = options.pendingConnectionClock ?? (() => Date.now());
  const pendingTtlMs = options.pendingConnectionTtlMs ?? PENDING_REMOTE_CONNECTION_TTL_MS;

  const authToken = options.authToken?.trim();
  if (authToken) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
      // 已知限制（specs/server-auth.md「Bot 回调入口 × server token」节，本次不改行为）：
      // /api/bots/:provider 是外部 provider webhook 回调入口，自有鉴权是 webhook secret/验签
      // （botsService），provider 无法携带本 server 的 Bearer token——配置
      // ACODE_SERVER_AUTH_TOKEN 的部署里外部回调在下面一律 401。按 spec 裁决不在这里开
      // 路径豁免（会破坏「/api/** 全量受保护」单一不变量）；需要公网 bot 回调的部署暂不设
      // server token，靠 webhook secret + loopback 绑定 + 反向代理把关，详见该登记。
      // 裁决本体在共享 resolveServerTokenAuth（两套 server 单一实现），这里只做一次性告警。
      const auth = resolveServerTokenAuth(serverTokenRequestView(c), authToken);
      if (auth.viaDeprecatedQuery) {
        warnDeprecatedQueryTokenOnce();
      }
      if (!isTokenProtectedPathname(pathname) || auth.valid) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  // M2：传入实际用于挂中间件的 authToken，server-info 的 authRequired 如实反映强制状态。
  app.get("/api/server-info", (c) => c.json(createServerInfo(options, authToken)));
  // P0-1：铸造 trusted-host 能力受鉴权门控。配置 token 时，未鉴权请求已被上面的中间件
  // 拦为 401；走到这里说明请求已通过该 token 鉴权，故主体即该 token 的指纹（单 token=单主体）。
  // 未配置 token 的 loopback 场景主体为 anonymous，仍受非 loopback fail-closed 不变量约束。
  app.post("/api/rpc-host-capability", (c) => {
    // 先做 Origin 裁决，**再** issue()：恶意网页发来的跨源 POST 属于不需要 CORS 预检的
    // simple request，即使它读不到响应，请求本身也会触发 issue() 占掉一个槽位。
    // 若把校验放在铸造之后，攻击者仍可灌满 MAX_LIVE_HOST_CAPABILITIES 个槽位，
    // 让合法桌面 host 铸造就吃 503——那只是把「内存耗尽 DoS」换成「可用性 DoS」。
    // 放在之前则恶意网页连槽位都占不到。
    //
    // 与 /ws/host 升级路径用同一个 resolveRequestOriginTrust，策略一致：
    // 浏览器带 Origin 且不在白名单 → 403；原生客户端不带 Origin → 放行。
    // 本端点在仓库内没有浏览器调用方（唯一消费链 packages/desktop/src/host/
    // serverRemoteConnection.ts 用 Node 原生 `ws`，默认不发 Origin），故对合法流程零影响。
    const mintTrust = resolveRequestOriginTrust({
      origin: c.req.header("origin"),
      host: c.req.header("host"),
      allowedOrigins: options.allowedOrigins,
    });
    if (!mintTrust.allowed) {
      return c.json({ error: `Mint rejected: untrusted ${mintTrust.reason}` }, 403);
    }
    const issued = hostCapabilities.issue(
      authToken
        ? { fingerprint: fingerprintPrincipal(authToken) }
        : ANONYMOUS_HOST_CAPABILITY_PRINCIPAL,
    );
    // P0-1：存活能力达上限即拒绝铸造，堵住无鉴权端点被刷爆内存的 DoS（见 MAX_LIVE_HOST_CAPABILITIES）。
    if (!issued) {
      return c.json({ error: "Host capability budget exhausted; retry later" }, 503);
    }
    return c.json(issued);
  });

  // P0-3：普通 `/ws` 与 `/ws/remote/:id` 升级在鉴权（上方 token 中间件）之后、升级之前，
  // 做与 `/ws/host` 完全同源的 Origin/Host 裁决。WebSocket 握手不受 CORS 限制：默认
  // loopback 无 token 配置下，恶意网页（DNS-rebinding / 本机恶意页面）可直连
  // ws://127.0.0.1:<port>/ws 以 terminal-client 身份调用全部暴露服务（含文件/终端），
  // Origin 裁决是该姿态下唯一的浏览器侧屏障；原生客户端（Node `ws`）不带 Origin，放行。
  // 判定必须复用 `/ws/host` 的同一个 resolveRequestOriginTrust，不允许另起兜底分支。
  const rejectUntrustedUpgradeOrigin: MiddlewareHandler = async (c, next) => {
    const trust = resolveRequestOriginTrust({
      origin: c.req.header("origin"),
      host: c.req.header("host"),
      allowedOrigins: options.allowedOrigins,
    });
    if (!trust.allowed) {
      // 安全拒绝是生产可用事件（AGENTS.md 日志分级），记 warn 且不打敏感数据。
      warn(
        `SECURITY: WebSocket upgrade to ${new URL(c.req.url).pathname} rejected: untrusted ${trust.reason}`,
      );
      return c.json({ error: `Upgrade rejected: untrusted ${trust.reason}` }, 403);
    }
    await next();
  };

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
  app.use("/ws", rejectUntrustedUpgradeOrigin);
  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        setupChannelServer(ws.raw as WebSocket, services, "web-remote-replayable");
      },
    })),
  );

  const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
    onOpen(_event, ws) {
      setupChannelServer(ws.raw as WebSocket, services, "desktop-continuous");
    },
  }));
  app.use("/ws/host", async (c, next) => {
    // P0-1：在消费能力之前先做 Origin/Host 校验，拒绝携带浏览器 Origin 但非白名单的升级请求
    // （DNS-rebinding / 恶意网页驱动 loopback WS）。原生客户端不带 Origin，放行交由能力 ticket 把关。
    const trust = resolveRequestOriginTrust({
      origin: c.req.header("origin"),
      host: c.req.header("host"),
      allowedOrigins: options.allowedOrigins,
    });
    if (!trust.allowed) {
      return c.json({ error: `Upgrade rejected: untrusted ${trust.reason}` }, 403);
    }
    const capability = c.req.header(ACODE_RPC_HOST_CAPABILITY_HEADER);
    const principal = hostCapabilities.consume(capability);
    if (!principal) {
      return c.json({ error: "Invalid or expired host capability" }, 401);
    }
    // P0-1：真正执行能力与主体的绑定（共享 helper，与 server-core 同源，避免两套实现分叉）。
    // 此前 consume() 的返回值被丢弃，绑定形同虚设（对抗评审核实）；这里把比较补上。
    const binding = resolveHostCapabilityBinding({
      boundPrincipal: principal,
      configuredToken: authToken,
      presentedToken: readPresentedServerToken(serverTokenRequestView(c)),
    });
    if (!binding.allowed) {
      return c.json({ error: `Host capability rejected: ${binding.reason}` }, 403);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  // Web 模式下发起远程连接
  app.post("/api/connect-remote", async (c) => {
    // M11 修复：与 capability 铸造端点、三处 WS 升级同一个 resolveRequestOriginTrust 裁决，
    // 且必须在 body 解析与任何副作用**之前**。根因：hono c.req.json() 不校验 Content-Type，
    // 跨源 text/plain simple POST 免 CORS 预检即可执行本路由——恶意网页可盲触发
    // createRemoteBackend（真实 SSH 外联 / WSL / Docker spawn），并靠未认领连接累积刷 DoS
    // （下方 :ws/remote/:id 注释自认的攻击链）。浏览器带 Origin 且不在白名单 → 403；
    // 原生客户端不带 Origin → 放行（仓库内合法调用方 packages/web 为同源/loopback Origin）。
    const connectTrust = resolveRequestOriginTrust({
      origin: c.req.header("origin"),
      host: c.req.header("host"),
      allowedOrigins: options.allowedOrigins,
    });
    if (!connectTrust.allowed) {
      // 安全拒绝是生产可用事件（AGENTS.md 日志分级），记 warn 且不打敏感数据。
      warn(`SECURITY: POST /api/connect-remote rejected: untrusted ${connectTrust.reason}`);
      return c.json({ error: `Connect rejected: untrusted ${connectTrust.reason}` }, 403);
    }
    // M11：待认领连接硬上限——条目只在 WS 认领时删除，盲刷可累积真实后端连接（见
    // MAX_PENDING_REMOTE_CONNECTIONS 注释与 server-auth.md 风险登记）。
    // R2 finding 3：容量检查前先惰性驱逐超期条目，回收放弃认领客户端留下的句柄/内存；
    // 驱逐后仍达上限才拒绝，避免陈旧条目把合法新连接挤成 503。
    pruneExpiredPendingConnections(pendingClock(), pendingTtlMs);
    if (getPendingConnectionCount() >= MAX_PENDING_REMOTE_CONNECTIONS) {
      return c.json({ error: "Pending remote connection budget exhausted; retry later" }, 503);
    }
    const rawBody = await c.req.json();
    const parsedBody = remoteTargetSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return c.json({ error: `Invalid request body: ${formatZodError(parsedBody.error)}` }, 400);
    }
    const body = parsedBody.data;

    try {
      const backend = await createRemoteBackend(body);
      const connection = await connectRemote(backend);
      const id = generateId();
      // 记录 spawn 完成时刻作为惰性过期依据（R2 finding 3）；登记经唯一所有者叶
      // pending-connections.ts 的 registerPendingConnection，不直接写 Map。
      registerPendingConnection(id, connection, pendingClock());

      return c.json({ id });
    } catch (err: unknown) {
      // R2-04 修复：此前把 `err.message` 原样进响应体。SSH/WSL/Docker spawn 失败的 message
      // 常含主机名、绝对路径、可执行命令（如 `spawn ssh ENOENT`、`connect EHOSTUNREACH
      // 10.x.x.x:22`、WSL 发行版路径），对外返回等于把内部拓扑/命令泄漏给调用方（含浏览器）。
      // 修法：对外只回稳定归类码 `remote-connect-failed`，原始 message 降级进 warn 日志
      //（生产可诊断，但不出网）。与上方 Origin/预算拒绝一致的对外错误面。
      const detail = err instanceof Error ? err.message : String(err);
      warn("POST /api/connect-remote failed:", detail);
      return c.json({ error: "remote-connect-failed" }, 500);
    }
  });

  const { handleBotCallback, handleBotVerify } = createBotCallbackHandlers(services);

  app.post("/api/bots/:provider", handleBotCallback);
  app.post("/api/bots/:provider/:botId", handleBotCallback);
  app.get("/api/bots/:provider/:botId", handleBotVerify);

  // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器。
  // P0-3 核查结论：`/ws/remote/:id` 是**独立的**升级路由（`app.get("/ws")` 处理器不覆盖它），
  // 必须单独挂同一裁决——默认 loopback 无 token 姿态下恶意网页可先 POST /api/connect-remote
  // 拿到 id 再连这里，拿到的服务面（文件/终端）与 `/ws` 相同。
  app.use("/ws/remote/:id", rejectUntrustedUpgradeOrigin);
  app.get(
    "/ws/remote/:id",
    upgradeWebSocket((c) => {
      const id = c.req.param("id");
      return {
        onOpen(_event, ws) {
          if (!id) {
            ws.close(4000, "Missing remote connection id");
            return;
          }
          // R2 finding 3：认领是第二个惰性过期触点。先整体驱逐超期条目（有界资源回收，
          // 非常驻定时器），再认领本条；被本次驱逐命中的条目等同「不存在」。
          pruneExpiredPendingConnections(pendingClock(), pendingTtlMs);
          // 认领时校验 spawn 时间、超期 dispose、取出即从表移除，全部封装在唯一所有者叶
          // claimPendingConnection 内：不存在与已超期一律 null → close 4004，
          // 避免陈旧连接被迟到客户端复活（判定与 prune 同源 isPendingConnectionExpired）。
          const connection = claimPendingConnection(id, pendingClock(), pendingTtlMs);
          if (!connection) {
            ws.close(4004, "Remote connection not found");
            return;
          }

          // 将远程 services 包装为 ServiceCollection，复用 exposeOnChannelServer 统一注册
          const remoteServices = new ServiceCollection()
            .register(IFileService, connection.services.fileService)
            .register(IGitService, connection.services.gitService)
            .register(ISystemService, connection.services.systemService)
            .register(ITerminalService, connection.services.terminalService);

          setupChannelServer(ws.raw as WebSocket, remoteServices, "web-remote-replayable");
        },
      };
    }),
  );

  if (options.staticRoot?.trim()) {
    const staticRoot = options.staticRoot.trim();
    app.get("*", async (c) => {
      const pathname = new URL(c.req.url).pathname;
      const filePath = await resolveStaticFile(staticRoot, pathname, options.spaFallback ?? true);
      if (!filePath) {
        return c.notFound();
      }
      return c.body(await readFile(filePath), 200, {
        "Cache-Control": filePath.endsWith("index.html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
        "Content-Type": staticContentType(filePath),
      });
    });
  }

  // P0-2：把 server-core 既有的 fail-closed 不变量提到共享层。未指定 host 时默认绑定
  // loopback（此前未指定即监听所有网卡，属 fail-open）；非 loopback 绑定且未配 token 一律
  // 拒绝启动。bindHost 同时用于不变量校验与实际 serve，保证「检查的」与「监听的」是同一地址。
  const bindHost = options.host?.trim() || "127.0.0.1";
  const authRequired = Boolean(authToken);
  assertServerAuthInvariant({ host: bindHost, authRequired });

  const server = serve({ fetch: app.fetch, hostname: bindHost, port }, () => {
    const address = server.address();
    const listenPort = typeof address === "object" && address ? address.port : port;
    if (!authRequired) {
      // loopback 无 token 是受支持的默认姿态，但必须醒目告警，提醒本机任意进程/网页均可访问。
      log(describeNoAuthLoopbackWarning(bindHost));
    }
    log(`http://${bindHost}:${listenPort}`);
  });

  injectWebSocket(server);

  return server;
}
