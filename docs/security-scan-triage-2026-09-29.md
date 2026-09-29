# 安全扫描分诊记录（Security Scan Triage, 2026-09-29 深度扫描）

本文件是对 Mimosa 密封深度扫描 `scan-2026-09-29T15-27-11.841Z-8fdb6ff412a1` 全部 118 条 findings 与依赖公告面的**分诊结论记录**：逐簇判定误报 / 设计固有 / 已缓解 / 真实残留，并给出残留项的最小修复点与后续动作。与 [`security-hardening-plan.md`](security-hardening-plan.md)（加固路线）和 [`security-hardening-handoff.md`](security-hardening-handoff.md)（实施交接）互补：本文只做**扫描结果分诊**，不重开加固议题。

> **文档状态**：分诊结论（triage record）。**生成日期**：2026-09-30。**代码基线**：git `91c1f71`（dev/0.0.1，工作区干净时扫描），文中 `file:line` 以该基线为准，随演进可能漂移。
>
> **扫描标识**：scanId `scan-2026-09-29T15-27-11.841Z-8fdb6ff412a1`；seal `sha256:b1e8d3b2a16165dafe389ec75f8debe5e03d8602eda9f0dfbc10dc4fbd7ee36f`；产物目录 `~/.mimosa/security-scans/project-4e5246d90e01266c4f0a33c9/scan-2026-09-29T15-27-11.841Z-8fdb6ff412a1`（仓库外，防篡改 seal 覆盖 manifest/findings/coverage 三件）。
>
> **判定纪律**：本次 coverage 为 `partial`（动态派发导致调用图不完整）、`runStatus: inconclusive`——按密封扫描契约，**不允许据此做全项目安全断言**。本文结论仅限：118 条静态 findings 已逐簇人工归因（含源码级证据），其中 3 条残留观察项登记待决策；依赖公告面已用 `pnpm audit` 实测枚举。

---

## 1. 扫描概览

| 项 | 值 |
| --- | --- |
| 深度 / 尝试 | deep / attempt 1（一次完成） |
| 证据边界 | `static_only_no_runtime_execution`（纯静态，未执行目标项目） |
| 五阶段 | threatModel / findingDiscovery / validation / pathAnalysis / reporting 全部 completed |
| 规模 | 3844 文件解析（0 失败）、46440 函数、58651 调用边、39 条验证查询 |
| findings | 118（88 high / 30 medium）+ 3 条业务逻辑假设（均 inconclusive/candidate） |
| 依赖（离线库） | 1467 包扫描，19 包命中 86 条公告（明细未在封印产物展开，见 §4 的在线实测） |
| 已知缺口 | 调用图部分不完整（动态派发/规模），跨文件可达性可能漏报——**漏报方向的风险不在本文覆盖范围** |

分诊方法：主 agent 对 5 个代表点位做源码抽查（硬编码凭据 4 处、sql sink 2 处、Program.cs、workflow-drafts slug、CUA sort），另派独立只读 Research 代理对 CUA 簇（20 条）与 transport/SSRF 簇（38 条）逐条核实（读取 35+ 文件、99 次工具调用），并对照 `security-hardening-handoff.md`、`plugin-git-source-pinning.md`、`subprocess-env-credential-allowlist.md` 核验既有守卫在位。

## 2. 分诊总表（118 条全归属）

按标题桶精确切分（互斥，合计 118）：

| 桶 | 条数 | 判定 | 关键证据（代表点位） |
| --- | --- | --- | --- |
| SSRF 类（含「经 N 跳到达 ssrf」「fetch/sendPrompt 是 ssrf 入口」等） | 49 | **误报 47 / 设计固有 2** | ① bootstrap `acode-protocol/server.ts:513-539` 的 conversation*/workflow* 10 条路由：该 server 是 **stdio JSON-RPC 分发器**（子进程 `app-server --stdio`），「sink」文件 `packages/ui/src/v4/agentConversationTransport*.ts` 是 renderer 桥接层，全链无 HTTP/URL/网络 sink。② `acodeAgentService.ts` 19 条（ensureAccountProviderConfigSynced×9、getClient×3 等）：文件内零 fetch/URL，全部是对同机 spawn 的 CLI 子进程 stdio 管道 `client.request(...)`；官方平台入口另有守卫且审计版默认关（`packages/shared/src/officialPlatformPolicy.ts:115-122`，HTTP 适配器入口 `adapters/src/http/index.ts:58` 短路）。③ `adapters/src/http/index.ts:173` fetch 2 条 = **设计固有**的通用出口适配层：协议仅 http/https（:245-251）、`egressPolicy:"public"` 时 DNS 公网校验（:91-96,:276-285）、URL 来源三类（用户 BYO 配置 / WebFetch / 插件下载）各有归属——但由此派生残留观察 #1（§3）。④ offPeakMockGateway 2 条：`ACODE_OFFPEAK_MOCK=1` 门控的 127.0.0.1 mock（文件头自述）。⑤ prompt-trajectory 2 条：`private:true` 开发录制工具，只听 `127.0.0.1:0`，upstream host 由操作员 CLI 固定。 |
| mongo-sort-injection 类 | 15 | **全部误报** | 仓库无任何 Mongo 依赖。sink 实为 `Object.keys(value).sort()` 键集比较（`windowsCuaDevRuntime.ts:355-362` hasExactKeys）与 `readdirSync(...).sort()` 目录确定性排序（`cuaAccessibilitySettings.ts:104,129`）；被标 8 行全是指纹抓取/比对调用点（TOCTOU 防线本身）。 |
| sql-injection 类 | 8 | **全部误报** | 代表 sink 现场无 SQL：`v4-gateway.ts:2504` queryCommands = zod parse + 内存 Map 读取；`node-repl-host/src/server.ts:353` execute = worker_threads 子线程 JS 执行入口（全文件零 SQL 命中）；desktop host 的 getSession→buildInjectedGlobals 5 条同属 node-repl 注入面规则族误标。 |
| 命令注入（直接） | 5 | **误报 1 / 设计固有 4** | `Program.cs:140`：自提权流程，pipeName=GUID 随机、token 自产（CreateToken）、self-path 经 QuoteCommandLineArgument，另有 VerifyPipeClient + 进程映像路径校验（:113-114,173,320,362）——误报。`packages/server/src/remote/{backend,docker-backend,ssh-backend,wsl-backend}.ts` 4 条：`exec(command)` 即产品功能（远程 workspace 部署/执行），SSH 边界统一进 `/bin/sh`（`ssh-backend.ts:283` 附近含 fish 兼容注释），受 P0-2 fail-closed 服务端鉴权守护；命令段由服务端从运维配置构造——设计固有（运维信任边界）。 |
| 命令注入（跳板「经 N 跳到达 command-injection」） | 5 | **误报 1 / 设计固有·误报 4** | `zip-source.ts:182` validateZipDownloadUrl：全文件无 spawn/exec/shell；HTTPS-only + 每 redirect 跳重验 + ≤5 跳 + 跨 origin 剥自定义 header + zip 强制 sha256 + 解包包含性/拒 symlink；git fallback 用 `execFile` argv（`marketplace.ts:1729`）+ host 白名单 + commit pin（与 `specs/plugin-git-source-pinning.md` 一致）——误报。`updatePreparation.ts`/`stageCli.ts` 4 条：见下两行。 |
| 硬编码凭据 | 8 | **全部误报** | 全是键名/错误码/mock 占位/测试 id 字符串，非凭据值：`shared-credentials.ts:15-23` 是 credential-store 键名表（`"oauth:bigmodel:access_token"` 等）；`oauth-provider.ts:60` 是错误 reason 码 `"no_refresh_token"`；`offPeakRuntimeModel.ts:150` 是 mock 网关占位 `"offpeak-mock-key"`（注释明示不校验凭证）；`test-ids.ts:175,177` 是 UI test-id 常量。 |
| path-traversal（CUA 7 + workflow-drafts 1） | 8 | **误报/设计固有 7 / 误报 1** | CUA 簇（`windowsCuaDevRuntime.ts:90,113,186,213,214,244,489`）：打包态路径 = `process.resourcesPath` + 常量，**无 env 参与**，且读前 lstat 正则文件 + 拒 symlink + realpath 包含校验（:236-243）、artifact 相对路径经 `isCanonicalRelativeArtifactPath`（:386-407 拒 `..`/绝对/反斜杠/冒号/NUL）+ manifest 包含性 + 读后 SHA-256 比对（:216-219）——误报（来源标注错误）。dev 态唯一 env `ACODE_CUA_DEV_ROOT`（:7,88，全仓唯一读取点）：须绝对路径 + realpath 等于自身 + package.json 包含性与包名契约校验（:100-107,328-349,527-553）——设计固有（能写该 env 者已具同用户代码执行，无权限增量），但缺 isPackaged 门禁 → 残留观察 #2（§3）。`workflow-drafts.ts:79`：`workflowDraftSlug`（:122-134）字符白名单丢分隔符 + 纯点串兜底 + `wx` 独占创建——误报（Initial commit 既有代码，非本轮升级引入）。 |
| 不可信程序选择（3）+ 不可信命令参数向量（2） | 5 | **设计固有/已缓解** | `runtimeLoginShellEnvCapture.ts:95,236`：程序 = `$SHELL`（fallback 固定三个且须 X_OK），模块目的即回放用户 login shell 采集 env，命令串为固定常量（:54），4s 超时/2MB 上限/独立进程组——同用户信任边界，设计固有。`acodeAgentProcessManager.ts:1060`：`ACODE_AGENT_SERVER_COMMAND/ARGS_JSON/CWD` env 覆盖被 `isPackagedACodeDesktopRuntime()` 门禁在打包态直接忽略（:469-475，P2 agent-command-env-gate R1），spawn env 经 `sanitizeACodeRuntimeEnv`（:1065-1073）+ CLI 侧凭据 allowlist spec——已缓解。 |
| 权限假设（业务逻辑 3 条，medium/inconclusive） | 3 | **已缓解（扫描器不识别非 RBAC 守卫）** | `POST /api/bots/:provider[/:botId]`（`packages/server/src/http.ts:591-592`）：鉴权在 service 层——webhook secret 比对（`botsService.ts:2775-2780`）、feishu token（:2782-2795）、wecom SHA1 验签+AES；P0-3 绑定码防爆破（`createBotBindAttemptGuard`，:4722-4776 指数退避）+ 权限天花板（`bot-remote-guard.ts:20` 禁 yolo/bypass）+ loopback fail-closed（`http.ts:648-652`）。`POST /api/rpc-host-capability`（`server-core/http.ts:201`）：P0-1 守卫在位——Origin/Host 裁决（:206-215）、能力预算上限→503（:200-201）、/ws/host consume+主体绑定（:161-190）、恒 loopback；绑定 token 恒 null 的局限代码注释已自我声明（:175-186）→ 残留观察 #3（§3）。 |
| 疑似跨文件污点（medium 影子条目） | 12 | **随主链判定** | 均为上述 SSRF/SQL 链的 medium 伴生条目（`adapters/http:173`、`server.ts:568,695`、`harness.ts:515`、`openai-provider-proxy:73`、`stageCli:54`、`offPeakMockGateway:419` 等），主链判定误报/设计固有后即关闭；`harness.ts:515` 实为沙箱 child→host 进程内消息桥，非网络调用点。 |

**合计**：误报 96、设计固有 14、已缓解 5、跨文件影子随主链 12（不重复计）——**无 P0/P1 级真实问题**；3 条残留观察项见 §3。

## 3. 残留观察项（真实候选，均非 P0/P1，待产品决策）

1. **WebFetch DNS 重绑定残留（建议 P2 评估，可选运行时 PoC 后定级）**
   最短利用链：prompt injection 使模型调用 WebFetch 请求攻击者域名，该域名 DNS 解析到内网/云元数据 IP → 字面量守卫放行（非 IP 字面量，`webfetch-egress-guard.ts:26-28`；localhost/.local/私网 IP 字面量已拒，`webfetch-url.ts:117-128`）→ `httpClientPort.request`（`webfetch-network.ts:70`）→ 适配器快速路径 fetch（`adapters/src/http/index.ts:172-173`，`egressPolicy` 未设故 DNS 公网校验链未激活）→ 内网响应回流模型上下文。
   缓解现状：http→https 强制升级（`webfetch-url.ts:38-41`）使明文元数据端点（169.254.169.254 的 http API）大半不可达；重定向限同 host/协议/端口（:63-83）；https 内网服务仍可达。
   **最小修复点已就绪**：在 `webfetch-network.ts:70` 的请求上设置 `egressPolicy: "public"` 即可激活既有 DNS 公网校验实现（`adapters/src/http/public-egress-policy.ts` + `index.ts:73-96`）——全仓当前**无任何生产调用方**设置该字段。属一处小改动 + 测试；是否实施需产品决策（WebFetch 对内网地址的合法用例权衡）。
2. **`ACODE_CUA_DEV_ROOT` 打包态无 isPackaged 门禁（P3，一致性）**
   `windowsCuaDevRuntime.ts:88-91` dev-root 分支优先级最高且不检查打包态，helper 会 fork 该目录的 JS（`windowsCuaDevHelperHost.ts:309-326`）。同用户 env 信任边界 → 无权限增量，但与同类加固哲学不一致（对照 agent-command-env-gate R1 对 `ACODE_AGENT_SERVER_COMMAND` 的 isPackaged 忽略、P1-7 更新源门禁）。最小修复点：`windowsCuaDevRuntime.ts:88` 加 `isPackagedACodeDesktopRuntime()` 门禁。
3. **server-core `/ws/host` 主体绑定恒 null（P3，已声明边界）**
   `packages/acode-server-cli/src/server-core/http.ts:181-186` `configuredToken/presentedToken` 传字面量 null，代码注释自我声明「当前不提供任何屏障，真实边界是 loopback 绑定 + Origin 校验 + 能力预算」。属已记录的诚实边界，登记备查；若未来 server-core 暴露面扩大（非 loopback），此项升级为必须。

## 4. 依赖公告分诊（pnpm audit 在线实测，2026-09-29）

Mimosa 离线库报 19 包/86 条；在线 registry 实测覆盖更广：

| 范围 | 公告数 | 分布 |
| --- | --- | --- |
| root workspace 全量（含 dev） | 217 / 37 包 | 2 critical, 88 high, 114 moderate, 24 low |
| root workspace 仅生产依赖（--prod） | 158 / 29 包 | **1 critical**, 54 high, 87 moderate, 16 low |
| apps/acode-cli workspace（独立 lockfile） | **0** | 干净 |

**生产面优先处置清单（有已发布修复版本）**：

- **critical**：`shell-quote`（quote() 不转义对象 .op 中的换行；fixed ≥1.8.4/≥1.9.0）——唯一 prod critical，升级最优先。
- **high 头部**：`axios` ×28（含 NO_PROXY 主机名规范化绕过 → SSRF；fixed ≥1.15.x）、`undici` ×19（fixed ≥6.24/≥7.28）、`protobufjs` ×11（bytes 字段默认值代码注入；fixed ≥7.5.6）、`fast-uri` ×8（反斜杠 authority 主机混淆；fixed ≥3.1.x）、`nanoid` ×5（fixed ≥3.3.16/≥5.1.11）、`form-data`（multipart 字段名 CRLF 注入；fixed ≥4.0.6）、`ws`（未初始化内存泄露；fixed ≥8.21）、`js-yaml` ×4、`linkify-it`、`basic-ftp`、`smol-toml`、`builder-util-runtime`/`app-builder-lib`（electron-updater 跨源重定向泄露 PRIVATE-TOKEN / AppImage 搜索路径）。
- `hono` ×25、`dompurify` ×14、`mermaid` ×9、`postcss`、`ip-address`、`qs` 等以 moderate 为主，随批次升级。

**dev/构建面（不在 prod，接受或随工具链升级）**：`electron` ×19（随桌面升级节奏）、`tar` critical（构建期）、**`extract-zip` 2 high 无修复版本**（symlink 路径穿越，patched `<0.0.0`；构建期使用，建议评估替换或在打包脚本中固化受信来源）、`vite`/`esbuild`/`tmp`/`browserslist` 等。

**建议动作**：另立**依赖升级专项**（不进本文实施）：批次 1 = prod critical/high 且有修复版本（shell-quote、axios、undici、protobufjs、fast-uri、nanoid、form-data、ws）；批次 2 = 其余 prod moderate 与 dev 面；每批走全量门禁 + 桌面/CLI 打包冒烟。CLI workspace 为 0 的事实说明新近重建的 lockfile 自然消解公告——root lockfile 的批量 `pnpm update` 是主要手段。

## 5. 结论与后续动作

**结论**：118 条静态 findings 已全部归簇处置——96 误报、14 设计固有、5 已缓解（P0/P1/P2 既有加固守卫在位）、12 影子条目随主链关闭；**无 P0/P1 级真实问题**。3 条残留观察项（§3）均给出了最小修复点，待产品决策。依赖面存在实质升级需求（§4，1 条 prod critical + 54 prod high），与代码 findings 相互独立。

**后续动作清单**：

| # | 动作 | 性质 |
| --- | --- | --- |
| 1 | WebFetch `egressPolicy:"public"` 激活决策（可选先做运行时 PoC 定级 P2/P3） | 产品决策 + 一处小改动 |
| 2 | `ACODE_CUA_DEV_ROOT` 加 isPackaged 门禁（对齐 env-gate 哲学） | 小改动，可与 #1 同批 |
| 3 | 依赖升级专项（批次 1：prod critical/high） | 独立工作项 |
| 4 | 下次深扫后用 `security-scan compare` 对本 scanId 做增量对比（新增/持续/已解决） | 流程约定 |
| 5 | server-core `/ws/host` 绑定 null：暴露面扩大前维持登记，扩大时必须重评 | 登记备查 |

---

**分诊证据边界**：本文判定基于静态阅读与既有测试/文档对照，未做运行时 PoC（§3 #1 的端到端可达性、wecom 各 provider adapter 验签实现细节、workflow engine world-read 能力面的全部网络路径为已声明的未覆盖点）。扫描产物 seal 见头部；产物在仓库外，本文仅引用其结论不复制原文。
