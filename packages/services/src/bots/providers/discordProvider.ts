import type {
  BotConfig,
  BotInboundAttachment,
  BotInboundMessage,
  BotOutboundMessage,
} from "@acode/shared";
import type { BotProviderAdapter, BotTypingTarget } from "./types.js";
import {
  fetchBotProvider,
  fetchBotProviderJson,
} from "#src/bots/providers/providerRequest.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_MESSAGE_CHAR_LIMIT = 2_000;

interface DiscordProviderDeps {
  loadCredential(key: string): Promise<string | null>;
}

interface DiscordCurrentUser {
  id?: string;
  username?: string;
  global_name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function readNumber(record: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function splitDiscordText(text: string): string[] {
  const limit = DISCORD_MESSAGE_CHAR_LIMIT;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks.length > 0 ? chunks : [text];
}

function inferDiscordAttachmentKind(contentType: string, filename: string): BotInboundAttachment["kind"] {
  const normalized = `${contentType} ${filename}`.toLowerCase();
  if (normalized.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp)$/u.test(filename)) {
    return "image";
  }
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return "file";
}

function readDiscordAttachments(event: Record<string, unknown>): BotInboundAttachment[] {
  if (!Array.isArray(event.attachments)) {
    return [];
  }
  return event.attachments
    .filter(isRecord)
    .map((value, index): BotInboundAttachment | null => {
      const url = readString(value, "url");
      const id = readString(value, "id") || url || `discord-${index + 1}`;
      const filename = readString(value, "filename") || `discord-attachment-${index + 1}`;
      const mimeType = readString(value, "content_type") || "application/octet-stream";
      const kind = inferDiscordAttachmentKind(mimeType, filename);
      if (!url) {
        return null;
      }
      const sizeBytes = readNumber(value, "size");
      return {
        id,
        kind,
        filename,
        mimeType,
        ...(sizeBytes !== null ? { sizeBytes } : {}),
        downloadUrl: url,
      };
    })
    .filter((attachment): attachment is BotInboundAttachment => attachment !== null);
}

/** 把 MESSAGE_CREATE 事件映射为 BotInboundMessage；非消息事件或自身/bot 消息返回 null。 */
function readDiscordInbound(
  botId: string,
  eventType: string,
  event: Record<string, unknown>,
): BotInboundMessage | null {
  if (eventType !== "MESSAGE_CREATE") {
    return null;
  }
  const author = isRecord(event.author) ? event.author : null;
  const authorId = readString(author, "id");
  // Discord Gateway 会把 bot 自己（以及其他 bot）发出的消息也推回；不忽略会形成回环。
  if (!authorId || author?.bot === true) {
    return null;
  }
  const channelId = readString(event, "channel_id");
  const content = readString(event, "content");
  const attachments = readDiscordAttachments(event);
  if (!channelId || (!content.trim() && attachments.length === 0)) {
    return null;
  }
  // DM/群 DM 消息没有 guild_id；guild 频道消息带 guild_id，按群聊处理（仅私聊语义可用）。
  const guildId = readString(event, "guild_id");
  const isPrivate = !guildId;
  const messageId = readString(event, "id");
  return {
    botId,
    text: content,
    ...(attachments.length > 0 ? { attachments } : {}),
    actor: {
      provider: "discord",
      botId,
      providerUserId: authorId,
      displayName: readString(author, "global_name") || readString(author, "username") || undefined,
      chatType: isPrivate ? "private" : "group",
      // createOutbound 以 chatId ?? providerUserId 作为发送目标；Discord 回复目标是频道 id。
      chatId: channelId,
      providerMessageId: messageId || undefined,
    },
  };
}

export function createDiscordBotProvider(deps: DiscordProviderDeps): BotProviderAdapter {
  async function loadToken(bot: BotConfig): Promise<string | null> {
    return bot.credentialRef ? deps.loadCredential(bot.credentialRef) : null;
  }

  async function getCurrentUser(bot: BotConfig): Promise<DiscordCurrentUser | null> {
    const token = await loadToken(bot);
    if (!token?.trim()) {
      return null;
    }
    const response = await fetchBotProviderJson<DiscordCurrentUser>(
      `${DISCORD_API_BASE}/users/@me`,
      { headers: { Authorization: `Bot ${token.trim()}` } },
    );
    return response.ok ? (response.payload ?? {}) : null;
  }

  return {
    async test(bot) {
      if (!bot.credentialRef) {
        return { ok: false, message: "Discord bot token is missing." };
      }
      const user = await getCurrentUser(bot);
      if (!user) {
        return { ok: false, message: "Discord users/@me failed." };
      }
      return {
        ok: true,
        name: user.global_name || user.username || undefined,
        message: "Discord bot is reachable.",
      };
    },

    async resolveName(bot) {
      const user = await getCurrentUser(bot);
      return user ? user.global_name || user.username || null : null;
    },

    async send(bot: BotConfig, message: BotOutboundMessage) {
      const token = await loadToken(bot);
      if (!token?.trim()) {
        return;
      }
      const channelId = message.providerUserId;
      if (!channelId) {
        return;
      }
      for (const text of splitDiscordText(message.text)) {
        if (!text) {
          continue;
        }
        await fetchBotProvider(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bot ${token.trim()}`,
          },
          body: JSON.stringify({ content: text }),
        });
      }
    },

    async sendTyping(bot: BotConfig, target: BotTypingTarget) {
      const token = await loadToken(bot);
      if (!token?.trim() || !target.providerUserId) {
        return;
      }
      await fetchBotProvider(`${DISCORD_API_BASE}/channels/${target.providerUserId}/typing`, {
        method: "POST",
        headers: { Authorization: `Bot ${token.trim()}` },
      });
    },

    parseCallback(payload: unknown): BotInboundMessage[] {
      if (!isRecord(payload)) {
        return [];
      }
      const botId = readString(payload, "botId");
      const eventType = readString(payload, "eventType");
      const event = isRecord(payload.event) ? payload.event : null;
      if (!botId || !event) {
        return [];
      }
      const inbound = readDiscordInbound(botId, eventType, event);
      return inbound ? [inbound] : [];
    },
  };
}
