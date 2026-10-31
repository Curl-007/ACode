import type { Context } from "hono";
import { IBotsService, type ServiceCollection } from "@acode/services";
import { botProviders, type BotProvider } from "@acode/shared";

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

/**
 * Bot 回调处理器工厂（2026-10-30 自 http.ts 拆出，行为不变）。
 * 鉴权语义不在这里：`/api/bots/*` 与全量 `/api/**` 一样受 http.ts 本体的 token
 * 中间件门控（配 token 部署里外部回调必然 401 的已登记限制，见 specs/server-auth.md
 * 「Bot 回调入口 × server token」与 server-auth.test.mjs R2 finding 8 钉住用例）。
 * 显式返回类型标注：hono 的 JSONRespondReturn 是 dist 内部类型，依赖推断会触发
 * TS2883 不可移植错误；处理器一律按 Response 收敛（c.json/c.body 均可赋值）。
 */
type BotCallbackHandler = (c: Context) => Promise<Response>;

export function createBotCallbackHandlers(services: ServiceCollection): {
  handleBotCallback: BotCallbackHandler;
  handleBotVerify: BotCallbackHandler;
} {
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

  return { handleBotCallback, handleBotVerify };
}
