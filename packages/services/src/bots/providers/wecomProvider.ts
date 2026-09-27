import { Buffer } from "node:buffer";
import type {
  BotConfig,
  BotInboundMessage,
  BotOutboundMessage,
  BotProviderCallbackResult,
} from "@acode/shared";
import type { BotProviderAdapter } from "./types.js";
import { fetchBotProviderJson } from "#src/bots/providers/providerRequest.js";
import {
  decryptWeComMessage,
  readWeComXmlField,
  verifyWeComSignature,
} from "./wecomCrypto.js";

const WECOM_API_BASE = "https://qyapi.weixin.qq.com";
const WECOM_ACCESS_TOKEN_TTL_MS = 7_000 * 1_000; // 企业微信 access_token 有效期 7200s，提前刷新。

interface WeComProviderDeps {
  loadCredential(key: string): Promise<string | null>;
}

interface WeComTokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

interface WeComQuery {
  msg_signature?: string;
  timestamp?: string;
  nonce?: string;
  echostr?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readWeComQuery(payload: unknown): WeComQuery {
  if (!isRecord(payload)) {
    return {};
  }
  const query = isRecord(payload.acodeWecomQuery) ? payload.acodeWecomQuery : null;
  return {
    msg_signature: readString(query, "msg_signature"),
    timestamp: readString(query, "timestamp"),
    nonce: readString(query, "nonce"),
    echostr: readString(query, "echostr"),
  };
}

async function loadToken(
  bot: BotConfig,
  deps: WeComProviderDeps,
): Promise<string | null> {
  return bot.credentialRef ? deps.loadCredential(bot.credentialRef) : null;
}

async function loadCallbackToken(
  bot: BotConfig,
  deps: WeComProviderDeps,
): Promise<string | null> {
  return bot.webhookSecretRef ? deps.loadCredential(bot.webhookSecretRef) : null;
}

function buildWeComText(message: BotOutboundMessage): string {
  return message.text;
}

/** 解析企业微信回调解密后的消息 XML/JSON 为 BotInboundMessage。 */
function readWeComInbound(botId: string, decrypted: string): BotInboundMessage | null {
  const isXml = decrypted.trimStart().startsWith("<");
  const fromUser = isXml
    ? readWeComXmlField(decrypted, "FromUserName")
    : readJsonField(decrypted, "FromUserName");
  const msgType = isXml
    ? readWeComXmlField(decrypted, "MsgType")
    : readJsonField(decrypted, "MsgType");
  const content = isXml
    ? readWeComXmlField(decrypted, "Content")
    : readJsonField(decrypted, "Content");
  const messageId = isXml
    ? readWeComXmlField(decrypted, "MsgId")
    : readJsonField(decrypted, "MsgId");
  // 企业微信应用消息目前只处理成员发来的文本；事件/图片等留待后续扩展。
  if (!fromUser || msgType !== "text" || !content.trim()) {
    return null;
  }
  return {
    botId,
    text: content,
    actor: {
      provider: "wecom",
      botId,
      providerUserId: fromUser,
      displayName: fromUser,
      chatType: "private",
      providerMessageId: messageId || undefined,
    },
  };
}

function readJsonField(decrypted: string, field: string): string {
  try {
    const parsed = JSON.parse(decrypted) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  } catch {
    return "";
  }
}

export function createWeComBotProvider(deps: WeComProviderDeps): BotProviderAdapter {
  // access_token 缓存按 corpId+secret 维度；同一进程内复用，过期或失效再刷新。
  const tokenCache = new Map<string, { token: string; expiresAt: number }>();

  async function fetchAccessToken(bot: BotConfig): Promise<string> {
    const corpId = bot.wecomCorpId?.trim();
    const secret = await loadToken(bot, deps);
    if (!corpId || !secret?.trim()) {
      throw new Error("WeCom corpid and corp secret are required.");
    }
    const cacheKey = `${corpId}:${Buffer.from(secret).toString("base64")}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }
    const url = `${WECOM_API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret.trim())}`;
    const response = await fetchBotProviderJson<WeComTokenResponse>(url);
    const payload = response.payload;
    if (!response.ok || !payload || payload.errcode !== 0 || !payload.access_token) {
      throw new Error(
        `WeCom gettoken failed: ${payload?.errmsg ?? `HTTP ${response.status}`}`,
      );
    }
    tokenCache.set(cacheKey, {
      token: payload.access_token,
      expiresAt: Date.now() + WECOM_ACCESS_TOKEN_TTL_MS,
    });
    return payload.access_token;
  }

  return {
    async test(bot) {
      if (!bot.credentialRef) {
        return { ok: false, message: "WeCom corp secret is missing." };
      }
      if (!bot.wecomCorpId?.trim()) {
        return { ok: false, message: "WeCom corpid is missing." };
      }
      try {
        await fetchAccessToken(bot);
        return { ok: true, message: "WeCom API is reachable." };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async send(bot: BotConfig, message: BotOutboundMessage) {
      const accessToken = await fetchAccessToken(bot);
      const agentId = bot.wecomAgentId?.trim();
      if (!agentId) {
        throw new Error("WeCom agentid is missing.");
      }
      const response = await fetchBotProviderJson<WeComTokenResponse>(
        `${WECOM_API_BASE}/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            touser: message.providerUserId,
            msgtype: "text",
            agentid: Number(agentId),
            text: { content: buildWeComText(message) },
          }),
        },
      );
      const payload = response.payload;
      if (!response.ok || payload?.errcode !== 0) {
        throw new Error(
          `WeCom message/send failed: ${payload?.errmsg ?? `HTTP ${response.status}`}`,
        );
      }
    },

    /**
     * 回调安全边界：SHA1 msg_signature 验签 + AES-256-CBC 解密 + receiveid 校验。
     * GET URL 校验解密 echostr 并通过 acodeWecomVerifyEcho 交给 handleCallbackResponse 回明文。
     * POST 入站消息解密后把明文挂到 acodeWecomDecrypted，供 parseCallback 消费。
     */
    async prepareCallbackPayload(bot: BotConfig, payload: unknown) {
      if (!isRecord(payload)) {
        return payload;
      }
      const query = readWeComQuery(payload);
      const token = await loadCallbackToken(bot, deps);
      const encodingAESKey = bot.wecomEncodingAESKey?.trim();
      const corpId = bot.wecomCorpId?.trim();
      if (!token?.trim() || !encodingAESKey || !corpId) {
        return { acodeCallbackPrepareError: "WeCom callback is not fully configured." };
      }
      const isVerify = payload.acodeWecomVerify === true;
      const cipherBase64 = isVerify
        ? query.echostr ?? ""
        : readWeComXmlField(String(payload.rawBody ?? ""), "Encrypt") ||
          readWeComXmlField(String(payload.rawBody ?? ""), "encrypt");
      if (!cipherBase64 || !query.msg_signature || !query.timestamp || !query.nonce) {
        return { acodeCallbackPrepareError: "WeCom callback signature parameters are missing." };
      }
      if (
        !verifyWeComSignature(
          query.msg_signature,
          token.trim(),
          query.timestamp,
          query.nonce,
          cipherBase64,
        )
      ) {
        return { acodeCallbackPrepareError: "WeCom callback signature verification failed." };
      }
      let decrypted: { message: string; receiveid: string };
      try {
        decrypted = decryptWeComMessage(encodingAESKey, cipherBase64);
      } catch (error) {
        return {
          acodeCallbackPrepareError: `WeCom callback decrypt failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      // receiveid 必须等于 corpid，否则密文被发往错误应用（中间人/配置串台）。
      if (decrypted.receiveid !== corpId) {
        return { acodeCallbackPrepareError: "WeCom callback receiveid mismatch." };
      }
      if (isVerify) {
        return { ...payload, acodeWecomVerifyEcho: decrypted.message };
      }
      return { ...payload, acodeWecomDecrypted: decrypted.message };
    },

    async handleCallbackResponse(
      _bot: BotConfig,
      payload: unknown,
    ): Promise<Pick<BotProviderCallbackResult, "responseBody" | "status"> | null> {
      if (!isRecord(payload) || payload.acodeWecomVerify !== true) {
        return null;
      }
      const echo = typeof payload.acodeWecomVerifyEcho === "string" ? payload.acodeWecomVerifyEcho : "";
      // URL 校验必须把解密后的明文 echostr 原样返回，企业微信据此判定校验成功。
      return { responseBody: echo, status: echo ? 200 : 401 };
    },

    parseCallback(payload: unknown): BotInboundMessage[] {
      if (!isRecord(payload)) {
        return [];
      }
      const botId = readString(payload, "botId");
      const decrypted = readString(payload, "acodeWecomDecrypted");
      if (!botId || !decrypted) {
        return [];
      }
      const inbound = readWeComInbound(botId, decrypted);
      return inbound ? [inbound] : [];
    },
  };
}
