# 「危险任务进沙箱」路线预研（每会话 VM 沙箱范式对照登记）

> **定位**：预研/登记文档，**不是 spec、不含代码改动、不改任何行为面**。把某桌面 agent 产品
> 「每会话一个本地轻量 VM」的沙箱路线转译为机制层设计思想，对照 ACode 当前源码逐项核实，
> 给出分阶段建议与触发条件。落地前按 AGENTS.md spec-first 约定另立 spec。
> **机制情报来源**：对某桌面 agent 产品 2.37337 版还原工程的只读研究（T1-3 节）。证据在本地
> 研究工程 `~/Desktop/zoode/Claude-2.37337`（受 EULA 约束，禁止再分发；本文只搬运机制设计，
> 不复制代码，不使用厂商内部代号；Hyper-V Host Compute Service、Virtualization.framework、
> gvisor-tap-vsock、9P/Plan 9 文件共享、Windows Sandbox、bubblewrap 等均为公开技术名词）。
> **核实基线**：分支 `feature/cli-value-extract-23737`，HEAD `8898032`（dev/0.0.10 合并点）。
> 全部 `file:line` 以该 HEAD 的干净检出核实；本波次其他代理正在同一工作树并行改动
> `apps/acode-cli`（permission/mcp/hooks 等）与 `packages/ui`，改动合入后行号会漂移，
> 实施前必须复核。
> **生成日期**：2026-10-15。

---

## 1. 执行摘要

外部范式的核心不是「跑一个 VM」，而是一整套**围绕 VM 的工程纪律**：宿主服务 fail-closed、
宿主↔服务双向身份验证、会话级磁盘分离、受控目录挂载、用户态网络栈 + 出口白名单、企业策略
注入点（每启动重读 + 服务端 kill switch）、bundle 二进制 delta 更新、错误分类全封闭枚举。
VM 只是隔离介质，**每一层都可独立借鉴**。

ACode 现状（逐项核实）：**没有任何 VM/OS 容器级隔离**。危险任务治理全部落在「决策层」——
AST 级 Bash 治理 + blast-radius 分级 + 旁路免疫熔断器 + 托管策略地板 + 子进程 env 清洗。
进程级收容只有 Windows job object 一处，且**只覆盖 MCP stdio 子进程、不覆盖 Bash 工具子进程，
失败时静默回退而非 fail-closed**。企业策略注入点已有同构物（OS 托管路径的 managed policy
文件，strictest-wins），但缺「每启动重读」与「服务端 kill switch」两个语义。

建议按三阶段推进，每阶段绑定明确触发条件（§4）：短期偿还进程级收容欠账（无需新产品需求）；
中期在「无人值守危险任务」成为头条能力时评估三平台 OS 容器矩阵；企业面在分发需求出现时
把策略注入点补全为完整档位词汇。

---

## 2. 外部范式摘要（机制层）

某桌面 agent 产品把「非代码类的通用 agent 任务」整体放进**每会话一个的本地轻量 Linux VM**
（系统提示自述「跑在用户机器上的轻量 Linux VM 沙箱」；证据：研究工程
`analysis/prompts-and-long-strings.txt` 行 10616）。按层拆解：

### 2.1 宿主服务 fail-closed

Windows 侧是一个独立的 Go 宿主服务（约 13.7MB / 15,171 函数，经 SCM 启停并轮询；证据：
研究工程 `analysis/native/` 符号级 funcmap 报告，包分布 vm(463)/pipe(211)/企业安全软件
门控与策略(19+16)）。
关键纪律：**服务未安装或未通过签名校验时，主进程拒绝转发任何 VM 请求**（fail-closed，
证据：prompts-and-long-strings.txt 行 36402 的 `not_a_service`/`unsigned`/`unpackaged` 词表）。

### 2.2 宿主↔服务双向身份验证的本机 RPC

- 传输：固定名命名管道，4 字节大端长度前缀 + JSON 帧（≤10MB）、requestId→Promise Map、
  默认 30s 超时（证据：`src/beautified/main/index.chunk-CHpJbW9_.js:125927-126010`）。
- **双向验证**：客户端（JS 侧）用原生模块验证管道服务端为 SYSTEM 属主并限制
  impersonation level（`:125528`）；服务端（Go 侧）反过来校验客户端的代码签名
  （`verifyClientSignature`）。两侧都不信任「管道名对得上」这一事实本身。
- RPC 面：StartVM/StopVM/Configure/GetNetworkDrives/RefreshGuestProxy/WriteStdin/
  PersistentRPC/Subscription 等；事件回调 onStdout/onStderr/onExit/onNetworkStatus/
  onApiReachability/onStartupStep。

### 2.3 会话级磁盘三盘分离 + 受控目录挂载

- 三块独立 vhdx：系统盘（rootfs）/ 会话数据盘（sessiondata）/ 工具盘（证据：
  `index.chunk-CHpJbW9_.js:159845-182209`），另有「会话收养」标记文件。数据盘按会话
  生命周期创建/销毁，系统盘与工具盘跨会话复用——**爆炸半径按盘切分**。
- 宿主目录经 9P（Plan 9）文件共享受控挂进 VM（AddPlan9Share/RemovePlan9Share），
  挂载完成后发「目录已 staged」事件给 UI（含 sessionId + mountPaths），配「文件夹标记 +
  指令文件大小校验 + 远程文件夹同意结果」三件套（证据：`index.chunk-DhN98CRk.js:1776-1790`）。
- macOS 侧对应独立守护进程 + Virtualization.framework，遥测含 VM 内存足迹/内核控制台尾部。

### 2.4 用户态网络栈 + 出口域名白名单

网络走 gvisor-tap-vsock 用户态栈 + Hyper-V socket——**guest 里没有内核网络栈可被利用**；
出口域名白名单由企业策略键下发（surface 档位策略：standard/simple/no-vm/off 四档 +
egress allowed hosts 键；证据：`index.pre.js:25384-25387`）。含 CA 证书注入通道
（SendInstallCACertificates）供企业中间人代理审计。

### 2.5 企业策略注入点

- 组策略键（厂商专属 `HKLM\SOFTWARE\Policies\...` 路径）下发**企业安全软件集成**配置：
  安装包路径 + 厂商标识两键；安装参数放同名 `.args` 伴随文件。
- 参数文件校验词表（本身就是错误消息设计范本）：单行、1-256 字符、白名单字符集、
  拒 BOM/UTF-16、必须常规文件非链接、属主/权限校验；每个失败原因一个封闭 token
  （not_regular/open_failed/read_failed/install_args_busy/empty/too_long/not_one_line/
  bad_first_byte/bad_byte/kill_switch_missing/not_a_service/unsigned/unpackaged…），
  每 token 附一段面向用户的修复指引（证据：prompts-and-long-strings.txt 行
  29992/31761/33948/34093/34516/36164/36402/46662）。
- **每次 VM 启动重读策略**（不缓存跨启动）；**服务端 kill switch**：远端开关缺失时
  不安装并记录原因——「服务端沉默 = 关闭」而非「服务端沉默 = 沿用上次」。
- macOS 同机制（chown root:wheel + chmod 644 变体）。

### 2.6 VM bundle 二进制 delta 更新

manifest 的 versions[0] 为当前版，保留最近几个 bundle 供发布工作流生成**二进制差分**
（证据：prompts-and-long-strings.txt 行 40083）。本轮实测一次更新：容器同尺寸新 sha，
唯一变化是内部守护进程 +36,864B——delta 更新的收益面被真实验证。

### 2.7 错误分类全封闭枚举

VM 磁盘直通校验独立四态词表（not_served/network/not_the_drive_root/not_mounted，
行 36738）；启动超时按阶段归类（guestReady 等）。与 §2.5 的参数文件词表同一哲学：
**只收主进程字面量、不收自由错误文本**，每 token 配用户可执行的下一步。

---

## 3. ACode 现状对照（逐项核实，file:line）

### 3.1 进程收容：job object 只覆盖 MCP，且静默回退

- `apps/acode-cli/packages/adapters/src/mcp/windows-job-object.ts:27-31`：
  `attachProcessToWindowsJobObject` 仅 win32 生效（koffi FFI 调 kernel32），
  `:144` 设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`——句柄关闭即杀整棵进程树。
- **覆盖面**：唯一消费点是 MCP stdio 传输（`adapters/src/mcp/stdio-transport.ts:61-62`
  的 `windowsJobObjectFactory` 缺省注入）。**Bash 工具子进程不接 job object**
  （`adapters/src/exec/execution-command.ts` 常规 spawn，无收容调用）。
- **失败语义**：`windows-job-object.ts:44-53、198-201` 创建/assign 失败一律返回
  `undefined` 回退既有 taskkill——是「尽力收容」而非「无法收容即拒绝启动」的
  fail-closed（对照 §2.1；`docs/security-hardening-plan.md` P2 已把 fail-closed
  启动登记为全仓不变量方向）。

### 3.2 路径策略：故意不硬拦 + 熔断器兜底

- `apps/acode-cli/packages/core/src/tool/path-policy.ts:36-39`：注释明写「当前版本
  故意不硬拦工作区外绝对路径」（子代理需要看 sibling repo）。
- 越界写的唯一收容线是旁路免疫熔断器 `checkPathEscapeWrite`
  （`core/src/permission/bypass-immune-breakers.ts:216-248`，Write/Edit/ApplyPatch/
  MultiEdit 目标逃逸 workspaceRoot 即降级 ask；tmpdir/scratch 根豁免 `:255-259`）。
- **注意 R6 裁决**：yolo 直通条件下 pathEscapeWrite 熔断**不再触发**
  （`core/src/permission/service.ts:262-269`，「完全访问 = 字面完全访问」）——即
  yolo 下越界写没有任何静态收容，这正是「危险任务进沙箱」要补的洞。

### 3.3 熔断器与策略地板（决策层已达外部范式的「策略档位」同构深度）

- 四类熔断按序评估、首命中即终局（`bypass-immune-breakers.ts:70-79`）：
  catastrophic 目标档为 **deny 级**（`:83-115`，「永不执行、任何论证不解锁」）、
  空变量根删除/路径逃逸写/敏感位置读为 ask 级；纯函数、零 IO、只收紧不放宽（`:8-19`）。
- 决策收口统一应用（`service.ts:249-277`）；yolo 直通在 `:394`，位于熔断之前但被
  熔断覆写——「yolo = 放行除熔断器外的一切」。
- 托管策略地板进程级注册（`core/src/permission/process-policy-floor.ts:19-25`），
  子代理/memory agent 自建 PermissionService 也自动携带。
- 策略文件加载器（`adapters/src/config/managed-policy.ts:32-45`）：missing/empty →
  零行为变化；**invalid → 最小封锁地板（收回 yolo/bypass 直通，不 deny-all）**——
  fail-closed 的克制形态。

### 3.4 Bash 治理（AST 级，外部范式无直接对应物——这是 ACode 更强的面）

- unbash AST 解析（`core/src/tool/handlers/bash-command-parser.ts:1-40`：动态词/
  重定向/env 前缀/引号形态全量建模）。
- 目标 blast-radius 分级（`core/src/tool/handlers/bash-target-risk/index.ts:1-16`：
  零 IO 宪法；消费点 = bash.ts capability 计算 `:85-126`、熔断器 catastrophic 类、
  规则建议收窄、npm script body 预取）。
- 只读命令白名单词表族（`bash-readonly-policy-*` 约 20 个模块）+ 确认反射门
  （`core/src/permission/bash-confirm-reflex-gate.ts`，service.ts:277-300 接线）。
- 对照结论：外部产品把「命令危险治理」整体外包给 VM 隔离（沙箱内随便跑）；ACode 在
  **没有隔离介质**的前提下把决策层做深。两条路线互补：沙箱落地后决策层不废弃，
  降级为沙箱内的第二道防线（对齐 auto 分类器设计文档的「确定性规则先行」原则）。

### 3.5 子进程 env 边界（已清洗，但非白名单继承）

- 统一清洗入口：`adapters/src/exec/execution-command.ts:52`
  （`sanitizeACodeRuntimeEnvInPlace(..., { stripSensitiveCredentials: true })`）。
- 单一事实源：`packages/shared/src/runtimeEnv.ts:50-104`（NODE_OPTIONS/代理/CA/CUA
  broker 凭据/遗留遥测键全剔除；`:106-120` 防经 tool-env-passthrough 恢复）+
  `packages/shared/src/sensitive-env-guard.ts:15`（`ACODE_TOOL_ENV_INHERIT_ALLOWLIST`
  精确名/前缀 opt-in）。
- CUA broker socket 的**定向注入 + 全局剔除**（runtimeEnv.ts:76-83 注释）：连接材料
  只给目标 MCP server，防同 agent 内恶意 MCP/注入命令驱动已授权 Helper
  （confused-deputy）——这是 ACode 已有的「能力材料最小分发」先例。

### 3.6 网络出口：无过滤面

- `adapters/src/network/subprocess-env.ts:42-58`（applyNetworkEgressEnv）只做代理/CA/
  passthrough env 的**传递**，不是安全边界；全仓无出口域名白名单、无用户态网络栈。
- 对照 §2.4：外部范式的出口白名单依赖 VM 网络栈这一介质，进程级无法等价复刻——
  这是「中期 OS 容器」阶段才有的能力，短期不追。

### 3.7 本机 RPC 身份验证：CUA 双链路是最近同构物

- 链路甲（node-repl 内核 ↔ host broker）：随机 UUID socket 名 + 32 字节随机 token
  （`apps/acode-cli/packages/node-repl-host/src/cua-broker.ts:26-30`），bridge 经
  注册 Symbol 注入（`cua-bridge.ts:7`），子代理作用域硬拒（`:45-52`）。
- 链路乙（host ↔ CUA Helper）：identity 模式（socket + authority，无口令），单连接
  单请求往返、连接失败即 fail-closed、请求/响应字节上限、possibly_sent 防重放
  （`packages/acode-cua/broker.js:273-290` socket 铸造与解析；wire 注释 `:86-90`）。
- 对照 §2.2：ACode 用「不可猜的随机路径 + token + env 定向分发」达成同目的，但
  **没有 OS 级属主/签名校验**——同机任意进程若拿到 socket 路径与 token 即可驱动。
  强度差一档；若沙箱服务落地，管道属主校验 + 客户端签名校验应直接抄。

### 3.8 企业策略注入点：managed policy 文件是同构物，缺两个语义

- 已有：OS 托管路径解析（`packages/shared/src/node/managedPolicy.ts:96-111`：
  Windows `%ProgramData%\ACode\managed-settings.json`、macOS
  `/Library/Application Support/ACode/`、Linux `/etc/acode/`；`:103` 打包态忽略
  env 覆盖）；strict schema「只能收紧」（`:30` 注释：allow 键/未知键解析失败
  → 整份 fail-closed）；CLI 与 host services 单一来源共用（`:1-15` 头注）。
- **缺「每启动重读」**：策略在 createConfig 管线进程启动期一次性定型
  （managedPolicy.ts:14-15 注释明写），无外部范式「每次 VM 启动重读」的等价物
  （对常驻 host 进程即「每次任务派发重读」）。
- **缺「服务端 kill switch」**：服务端公开配置面存在但极窄——
  `packages/services/src/client-config/clientConfigService.ts:11-12`（1h 缓存 +
  15s 超时）、快照仅 `pluginStoreOrder` 一个字段
  （`packages/shared/src/clientConfig.ts:5-7`），且注释明确「首期仅公开配置；
  账户灰度不得通过此实例复用」。官方服务开关是**本地用户**开关
  （`packages/shared/src/officialPlatformPolicy.ts:8-16`，默认全关），不是服务端
  下发。「服务端沉默 = 关闭」语义暂无对应面。

### 3.9 错误闭集：局部已有，无全局规范

- prompt-cache miss 归因闭集（`apps/acode-cli/packages/contracts/src/events/session.events.ts:789`，
  spec `prompt-cache-diagnostics.md`）；CUA broker→SDK 错误码映射 + 重试分类
  （`apps/acode-cli/packages/acode-cua-plugin/scripts/computer-use-errors.mjs:15-60`：
  未登记码一律落 INTERNAL、REACQUIRE_FIRST/POINTLESS_RETRY 两张闭集表）；off-peak
  判别联合业务码跨协议保真（`core/src/tool/handlers/off-peak.ts:6-8` 头注）。
- 对照 §2.5/§2.7：「每 token 一段用户可执行修复指引」的**词表工程范本**值得在
  沙箱/收容类错误面直接采用；与 `docs/security-hardening-plan.md` P3 登记的
  「三面 reason 收敛为闭集」建议同向。

### 3.10 执行目标路由：远程面已有三 kind，沙箱可作第四目标

- `packages/shared/src/remoteTarget.ts:5,18,24,43`：ssh/wsl/docker 三种远程目标 +
  联合类型；docker kind 已进入窗口连接注册表与去重
  （`packages/desktop/src/host/windowRemoteConnectionRegistry.ts:560`、
  `packages/desktop/src/main/desktopRemoteSessions.ts:82`）。
- 平台差异经 `IPlatformService` DI（`packages/shared/src/platform.ts:585`）。
- 对照外部产品的「host/VM/cloud/SSH 四路执行目标路由」：ACode 已有 host/ssh/wsl/
  docker 路由骨架，**「本地沙箱目标」可作为同族新 kind 挂接**，不必另起炉灶。

---

## 4. 分阶段建议（每阶段带触发条件）

### 阶段一（短期）：进程级收容强化 —— 无需新产品需求，属既有不变量偿债

1. **job object 覆盖面扩展**：Bash 工具子进程（execution-command 路径）在 Windows
   接入 job object（现仅 MCP stdio）；后台 Bash（bash-background-lifecycle）优先——
   无人值守 + 长生命周期是孤儿进程风险最高面。
2. **收容失败 fail-closed 化**：「无法放入 job object 即拒绝启动该子进程」提为
   可配置策略（默认维持回退以免破坏存量环境，managed policy 键可收紧为拒绝）——
   与 security-hardening-plan P2 的 fail-closed 不变量、managed-policy 的
   「只能收紧」哲学同构。
3. **熔断联动**：catastrophic deny 档命中后的存量后台进程清理路径明确走 job
   object terminate（现 taskkill 回退在 Windows 上有进程树漏杀窗口）。

- **触发条件**：无需等待——是既有 P2 不变量的自然延伸；建议随下一次
  bash/adapters 触碰顺带落地（S-M）。

### 阶段二（中期）：OS 容器评估 —— 三平台矩阵

| 平台    | 候选介质                                                                                                             | 外部范式对应                              | ACode 挂接点                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| Windows | Windows Sandbox（WDAG、.wsb 配置驱动、一次性实例）/ Hyper-V Host Compute Service 直用（外部范式选择）/ WSL2 实例复用 | HCS 跑 guest + 9P 挂载 + gvisor-tap-vsock | `IPlatformService` DI + RemoteTarget 新 kind；WSL kind 已在（remoteTarget.ts:18） |
| macOS   | Virtualization.framework（外部范式 macOS 侧同选）                                                                    | 独立守护进程 + 框架 VM                    | 同上；签名/公证约束需评估（Helper 面已有签名校验词汇可复用）                      |
| Linux   | bubblewrap + namespaces（无 VM 开销；外部产品 SSH 会话 shell 拦截同用 bwrap 形态）                                   | —（外部产品 Linux guest 本身在 VM 内）    | 同上；与 docker kind 的关系需裁决（docker 是用户自备远程目标，bwrap 是本机收容）  |

设计要点（从外部范式按层抄，介质可换）：

- **磁盘三分离**的 ACode 等价：系统/运行时层跨会话复用 + **会话数据盘按会话生命周期
  销毁** + 工具层独立更新——对应 ACode 的 workspace 快照/回滚与 scratch 根
  （bypass-immune-breakers.ts:58-62 已有 scratchRoot 概念）。
- **受控挂载**：宿主目录白名单挂载 + 「已 staged」事件回 UI + 指令文件大小校验；
  ACode 的 workspacePath/workspaceIdentity 二分（AGENTS.md）天然是挂载授权的身份键。
- **出口白名单**：仅在有网络栈介质的档位生效；无介质档位维持现状（决策层治理）。
- **档位策略**：仿外部 surface 四档（standard/simple/no-vm/off）设计 ACode 沙箱档位
  键，进 managed policy 词汇（只收紧：项目/用户配置不能把「必须进沙箱」放松回
  「本机直跑」）。
- **触发条件**：「无人值守跑危险任务」成为头条产品能力（yolo 长任务、cron/off-peak
  自动化提权、CUA 桌面控制放权三者任一）；或企业版立项。在此之前**不启动**——
  VM/容器介质的维护成本（bundle 分发、delta 更新、guest 兼容）只有被真实需求摊销
  才划算。

### 阶段三（企业面预留）：策略注入点与 kill switch 的 ACode 等价设计

1. **每任务重读**：managed policy 文件从「进程启动期一次定型」改为「任务派发时
   重读 + mtime/内容 hash 缓存」——外部「每次 VM 启动重读」的等价粒度是每次
   危险任务派发。
2. **服务端 kill switch 等价**：clientConfig 快照扩一个显式字段（如沙箱/收容功能
   的远端开关），语义定为「拉取失败/字段缺失 = 功能关闭」（服务端沉默 = 关闭），
   与 officialPlatformPolicy 默认全关的本地开关合成 AND。注意 no-telemetry 红线：
   只拉公开配置，不带账户灰度（clientConfigService.ts:26 注释既有约束）。
3. **安装参数文件校验词表范本**：企业集成包（若做）的参数文件校验直接采用
   §2.5 词表形态——封闭 token + 用户可执行修复指引，进错误码规范。

- **触发条件**：企业分发需求（MDM/组策略部署 ACode）出现；或阶段二立项时同步
  预留键位（键先定义、行为后置，避免二次改 schema）。

### 明确不做（本阶段）

- 不自研 hypervisor/不 fork 外部 VM 管理代码；介质全部选平台官方 API。
- 不把沙箱作为权限决策的替代品——决策层（熔断/地板/AST 治理）保持独立生效，
  沙箱是第四层而非替换层。
- 不引入任何遥测上报面（no-telemetry 不变量，`apps/acode-cli/tests/no-telemetry.test.mjs`）。

---

## 5. 登记：可直接复用的设计范本清单

| 范本                                                    | 出处（机制层） | ACode 落点                                                                                                                                                           |
| ------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 错误词表 = 封闭 token + 每 token 一段用户可执行修复指引 | §2.5/§2.7      | 沙箱/收容错误面；与 security-hardening-plan P3 闭集建议合流                                                                                                          |
| 双向身份验证本机 RPC（属主校验 + 客户端签名校验）       | §2.2           | 沙箱宿主服务；CUA 链路乙升级参照（§3.7 强度差一档）                                                                                                                  |
| 磁盘三分离 + 会话数据盘随会话销毁                       | §2.3           | 会话 workspace 快照/回滚设计                                                                                                                                         |
| bundle delta 更新（保留近 N 版生成二进制差分）          | §2.6           | 若沙箱镜像自分发；ACode builtin 配置已有 Bundled/Active-LKG/Remote 三源同 Release 先例（`packages/provider-node/src/acode-builtin-provider-config-source.ts:20-24`） |
| 「服务端沉默 = 关闭」kill switch 语义                   | §2.5           | clientConfig 扩展键（阶段三）                                                                                                                                        |
| 每启动重读策略（不信任跨启动缓存）                      | §2.5           | managed policy 任务派发时重读（阶段三）                                                                                                                              |

---

## 6. 演进信号佐证（第二轮版本数字对账）

> **来源与基线**：本节来自第二轮六路深挖清册的「演进信号」分区（同一还原工程
> `~/Desktop/zoode/Claude-2.37337` 的只读研究；证据：研究工程
> `docs/CHANGELOG-2.31226-to-2.37337.md:73-116`、`docs/NOT-RECOVERED.md:20-25` 与
> native 符号级 funcmap 报告，落地前按文首纪律复核）。撰写基线：分支
> `feature/value-extract-23737-r2`，HEAD `73d0b3b`。本节为 §4 阶段二的触发条件论证与
> §5 范本清单提供外部演进证据，**不改变本文任何既有结论与触发条件**。

### 6.1 原生投入已收敛到 VM 沙箱服务一条线

某桌面 agent 产品连续多版本的原生二进制增量对账显示极强的方向一致性：

| 面                                                 | 版本间变化                                                          | 解读                                            |
| -------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| VM 沙箱宿主服务可执行文件（§2.1 的 Go 服务）       | **+156,160B / +179 函数**——本轮全部原生面唯一实质代码增长           | 新能力持续加在已产品化的 VM 服务线上            |
| SSH 三件套可执行文件                               | 仅重编译 + 重签名，函数数逐一不变（2,864 / 2,785 / 2,185）          | 维护冻结                                        |
| 捆绑上游 OSS MCP sidecar                           | 函数数不变（24,777）；funcmap 证实纯上游零修改（上游 SDK + 其依赖） | 维护冻结；「随包分发未修改上游 MCP server」形态 |
| 三个 wasm（CRDT 编辑层 / 内容来源签名 / 语法解析） | 连续第三代字节不变                                                  | 维护冻结                                        |
| 主程序可执行文件                                   | +66KB，全部来自 Electron 框架换代                                   | 壳层换代，与业务投入无关                        |
| 另一原生绑定模块                                   | +23,040B（无符号面，内容不可见）                                    | 研究边界，不作解读                              |

**佐证点**：SSH、侧车 MCP、CRDT 编辑层、内容签名全部处于维护冻结状态，原生新增投入
收敛到 VM 沙箱服务一条线——对方不是在实验性触碰 VM，而是在一条**已产品化的服务线**上
连续多轮加功能。这为 §4 阶段二的触发条件论证补一个外部信号维度：「外部持续投入 =
该方向产品化确定性升高」。注意佐证的边界：它只提高方向置信权重，**不改变本文「触发
条件出现前不启动」的结论**——bundle 分发、delta 更新、guest 兼容的维护成本仍须由
ACode 自己的真实需求（无人值守危险任务/企业版）摊销。

**旁证（sidecar 分发纪律）**：捆绑上游 MCP server 为字节级零修改的纯 OSS 产物——
「随包分发未修改的上游二进制」形态。ACode 若做 sidecar/捆绑 agent 分发，「上游零修改 +
自有签名面独立」是可直接参照的纪律：上游 diff 与自有 diff 天然分离，更新门链
（第二轮清册 sidecar 更新条目，见 `docs/value-extraction-23737-registrations.md` §9.7）
只需覆盖自有面。

### 6.2 企业注入层范本清单增量：EDR 集成运行台账

外部运行态新增：**EDR（企业安全软件）集成运行记录台账**——每次集成安装/运行在本地
JSON 审计文件落一条记录（持久审计面，非遥测上报）。与 §2.5 三件配套构成完整闭环：
参数文件校验词表管「能不能装」、每启动重读策略管「以什么配置装」、运行台账管「装完
实际做了什么、何时做的」。

本条并入 §5「可直接复用的设计范本清单」（增量行如下；§5 表体未动，下次修订该表时
合入）：

| 范本                                                          | 出处（机制层）                                                                   | ACode 落点                                                                                                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 企业集成运行台账（本地 JSON 审计文件，每次安装/运行一条记录） | 第二轮演进信号（本节 §6.2，外部运行态台账文件名证据见研究工程 NOT-RECOVERED 面） | 企业注入层立项时（§4 阶段三）与 managed policy 重读面同批落地；形态循 run 台账先例（`packages/shared/src/automation-types.ts` 的 automation run 台账）与 hooks 信任记录（bundle 摘要），本地文件、不出网 |

---

## 对外发布说明

本文只保留机制设计层面的对照结论；外部产品证据一律以「某桌面 agent 产品」指代，
不含厂商内部代号、专有代码或提示词正文字面。研究工程路径以 `~/Desktop/zoode/`
相对形式引用。后续增补保持同一边界。
