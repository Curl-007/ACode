/* server kind 的 host 附着传输：与 stdio backend 路径并列的第二种 RemoteConnection 来源。 */
import { WebSocket } from "ws";
import { ChannelClient, Emitter, SocketProtocol, VSBuffer, type ISocket } from "@acode/rpc";
import { RemoteServiceAccess } from "@acode/client";
import type { IServiceAccessor } from "@acode/services";
import { formatLogPrefix, serverRemoteInfoSchema, type ServerConnectOptions } from "@acode/shared";

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("serverRemoteConnection", process.pid), ...args);

/** server-info 校验与 ws 打开的总超时；超时按连接失败处理，不残留半开信道。 */
const SERVER_CONNECT_TIMEOUT_MS = 15_000;

export interface ServerRemoteConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

/**
 * 与 stdio 路径的 `RemoteConnection` 同形（services/client/dispose/disposeAndWait），
 * 但**没有 backend**：server 已在运行，host 只附着，不部署/不 exec/不 handshake。
 */
export interface ServerRemoteConnection {
  services: IServiceAccessor;
  client: ChannelClient;
  dispose(): void;
  disposeAndWait(options?: { timeoutMs?: number }): Promise<void>;
}

export interface ConnectToRemoteServerTargetOptions {
  signal?: AbortSignal;
  /** 复用 Host 网络策略（设置页代理），与 stdio 路径一致；缺省回退 global fetch。 */
  fetch?: typeof globalThis.fetch;
  onDidRemoteClose?: (event: ServerRemoteConnectionCloseEvent) => void;
}

function createAbortError(): Error {
  const error = new Error("远程连接已取消");
  error.name = "AbortError";
  return error;
}

/** 从用户输入的 url 推导 server-info(HTTP) 与 ws 两个端点；token 只经 Authorization 头注入，绝不入日志/URL。 */
function resolveServerEndpoints(url: string): { infoUrl: URL; wsUrl: URL } {
  const parsed = new URL(url.trim());
  // HTTP 端点：ws/wss 归一回 http/https，便于 fetch /api/server-info。
  if (parsed.protocol === "ws:") parsed.protocol = "http:";
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  // 用户可能直接粘贴 ws 端点（…/ws），与 normalizeServerEndpoint 一致去掉末尾 /ws，
  // 否则会被拼成 …/ws/ws 与 …/ws/api/server-info。
  const trimmedPath = parsed.pathname.replace(/\/+$/g, "");
  const basePath = trimmedPath.endsWith("/ws")
    ? trimmedPath.slice(0, -"/ws".length).replace(/\/+$/g, "")
    : trimmedPath;
  const infoUrl = new URL(parsed.toString());
  infoUrl.pathname = `${basePath}/api/server-info`;
  infoUrl.hash = "";
  // WS 端点：http/https 升级回 ws/wss。
  const wsUrl = new URL(parsed.toString());
  wsUrl.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = `${basePath}/ws`;
  wsUrl.hash = "";
  return { infoUrl, wsUrl };
}

/** 把 `ws` 的 WebSocket 适配为 RPC 的 ISocket（镜像 server/http.ts 的 wrapWebSocket）。 */
function wrapNodeWebSocket(ws: WebSocket): ISocket {
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
      if (ws.readyState === WebSocket.OPEN) {
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

/**
 * 附着到一个已运行的 ACode/ZCode server。
 *
 * 步骤：1) GET /api/server-info 校验协议版本与能力（zod literal 把关，不符即明确失败）；
 * 2) 打开 /ws（token 经 Authorization: Bearer 头）；3) ISocket→SocketProtocol→ChannelClient→RemoteServiceAccess。
 * 全程不部署、不 detect、不 handshake——server 已在运行。
 */
export async function connectToRemoteServerTarget(
  target: ServerConnectOptions,
  options: ConnectToRemoteServerTargetOptions = {},
): Promise<ServerRemoteConnection> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const token = target.token?.trim();
  let endpoints: { infoUrl: URL; wsUrl: URL };
  try {
    endpoints = resolveServerEndpoints(target.url);
  } catch {
    throw new Error(`无法解析 server 地址: ${target.url}`);
  }

  const throwIfAborted = () => {
    if (options.signal?.aborted) {
      throw createAbortError();
    }
  };
  throwIfAborted();

  // 1) 校验 server-info：协议版本/能力由 serverRemoteInfoSchema 的 literal 固定，
  //    safeParse 失败即视为不兼容，给出明确连接错误而不是半开 ws。
  //    R2（server-auth.md）：HTTP 路由的 ?token= query 兼容窗已关闭，token 走 Bearer 头
  //    ——query 会泄漏进日志/历史/Referer，fetch 可以带头就不该用 query。
  const infoUrl = new URL(endpoints.infoUrl.toString());
  let infoResponse: Response;
  try {
    infoResponse = await fetchImpl(infoUrl.toString(), {
      cache: "no-store",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  } catch (error) {
    throw new Error(
      `无法访问 server-info（${endpoints.infoUrl.origin}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throwIfAborted();
  if (infoResponse.status === 401) {
    throw new Error("server 需要 token 鉴权，但当前 token 缺失或无效");
  }
  if (!infoResponse.ok) {
    throw new Error(`server-info 返回非 2xx 状态：${infoResponse.status}`);
  }
  const parsedInfo = serverRemoteInfoSchema.safeParse(await infoResponse.json());
  if (!parsedInfo.success) {
    // 版本/能力不符（例如旧 ACode 或异构 ZCode 构建）时拒绝附着，避免后续 RPC 错位。
    throw new Error(
      `server 协议或能力不兼容：${parsedInfo.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const serverInfo = parsedInfo.data;
  if (serverInfo.authRequired && !token) {
    throw new Error("server 要求 token 鉴权，请在连接表单填写 token");
  }
  throwIfAborted();

  // 2) 打开 /ws。安全修复（审计 M5，spec: specs/provisioning-transport-encryption-gate.md）：
  //    token 改经 Authorization: Bearer 头注入，不再写 URL query——query 会泄漏进代理/访问
  //    日志/历史记录。「标准 WebSocket API 无法携带自定义 header」的限制只适用于浏览器客户端；
  //    这里是 Node `ws`，支持 ClientOptions.headers。服务端全局 token 中间件对 /ws 升级请求
  //    同样优先读 Bearer 头（packages/server/src/http.ts 的 app.use("*") 覆盖升级路径，裁决
  //    本体 resolveServerTokenAuth 接受顺序 Bearer > cookie > query 仅 /ws*），query 仅为
  //    浏览器客户端保留兼容面，故本改动不触碰服务端语义。
  const wsUrl = new URL(endpoints.wsUrl.toString());
  const ws = new WebSocket(
    wsUrl.toString(),
    token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  );
  let settled = false;
  let openTimeout: ReturnType<typeof setTimeout> | undefined;
  const removeAbortListener = options.signal
    ? (() => {
        const onAbort = () => {
          if (!settled) {
            settled = true;
            ws.close();
          }
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        return () => options.signal?.removeEventListener("abort", onAbort);
      })()
    : () => undefined;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (openTimeout) clearTimeout(openTimeout);
      reject(error);
    };
    openTimeout = setTimeout(() => {
      fail(new Error(`连接 server WebSocket 超时（${wsUrl.origin}）`));
      ws.close();
    }, SERVER_CONNECT_TIMEOUT_MS);
    ws.once("error", () => fail(new Error(`无法连接 server WebSocket（${wsUrl.origin}）`)));
    ws.once("close", (code: number, reason: Buffer) => {
      if (settled) return;
      settled = true;
      if (openTimeout) clearTimeout(openTimeout);
      const reasonText = reason?.toString().trim();
      reject(
        new Error(
          reasonText
            ? `server WebSocket 在就绪前关闭：${reasonText}`
            : `server WebSocket 在就绪前关闭（${code}）`,
        ),
      );
    });
    ws.once("open", () => {
      if (settled) return;
      settled = true;
      if (openTimeout) clearTimeout(openTimeout);
      resolve();
    });
  });

  if (options.signal?.aborted) {
    ws.close();
    removeAbortListener();
    throw createAbortError();
  }

  // 3) ISocket → SocketProtocol → ChannelClient → RemoteServiceAccess（镜像 connectViaProtocol）。
  const socket = wrapNodeWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const client = new ChannelClient(protocol);
  const services = new RemoteServiceAccess(client);
  log(`attached to running server, serverId=${serverInfo.serverId}, version=${serverInfo.version}`);

  let hasReportedClose = false;
  let hasClosed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const closeListener = (code: number, reason: Buffer) => {
    hasClosed = true;
    resolveClosed();
    if (hasReportedClose) return;
    hasReportedClose = true;
    options.onDidRemoteClose?.({
      code,
      reason: reason?.toString() ?? "",
      wasClean: code === 1000 || code === 1001,
    });
  };
  ws.on("close", closeListener);

  let disposalStarted = false;
  const beginDisposal = () => {
    if (disposalStarted) return;
    disposalStarted = true;
    removeAbortListener();
    // 不能在这里 ws.off("close")：socket.dispose() 触发的 close 事件仍需 closeListener
    // 来 resolve `closed`，否则 disposeAndWait 永远等不到确认、只能耗满超时。
    // 与 stdio 路径一致——dispose 期间保留关闭上报，registry 对 close 幂等收口。
    client.dispose();
    protocol.dispose();
    socket.dispose();
  };

  return {
    services,
    client,
    dispose() {
      beginDisposal();
    },
    async disposeAndWait(disposeOptions) {
      beginDisposal();
      if (hasClosed) {
        return;
      }
      const timeoutMs = Math.max(disposeOptions?.timeoutMs ?? 5_000, 0);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timed-out">((resolve) => {
        timeout = setTimeout(() => resolve("timed-out"), timeoutMs);
      });
      const result = await Promise.race([closed.then(() => "closed" as const), deadline]);
      if (timeout) clearTimeout(timeout);
      if (result === "timed-out") {
        log(`server WebSocket close timed out after ${timeoutMs}ms`);
      }
    },
  };
}
