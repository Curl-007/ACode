/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { hostname } from "node:os";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WebSocket } from "ws";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  LoggingChannelServer,
  type ISocket,
} from "@acode/rpc";
import {
  ServiceCollection,
  IACodeAgentService,
  createACodeAgentConnectionScope,
  ICredentialService,
  IFileService,
  IGitService,
  ISystemService,
  ITerminalService,
  IBotsService,
  IProviderProvisioningTargetService,
} from "@acode/services";
import {
  botProviders,
  formatLogPrefix,
  formatZodError,
  remoteTargetSchema,
  SERVER_REMOTE_PROTOCOL_VERSION,
  ACODE_RPC_HOST_CAPABILITY_HEADER,
  ACODE_VERSION,
  type BotProvider,
  type ServerRemoteInfo,
  type ServerRemoteWorkspaceInfo,
} from "@acode/shared";
import { connectRemote, createRemoteBackend, type RemoteConnection } from "./remote/index.js";
import {
  ANONYMOUS_HOST_CAPABILITY_PRINCIPAL,
  assertServerAuthInvariant,
  createHostCapabilityStore,
  createTerminalClientCredentialGuard,
  describeNoAuthLoopbackWarning,
  fingerprintPrincipal,
  isTokenProtectedPathname,
  readPresentedServerToken,
  resolveHostCapabilityBinding,
  resolveRequestOriginTrust,
  resolveServerTokenAuth,
  type ServerTokenRequestView,
} from "@acode/shared/node";

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
      }
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

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("acode-server:http", process.pid), ...args);

const warn = (...args: unknown[]) =>
  console.warn(formatLogPrefix("acode-server:http", process.pid), ...args);

function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: "desktop-continuous" | "web-remote-replayable",
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IACodeAgentService);
  const connectionScope = agentService
    ? createACodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IACodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  // M4：Credential 通道承载全仓明文凭据（OAuth token / JWT / BYO API Key / MCP token /
  // bot secret），此前无差别注册给每条连接——默认 loopback 无 token 姿态下本机任意进程/
  // 恶意网页可 dump 全部凭据。与上方 Provisioning 先例同模式，在传输注册层（overrides）
  // 按 clientMode 收窄：desktop-continuous 保持全量（renderer 登录态与 remote-workspace
  // token 流依赖）；terminal-client 仅放行 allowlist 键的只读 load（allowlist 证据与拒绝
  // 语义的唯一所有者在 @acode/shared/node credentialChannelAccess，两套 server 共用）。
  if (clientMode !== "desktop-continuous") {
    const credentialService = services.getOptional(ICredentialService);
    if (credentialService) {
      overrides.set(
        ICredentialService.channelName,
        createTerminalClientCredentialGuard(credentialService),
      );
    }
  }
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<string, RemoteConnection>();

/**
 * 待认领（已 spawn 但尚未被 `/ws/remote/:id` WS 客户端认领）远程连接的硬上限（M11）。
 *
 * 根因：条目只在 WS 认领时删除，`POST /api/connect-remote` 又可被盲刷——每次成功都会
 * spawn 真实后端（SSH 外联 / WSL / Docker），未认领条目无限累积即内存与进程句柄 DoS。
 * Origin 裁决封死浏览器攻击者后，本上限是有界性兜底：达上限即 503 拒绝新连接。
 * 风险登记（server-auth.md）：本次不引入 TTL 定时驱逐，陈旧未认领条目存活至进程重启。
 */
const MAX_PENDING_REMOTE_CONNECTIONS = 32;

function generateId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface HttpServerOptions {
  serverId?: string;
  name?: string;
  host?: string;
  authRequired?: boolean;
  authToken?: string;
  spaFallback?: boolean;
  staticRoot?: string;
  workspaces?: ServerRemoteWorkspaceInfo[];
  /** `/ws/host` 升级允许的非 loopback Origin 白名单（DNS-rebinding / 恶意网页防护）。 */
  allowedOrigins?: string[];
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function resolveServerId(options: HttpServerOptions): string {
  return (
    options.serverId?.trim() || readTrimmedEnv("ACODE_SERVER_ID") || hostname() || "acode-server"
  );
}

function resolveServerWorkspaces(options: HttpServerOptions): ServerRemoteWorkspaceInfo[] {
  if (options.workspaces) {
    return options.workspaces;
  }
  const workspacePath = readTrimmedEnv("ACODE_SERVER_WORKSPACE") || process.cwd();
  return [
    {
      path: workspacePath,
      label: basename(workspacePath) || workspacePath,
    },
  ];
}

function createServerInfo(
  options: HttpServerOptions,
  resolvedAuthToken?: string,
): ServerRemoteInfo {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ACODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ACODE_SERVER_NAME") }
      : {}),
    version: ACODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    // M2 修复：authRequired 必须如实反映「鉴权中间件是否真的挂载」。此前 fallback 读
    // ACODE_SERVER_TOKEN，而真实强制点（entry-http.ts）只读 ACODE_SERVER_AUTH_TOKEN 并经
    // options.authToken 传入——按文档配置旧变量名会得到「自报已鉴权、实际无鉴权」。
    // 现在以调用方实际用于挂中间件的 resolvedAuthToken 为准，不再读任何环境变量；
    // 全仓唯一鉴权 env 名 = ACODE_SERVER_AUTH_TOKEN（本包读取点在 entry-http.ts；
    // Server Core 在 server-core/http.ts 另有自己的单一读取点，见 server-auth.md）。
    authRequired: options.authRequired ?? Boolean(resolvedAuthToken),
    workspaces: resolveServerWorkspaces(options),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
    },
  };
}

/**
 * hono Context → 共享 token 裁决的请求视图。
 *
 * 裁决本体（凭据接受顺序 Bearer > lite token cookie > query 仅 `/ws*`、cookie 名与安全解码、
 * 受保护路径判定）已收敛到 `@acode/shared/node` serverAuth 的 `resolveServerTokenAuth` /
 * `readPresentedServerToken` / `isTokenProtectedPathname`，与 Server Core 共用单一实现；
 * 本文件只保留这一层 Context 适配，不再维护第二份接受顺序或 cookie 解码。
 */
function serverTokenRequestView(c: Context): ServerTokenRequestView {
  return {
    authorizationHeader: c.req.header("authorization"),
    cookieHeader: c.req.header("cookie"),
    url: c.req.url,
  };
}

// `?token=` 移除告警每进程只打印一次，避免刷屏，同时确保旧客户端能被明确告知迁移路径。
let warnedDeprecatedQueryToken = false;
function warnDeprecatedQueryTokenOnce(): void {
  if (warnedDeprecatedQueryToken) return;
  warnedDeprecatedQueryToken = true;
  console.warn(
    formatLogPrefix("acode-server:http", process.pid),
    "DEPRECATION REMOVED: the ?token= URL query is no longer accepted on HTTP routes and the request was rejected (it leaks into logs, browser history and Referer). Send `Authorization: Bearer <token>` instead. The query form remains supported only for WebSocket upgrade handshakes (/ws*), which cannot carry custom headers.",
  );
}

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

async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
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

function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** 企业微信回调验签参数固定来自 query；GET 校验和 POST 消息复用同一份读取。 */
function readWeComQuery(c: Context): Record<string, string> {
  const url = new URL(c.req.url);
  const query: Record<string, string> = {};
  for (const key of ["msg_signature", "timestamp", "nonce", "echostr"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) {
      query[key] = value;
    }
  }
  return query;
}

/**
 * Bot 回调统一响应：string responseBody 以 text/plain 原样返回（企业微信 URL 校验回明文 echostr），
 * 其余以 JSON 返回，并保留 400/401/503 的可重试语义。
 */
function respondBotCallback(c: Context, status: number | undefined, responseBody: unknown) {
  const httpStatus = status === 400 || status === 401 || status === 503 ? status : 200;
  if (typeof responseBody === "string") {
    // Bugfix：企业微信 URL 校验要求返回解密后的明文 echostr，包成 JSON 会让校验失败。
    return c.body(responseBody, httpStatus, { "Content-Type": "text/plain; charset=utf-8" });
  }
  return c.json(responseBody, httpStatus);
}

export function createHttpServer(
  services: ServiceCollection,
  port = 3030,
  options: HttpServerOptions = {},
) {
  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const hostCapabilities = createHostCapabilityStore();

  const authToken = options.authToken?.trim();
  if (authToken) {
    app.use("*", async (c, next) => {
      const pathname = new URL(c.req.url).pathname;
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
    if (remoteConnections.size >= MAX_PENDING_REMOTE_CONNECTIONS) {
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
      remoteConnections.set(id, connection);

      return c.json({ id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  const handleBotCallback = async (c: Context) => {
    const provider = c.req.param("provider") as BotProvider;
    if (!botProviders.includes(provider)) {
      return c.json({ error: `Unsupported provider: ${provider}` }, 400);
    }
    // wecom 走企业微信加密回调（POST 消息 + GET URL 校验）；其余 provider 仅 webhook 支持 HTTP 回调，
    // discord 为出站 Gateway、telegram/feishu/weixin 各有自己的长连接/轮询通道。
    if (provider !== "webhook" && provider !== "wecom") {
      return c.json({ error: `Provider ${provider} does not support HTTP callbacks.` }, 400);
    }
    const botsService = services.getOptional(IBotsService);
    if (!botsService) {
      return c.json({ error: "Bots service is not available." }, 503);
    }
    const rawBodyText = await c.req.text().catch(() => "");
    let rawBody: unknown = {};
    if (rawBodyText) {
      try {
        rawBody = JSON.parse(rawBodyText) as unknown;
      } catch {
        rawBody = { payload: rawBodyText };
      }
    }
    const webhookSecret = c.req.header("x-acode-bot-secret");
    const botId = c.req.param("botId");
    // 企业微信把验签参数放在 query（msg_signature/timestamp/nonce），密文 Encrypt 放在 body；
    // 两者都要透传给 adapter.prepareCallbackPayload 才能完成 SHA1 验签 + AES 解密。
    const acodeWecomQuery = provider === "wecom" ? readWeComQuery(c) : undefined;
    const result = await botsService.handleProviderCallbackResponse(provider, {
      ...(typeof rawBody === "object" && rawBody !== null ? rawBody : { payload: rawBody }),
      rawBody: rawBodyText,
      ...(botId ? { botId } : {}),
      ...(webhookSecret ? { webhookSecret } : {}),
      ...(acodeWecomQuery ? { acodeWecomQuery } : {}),
    });
    const responseBody = result.responseBody ?? { ok: result.ok, replies: result.replies };
    return respondBotCallback(c, result.status, responseBody);
  };

  const handleBotVerify = async (c: Context) => {
    const provider = c.req.param("provider") as BotProvider;
    // GET 校验仅企业微信需要：解密 echostr 后原样回明文，企业微信据此判定回调 URL 配置成功。
    if (provider !== "wecom") {
      return c.json({ error: `Provider ${provider} does not support GET verification.` }, 400);
    }
    const botsService = services.getOptional(IBotsService);
    if (!botsService) {
      return c.json({ error: "Bots service is not available." }, 503);
    }
    const botId = c.req.param("botId");
    const result = await botsService.handleProviderCallbackResponse(provider, {
      ...(botId ? { botId } : {}),
      acodeWecomVerify: true,
      acodeWecomQuery: readWeComQuery(c),
    });
    return respondBotCallback(c, result.status, result.responseBody ?? "");
  };

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
          const connection = remoteConnections.get(id);
          if (!connection) {
            ws.close(4004, "Remote connection not found");
            return;
          }
          // 一个连接只给一个 WS 客户端使用，取出后从 Map 移除
          remoteConnections.delete(id);

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
