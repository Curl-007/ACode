# 安全加固方案（Security Hardening Plan）

本文件是 ACode 的分优先级安全加固路线图，基于对业界通行安全设计的对照与公开资料，以及对 ACode 当前源码的逐项核实。适用于所有协作者与 AI 辅助会话；与 [AGENTS.md](../AGENTS.md) 冲突时以 AGENTS.md 为准。

> **文档状态**：方案（plan）。**P0 与 P1（P1-5/6/7）已实施并验证，进度与验证记录见 [`security-hardening-handoff.md`](security-hardening-handoff.md)；P2 已实施（2026-09-30 核实代码+spec 俱在）、P3 未开始。**每项落地前先按 AGENTS.md 的 spec-first 约定更新对应 `specs/*.md`，再改代码。
>
> **生成日期**：2026-09-27。**行号时效性**：以下 `file:line` 以 2026-09-27 的检出为准，实施前需复核（行号会随版本漂移）。
>
> **分发边界**：本文只引用「机制设计」层面的对照结论与公开资料，不包含任何第三方代码或非公开的厂商内部信息。

---

## 执行摘要

**ACode 不缺基础能力，缺的是安全兜底。** 逐项核实后确认它已具备：AST 级 Bash 命令治理（`unbash` 解析 + 重定向/动态词拒绝自动放行的反走私逻辑）、memory 子系统、dynamic-workflow 的 JS-DSL 多代理编排、带信任门的 hooks、MCP、skills，以及已彻底移除并有回归测试守护的遥测。node-forge 自签 CA 已删、内嵌浏览器 trust-all 已收窄到仅内嵌分区、插件 zip 源已强制 sha256。**这些都不需要再做。**

最高价值的提升集中在两类真正的缺口：

1. **ACode 自己新增「四项对照功能」时引入的新攻击面（最紧急，属回归）**。其中 `POST /api/rpc-host-capability` **无需任何凭据**即可铸造「trusted host」能力、兑换后跳过客户端握手，且 `packages/server` 全程**没有 Origin/Host 校验**——未配 token（默认）时，loopback 上的**恶意网页经浏览器 WebSocket 就能取得 trusted-host RPC 访问权**。这是本方案发现的最严重问题。同批还有：bot 绑定码仅 `randomBytes(3)` 且无爆破限速，而被绑定的聊天用户可经 `/mode` 选 **yolo** 并建任务 → **一条聊天消息 = 远程任意命令执行、无逐动作确认**。

2. **从上游基线继承、尚未修复的 high 级缺陷**，且它们直接削弱 ACode 的核心卖点（「无监控 / 隐私」）。最实的一条：凭据加密密钥 = `sha256("acode-credential-fallback:{platform}:{homedir}:{username}")`，三个组成部分对同机任意进程公开可知，单轮 sha256、无盐、无机器绑定，且 `ACODE_CREDENTIAL_SECRET` 在产物代码中从不被赋值——**永远走可推导回退**，`credentials.json` 一旦被外带即可纯离线还原全部 OAuth token 与付费 Key。代码注释自己也写着「后续可切换到 Electron safeStorage」。并列的还有：BYO Provider API Key **明文**落盘 `provider_config.json`；项目级 `permission.allowedTools` **不受信任门保护**（而同一配置文件里的 hooks 却受门控——「明知仓库配置要门控，却独漏了更危险的 permission」）。

**业界通行、ACode 完全缺失的两项机制**值得作为统一骨架移植：**托管策略地板**（低层只能收紧不能放松）与**旁路免疫熔断器**（即使 yolo/bypass 也强制弹窗）。ACode 当前是 `mode === "yolo" → 直接 allow`，**无任何熔断**，也没有策略地板层。这两项落地后，多个散点修复（项目 permission 门、子代理模式继承、工作区路径收敛）都能收敛为统一表达，符合 AGENTS.md「不不断增加兜底分支」原则。

**能力差异化**（已选后置，仅登记）：`auto` 模式目前是**桩**（直接 deny「not implemented」），而业界同类产品由 LLM 风险分类器裁决、且置于确定性规则**之后**（带「`rm -rf` 空目录降级」式校准以减少审批疲劳）。另有 **heartbeat 自动化协议**（强制 NOTIFY/DONT_NOTIFY、默认安静、过期自删）可直接移植到 cron/off-peak，根治通知刷屏；以及**跨厂商插件清单兼容**——低成本高杠杆的生态套利。

---

## 优先级总览

| 级别 | 主题 | 性质 | 工作量 |
| --- | --- | --- | --- |
| **P0-1** | server `rpc-host-capability` 无鉴权铸造 + WS 无 Origin 校验 | 新增功能引入·最严重回归 | M |
| **P0-2** | server 鉴权 fail-closed + token 走 Header 不走 query | 新增功能引入 | S |
| **P0-3** | bot 绑定码防爆破 + 「聊天里选 yolo / 建任务」护栏 | 新增功能引入 | M |
| **P0-4** | 凭据加密密钥改用 OS 钥匙串（去掉可离线推导的 fallback） | 继承·high | M |
| **P1-5** | BYO Provider API Key 从明文 config 迁入加密凭据库 | 继承·high | M |
| **P1-6** | 项目级 `permission.allowedTools` 纳入信任门（对齐 hooks） | 继承·high | M |
| **P1-7** | 更新源 env/参数覆盖加 `isPackaged` 门禁 + 修 NOTICE 文档矛盾 | 继承·medium | S |
| **P2** | 托管策略地板（strictest-wins）+ 旁路免疫熔断器（**已实施**：`apps/acode-cli/packages/core/src/permission/process-policy-floor.ts`、`bypass-immune-breakers.ts`，spec `apps/acode-cli/specs/managed-policy-floor-and-bypass-immune-breakers.md`；2026-09-30 核实俱在） | 机制移植 | L |
| **P2** | 其余继承项（Electron 加固/fuse/env 白名单/工作区收敛/PKCE/http 端点告警/插件 commit 固定/子代理模式/Chrome 提权门）（**已按批次实施**，各项 spec 与验证记录见 handoff §6，2026-09-30 核实；残余 #5 工作区路径收敛待产品决策） | 加固 | 各项 S–M |
| **P3** | 能力差异化 backlog（auto 模式 LLM 分类器/heartbeat 自动化/跨厂商插件清单/prompt-cache 诊断/任务依赖图） | 非安全·已选后置 | — |

> S=小（≤1 天）M=中（1–3 天）L=大（>3 天）。

---

## P0 — 立即处理（新增功能引入的严重面）

### P0-1 · server 信任主机能力无鉴权铸造 + WebSocket 无 Origin 校验 【最严重】

**问题**：`POST /api/rpc-host-capability` 在**无任何凭据**的情况下签发「trusted host」能力（`packages/server/src/http.ts:346`；`packages/acode-server-cli/src/server-core/http.ts:171`）；随后在 `/ws/host` 兑换该能力即把连接升级为 `trusted-host-relay` 角色（`packages/services/src/acode-agent/acodeAgentConnectionScope.ts:242-252`），**跳过客户端握手**。`packages/server/src` 全程**没有** `Origin`/`Host` 头校验。

后果：未配置 auth token（默认）时，任何能连到该端口的进程——在 loopback 上甚至包括**恶意网页经浏览器发起的 WebSocket**——都能铸造能力并取得 trusted-host RPC 访问权。

**改动**：

1. `packages/server/src/http.ts` 的 `/api/rpc-host-capability`：当服务处于「需要鉴权」配置（见 P0-2）时，要求合法 token 才签发能力；把签发的 capability 与**已认证主体**绑定（内含一次性、短 TTL、单兑换的 nonce + 主体指纹），兑换时校验未被使用过。
2. `acodeAgentConnectionScope.ts:242-252` 的 WS 升级路径：新增 `Origin`/`Host` 白名单校验（仅允许本机 loopback origin 或显式配置的来源），拒绝携带浏览器 `Origin` 但非白名单的升级请求（防 DNS-rebinding / 恶意网页驱动）。
3. 复用现有 fail-closed 先例：`packages/acode-server-cli/src/server-core/http.ts:126-132` 已经在「非 loopback 绑定但无 auth」时拒绝启动——把同一不变量提到 `packages/server` 共享层，避免两条 server 实现行为分叉。

**验收**：新增回归测试——(a) 无 token 时铸造 capability 返回 401/403；(b) 带浏览器 `Origin: http://evil.test` 的 `/ws/host` 升级被拒；(c) 同一 capability 二次兑换失败。仿照 `apps/acode-cli/tests/no-telemetry.test.mjs` 的「不变量守护测试」写法。

### P0-2 · server 鉴权 fail-closed + token 走 Header 不走 query

**问题**：`ACODE_SERVER_AUTH_TOKEN` 未设置（默认）时，`packages/server` 的 HTTP/WS **完全无鉴权**（`packages/server/src/entry-http.ts:16,25`，`http.ts:332-343`）。设置时，token 被接受为 `?token=` **URL query 参数**或 cookie（`hasValidLiteToken`，`http.ts:226-236`）——query 会泄漏进日志/浏览器历史/Referer。

**改动**：

1. `packages/server`：非 loopback 绑定且未配置 token → **拒绝启动**（对齐 `server-core/http.ts:126-132` 的既有 fail-closed）。loopback 默认无 token 可保留，但需在启动日志显式打印「无鉴权·仅本机」告警。
2. token 校验优先走 `Authorization: Bearer` 头；保留 cookie 作为浏览器兼容路径；**弃用 `?token=` query**（保留一个版本的兼容 + 弃用告警，再移除）。
3. README「Web 模式默认 127.0.0.1 无 token」段落同步说明 fail-closed 行为。

**验收**：`packages/server` 启动测试覆盖「非 loopback + 无 token = 拒绝启动」；token 仅经 Header 时鉴权通过；带 `?token=` 时记录弃用告警。

### P0-3 · bot 绑定码防爆破 + 「聊天里选 yolo / 建任务」护栏

**问题**：`packages/services/src/bots/botsService.ts:413-415` 用 `randomBytes(3)`（6 个 hex，约 1670 万空间）生成绑定码，TTL 仅 30s（`packages/shared/src/bots.ts:75`），但 `handleBind`（`botsService.ts:4640-4679`）**无尝试频率限制**。

更关键：被绑定的聊天用户可经 `/mode` 选 **yolo**（labels 在 `botsService.ts:1499-1506`）并 `createTask` 驱动 host agent（`botsService.ts:4981-4990`）——**yolo 下无逐动作确认**，等于「一条聊天消息 → 远程任意命令执行」。入站通道现已扩到 4 个（飞书/Telegram/企业微信/Discord），该面随之放大。

**改动**：

1. `handleBind` 加**每 bot 的尝试计数 + 指数退避锁定**；绑定码扩到 ≥ `randomBytes(8)`（或改为一次性配对链接/二维码），并保留单次使用 + 短 TTL。
2. 给 bot 驱动的会话设**权限模式天花板**：远程聊天入口**禁止选 yolo/bypass**（最高到 build/edit），与 `packages/services/specs/bot-draft-options.md` 对齐——把「yolo 硬锁降级为默认」改回「远程入口 yolo 不可达」。需要 yolo 必须在桌面本地显式操作。
3. bot `createTask` 的首条消息默认进入 **plan/build 审批模式**，副作用工具照常弹窗（经桌面 host 的审批闸），不静默执行。

**验收**：(a) 连续错误绑定码 N 次后锁定；(b) bot `/mode yolo` 被拒并提示「远程入口不支持完全访问」；(c) bot 建的任务在 build 模式下触发既有审批流。同步更新 `bot-draft-options.md`。

### P0-4 · 凭据加密密钥改用 OS 钥匙串（去掉可离线推导的 fallback）

**问题**（已直接复核确认）：`packages/services/src/credential/providers/credentialCipherProvider.ts:24-38` 与 `apps/acode-cli/packages/adapters/src/auth/credential-cipher.ts:87-101` 两处，AES-256-GCM 的 key = `sha256(ACODE_CREDENTIAL_SECRET 环境变量，缺省则回退到 acode-credential-fallback:{platform}:{homedir}:{username})`。该 env 变量在产物代码中**从不被赋值**，故永远走回退；回退串三个组成部分对同机任意进程公开可知，**单轮 sha256、无盐/无 PBKDF/无 AAD/无机器绑定**。`credentialService.ts:22-23` 的注释自己也写着「后续可切换到 Electron safeStorage」。

后果：`~/.acode/.../credentials.json` 一旦被外带（云同步/备份/磁盘镜像/恶意 npm/本产品自带的 Read·Bash 工具），即可**纯离线还原全部 OAuth token 与付费 Key**。

> **反面教材（勿抄）**：业界有产品同样默认明文凭据落盘，或钥匙串集成存在「写入失败静默回退明文」的缺陷。ACode 应「要么真接 OS 钥匙串，要么明确拒绝」，不要留假的安全感。

**改动**（host→main 请求 encrypt/decrypt，按 `credentialService.ts` 注释的既定方向）：

1. 桌面端用 **Electron `safeStorage`**（macOS Keychain / Windows DPAPI / Linux libsecret）托管主密钥；host 进程经 IPC 向 main 请求加解密，密钥**永不落盘明文**。
2. CLI/无 Electron 环境用 **`keytar` 或平台原生**（Windows CredMan / macOS Keychain / Linux Secret Service）；不可用时回退到 `ACODE_CREDENTIAL_SECRET`（要求用户显式设置），**移除可推导的 `platform:homedir:username` fallback**——宁可拒绝启动并提示设置密钥，也不要静默用可推导密钥。
3. 派生改 **HKDF/scrypt（带盐 + AAD）**，不再单轮 sha256。
4. 迁移：首次启动检测到旧 `enc:v1:`（可推导密钥）→ 用旧密钥解密、用新 OS 密钥重加密、原子替换；保留一次回滚备份。

**验收**：`grep` 全仓不再有 `acode-credential-fallback`；新增测试断言「未设 OS 钥匙串且未设 `ACODE_CREDENTIAL_SECRET` 时拒绝静默回退」；迁移测试覆盖旧→新重加密。更新 README「保护本机静态密钥」段。

---

## P1 — 高价值继承项

### P1-5 · BYO Provider API Key 从明文迁入加密凭据库

**问题**：设置里录入的自定义 Provider Key 经 `packages/ui/src/settings/model-provider-section/ProviderDraftSave.ts:66-90` → `packages/provider/src/config-service.ts:144-220` `savePersonalProviderOverlay` → `NodePersonalProviderConfigRepository`（`packages/provider-node/src/personal-provider-config-repository.ts:143-151`）**明文**序列化进 `provider_config.json`（`provider-config-file-codec.ts:112-124`；`ApiKeyAccessConfig.toJSON` 直接吐出 `apiKey`，`packages/provider/src/config/provider-config.ts:61-69`）。加密的 `credentials.json` 只管 OAuth/账号 Key，**不覆盖 BYO Provider Key**。

**改动**：把 `access.apiKey` 的持久化改走 P0-4 的加密凭据服务（`ICredentialService`），`provider_config.json` 里只存 `credentialRef`（引用），不存明文。`toJSON` 不再输出 apiKey 明文。读取时经凭据服务解密注入内存。

**验收**：落盘的 `provider_config.json` 样例无 `sk-`/`eyJ`/明文 key；新增测试断言保存→读取往返后 Key 可用且磁盘上是 `credentialRef`。

### P1-6 · 项目级 permission 纳入信任门（对齐 hooks）

**问题**：仓库携带的项目配置里的 `permission.allowedTools`/`autoApproveHighRisk` 被**无条件合并生效**（`apps/acode-cli/packages/adapters/src/config/config-merger.ts:51-53`；`apps/acode-cli/packages/adapters/src/config/index.ts:80-96` 按 scope 写入 `PermissionAllowedTools`），最终命中 `apps/acode-cli/packages/core/src/permission/service.ts:217` 的 `this.config.allowedTools.has(toolName)` **裸工具名整体放行**。而**同一份配置文件里的 hooks 字段却走了完整信任门**（`apps/acode-cli/packages/contracts/src/hooks/workspace-hook-trust.ts` 的 `pending_trust`/`bundleDigest`）。即「明知仓库配置要门控，却独漏了更危险的 permission」。克隆恶意仓库即可静默预放行 Bash/Write/Edit。

**改动**：把项目来源的 `permission.allowedTools`/`autoApproveHighRisk` 接入**已有的** workspace-hook 信任管线（同一 `trustState`/`bundleDigest` 机制，复用 `apps/acode-cli/packages/core/src/hooks/workspace-hook-trust-*.ts`）：未受信任的项目配置，其 permission 放行项标 `pending_trust`、不生效，直到用户审阅通过。用户级/系统级配置不受影响。

**验收**：打开携带 `.acode` 配置且 `permission.allowedTools:["Bash"]` 的未信任仓库 → Bash 仍需审批；信任后生效。新增测试覆盖「项目 permission 受信任门、用户 permission 不受」。

### P1-7 · 更新源 env/参数覆盖加 isPackaged 门禁 + 修文档矛盾

**问题**：`packages/desktop/src/main/autoUpdater.ts:24-25,690-703` 从 `ACODE_UPDATE_FEED_URL`/`--acode-update-feed-url` 读 feed URL，`applyUpdateProvider`（`:732-754`）应用时**无 `app.isPackaged` 门禁**（调用点 `main/index.ts:1881-1884`）。能为进程注入环境/参数者可把更新清单指向自有服务器。且 `NOTICE.md:53`/`NOTICE.zh-CN.md:53` **声称打包版会忽略这些覆盖——代码与文档矛盾**。

**改动**：`applyUpdateProvider` 在 `app.isPackaged === true` 时**忽略** env/CLI feed 覆盖（仅开发态允许），或要求覆盖源同样过 sha512 + Authenticode 校验。同步修正两份 NOTICE 使文档与代码一致（建议以「打包版忽略覆盖」为准）。

**验收**：打包态设 `ACODE_UPDATE_FEED_URL` 不改变实际 feed；开发态仍可用；NOTICE 描述与代码一致。

---

## P2 — 机制移植（业界通行做法，ACode 完全缺失）

建议作为一个「策略地板」骨架统一实现，后续加固都挂上去：

- **托管策略地板（strictest-wins）**：业界同类产品的实现是同一哲学——策略层可 pin 住 deny/ask 与 `disableBypassPermissionsMode`，且托管策略**只能表达 prompt/forbidden、禁止 allow**，多层取最严，**低层只能收紧、不能放松**。ACode 当前配置优先级是 System<User<Project<Env<CLI（`apps/acode-cli/packages/adapters/src/config/config-factory.ts:122-127`），**缺一个不可被项目/用户放松的策略地板层**。新增 `policy` scope（最高优先、只增不减 deny/ask），企业/高级用户可下发不可绕过的基线。
- **旁路免疫熔断器（bypass-immune circuit breakers）**：业界同类产品普遍有若干类即使 yolo/bypass 也**强制弹窗**的检查（空变量根删除、路径逃逸、越界读、跨机隔离）。ACode 的 `permission/service.ts:136` 是 `mode==="yolo" → 直接 allow`，**无任何熔断**。在 yolo 直通**之前**插入一组 `bypassImmune` 检查类（复用已有的 `core/src/tool/path-policy.ts` 越界判定 + Bash AST 危险模式），命中即降级为 ask。

> 这两项落地后，P0/P1 的多个单点修复（项目 permission 门、子代理模式继承、工作区收敛）都能收敛为「策略地板 + 熔断器」的统一表达，减少兜底分支。

**另一项值得单独提的工程不变量**：**fail-closed 启动**——「沙箱进程若无法放入 job object 则拒绝启动，以避免运行一个无法收容的沙箱」。ACode 已有 `apps/acode-cli/packages/adapters/src/mcp/windows-job-object.ts` 与 `server-core/http.ts:126-132` 的拒绝启动先例；建议把「无法保证收容/鉴权即拒绝启动」提为全仓不变量，而非逐处兜底。

---

## P2 — 其余继承加固项（排序清单，落地时再展开到文件级）

按「危害 ÷ 工作量」排序：

1. **子进程 env 从黑名单改白名单**（`apps/acode-cli/packages/adapters/src/exec/execution-command.ts:38-49` + `packages/shared/src/runtimeEnv.ts:43-93`）：当前继承完整 `process.env` 仅删固定黑名单，AWS/GCP/Azure 凭据、`SSH_AUTH_SOCK`、`GITHUB_TOKEN`、npm token 全流入 Bash/MCP 子进程。业界通行做法是**无条件清洗第一方凭据 env**、opt-in 才放行——改为「默认不继承敏感前缀，显式 allowlist 才透传」。`adapters/src/mcp/network.ts:9-19` 同改。
2. **Electron 加固四件套**：(a) 主特权窗补 `will-navigate`/`setWindowOpenHandler`（`packages/desktop/src/main/desktopWindowChrome.ts:579-601`，当前只在 webview guest 上有）；(b) 全局 `setPermissionRequestHandler`（当前**零**命中，内嵌浏览器加载任意页面 + `getDisplayMedia` → 恶意页可无确认取摄像头/麦克风）；(c) 主 `renderer/index.html` 补 CSP（辅助窗已有，主窗缺）；(d) `openExternal` 收敛 `file:` 协议（`desktopMainIpcRemote.ts:22-29`）。
3. **Electron fuse**：当前**无 `@electron/fuses` 配置**（`electron-builder.config.js` 未接线），RunAsNode/asar 完整性/OnlyLoadAppFromAsar 全在默认（关）。开启 `EnableEmbeddedAsarIntegrityValidation` + `OnlyLoadAppFromAsar`，关 `RunAsNode`/`EnableNodeOptionsEnvironmentVariable`。
4. **agent 命令 env 覆盖加门禁**（`packages/services/src/acode-agent/acodeAgentProcessManager.ts:468`、`externalEngineCommandResolver.ts:38-40`、`packages/shared/src/acode-agent-runtime.ts:31`）：`ACODE_AGENT_SERVER_COMMAND`/`GLM_BINARY_PATH`/各外部引擎 binary env 能在打包态整体替换 agent 子进程二进制。打包态忽略或要求签名校验。**引擎注册表把这一覆盖面按引擎复制了一遍**（codex/opencode/gemini 各有 binaryEnvVar），需统一门禁。
5. **工作区路径收敛**（`apps/acode-cli/packages/core/src/tool/path-policy.ts:32-39`）：注释明写「当前版本故意不硬拦工作区外绝对路径」。build 模式默认收敛到 workspace（越界需显式批准），yolo 下至少留熔断器（见 P2 策略地板）。
6. **OAuth 补 PKCE**（`packages/services/src/oauth/providers/bigmodelProviderAdapter.ts:109-117` + `exchangeAcodeJwtToken:133-168`）：账号登录仍是授权码 + 自定义协议回调、仅 `state` 防 CSRF、**无 PKCE**（MCP OAuth 反而用了 `pkce-challenge`，可直接复用该依赖）。
7. **http 明文端点告警**（`packages/provider/src/config/provider-data-schema.ts:67,74` + `ProviderDraftSave.ts:14-31`）：自定义 Provider baseUrl 接受 `http:` 且无告警，API Key 明文传输。加「非 https 显式警告」。
8. **插件 git 源 commit 固定**（`apps/acode-cli/packages/adapters/src/plugins/marketplace.ts:1410-1424`）：zip 源已强制 sha256（好），但 git 源仍 `--depth 1` clone 浮动 branch/HEAD、仅 `if(sha)` 才 checkout、git fallback **无 host 白名单**（只有 archive 快路径限 github.com）。要求 git 源 commit 固定 + host 白名单。
9. **Chrome 提权解密门**（`packages/desktop/src/main/browserDataManager.ts:74` → `chromeCookieManager.ts:319`，`desktopBrowserDataIpc.ts:12-13`）：`allowElevatedChromeDecryption` 直接来自 renderer IPC 载荷，renderer 被攻陷即可请求 App-Bound/DPAPI 提权解密而无 main 进程二次确认。提权开关改由 main 进程持有 + 用户显式确认。
10. **遥测残留清理**（低危）：`packages/client/src/globals.d.ts:212-215` 的 `syncTelemetryContext`/`reportTelemetryEvent` 死类型声明删除；`packages/shared/src/acode-source-headers.ts:57` 的 `X-Device-Mid` 评估是否仍需（持久设备标识，发往自有端点）。
11. **子代理权限模式继承**（`apps/acode-cli/packages/core/src/runtime/methods/subagent.ts:473-488,316-318`）：父 yolo → general-purpose 子代理同 yolo 且复用父 permissionService。已有一处缓解（项目来源的 subagent md 不能再声明 `permissionMode`，`core/src/subagent/profile.ts:183-185`）；建议子代理模式**不高于**父且经策略地板收敛（并入 P2）。

---

## P3 — 能力差异化 backlog（已选「安全优先」，本轮仅登记）

以下按 ACode 当前源码重新判定（注意：上游基线的 prompt 缺口清单不代表 ACode 现状，ACode 已自建 memory/dynamic-workflow/ask-user-question）：

- **`auto` 模式 LLM 风险分类器**：ACode 的 `auto` 模式是**桩**（`apps/acode-cli/packages/core/src/permission/service.ts:140-147` 直接 deny「not implemented」）。业界同类产品中，`auto` 由服务端安全分类器（HARD/SOFT BLOCK 分级 + 转录取证规则）裁决，或有 LLM 风险判官**置于确定性规则之后**，带「`rm -rf` 目标已确认为空/不存在则降级」式校准以减少审批疲劳。这是把「确定性白名单」升级为「白名单 + LLM 兜底判断」的高价值项，且 ACode 的 `riskLevel`/`sideEffectScope` 元数据已具备接入点。
- **heartbeat 自动化协议**：定时触发 → 强制输出单个 `NOTIFY`/`DONT_NOTIFY` 决策 → 默认安静（「心跳触发本身不构成通知理由」）→ 过期自动化自删。直接可移植到 ACode 的 cron/off-peak/scheduler，根治「主动通知刷屏」。
- **跨厂商插件清单兼容**：让 ACode 直接消费其他生态的插件清单格式，而非从零自建。ACode 已有插件市场 + bundled-skills + `Plugin Manifest` 词汇（[CONTEXT.md](../CONTEXT.md)），加一层清单格式 shim 即可。
- **prompt-cache 命中诊断**：业界同类产品暴露 `prompt_cache` 健康对象（warm/ttl/hit_ratio + miss-cause 闭集：`system_prompt_changed`/`tools_changed`/`model_changed`/`messages_rewritten`/`ttl_expired`）。ACode 已有 `core/src/context/sections` 的 `cacheHint:"stable"` 标注，补一个命中率/miss 归因面板可显著降本。
- **任务依赖图**：业界同类产品的任务创建带 blocked-by/owner/blocked 状态，ACode 为扁平 `core/src/tool/handlers/todo.ts`。编排能力升级。

> **不属于缺口**：**Workflow JS-DSL 多代理编排**——ACode 的 `apps/acode-cli/packages/dynamic-workflow` 已实现 `agent()`/fan-out/schema 强制返回（`apps/acode-cli/packages/contracts/src/workflow/script.ts`、`apps/acode-cli/packages/dynamic-workflow/src/analysis/*`，含 actor-names/causality-graph 静态分析），仅 `pipeline/parallel/phase/budget` 的完整度可对照补强。（**2026-10-04 纠偏**：本行原声称「已实现 worktree 隔离」与源码不符——当时 `isolation:"worktree"` 是 not-implemented 桩，且现役 dwf 引擎无任何 isolation 参数面。S1 已把桩落地为真实 git worktree 隔离，但范围是 **legacy 脚本工作流路径**（契约声明处）；dwf 面的 isolation 仍是显式非目标，见 `apps/acode-cli/specs/workflow-worktree-isolation.md` R1。）
>
> **低优先**（桌面端特有，对 CLI 中心的 ACode 价值有限）：独立 consent 窗口进程把特权动作 UX 与聊天 UI 分离；第一方 MCP 以「预鉴权 bundled stdio server」形态分发 + 双 host 运行时（in-proc 快、subprocess 隔离）；渲染不可信 HTML 的 iframe 沙箱运行时，仅在 ACode 将来渲染模型生成 HTML 时才需要。

---

## 验证方式（端到端）

每个安全项落地后，遵循 AGENTS.md 的既有约定：

1. **类型 + lint**：`pnpm typecheck` 与 `pnpm lint`（0 error），如实报告结果，不把既有失败写成通过。
2. **不变量守护测试**：仿照仓库已有的 `no-telemetry` 回归测试模式（`apps/acode-cli/tests/no-telemetry.test.mjs`、`packages/desktop/tests/no-telemetry.test.mjs`、`packages/ui/tests/no-telemetry.test.mjs`）——为每条新安全不变量写「负向断言」测试，防回归。例如：无 `acode-credential-fallback` 字符串、无鉴权时非 loopback server 拒绝启动、未信任项目 permission 不放行、yolo 下熔断器仍弹窗、落盘 config 无明文 apiKey。
3. **架构检查**：`pnpm architecture:check --changed`（改动跨包时），确保不引入 UI→Repo 直调、循环依赖等违规。
4. **桌面手测**：`pnpm dev:desktop`，逐项验证——(a) 配置无 token 的 server 后尝试从「网页」发起 WS 升级被拒；(b) bot 聊天里 `/mode yolo` 被拒；(c) 打包态设 `ACODE_UPDATE_FEED_URL` 不改 feed；(d) 录入 BYO Key 后检查落盘 `provider_config.json` 无明文。
5. **CLI 分发手测**：`pnpm build:acode` 后解压运行，验证凭据加密在 CLI（无 Electron）路径走 keytar/原生钥匙串、缺失时拒绝静默回退。
6. **提交规范**：按 [docs/git-collaboration.md](git-collaboration.md)，`feature/`/`fix/` 分支 → `dev` squash；Conventional Commits；每项安全修复**先更 spec 再改码**。

---

## 落地顺序建议

1. **第一批（P0）**：P0-1 → P0-2 → P0-3 → P0-4。这四项要么是 ACode 自己引入的回归（最紧急），要么是 high 级继承缺陷且直接支撑产品「隐私/无监控」核心卖点。P0-1/P0-2 同属 server 鉴权，可一个 PR 内完成。
2. **第二批（P1）**：P1-5（依赖 P0-4 的加密凭据服务）、P1-6、P1-7。
3. **第三批（P2 骨架）**：策略地板 + 熔断器，然后把 P2 清单里的子代理模式/工作区收敛/项目 permission 收敛到该骨架上，避免散点兜底。
4. **第四批（P2 清单其余 + P3 backlog）**：按危害÷工作量逐项；P3 能力项在安全基线稳固后启动。

---

## 对外发布说明

本文件经 2026-09-28 脱敏复核：全文只保留「机制设计」层面的对照结论与公开资料引用，
不含第三方代码、未发布模型代号、厂商内部端点或内部构建路径，也不含任何研究来源的
溯源表述。后续增补内容时保持同一边界；新增「对照」表述一律使用中性的
「业界通行设计 / 业界同类产品」措辞，不点名具体商业产品、不描述其非公开实现细节。
