# OAuth 授权码流 PKCE（S256）：参数注入与 verifier 生命周期

安全加固 P2-6。为账号登录的授权码流补充 PKCE 防护，收敛 deep-link 回调被同机应用抢注/劫持授权码的攻击面。

## 背景

账号登录是授权码 + 自定义协议回调（`zcode://oauth/callback`），此前仅 `state` 防 CSRF，**无 PKCE**。自定义协议回调可被同机其他应用抢注或劫持授权码：没有 PKCE 时，劫持者拿到授权码即可直接兑换 token。

客户端有两个授权码入口，PKCE 适用性不同：

- **deep-link 流程**（`OAuthService.startOAuth` → `adapter.buildAuthorizeUrl` → `handleCallback` → `adapter.exchangeToken`）：授权 URL 由客户端构造、授权码由客户端经 ACode 后端 token 路由兑换。**这是客户端唯一能端到端注入 PKCE 的流程**，也是本 spec 的范围。
- **轮询流程**（`OAuthService.startOAuthWithPolling`，当前 UI 唯一实际调用路径，`packages/ui/src/hooks/useOAuth.ts`）：授权 URL 由后端 `/api/v1/oauth/cli/init` 下发，兑换由后端完成。客户端往该 URL 上追加 `code_challenge` 无法形成端到端防护（verifier 在后端手里），且若授权服务器强制 PKCE，后端无 verifier 兑换会直接登录失败。**因此轮询流程不注入 PKCE 参数**，其安全责任在后端协议，不在本 spec 范围。

## 产品规则

- **算法**：PKCE 仅用 S256（RFC 7636）；禁止 plain。challenge 为 base64url(SHA-256(verifier))。
- **参数注入规则**：
  - 授权 URL：存在 PKCE 上下文时追加 `code_challenge` 与 `code_challenge_method=S256`；两个 provider adapter（BigModel `bigmodel.cn/login`、ZAI `chat.z.ai/api/oauth/authorize`）行为一致，共用同一 helper，禁止各自手拼。
  - token 交换载荷：存在 PKCE 上下文时在既有 JSON body（`{provider, code, redirect_uri, state}`）上追加 `code_verifier`；无 PKCE 上下文（轮询流程的 deep-link 完成、legacy 路径）时**不得**出现 `code_verifier` 字段——保证既有请求字节形态零回归。
- **verifier 生成与消费**：verifier/challenge pair 由 `OAuthService` 在生成 `state` 的同一时刻生成（`pkce-challenge` 依赖，与 MCP OAuth 同源），challenge 经 context 交给 adapter 拼 URL，verifier 在回调兑换时经 context 交给 adapter。adapter 自身不生成、不存储 verifier。
- **失败语义（fail-closed）**：pair 生成失败（crypto 不可用等）时登录启动直接失败，**禁止**静默降级为无 PKCE 继续流程。
- **refresh token 流程零改动**：refresh 是独立grant，无授权码语义，不得携带任何 PKCE 参数。当前 BigModel/ZAI adapter 均未实现 `refreshToken`，本规则约束未来实现。
- **既有会话恢复零改动**：`restoreSession` / `restoreCachedSession` 不重放授权流（仅校验已持久化 token/userinfo），与 PKCE 无关，不受影响。

## 状态所有者

- **唯一所有者：`OAuthService`**。verifier 与 `state` 同对象存放在进程内 `pendingState`（`PendingState.codeVerifier`），不落盘、不进日志。
- **生命周期与 `state` 完全一致**：登录启动时生成；新登录、`cancelPending`、超时（5 分钟）或流程完成时随 `pendingState` 一起清除。
- **进程重启语义**：`pendingState` 本就是进程内存态，重启即丢。重启后的 deep-link 回调会因 `state` 不匹配被拒——这与现状一致，verifier 不引入新的持久化需求。若未来把 pending flow 持久化，verifier 必须与 state 同密级同存同清，不允许 verifier 单独明文落盘。
- 与 MCP OAuth 的「PKCE verifier 只存内存」先例（`apps/acode-cli/packages/adapters/src/mcp/oauth-interactive.ts`）保持同一原则。

## 接口

- `OAuthProviderContext`（`packages/services/src/oauth/providers/providerAdapter.ts`）新增可选字段 `codeVerifier?: string` 与 `codeChallenge?: string`。该类型是 services 包内部契约，不在 `@acode/shared`。
- `providers/pkce.ts` 提供：
  - `createOAuthPkcePair()`：生成 `{codeVerifier, codeChallenge}`（委托 `pkce-challenge`，不自造 crypto）。
  - `buildPkceAuthorizeParams(context)`：有 challenge 时返回 `{code_challenge, code_challenge_method: "S256"}`，否则空对象。
  - `buildPkceTokenExchangeFields(context)`：有 verifier 时返回 `{code_verifier}`，否则空对象。
- 日志约束：verifier 是等同 bearer 凭据的机密，任何日志（含现有 token request 结构日志）不得包含 verifier 或 challenge 明文。

## 已知边界（诚实声明）

- **服务端 PKCE 支持未经验证（本项最大边界）**。调查结论：
  - 客户端与仓库内均无授权服务器 metadata（`.well-known/oauth-authorization-server`）抓取，无本地可验证的 PKCE 能力声明；
  - BigModel 授权入口是自定义登录页 `https://bigmodel.cn/login`（参数 `redirect`/`appId`/`state`），非标准 `/authorize` 端点；ZAI 入口 `https://chat.z.ai/api/oauth/authorize` 是标准形态（`response_type=code` + `client_id`），但同样无支持证据；
  - token 兑换并非直连 provider，而是 POST ACode 自有后端 `/api/v1/oauth/token`（`{provider, code, redirect_uri, state}`），后端实现不在本仓库。PKCE 端到端生效要求后端把 `code_verifier` 转发给 provider，这一转发是否存在无法本地确认。
  - **因此本实现采用「附加参数」策略**：不支持 PKCE 的服务端按 RFC 7636 应忽略未知参数（授权 URL 的 `code_challenge`、交换载荷的 `code_verifier`），行为不变；支持的服务端则立即获得防护。
  - **冒烟范围的更正（重要）**：当前产品 UI 唯一登录路径是轮询流程（`startOAuthWithPolling` → 后端 `/api/v1/oauth/cli/init` 下发 URL），**不注入也不发送任何 PKCE 参数**（见上「轮询流程不注入」与下「deep-link 无 UI 调用方」）。因此对 BigModel/ZAI 做真实登录冒烟**只能验证轮询登录链路本身**（登录可用 + 后端下发 URL 被原样使用、客户端仅重写 redirect/state、交换载荷不含 code_verifier 的零回归），**无法验证服务端对 code_challenge/code_verifier 的容忍度**——那条路径根本不发这些参数。「服务端 PKCE 容忍度」只在 deep-link 流程真正接入 UI 后才可冒烟；在此之前它是 dormant 契约，由 `oauthPkce.test.ts` 的单元层保证客户端侧正确性。若将来启用 deep-link 入口，届时再对真实授权服务器做一次 code_verifier 兑换冒烟。
- **deep-link 流程当前无 UI 调用方**：`startOAuth`（非轮询）在产品 UI 中暂无调用，本实现保证 adapter 契约与 service 实现端到端 PKCE-ready；一旦入口启用即获得防护。
- **轮询流程的劫持面未消除**：轮询流程授权 URL 与兑换均在后端，若 provider 侧存在授权码劫持风险，需后端协议跟进（后端在 init 时生成 pair、authorize URL 带 challenge、兑换带 verifier）。
- `pkce-challenge` 当前是 MCP SDK 的传递依赖（`node-linker=hoisted` 布局下可解析），但 `packages/services/package.json` 尚未声明直接依赖；应补 `"pkce-challenge": "^5.0.1"` 显式声明（属包清单变更，另行处理）。

## 验收场景

见 `packages/services/test/oauthPkce.test.ts`：

- pair 生成符合 S256：challenge 等于 base64url(sha256(verifier))；verifier 长度 43–128、字符集为 RFC 7636 unreserved；两次生成不重复。
- BigModel 授权 URL 含 `code_challenge`、`code_challenge_method=S256`、`state`、`redirect`、`appId`；challenge 与 pair 一致。
- ZAI 授权 URL 含 `code_challenge`、`code_challenge_method=S256`、`state`、`redirect_uri`、`response_type=code`、`client_id`。
- token 交换载荷含 `code_verifier`，且与本次授权 URL 的 challenge 配对（同一 verifier 派生）；service 级别验证回调兑换使用的 verifier 正是启动时暂存的那一个。
- 错配拒绝：并发两次登录后，用旧 `state` 的回调 URL 触发 `handleCallback` 抛「OAuth state 不匹配或已过期」，且未发出任何 token 交换请求（旧 flow 的 verifier 不可能被用于新 flow）。
- 无 PKCE 上下文零回归：context 无 verifier 时授权 URL 不含 `code_challenge*`、交换载荷不含 `code_verifier`（对应轮询流程 deep-link 完成的字节形态）。
- 轮询启动路径不注入：`startOAuthWithPolling` 返回的授权 URL 不含 `code_challenge*`（URL 属后端所有，客户端仅重写 redirect 参数）。
- refresh 路径无 PKCE：adapter 未实现 refresh 时 `refreshToken` 报「暂未提供 refresh token 交换接口」且零网络请求。
