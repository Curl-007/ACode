/* off-peak 进程内 mock 网关。
   本地起 127.0.0.1 http 服务完整模拟 额度快照/取号/批量状态/结算/messages，
   真实 HTTP client 与 idle plan provider 的 baseURL 只需指到本网关 origin——生产代码路径
   与联调完全一致，联调时删掉 ACODE_OFFPEAK_MOCK 开关即可。

   ⚠ messages 端点在准入后把请求原样代理到 resolveUpstream() 指定的真实模型端点
   （通常是用户 coding plan 的 anthropic 兼容端点）——mock 模式下跑的是真模型、
   计费走用户自己的 key，仅用于开发/演示。

   状态机（对齐两轴的服务端轴）：
   take → queued（FIFO position）；status 轮询触发晋级（轮询即 Promote）：
   取号超过 readyDelayMs → ready（readyDeadline = +readyTtlMs）；ready 超时未发首个
   message → expired；首个 message 准入 → active（activeDeadline = +activeMs）；
   active 到期 → expired，messages 返回 400/3102；settle → settled（幂等）。
   messages 准入前可注入 N 次 429/3105 + Retry-After（模拟资源满载细阀）。

   2026-10-30 拆分（onboard-b3 例外偿还）：共享票据状态的唯一所有者是
   off-peak/offPeakMockTicketStore 叶子；HTTP 处理器、messages 代理与 E2E 剧本
   分别在 ticketHandlers/messages/scenario 叶子，本体只留选项解析与路由装配。 */
import { createServer, type Server } from "node:http";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { json } from "#src/session/off-peak/offPeakMockHttp.js";
import { handleMockMessages } from "#src/session/off-peak/offPeakMockMessages.js";
import type { OffPeakMockScenarioName } from "#src/session/off-peak/offPeakMockScenario.js";
import {
  handleMockAvailability,
  handleMockSettle,
  handleMockStatus,
  handleMockTake,
} from "#src/session/off-peak/offPeakMockTicketHandlers.js";
import {
  createOffPeakMockTicketStore,
  type OffPeakMockGatewayConfig,
} from "#src/session/off-peak/offPeakMockTicketStore.js";

interface OffPeakMockGatewayOptions {
  /** queued→ready 的晋级延迟；默认 15s（演示低峰等待）。 */
  readyDelayMs?: number;
  /** ready 后须发首个 message 的窗口；默认 5min。 */
  readyTtlMs?: number;
  /** active 硬顶；默认 3h（调小可演示 400/3102 自动续跑）。 */
  activeMs?: number;
  /** 每张票准入前先回多少次 429/3105；默认 0。 */
  queue429Count?: number;
  /** 前 N 次取号直接回 3103（免费额度耗尽），用于验证错误提示后仍可重试；默认 0。 */
  quotaExhaustedCount?: number;
  /** availability 与真实取号保持不可用的时长；默认 0，E2E 用于验证服务端快照置灰。 */
  availabilityBlockedMs?: number;
  /** 429 的 Retry-After 秒数；默认 5。 */
  retryAfterS?: number;
  /** status/take 下发的 next_poll_after 秒数；默认 5。 */
  nextPollS?: number;
  /** 仅供确定性 E2E 使用的 messages 脚本；生产与普通 mock 演示均不设置。 */
  scenario?: OffPeakMockScenarioName;
}

interface OffPeakMockGatewayDeps {
  logger: ServiceLogger;
  /**
   * 准入后 messages 的转发目标：完整 messages URL + 出站头（含上游鉴权）。
   * 返回 null = 不代理，直接回一段固定的 Anthropic 响应（E2E/离线演示：agent loop 立即完成，
   * 不依赖真实模型 key）。
   */
  resolveUpstream: () => Promise<{
    url: string;
    headers: Record<string, string>;
  } | null>;
}

interface OffPeakMockGatewayHandle {
  origin: string;
  port: number;
  /** true = 端口已被另一个 host 的网关占用，本 handle 只是指向它（close 为 no-op）。 */
  external: boolean;
  close: () => Promise<void>;
}

export function isOffPeakMockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["ACODE_OFFPEAK_MOCK"] === "1";
}

/** 环境变量覆盖数值选项（真机演示用；测试直接传 options）。 */
function readEnvOptions(env: NodeJS.ProcessEnv): OffPeakMockGatewayOptions {
  const num = (key: string): number | undefined => {
    const raw = env[key];
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const scenarioValue = env["ACODE_OFFPEAK_MOCK_SCENARIO"];
  const scenario =
    scenarioValue === "foreground-subagents" ||
    scenarioValue === "capture" ||
    scenarioValue === "invalid-ticket"
      ? scenarioValue
      : undefined;
  return {
    ...(num("ACODE_OFFPEAK_MOCK_READY_DELAY_MS") !== undefined
      ? { readyDelayMs: num("ACODE_OFFPEAK_MOCK_READY_DELAY_MS") }
      : {}),
    ...(num("ACODE_OFFPEAK_MOCK_READY_TTL_MS") !== undefined
      ? { readyTtlMs: num("ACODE_OFFPEAK_MOCK_READY_TTL_MS") }
      : {}),
    ...(num("ACODE_OFFPEAK_MOCK_ACTIVE_MS") !== undefined
      ? { activeMs: num("ACODE_OFFPEAK_MOCK_ACTIVE_MS") }
      : {}),
    ...(num("ACODE_OFFPEAK_MOCK_QUEUE_429_COUNT") !== undefined
      ? { queue429Count: num("ACODE_OFFPEAK_MOCK_QUEUE_429_COUNT") }
      : {}),
    ...(num("ACODE_OFFPEAK_MOCK_QUOTA_COUNT") !== undefined
      ? { quotaExhaustedCount: num("ACODE_OFFPEAK_MOCK_QUOTA_COUNT") }
      : {}),
    ...(num("ACODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS") !== undefined
      ? {
          availabilityBlockedMs: num("ACODE_OFFPEAK_MOCK_AVAILABILITY_BLOCK_MS"),
        }
      : {}),
    ...(num("ACODE_OFFPEAK_MOCK_RETRY_AFTER_S") !== undefined
      ? { retryAfterS: num("ACODE_OFFPEAK_MOCK_RETRY_AFTER_S") }
      : {}),
    ...(num("ACODE_OFFPEAK_MOCK_NEXT_POLL_S") !== undefined
      ? { nextPollS: num("ACODE_OFFPEAK_MOCK_NEXT_POLL_S") }
      : {}),
    ...(scenario ? { scenario } : {}),
  };
}

/** 固定端口（可用 ACODE_OFFPEAK_MOCK_PORT 覆盖）：多窗口多 host 时共享同一份 mock 票据状态。 */
const DEFAULT_MOCK_PORT = 45_197;

export async function startOffPeakMockGateway(
  deps: OffPeakMockGatewayDeps,
  options?: OffPeakMockGatewayOptions & { port?: number },
): Promise<OffPeakMockGatewayHandle> {
  const config: OffPeakMockGatewayConfig = {
    readyDelayMs: 15_000,
    readyTtlMs: 5 * 60_000,
    activeMs: 3 * 60 * 60_000,
    queue429Count: 0,
    quotaExhaustedCount: 0,
    availabilityBlockedMs: 0,
    retryAfterS: 5,
    nextPollS: 5,
    ...readEnvOptions(process.env),
    ...options,
  };
  const store = createOffPeakMockTicketStore(config);
  const ticketCtx = { store, config, logger: deps.logger };
  const messagesCtx = {
    store,
    config,
    logger: deps.logger,
    resolveUpstream: deps.resolveUpstream,
  };

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "";
    void (async () => {
      if (
        req.method === "GET" &&
        url === "/__e2e/off-peak/requests" &&
        (config.scenario === "foreground-subagents" ||
          config.scenario === "capture" ||
          config.scenario === "invalid-ticket")
      ) {
        json(res, 200, {
          invalidTicketRequests: store.invalidTicketRequestCount(),
          requests: store.capturedRequests(),
        });
        return;
      }
      if (req.method === "GET" && url === "/api/v1/off-peak/ticket/availability") {
        handleMockAvailability(ticketCtx, res);
        return;
      }
      if (req.method !== "POST") {
        json(res, 405, { msg: "method not allowed" });
        return;
      }
      if (url === "/api/v1/off-peak/ticket") {
        await handleMockTake(ticketCtx, req, res);
        return;
      }
      if (url === "/api/v1/off-peak/ticket/status") {
        await handleMockStatus(ticketCtx, req, res);
        return;
      }
      const settleMatch = /^\/api\/v1\/off-peak\/ticket\/([^/]+)\/settle$/.exec(url);
      if (settleMatch) {
        handleMockSettle(ticketCtx, res, decodeURIComponent(settleMatch[1]!));
        return;
      }
      if (url === "/api/v1/off-peak/anthropic/v1/messages") {
        await handleMockMessages(messagesCtx, req, res);
        return;
      }
      json(res, 404, { msg: `no mock route for ${url}` });
    })().catch((error) => {
      deps.logger.warn(undefined, "mock gateway handler failed:", error);
      try {
        json(res, 500, { msg: "mock gateway internal error" });
      } catch {
        // 响应已发出，忽略。
      }
    });
  });

  const requestedPort =
    options?.port ??
    (Number(process.env["ACODE_OFFPEAK_MOCK_PORT"]) > 0
      ? Number(process.env["ACODE_OFFPEAK_MOCK_PORT"])
      : DEFAULT_MOCK_PORT);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      // 多窗口：另一个 host 已起网关，共用它的票据状态（票在共享 sqlite 里跨 host 流转，
      // mock 状态必须单实例，否则 A 取的票在 B 的网关查不到）。
      const origin = `http://127.0.0.1:${requestedPort}`;
      deps.logger.info(undefined, `off-peak mock gateway reusing existing instance at ${origin}`);
      return {
        origin,
        port: requestedPort,
        external: true,
        close: async () => {},
      };
    }
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("off-peak mock gateway failed to bind");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  deps.logger.info(undefined, `off-peak mock gateway listening at ${origin}`);
  return {
    origin,
    port: address.port,
    external: false,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
