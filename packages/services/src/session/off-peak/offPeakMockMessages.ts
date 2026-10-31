/* off-peak mock 网关的 messages 端点：票据准入裁决后，E2E scenario 走剧本/捕获应答，
   否则把请求原样代理到 resolveUpstream() 指定的真实模型端点（SSE 透传）；
   无上游时回固定 Anthropic 响应让 agent loop 立即收尾。
   准入与状态迁移委托 offPeakMockTicketStore 叶子，本叶子不持有票据状态。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import { json } from "#src/session/off-peak/offPeakMockHttp.js";
import {
  buildForegroundSubagentScenarioResponse,
  classifyForegroundSubagentScenarioRequest,
  parseMockRequestJson,
  readRequestBoolean,
  readRequestNumber,
  readRequestString,
  respondWithAnthropicMock,
} from "#src/session/off-peak/offPeakMockScenario.js";
import type {
  OffPeakMockGatewayConfig,
  OffPeakMockTicketStore,
} from "#src/session/off-peak/offPeakMockTicketStore.js";

export interface OffPeakMockMessagesContext {
  store: OffPeakMockTicketStore;
  config: OffPeakMockGatewayConfig;
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

export async function handleMockMessages(
  ctx: OffPeakMockMessagesContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const ticketId = String(req.headers["x-off-peak-ticket-id"] ?? "");
  const now = Date.now();
  const admission = ctx.store.admitForMessages(ticketId, now);
  if (admission.kind === "invalid") {
    json(res, 400, { code: 3102, msg: "wrong off-peak ticket" });
    return;
  }
  if (admission.kind === "queued") {
    // 粗阀未开就来了 message：按细阀排队应答（客户端不应走到这，防御分支）。
    json(
      res,
      429,
      { code: 3105, msg: "not ready" },
      { "retry-after": String(ctx.config.retryAfterS) },
    );
    return;
  }
  if (admission.kind === "throttled") {
    json(
      res,
      429,
      { code: 3105, msg: "model concurrency saturated (mock)" },
      { "retry-after": String(ctx.config.retryAfterS) },
    );
    return;
  }
  if (admission.becameActive) {
    ctx.logger.info(
      undefined,
      `mock gateway admitted ticket=${ticketId} activeDeadline=${admission.ticket.activeDeadline}`,
    );
  }
  // admitted：原样代理到真实上游（SSE 透传）。
  const requestBody = await (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  })();
  const requestJson = parseMockRequestJson(requestBody);
  if (ctx.config.scenario === "foreground-subagents" || ctx.config.scenario === "capture") {
    const stage = classifyForegroundSubagentScenarioRequest(requestJson);
    const maxTokens = readRequestNumber(requestJson, "max_tokens");
    const model = readRequestString(requestJson, "model");
    ctx.store.captureRequest({
      hasApiKey: Boolean(req.headers["x-api-key"]),
      hasAuthorization: Boolean(req.headers.authorization),
      hasCodingPlanApiKey: Boolean(req.headers["x-coding-plan-api-key"]),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(model ? { model } : {}),
      requestJson,
      stage,
      ticketId,
      ...(typeof req.headers["bigmodel-organization"] === "string"
        ? { organization: req.headers["bigmodel-organization"] }
        : {}),
      ...(typeof req.headers["bigmodel-project"] === "string"
        ? { project: req.headers["bigmodel-project"] }
        : {}),
    });
    const scripted =
      ctx.config.scenario === "foreground-subagents"
        ? buildForegroundSubagentScenarioResponse(stage)
        : null;
    if (scripted) {
      respondWithAnthropicMock(res, scripted, readRequestBoolean(requestJson, "stream"));
      return;
    }
  }
  let upstream: { url: string; headers: Record<string, string> } | null;
  try {
    upstream = await ctx.resolveUpstream();
  } catch (error) {
    ctx.logger.warn(undefined, "mock gateway resolveUpstream failed:", error);
    upstream = null;
  }
  if (!upstream) {
    // 离线/E2E：回一段固定的非流式 Anthropic 响应，agent loop 立即拿到 stop 收尾。
    json(res, 200, {
      id: "msg_offpeak_mock",
      type: "message",
      role: "assistant",
      model: "offpeak-mock",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Off-peak mock run completed." }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    return;
  }
  try {
    const upstreamResponse = await fetch(upstream.url, {
      method: "POST",
      headers: {
        "content-type": String(req.headers["content-type"] ?? "application/json"),
        ...(req.headers["anthropic-version"]
          ? { "anthropic-version": String(req.headers["anthropic-version"]) }
          : {}),
        ...upstream.headers,
      },
      body: new Uint8Array(requestBody),
    });
    const responseHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, key) => {
      // hop-by-hop 头不透传。
      if (
        ["transfer-encoding", "connection", "content-length", "content-encoding"].includes(key)
      ) {
        return;
      }
      responseHeaders[key] = value;
    });
    res.writeHead(upstreamResponse.status, responseHeaders);
    if (!upstreamResponse.body) {
      res.end();
      return;
    }
    const reader = upstreamResponse.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (error) {
    ctx.logger.warn(undefined, "mock gateway upstream proxy failed:", error);
    json(res, 502, { code: 2001, msg: "mock upstream proxy failed" });
  }
}
