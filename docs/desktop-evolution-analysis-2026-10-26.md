# ACode 桌面端功能进化分析（2026-10-26）

分析日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4` + 本轮 review/修复提交（`04ba3d97`）。

> **定位**：分析/评估文档——盘点桌面端功能现状、核验已立项提案的落地状态、提出协同进化机会与建议排序。**不是 spec、不含代码改动、不改任何行为面**；各项实施前仍须按 spec-first 约定走各自 spec。方法论：三份升级提案文档（[upgrades/product-and-support-2026-10.md](upgrades/product-and-support-2026-10.md)、[k-series-upgrade-plan.md](k-series-upgrade-plan.md)、[capability-uplift-plan.md](capability-uplift-plan.md)）+ 桌面端 154 个 main 进程文件能力盘点 + 对每个「未落地」论断的代码级核验（附录 A 证据索引）。同日全项目 review 见 [project-review-2026-10-26.md](project-review-2026-10-26.md)。

## 0. 执行摘要

桌面端的能力版图呈「**引擎强、仪表盘弱**」形态：CLI 侧 K1-K9 能力（记忆语义召回、swarm 任务图、overnight 挂机、跨会话搜索、harness API、ACP）已全部实施合入，desktop main 进程已有 154 个文件的厚能力面（托盘、自更新、支持包、资源管理器、卡顿归因、打印、find-in-page、深链、内嵌浏览器、CUA 权限面板），但两者之间的「出口接线」大量缺失。

进化机会按杠杆分四档：

1. **已立项未实施的四个 U 项**（U07/U08/U11/U12）——spec 齐全（含所有者、契约、验收场景、量化门槛），代码核验零落地，合计约 16-25 人日，全部是用户直接可感知的桌面 UX 进化。**开工阻力最小，建议先做。**
   > **进度（2026-10-27 更新）**：**U12/U08/U07 已完整实施并提交**（`2a390ef8`/`1ead67e2`/`9d33305a`），overnight×通知接线**端到端已通**（`89a515bb`+`b8a983c7`）；**U11 读取侧+生产者已实施但生产门默认关闭**（`87bc31f1`+`b1ad78e2`，正规能力协商待读侧改造，见 §2.4）。全部经主审逐行亲验 + 五门禁全绿 + 真机 smoke。§2 各节标注实时状态。
2. **U14 Windows CUA（进行中）**——差异化能力，角色 B（纯 JS）大头已落，角色 A（C++ addon）阻塞在 node-gyp/VS2026 工具链版本表，**需一项三选一的用户裁决**即可解除。
3. **协同接线机会**（本文新分析，提案文档未覆盖）——overnight×桌面通知、资源管理器×卡顿归因、内嵌浏览器×CUA 架构评估。成本低、复用既有地基。
4. **战略大件**（维持登记不立项）——活会话跨机迁移、OS 级沙箱；以及 legacy 退役 2026-12-31 硬 deadline 对进化速度的结构约束。

建议落地顺序：**U12 → U08 → U14 工具链裁决 → overnight×通知 → U07 → U11**（§7 详述理由）。

## 1. 桌面端能力现状盘点

### 1.1 main 进程能力面（154 文件，按域归类）

| 域 | 代表文件 | 成熟度 |
|---|---|---|
| 窗口/生命周期 | `desktopWindowChrome`、`desktopWindowLifecycle`、`primaryWindowCoordinator`、`desktopZoom` | 高（本轮 review 判定进程边界层为全仓最佳） |
| 进程/Host | `desktopHostProcess`、`desktopRemoteSessions`、`taskRealtimeBus`、`processContainment` | 高 |
| 更新/发布 | `autoUpdater`、`updateGates`、`updaterJournal`、`updaterSweep`、`forceUpdateGuard` | 高（1.0.4 新增免安装 zip 版） |
| 诊断/可观测 | `exportLogs`、`supportBundle` 三件套、`stallSampler` 四件套、`resourceManager*` 五件套、`unresponsiveReport`、`shutdownEvidence` | **部件厚、集成薄**（见 §5.2） |
| 系统集成 | `desktopTray`、`desktopNotifications`、`unreadBadge`、`deepLink` 族、`desktopPrintToPdf`、`findInPage` 两件套、`openInEditor`、`desktopWindowsOpenFolderContextMenu` | 中（通知面薄，见 §5.1） |
| 内嵌浏览器 | `browserView/`、`chromeCookie*`、`chromeCredentialManager`、`chromeLocalStorageManager`、`chromeProfileDiscovery`、`desktopBrowserDataIpc` | 高（集成深度超预期） |
| CUA（Computer Use） | `cua*` 六件套、`windowsCua*` 三件套、`desktopCuaHelperInstaller` | **推进中**（§4） |
| 安全/权限 | `desktopSessionPermissionPolicy`、`rendererFrameTrust`、`desktopWebContentsGuard`、`deepLinkHardening`、`debugTokenGate`、`remoteTargetTransportSecurity` | 高（历轮 review 持续加固） |

### 1.2 引擎侧已落地的能力（K 系列全部实施）

[k-series-upgrade-plan.md](k-series-upgrade-plan.md) 的 K1-K9 全部标注「已实施」并带提交号：K1 记忆语义召回（BM25+RRF，Phase B/C 接口位就绪）、K2 对话内 swarm 任务图、K3 Overnight 挂机执行、K4 跨会话搜索（FTS5）、K5 外部会话导入扩展（Codex/Gemini CLI/opencode/Cursor）、K6 Ambient 预算调度（默认关）、K7 Harness API 公开面 + TS SDK、K8 ACP 宿主适配、K9 工具微增补。这些能力在桌面端的暴露程度参差——K2/K4 有 UI 面，K3/K6 的桌面出口薄（§5）。

## 2. 已立项未实施：四个 U 项（最高杠杆）

四项均在 [upgrades/product-and-support-2026-10.md](upgrades/product-and-support-2026-10.md)（U07/U08/U11/U12 章节）有完整实施标准：状态所有者、拟议契约、编号验收场景、量化门槛、回退条件。文档头部明示「仅定义拟议实施标准，不代表行为已经实现」。以下落地状态为本文 2026-10-26 代码核验（附录 A）：

### 2.1 U12：桌面与手机 Web 本地诊断报告 —— **✅ 已实施（2026-10-26，提交 `2a390ef8`）**

> **状态更新**：本节原为「已立项未实施」，同日已按 spec-first 落地。实现与本文核验的差异：
> build/env 事实的所有者**不只是** Desktop main——`appVersion`/`commit` 来自 `packages/shared/src/version.ts`
> 的 bundler 注入常量，desktop 与 web 两个 vite 配置都注入，故 **Web 也能诚实上报构建版本**；
> 只有 `os`/`arch` 是 main 独占。契约详见 `packages/shared/specs/local-diagnostic-report.md`，
> 三端各自 spec 指回该真源。缺口比本文预估更窄：main 侧 `exportLogs.ts`、UI 侧动作分支、
> Web 侧 Blob 下载全部就位，帮助菜单入口已暴露。

- **用户价值**：桌面 App 出问题时用户能自助生成脱敏诊断文件、预览内容、自行决定是否发给维护者；手机离线也能导出客户端已知事实。当前报 bug 全靠口述。
- **核验现状（实施前）**：三段地基中两段已就位——`packages/desktop/src/main/exportLogs.ts` 已有日志整理与脱敏；`packages/ui/src/lib/helpMenuActions.ts:3,7,22` 已有 `exportLogs` 动作分支（经 `IPlatformService.exportLogs`）。**缺口精确在 UI 入口**：`packages/ui/src/WorkspaceHelpMenuButton.tsx` 未暴露该动作（grep `exportLogs|诊断` 零命中）；Web platform 侧返回 unsupported。
- **估算**：3-5 人日（提案 §6.3）。**四项中最低成本**，且不碰协议面。
- **边界**（提案已裁决）：不自动上传、不增遥测、不默认采集会话正文/凭据/机器路径。

### 2.2 U08：首次配置与模型故障诊断 —— onboarding 留存关键（✅ 已实施 `1ead67e2`）

- **用户价值**：保存 provider 后区分「已保存」vs「已验证」；故障时看到明确阶段（offline/catalog/live）；不重复建 provider 即可重试。
- **核验现状**：`runProviderDiagnostics` 全仓零命中——拟议服务契约未落。但承接面已在：`useModelProviders` 连通性 hook、`providerSettingsConnectivity` service、CLI 侧 [provider-doctor spec](../apps/acode-cli/specs/provider-doctor.md) 的 offline/catalog/live 分档均已存在，GUI 只欠承接。
- **估算**：4-6 人日（提案 §3.4）。
- **边界**：不自动换模型、不自动修凭据、诊断失败≠保存失败。

### 2.3 U07：长对话目录索引与窗口外跳转 —— 桌面主力场景（✅ 已实施 `9d33305a`）

- **用户价值**：长会话打开目录即找到已索引历史输入，点击定位窗口外正文，查看历史期间仍收运行状态，可一键返回最新。
- **核验现状**：`getTurnIndexEntries()` 已存在（`conversationProjectionStore.ts`），但拟议的 store 公共入口 `focusIndexedRow(target)`/`returnToLive()` 全仓零命中；生产目录仍走 `renderUnits`，`loadAllOlder()` 逐页读正文。
- **估算**：3-5 人日（提案 §2.3）；若产品要求超 8000 项索引的完整历史目录，另立 v4 分页目录能力追加 4-6 人日。
- **边界**：不建全文搜索、不扩 renderer 预算（1200 行/32 MiB 约束不变）、打开目录零新增正文请求。

### 2.4 U11：工具图片受授权附件引用 —— 内存与图片密集历史（✅ 读取侧+生产者已实施 `87bc31f1`+`b1ad78e2`，**生产者默认关闭**）

> **状态更新**：schema/授权/渲染读取侧与生产者（node-repl 图片落 artifact 发 ref）均已实施并测试。
> 但**生产门 `nodeReplMediaRefs` 默认关闭**，全仓无任何生产路径置 true——故 ref 形态当前
> 零生产启用，功能可验证面是单测而非端到端。原因：正规能力协商需 client→host 方向的新增
> `clientHello.capabilities` 键，而该 schema 是 `.strict()`，老 Host 见未知键会整条握手失败
> （`transport.ts:92`）；per-connection 的 clientMode 又无法证明将来谁回放该持久化 row。
> 故按「不 ship 破坏兼容的门」原则，生产者建好但保持关闭，字节收益记为 deferred，
> 待读侧投影改造（投影异步化 + 网关拿 artifact store）设计好再开。详见
> `apps/acode-cli/specs/tool-media-attachment-ref.md` R10 与 `b1ad78e2` 提交说明。

- **用户价值**：图片密集历史先看轻量行，图片可见/打开预览才读字节；重连后仍可预览；跨 workspace/session 媒体不可读。
- **核验现状**：`packages/shared/src/acode-protocol-v4/toolDisplay.ts:239` 的 `node_repl_images` 仍是内联 base64（每张 ≤200×1024 字符、最多 2 张）；lazy img 只延迟解码、不减 row 字节。v4 Gateway 的授权媒体读取（userInput 附件 + 当前 session assistant artifact ref）已在，但不能直接用于工具 row——这是本项的主要工程面。
- **估算**：6-9 人日（提案 §5.3）。**四项中最贵**，涉及协议面（toolDisplay schema 演进）。
- **边界**：不增任意路径读取、模型可控 Markdown 不作跨 session 授权、不提高图片生产上限。

## 3. 提案中其余桌面相关项（非本文重点，状态备注）

- **U09 文档事实校准**（1-2 人日）：文档面，非功能进化，随任意迭代捎带即可。
- **U02 V4 Gateway 故障注入 / U05 legacy 退役 / U10 Runtime 写入边界**（[upgrades/runtime-and-protocol-2026-10.md](upgrades/runtime-and-protocol-2026-10.md)）：健壮性/结构项非用户可感知功能；其中 U05 与 §6.3 的 legacy deadline 直接相关。
- **U01**（质量与发布）已落地；**U13**（台账门禁）已落地（`a8a8ff0b`）。

## 4. U14 Windows CUA：进行中，阻塞点是一个待裁决的工具链问题

**进度**（核验 + 项目记忆对齐）：`cua-producer/` 骨架（45 文件）已在当前分支追踪；阶段 0 完成（1706 行宿主代码测试覆盖补齐）；阶段 2 角色 B（host 侧纯 JS）增量 1-3 完成（broker.js 方法表 + win32 named-pipe 分支、broker-server.js marker 三件套、index.js execute 补实，含 wire 协议 spec `broker-wire-protocol.md`）；阶段 1 文档移植按台账原子性约束撤回、重做路径已明确（须 CI-Linux 原子提交）。

**阻塞点**：角色 A（C++ N-API addon `ax_native.node`）无法在本机编译——仓库钉定的 node-gyp 11.5.0 的 VS 版本表只认 2019/2022，本机 VS 2026（v18.4）被拒。**三条解除路径（需用户裁决）**：

| 路径 | 改动面 | 权衡 |
|---|---|---|
| A. 升 node-gyp 至 13.x | lockfile + 台账连带（CI Linux 回补） | 大概率已支持 VS2026；一次升级长期受益 |
| B. 本机装 VS 2022 Build Tools | 零仓库改动 | 双版本共存占盘；每个开发机都要装 |
| C. 靠 CI windows runner 编译原生件 | workflow 改动 | 本机永不编译、最干净；本地迭代体验差 |

**价值判断**：Windows CUA 是桌面端相对同类产品的差异化能力（Agent 直接操作 Windows 桌面应用），且角色 B 大头已投入——工具链裁决越晚，沉没的半成品期越长。角色 A 之外，阶段 2 首版还延后了 5 项角色 B 占位（`isPotentialACodeCuaAgentMcpServer` 为增量 4 候选），不在 C05 关键路径。

## 5. 协同接线机会（本文新分析，提案文档未覆盖）

以下三项的共同形态：**两侧地基都已建成，缺的是把它们接起来的线**。均为本文盘点 154 文件能力面 + K 系列实施记录时识别，非转述既有提案；实施前须按 spec-first 立项。

### 5.1 Overnight（K3）× 桌面通知/角标 —— 已建成的引擎缺桌面出口（✅ 已实施 `89a515bb`+`b8a983c7`）

- **现状**：CLI 侧 K3 已实施（`/overnight` 时间闸状态机、晨报走任务卡片 markdown、桌面 UI 可直接渲染）。桌面通知原语也在：`desktopNotifications.ts`、`unreadBadge.ts`、`desktopTray.ts`。挂机任务在 App 最小化/后台完成时，晨报到达缺一条「系统通知 → 托盘角标 → 点击直达任务卡」的链路。
- **机会**：把 K3 的晨报/交接事件接入既有通知与角标部件。
- **量级（本文原估 S-M「纯接线」偏乐观，实施核验后修正）**：本文初稿判为「两侧地基都已建成、缺的只是接线」，但实施期核验发现**缺口更深**——overnight 完成事件当前**根本不跨进程边界**。证据：supervisor 发 `overnight.completed/failed`（`core/src/overnight/supervisor.ts:50,234,241,269`），但 bootstrap 的 `onEvent` 只调 logger（`bootstrap/src/app/overnight-controller.ts:274-308`，无协议/host 发射）；coordinator 是 `hidden:true` 的 fork 子会话，其事件不进 sessions-index（`v4-bridge.ts:1480-1485` 无 sessions 记录）；全仓 `packages/**` grep `overnight` 只命中 slash-help 文案，**无任何协议事件/服务面/shared 类型把 overnight 状态送到桌面**。故真实成本是「新建一条 host→Main 协议通道 + bootstrap 发射点 + services reporter port」，量级 M（3-5 人日），非 S-M。
- **实施现状（2026-10-27）**：**端到端已通并提交**。Main 侧出口 seam（`overnightCompletionNotify.ts`，runId 幂等/焦点闸/Main 侧本地化文案/点击路由 parentTaskId）+ 跨进程接线（`b8a983c7`，20 文件）：agent 子进程在 `handle.completion.then` 单一发射点（completion promise 每 run 恰 resolve 一次，幂等由构造保证）→ 经新 v4 中立叶子 `overnight-completion.ts` 的 stdio 通知 → `acodeAgentService` fail-closed dispatch（畸形信号丢弃、只记 issue 元数据不记原始 params）→ host 纯转发器（不落状态/不去重）→ main dispatch（新 `HostResponseTypes.OvernightCompletionNotify`，已注册进 `hostResponseMessageSchema` 判别联合，避免静默丢弃）→ 单例 notifier 裁决。`outcome` failed-wins、`morningReportReady` 取权威标志 `morningReportPostedAtMs !== null`。34 个新测试（跨 4 边界）+ 5 组负向验证全绿；desktop 451/451、shared 416/416、CLI overnight 23/23。**未验证项**：真机 Electron + 真 CLI 子进程的三进程端到端投递时序——代理无法启动 Electron，仅逐边界注入 fake 单测覆盖；真机 `/overnight`→系统通知弹窗需人工验证（已在 spec §7.3 如实登记）。主审已跑 desktop build + e2e:smoke 六检查点全 PASS，覆盖 host 启动路径不回归。
- **接线顺带清掉的 CI 阻塞**：seam 单独提交时（`89a515bb`）因无生产 importer 被 `knip:gate` 判 Unused files（红）——本轮接线给了它真实 importer，knip 回绿。
- **附带发现（既有 K3 缺陷，非本轮引入）**：coordinator 的 `hidden:true`（`coordinator.ts:37`）从未被 fork 绑定消费——`forkCoordinatorTask` 只读 `targetMessageId` 并设 `taskType:"fork"`（`overnight-controller.ts:~180`），而 `"fork"` ∈ `TASK_LIST_SESSION_TYPES`（`task-list-session-membership.ts:12`），故 CLI 重启后冷启动 seed 会把 coordinator 投进侧栏显示为「Fork of X」——**「隐藏 coordinator」语义跨重启不成立**。修复归属 bootstrap（当前 U08 占用），登记待办。

### 5.2 资源管理器 × 卡顿归因 —— 两个诊断孤岛合成一个故事

- **现状**：`resourceManager*` 五件套（窗口/存储/进程名/host 采样）与 `stallSampler` 四件套（core/protocol/worker）各自独立；`unresponsiveReport`、`shutdownEvidence` 又是第三、四个孤岛。
- **机会**：资源管理器增加「卡顿/无响应」视图（哪个 host、哪个会话、采样窗口内的 stall 证据），并为 U12 诊断报告直接供料（U12 的 report sections 已有 `supportBundleSections.ts` 承接点）。四项诊断能力合成一条「发现异常 → 定位会话 → 导出报告」的用户旅程。
- **量级**：估 M（3-5 人日），依赖 U12 先行（报告契约是汇合点）。

### 5.3 内嵌浏览器 × CUA 浏览器操作 —— 架构评估级（登记，不排期）

- **现状**：桌面已有深度内嵌浏览器集成（chromeCookie/Credential/LocalStorage/ProfileDiscovery、browserView、站点权限 IPC），而 CUA 的浏览器操作面向外部浏览器。
- **机会**：「Agent 操作内嵌浏览器」在授权（站点权限面已有）、录制（browserView 在进程内）、审计三个维度都比驱动外部 Chrome 更可控。这是一次架构评估而非功能项——涉及 CUA 工具面与 browserView 的能力对齐、跨域授权模型，**先出评估文档再决定是否立项**。

## 6. 战略性大件与结构约束

### 6.1 活会话跨机迁移（登记不立项——是产品决策不是工程决策）

桌面开跑、手机接管继续的「会话跟人走」形态。k-series 非目标 §1 已裁决：手机远控现为 `web-remote-replayable` 重放语义，活迁移需 lease/epoch 与远程 workspace 注册表的所有权模型重构；jcode 的「会话=单所有者租约+单调 epoch」设计已存档可参照。**触发条件**：产品层决定要做活迁移体验时，先做所有权模型设计文档。

### 6.2 OS 级沙箱（预研已归档，维持登记）

[archive/vm-sandbox-roadmap.md](archive/vm-sandbox-roadmap.md) 结论：ACode 走「命令危险治理」（AST 门控、反射闸、熔断器）而非 VM 隔离；外部产品的沙箱范式已登记为设计范本。**触发条件**：出现「用户要求 Agent 无条件执行危险命令」的真实需求，或治理面被证明不够（当前无此信号——本轮 review 安全层面判定无远程无交互利用面）。

### 6.3 legacy 退役是进化速度的结构税（2026-12-31 硬 deadline）

本轮 review 实测：M1 UI 投影消费面 12 未降反增、M3 bootstrap legacy server 仍 48 文件/15,188 行、M4 barrel 3,652 行；`architecture-policy.yaml` 42 条 `expires: "2026-12-31"` 例外集中在 services/session 层，**到期未推进即门禁转红**。对桌面进化的直接影响：bootstrap W2 拆包被 M3 阻塞，桌面新功能凡触及装配层的都要绕这笔债走。**建议把 U05（legacy 退役，[runtime-and-protocol 提案](upgrades/runtime-and-protocol-2026-10.md) §3）视为与四个 U 项同优先级的事项排进日程**——它不产生新功能，但决定其余功能的生产速度。

## 7. 建议落地顺序

| 顺位 | 项 | 理由 | 量级 | 状态（2026-10-26） |
|---|---|---|---|---|
| 1 | **U12 诊断报告** | main 侧 exportLogs + UI 侧动作分支已就绪，缺口只在菜单入口与 Web 降级——最便宜的用户可感知进化，且为 §5.2 铺路 | 3-5 人日 | **✅ 已实施** `2a390ef8` |
| 2 | **U08 配置诊断** | onboarding 是留存关键；承接面（hook/service/doctor spec）全在，只欠 GUI 接线 | 4-6 人日 | **✅ 已实施** `1ead67e2` |
| 3 | **U14 工具链裁决** | 一个三选一决策解除整条差异化功能线的阻塞；裁决本身零工程量 | 决策项 | **待用户裁决**（§4） |
| 4 | **Overnight×通知接线** | 引擎已建成、部件已存在；实测非「纯接线」——需新建跨进程通道（见 §5.1） | 实为 M | **✅ 已实施** `89a515bb`+`b8a983c7` |
| 5 | **U07 目录跳转** | 桌面主力场景体验，但 store 语义裁决（窗口聚焦 vs 连续尾部）需先落 spec | 3-5 人日 | **✅ 已实施** `9d33305a` |
| 6 | **U11 图片授权引用** | 价值真实但最贵、动协议面；排最后让其吸收前序迭代对 toolDisplay 的理解 | 6-9 人日 | **✅ 已实施但生产门默认关** `87bc31f1`+`b1ad78e2` |
| 并行 | **U05 legacy 退役（M2/M3）** | 非功能项但决定功能生产速度；2026-12-31 前必须推进 | 里程碑 | 未启动 |

排序原则：先做「地基已在、只欠接线」的（1/2/4），再做需要设计裁决的（3/5），最贵且动协议面的殿后（6）；结构债（并行项）不与功能项抢同一批人力但必须有日程。

> **落地复盘（2026-10-27）**：本表 1/2/4/5/6 五项当轮全部落地，但**两处量级估计被实施推翻**——① overnight×通知原估「≤3 人日纯接线」，实测需新建 agent→host→main 三进程协议通道（§5.1），实为 M；② U11 原以为最贵的只是协议面，实施发现真正的阻塞是**能力协商无法安全新增**（`.strict()` clientHello + per-connection vs per-session 持久化的错配），故生产者建好但**默认关闭**，字节收益 deferred 到读侧改造。教训：本表「量级」栏对「纯接线」类判断系统性偏乐观——凡跨进程或跨版本兼容的接线，成本都在通道与协商，不在业务逻辑。

## 附录 A：核验证据索引（本文全部「未落地/已就绪」论断）

| 论断 | 核验方式 | 结果 |
|---|---|---|
| U07 未落地 | grep `focusIndexedRow\|returnToLive` in `packages/ui/src` | 零命中；`getTurnIndexEntries` 仅存在于 `conversationProjectionStore.ts`（提案所述「已有轻量索引」属实） |
| U08 未落地 | grep `runProviderDiagnostics` in `packages/` | 零命中 |
| U12 地基两段就绪、缺口在菜单 | `exportLogs.ts` 存在（main）；`helpMenuActions.ts:3,7,22` 有 exportLogs 动作；`WorkspaceHelpMenuButton.tsx` grep `exportLogs\|诊断` | 零命中（入口未暴露，提案 §6.1 表述与代码一致） |
| U11 未落地 | `toolDisplay.ts:232,239` | `node_repl_images` 仍 base64 内联 |
| K1-K9 已实施 | k-series 优先级总览表 | 全部带提交号标注「已实施」 |
| U14 进行中 | `git ls-files cua-producer` = 45 文件；`packages/acode-cua/` broker 面；项目记忆（阶段 0/角色 B 增量 1-3 完成、角色 A 工具链阻塞） | 一致 |
| 桌面通知面薄 | wc：`desktopNotifications.ts` 158 / `desktopTray.ts` 111 / `unreadBadge.ts` 35 | 见 §5.1 |
| main 能力面 154 文件 | `ls packages/desktop/src/main` 计数 | 154 |
| legacy deadline | `architecture-policy.yaml` 42 条 `expires: "2026-12-31"`（本轮修复中 D 代理实测）；收敛计划 2026-10-26 实测列 | 见 §6.3 与 [reviews/2026-10-26/shared-protocol.md](reviews/2026-10-26/shared-protocol.md) §3 |

未核验/转述项（如实标注）：§5.1-5.3 的人日估算为本文基于部件规模的粗估，无 spec 背书；U14 各阶段进度的细节转述自项目记忆与提案 §7（提交号在 `dev/0.0.9` 线上，未在本基线逐一重验）。
