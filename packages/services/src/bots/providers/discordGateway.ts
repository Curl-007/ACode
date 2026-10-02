import { fetchBotProviderJson } from "#src/bots/providers/providerRequest.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_GATEWAY_VERSION = 10;
const DISCORD_HEARTBEAT_JITTER = 0.5;
const DISCORD_START_TIMEOUT_MS = 30_000;

// Discord 特权 intent：GUILD_MESSAGES(1<<9) + DIRECT_MESSAGES(1<<12) + MESSAGE_CONTENT(1<<15) + GUILDS(1<<0)。
// MESSAGE_CONTENT 必须在开发者后台开启，否则收到的消息 content 为空字符串。
const DISCORD_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

interface DiscordGatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export interface DiscordGatewayClient {
  close(): void;
  terminated: Promise<void>;
}

async function fetchGatewayUrl(token: string, signal?: AbortSignal): Promise<string> {
  const response = await fetchBotProviderJson<{ url?: string }>(
    `${DISCORD_API_BASE}/gateway/bot`,
    {
      headers: { Authorization: `Bot ${token}` },
      signal,
    },
  );
  const url = response.payload?.url;
  if (!response.ok || !url) {
    throw new Error(`Discord gateway/bot failed: HTTP ${response.status}`);
  }
  return url;
}

/**
 * 建立 Discord 原始 Gateway 长连接：HELLO → IDENTIFY → 心跳循环 → DISPATCH。
 * 出站消息仍走 REST；Gateway 只负责接收 MESSAGE_CREATE。
 * 连接断开后由调用方（runtime）重建新会话，本函数不实现 RESUME。
 */
export async function startDiscordGateway(params: {
  token: string;
  signal?: AbortSignal;
  onDispatch: (type: string, data: unknown) => Promise<void> | void;
  onConnectionStateChange?: (state: "connecting" | "connected" | "reconnecting") => void;
}): Promise<DiscordGatewayClient> {
  const { token, signal, onDispatch, onConnectionStateChange } = params;
  if (signal?.aborted) {
    throw new Error("Discord gateway startup aborted.");
  }
  onConnectionStateChange?.("connecting");
  const baseUrl = await fetchGatewayUrl(token.trim(), signal);
  const url = `${baseUrl.replace(/\/+$/u, "")}/?v=${DISCORD_GATEWAY_VERSION}&encoding=json`;

  return new Promise<DiscordGatewayClient>((resolve, reject) => {
    let startupSettled = false;
    let lifecycleSettled = false;
    let closed = false;
    let sequence: number | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatAcked = true;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveTerminated: (() => void) | undefined;
    let rejectTerminated: ((error: unknown) => void) | undefined;
    const terminated = new Promise<void>((resolveLifecycle, rejectLifecycle) => {
      resolveTerminated = resolveLifecycle;
      rejectTerminated = rejectLifecycle;
    });

    const ws = new WebSocket(url);

    const finishLifecycle = (error?: unknown) => {
      if (lifecycleSettled) return;
      lifecycleSettled = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (error) {
        rejectTerminated?.(error);
      } else {
        resolveTerminated?.();
      }
    };

    const fail = (error: unknown) => {
      if (startupSettled) return;
      startupSettled = true;
      if (startupTimer) clearTimeout(startupTimer);
      signal?.removeEventListener("abort", handleAbort);
      closeClient();
      reject(error);
    };

    function handleAbort() {
      if (startupSettled) {
        finishLifecycle();
        closeClient();
        return;
      }
      fail(new Error("Discord gateway startup aborted."));
    }

    function closeClient() {
      if (closed) return;
      closed = true;
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      try {
        ws.close();
      } catch {
        // 关闭异常不影响生命周期收口。
      }
    }

    function scheduleHeartbeat(intervalMs: number) {
      // Discord 建议首个心跳使用 interval * jitter 延迟，避免会话同时心跳。
      const initialDelay = Math.floor(intervalMs * DISCORD_HEARTBEAT_JITTER);
      const tick = () => {
        if (closed) return;
        if (!heartbeatAcked) {
          // 上一个心跳未收到 ACK，连接已僵尸；终止后由 runtime 重建会话。
          finishLifecycle(new Error("Discord gateway heartbeat not acknowledged."));
          closeClient();
          return;
        }
        heartbeatAcked = false;
        try {
          ws.send(JSON.stringify({ op: 1, d: sequence }));
        } catch (error) {
          finishLifecycle(error);
          closeClient();
          return;
        }
        heartbeatTimer = setTimeout(tick, intervalMs);
      };
      heartbeatTimer = setTimeout(tick, initialDelay);
    }

    function sendIdentify() {
      ws.send(
        JSON.stringify({
          op: 2,
          d: {
            token: token.trim(),
            intents: DISCORD_INTENTS,
            properties: { os: "linux", browser: "acode", device: "acode" },
          },
        }),
      );
    }

    ws.addEventListener("message", (event: MessageEvent) => {
      let payload: DiscordGatewayPayload;
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (typeof payload.s === "number") {
        sequence = payload.s;
      }
      switch (payload.op) {
        case 10: {
          const interval =
            typeof payload.d === "object" && payload.d !== null
              ? Number((payload.d as { heartbeat_interval?: number }).heartbeat_interval)
              : 45_000;
          heartbeatAcked = true;
          scheduleHeartbeat(Number.isFinite(interval) && interval > 0 ? interval : 45_000);
          sendIdentify();
          return;
        }
        case 11:
          heartbeatAcked = true;
          return;
        case 0:
          if (payload.t === "READY") {
            if (!startupSettled) {
              startupSettled = true;
              if (startupTimer) clearTimeout(startupTimer);
              signal?.removeEventListener("abort", handleAbort);
              onConnectionStateChange?.("connected");
              resolve({ close: closeClient, terminated });
            }
            return;
          }
          if (payload.t) {
            void onDispatch(payload.t, payload.d);
          }
          return;
        case 7:
          // RECONNECT：服务端要求重连，终止当前会话交给 runtime 重建。
          finishLifecycle(new Error("Discord gateway requested reconnect."));
          closeClient();
          return;
        case 9:
          // INVALID_SESSION：d=false 不可恢复，重新 IDENTIFY；d=true 也保守重建会话。
          finishLifecycle(new Error("Discord gateway session invalidated."));
          closeClient();
          return;
        default:
          return;
      }
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      // 4004 token 无效 / 4013 intent 无效 / 4014 特权 intent 未开启，均为不可重试错误。
      if (!startupSettled) {
        fail(new Error(`Discord gateway closed during startup: code=${event.code}`));
        return;
      }
      finishLifecycle(new Error(`Discord gateway closed: code=${event.code}`));
    });

    ws.addEventListener("error", () => {
      if (!startupSettled) {
        fail(new Error("Discord gateway connection failed."));
        return;
      }
      finishLifecycle(new Error("Discord gateway connection error."));
    });

    startupTimer = setTimeout(() => {
      fail(new Error(`Discord gateway startup timed out after ${DISCORD_START_TIMEOUT_MS}ms.`));
    }, DISCORD_START_TIMEOUT_MS);

    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
    }
  });
}
