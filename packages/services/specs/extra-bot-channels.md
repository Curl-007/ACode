# 额外 Bot 渠道：企业微信（wecom）与 Discord

为 Bot 接入新增两个 provider 的端到端能力：企业微信应用消息（HTTP 加密回调）与 Discord（出站 Gateway 长连接）。通用 `webhook` provider 已实现，本 spec 不涉及。

## 产品规则

- **wecom（企业微信自建应用）**：通过企业微信「接收消息」回调接入。入站为 HTTP 推送（GET URL 校验 + POST 加密消息），出站为企业微信 `message/send` 应用消息。需要 corpid、agentid、CorpSecret、回调 Token、EncodingAESKey 五项配置。
- **discord**：通过 Discord Bot Token 主动建立 Gateway 长连接（出站 wss）接收 `MESSAGE_CREATE`，出站为 Discord REST `POST /channels/:id/messages`。无需公网回调地址，适配 NAT/家用网络。
- 两者都只支持私聊语义：与现有 Bot 一致，群聊入站回复 `privateChatOnly`，绑定只在私聊生效。
- 回复颗粒度沿用非飞书默认（无 `streaming_card`），选项走纯文本编号 fallback。
- discord/wecom **不纳入**定时任务回推目标（`acodeAutomationBotDeliveryTargetSchema` 保持 feishu/lark/weixin），仅支持交互式入站/出站。

## 状态所有者与写入路径

- **配置唯一所有者**：`@acode/services` 的 `BotsRepo`（`bot-config.v3.json`）。新增可选字段：`wecomCorpId`、`wecomAgentId`、`wecomEncodingAESKey`。`credentialRef` 复用为 wecom CorpSecret / discord Bot Token；`webhookSecretRef` 复用为 wecom 回调 Token。字段全部可选，保持 `version: 3` 回滚兼容。
- **凭据所有者**：`ICredentialService`。CorpSecret（wecom）与 Bot Token（discord）经 `credentialValue` 走加密存储；回调 Token 经 `webhookSecretValue` 加密存储。
- **discord Gateway 运行态所有者**：`createDiscordChannelRuntime`，每个 bot 一个 `AbortController`，跨窗口由 `acquireDiscordGatewayLock`（token 维度）互斥——Discord 同一 token 拒绝第二个 Gateway 会话。wecom 为 HTTP 推送，无运行态、无锁。
- **回调安全边界所有者**：`createWeComBotProvider` 的 `prepareCallbackPayload`。SHA1 `msg_signature` 校验 + AES-256-CBC 解密 + receiveid 校验全部在 adapter 内完成；`botsService.processProviderCallback` 的通用 dispatch 不感知 wecom 加密细节。

## 接口

- `packages/shared/src/bots.ts`：`BotConfig` 接口与 `botConfigSchema`（`.strict()`）同步新增三个可选 wecom 字段。
- `packages/services/src/bots/providers/wecomProvider.ts`：`createWeComBotProvider({ loadCredential })` 实现 `BotProviderAdapter`（`prepareCallbackPayload`/`handleCallbackResponse`/`test`/`send`/`parseCallback`）。
- `packages/services/src/bots/providers/discordProvider.ts`：`createDiscordBotProvider({ loadCredential })` 实现 adapter（`test`/`resolveName`/`send`/`sendTyping`/`downloadAttachment`/`parseCallback`），并导出 `startDiscordGateway`（原始 Gateway：HELLO/IDENTIFY/heartbeat/ACK/dispatch）。
- `packages/services/src/bots/discordChannelRuntime.ts`：`createDiscordChannelRuntime(deps)`，结构对齐 `feishuChannelRuntime`（`runBot`/`reconcile`/`refresh`/`scheduleRefresh`/`stopGateway`/`dispose`），遵守 `runBackgroundTasks === false` 守卫。
- `packages/services/src/bots/channelRuntime.ts`：新增 `acquireDiscordGatewayLock(token, botId)`。
- `packages/services/src/bots/botsService.ts`：providers 注册表把 `discord`/`wecom` 从 `null` 换成真实 adapter；构造 `discordRuntime` 并接入 `saveConfig`/`saveBot`/`removeBotSecret`/`deleteBot`/`disposeAllAndWait`/启动 refresh；`BOT_EXCLUSIVE_CREDENTIAL_PROVIDERS` 增加 `discord`。
- `packages/server/src/http.ts`：放宽回调守卫允许 `wecom`；POST 透传 query（`msg_signature`/`timestamp`/`nonce`/`echostr`）与 `rawBody`；新增 `GET /api/bots/:provider/:botId` 校验路由，string responseBody 以 `text/plain` 返回 echostr 明文。

## 事件顺序

```text
wecom URL 校验:
  企业微信 GET ?msg_signature&timestamp&nonce&echostr
    └─ server GET 路由 → handleProviderCallbackResponse(wecom, {botId, query, acodeWecomVerify})
         └─ adapter.prepareCallbackPayload: SHA1 校验 → AES 解密 echostr → {acodeWecomVerifyEcho: 明文}
         └─ adapter.handleCallbackResponse: 返回 {responseBody: 明文, status:200}
    └─ server 以 text/plain 回明文 echostr

wecom 入站消息:
  企业微信 POST 加密 body + query(msg_signature/timestamp/nonce)
    └─ server POST → handleProviderCallbackResponse(wecom, {...body, rawBody, query, botId})
         └─ prepareCallbackPayload: 验签 → 解密 → 解析 XML/JSON 为消息记录
         └─ parseCallback → BotInboundMessage(actor.provider=wecom, providerUserId=FromUserName)
         └─ 通用业务处理 → adapter.send → WeCom message/send

discord 入站消息:
  Gateway 连接（持有 token 锁）
    └─ op10 HELLO → op2 IDENTIFY(intents) → 心跳循环(op1/op11 ACK)
    └─ op0 dispatch MESSAGE_CREATE → processProviderCallback(discord, {botId, event})
         └─ parseCallback → BotInboundMessage(actor.provider=discord, providerUserId=author.id, chatId=channel_id)
         └─ 通用业务处理 → adapter.send → POST /channels/:channel_id/messages
```

## 验收场景

- 配置 wecom bot（corpid/agentid/CorpSecret/Token/EncodingAESKey）后，企业微信后台 URL 校验返回明文 echostr 并通过。
- wecom 收到成员文本消息，验签+解密成功，Bot 正常回复；验签失败返回 401，不解密、不处理。
- 配置 discord bot（Token）后，Gateway 连接成功并显示运行状态；DM 文本消息触发 Bot 回复；自身/其他 bot 消息被忽略。
- 两个 ACode 窗口配置同一 discord token 时，只有一个持有 Gateway 锁，另一个显示「由另一个窗口处理」。
- `runBackgroundTasks === false` 的 desktop-attached 远端 host 不打开 discord Gateway。
- 删除/停用 discord bot 或移除其密钥时，Gateway 停止并释放跨窗口锁。
- discord/wecom 不出现在远程控制的 Bot Channel 快捷入口（仍可经「管理机器人」配置）。
- `pnpm typecheck` 与 `pnpm lint` 通过；`bot-config.v3.json` 读取不因新字段在 `.strict()` 下抛错。

## 安全与权衡

- EncodingAESKey 与 corpid/agentid 作为普通配置字段明文存储（沿用 change-map 取舍）。CorpSecret 与回调 Token 仍走加密凭据存储。后续可为 EncodingAESKey 增加第三个加密凭据槽，本次不做以控制改动面。
- discord Gateway 不实现 RESUME：连接断开后重新 IDENTIFY（新会话）。`BotState` 不新增 resume/sequence 字段。
