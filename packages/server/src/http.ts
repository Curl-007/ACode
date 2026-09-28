/* eslint-disable max-lines -- HTTP、WebSocket 与静态资源路由集中注册，保持同一鉴权顺序。 */
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { hostname } from "node:os";
import { Hono, type Context } from "hono";
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
  describeNoAuthLoopbackWarning,
  fingerprintPrincipal,
  parseBearerToken,
  resolveHostCapabilityBinding,
  resolveRequestOriginTrust,
  timingSafeTokenEquals,
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
  services.exposeOnChannelServer(server, overrides);
  socket.onClose(() => {
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

/** 存储 web 模式下的远程连接，key 为随机 ID */
const remoteConnections = new Map<string, RemoteConnection>();

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

function createServerInfo(options: HttpServerOptions): ServerRemoteInfo {
  return {
    serverId: resolveServerId(options),
    ...(options.name?.trim() || readTrimmedEnv("ACODE_SERVER_NAME")
      ? { name: options.name?.trim() || readTrimmedEnv("ACODE_SERVER_NAME") }
      : {}),
    version: ACODE_VERSION,
    protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
    authRequired: options.authRequired ?? Boolean(readTrimmedEnv("ACODE_SERVER_TOKEN")),
    workspaces: resolveServerWorkspaces(options),
    capabilities: {
      desktopContinuous: true,
      websocketRpc: true,
    },
  };
}

const acodeLiteTokenCookieName = "acode_lite_token";

interface LiteTokenAuthResult {
  valid: boolean;
  /** 命中已弃用的 `?token=` query；调用点据此打印一次性弃用告警。 */
  viaDeprecatedQuery: boolean;
}

// `?token=` 弃用告警每进程只打印一次，避免刷屏，同时确保旧客户端能被明确告知迁移路径。
let warnedDeprecatedQueryToken = false;
function warnDeprecatedQueryTokenOnce(): void {
  if (warnedDeprecatedQueryToken) return;
  warnedDeprecatedQueryToken = true;
  console.warn(
    formatLogPrefix("acode-server:http", process.pid),
    "DEPRECATION: authenticating via the ?token= URL query is deprecated and will be removed in a future release; it leaks into logs, browser history and Referer. Send `Authorization: Bearer <token>` instead.",
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

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

/**
 * 读取 `acode_lite_token` cookie 的值，与写入端（`encodeURIComponent`）对称地安全解码。
 *
 * **为什么必须有这一个 helper**：鉴权（`hasValidLiteToken`）与主体绑定
 * （`readPresentedLiteToken`）必须对「本次请求出示的是哪个 token」给出**完全相同**的答案。
 * 此前两处各自读 cookie——一处比较原值、一处 `decodeURIComponent`——导致含 `%XX` 的 token
 * 会出现「中间件认可、绑定校验算出不同主体」的分叉：合法 cookie 升级被 403（principal-mismatch），
 * 含裸 `%` 的 token 还会让 `decodeURIComponent` 抛 URIError → 500。
 *
 * 解码失败时回退原值而不是抛错：cookie 可能来自旧客户端或非本服务写入，
 * 鉴权/绑定都不应因为一个畸形值而 500，比较不上自然就是「不匹配」。
 */
function readLiteTokenCookie(c: Context): string | undefined {
  const raw = parseCookieHeader(c.req.header("cookie")).get(acodeLiteTokenCookieName);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function hasValidLiteToken(c: Context, token: string): LiteTokenAuthResult {
  // P0-2：token 校验优先走 `Authorization: Bearer`，其次 cookie（浏览器兼容），
  // 最后才是已弃用的 `?token=` query（会泄漏进日志/历史/Referer）。
  const bearer = parseBearerToken(c.req.header("authorization"));
  if (timingSafeTokenEquals(bearer, token)) {
    return { valid: true, viaDeprecatedQuery: false };
  }
  if (timingSafeTokenEquals(readLiteTokenCookie(c), token)) {
    return { valid: true, viaDeprecatedQuery: false };
  }
  const url = new URL(c.req.url);
  if (timingSafeTokenEquals(url.searchParams.get("token") ?? undefined, token)) {
    // 兼容旧客户端：命中 query 后回写 cookie，使其后续走 cookie 路径。
    c.header(
      "Set-Cookie",
      `${acodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return { valid: true, viaDeprecatedQuery: true };
  }
  return { valid: false, viaDeprecatedQuery: false };
}

/**
 * 取出本次请求实际出示的 token（`Authorization: Bearer` > cookie > 已弃用 query）。
 *
 * P0-1 需要它来**真正执行**能力与主体的绑定：`hasValidLiteToken` 只回答「合不合法」，
 * 而绑定校验要的是「出示的是哪一个主体」。两者必须同源——cookie 一律经
 * `readLiteTokenCookie` 读取，避免出现「中间件认可 A、绑定校验取到 B」的分叉。
 */
function readPresentedLiteToken(c: Context): string | undefined {
  const bearer = parseBearerToken(c.req.header("authorization"));
  if (bearer) {
    return bearer;
  }
  const fromCookie = readLiteTokenCookie(c);
  if (fromCookie) {
    return fromCookie;
  }
  return new URL(c.req.url).searchParams.get("token") ?? undefined;
}

function isTokenProtectedPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

function isStaticFallbackAllowed(pathname: string): boolean {
  return !isTokenProtectedPath(pathname);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
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
      const auth = hasValidLiteToken(c, authToken);
      if (auth.viaDeprecatedQuery) {
        warnDeprecatedQueryTokenOnce();
      }
      if (!isTokenProtectedPath(pathname) || auth.valid) {
        await next();
        return;
      }
      return c.json({ error: "Unauthorized" }, 401);
    });
  }

  app.get("/api/server-info", (c) => c.json(createServerInfo(options)));
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

  // 普通 `/ws` 永远是 terminal-client；浏览器/任意客户端设置旧 mode header
  // 都不能再把自己提升为 trusted host。
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
      presentedToken: readPresentedLiteToken(c),
    });
    if (!binding.allowed) {
      return c.json({ error: `Host capability rejected: ${binding.reason}` }, 403);
    }
    await next();
  });
  app.get("/ws/host", upgradeTrustedHostWebSocket);

  // Web 模式下发起远程连接
  app.post("/api/connect-remote", async (c) => {
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

  // 远程连接的 WebSocket 端点，将远程 services 桥接给浏览器
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
