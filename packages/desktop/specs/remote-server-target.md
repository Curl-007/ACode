# 远端连接类型：server（附着到已运行的 ACode/ZCode Server）

新增 `server` 远端连接类型：不再走「部署 + stdio 拉起」远端 server，而是直接 WebSocket 附着到一个已经在运行的 ACode/ZCode server（`<url>/ws` RPC，可选 token 鉴权）。复用既有 `RemoteTarget` / `RemoteTargetSnapshot` / 远端会话历史 / 连接向导抽象，不新建并行体系。

## 产品规则

- **server kind 是平台无关的**：不像 WSL 受 Windows 桌面门控、Docker 受守护进程探测门控，server 入口始终展示。
- 连接表单字段：`url`（必填，http/https/ws/wss 均可）、`name`（可选展示名）、`token`（可选，对应 server 的 `ACODE_SERVER_AUTH_TOKEN`）、`workspacePath`（可选默认工作目录，留空则连上后再选目录）。
- **token 是 secret**：只存在于当前连接流程内存态。落盘快照（`ServerRemoteTargetSnapshot`）与跨进程 descriptor 永不写原始 token，只写 `tokenCredentialKey`，恢复时再从 `ICredentialService` 读取——与 SSH `passwordCredentialKey` 同款。传输时 token 一律经 `Authorization: Bearer` 头（server-info 与 /ws 升级握手两处一致），不写 URL query（安全修复 M5，见 `provisioning-transport-encryption-gate.md`）。
- **明文 ws:// 连接不触发 Provider Provisioning**：连接建立时 Main 按传输加密分类决定是否注册 provisioning lane；ws:// 整体跳过同步并告警（信封携带解密后的明文凭据，replace-allowlist 语义下也无法安全降级为仅配置），见 `provisioning-transport-encryption-gate.md`。
- 附着前用 `/api/server-info` 校验协议版本与能力（`serverRemoteInfoSchema` 的 `protocolVersion: literal(1)`、`capabilities.desktopContinuous/websocketRpc: literal(true)` 已用 zod literal 固定，safeParse 失败即视为不兼容并给出明确连接错误，不允许半开信道）。
- server kind **没有 stdio backend**：不部署、不 detect、不 handshake、不能经 `createRemoteBackend`。prompt 附件不在 host 侧 eager 物化（无 `backend.exec/upload`），直接复用 server 经 RPC 暴露的 `promptAttachmentTransferService`（与纯 Web 附着同模型）。
- server kind 不提供「在外部编辑器打开」（无 VS Code Remote-SSH/WSL URI），`createOpenInEditorRemoteTarget` 返回 `undefined`；也不纳入 RemoteSyncActions（仅 ssh/wsl）。
- 连接复用键按归一化 URL（像 ssh/wsl），不用 docker 的 dedicated-per-session 键——两个窗口附着同一 server URL 复用一个逻辑会话。
- Web 端（`packages/web`）的 `connectRemote` 维持 `success:false` 占位：纯 Web 自身已是到本机 server 的 WebSocket，再连 server kind 概念冗余，本 spec 不建并行 Web 体系。

## 状态所有者与写入路径

- **类型/校验唯一来源**：`packages/shared`。`RemoteTarget`（连接态，含 token）、`RemoteTargetSnapshot`（持久态，含 tokenCredentialKey 不含 token）、`remoteTargetSchema`（IPC/协议边界 zod 门）、`remoteWorkspaceTargetSchema`（settings.json 持久化 zod 门）四处同步新增 server 成员。
- **secret 剥离唯一路径**：`stripRemoteTargetSecrets` 新增 server 分支剥 `token`；任何进入 descriptor/snapshot/telemetry/日志的 target 都先过它。
- **身份构造唯一工具**：`buildRemoteWorkspaceIdentity`（shared）与 `getRemoteWorkspaceAuthorityKey`（ui/remoteWorkspaceHistory）对 server 都委派同一对 shared 助手 `resolveServerIdentityId` + `normalizeServerIdForIdentity`，保证两端 authority 字节一致。格式：`remote:server:<normalizedServerId>:<posixPath>`，单 authority 段，复用通用解析循环。
- **端点归一唯一实现**：`normalizeServerEndpoint`（新 shared 助手，ws→http/wss→https、清 hash/search、去尾斜杠、去尾 `/ws`）。`remoteEnvironmentKey`、`resolveServerIdentityId`、desktop main 的 `isSameRemoteTarget` 全部 import 它——消除 desktopRemoteSessions.ts 里原有的私有副本。
- **token 凭据所有者**：`ICredentialService`，键 `remote-workspace:<workspaceKey>:token`（新 `buildRemoteWorkspaceTokenCredentialKey`）。`collectRemoteWorkspaceCredentialKeys` 对 server 返回该键，移除历史时一并清理，避免孤儿。
- **host 连接生命周期所有者**：窗口级 `windowRemoteConnectionRegistry`。server kind 经新模块 `serverRemoteConnection.ts` 建立 ws 附着，返回 `RemoteConnection` 形态（services/client/dispose/disposeAndWait）但 **不带 backend**；`HostRemoteConnection.backend` 因此改为可选。ws close（code/reason/wasClean）映射进既有 `WindowRemoteConnectionCloseEvent`（exitCode/signal/error），复用同一收口链路。

## 接口

- `packages/shared/src/remoteTarget.ts`：`ServerConnectOptions`（kind/url/name?/token?/workspacePath?/serverId?）+ 并入 `RemoteTarget` + `stripRemoteTargetSecrets` server 分支。
- `packages/shared/src/serverEndpoint.ts`（新）：`normalizeServerEndpoint(url)`、`resolveServerIdentityId({serverId?,name?,url})`、`normalizeServerIdForIdentity(id)`；由 `index.ts` re-export。
- `packages/shared/src/validation.ts`：`serverConnectOptionsSchema`（url=z.string().url()，其余 optional）并入 `remoteTargetSchema`。
- `packages/shared/src/protocol.ts`：`ServerRemoteTargetSnapshot`（token→tokenCredentialKey）并入 `RemoteTargetSnapshot`。
- `packages/shared/src/validationAppSettings.ts`：`remoteWorkspaceTargetSchema` 新增 server 变体（含 tokenCredentialKey）。
- `packages/shared/src/remote-workspace-identity.ts`：kind 加 "server"、`AUTHORITY_SEGMENTS.server=1`、kind guard、`buildRemoteWorkspaceIdentity` server 分支。
- `packages/shared/src/remoteEnvironmentKey.ts`：server 分支 `server:${serverId?.trim() || normalizeServerEndpoint(url)}`。
- `packages/shared/src/platform.ts`：`createOpenInEditorRemoteTarget` 返回类型改 `OpenInEditorRemoteTarget | undefined`，server→undefined。
- `packages/shared/src/test-ids.ts`：`TID_REMOTE_KIND_SERVER` + `TID_SERVER_URL_INPUT/NAME_INPUT/TOKEN_INPUT/WORKSPACE_PATH_INPUT`。
- `packages/ui`：`useRemoteConnectionForm`（buildAvailableKinds 无条件加 server + 四个字段 state/setter）、`remoteConnectionWizard`（snapshot 字段 + buildRemoteTarget server 分支：空 url→`server.validation.urlRequired`，`new URL` 抛错→`server.validation.invalidUrl`）、`RemoteConnectionFields`（server case 渲染四个 Input）、`RemoteConnectionDialogContent`（getKindIcon + kind-step data-testid + settings-step props）、`SSHDialog`（snapshot 透传）、`remoteWorkspaceHistory`（subtitle/header/authorityKey/snapshot 双向/token 凭据键/mutation 保存 token）、`reconnectRemoteWorkspaceHistoryEntry`（server token 恢复）、`reconnectingRemoteWorkspaceLogs`（server log suffix）、`RemoteConnectionConnectingStep`（feedback module 标签）、locales。
- `packages/desktop/src/main/desktopRemoteSessions.ts`：`normalizeServerRemoteUrlForComparison` 改为 import shared `normalizeServerEndpoint`；既有 `case "server"` 随 union 落地而激活。
- `packages/desktop/src/host/windowRemoteConnectionRegistry.ts`：`buildConnectionKey` server 分支（归一化 URL 复用）。
- `packages/desktop/src/host/serverRemoteConnection.ts`（新）：`connectToRemoteServerTarget(target, {signal, fetch, onClose})`——校验 server-info → 开 `ws` → `wrapNodeWebSocket`→`SocketProtocol`→`ChannelClient`→`RemoteServiceAccess`，返回无 backend 的 `RemoteConnection`。
- `packages/desktop/src/host/index.ts`：`HostRemoteConnection.backend` 改可选；`formatRemoteTargetForLog` server 分支（token 以 `[redacted]` 占位，绝不打印）；`createWindowRemoteConnectionHandle` 按 `backend` 是否存在分支 prompt-attachment 闭包与 capabilities。
- `packages/server/src/remote/create-backend.ts`：server 分支抛明确 typed 错误，守卫 deploy 路径。

## 事件顺序

```text
连接 server kind:
  向导 buildRemoteTarget → { kind:"server", url, name?, token?, workspacePath? }
    └─ main createRemoteWorkspaceSession（kind 无关，原样转发 target）
         └─ host connect-remote-workspace → createWindowRemoteConnectionHandle
              ├─ target.kind === "server"
              │    └─ connectToRemoteServerTarget:
              │         1. GET <base>/api/server-info（Authorization: Bearer <token> 头）→
              │            serverRemoteInfoSchema.safeParse
              │            （版本/能力不符或 authRequired 缺 token → 明确连接错误）
              │         2. new WebSocket(<wsBase>/ws, { headers: { authorization: Bearer } }) →
              │            wrapNodeWebSocket(ISocket)
              │            （安全修复 M5：token 不再走 URL query——Node ws 客户端支持自定义
              │            header，服务端 token 裁决 resolveServerTokenAuth 对升级请求同样
              │            优先读 Bearer 头，query 仅为浏览器客户端保留；
              │            见 provisioning-transport-encryption-gate.md）
              │         3. SocketProtocol → ChannelClient → RemoteServiceAccess
              │         4. 返回 { services, client, dispose, disposeAndWait }（无 backend）
              ├─ createRemoteWorkspaceServiceCollection（passthrough 附件 wrapper +
              │    RPC 暴露的 promptAttachmentTransferService，无 host 侧 eager 物化）
              └─ capabilities 不含 browserRecordingUploader（无 backend.upload）
    ws close(code/reason) → notifyClose({exitCode, signal:null, error}) → 既有 session-close 收口

恢复 server 历史:
  reconnectRemoteWorkspaceHistoryEntry → 读 tokenCredentialKey → createRemoteTargetFromSnapshot
    注入 token → 同上连接路径
```

## 验收

- `pnpm typecheck`（含 tsconfig.host.json）与 `pnpm lint` 0 新增错误；`src/main` 不在根 typecheck，单独跑 tsconfig.main.json 确认 desktopRemoteSessions 改动通过。
- 向导可选 server，填非法/空 url 给出对应校验文案；填合法 url 发起连接。
- token 不出现在 settings.json、descriptor、连接日志、feedback 文本中（`stripRemoteTargetSecrets` + `[redacted]` 日志 + redactFeedbackText）。
- 移除 server 历史时 token 凭据键被清理。
- server-info 协议/能力不匹配时连接以明确错误失败，不残留半开 ws。
- 注：本环境无运行中的 ACode/ZCode server，ws 附着的真实端到端联调未执行；实现复用 `connectRemoteUnchecked` 第 5 步与 `packages/web` bootstrap 的既有原语，并通过类型检查。
