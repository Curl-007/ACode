# ACode 1.0.3 深度 Review · 横切安全

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`。方法：只读源码审查 + 全库危险模式扫描 + 历史安全修复点逐一核对，未改动代码，未运行真实 SSH/网络攻击复现。总入口见 [../../project-review-2026-10-22.md](../../project-review-2026-10-22.md)。这是授权范围内的防御性安全审查。

范围：横切全仓——凭据链、鉴权与配对、SSH/主机密钥、路径边界、注入、IPC、敏感信息泄漏、fail-closed 表面、依赖供应链。

---

## 1. 整体安全评估

ACode 的安全姿态**成熟且显著优于同类基线**：`security-hardening-plan.md` 记录的 P0/P1/P2 加固项与历史 review 的 ARCH-01/02、CLI-03/04、M2 fail-closed 全部已在当前 1.0.3 源码中落地并核实，**无回归**。凭据链（每安装随机主密钥 + OS 钥匙串 + HKDF/AAD + 单次兑换能力票）、server 鉴权（非 loopback 无 token 拒绝启动 + Origin/Host 校验前置于能力铸造）、IPC sender 门控（拒远程 origin/子帧）、SSH known_hosts/managed trust（revoked 优先、changed 需显式 replace、认证前 fail-closed）、文件遏制（五层 lstat/O_NOFOLLOW/dev-ino 复核）均为真实实现而非纸面承诺。**未发现可被随机远程攻击者利用的 P1 级漏洞**，无硬编码密钥、无明文凭据落日志。本轮仅确认 **2 处真实缺陷**：一处 Windows OAuth 命令注入（P2，已识别模式 H1 的漏修副本），一处 DPAPI PowerShell 字符串插值（P3，同信任边界内的纵深防御）。二者均需攻击者已控制 OAuth 服务端/env 或已具备同用户文件写权限才能触发，不构成远程无交互利用面。

## 2. 安全问题清单（按严重度）

### [P2] Windows CLI 登录：OAuth authorize_url 经 `cmd.exe /c start` 命令注入
- **位置**：`apps/acode-cli/packages/adapters/src/auth/browser.ts:50`
- **类型**：shell 命令注入（cmd.exe 元字符逃逸）
- **触发/攻击场景**：`acode auth login`（Windows）时，`openUrlInBrowser(initData.authorize_url)` 打开网络返回的 URL。`cmd.exe /c start "" <url>` 中，cmd 按 `"` 切换引号态——URL 含双引号即可逃逸，其后 `&calc&` 作为新命令执行。攻击者若能影响 `authorize_url`（恶意/被入侵 OAuth 端点、或经 `buildBigModelApiUrl(process.env,...)` 的 env 覆盖 base URL），即在 CLI 用户上下文执行任意命令。
- **证据**：`cli-oauth.ts:194` 唯一校验是 `new URL(authorize_url).protocol !== "https:"`——https URL 仍可含 `"`/`&`/`^`/`%`。**本仓库已在 `platform-open-port.ts:8-12` 就同一模式（finding H1，2026-10-04）修复并注释警示**「cmd.exe 按 `"` 切换引号态，target 内嵌双引号可逃逸执行任意命令」，改用 `explorer.exe`；但 `browser.ts` 是**同一漏洞的第二份未修副本**。
- **修复建议**：对齐 `platform-open-port.ts`——Windows 分支改 `explorer.exe <url>`（非 shell，argv 经 CreateProcess 传递，无元字符解释层）；或在 `cli-oauth.ts` 校验层增加「URL percent-encode 后不含引号/元字符」断言。
- **验收**：构造 `authorize_url = 'https://x/?q="&calc&"'` 的假 init 响应，Windows 上 login 不触发 calc；新增不变量测试断言 browser.ts 不再出现 `cmd.exe`+`start`。

### [P3] Windows DPAPI 钥匙串读取：blob 字符串未校验即插值进 PowerShell `-Command`
- **位置**：`packages/shared/src/node/credentialKeychain.ts:216`（`POWERSHELL_UNPROTECT`）、消费于 `:250`
- **类型**：PowerShell 字符串注入（纵深防御缺口）
- **触发/攻击场景**：`read()` 从 `credential-key.dpapi.json` 取 `parsed.blob`，`:242` 仅校验 `typeof === "string"`（**从不校验 base64 格式**），随后拼进单引号 PowerShell 串。含 `'); ...//` 的 blob 值可闭合单引号执行任意 PowerShell。能写该文件者已具备同用户 `.acode/` 目录写权限（恶意 npm 依赖、或本产品 Read/Bash 工具），故**不跨权限边界**；但从「可写 .acode 文件」升级为「ACode 进程内代码执行」仍值得封堵。写入路径（`POWERSHELL_PROTECT`）安全——值先经 Node `Buffer` base64 重编码。
- **证据**：同仓库已有正确范式 `packages/desktop/scripts/powershell-command.mjs:createEncodedPowerShellArgs`（逐值 base64 + `-EncodedCommand`），`windowsChromeAppBoundKey.ts` 全程使用；此路径未用。
- **修复建议**：插值前加 `/^[A-Za-z0-9+/]+={0,2}$/.test(protectedB64)`，不符则返回 `{status:"error"}`（与「blob 存在但损坏 → error，fail-loud」既有纪律一致）；或迁到 `-EncodedCommand` 范式。
- **验收**：测试注入含 `');` 的 blob，断言 read 返回 error 且不 spawn 出带注入片段的命令。

### [P3] serviceLogger 对象参数在非桌面进程可能绕过脱敏（观察项，当前无泄漏）
- **位置**：`packages/services/src/logger/logPrivacy.ts:110-119`（非 string/Error 参数原样返回）+ `serviceLogger.ts:29`（默认 sink 为 console）
- **说明**：对象参数的终端脱敏依赖桌面 main 漏斗（`desktop/src/main/logger.ts:82` 对对象 JSON.stringify 后脱敏）。当前所有调用点的被记录对象只含非敏感字段，**无实际泄漏**；但「对象内容在终端漏斗脱敏」是承重不变量。建议在非桌面路径补守护测试。
- **附带**：`nodeApiClient.ts:145` 把消息串传入 `traceId` 槽位（ServiceLogger 首参为 traceId），属调用形态笔误，无秘密外泄。

## 3. 历史安全修复回归核对

| 项 | 当前状态 | 关键证据（file:line） |
|---|---|---|
| **ARCH-02** SSH/known_hosts/managed trust | **已修复，无回归** | `sshAuth.ts:187-193` 唯一生产 `hostVerifier`（hostHash sha256），verifier 末行 `return status==="trusted"`（未知/变更/revoked/unavailable/异常全 false）；`sshKnownHosts.ts` 支持 hex+base64、多 key、`\|1\|` hashed host（HMAC-SHA1+timingSafeEqual）、仅认 `@revoked`；`sshManagedTrust.ts:199-201` changed 必须显式 `replace`；`sshAuth.ts:297-300` revoked 短路优先于 managed；原子写 `privateFilePersistence.ts:88-106` + 锁内重读合并；验证在认证/exec/upload 前（`ssh-backend.ts:300-352` 二次门） |
| **CLI-03** 路径边界 | **已修复** | `cli/src/acp/session-registry.ts:490-530` 异步 `realpath`（根+目标）→ `stat.isDirectory()` → 仅拒完整 `..` 段（不误杀 `..cache`）；`fileContainment.ts` 五层 lstat/O_NOFOLLOW/dev-ino 复核 fail-closed |
| **CLI-04** 审计串线 | **已修复** | `bash-confirm-reflex-gate.ts:453-461` 按 session 注册 + 幂等释放；`:463-468` emitAudit 按 sessionId 路由；挑战键并入 sessionId（`:579-588`，NUL 分隔）防子代理继承绕过 |
| **M2 capability fail-closed** | **已修复** | `independentPlanSupport.ts:23-34`：仅 `supported===true` 且 key 匹配才放行，其余经 strict schema reject → 统一抛 `proto.independentPlanUnsupported` |
| **ARCH-01** RPC 方法白名单 | **已修复** | `proxy-channel.ts:204` `RPC_RESERVED_MEMBER_NAMES` 拒绝；`:222` 排除 Object.prototype 继承方法；装配期一次性冻结公开面 |

**新增核实（P0/P1/P2 加固残留项）**：server-core `/ws/host` 主体绑定已传**真实** token（`server-core/http.ts:264-267`，分诊残留 #3 已闭合）；WebFetch `egressPolicy:"public"` 已激活（`webfetch-network.ts:82`，残留 #1 闭合）；`ACODE_CUA_DEV_ROOT` 已加 `isPackagedACodeDesktopRuntime` 门禁（`windowsCuaDevRuntime.ts:94`，残留 #2 闭合）。

## 4. 危险模式扫描结果

| 模式 | 命中 | 真漏洞 | 说明 |
|---|---|---|---|
| `child_process` exec/spawn | 174 文件 | **1**（browser.ts:50） | 远程部署族（ssh/docker/wsl-backend、remoteAssetInstaller）全经 `quotePosixShellArg`/`quotePosixPathArg` 转义；git 全走 argv 数组 + posture gateway；无 `eval`/`new Function`（script-workflow vm 显式禁 eval） |
| PowerShell `-Command` 插值 | 多处 | **1**（credentialKeychain.ts:216） | 其余用 `createEncodedPowerShellArgs`（值单独 base64）或 `toPowerShellSingleQuotedString`（引号加倍） |
| `dangerouslySetInnerHTML` | 3 | **0** | mermaid `securityLevel:"strict"`（内置 DOMPurify）；chart.tsx 为 tooltip HTML；diagram-preview 同源 SVG |
| SQL 字符串拼接 | 多处 | **0** | 全部 `?` 参数绑定；`migrations.ts` 插值取自冻结常量数组 |
| `nodeIntegration:true`/`contextIsolation:false` | 0 | **0** | 全仓统一 `contextIsolation:true`+`nodeIntegration:false`；webview guest `sandbox:true`+隔离 preload（无 acode 桥） |
| 硬编码密钥/token/内网地址 | ~150 | **0** | 全为测试 fixture、键名表、错误码、mock 占位、egress 黑名单定义、i18n 示例 |

**最可疑 5 处**：① browser.ts:50（P2，真）② credentialKeychain.ts:216（P3，真）③ `server/src/remote/*-backend.ts` exec（设计固有，已验证转义）④ `remoteAssetInstaller.ts` 大段 shell 脚本（manifest 签名校验 + 逐段 quote，安全）⑤ node-repl `vm`（显式声明非安全沙箱，隔离靠权限 gate，已接受边界）。

## 5. 凭据与敏感信息

- **keychain 使用**：三平台原生工具统一（macOS `security`/Windows DPAPI blob/Linux `secret-tool`），`spawnSync` + 进程级缓存；优先级 explicit > keychain > keyFile > env > generate；条目损坏 fail-loud 抛错（绝不降级生成新密钥孤立既有 v2 密文）；R1-b 迁移「写入→回读逐字节验证→删文件」，失败清条目保文件。可离线推导的 `acode-credential-fallback` 仅存于 `credentialCipher.ts:93-108` 的 **v1 decrypt-only** 路径（升级不丢既有凭据，`encrypt()` 永不产出 v1）。
- **日志泄漏**：无明文泄漏。服务层 `serviceLogger.ts:61` + 桌面 main `logger.ts:82` 双漏斗脱敏；`logRedactionSecrets.ts` 覆盖私钥块/Bearer/Basic/sk-/AKIA/AIza/ghp_/xox/glpat-/JWT/≥40 base64；`logRedactionUrls.ts` 收敛 origin + 剥 userinfo（识别 %40/@ 编码绕过）+ 内网 IP/域整段 `<url>` + SID `<sid>`；OAuth code 经 `maskOAuthCode`；nodeApiClient 只记 header key 不记值。
- **BYO Key reveal**（handoff §5.5）：`ApiKeyInput.tsx` 无 logger 导入；`InlineEditableProviderCard.tsx:663` 明文仅进组件 state，错误只 surface `error.message`——「绝不落日志」核实成立。
- **硬编码密钥核实**：0 处真实密钥。crypto 无硬编码 key/IV；凭据密钥来自随机文件/钥匙串。

## 6. fail-closed 核对

- **acode-cua**：12 个公开子路径全 fail-closed。`execute()` 无 brokerSocketPath → `unavailable()`（isError:true）；broker `dispatchRequest`/`callBrokerMethod` 失败即 throw（绝不返回 undefined/result）；`probeHelperHealth` 预算耗尽 throw（注释明禁「假成功空值」）；attest/allow 谓词恒 false/undefined。**注**：架构治理专项指出 broker.js 客户端 wire 面是功能完整实现，生产 fail-closed 靠上游插件门控（默认构建 `cuaPluginEnabled=false`）——见 [architecture-governance.md](architecture-governance.md) §5，两份结论一致：默认安全，dev env 旋钮可激活活路径。
- **capability query**：见 §3 M2 行——strict schema + 单一 `===true` 肯定位，无 allow 默认分支。
- **server auth**：`assertServerAuthInvariant`（`serverAuth.ts:59-66`）非 loopback 无 token throw（0.0.0.0/:: 视为非 loopback）；mint/upgrade 前 Origin 校验（http.ts:420/482，server-core:290/246）；`consume()` 结果实际检查（http.ts:491 `if(!principal) return 401`）。
- **managed policy floor**：解析失败 → `MINIMAL_LOCKDOWN`（disableBypassPermissionsMode:true），strict schema 拒未知/放宽键；yolo 直通前经 `evaluateBypassImmuneBreakers`（`service.ts:407-409`）。
- **bot 护栏**（P0-3）：绑定码 `randomBytes(8)`=2^64 + 每 bot 指数退避锁定（`botsService.ts:4738-4791`）；远程入口天花板排除 yolo/bypass/**auto**（`bot-remote-guard.ts:33`）。

**供应链**：2 个 pnpm patch（@ai-sdk）仅加 video/* content-block，无恶意；overrides 已落地（shell-quote/axios/undici/protobufjs/nanoid/form-data/ws 等，prod 公告 critical 1→0）；third-party 台账（inventory/copied-components/npm-overrides）在位。

## 7. 修复入口建议

最严重风险：browser.ts:50 的 OAuth URL 命令注入（P2）——本仓库已就同一模式修过一处（platform-open-port.ts H1），这是漏修的第二份副本。打开 `apps/acode-cli/packages/adapters/src/auth/browser.ts:50`，把 win32 分支的 `cmd.exe /c start` 改为 `explorer.exe`（照抄同仓 `platform-open-port.ts:36`），约 10 分钟含测试。
