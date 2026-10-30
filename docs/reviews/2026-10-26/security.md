# ACode 1.0.4 深度 Review · 横切安全

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`。方法：只读源码审查 + 全库危险模式扫描 + 上轮（2026-10-22，基线 `ebe9033b`）安全修复逐条核验；未改动代码，未运行真实 SSH/网络攻击复现。总入口见 [../../project-review-2026-10-26.md](../../project-review-2026-10-26.md)。这是授权范围内的防御性安全审查。

范围：横切全仓——凭据链、鉴权与配对、SSH/主机密钥、路径边界、注入、IPC、敏感信息泄漏、fail-closed 表面、依赖供应链。

---

## 1. 整体安全评估

1.0.4 的全部安全修复**真实落地**：上轮 2 个确认缺陷（R2-01 Windows OAuth 命令注入 P2、DPAPI PowerShell 插值 P3）均已修复且带测试与 spec；全部历史加固（ARCH-01/02、CLI-03/04、M2 fail-closed、serviceLogger 脱敏契约）**无回归**——结构性原因是 1.0.4 对 `packages/server/src/remote`、`packages/rpc`、`core/src/acp` 的 diff 为**空**，这些层靠「未触碰」保持。发布新增的安全工作（server 错误脱敏、Web 重连、desktop 显式 sandbox、OAuth 日志漏斗）均为净改善，无泄漏。**未发现可被远程无交互攻击者利用的 P1/P2 漏洞。** 本轮确认 2 个新 P3，其中一个是上轮流程批评的**复发**：同一 `cmd /c start` 模式修了两处、宣称扫描归零，但第三份出货副本（`scripts/acode-distribution/runner.mjs`，随发行包出为 `bin/acode.mjs`）漏扫。

## 2. 上轮修复回归核对

| finding | 声称修复 | 核验结论 | 当前证据（file:line） |
|---|---|---|---|
| **R2-01 [P2]** OAuth `cmd.exe /c start` 注入 | browser.ts → `explorer.exe` | **HOLDS** | `apps/acode-cli/packages/adapters/src/auth/browser.ts:59` 返回 `explorer.exe`（非 shell，argv 经 CreateProcess）；根因注释 `:50-58`。**主审亲验**：grep 确认 cmd.exe 仅存于注释 |
| R2-01 纵深防御 | authorize_url 含裸 `"` 即 fail-closed | **HOLDS** | `cli-oauth.ts:200` https-only 校验内 `if (authorizeUrl.includes('"')) throw` |
| R2-01 守护测试 + spec | 新测试 + auth-browser-opener.md | **HOLDS** | `adapters/tests/browser-open-command-injection.test.ts:48-63`（源码不变量：不得出现 cmd.exe executable、不得出现 "start" 字面量）+ 2 行为测试；`adapters/specs/auth-browser-opener.md:16` |
| **DPAPI [P3]** PowerShell 插值 | spawn 前 base64 校验 | **HOLDS** | `packages/shared/src/node/credentialKeychain.ts:260` `/^[A-Za-z0-9+/]+={0,2}$/` → `{status:"error"}`；测试 `packages/shared/tests/credential-keychain.test.mjs:151-178` 断言 `calls.length===0`（零 spawn）+ argv 无注入片段 |
| **ARCH-02** SSH known_hosts/managed trust | （1.0.4 未触碰） | **HOLDS** | `server/src/remote/sshAuth.ts:219` `return status === "trusted"`；`:298` revoked/unavailable 短路；`sshManagedTrust.ts:199-201` changed 须显式 replace。`git diff ebe9033b..HEAD -- packages/server/src/remote` = 空 |
| **CLI-03** 路径边界 | （未触碰） | **HOLDS** | `cli/src/acp/session-registry.ts:507-522` 异步 realpath（根+目标）→ isDirectory → 仅拒完整 `..` 段 |
| **CLI-04** 审计会话路由 | （未触碰） | **HOLDS** | `core/src/permission/bash-confirm-reflex-gate.ts` 在位；不在 1.0.4 diff 内 |
| **M2** capability fail-closed | （未触碰） | **HOLDS** | `services/src/acode-agent/independentPlanSupport.ts:25-28` `supported !== true` → throw |
| **ARCH-01** RPC 方法白名单 | （未触碰） | **HOLDS** | `packages/rpc/src/proxy-channel.ts:204` 保留名拒绝、`:222` 排除 Object.prototype 继承方法、`:241` 原型链终止 |
| serviceLogger 对象脱敏守护 | 守护测试钉契约 | **HOLDS** | `packages/services/test/serviceLogger.redaction.test.ts:87-99` 钉对象透传契约（R2-04）+ 字符串/Error 源头脱敏；决策块 `logPrivacy.ts:102-118` |

## 3. 本轮新发现

| 级别 | 问题 | 位置 | 证据 | 定性 |
|---|---|---|---|---|
| **P3** | `cmd /c start "" <url>` 模式的**第三份出货副本**在「扫描归零」宣称下幸存 | `scripts/acode-distribution/runner.mjs:153-154` | `spawn("cmd", ["/c","start","",url])`（win32 分支）。该文件**随发行包出货**——`scripts/build-acode.mjs:207` 将其复制为分发包 `bin/acode.mjs`。违反新立的不变量 `adapters/specs/auth-browser-opener.md:16`（「禁止经 cmd.exe/start 打开任何来自网络或用户的字符串」）。**不可远程利用**：`url = formatUrl(host, port, token)`，host 来自本地 `--host` CLI 参数、port 是数字校验后的值、token 是 `randomBytes(24).base64url` 或用户自己的 `--token`——无网络/远程字符串到达该调用，攻击者需让受害者在自己命令行里输入 cmd 元字符（自注入，不跨权限边界）。故 P3 非 P2。**主审亲验源码行** | CONFIRMED（代码已读；可利用性有界） |
| **P3** | fix-status 扫描宣称不准确——同一元失败复发 | `docs/reviews/2026-10-22/fix-status.md:40` | 宣称「全仓 cmd.exe 同类副本扫描：browser.ts 是唯一真漏洞副本」并逐一列举其余命中（execution-command.ts、ComSpec、shared/mcp.ts），但 `runner.mjs:154` **不在列举中**。上轮 review 的头号流程批评（「同一漏洞模式的修复没有全仓扫描同类副本」）复发：模式在 browser.ts + platform-open-port.ts 修了两处、宣称扫干净，第三份出货副本仍漏 | CONFIRMED |

无新 P1/P2。1.0.4 其余安全相关变更逐项核验为净改善：

- **R2-04 server 错误脱敏** `server/src/http.ts:626-628`：connect-remote catch 对外返回稳定码 `remote-connect-failed`，原始 `err.message`（可含主机名/路径/`spawn ssh ENOENT`）降级 warn 日志，不进响应体。正确。
- **R2-05 Web WS 重连** `web/src/reconnect/webSocketReconnect.ts` + `main.tsx:220-263`：有界指数退避 + full jitter + `cancel()`/`pagehide` 清理；复用 `bootstrap.wsUrl`（无新 token 处理）；`web/src/reconnect/` 目录 grep `console.|token|innerHTML` 零命中（无 token 日志、无 HTML 注入）。
- **getActiveProvider 加固** `web/src/auth/browserOAuthCredentialRepo.ts:113-114`：localStorage 任意字符串现须过 `isWebOAuthProviderId` 才流入 `oauth:<provider>:access_token` 键模板。正确。
- **OAuth 日志漏斗** `services/src/oauth/oauthService.ts:43` + `providers/zaiProviderAdapter.ts:61,67`：裸 console 已换 `createServiceLogger`；oauth 目录裸 console 归零（**主审亲验 grep**）。注意关联发现：traceId 槽位不经脱敏（见 services 专项 §3），oauthService 内 7 处 traceId 误用是该漏斗保证的结构性削弱。
- **desktop 主窗 sandbox** `desktopWindowChrome.ts:593-603`：显式 `contextIsolation:true, nodeIntegration:false, sandbox:true`（原依赖 Electron 41 隐式默认——零行为变更，声明式加固）。全仓 `sandbox:false` 仅两处 e2e 测试脚手架，非出货。

## 4. 危险模式扫描增量（vs 上轮）

| 模式 | 上轮（1.0.3） | 本轮（1.0.4） | 增量 |
|---|---|---|---|
| `cmd.exe`/`start` shell 解释字符串 | 1 真（browser.ts:50） | browser.ts **已修**；**新 surfaced**：runner.mjs:154（出货、P3、非远程可达） | 净：唯一远程可达副本已闭合；1 份非可达出货副本幸存且被修复扫描漏掉 |
| PowerShell `-Command` 插值 | 1 真（credentialKeychain.ts:216） | **已修**（base64 校验）。其余动态点（`workspace-hook-trust-store.ts:84`、processTreeSnapshot、processResourceSampler、windowsProcessListAsync）插值**数字 PID** 或用固定脚本——均未被 1.0.4 触碰、无新增 | 改善，无新命中 |
| `dangerouslySetInnerHTML` | 3 处 0 真 | 3 处 0 真（mermaid `securityLevel:"strict"` `mermaid-block.tsx:162`、chart tooltip、同源 SVG） | 无变化 |
| `eval`/`new Function`/`execSync` | 0 运行时 | 全部命中在测试文件、构建 codegen（generate-child-main.mjs）或 `git rev-parse` 构建脚本 | 无变化 |
| `nodeIntegration:true`/`contextIsolation:false` | 0 | 0 生产；desktop 主窗现显式 `sandbox:true` | 改善 |
| SQL 字符串拼接 | 0 真 | 1.0.4 diff 无 SQL 文件 | 无变化 |
| 硬编码密钥 | 0 真 | 0 新增 | 无变化 |
| 供应链（overrides/patches） | 完整 | `package.json:77-113` overrides 全部在位（shell-quote/axios/undici/protobufjs/nanoid/form-data/ws/dompurify/mermaid/tar…）；2 个 @ai-sdk patch 未变。工作树一度出现的 `pnpm-lock.yaml` diff 仅为 `patch_hash` 编码格式变化（本机 pnpm 9.10.0 vs 钉定 10.33.2 的版本产物，同版本同 patch），**主审已 `git checkout` 还原，非依赖变更** | 无回归 |

## 5. fail-closed 与凭据链抽查

上轮已深核的凭据链（每安装随机主密钥 + OS 钥匙串 + HKDF/AAD + 单次兑换票）、server 鉴权不变量（`assertServerAuthInvariant` 非 loopback 无 token 拒启动、Origin 校验前置、consume() 结果实查）、managed policy floor（解析失败 → MINIMAL_LOCKDOWN）、bot 护栏（2^64 绑定码 + 指数退避锁定 + 远程入口天花板排除 yolo/bypass/auto）本轮抽查无回归（所在文件不在 1.0.4 diff 内）。acode-cua 门控表述订正（上轮 review 文档两处过期前提）已落地：`architecture-governance.md:57-61`、`security.md:71` 就地订正块 + `CONTRACT.md:3-27` 精确边界（详见架构治理专项）。

## 6. 层面健康度

**良**。两个上轮确认缺陷真修（带测试+spec），全部历史加固保持（主要因 1.0.4 结构性未触碰那些文件），发布新增安全工作均为净改善。不到优的原因：`cmd /c start` 模式被宣称扫描归零，但**第三份出货副本**（runner.mjs:154，随包出为 bin/acode.mjs）幸存并违反新立的 auth-browser-opener 不变量——不可远程利用，但正是上轮点名的「修一处、漏其余」流程失败的复发。修复入口：照抄 browser.ts 的 `explorer.exe` 写法，约 5 分钟；同时把「同模式全仓扫描」从人工 grep 升级为守护测试（对 `spawn("cmd"` + `"start"` 组合全仓断言），杜绝第四份副本。
