# Server 鉴权与信任主机能力（server-auth）

本 spec 描述 ACode 两类 HTTP/WS server 实现（`packages/server` 通用 Web 服务、
`packages/acode-server-cli` Server Core）共用的**鉴权模型**与**信任主机能力（trusted-host
capability）**铸造/兑换规则，对应安全加固方案的 P0-1（无鉴权铸造 + WS 无 Origin 校验）与
P0-2（鉴权 fail-closed + token 走 Header 不走 query）。

落地前遵循 AGENTS.md 的 spec-first：本文件先于代码定义产品规则、状态所有者、接口与验收场景。

## 背景与裁决

- **两套 server 实现已分叉**：`packages/server/src/hostCapability.ts` 与
  `packages/acode-server-cli/src/server-core/hostCapability.ts` 是两份等价的一次性 ticket 实现，
  其注释自陈「依赖边界禁止从 `@acode/server` 的入口导入实现，因此保留一份等价副本」。架构策略
  （`architecture-policy.yaml`）确实禁止 `server` ↔ `acode-server-cli` 互相导入，但**两者都依赖
  `shared`**。因此本 spec 把「能力铸造/兑换」「鉴权 fail-closed 不变量」「Origin/Host 校验」收敛到
  `@acode/shared/node` 单一实现，两套 server 共用，**消除分叉**而不是再各加一份兜底。
- **`@acode/shared` 主入口被浏览器 bundle 引用**：鉴权原语用到 `node:crypto`（随机 nonce、指纹、
  定长比较），属 Node-only，必须放在 `@acode/shared/node` 子路径（该子路径已声明「不得被
  renderer/browser bundle 导入」），不进主入口。
- **loopback 无 token 是受支持的默认姿态**：`README` 记载「Web 模式默认 127.0.0.1 无 token」。
  本 spec 保留该默认，但收紧为：(1) 默认绑定 host 从「未指定=所有网卡」改为「未指定=loopback」，
  (2) loopback 无 token 时启动打印**醒目告警**，(3) **非 loopback 绑定且无 token 一律拒绝启动**。
- **浏览器是 loopback 上的真实攻击面**：即使 server 只听 loopback，恶意网页也能让受害者浏览器
  向 `127.0.0.1:<port>` 发起 WebSocket 升级（DNS-rebinding / 本机恶意页面）。`/ws/host` 兑换会把
  连接提升为 `trusted-host-relay` 并跳过客户端握手，故该路径必须做 Origin/Host 校验。

## 产品规则

### 鉴权（P0-2）

- **token 来源优先级**：`Authorization: Bearer <token>` 头为首选；`acode_lite_token` cookie 为浏览器
  兼容路径；`?token=<token>` query 的 HTTP 路由兼容窗**已关闭**（R2，批次 4：原承诺「仍接受一个
  版本」自 e5f0fe1 起算，本版本移除）——HTTP 路由出示合法 query token 一律 401，并打印一次性
  「已移除」告警指明迁移路径；query 的**唯一保留面**是 `/ws*` 升级握手，因为标准 WebSocket API
  无法携带自定义 header（desktop 附着链路 `serverRemoteConnection.ts` 的 info fetch 已同步迁移到
  Bearer 头，仅 WS 握手保留 query）。cookie 回写（旧 query 命中后 Set-Cookie 迁移）随 HTTP query
  面一并移除：101 升级响应上的 Set-Cookie 无消费方。
- **受保护路径**：`/ws`、`/ws/**`、`/api/**`（含 `/api/server-info`）在配置了 token 时必须携带合法凭据；
  其余路径（静态资源、SPA fallback）不强制（理由见「静态资源路径收敛」一节）。客户端把
  `/api/server-info` 的 401 判定为「需要 token」（desktop `serverRemoteConnection.ts` 依赖该行为），
  无 token 部署下 `server-info` 自报 `authRequired:false` 供客户端预判。
- **鉴权环境变量唯一名 `ACODE_SERVER_AUTH_TOKEN`（M2 修复）**：全仓不再有任何代码消费
  `ACODE_SERVER_TOKEN`。历史缺陷：`createServerInfo` 的 `authRequired` fallback 读 `ACODE_SERVER_TOKEN`，
  而真实强制点（`entry-http.ts` → `options.authToken` → 全局中间件）只读 `ACODE_SERVER_AUTH_TOKEN`——
  按文档配置旧变量名会得到「server-info 自报已鉴权、实际无鉴权」。修复后 server-info 的
  `authRequired = options.authRequired ?? Boolean(实际挂载中间件的 authToken)`，不读任何环境变量，
  如实反映强制状态；文档与类型注释（`remoteTarget.ts`、`remote-server-target.md`）同步改名。
- **token 裁决单一实现（M1 配套）**：cookie 名/解析/安全解码、凭据接受顺序（Bearer > cookie >
  query 仅 `/ws*` 升级路径）、受保护路径判定收敛到 `@acode/shared/node` serverAuth
  （`resolveServerTokenAuth` / `readPresentedServerToken` / `isTokenProtectedPathname`），
  `packages/server` 与 Server Core 共用；任一侧不得另写接受顺序或 cookie 解码。
- **`/ws` 升级前 Origin/Host 裁决（P0-3，与 `/ws/host` 同源同规则）**：普通 `/ws` 升级（terminal-client /
  web-remote 客户端）在鉴权之后、升级之前调用同一个 `resolveRequestOriginTrust`——无 `Origin`（原生客户端）
  放行；loopback origin 与显式白名单放行；携带浏览器 `Origin` 但不在白名单返回 403。理由与
  `/ws/host` 相同：WebSocket 握手不受 CORS 限制，默认 loopback 无 token 配置下恶意网页可直连
  `ws://127.0.0.1:<port>/ws` 以客户端身份调用全部暴露服务（含文件/终端），Origin 裁决是该姿态下的
  唯一浏览器侧屏障；仓库内无浏览器调用方直连 `/ws`，对合法流程零影响。
- **fail-closed 启动不变量**：解析后的绑定 host 非 loopback 且未配置 token（`authRequired` 为假）时，
  `createHttpServer` / `createCoreHttpServer` **在 listen 之前抛错拒绝启动**，错误信息指明「非 loopback
  绑定需要鉴权」。loopback 绑定无 token 允许启动，但打印「无鉴权·仅本机」告警。
- **默认绑定 host**：`packages/server` 的 HTTP 入口在 `ACODE_SERVER_HOST`/`HOST` 均未设置时默认
  `127.0.0.1`（此前未指定即绑定所有网卡，属 fail-open，本 spec 收紧为 loopback 默认）。

### 信任主机能力（P0-1）

- **铸造受鉴权门控**：`POST /api/rpc-host-capability` 在 server 处于「需要鉴权」配置时，必须携带合法
  token 才能铸造；未鉴权请求返回 401。
- **铸造受 Origin 门控（且必须在 `issue()` 之前）**：两套 server 的铸造端点都在铸造**之前**做
  `resolveRequestOriginTrust` 裁决，浏览器 `Origin` 非白名单 → 403。原因：默认无 token 的 loopback
  配置下该端点无鉴权，而浏览器跨源 POST 属于不需要 CORS 预检的 simple request——恶意网页即使读不到
  响应也能触发 `issue()` 占槽位。若把 Origin 校验放在铸造之后，攻击者仍可灌满
  `MAX_LIVE_HOST_CAPABILITIES` 个槽位令合法桌面 host 吃 503，等于把「内存耗尽 DoS」换成「可用性 DoS」；
  放在之前则恶意网页连槽位都占不到。原生客户端（Node `ws` / 进程内 fetch）不带 Origin，放行。
  本端点在仓库内**无浏览器调用方**，故该门控对合法流程零影响。
- **能力绑定已认证主体**：铸造时把能力（一次性 nonce）与**已认证主体指纹**绑定（指纹为 token 的
  sha256 前缀，**永不含原始 token**；未配置 token 的 loopback 场景主体为 `anonymous`）。
- **单次兑换 + 短 TTL**：能力默认 TTL 30s，仅存活于 server 进程内存。兑换（`/ws/host` 升级）时
  无论成功、过期还是重放都先作废该 nonce，只有首次且未过期的兑换返回绑定主体；二次兑换同一能力失败。
- **`/ws/host` 升级前 Origin/Host 校验**：在消费能力之前校验升级请求来源——
  - 允许：无 `Origin` 头（原生客户端，如 Node `ws` / SSH 隧道内的 desktop host）；loopback origin
    （`http(s)://127.0.0.1|localhost|[::1]:<任意端口>`）；显式配置的 origin 白名单。
  - 拒绝：携带浏览器 `Origin` 但不在白名单（返回 403），防 DNS-rebinding / 恶意网页驱动升级。
  - `Host` 头存在时同样校验为 loopback 或配置白名单，进一步收敛 DNS-rebinding。
- **响应线协议不变**：铸造响应仍是 `{ capability, expiresAt }`（`serverRemoteHostCapabilitySchema`
  为 `.strict()`）；主体绑定是 server 内部状态，不上 wire。

### Server Core token 鉴权（M1 修复）

- **接入与 `packages/server` 同源的 token 能力**：`createCoreHttpServer` 的 token 解析顺序为
  `options.authToken?.trim() || process.env.ACODE_SERVER_AUTH_TOKEN`（trim 后为空视为未配置）。
  配置了 token 时：
  - 挂**全局 token 中间件**，裁决逻辑与 `packages/server` 完全同源（同一个
    `resolveServerTokenAuth`）：受保护路径 = `/ws*` 与 `/api/**`；HTTP 路由出示合法 `?token=` →
    401 + 一次性迁移告警；`/ws*` 升级握手保留 query 面（标准 WebSocket API 无法携带自定义头，
    desktop `serverRemoteConnection.ts` 依赖 `/ws?token=`）。
  - `/api/server-info` 的 `authRequired` 如实上报 `Boolean(authToken)`。
  - 能力铸造绑定已认证主体指纹（`fingerprintPrincipal(authToken)`）；`/ws/host` 的
    `resolveHostCapabilityBinding` 传入**真实**的 `configuredToken` / `readPresentedServerToken(...)`
    ——即 P0-1 注释预告的「接入 token middleware 时必须同步改那两个实参」，本次兑现，主体绑定
    从恒放行变为活动屏障。
  - `assertServerAuthInvariant` 的 `authRequired` 反映真实 token 状态（此前写死 `false`）。
- **缺省姿态不变**：未配置 token 时保持 loopback 无 token 行为（与 `packages/server` 一致），
  但启动告警对齐——listen 成功后经 `createServiceLogger` 打印与 `packages/server` 同一串的
  `describeNoAuthLoopbackWarning(host)`。

### 静态资源路径收敛与匿名静态面（M10 修复）

- **目录包含判定必须拒绝跨盘符逃逸**：Windows 上 `path.win32.relative(root, candidate)` 在两者
  位于**不同盘符根**时原样返回 candidate 的绝对路径（不以 `..` 开头）。旧判定
  `!relative.startsWith("..")` 因此把 `GET /C:/Windows/win.ini`（staticRoot 在 D: 时）误判为
  「目录内」→ 任意文件读取。新判定：`rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))`，
  跨盘符与 `..` 逃逸一律拒绝（返回 404，不进入 fs）。
- **静态路由保持匿名（决定与理由，不纳入 token 保护面）**：静态资源与 SPA fallback **不**加入
  `isTokenProtectedPath`。理由：(1) 浏览器无法为 `<script>`/`<img>` 等子资源请求附加
  `Authorization` 头，cookie 也只在登录流程完成后才存在——把静态面纳入 token 保护会让配了
  token 的 Web 部署无法完成首屏加载与登录；(2) 数据面（`/api/**`、`/ws*`）已被 token 全量保护，
  静态面只回送 Web 构建产物。静态面的安全边界 = 本节的 staticRoot 严格包含判定。
  **风险登记**：若部署把 `staticRoot`/`ACODE_WEB_STATIC_ROOT` 误配到敏感目录，该目录内文件将
  匿名可读——部署要求 staticRoot 只指向 Web 构建产物目录（本次不改行为，仅登记）。

### `/api/connect-remote` Origin 裁决与累积上限（M11 修复）

- **与 capability 铸造、三处 WS 升级同一裁决**：`POST /api/connect-remote` 在解析 body 与产生
  任何副作用**之前**调用同一个 `resolveRequestOriginTrust`——浏览器 `Origin` 非白名单 → 403。
  根因：hono `c.req.json()` 不校验 Content-Type，跨源 `text/plain` simple POST 免 CORS 预检即可
  执行 `createRemoteBackend`（触发真实 SSH 外联 / WSL / Docker spawn）；配 token 的非 loopback
  部署下 `/api/**` 虽被中间件保护，但默认 loopback 无 token 姿态下 Origin 裁决是唯一浏览器侧
  屏障。原生客户端（无 Origin）不受影响。
- **未认领连接累积上限**：`remoteConnections` 条目只在 `/ws/remote/:id` 认领时删除，盲刷可累积
  真实后端连接（DoS）。新增 `MAX_PENDING_REMOTE_CONNECTIONS`（有界常量）：待认领条目达上限时
  新请求 → 503。**风险登记**：本次不引入 TTL 定时驱逐（避免新增定时器所有权问题）；陈旧未认领
  条目存活至进程重启，Origin 裁决已封死浏览器攻击者，loopback 姿态下原生本地进程属既有信任边界。

### Credential RPC 通道按客户端角色收窄（M4 修复）

- **威胁**：`ICredentialService` 是全仓明文凭据面（OAuth access token、JWT、BYO API Key、
  MCP token、bot secret），此前经 `exposeOnChannelServer` 无差别注册给**每条** WS 连接——默认
  loopback 无 token 姿态下，本机任意进程/恶意网页可 dump 全部凭据。
- **收窄点在传输注册层（单一所有者），不改 credential 服务本体**：`packages/server` 的
  `setupChannelServer` 与 Server Core 的 `exposeWebSocket` 按 `clientMode` 收窄，模式与既有
  `IProviderProvisioningTargetService` 先例一致（`exposeOnChannelServer` 的 overrides）：
  - `desktop-continuous`（受信 Desktop Host 中继）：**保持全量**——desktop renderer 登录态
    （`useCredentials.ts` 拉明文 OAuth token）与 remote-workspace token 凭据流
    （`remote-workspace:*` 键）依赖完整读写。
  - `web-remote-replayable`（terminal-client，含纯 Web 客户端）：仅放行
    `TERMINAL_CLIENT_CREDENTIAL_ALLOWED_KEYS` 内键的 **load**；`save`/`delete` 与 allowlist 外键
    一律拒绝（抛错经 RPC 回传）。
- **allowlist 证据**（grep `packages/web`、`packages/ui` 的全部 `ICredentialService`/`useCredentials`
  消费点）：Web 客户端经该通道的真实消费只有登录态读取——`ModelProviderSection.tsx`
  （`oauth:active_provider`、`oauth:zai:access_token`、`oauth:bigmodel:access_token`）与
  `useCodingPlanEntryPlanList.ts`（`oauth:bigmodel:access_token`、`oauth:zai:access_token`）。
  Web 自身 OAuth 登录态存浏览器 localStorage（`BrowserOAuthCredentialRepo`），不经此通道；
  `remote-workspace:*` 凭据流在 Web 被 `allowRemoteWorkspace=false` 关闭，desktop 侧走本地 host
  通道不受影响。故 allowlist 为上述 3 键、只读；宁严勿松。
  **legacy 键 `auth_token` 明确排除（取证于本轮修复）**：唯一消费点是
  `useCredentials.ts:39/:61` 的 bigmodel 兜底 load/delete，而其宿主 `useAuthToken`/`useCredentials`
  两个 hook 在全仓（ui/web/desktop/shared/formal-proof/acode-cli 源码面）**零调用点**，仅剩定义与
  `hooks/index.ts`、`ui/src/index.ts` 两处导出桶——remote web（terminal-client）不可达该分支；
  Root 的 `useTokenRefresh` 只经 `oauthService`（独立通道）刷新/登出，不触碰 Credential 通道。
  故不预先放行（测试断言 guard 对该键显式拒绝）；若将来 `useAuthToken` 出现真实调用方，
  须按届时的新证据重新评估 allowlist，而不是现在放宽。
- **单一实现**：allowlist 与 guard 工厂收敛在 `@acode/shared/node`
  （`createTerminalClientCredentialGuard`），两套 server 共用，不允许任一侧另写键列表。


## 状态所有者与写入路径

- **能力 ticket 唯一所有者**：`@acode/shared/node` 的 `createHostCapabilityStore()` 返回的内存 store
  （`Map<nonce, { expiresAt, principal }>`）。铸造写入、兑换读取并即时删除；无第二条写入路径，
  不落盘、不跨进程共享。两套 server 各自持有一个 store 实例，但**类型与语义同源**。
- **鉴权配置唯一所有者**：进程启动入参 / 环境变量（`packages/server`：`ACODE_SERVER_AUTH_TOKEN`、
  `ACODE_SERVER_HOST`、`ACODE_SERVER_ALLOWED_ORIGINS`；Server Core：`options.authToken` 优先、
  fallback `ACODE_SERVER_AUTH_TOKEN`，host 缺省 loopback）。运行期不变更；`createServerInfo` /
  Core `info` 据实际挂载中间件的 token 派生 `authRequired`，不读其它变量。
- **待认领远程连接唯一所有者**：`packages/server` 进程内 `remoteConnections` Map；写入仅
  `/api/connect-remote`（Origin 裁决 + 上限之后），删除仅 `/ws/remote/:id` 认领时；不落盘。
- **terminal-client 凭据 allowlist 唯一所有者**：`@acode/shared/node` 的
  `TERMINAL_CLIENT_CREDENTIAL_ALLOWED_KEYS`；两套 server 的传输注册层引用同一常量。
- **主体指纹**：由 token 派生（`sha256(token)` 前 16 hex），仅在 store 内部与日志中出现，不存原始 token。

## 接口

- `packages/shared/src/node/serverAuth.ts`（新增，`@acode/shared/node` 导出）：
  - `isLoopbackBindHost(host: string): boolean` —— `127.0.0.1`/`localhost`/`::1`/`[::1]` 为真，
    `0.0.0.0`/`::`/其它为假。**入参为已解析的具体 host 字符串**（调用方需先把「未指定」归一为默认值，
    server 默认 loopback）；不接受 `undefined`（传 `undefined` 会在 `.trim()` 处抛错）。
  - `assertServerAuthInvariant(input: { host: string; authRequired: boolean }): void` —— 非 loopback host
    且 `authRequired` 为假时抛 `Error`（fail-closed）。
  - `describeNoAuthLoopbackWarning(host: string): string` —— loopback 无 token 的醒目告警文案（两套 server 共用同一串）。
  - `timingSafeTokenEquals(provided: string | undefined, expected: string): boolean` —— 定长比较，长度不等直接假。
  - `parseBearerToken(header: string | undefined): string | undefined` —— 解析 `Authorization: Bearer <token>`。
  - `fingerprintPrincipal(token: string): string` —— `sha256(token)` 前 16 hex；不含原始 token。
  - `resolveRequestOriginTrust(input: { origin?: string | null; host?: string | null; allowedOrigins?: readonly string[] }): { allowed: boolean; reason?: "origin" | "host" }`
    —— 敏感入口（`/ws/host` 升级与 `POST /api/rpc-host-capability` 铸造）的 Origin/Host 裁决。
    **入参没有 `allowedHosts`**：Host 白名单由 `allowedOrigins` 内部派生（取其 host 部分）再叠加
    loopback，不由调用方单独提供。（原名 `resolveUpgradeRequestTrust`；因铸造端点不是升级请求，
    改名为 origin 语义。）
  - `resolveHostCapabilityBinding(input: { boundPrincipal: HostCapabilityPrincipal; configuredToken?: string | null; presentedToken?: string | null }): { allowed: boolean; reason?: "principal-mismatch" }`
    —— **主体绑定的实际执行点**。对抗评审核实：此前 `consume()` 的返回值被两处调用点丢弃（只做真值判断），
    绑定形同虚设。本 helper 比较能力上绑定的主体指纹与本次升级出示 token 的指纹：配置了 token 时不一致 →
    `allowed:false`（回 403）；未配置 token（loopback 无鉴权）→ `allowed:true`（主体恒为 anonymous，
    绑定不提供屏障，真实边界是 loopback 绑定 + fail-closed + 告警）。两套 server 共用此 helper 以保证
    结构一致、不易漏改；Server Core 接入 token 后（M1 修复）两侧都传**真实**的
    `configuredToken` 与 `readPresentedServerToken(...)`——未配置 token 时 `configuredToken` 为空，
    helper 按约定放行（anonymous 主体，屏障仍是 loopback + fail-closed + 告警）。
  - **本 helper 在 packages/server 单 token 模型下的实际价值**：能到达 `/ws/host` 升级中间件的请求必然已通过
    全局 token 中间件（即 `presented == authToken`），而铸造时绑定的正是 `fingerprint(authToken)`，
    故当前 `presented == bound` 恒成立——「A 铸造、B 兑换」的主体混淆威胁需要 2 个以上不同 token，
    本 server 尚不具备。这条校验是面向将来多 token 模型的**结构性防回归**，而非当下的活动屏障。
  - `SERVER_LITE_TOKEN_COOKIE_NAME`、`isWebSocketUpgradePathname(pathname)`、
    `isTokenProtectedPathname(pathname)` —— cookie 名与受保护路径判定的单一定义
    （`/ws`、`/ws/**`、`/api/**`）。
  - `resolveServerTokenAuth(view: { authorizationHeader?; cookieHeader?; url }, expectedToken): { valid; viaDeprecatedQuery }`
    —— 请求 token 裁决单一实现（自 `packages/server` http.ts 提取，语义不变）：Bearer >
    `acode_lite_token` cookie（对称 `decodeURIComponent`，失败回退原值不抛 URIError）> `?token=`
    query（仅 `/ws*` 升级路径有效；HTTP 路由出示合法 query → `{valid:false, viaDeprecatedQuery:true}`
    供调用点打一次性迁移告警）。
  - `readPresentedServerToken(view): string | undefined` —— 本次请求实际出示的 token
    （Bearer > cookie > query），与 `resolveServerTokenAuth` 同源读取，供主体绑定校验使用。
- `packages/shared/src/node/credentialChannelAccess.ts`（新增，`@acode/shared/node` 导出）：
  - `TERMINAL_CLIENT_CREDENTIAL_ALLOWED_KEYS`：terminal-client 可 load 的键 allowlist
    （`oauth:active_provider`、`oauth:zai:access_token`、`oauth:bigmodel:access_token`，
    由 `ZAI_PROVIDER_ID`/`BIGMODEL_PROVIDER_ID` 拼接，证据见产品规则 M4 节）。
  - `isTerminalClientCredentialKeyAllowed(key)`。
  - `createTerminalClientCredentialGuard(real)`：把真实凭据服务包成收窄代理——allowed 键 load
    委派真实服务，其余 load/save/delete 抛错；结构化类型（不依赖 `@acode/services`，保持
    shared → 无上游依赖方向）。两套 server 的传输注册层共用。
- `packages/shared/src/node/hostCapability.ts`（新增，`@acode/shared/node` 导出，取代两套 server 的本地副本）：
  - `HostCapabilityPrincipal = { fingerprint: string }`；`ANONYMOUS_HOST_CAPABILITY_PRINCIPAL`。
  - `HostCapabilityStore.issue(principal?: HostCapabilityPrincipal): ServerRemoteHostCapability | null`
    —— 存活条目达 `MAX_LIVE_HOST_CAPABILITIES` 时返回 `null`（调用点回 503），堵住无鉴权铸造端点
    被恶意网页跨源狂刷、把内存 Map 撑爆的 DoS（对抗评审 #2）。满了**拒绝**而非淘汰最旧——淘汰会让
    攻击者能定向踢掉合法桌面 host 尚未兑换的能力，把「耗尽内存」变成「拒绝服务合法连接」。
  - `HostCapabilityStore.consume(capability: string | undefined): HostCapabilityPrincipal | null`
    —— 返回 null 表示无效/过期/重放；返回主体表示兑换成功。**调用点必须**把返回主体交给
    `resolveHostCapabilityBinding` 校验，不得只做 `if (!store.consume(x))` 真值判断（那正是此前绑定形同虚设的原因）。
  - `createHostCapabilityStore(options?)`（`options.maxLive` 可注入更小上限供测试）、`DEFAULT_HOST_CAPABILITY_TTL_MS`、`MAX_LIVE_HOST_CAPABILITIES`。
- `packages/server/src/http.ts`：
  - 鉴权中间件按 Bearer > cookie > `?token=`（弃用告警）顺序校验；裁决本体委派共享
    `resolveServerTokenAuth`，http.ts 只保留 hono Context → 请求视图的适配层与一次性告警。
  - `isInsideDirectory(root, candidate)`：`relative()` 结果既不以 `..` 开头也**非绝对路径**才算
    目录内（Windows 跨盘符时 `relative` 原样返回绝对路径，旧判定会误放行 → M10 修复）；
    `resolveStaticFile` 的两处包含判定都经它。
  - `createServerInfo(options, resolvedAuthToken)`：`authRequired = options.authRequired ??
    Boolean(resolvedAuthToken)`，不读环境变量（M2 修复；`ACODE_SERVER_TOKEN` fallback 已删除）。
  - `POST /api/connect-remote`：先 `resolveRequestOriginTrust` 裁决（拒绝 403，先于 body 解析与
    backend spawn），再 schema 校验；`remoteConnections` 待认领条目达
    `MAX_PENDING_REMOTE_CONNECTIONS` → 503（M11 修复）。
  - `setupChannelServer`：`clientMode !== "desktop-continuous"` 时对 Credential 通道挂
    `createTerminalClientCredentialGuard` 收窄（overrides，与 Provisioning 先例同模式）（M4 修复）。
  - `readPresentedLiteToken` 委派共享 `readPresentedServerToken`，确保鉴权与主体绑定对
    「出示的是哪个 token」给出完全一致的答案（含 `%XX` / 裸 `%` cookie 编码 token）。
  - `POST /api/rpc-host-capability`：鉴权配置下经中间件门控；**先 `resolveRequestOriginTrust` 裁决**
    （浏览器非白名单 Origin 返回 403，且必须在 `issue()` 之前以免占槽位），再铸造并传入已认证主体指纹；
    store 返回 `null`（达存活上限）时回 **503**。
  - `/ws/host`：先 `resolveRequestOriginTrust` 裁决（拒绝返回 403），再 `consume` 能力（失败 401），
    **最后 `resolveHostCapabilityBinding` 校验主体**（配置了 token 且不匹配返回 403）。
  - `/ws`（普通升级）：鉴权之后、升级之前 `resolveRequestOriginTrust` 裁决（拒绝返回 403），
    规则与 helper 与 `/ws/host` 完全同源；两套 server 行为一致。
  - `createHttpServer` 在 `serve()` 前调用 `assertServerAuthInvariant`；loopback 无 token 打印告警；
    host 未指定时默认 `127.0.0.1`。
  - 新增 `allowedOrigins?` 选项 + `ACODE_SERVER_ALLOWED_ORIGINS`（逗号分隔）解析。
- `packages/server/src/entry-http.ts`：host 默认 `127.0.0.1`；透传 `allowedOrigins`。
- `packages/acode-server-cli/src/server-core/http.ts`：删除本地 `isLoopbackHost`/throw 与本地 capability
  副本，改用 `@acode/shared/node` 的 `assertServerAuthInvariant` 与 `createHostCapabilityStore`；`/ws/host`
  同样加 Origin/Host 校验与 `resolveHostCapabilityBinding`；铸造达上限同样回 503。
  M1 修复后：`options.authToken ?? env ACODE_SERVER_AUTH_TOKEN` 存在时挂全局 token 中间件
  （共享 `resolveServerTokenAuth` + `isTokenProtectedPathname`），`server-info.authRequired` 如实，
  铸造绑定主体指纹，`resolveHostCapabilityBinding` 传真实 `configuredToken`/`presentedToken`；
  无 token 时 loopback 默认姿态不变并打印 `describeNoAuthLoopbackWarning`。
  M4 修复后：`exposeWebSocket` 对非 desktop clientMode 挂 `createTerminalClientCredentialGuard`。

## 验收场景

1. **无 token 铸造被拒（auth required）**：配置 token 后，`POST /api/rpc-host-capability` 不带凭据 → 401。
2. **恶意 Origin 升级被拒**：`/ws/host` 携带 `Origin: http://evil.test` → 403（在消费能力之前拒绝）。
3. **能力不可二次兑换**：铸造一个能力，首次 `/ws/host` 兑换成功（或经 store.consume 返回主体），
   第二次兑换同一能力失败（store.consume 返回 null / HTTP 401）。
4. **非 loopback + 无 token 拒绝启动**：`createHttpServer({ host: "0.0.0.0" })` 且未配 token → 抛错，不 listen。
5. **Authorization 头鉴权通过**：`Authorization: Bearer <token>` 访问受保护路径 → 200。
6. **`?token=` 仍可用但告警**：`?token=<token>` 访问受保护路径 → 200，且记录一次弃用告警。
7. **loopback origin 升级放行**：`/ws/host` 携带 `Origin: http://127.0.0.1:<port>` + 合法能力 → 不被 Origin 门拒绝。
8. **fail-closed 不变量两套 server 同源**：Server Core 与通用 server 复用同一 `assertServerAuthInvariant`，
   非 loopback 无 token 行为一致（回归测试断言共享实现，不允许任一侧另起兜底）。
9. **能力存活上限有界（对抗评审 #2）**：store 存活条目达 `MAX_LIVE_HOST_CAPABILITIES`（测试可注入更小 `maxLive`）时
   `issue()` 返回 null；兑换/过期释放名额后恢复可铸造。`MAX_LIVE_HOST_CAPABILITIES` 是有界正常数。
   铸造端点达上限回 503（堵住无鉴权 loopback 端点被恶意网页跨源刷爆内存的 DoS）。
10. **主体绑定被实际执行（对抗评审 #1）**：`resolveHostCapabilityBinding` 比较能力绑定主体与升级请求出示主体——
    配置 token 时不一致返回 `{allowed:false, reason:"principal-mismatch"}`（`/ws/host` 回 403），
    出示同一 token 放行，配了 token 但本次未出示任何 token 也拒绝；未配置 token（loopback anonymous）放行。
    两套 server 共用该 helper，消除「consume() 返回值被丢弃、绑定形同虚设」的疏漏。
11. **铸造 Origin 门在 `issue()` 之前、不占槽位（对抗评审 + fork 复核的残留 DoS）**：恶意 `Origin` 的
    `POST /api/rpc-host-capability` → 403，且连续 300 次被拒后，无 Origin 的原生铸造仍 200
    （证明被拒请求没有消耗能力槽位、无法把合法桌面 host 挤成 503）。两套 server 同源验证。
12. **cookie 编码 token 跨中间件与绑定一致**：含 `%XX` / 裸 `%` / UTF-8 百分号编码的 token，经 query 铸造
    回写 cookie 后，仅带 cookie 再次铸造仍 200，且用它做原生 `/ws/host` 升级不被 403（principal-mismatch）
    或 500（URIError）——证明 `readLiteTokenCookie` 让鉴权与主体绑定对同一 cookie 给出一致答案。
13. **`/ws` 恶意 Origin 被拒（P0-3）**：`/ws` 升级携带 `Origin: http://evil.test` → 403；无 `Origin` 的原生
    客户端（Node `ws`）升级正常；loopback origin（`http://127.0.0.1:<port>`）放行。两套 server 同源验证
    （`packages/server` 与 Server Core 行为一致，共用同一 helper，不允许任一侧另起兜底分支）。
14. **跨盘符静态路径被拒（M10）**：以 win32 路径语义 + 内存 fs stub 注入 http.ts——staticRoot 在
    `D:\web` 时 `GET /C:/Windows/win.ini` → 404 且**不得**返回文件内容（旧判定下会 200 泄漏）；
    同盘目录内合法文件仍 200；`%2e%2e` 编码的 `..` 逃逸不得返回 staticRoot 外内容（落入 SPA fallback）。
    测试必须 OS 无关（CI 为 ubuntu，用 `path.win32` 注入验证纯函数语义）。
15. **connect-remote Origin 裁决（M11）**：携带 `Origin: http://evil.test` 的
    `POST /api/connect-remote` → 403，且不进入 body 解析/backend spawn；无 Origin（原生）→ 正常进入
    body 校验；loopback Origin → 不被 Origin 门拒绝。
16. **connect-remote 累积上限（M11）**：待认领连接条目达 `MAX_PENDING_REMOTE_CONNECTIONS` 后新请求 → 503。
17. **server-info 如实上报（M2）**：只传 `authToken`（不传 `authRequired`）→ server-info
    `authRequired:true`；进程 env 只设 legacy `ACODE_SERVER_TOKEN` → `authRequired:false`
    （旧代码会误报 true）；`packages/server/src/http.ts` 源码不再含 `"ACODE_SERVER_TOKEN"` 字面量；
    全仓（除历史文档）无其它 `ACODE_SERVER_TOKEN` 消费点。
18. **Credential 通道收窄（M4）**：`/ws`（web-remote-replayable）连接的 overrides 含 credential
    guard——allowlist 键 load 委派真实服务，allowlist 外键 load 与任何 save/delete 抛错；
    `/ws/host`（desktop-continuous）连接无 credential 收窄（保持全量）。两套 server 同源验证。
19. **Server Core token 鉴权（M1）**：配置 token（option 或 `ACODE_SERVER_AUTH_TOKEN` env）后——
    无凭据访问 `/api/server-info`、`/api/rpc-host-capability`、`/ws` → 401；`Authorization: Bearer`
    → 200 且 `authRequired:true`；`/ws?token=` 升级握手 → 101；错误 token → 401。未配置 token 时
    行为与现状一致（server-info 匿名可读、`authRequired:false`）并打印同源 no-auth loopback 告警。
20. **token 裁决单一实现（M1 配套）**：两套 server 源码都调用共享 `resolveServerTokenAuth` /
    `readPresentedServerToken` / `isTokenProtectedPathname`（静态断言），不允许任一侧内联第二份
    接受顺序或 cookie 解码。

测试遵循仓库既有「不变量守护」风格（`packages/desktop/tests/no-telemetry.test.mjs`、
`apps/acode-cli/tests/no-telemetry.test.mjs`）：仅用临时端口 / loopback / 内存 fixture，
**绝不**读写、迁移或删除真实 `~/.acode` 或任何真实用户凭据，测试内不绑定公网网卡。
