# conversation-share 删净（下线功能代码清除）

- 日期：2026-10-01
- 决策：删净（含读端）。依据 `packages/shared/src/officialPlatformPolicy.ts:5`「对话分享已整体下线——不提供开关，开启任何开关都不会恢复它」。本文是该删净的唯一范围与验收依据；执行前须与用户对齐本 spec。

## 1. 现状与判定

- 发布链路已死：`conversationShareSelectionStore` 的 `setScope`/`setPopoverOpen` 全仓无调用方，draft 恒为默认 `"all"`，`shareActive` 恒 false → SessionPane preflight/发布动作/全部浮层（SelectionDock/Panel/Scrim/ReopenTab/ConfirmationDock/SuccessDock/PermissionPicker）不可达；`conversationShare.trigger` i18n key 无代码引用。
- 深链导入已死：`acode://share/import` → `PlatformChannels.ShareImport` → `window.acode.onShareImport` 在 renderer 层零订阅者，链路断裂。
- 服务端运行时已被政策短路：`conversationShareHttpClient.ts:413` `assertConversationShareRemoved()` 使包括 `getCapabilities()` 在内的所有请求抛「已下线」。
- 仍活的部分（本次删净对象）：
  - 存量已导入会话只读块：snapshot `sharedContextImport` → `getImportedConversation` → `ConversationShareImportNotice` → `ConversationShareReadonlyTimeline`。
  - composer attach：`sharedContextRefs` 注入 → CLI `v4-bridge` pending→reserved→attached 状态机 + `discardSharedContext` 命令（命令本身已无 UI 调用方）。
  - desktop host attachment 包装与远程 workspace 独立注册。

## 2. 删除范围

### 2.1 整文件删除

| 域 | 文件 |
| --- | --- |
| services | `src/conversation-share/` 全目录 8 文件（conversationShare/Service/HttpClient/ArtifactDiscovery/ArtifactSource/Integrity/PublicProjection/sharedContextFormatter） |
| ui | `src/store/conversationShareSelectionStore.ts`；`src/ConversationSharePermissionPicker.tsx`；`src/v4/ConversationShare{ReadonlyTimeline,ImportNotice,ConfirmationDock,SuccessDock,SelectionDock,SelectionPanel,SelectionReopenTab,SelectionScrim}.tsx`；`src/v4/conversationShare{Attempt,ModeMotion,ModePolicy,PreflightCache,ScrollbarMetrics,SelectionPanelLayout,Markdown}.ts`；`src/v4/useConversationShareSelectionOutsideDismiss.ts`；`src/lib/conversationShareError.ts`；`src/lib/conversationShareContext.ts` |
| desktop | `src/host/conversationShareAttachmentService.ts` |
| shared | `src/conversation-share.ts` |

### 2.2 文件内摘除

- **ui**：`SessionPane.tsx`（imports/store 挂钩/eligible rows/preflight/导入读取与渲染/发布动作/浮层渲染/`shareSelection` 透传）；`ConversationTimeline.tsx`（`shareSelection` prop 与几何同步）；`ConversationTurnGroup.tsx`（勾选框与相关渲染）；`ConversationComposer.tsx`（`sharedContextRefs` 注入）；`ConversationRowView.tsx`（历史 share URL 尾块剥离）；`useAppPanels.ts`（share URL 嵌入式浏览器特判，统一走通用 `openBrowserSidePane`）；`i18n/locales/{zh-CN,en-US}.ts` 各 165 个 `conversationShare.*` key；`package.json` 的 `./conversation-share-readonly` 导出。
- **desktop**：`host/index.ts` overrides 接线；`remoteWorkspaceServiceCollection.ts`（import/构造/register）；`renderer/src/remoteWorkspaceSessionServices.ts`；`main/desktopDeepLinkUrl.ts`（SHARE_IMPORT_HOST/isShareImportUrl/extractShareImportCode）；`main/desktopOAuthDeepLink.ts`（share 分支投递与清理，**OAuth 回调路径不动**）；`preload/index.ts`；`renderer/src/desktopPlatform.ts`（onShareImport 转发）。
- **client**：`remoteServiceAccess.ts` 的 ConversationShare proxy。
- **services**：`node.ts`（HttpClient 构造/降级分支/register）；`index.ts:28-48` re-export；`accessor.ts`（可选字段）。
- **shared**：`channels.ts`（`ServiceChannels.ConversationShare`、`PlatformChannels.ShareImport` 及 payload）；`platform.ts` 的 `onShareImport?`；`officialPlatformPolicy.ts:132-139`（`isConversationShareAvailable`/`assertConversationShareRemoved`）；`acode-protocol/index.ts` 的 `source:"sharedContext"` 分支；`acode-protocol-v4/`（`shared-context-import.ts`、snapshot/delta 的 `sharedContextImport` 字段、`command.ts` 的 `discardSharedContext`）。
- **acode-cli**：`adapters` session-store 的 codecs/rows/SQL 写路径与 `commitSharedContextImportBundle`；`contracts` 端口 `SharedContextImport*` 类型与可选方法；`bootstrap` 的 `persistImportedSessionHistory` sharedContext 分支、`v4-bridge` 状态机、`cold-event-merge`、`v4-gateway` 事件、`commands` 的 discard 命令。
- **sharedContextRef 协议面（执行中追加）**：ui 注入与 CLI 状态机删除后成为零消费者，连带删除 `shared-context-ref.ts` 整文件、`command.ts` 的 `sendText.context_refs`、`input-intent.ts` 的 `sharedContextRefs`，以及 acode-cli 侧不可达透传链（session-flow/input-intent/prompt-turn/event-normalizer/input-facade/app types/session.port/core 的 turn 与 input-intent-persistence 与 runtime types/session-inputs 仓库）。
- **ui store 孤儿（执行中追加）**：`acodeSessionStoreTypes`/`acodeSessionStoreWorkspaceSlice` 的 `TimelineBottomRequest` 与 `requestTimelineBottom`（原服务 share 导入滚动）。
- **配置/文档/测试**：`.env.example` 的 `ACODE_CONVERSATION_SHARE_WEB_URL`；`packages/web/src/env.d.ts` 的 `VITE_CONVERSATION_SHARE_PREVIEW_MOCK`；`packages/web/src/main.tsx:174` no-op 桩；`packages/desktop/specs/no-official-platform-report.md:68-69`；`packages/desktop/tests/no-official-platform.test.mjs`（允许列表失效条目 + preflight/publish/importShare guard 断言同步移除）。

### 2.3 明确保留（勿删）

- `officialPlatformPolicy.ts:216-218` 的 `/(^|\/)share(\/|$)/` 路径拒绝与 `:244-255` 未登记路径出口拦截——防回连护栏。
- `packages/web/src/main.tsx` 的 `/cn/share/callback`、`/share/callback` 是 OAuth 回调路径，与对话分享无关。
- DB `sessions.share_url` 列与已发布 migration：**保留列与读取容忍、删除写入路径**，不新增 drop-column migration（存量库兼容，与 legacy schema 策略一致）。
- 用户磁盘上的 `.acode-share/`、`.acode-share-imports.json` 存量数据：代码不再读写，不主动清理用户数据。

## 3. 存量行为（删净后）

- 已导入会话：顶部只读块与「导入来源」提示消失；会话本体消息与 markdown 正文仍在 session 持久化中，正常打开与续聊不受影响。
- 存量会话快照中的 `sharedContextImport` 字段被忽略（schema 容忍读取，不再有消费者）。
- 打开旧 shareUrl：统一走嵌入式浏览器默认行为（无分享特判）。
- `session-history-hydrator` 保留 `shared_context` source 消息的 attached 过滤：该过滤只作用于存量导入消息且决定其是否进入模型历史（pending/reserved 上下文原不注入），删除会改变存量续聊语义，故保留并注释。
- DB `sessions.share_url` 列保留（migration 不动），decode 忽略、不再写入；新行落 NULL，存量值原样保留。
- `ai-elements` 库存组件 `agent.tsx` 依赖的 `ui/accordion.tsx` 属库存一部分（2026-10-01 决策保留库存），从第一批清理的删除中恢复。

## 4. 接口与所有权变化

- 移除 `IConversationShareService`、`ServiceChannels.ConversationShare`、`PlatformChannels.ShareImport`、`IPlatformService.onShareImport?`。
- `IServiceAccessor.conversationShareService?` 字段移除；services 根出口 28-48 行的 browser-safe re-export 移除。
- 状态唯一性不变更：会话投影、composer 草稿、Host owner/lease 均不因本次删除改变所有权。

## 5. 实施顺序

shared（协议/通道/policy）→ services（实现+注册+出口）→ client/desktop（proxy/接线/深链）→ ui（store/组件/接线/i18n）→ acode-cli（端口/状态机/持久化分支）→ 配置/文档/测试。

## 6. 验收

1. `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 零新增违反。
2. `git grep -i "conversationshare\|conversation-share"` 仅余：本 spec、no-official-platform 报告的历史记录（若保留）、DB 列读取容忍处、policy 路径护栏。
3. `packages/desktop/tests/no-official-platform.test.mjs` 更新后通过（guard 断言移除后仍守护其余官方服务短路）。
4. 场景回归：desktop 深链 OAuth 正常；嵌入式浏览器打开普通 URL 正常；普通会话时间线渲染/交互（勾选框移除后布局）正常；composer 发送消息正常；CLI 冷启动会话恢复正常；存量已导入会话打开正常（只读块消失、正文在）。
