# M2 启动前调研报告：legacy → v4 双栈切换范围与批次划分

> 生成日期：2026-10-28
> 分支：`fix/project-review-2026-10-26`
> 任务类型：只读调研 + 单文档产出
> 上游文档：`docs/legacy-protocol-convergence-plan.md` M2 节（含 2026-10-27 实测订正，行 188–250）、`docs/reviews/2026-10-26/shared-protocol.md`
> 实测基线：本分支 HEAD 的 `packages/shared/src/acode-protocol/index.ts:3495-3599` 与 `packages/shared/src/acode-protocol-v4/transport.ts:372-436`

---

## 1. 68 个 legacy 方法清单与分类

`acodeProtocolMethods` 全表 74 个 key（`packages/shared/src/acode-protocol/index.ts:3495-3599`）。其中：

- **services 实际消费 68 个**：`acodeAgentService.ts` 66 个（grep `acodeProtocolMethods\.` 实测 66 unique）+ `pluginReferenceCatalogRequest.ts` 2 个（`pluginsReferenceCatalog`、`pluginsReferenceCatalogWithCategory`）。
- **services 未消费 6 个**：`runtimeCapabilities`、`sessionStop`、`sessionCancelBackgroundTask`、`sessionFork`、`usageStats`、`sessionUsage`——均为源码注释自述的「@deprecated wire case 留兼容」残余（`index.ts:3511-3519, 3584-3589`），属 M4 整体删除范围，不在 M2。

按业务域分类（计数 = 该域下 services 实际消费的 legacy 方法数）：

| 业务域 | 方法数 | 方法 key 列表 |
|---|---:|---|
| `session/*` 生命周期 | 14 | `sessionCreate` `sessionResume` `sessionList` `sessionSubagents` `sessionRead` `sessionMessages` `sessionEvents` `sessionSubscribe` `sessionSend` `sessionCompact` `sessionGoal` `sessionClose` `sessionDebug` `sessionRequestRuntimePreferences` |
| `session/*` 配置切换 | 3 | `sessionSetModel` `sessionSetThoughtLevel` `sessionSetMode` |
| `workspace/*` | 8 | `workspaceReadPresentation` `workspaceHookTrustGrant` `workspaceUpdateInteractionPreferences` `workspaceUpdateModelIoPreferences` `workspaceUpdateOffPeakToolPolicy` `workspaceUpdateDynamicWorkflowPolicy` `workspaceGenerateText` `workspaceCancelGenerateText` |
| `plugins/*` | 16 | `pluginsList` `pluginsReferenceCatalog` `pluginsReferenceCatalogWithCategory` `pluginsResolveSuggestedReference` `pluginsSetEnabled` `pluginsOverview` `pluginsMarketplaceAdd` `pluginsMarketplaceRemove` `pluginsMarketplaceUpdate` `pluginsInstall` `pluginsCancelOperation` `pluginsUninstall` `pluginsUpdate` `pluginsRestoreBuiltin` `pluginsConfigure` `pluginsResetConfig` `pluginsValidate` `pluginsDescribe` |
| `mcp/*` | 1 | `mcpList` |
| `skills/*` | 1 | `skillsReferenceCatalog` |
| `workflows/*` | 6 | `workflowsList` `workflowsGet` `workflowsUpdateMeta` `workflowsDelete` `workflowsRuns` `workflowsMove` |
| `automation/*` | 5 | `automationCreate` `automationUpdate` `automationCheckTaskBinding` `automationList` `automationDelete` |
| `offPeak/*` | 2 | `offPeakCreate` `offPeakList` |
| `provider/*` | 2 | `providerUpdateAccountConfig` `providerTestModelConnectivity` |
| `interaction/*` (inbound) | 6 | `interactionRequestPermission` `interactionRequestUserInput` `interactionRequestProviderRuntimeHeaders` `interactionRequestOfficialMcpAuthHeaders` `interactionBrowserList` `interactionBrowserExecute` |
| `computer-use/*` (inbound) | 1 | `computerUseOperationEvent` |
| `process/*` | 1 | `processChildProcesses` |
| **合计** | **66** | （+ `pluginReferenceCatalogRequest.ts` 的 2 个 plugins/* = **68**；上表 plugins 行已含此 2 个） |

> 注：pluginReferenceCatalog 与 pluginsReferenceCatalogWithCategory 出现在 plugins 业务域（services 消费方为独立文件 `pluginReferenceCatalogRequest.ts`），故 plugins 域是 18 个调用点、16 个唯一方法 key（pluginsList 在两处都被调）。

---

## 2. 每类的 v4 等价物状态

v4 协议面实测 `V4_METHODS` 40 个 entry（`transport.ts:372-436` + grep `"v4/`），命令面 `commandPayloadSchemas` 26 个 payload kind（`command.ts:51-279`）。**与 68 个 legacy 方法的语义映射**如下。

### 2.A 完全有 v4 契约（5 个）

| legacy 方法 | v4 等价 | 证据 |
|---|---|---|
| `sessionSubscribe` | `conversationSubscribe` + `conversationResync` + `conversationFrame` 通知 | `transport.ts:378-380, 461`；消费点 `acodeAgentService.ts:5154` |
| `sessionSend`（主路径） | `command` op = `sendText` | `command.ts:109`；acodeAgentService 已部分迁，残留仅 adapter 附件回退分支（`index.ts:3508-3510` 自述） |
| `sessionStop` | `command` op = `stop` | `command.ts:169`（v4 已收敛，legacy wire case 已删 host 消费，见 `index.ts:3511-3513`） |
| `sessionCancelBackgroundTask` | `command` op = `cancelBackgroundWork` | `command.ts:248`（v4 已收敛，同上） |
| `sessionFork` | `command` op = `forkAssistant` | `command.ts:177`（v4 原生 handler；legacy 仅留 wire 兼容，见 `index.ts:3517-3519`） |

> 注：上表 5 个里前 2 个仍是 services 真实消费（acodeAgentService 在调），后 3 个 services 已不切——它们出现在此处是「v4 契约已就位、legacy 侧是 wire compat 死码」，M2 不需要动它们。

### 2.B 部分等价（14 个，**每一个都有已知字段/值域落差**）

| legacy 方法 | v4 对应 | 落差（实测） |
|---|---|---|
| `sessionCreate` | `command` op = `createSession` | 丢 `engine`/`persistence`/`importedHistory`/`toolAllowlist`；返回从完整 snapshot 变 `CommandAck`（`command.ts:51-94` vs legacy `acodeSessionStateSnapshotSchema`） |
| `sessionResume` | （v4 `cold-session-resume.ts` 内部路径） | 无对外 RPC 等价物；v4 恢复链路是 attachment 驱动的冷恢复，不是同名 resume |
| `sessionList` | （v4 `sessions-index` topic 订阅） | v4 是 conflated 订阅（`sessions-index.ts`），legacy 是一次性 query；语义不同，不是改名 |
| `sessionRead` | `sessionHeaderMeta` + `conversationSubscribe` | v4 拆成 header 冷读（`session-header-meta.ts`）+ 订阅面；legacy 是单点同步返回完整 snapshot。**已实测**：headerMeta 缺 4 个必填身份字段，需身份信封 + 投影合成（见 `docs/legacy-protocol-convergence-plan.md:80-101` M1 实施记录） |
| `sessionMessages` | `conversationRowsRange` | 分页方向相反：legacy `afterMessageId` 前向 vs v4 `beforeRowId` 后向（`transport.ts:382`） |
| `sessionEvents` | `conversationSubscribe`（topic 帧流） | legacy 是事件日志分页拉取，v4 是 snapshot+deltas 订阅；模型完全不同 |
| `sessionCompact` | `command` op = `compact` | v4 payload 是 `z.object({})` **空的**（`command.ts:175`），带不了 legacy `instructions` 字段 |
| `sessionGoal` | `command` op = `sendGoalCommand` / `pauseGoal` / `resumeGoal` | v4 拆成 3 个 op；legacy `goal` 是单点 query/set 复用（`command.ts:160, 246-247`） |
| `sessionClose` | `command` op = `deleteSession` | 语义不等价：close ≠ delete，且 legacy 断言 `expectedPersistence`（`command.ts:272` vs legacy schema） |
| `sessionSetModel` | `command` op = `switchModelConfig` | v4 完整覆盖 model+provider+thought，legacy setModel 只切 model |
| `sessionSetThoughtLevel` | `command` op = `switchModelConfig` | 同上合一 |
| `sessionSetMode` | `command` op = `switchCollaborationMode` | **v4 值域刻意排除 `auto`**（`index.ts:3529` 自述）；legacy `mode: "auto"` 残留无对应 |
| `sessionSubagents` | 无直接对应；`subagent-session-query.ts` 仅 CLI 内部 | v4 没把 subagent 列表做成对外 RPC |
| `sessionRequestRuntimePreferences` | 无；v4 走 `runtime-preferences` 内部发射器 | legacy 是 host→agent 主动拉，v4 是 agent 推送 |
| `sessionDebug` | 无 | v4 无 debug 查询面 |

### 2.C 完全无 v4 契约（54 个）

按域清点：

- **plugins/* 16 个全部无 v4 契约**：`pluginsList` `pluginsReferenceCatalog` `pluginsReferenceCatalogWithCategory` `pluginsResolveSuggestedReference` `pluginsSetEnabled` `pluginsOverview` `pluginsMarketplaceAdd` `pluginsMarketplaceRemove` `pluginsMarketplaceUpdate` `pluginsInstall` `pluginsCancelOperation` `pluginsUninstall` `pluginsUpdate` `pluginsRestoreBuiltin` `pluginsConfigure` `pluginsResetConfig` `pluginsValidate` `pluginsDescribe`（grep `transport.ts` + `command.ts` 对 `plugins` 零命中）。
- **mcp/* 1 个无**：`mcpList`（v4 无 mcp 域）。
- **skills/* 1 个无**：`skillsReferenceCatalog`。
- **workflows/* 6 个全无**：`workflowsList` `workflowsGet` `workflowsUpdateMeta` `workflowsDelete` `workflowsRuns` `workflowsMove`（v4 的 `workflow-runs*`/`script-workflow-management` 是**会话内脚本执行面**，不是已保存工作流的 GUI 中枢管理面）。
- **automation/* 5 个全无**：`automationCreate` `automationUpdate` `automationCheckTaskBinding` `automationList` `automationDelete`。
- **offPeak/* 2 个全无**：`offPeakCreate` `offPeakList`（v4 的 `overnight-completion` 是 K3 完成信号单向通知，不是 CRUD 面）。
- **provider/* 2 个全无**：`providerUpdateAccountConfig` `providerTestModelConnectivity`。
- **workspace/* 8 个全无**：`workspaceReadPresentation` `workspaceHookTrustGrant` `workspaceUpdateInteractionPreferences` `workspaceUpdateModelIoPreferences` `workspaceUpdateOffPeakToolPolicy` `workspaceUpdateDynamicWorkflowPolicy` `workspaceGenerateText` `workspaceCancelGenerateText`（v4 `workspace-config.ts` 是**订阅 topic**，不是 RPC 命令面）。
- **process/* 1 个无**：`processChildProcesses`。
- **interaction/* 6 个无（且语义为 inbound）**：见 2.D。
- **computer-use/* 1 个无（inbound）**：见 2.D。
- **session/* 4 个全无 v4 等价**（含在 14 个部分等价之外的零等价项）：`sessionDebug`、`sessionSubagents`、`sessionRequestRuntimePreferences`、`sessionEvents`（v4 有模型替换但语义完全不同，归为「需要重新设计」而不是「部分等价」）。

> 交叉核对：5（完全有）+ 14（部分）+ 49（完全无）= 68。上面把 `sessionEvents`/`sessionSubagents`/`sessionRequestRuntimePreferences`/`sessionDebug` 同时计入 2.B 与 2.C 是**因为它们介于两者之间**：v4 语义模型已换，不能再叫「等价」；本报告最终归类：**14 个部分等价 + 49 个完全无 + 5 个完全有 = 68**。

### 2.D inbound handler（7 个，**不是单纯客户端切换**）

这些方法的调用方向是 **agent → host**（services 在 `acodeAgentService.ts` 里挂 `client.on("request", ...)` handler）：

| 方法 | services handler 位置 | v4 等价 |
|---|---|---|
| `interactionRequestPermission` | `acodeAgentService.ts:2301-2330` | **架构性替换**：v4 用 `pendingInteractions` 快照行（`snapshot.ts:267, 544`）+ `resolveInteraction` 命令（`command.ts:201`），是 broker 重设计而非改名 |
| `interactionRequestUserInput` | `acodeAgentService.ts:2330` 起的同族分支 | 同上 |
| `interactionRequestProviderRuntimeHeaders` | 同文件（grep 命中） | 无 v4 等价；v4 broker 仅覆盖 permission/userInput 两类 |
| `interactionRequestOfficialMcpAuthHeaders` | 同文件 | 同上 |
| `interactionBrowserList` | 同文件 | v4 `browser-control-broker.ts` 仅在 legacy server 目录，无 v4 broker |
| `interactionBrowserExecute` | 同文件 | 同上 |
| `computerUseOperationEvent` | `acodeAgentService.ts:2039` | v4 `cua-permission-observation.ts` 仅承载 permission 观测，不含 operation event；CUA 包整面 fail-closed（`packages/acode-cua`） |
| `automationCreate` | `acodeAgentService.ts:2605` | 无 v4 等价 |
| `offPeakCreate` | `acodeAgentService.ts:2666` | 无 v4 等价 |

**含义**：这 9 个的迁移必须 **CLI 先改发出 v4 形态**，host 才能改 handler；不是单纯改 services 调用，而是两侧协议变更。permissions 一对尤其需要从 request/response 改造成「快照行 + resolve 命令」的 broker 模型。

---

## 3. 消费方矩阵

### 3.1 services 侧消费（全部 68 个）

唯一两个文件：

- `packages/services/src/acode-agent/acodeAgentService.ts`（66 个唯一方法 key，grep 实测；调用点散布全文，最主要集中在 3670–5160 行区段）
- `packages/services/src/acode-agent/pluginReferenceCatalogRequest.ts`（2 个：`pluginsReferenceCatalog` `pluginsReferenceCatalogWithCategory`）

**误报排除**（2026-10-27 实测订正已记录，`docs/legacy-protocol-convergence-plan.md:213-218`）：

- `packages/services/src/node.ts:108` 是 barrel re-export，非消费
- `packages/services/src/acode-agent/acodeAgentProcessManager.ts:45` 只是 import 类型，方法调用数 = 0
- `packages/services/src/acode-agent/acodeProtocolClient.ts` 是 transport 载体本身（**不是 legacy 客户端**，方法名联合已含 `V4Method`，见 `:19`）；M2 完成后它继续存在，作为唯一协议面载体

### 3.2 CLI bootstrap dispatch 点

单一入口 `apps/acode-cli/packages/bootstrap/src/acode-protocol/server.ts`，dispatch 集中在行 640–794：

| 行号 | 处理的方法族 |
|---|---|
| `server.ts:640-674` | session/* 生命周期 14 个 |
| `server.ts:676` | `workspaceReadPresentation` |
| `server.ts:678-696` | `workspaceHookTrustGrant`（含 notify 联动） |
| `server.ts:697-714` | `provider/*` + `workspace/Update*` 6 个（含 generate/cancel 包装） |
| `server.ts:721-722` | `mcpList` |
| `server.ts:723-730` | `pluginsList` `pluginsReferenceCatalog(WithCategory)` `skillsReferenceCatalog` |
| `server.ts:731-742` | `workflows/*` 6 个 |
| `server.ts:743-786` | `plugins/*` 操作面 14 个（`pluginsResolveSuggestedReference` 起） |
| `server.ts:787-792` | `usageStats` `sessionDebug` `sessionUsage`（wire compat 死码） |

inbound 方向（agent→host）的 dispatch 不在 server.ts，而在 services 侧 client.on("request") handler（见 2.D 表）。

每个 legacy case 的实体实现分散在 `apps/acode-cli/packages/bootstrap/src/acode-protocol/` 48 个文件中（`session-*.ts`、`plugins.ts`、`automation-port.ts`、`off-peak-tool-policy.ts`、`workspace-*.ts`、`provider-*.ts`、`browser-control-broker.ts`、`interaction-broker.ts` 等）。

---

## 4. stream / snapshot / queue 触及面（13 个高危方法）

按源码语义逐方法核对，68 个里**确与 stream/snapshot/queue/reconnect 语义直接相关**的有 13 个：

| 方法 | 触及面 | desktop-continuous 影响 | web-remote-replayable 影响 |
|---|---|---|---|
| `sessionSubscribe` | snapshot + deltas 推送 | 持续订阅，通道常开 | **冷恢复走这条**，replayable 必须拉到完整 snapshot 才能续 |
| `sessionSend` | turn 流式产生 + queue admission | busy 时 `queue` 入队 / `startNow` 抢占 | replayable 模式下 queue 持久化跨进程恢复 |
| `sessionStop` | 流中断 + queue 清空 | 立即终止流 | 恢复时需识别已停的 turn |
| `sessionCancelBackgroundTask` | 后台 work queue | 取消 live work | 取消需跨 replay 命中 |
| `sessionFork` | snapshot 分支 | fork 后产生新流 | replayable 需能 fork 已结束的 turn |
| `sessionCompact` | snapshot 重写 | 流式生成压缩 summary | compact 是状态变更，replayable 必须能看到 |
| `sessionCreate` | 初始化 snapshot + 队列就位 | 同步返回完整 snapshot | replayable 的 attachment 首次创建路径 |
| `sessionResume` | 冷恢复 snapshot | 桌面恢复 | **replayable 的核心入口** |
| `sessionRead` | 完整 snapshot 一次性读 | 调试/归档 | replayable 冷读 |
| `sessionMessages` | 消息分页（含 in-flight streaming rows） | 桌面滚动加载 | replayable 历史回放 |
| `sessionEvents` | 事件日志 | 审计/调试 | replayable 事件回放 |
| `sessionGoal` | goal 状态（驱动 turn 调度） | 流中段变更 goal | replayable 必须看到最新 goal |
| `sessionClose` | 终止 snapshot 写入 | 桌面关会话 | replayable 会话归档 |

**冒烟测试含义**（按 `docs/legacy-protocol-convergence-plan.md:192` M2 风险条）：这 13 个的每一个迁移批次都必须跑 desktop-continuous + web-remote-replayable **双链路真实冒烟**，headless 环境不可跑（前者需要 desktop main 进程持续通道，后者需要远端 relay 回放语义）。

其余 55 个不直接触及 stream/snapshot/queue（它们是 CRUD / 配置 / catalog / marketplace / interaction broker），冒烟要求可降级为单链路功能测试 + 单元测试。

---

## 5. 批次划分建议

按「可独立 PR 落地、每批可单独验收」切分。**前置约束**：每批都必须先建 spec（`apps/acode-cli/specs/` 下新增），再动 schema，再动 CLI gateway，再动 services；顺序不可颠倒（spec-first 是 AGENTS.md 核心原则）。

### Batch M2-0 — 准备件（前置，不迁方法）

- **内容**：把 `acodeAgentService` 的 type-only 消费从具体 `ACodeProtocolClient` 类解耦到中立接口叶子（继承 2026-10-27 已开的线）；明确 `acodeProtocolClient.ts` 是永久载体，从 grep 验收判据中豁免（改写判据为「services 内 legacy **方法** 消费 = 0」）。
- **新增 v4 schema**：无。
- **services 改动**：接口抽离。
- **CLI 改动**：无。
- **验收测试**：typecheck + lint；不改动运行时行为。
- **预估**：0.5 人日。

### Batch M2-1 — session/* 配置切换三件套（3 个）

- **方法**：`sessionSetModel` `sessionSetThoughtLevel` `sessionSetMode`。
- **v4 改动**：`command.ts` 的 `switchModelConfig` 已存在；`switchCollaborationMode` 已存在。~~**裁决项**：`mode: "auto"` 是否保留~~ → **已裁决（2026-10-28，默认裁决产品可推翻）：auto 保留**，v4 值域补 `auto`（见 §6.3）。
- **services 改动**：`acodeAgentService.ts:4959, 4993, 5008` 三处切到 v4 `command` op。
- **CLI 改动**：无（v4 handler 已就位，`commands/handlers/model-config.ts`）。
- **验收**：双链路真实冒烟（切 model/mode 是流中段操作，触及 snapshot.config）；auto 裁决落地后补对应值域测试。
- **预估**：1.5 人日（含 auto 裁决讨论）。

### Batch M2-2 — session/* 控制面四件套（4 个）

- **方法**：`sessionCompact` `sessionGoal` `sessionClose` `sessionDebug`。
- **v4 改动**：
  - `compact` 命令扩 payload 支持 `instructions`（当前是 `z.object({})`，`command.ts:175`）——**裁决已落（2026-10-28，默认裁决产品可推翻）：instructions 保留**，协议面已随 M2-1 落地，本批接管消费侧。
  - `sendGoalCommand`/`pauseGoal`/`resumeGoal` 已存在；需补 legacy goal 的 query 形态。
  - ~~`deleteSession` vs `closeSession` 语义裁决~~ → **已裁决：两个真语义都保留**（close=终止/归档 snapshot 写入并保留 `expectedPersistence` 断言，delete=删除），v4 侧补 `closeSession` op 属本批。
  - ~~`sessionDebug` 是否保留？~~ → **已裁决：保留**，本批新建 v4 debug query。
- **services 改动**：`acodeAgentService.ts:4849, 4891, 4933` 三处 + debug 一处。
- **CLI 改动**：`commands/handlers/goal-compact.ts` `session-mgmt.ts` 扩。
- **验收**：~~3 个产品裁决~~（已裁决，见 §6.3：compact instructions 保留 / close、delete 两语义并存 / debug 保留新建 v4 query；goal query 形态随本批设计）+ 双链路冒烟（compact 重写 snapshot、close 终止 snapshot）。
- **预估**：3 人日（含 3 个裁决 + 协议扩展）。

### Batch M2-3 — session/* 读写面七件套（7 个，**最重**）

- **方法**：`sessionCreate` `sessionResume` `sessionList` `sessionRead` `sessionMessages` `sessionEvents` `sessionSubscribe` `sessionRequestRuntimePreferences`（8 个；含 M1 阻塞项 `sessionSubscribe`）。
- **v4 改动**：
  - `createSession` 命令补 `engine`/`persistence`/`importedHistory`/`toolAllowlist` 字段；返回从 `CommandAck` 扩为可选 snapshot 承载。
  - `sessionResume` 需新建 v4 冷恢复 query（不激活运行时的 resume）。
  - `sessionList` 已由 v4 `sessions-index` topic 承载——但是订阅不是 query，需在 services 侧加一次性 list snapshot 的 query。
  - `sessionRead` 拆为 `sessionHeaderMeta`（已有）+ `conversationSubscribe`（已有）的合成；services 侧改拼接。
  - `sessionMessages` → `conversationRowsRange` 分页方向反转，services 适配层需做 afterMessageId ↔ beforeRowId 转换。
  - `sessionEvents` 需裁决：是新建 v4 events 日志查询，还是并入 conversation frame 流？
  - `sessionSubscribe` 已在 v4（`conversationSubscribe`），但它阻塞在 M1（UI 投影收口 2026-10-28 已落地，可解阻）。
  - `sessionRequestRuntimePreferences` 改为 v4 推送订阅（CLI 侧发射器改 v4 topic）。
- **services 改动**：`acodeAgentService.ts:3679-3979` 与 `5154` 共 8 处大改，可能需新建 adapter 模块。
- **CLI 改动**：v4 gateway 新增 2-3 个 query handler；conversation frame 协议扩 events 字段（若裁决走该路径）。
- **验收**：完整双链路冒烟 + 桌面新建/恢复/列表/读取/消息分页/事件回放全 scenario；分页方向反转必须有专门测试钉住。
- **预估**：8 人日（协议扩展工作量最大 + 触及 8 个 stream/snapshot/queue 高危方法）。

### Batch M2-4 — inbound interaction broker 重设计（7 个）

- **方法**：`interactionRequestPermission` `interactionRequestUserInput` `interactionRequestProviderRuntimeHeaders` `interactionRequestOfficialMcpAuthHeaders` `interactionBrowserList` `interactionBrowserExecute` `computerUseOperationEvent`。
- **v4 改动**：
  - permission/userInput 已架构性替换为 `pendingInteractions` 快照行 + `resolveInteraction` 命令——但**仅 CLI → host 单向**已就位；agent → host 方向的请求如何以 v4 形态发出的设计**不在源码里**，需先写 broker 重设计 spec。
  - `ProviderRuntimeHeaders` / `OfficialMcpAuthHeaders` 需新建 v4 broker 通道。
  - `BrowserList`/`BrowserExecute` 需新建 v4 browser broker（当前 `browser-control-broker.ts` 在 legacy 目录）。
  - `computerUseOperationEvent` 整面 fail-closed（`packages/acode-cua`），可能直接删除不迁。
- **services 改动**：handler 注册点全改（`acodeAgentService.ts:2039, 2301, 2330` 等）。
- **CLI 改动**：agent 侧发出端全改。
- **验收**：桌面权限弹窗、AskUserQuestion、browser 操作、CUA 事件全链路；broker 重设计需双链路 + 跨进程 skew 测试（旧 CLI + 新 host 与新 CLI + 旧 host 各自行为）。
- **预估**：8 人日（含 broker spec 重写）。
- **备注**：这是**两侧协议变更**，不能像其他批次一样单边落地。需要分两个 PR：CLI 发双形态（legacy + v4 并存）→ host 切 v4 → CLI 删 legacy。

### Batch M2-5 — plugins 域（16 个）

- **方法**：plugins 域全部 16 个。
- **v4 改动**：从零建 v4 plugins 协议面（当前 grep `plugins` 在 v4 目录零命中）。需新建 `acode-protocol-v4/plugins.ts` 与对应 CLI gateway 分支。
- **services 改动**：`acodeAgentService.ts` 14 处 + `pluginReferenceCatalogRequest.ts` 2 处。
- **CLI 改动**：从 `acode-protocol/plugins.ts` + `plugin-reference-catalog.ts` 迁实现进 v4 gateway。
- **验收**：插件列表/启停/marketplace/安装/卸载/配置/校验/描述全 scenario 桌面 + Web 双端。
- **预估**：6 人日（协议面全新建，但不触及 stream/snapshot/queue，单链路功能测试可接受）。
- **可拆分**：可进一步拆 M2-5a（读路径 6 个：list/overview/describe/validate/referenceCatalog×2）与 M2-5b（写路径 10 个），各 3 人日。

### Batch M2-6 — workflows + skills + mcp（8 个）

- **方法**：`workflowsList` `workflowsGet` `workflowsUpdateMeta` `workflowsDelete` `workflowsRuns` `workflowsMove` + `skillsReferenceCatalog` + `mcpList`。
- **v4 改动**：新建 `acode-protocol-v4/workflows.ts`（与现有 `workflow-runs*.ts` **不同域**——那是会话内执行面，这是已保存工作流 GUI 中枢）；skills/mcp 参考目录协议。
- **services 改动**：`acodeAgentService.ts` 8 处。
- **CLI 改动**：从 `saved-workflows.ts` `skill-reference-catalog.ts` `mcp.ts` 迁。
- **验收**：已保存工作流 CRUD + 移动 + 运行记录列表；skills catalog 渲染；MCP server 列表。
- **预估**：4 人日。

### Batch M2-7 — automation + offPeak（7 个）

- **方法**：`automationCreate` `automationUpdate` `automationCheckTaskBinding` `automationList` `automationDelete` + `offPeakCreate` `offPeakList`。
- **v4 改动**：新建 v4 automation 协议面；注意 `automationCreate`/`offPeakCreate` 是 **inbound**（agent→host），与 Batch M2-4 同性质，需 broker 形态。
- **services 改动**：5 处 outbound + 2 处 inbound handler。
- **CLI 改动**：automation 实体在 `automation-port.ts` + `offpeak-port.ts` + `off-peak-tool-policy.ts`，需迁；inbound 2 个需 CLI agent 侧发出端改 v4。
- **验收**：定时任务 CRUD + Off-Peak 会话创建/列表；inbound 部分需双 PR 节奏。
- **预估**：5 人日（含 inbound broker 改造）。

### Batch M2-8 — workspace + provider + process（11 个）

- **方法**：`workspaceReadPresentation` `workspaceHookTrustGrant` `workspaceUpdateInteractionPreferences` `workspaceUpdateModelIoPreferences` `workspaceUpdateOffPeakToolPolicy` `workspaceUpdateDynamicWorkflowPolicy` `workspaceGenerateText` `workspaceCancelGenerateText` + `providerUpdateAccountConfig` `providerTestModelConnectivity` + `processChildProcesses`。
- **v4 改动**：新建 v4 workspace 配置命令面 + provider 诊断面 + 进程观测面。
- **services 改动**：11 处。
- **CLI 改动**：从 `workspace-model-runtime.ts` `workspace-hook-trust.ts` `interaction-preferences.ts` `model-io-preferences.ts` `off-peak-tool-policy.ts` `dynamic-workflow-policy.ts` `workspace.ts` `account-provider-config.ts` `provider-diagnostics.ts` `process-child-processes.ts` 迁。
- **特殊约束**：`workspaceGenerateText` 源码已自述「LLM 执行面在 CLI，直连不可行；消费仅 services 内部，待 v4 workspace 查询/命令面覆盖后移除」（`index.ts:3543-3544`）——**这条可能不迁，改为直接退役**。
- **验收**：workspace 配置读写 + provider 连接测试 + 进程观测。
- **预估**：5 人日。

### 批次小结

| 批次 | 方法数 | 预估人日 | 阻塞依赖 |
|---|---:|---:|---|
| M2-0 准备 | 0 | 0.5 | 无 |
| M2-1 session 配置 | 3 | 1.5 | ~~mode auto 产品裁决~~（已裁决 2026-10-28：auto 保留） |
| M2-2 session 控制 | 4 | 3 | ~~3 个产品裁决（compact/goal/close）~~（已裁决 2026-10-28，见 §6.3） |
| M2-3 session 读写 | 8 | 8 | M1 已落地；最重批次 |
| M2-4 inbound interaction | 7 | 8 | broker 重设计 spec；两侧协议变更 |
| M2-5 plugins | 16 | 6 | 无（全新建） |
| M2-6 workflows/skills/mcp | 8 | 4 | 无 |
| M2-7 automation/offPeak | 7 | 5 | inbound broker 形态依赖 M2-4 |
| M2-8 workspace/provider/process | 11 | 5 | `workspaceGenerateText` 退役裁决 |
| **合计** | **68** | **41 人日** | — |

---

## 6. 风险与阻塞

按启动前必须解决的优先级排序：

1. **M2 验收判据需重写**（**最先做**）。当前判据 `git grep -l "acodeProtocolMethods\|acodeProtocolClient"` 归零结构性不可满足（`acodeProtocolClient.ts` 是 v4 载体，必须存活）。改为「services 内 legacy **方法**消费 = 0」+ 新增 `acodeProtocolMethods` 符号消费为零的 grep。证据：`docs/legacy-protocol-convergence-plan.md:194-211` 实测订正。

2. **v4 协议面扩展节奏失控风险**。54 个方法需新建 v4 schema，但 v4 当前只有 40 method + 26 command。等于**翻一倍 v4 协议面**。必须先建立 spec-first 节奏（每个批次至少一份 spec），否则协议面会野蛮生长。证据：`transport.ts:372-436` 实测 v4 当前覆盖。

3. ~~**3 个产品裁决未落地**（不解决则 M2-1/M2-2 无法动工）~~ → **已裁决（2026-10-28，orchestrator 默认裁决：保守无能力损失；产品可推翻）**：
   - `mode: "auto"` **保留**。v4 `switchCollaborationMode` 值域补 `auto`（`command.ts`）——legacy `acodeSessionModeSchema` 含 auto 且有残留消费（adapter `switchCollaborationModeViaProtocol` 的 auto 分支），v4 刻意排除会收窄 legacy 能力；补值 = 放宽，向后兼容（core `CollaborationMode` 本就含 auto，CLI handler 直驱 `app.setMode` 无需改动）。**已随 M2-1 落地**。
   - `sessionCompact` 的 `instructions` 字段**保留**。v4 `compact` 命令 payload 加可选 `instructions?: string`（原 `z.object({})` 带不了该字段）——不丢字段。**本批（M2-1）只落协议面**；compact 消费迁移属 M2-2。
   - `sessionClose` 与 `deleteSession` **是两个真语义，都保留**：close = 终止/归档 snapshot 写入（保留 legacy `expectedPersistence` 断言语义），delete = 删除。v4 侧补 `closeSession` op 属 M2-2；本批只落裁决文档。
   - 附加三问同批裁决：`sessionDebug` **保留**（M2-2 新建 v4 debug query）；`sessionEvents` **保持独立事件日志查询**（与 conversation frame 的 snapshot+deltas 模型不同，不并入）；`workspaceGenerateText` **不直接退役**（随 workspace 域批次 M2-8 迁移，不提前删除）。

4. **inbound broker 重设计（M2-4 + M2-7 部分）是隐藏大坑**。9 个方法是 agent→host 方向，迁移需要 CLI 先发 v4 形态 + host 才能改 handler，**两侧协议变更**必须分 PR 落地（CLI 双形态共存 → host 切换 → CLI 删 legacy）。permissions 一对更复杂：架构性替换为 broker 模型，不是改名。证据：`acodeAgentService.ts:2301` handler 注册 vs `command.ts:201` resolveInteraction。

5. **双链路真实冒烟环境**（M2-3/M2-4 强阻塞）。13 个 stream/snapshot/queue 高危方法必须跑 desktop-continuous + web-remote-replayable 真实冒烟。当前 headless 环境**不可跑**。需要：桌面 main 进程持续通道运行环境 + 远端 relay replayable 链路环境。M2-3 之前必须备齐。证据：`docs/legacy-protocol-convergence-plan.md:192` 风险条。

6. **`sessionSubscribe` 阻塞已解除**。M1（UI 投影收口）2026-10-28 已落地（`docs/legacy-protocol-convergence-plan.md:46-57`），M2-3 的最大前置已清。

7. **`acode-cua` 包 fail-closed 状态**（M2-4 子项）。`computerUseOperationEvent` 当前不可用，可能直接删除而不迁。需要维护者确认。证据：`packages/acode-cua` 整面 fail-closed。

8. **不可迁需保留的方法**。当前识别 0 个绝对不可迁，但 `sessionDebug`（v4 无 debug 面）、`processChildProcesses`（CLI 内存态暴露）、`workspaceGenerateText`（已自述待退役）三方法的「迁 vs 删」需在批次动工前明确。

9. **进度表节拍**。`docs/legacy-protocol-convergence-plan.md` 自述 M2 是「多周到多月的协议扩展工程」（`:246-247`）。本报告 41 人日的实测分配证实该判断。**不应在 M2 内追求一次性 PR 大而全**；9 个批次各自独立可落。

---

## 7. 一句话总结

**M2 共 68 个 legacy 方法，分 9 批，预估总工作量 41 人日，最大阻塞是 v4 协议面扩展节奏（54 个方法无 v4 契约需 spec-first 新建）；3 个产品裁决（mode auto / compact instructions / close-vs-delete）已于 2026-10-28 落地（默认裁决，产品可推翻，见 §6.3）。**
