# 跨环境 Provider Provisioning 的传输加密门槛（安全审计 M5）

## 背景

跨环境 provisioning 的信封（`providerProvisioningEnvelopeSchema`，schemaVersion 1）在源端
（桌面 Local Host）把 `credentials.json` 里的 allowlist 条目 **cipher.decrypt 解密后以明文**装入
`credentials[]`（scope：`oauth-session`（含 OAuth access/refresh token、`acodejwttoken`）、
`account-provider`、`provider-apikey`（P1-5 vault 化的 BYO Key 真值）），随后经连接 RPC
`target.apply(envelope)` 发往远端环境。

`server` kind 远端连接的传输协议由用户输入的 URL 决定（`resolveServerEndpoints`：非 `https:`
一律归 `ws:`），即 **ws:// 明文 WebSocket 是受支持的连接形态**。在 ws:// 连接上，信封里的全部
长期凭据明文过网，链路中间人可全量截获；此前没有任何门槛或警告，连接建立即 `initialSync`
（`desktopRemoteSessions.ts handleConnected` → `ProviderProvisioningEnvironmentCoordinator.register`），
且本地凭据/config 变化会经 `requestAll` 持续推送。这与 P1-5「明文不出 Host」的意图相悖
（对照 `packages/provider-node/specs/byo-apikey-credential-ref.md`）。

同链路顺带修复：`serverRemoteConnection.ts` 打开 `/ws` 时 token 经 URL query 注入。query 会泄漏进
代理/访问日志/历史；Node `ws` 客户端支持自定义 header（「标准 WebSocket API 无法携带 header」的
限制只适用于浏览器客户端），服务端全局 token 中间件对升级请求同样**优先读
`Authorization: Bearer` 头**（`packages/server/src/http.ts` 的 `app.use("*")` 覆盖 `/ws` 升级路径，
裁决本体 `resolveServerTokenAuth`（`@acode/shared/node` serverAuth）接受顺序 Bearer > cookie >
query 仅 `/ws*`；query 仅是浏览器客户端的保留兼容面），因此桌面客户端改走 header，不改服务端语义。

## 产品规则

### 传输加密分类（唯一判定实现：`src/main/remoteTargetTransportSecurity.ts`）

| RemoteTarget kind | 传输形态 | 判定 |
| --- | --- | --- |
| `ssh` | 远端 server 经 SSH 部署，RPC 走 SSH 子进程 stdio（加密隧道内） | **加密** |
| `wsl` | 同机 WSL distro，RPC 走本机进程 stdio 管道，不上网络 | **加密**（不受网络窃听威胁） |
| `docker` | 同机容器，RPC 走 `docker exec` stdio 管道，不上网络 | **加密**（同上） |
| `server` | WebSocket，协议由用户 URL 决定 | `https:`/`wss:` → **加密**；`http:`/`ws:`/其它协议/非法 URL → **未加密**（fail-closed） |

判定依据与 `resolveServerEndpoints`/`normalizeServerEndpoint` 的协议归一同源（ws→http、wss→https；
非 https 一律按明文处理）。SSH 远程（含经 SSH 部署的 server）属于加密链路形态，**不得误伤**。

### 门槛（唯一决策点：Main `desktopRemoteSessions.ts handleConnected`）

- provisioning 的**唯一调度入口**在 Main：`handleConnected` 里
  `providerProvisioningCoordinator.register(environmentKey, sessionId, execute)` 是信封被触发的
  唯一路径（`ProviderProvisioningExecute` 消息仅由本文件的 `executeProviderProvisioning` 发出；
  Host 侧 `syncLocalToRemote` 仅被该消息触发，不经 Renderer RPC 暴露）。
- 连接目标传输**未加密**时：**不注册** provisioning lane。效果：`initialSync` 不发生、后续
  source 变化的 `requestAll` 也到不了该环境——信封（含明文凭据与非敏感配置）整体不经明文链路。
  连接本身照常建立（attachment 直接进入既有就绪流程），远端已有配置/凭据保持原样。
- 跳过时必须双通道告警：
  - 结构化日志 `options.logger.warn`（生产可用事件，含 environmentKey/sessionId/原因，不含凭据）；
  - 连接日志 UI `emitConnectionLog(level:"warn")`（既有机制，用户可见），提示改用 wss:// 或 SSH。
- **为什么不降级为「只同步配置」**：schemaVersion 1 的目标端是 replace-allowlist 语义
  （`providerProvisioningTarget.apply` 会把信封未携带的 allowlist 键在远端**删除**）。
  `credentials: []` 的「仅配置」信封会清空远端已有的 OAuth/JWT/BYO Key 凭据——远端 personalConfig
  仍是 ref 形态，hydrate 得 null，BYO provider 静默失效（正是 P1-5 R2 修复过的回归），属于数据
  丢失，比不同步更糟。信封 schema 是 strict 且随已部署 server 存在版本偏差，无法在不动
  `packages/shared` 与远端兼容性的前提下表达「凭据域缺席」。因此未加密传输整体跳过；若未来需要
  「仅配置」降级，必须先给信封增加显式 `credentialsOmitted` 类字段（schemaVersion 演进）并让目标端
  区分「凭据为空」与「凭据域缺席」。

### token 传输（`src/host/serverRemoteConnection.ts`）

- `/ws` 升级握手的 token 一律经 `Authorization: Bearer <token>` 请求头（Node `ws` 客户端
  `ClientOptions.headers`），**不再写入 URL query**；`/api/server-info` 已是 header 形态（R2），
  两者对齐。
- token 仍绝不出现在日志、错误消息、descriptor、快照中（既有 `stripRemoteTargetSecrets` /
  `[redacted]` 约束不变）；去掉 query 后 `wsUrl` 对象本身也不再含 secret。
- 服务端不改：共享 token 裁决 `resolveServerTokenAuth`（`@acode/shared/node` serverAuth，原
  `hasValidLiteToken` 已提取至此）的读取顺序（Bearer > cookie > query）与 query 对浏览器客户端的
  兼容面保持原样。

## 状态所有者与写入路径

- **传输加密事实唯一所有者**：`remoteTargetTransportSecurity.ts` 的
  `resolveProvisioningTransportSecurity(target)`（纯函数，无 electron 依赖，可单测）。
- **门槛唯一决策点**：Main `handleConnected`（注册即调度，不注册即永不同步；不存在第二条触发路径）。
- Host 侧 `remoteProviderProvisioningService.ts` / `providerProvisioningSource.ts` 不变：它们只被
  Main 的消息驱动，门槛收口在调度层，避免两层各判一次形成平行路径。

## 事件顺序

```text
handleConnected(child, webContentsId, requestId, descriptor):
  routesBySessionId.set(sessionId, route)
  environmentKey = buildRemoteEnvironmentKey(descriptor.target)
  security = resolveProvisioningTransportSecurity(descriptor.target)
  ├─ security.encrypted:
  │    registration = coordinator.register(environmentKey, sessionId, execute)
  │    route.providerProvisioningDispose = registration.dispose
  │    registration.initialSync ──→ attachRendererPort("connect") ──→ pending.resolve
  └─ 未加密:
       logger.warn("[provider-provisioning] Skip sync over unencrypted transport", {...})
       emitConnectionLog(win, level:"warn", "…已跳过 Provider 配置与凭据同步…")
       Promise.resolve() ──→ attachRendererPort("connect") ──→ pending.resolve
       （该 environmentKey 无 lane；requestAll 对它无效果；断开无需 dispose）
```

## 验收

- `packages/desktop/tests/remote-target-transport-security.test.mjs`：
  1. ssh/wsl/docker → encrypted（SSH 隧道与同机 stdio 不误伤）；
  2. server + `wss://`/`https://` URL → encrypted；
  3. server + `ws://`/`http://`/未知协议/非法 URL → 未加密（fail-closed）；
  4. 源码不变量：`desktopRemoteSessions.ts` 的注册路径必须先经门槛判定（防止后续改动绕过）。
- `packages/desktop/tests/server-remote-connection-auth.test.mjs`：本地起真实 HTTP+WS server，
  `connectToRemoteServerTarget` 握手后断言升级请求带 `authorization: Bearer <token>` 头、URL query
  不含 token，且连接正常建立（server-info 请求同样走 header）。
- `pnpm --filter @acode/desktop test`、`tsc -p tsconfig.main.json`、`tsc -p tsconfig.host.json`
  零回归。
