# Spec：RunWorkflow（脚本工作流 /ultracode）完整 parity 管理面

状态：revised（t-4 评审必改项 2/3/4/6/7 已落文；实现随本文件进行。2026-10-18 P2 修复线：
statuses 过滤下推 + truncated 语义订正（§4.1/§9 A7）、usageIncomplete 存在性读面（§4.1）、
技能面第二道门（§4.5）、UI 写入路径订正（§5/§8.1）、新增已知限制 §13）
日期：2026-10-17
作者：workflow-parity-builder（修复线 B）
事实基线：`.agent-teams/reports/t1-workflow-surface.md`、`.agent-teams/reports/t4-cross-verification.md`（两报告对本 spec 引用的 file:line 均已独立核验）
用户裁决：**完整 parity**（运行历史 + 已持久化脚本清单 + 三档灰度），不是最小面。

---

## 0. 结论速览

1. RunWorkflow 的运行 journal **已经持久化在 SQLite**（`workflow_run` 表），并已有按 cwd 枚举的
   存储查询 `listScriptWorkflowRuns`——缺口只在「协议层无枚举方法 + UI 无呈现」，
   **不需要新建存储**。
2. 已持久化脚本清单对应 `workflow_definition` 表（每次 run 启动经
   `prepareScriptWorkflowRun` upsert），存储查询同样已存在缺口：port 只有
   `upsertScriptWorkflowDefinition`，**没有 list 方法**——这是唯一需要新增的存储读面。
3. 三档灰度 `scriptWorkflowMode` 完全同构 `dynamicWorkflowMode` 的字段链，但**没有**
   远端下发与环境变量覆盖——它是本机产品开关，不是发布灰度，折叠链因此更短
   （只读 AppSettings，无 client config 三段折叠）。
4. 协议只进 v4：两个只读查询命令（`listScriptWorkflowRuns` / `listScriptWorkflowDefinitions`）
   + 一个 createSession 门控 flag（`scriptWorkflowEnabled`）。legacy `acode-protocol/index.ts`
   **零新增**。
5. UI：运行历史与脚本清单落 workspace「自动化 → 工作流」中枢页内的新分组
   「脚本工作流」；三档开关落设置侧栏既有 `dynamicWorkflow` 分区页内的新卡片。
   **不新增设置侧栏分区**（论证见 §7.3）。

---

## 1. 背景与缺口（引用基线，均已核验）

两套工作流系统在「斜杠命令层对称、管理面不对称」（t1 §四.4.4）：

| 维度 | CreateWorkflow（dwf） | RunWorkflow（脚本工作流） |
| --- | --- | --- |
| 工具 | `CreateWorkflow` + 十个创作工具 | `RunWorkflow`（`apps/acode-cli/packages/core/src/tool/handlers/run-workflow.ts`） |
| 斜杠命令 | `/workflow` | `/ultracode`（`apps/acode-cli/packages/bootstrap/src/builtin-ultracode-command.ts`） |
| 设置分区 | `dynamicWorkflow`（`packages/ui/src/settings/settingsPageConfig.ts:111`） | 无 |
| 已保存定义列表 | `SavedWorkflowsSection`（扫 `.dwf.ts` 文件） | 无 |
| 运行历史列表 | `SavedWorkflowRunHistoryPanel`（`workflows/runs` 协议） | 无 |
| 灰度三档 | `dynamicWorkflowMode`（全链贯穿） | 无 |

用户触点仅有对话内权限块（`packages/ui/src/ScriptWorkflowPermissionBlock.tsx`）与侧栏运行
实例视图（`WorkflowRunSidePane`，且其 Resume/配置是 **dwf 专属**命令，打到脚本工作流 run 上
会被拒——`packages/ui/src/app-shell/WorkflowRunSidePane.tsx:233` 注释明文）。

---

## 2. 现状探索：journal 存储格式与现有工具面（spec 事实底座）

### 2.1 存储（全部已存在，实测 file:line）

**`workflow_run` 表**（migration 0007，`apps/acode-cli/packages/adapters/src/storage/session-store/migrations.ts:251-286`）：

- 主键 `id`（`wf_<uuid>`，`prepareScriptWorkflowRun` 铸造，`apps/acode-cli/packages/cli-workflow/src/script-workflow-prepare.ts:45`）
- 关键列：`definition_id`、`name`、`kind`（恒 `'script'`）、`parent_session_id`（FK session）、
  `cwd`、`script_path`、`script_hash`、`args_json`、`status`（CHECK 六词）、
  `result_json` / `failure_json`、`budget_spent` / `budget_total`、`stats_json`、
  `tool_call_id`（migration 0027 起）、`workspace_identity` / `remote_session_id` /
  `owner_token` / `owner_generation`、时间列 `time_created / time_started / time_completed / time_updated`
- 现成索引：`workflow_run_cwd_status_idx on workflow_run(cwd, status, time_updated desc)`
  （migrations.ts:283-284）——**按项目枚举正好命中这个索引**。
- 状态词表受 CHECK 约束（`SCRIPT_WORKFLOW_RUN_STATUSES`，`apps/acode-cli/packages/contracts/src/workflow/script.ts:94-101`）：
  `pending | running | paused | completed | failed | cancelled`。

**逻辑状态与 stop_reason**（`apps/acode-cli/packages/cli-workflow/src/script-workflow-run-status.ts`，
全仓唯一映射）：

- 逻辑词 = 物理词 + `interrupted`；`cancelled` + `failure_json.code === "ScriptWorkflowInterrupted"`
  → `interrupted`（宿主进程在结算前退出，孤儿收敛写入）；`cancelled` 无 code → 用户取消
  （用户停的**不写** failure，这是「用户停」与「进程死」的唯一判据，绝不解析 message 文本）。
- 对应物（同名概念）在 dwf 侧是 `dwf_run` 的 `stopped{reason}` 信封 + `dwf-journal-codecs.ts`。
  两套系统**各自有一份映射文件**，不共享，这是刻意的（物理词表本来就不同）。

**`workflow_definition` 表**（migrations.ts:235-249）：`id`（`script_<hash24>`，路径+哈希铸造）、
`name`、`source`（builtin|user）、`trusted`、`enabled`、`script_path`、`script_hash`、
`meta_json`（`WorkflowScriptMeta`：name/description/phases/whenToUse）、`time_created/time_updated`，
scope 列由 migration 0008 补（`explicit|project|user`，builtin 由 source 表达）。
每次 run 启动 upsert（`script-workflow-prepare.ts:26-34`），同一脚本文件迭代后哈希变化会产生新行。

**store port 与实现**（`apps/acode-cli/packages/contracts/src/workflow/script.ts:326-372`）：

- `listScriptWorkflowRuns({ cwd?, limit?, parentSessionId?, statuses? })` **已存在**，SQLite 实现
  `apps/acode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-runs.ts:245`。
  注意其 `parentSessionId` 注释：冷回放必须会话作用域，但 **`cwd` 是独立可用的过滤维**——
  管理面按项目枚举正是 `cwd` 过滤（与 `ScriptWorkflowRuntime.list` 同一取数，
  `apps/acode-cli/packages/cli-workflow/src/script-workflow-runtime.ts:165-174`）。
- `ScriptWorkflowDefinitionRecord` 的 list 查询 **不存在**：port 只有
  `upsertScriptWorkflowDefinition`（script.ts:365）。→ 本 spec 新增
  `listScriptWorkflowDefinitions`（R4）。

### 2.2 现有工具面辨析（任务书点名要探索透的四件）

`ListWorkflowRuns` / `GetWorkflowRun` / `ResumeWorkflowRun` / `AmendWorkflow` 四个工具
（contracts：`apps/acode-cli/packages/contracts/src/tools/list-workflow-runs.ts` 等）是
**dwf（CreateWorkflow）系统的模型工具**，取数底座是 adapters 的
`DwfRunIntrospectionQueries`（`dwf-journal-introspection.ts`，`dwf_run` 表），能力探测接进
`ListWorkflowRuns`/`GetWorkflowRun`（`apps/acode-cli/packages/workflow-run-read/src/app/journal.ts:104-135`）。
**它们不读 `workflow_run` 表，与本 spec 的读面无关**。脚本工作流的模型侧状态查询走
`scriptWorkflowStatus`（facade 方法，`script-workflow-runtime.ts:176-203`）。
本 spec 的管理面读数与这四个工具**平行、不共用查询**——不要把两套 journal 混在同一列表里
（物理表、状态词表、owner 语义都不同）。

### 2.3 v4 命令通路（新协议的落点形状）

- shared 侧：`packages/shared/src/acode-protocol-v4/command.ts` 的 `commandPayloadSchemas`
  加条目即同时派生 `CommandType` / `CommandPayloadMap` / `commandTypeSchema`（command.ts:252-260）；
  envelope 的 `sessionId` **nullable**（command.ts:330-331）。
- CLI 侧：`apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/commands/handlers/`
  注册表 `NATIVE_HANDLERS`（handlers/index.ts:26-41，每组加一行 spread）。
- 工作流命令族先例：`startSavedWorkflow` / `amendWorkflowRunSettings`
  （handlers/interaction-background.ts:230-312）——**命令锚定一个会话 record**
  （`requireRecord(host, envelope.sessionId)`），能力经 `record.app.*` facade 暴露，
  能力缺席抛 `V4CapabilityUnsupportedError`，业务拒绝以
  `fault.command.<name>Rejected.<reason>` reasonCode 回 ACK。
- UI 侧：`createCommandEnvelope({ type, payload, sessionId })` → `sendCommand`
  （先例 `packages/ui/src/app-shell/useWorkflowRunPaneSettings.ts:73-79`）。
- 既有锚会话先例：工作流中枢的「运行」按钮经 `useSavedWorkflowLauncher`
  （创建/复用会话后发 `startSavedWorkflow`）。管理面只读查询同样锚定当前 workspace 的
  活动会话（数据本身是 workspace 级：`listScriptWorkflowRuns` 按 cwd 过滤跨会话——
  app facade 持有 sessionStore 与 workingDirectory，回答 workspace 级问题不需要会话级状态，
  锚会话只是**路由键**，与 startSavedWorkflow 同拓扑）。

### 2.4 `dynamicWorkflowMode` 现有链路（scriptWorkflowMode 的同构底稿，逐一实测）

| # | 落点 | file:line | 作用 |
| --- | --- | --- | --- |
| 1 | 类型与取值域 | `packages/shared/src/dynamic-workflow-feature.ts:9-10` | `DYNAMIC_WORKFLOW_MODES`、`DynamicWorkflowMode` |
| 2 | 归一化与折叠 | 同文件 :39-91 | `normalizeDynamicWorkflowMode`、`resolveDynamicWorkflowClientConfig`（env > remote > default 三段） |
| 3 | AppSettings 字段 | `packages/shared/src/protocol.ts:309` | `dynamicWorkflowMode?: DynamicWorkflowMode` |
| 4 | 存储 schema | `packages/shared/src/validationAppSettings.ts:41`（enum）+ **:505**（`appSettingsObjectSchema`，漏登记则写盘被 strip，2026-10-11 实机实测教训见 :502-503 注释）+ **:554**（`appSettingsPatchSchema`） | 三处缺一不可 |
| 5 | 设置 UI | `packages/ui/src/settings/DynamicWorkflowSection.tsx`（三档 radiogroup，`SettingsGroupCard`）+ `packages/ui/src/SettingsPage.tsx:822`（`settingService.update` 写盘）+ `:1583-1588`（挂载） | 选中态唯一来源是 Host 快照，组件不持有副本 |
| 6 | services 折叠出口 | `packages/services/src/node.ts:2085-2097` `resolveDynamicWorkflowClientConfigWithLocalOverride`：**设置值最高优先**，未设置落既有链（env/远端/缺省）；读取失败不阻断（catch 落既有链） | 唯一折叠出口，两条决策路（工具供给 + 渲染快照）都必须走它（:2082-2084 注释：分叉时设置页单选不跟随，2026-10-11 实机实测） |
| 7 | 会话门 | `packages/services/src/acode-agent/acodeAgentService.ts:3347-3360` `resolveDynamicWorkflowGate()`（memoized，异常按 false）→ :3356-3368（v4 createSession 信封注入 `dynamicWorkflowEnabled: true`）、:3513/:3617（legacy session create/resume 参数构造同样注入） | **缺省 fail-closed：门禁 false 时不写字段** |
| 8 | CLI runtime 门 | `apps/acode-cli/packages/core/src/runtime/types.ts:270`（config 字段）+ `apps/acode-cli/packages/core/src/tool/handlers/index.ts:215-223,297-302`（注册门：**只有显式 false 才下架** `GATED_WORKFLOW_TOOL_NAMES`；缺席 = 调用方不参与灰度，保留全工具面）+ `apps/acode-cli/packages/core/src/runtime/helpers/tool-allowlist.ts:83-88`（两个注册入口同一规则） | 注册面有两个入口（runtime-tools.ts 首次装配、embedded-search-branch.ts 分支刷新），规则必须单点 |
| 9 | reminder 门 | `apps/acode-cli/packages/core/src/runtime/helpers/ultracode-keyword.ts:56-62`（`dynamicWorkflowEnabled === false` → reminder 不注入） | 极性与注册门一致 |
| 10 | bootstrap 解析 | `server-operations.ts:3302-3304`（legacy session/create：参数显式 true **或** `appRuntimePreferences.dynamicWorkflowEnabled === true`）、`acode-protocol-v4/commands/handlers/session-mgmt.ts:54`（v4 createSession payload → runtime config）、`create-app.ts:986,1154`（runtime config 消费）、`v4-bridge.ts:1024,1047` | Host → CLI 的 flag 通路 |
| 11 | 命令面门 | `builtin-prompt-command.ts:85,114`（/workflow 命令在 `dynamicWorkflowEnabled === false` 时不注册）、`acode-protocol/slash-commands.ts:19,40`（同判据） | 命令与工具同结论 |
| 12 | 渲染层快照 | `useDynamicWorkflowAvailability`（Host 判定快照 store）→ `AutomationsSection.tsx:592,600,712,1390`（workflow tab 显隐）、`WorkflowRunSidePane.tsx:231-243`（Resume 门）、`SessionPane.tsx:1536` | UI 只读快照，不自判 |
| 13 | 动态策略更新 | `apps/acode-cli/packages/bootstrap/src/acode-protocol/dynamic-workflow-policy.ts:17`（`updateDynamicWorkflowPolicy` 写 `appRuntimePreferences`，server.ts 分派处） | 会话中途改档的通道（桌面端设置页保存后推给在跑的 Host） |

---

## 3. 产品规则

### 3.1 `scriptWorkflowMode` 三档语义

取值域与词表**逐字对齐** `DYNAMIC_WORKFLOW_MODES`：`disabled | onDemand | alwaysOn`。
新类型定义落 `packages/shared/src/script-workflow-feature.ts`（新文件，与
dynamic-workflow-feature.ts 并列；不放同文件——两套系统的取值域各自独立演进，
共享一个文件会让人误以为词表必须同步变化）。

| 档位 | RunWorkflow 工具 | ultracode keyword reminder | `/ultracode` 命令 | 管理面（本 spec 的列表） | 已在跑的 run |
| --- | --- | --- | --- | --- | --- |
| `disabled` | 不注册 | 不注入 | 不注册 | **照常可用**（只读） | 不受影响，跑完为止 |
| `onDemand`（**缺省**） | 注册 | 注入（现行为） | 注册 | 照常可用 | 不受影响 |
| `alwaysOn` | 注册 | 注入 | 注册 | 照常可用 | 不受影响 |

- **缺省 = `onDemand`**：与今天的可用性逐字一致（RunWorkflow 当前跟随 dwf 灰度门，
  `GATED_WORKFLOW_TOOL_NAMES` 现含 RunWorkflow——`apps/acode-cli/packages/core/src/tool/handlers/workflow-tool-names.ts:11,64`；
  缺省降档会造成行为回归），并且与工具描述的「用户显式选择才可调用」门槛
  （run-workflow.ts:44）天然对齐——onDemand 就是「显式选择才触发」的档位。
- **onDemand 与 alwaysOn 现阶段行为相同**：这不是偷懒，而是与 dwf 同一条既有裁决——
  `dynamic-workflow-feature.ts:47-53` 明文「解析保留服务端契约的三态，消费侧统一转换为
  布尔开关；将来 onDemand 有独立行为时，只需调整消费侧」。`isScriptWorkflowModeEnabled`
  同构（`mode !== "disabled"`）。alwaysOn 的预留语义（会话级常开 reminder）在
  ultracode-keyword.ts 文件末尾的「未做」注释里已登记为需要先定义状态所有者，
  本 spec 不偷偷实现。
- **disabled 时在跑实例的处理（R1）**：设置只影响**新 run 的准入**，不动在跑实例。
  已 backgrounded 的 run 脱离发起工具调用（run-workflow.ts:80-82 注释明文该裁决），
  其生命周期 owner 是 CLI runtime 的 store 行，不由设置档位管。运行中的 run 照常结算，
  孤儿收敛（`reconcileOrphanScriptWorkflowRuns`）照旧。关闭档位不会取消任何 run——
  「关掉开关 = 杀掉在跑的多代理编排」是真实的钱与时间，不能由一个设置项触发。
- **管理面在 disabled 下仍只读可用（R2）**：列表是记录的呈现，不是能力的开关。
  用户关掉工具后仍需要看历史（审计花了多少 token、上次跑到哪）。运行历史行上不提供
  「从此列表重跑」按钮（重跑 = 发起一次新的 RunWorkflow 调用，受当时档位门控）。

### 3.2 与 dwf 灰度门的关系（R3）

`scriptWorkflowMode` 与 `dynamicWorkflowMode` 是**两道独立的门**：

- 现状一个 flag（`dynamicWorkflowEnabled`）同管两套（`GATED_WORKFLOW_TOOL_NAMES`
  「dwf 十一个 + 脚本工作流一个」，workflow-tool-names.ts:64）。本 spec 之后：
  dwf 工具面仍只看 `dynamicWorkflowEnabled`；RunWorkflow 看 `dynamicWorkflowEnabled`
  **与** `scriptWorkflowEnabled` 的合取（任一 false 即不注册）。保留合取是因为：
  用户在 dwf 总闸上关掉「动态工作流」时，对「脚本工作流也没了」的预期是成立的
  （今天就是这个行为），scriptWorkflowMode 单独开着不该把它救回来；反之
  scriptWorkflowMode 单独关掉也不影响 dwf。
- 语义分工：`dynamicWorkflowMode` 是**发布灰度**（远端可回收，env 覆盖三段折叠）；
  `scriptWorkflowMode` 是**本机产品开关**（无远端、无 env，只读 AppSettings）。
  不给 scriptWorkflowMode 配远端下发与环境变量：RunWorkflow 全部在本机执行，
  不存在「服务端回收发布节奏」的需求（对照 dynamic-workflow-feature.ts:26-30 的裁决——
  那条裁决说的是 dwf 十工具灰度是发布节奏控制；脚本工作流同理不需要 fail-open 三段折叠，
  只需要缺省档）。
- **dwf 总闸关闭 × scriptWorkflowMode=onDemand 的组合（UI 条文，评审必改项 3）**：
  dwf 总闸关时「工作流」tab 整体不挂载（`AutomationsSection.tsx:600` 现行为：
  `pageTab = dynamicWorkflowEnabled ? storedPageTab : "automation"`），本 spec 落在该 tab
  内的脚本工作流分组随之不可见；此时 RunWorkflow 工具同样未注册（合取语义）——
  两侧皆无，属**一致 fail-closed**，不是「界面有入口/模型没工具」裂口。
  **R2「停用后历史仍可查看」限定适用于 scriptWorkflowMode 这道门，不适用于 dwf 总闸**：
  dwf 总闸关掉的是整个工作流中枢页，历史入口随 tab 一起消失，dwf 总闸恢复后历史重现
  （数据一直在库里，不丢）。

### 3.3 状态唯一所有者

| 状态 | 唯一所有者 | 其他方 |
| --- | --- | --- |
| `workflow_run` / `workflow_definition` / `workflow_event` / `workflow_activity` 行 | CLI runtime 的 SQLite store（经 `ScriptWorkflowStorePort`） | UI 只读（经本 spec 的 v4 查询命令）；UI 不写任何一行 |
| 档位 `scriptWorkflowMode` | AppSettings（settings.json，`settingService` 域） | 设置 UI 发起写；Host 折叠读；CLI 经会话创建 flag 消费。UI 选中态唯一来源是落盘值回读 |
| UI 列表缓存 | 每次挂载/刷新现查（与 saved-workflows 中枢同一条先例：`saved-workflows.ts:1-7` 注释「不带 sessionId，每次调用现扫——挂载时快照会漏掉用户手改 / 模型刚落盘的文件」） | store 只做同页重渲染缓存，变更后 `bypassCache` 刷新 |

---

## 4. 协议设计（全部进 acode-protocol-v4，legacy 零新增）

### 4.1 新命令一：`listScriptWorkflowRuns`（运行历史）

新文件 `packages/shared/src/acode-protocol-v4/script-workflow-management.ts`（schema 唯一来源），
在 `command.ts` 的 `commandPayloadSchemas` 登记（自动进 `CommandType`/`CommandPayloadMap`）。

```
payload:
  workspace: ACodeWorkspaceRef        // 与 legacy workflows/list 的 params.workspace 同形同源
  limit?: number                      // 缺省 50，上限 200（zod .int().min(1).max(200)）
  statuses?: ScriptWorkflowLogicalStatus[]  // 缺省不过滤；过滤**下推到 store 读面**（见下）
result:
  runs: Array<{
    runId: string
    name: string
    logicalStatus: "pending"|"running"|"paused"|"completed"|"failed"|"cancelled"|"interrupted"
    stopReason?: "user"|"processExited"      // 仅 cancelled/interrupted 行携带（见下）
    scriptPath?: string
    cwd: string
    workspaceIdentity?: string
    parentSessionId?: string
    toolCallId?: string                       // 「查看发起会话」深链的联接键
    budgetSpent: number
    budgetTotal?: number
    stats: { agentCalls; cachedAgentCalls; failedAgentCalls; toolCalls; tokensTotal; usageIncomplete }
    createdAt: number; startedAt?: number; completedAt?: number; updatedAt: number
  }>
  truncated: boolean                   // 「还有更多**匹配**」：过滤后匹配行数超过 limit 时 true，
                                       // UI 显示「仅显示最近 N 条」（语义见下方第二条 bullet）
```

- **statuses 过滤下推（2026-10-18 P2 修复）**：过滤发生在**取数层**——facade 把逻辑态闭集
  原样传给 store 读面（`ScriptWorkflowStorePort.listScriptWorkflowRuns` 的 `logicalStatuses`
  参数），SQL 展开：物理词直接进 `status in (...)`；`interrupted` 没有物理词（CHECK 约束），
  展开 = `cancelled` 且 `json_extract(failure_json,'$.code')` 命中 `ScriptWorkflowInterrupted`；
  `cancelled` = 其余 cancelled 行（无 code 或他码）；两词同时请求不分流。SQL 展开与唯一映射
  （`logicalScriptWorkflowStatus`）的一致性由对真实 SQLite 的 store 测试逐行互钉
  （script-workflow-management-store.test.mjs）。「多取一行探截断」探到的因此是第 limit+1 个
  **匹配行**——修复前先取 limit+1 物理行、投影后才过滤，带 statuses 时页外匹配行被静默隐藏、
  truncated 系统性 false。
- **truncated 语义 = 「还有更多匹配」**：`truncated: true` 当且仅当按当前过滤条件（含
  statuses）排序后存在第 limit+1 个匹配行；与 statuses 组合时说的是**匹配行**的余量，
  不是物理行的余量。`runs` 恒为匹配前缀的前 limit 条（`time_updated desc, id desc`）。
- **stop_reason 语义（唯一映射）**：CLI 侧用 `logicalScriptWorkflowStatus`
  （script-workflow-run-status.ts:49-57）投影出 `logicalStatus`；`stopReason` 派生规则：
  `cancelled` 且无 interrupted code → `"user"`；`interrupted`（= cancelled + code）→
  `"processExited"`；其余终态不携带。协议 schema 收 `stopReason` 枚举而不收 failure JSON——
  failure 原文可能含任意错误对象，不进管理面列表（详情属于未来会话详情页，不在本 spec）。
- **tokens 口径**：`stats` 即 `ScriptWorkflowRunStats`（contracts/src/workflow/script-usage.ts，
  经 run 行 `stats_json`），`usageIncomplete` 对应用量账本不完整标记
  （script-workflow-runtime.ts:698-714 写入的可见降级）——UI 显示「unknown (known subtotal)」
  而不是把不完整账本伪装成零。字段名在协议层展平为显式键（不透传 JSON blob），
  保证 schema 可校验。**读面（2026-10-18 P2 修复）**：usageIncomplete 经 store 的
  `hasScriptWorkflowUsageIncomplete` 存在性读面取数（`select exists(... json_extract(
  result_json,'$.usageAccounting.status')='incomplete')` 索引探测，判据唯一所有者
  script-workflow-format.ts 的 `scriptWorkflowActivityUsageIncomplete`，store 测试互钉）——
  修复前逐 run 全行拉取 activity（payload/result 大字段），默认 51、最大 201 次，只为算一个布尔。
- 排序：`time_updated desc`（命中现成索引 `workflow_run_cwd_status_idx`）。
- **workspaceIdentity 过滤语义**：`workflow_run` 无 workspace_identity 索引，且历史行可能缺席
  该列（legacy 行）。管理面按 **cwd 精确匹配**过滤（与 `ScriptWorkflowRuntime.list` 同一口径），
  不按 identity 过滤——同一项目目录的 runs 就是同一项目的 runs；identity 是身份隔离键
  （AGENTS.md Workspace Identity 节），不承担「按项目枚举」的职责。workspace ref 里的
  `workspacePath` 是过滤源。

### 4.2 新命令二：`listScriptWorkflowDefinitions`（已持久化脚本清单）

```
payload:
  workspace: ACodeWorkspaceRef
result:
  definitions: Array<{
    id: string
    name: string
    description: string                 // meta.description
    phaseTitles: string[]               // meta.phases[].title（顺序即脚本声明顺序）
    scope: "builtin"|"explicit"|"project"|"user"
    scriptPath?: string
    scriptHash: string
    enabled: boolean
    trusted: boolean
    timeCreated: number; timeUpdated: number
    lastRunAt?: number                  // 该 definition 最近一次 run 的 time_updated（联查，可选优化，首版可缺省不回）
  }>
```

- 过滤口径：`scope ∈ {project, user, explicit}` 且 `script_path` 非空（有实体文件可看）。
  `source = 'builtin'` 的预定义工作流（`SCRIPT_WORKFLOW_DEFINITION_SCOPES` 的 builtin 档）
  也在清单内但标注 scope，UI 分「预定义」小节（它们没有用户可见的脚本文件路径时行内
  只读 meta）。首版**不过滤 enabled**：清单是事实清单，`enabled` 是一列事实，不是过滤器
  （列上目前没有任何写路径改它——store port 没有 setDefinitionEnabled，诚实呈现即可）。
- 存储新增（唯一一处存储改动）：`ScriptWorkflowStorePort` 加
  `listScriptWorkflowDefinitions(input?: { limit?: number }): Promise<ScriptWorkflowDefinitionRecord[]>`，
  SQLite 实现 `select * from workflow_definition order by time_updated desc limit ?`
  （`apps/acode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-runs.ts`
  同文件追加；表已有 `workflow_definition_source_idx`，行数量级 = 用户迭代过的脚本数，全量回可行）。

### 4.3 门控 flag：`scriptWorkflowEnabled`（createSession payload）

- v4 `createSession` payload 加 `scriptWorkflowEnabled: z.boolean().optional()`
  （command.ts:63 `dynamicWorkflowEnabled` 旁，同一模式：**门禁 false 时不写字段**，
  缺席即 fail-open 到「本机缺省档」——见 4.4 的极性裁决）。
- legacy `session/create` / `session/resume` params **不加**（只删不增纪律）。影响面与理由：
  legacy 路径的会话收不到 flag → CLI 侧缺席 = 按本机缺省档（onDemand）= 可用，与今天的
  行为逐字一致，无回归；桌面主路径是 v4 createSession（`acodeAgentService.ts:3356-3368`
  的信封注入注释明文「V4 createSession 是桌面新会话的实际创建路径」），受控。legacy 面
  整体退役中（AGENTS.md 协议节），不为其扩字段。

### 4.4 CLI 侧极性裁决（与 dwf 门同构）

`AgentRuntimeConfig` 加 `scriptWorkflowEnabled?: boolean`（runtime/types.ts:270 旁）。
判据函数单点放在 tool-allowlist.ts（同文件，两个注册入口共用）：

```
resolveRuntimeScriptWorkflowToolsIncluded(config) = config.scriptWorkflowEnabled !== false
```

- **缺席即开启**（与 `resolveRuntimeDynamicWorkflowToolsIncluded` 的
  「缺席代表调用方不参与灰度，必须保留全部工具面」逐字同构，tool-allowlist.ts:76-82 注释）。
  显式 `false` 才下架。fail-closed 的缺省值不在这一层——Host 侧 services 折叠出口负责把
  「disabled 档」翻译成显式 false，CLI 不猜。
- Host 注入链（v4）：`services/acodeAgentService.ts` 的 `resolveDynamicWorkflowGate` 旁加
  `resolveScriptWorkflowGate`：读 `resolveScriptWorkflowModeWithLocalOverride()`
  （node.ts 折叠出口，见 §5.3）→ `enabled = mode !== "disabled"` → v4 createSession 信封注入
  `scriptWorkflowEnabled: enabled`（**true/false 都写**：缺席=开启的 CLI 极性意味着
  Host 必须**显式写 false** 才能关掉它；与 dynamicWorkflowEnabled 的「false 不写」不同，
  原因正是两边的缺席语义不同——dwf flag 缺席=fail-closed 关，本 flag 缺席=fail-open 开）。

### 4.5 CLI 侧各门落点（实现清单）

| 门 | 落点 | 改法 |
| --- | --- | --- |
| 工具注册 | `core/src/tool/handlers/index.ts:297-302` 注册门旁 | 新增独立支：`options.includeScriptWorkflow === false && entry.metadata.name === RUN_WORKFLOW_TOOL_NAME → continue`。**不动 `GATED_WORKFLOW_TOOL_NAMES`**（它继续由 dwf 总闸管，保持合取语义见 R3——includeDynamicWorkflow === false 已覆盖 RunWorkflow，scriptWorkflow 门只补「dwf 开、script 关」的另一半）。options 加 `includeScriptWorkflow?: boolean`（index.ts:215 旁，注释同款「只有显式 false 才下架」）。**同步注释（评审必改项 2）**：更新 `workflow-tool-names.ts:51-63` 设计注释——「共用一道开关」的论证改为「dwf 工具面仍由 includeDynamicWorkflow 单门管；RunWorkflow 额外与 scriptWorkflowEnabled 合取」；并同步 `builtin-prompt-command.ts:104-108` 与 `acode-protocol/slash-commands.ts:26-29` 两处「同一道开关」的引用表述（不改则注释说谎，违反仓库注释纪律） |
| keyword reminder | `core/src/runtime/helpers/ultracode-keyword.ts:56-62` | `shouldEmitUltracodeKeywordReminder` 入参加 `scriptWorkflowEnabled?: boolean`，`=== false` 时返回 false（现 `dynamicWorkflowEnabled === false` 判据保留——合取）。函数注释同步：两道门任一关着，把模型指向一个不存在的工具都是说谎 |
| `/ultracode` 命令 | `bootstrap/src/acode-protocol/slash-commands.ts:19,40`（/workflow 同判据处）与 `builtin-prompt-command.ts:85,114` | 与 /workflow 同款：`scriptWorkflowEnabled === false` 时命令不注册。**两道门任一 false 都下架 /ultracode**（工具不注册时命令还把模型引向 RunWorkflow 是同款说谎） |
| 技能面（bundled skills，2026-10-18 P2 修复） | `cli-workflow/src/dynamic-workflow-gate.ts`（判定矩阵 `collectWorkflowDisabledSkillPaths` 与门推导同址）+ `bootstrap/src/app/create-app.ts` skillPort 的 `disabledPaths` 接线 | dwf 总闸（`dynamicWorkflowEnabled === false`）剔 `dynamic-workflows` 与 `script-workflows` 两份（现状语义）；`scriptWorkflowEnabled === false`（dwf 总闸开着）**单独再剔 `script-workflows` 一份**——工具/命令/reminder 三面此时都已下架，技能面若还能加载就是教模型对着不存在的 RunWorkflow 反复重试（ultracode-keyword.ts「技能面……必须同结论」）。两门都关并集去重；极性与注册门一致：只有显式 false 才剔。修复前只在 `dynamicWorkflowEnabled === false` 时剔两份，「dwf 开 × script 关」时 script-workflows SKILL.md 仍可加载 |
| runtime config 装配 | `bootstrap/src/acode-protocol-v4/commands/handlers/session-mgmt.ts:54`（v4 createSession）、`bootstrap/src/acode-protocol/server-operations.ts:3302`（legacy：**不加字段**，恒缺省）、`create-app.ts:986,1154`、`v4-bridge.ts:1024,1047` | 透传 `scriptWorkflowEnabled`（v4 路径）；legacy 路径不写（缺席=开启） |
| 管理面读数 | `bootstrap/src/acode-protocol-v4/commands/handlers/`（新组文件 `script-workflow-management.ts`） | 两个 handler：`requireRecord(host, envelope.sessionId)` → `record.app.listScriptWorkflowRuns/ListDefinitions`；能力缺席（store 无 port / stub 宿主）抛 `V4CapabilityUnsupportedError`。facade 方法落 `workflow-app-facade.ts`（现有 dwf facade 旁），内部经 `isScriptWorkflowStore(sessionStore)` 能力探测取数——store 缺席即**可见降级**（错误上行），绝不静默回空（与 workflow-run-read/src/app/journal.ts:8-9 的纪律同一条） |
| 动态改档 | 不做 | `updateDynamicWorkflowPolicy`（dynamic-workflow-policy.ts）是 dwf 的会话中途改档通道。scriptWorkflowMode 首版**不提供会话中途改档**：档位在**下一次会话创建**时生效（见 §8 事件顺序），正在跑的会话不受设置变更影响。理由：RunWorkflow 工具面在会话中途刷新没有现成通路（dwf 的 embedded-search-branch 刷新机制不覆盖 workflow 门），为 parity 补一条中途刷新通路要动两个注册入口的刷新语义，收益是「设置后当前会话立即生效」——一个设置页交互细节不值得引入这条风险。spec 如实登记为未做。 |

### 4.6 错误与幂等

- 两个查询命令是**纯读**：不写任何行、不触发孤儿收敛、不碰 owner lease。幂等性由存储层
  天然保证（同一时刻重复查询同一快照）；不引入缓存、不引入「列表版本号」——UI 的刷新
  语义是显式重查（用户点刷新 / 重新挂载），不是订阅（§8）。
- 错误面：能力缺席 → `V4CapabilityUnsupportedError`（UI 显示「当前 agent 不支持」）；
  store 读失败 → error 上行进 ack.message（查询失败不伪造空列表——空列表和「读不到」
  是两个事实，UI 文案要能区分：空态引导创作，错误态引导重试）。

---

## 5. `scriptWorkflowMode` 字段链落点清单（对齐 §2.4 的每一行）

| # | 落点 | 对应 dwf 落点 | 本 spec 改动 |
| --- | --- | --- | --- |
| 1 | `packages/shared/src/script-workflow-feature.ts`（新文件） | dynamic-workflow-feature.ts:9-10 | `SCRIPT_WORKFLOW_MODES`、`ScriptWorkflowMode`、`DEFAULT_SCRIPT_WORKFLOW_MODE = "onDemand"`、`normalizeScriptWorkflowMode`、`isScriptWorkflowModeEnabled`。**无** env 常量、**无** client config 折叠（§3.2：本机产品开关） |
| 2 | `packages/shared/src/protocol.ts`（AppSettings，:309 旁） | :309 | `scriptWorkflowMode?: ScriptWorkflowMode` |
| 3 | `packages/shared/src/validationAppSettings.ts` | :41 + :505 + :554 | enum schema + `appSettingsObjectSchema` + `appSettingsPatchSchema` 三处登记（漏 505 = 写盘 strip，漏 554 = patch 拒写；两处注释里的实机教训原文适用） |
| 4 | `packages/ui/src/settings/ScriptWorkflowSection.tsx`（新组件） | DynamicWorkflowSection.tsx | 三档 radiogroup，复用 `SettingsGroupCard` + `data-testid="settings-script-workflow-option"` 模式；选中态唯一来源 = props 传入的落盘值（**比 dwf 简单**：无 Host 快照，本机设置即真相） |
| 5 | `packages/ui/src/SettingsPage.tsx` | :822 + :1583-1588 | `handleScriptWorkflowModeSelect`（经 `useSettings().update`——即 `updateSharedSettings`，`settingService.update` + 同步 + 刷新快照三合一路径——落盘 `{ scriptWorkflowMode }`；2026-10-18 订正：此前误写为直接调 `settingService.update`，UI 域不走它）+ 在 `dynamicWorkflow` 分区页挂载新卡片（挂载点见 §7.3） |
| 6 | i18n | zh-CN.ts / en-US.ts（`settings.dynamicWorkflow.*` 文案组旁） | `settings.scriptWorkflow.*` 全组双语（§7.5 文案表） |
| 7 | services 折叠出口 | node.ts:2085-2097 | `resolveScriptWorkflowModeWithLocalOverride()`：读 `(await settingService.get()).scriptWorkflowMode`，缺省/非法落 `DEFAULT_SCRIPT_WORKFLOW_MODE`，读取失败 catch 落缺省（不阻断装配）。**单一折叠出口**——门控注入（acodeAgentService）与未来任何消费方都必须走它，防两条决策路分叉（node.ts:2082-2084 的实机教训原文适用） |
| 8 | 会话门 | acodeAgentService.ts:3347-3368 | `resolveScriptWorkflowGate()`（**每次 v4 createSession 现读** `resolveScriptWorkflowModeWithLocalOverride()`，**无跨会话缓存**；异常按 **enabled=true** 处理——读取异常时保住今天的行为，与 dwf 的「异常按 false」方向相反，因为缺省档是开：fail 到缺省档而不是 fail 到关）+ v4 createSession 信封注入（§4.4：true/false 都写）。**与 dwf 刻意差异：不 memoize**——dwf 可 memoize 是因为有 `workspace/updateDynamicWorkflowPolicy` 推送通道兜底（缓存失效有中途改档补偿）；script 无中途改档通道，进程内缓存会使「下次会话生效」承诺失效（§8.1 时序不变式：每次判定现读，无缓存） |
| 9 | CLI runtime 门 | runtime/types.ts:270、handlers/index.ts:215-223,297-302、tool-allowlist.ts | §4.5 前两行 |
| 10 | reminder / 命令门 | ultracode-keyword.ts、slash-commands.ts、builtin-prompt-command.ts | §4.5 中两行 |
| 11 | bootstrap 装配 | session-mgmt.ts:54、create-app.ts、v4-bridge.ts | §4.5 末行 |
| 12 | 渲染层快照 | useDynamicWorkflowAvailability | **不需要**新快照 store：管理面分组与设置卡片的可用性直接读落盘设置（settingService 已在 UI 域）。automations 页的脚本工作流分组在 disabled 档**仍渲染**（§3.1 R2） |

与 dwf 链的刻意差异（汇总，评审重点看这里）：

1. 无远端 key、无 env 覆盖、无三段折叠（产品开关 vs 发布灰度，§3.2）。
2. 信封注入极性相反（true/false 都写 vs false 不写；缺席语义相反所致，§4.4）。
3. 无 Host 快照 store、无会话中途改档（§4.5 末行）。

---

## 6. 运行历史与脚本清单的 UI 数据流

```
[设置侧栏 dynamicWorkflow 分区]            [workspace 主视图 自动化 → 工作流中枢]
  ScriptWorkflowSection（三档）               AutomationsSection workflow tab
      │ useSettings().update                        │
      │ （updateSharedSettings：落盘+同步+刷新快照）    │
      ▼                                              ▼
  AppSettings.scriptWorkflowMode          ScriptWorkflowsGroup（新组件）
      │ （下次会话创建时生效）                    │ 挂载/刷新 → agentService.*
      ▼                                          ▼
  services 折叠出口 → resolveScriptWorkflowGate    v4 命令（经锚会话 sendCommand）
      │                                          ▼
      ▼                                  CLI handlers → app facade
  v4 createSession 信封                            ▼
      │ scriptWorkflowEnabled               ScriptWorkflowStorePort（SQLite，唯一所有者）
      ▼                                          ▼
  CLI runtime（注册门 + reminder 门 + /ultracode 门）  workflow_run / workflow_definition
```

- services 接口：`IACodeAgentService` 加 `listScriptWorkflowRuns` /
  `listScriptWorkflowDefinitions`。发送通路与 saved-workflows 系列不同——那六个走 legacy
  `client.request(method, params, resultSchema)`；本 spec 两个走 **v4 sendCommand**
  （UI 侧经 `useV4Conversation` 的 sendCommand + `createCommandEnvelope`，锚当前 workspace
  的活动会话；无活动会话时给出「打开一个会话后查看」的空态引导——与 startSavedWorkflow
  的锚会话先例一致）。result 校验用 v4 result schema（严格 zod，运行时校验）。
  **锚会话不在运行时（ACK reasonCode=`proto.sessionNotFound`，按结构化 reasonCode 精确匹配、
  不看 message 文本）视同无活动会话**：锚候选（最近主会话至多 5 个）逐个回退发查询，
  候选耗尽仍全是 sessionNotFound → 落 noSession 引导而非 error 态；其他失败原因
  （能力缺席、zod 校验失败等）不回退，照旧上行 error（2026-10-18 实机：持久化会话
  存在但未在运行时活跃——窗口刚开、只有 draft 预热——单锚直接落「加载失败」的错归类）。
- UI store：新 `packages/ui/src/store/scriptWorkflowStore.ts`，形状对齐
  savedWorkflowStore（按 workspaceKey 分片、`bypassCache` 刷新、in-flight 去重），
  但**无 errorCode 专列**（v4 错误走 reasonCode/ack.message，异常即 error 态）。

---

## 7. UI 落点设计

### 7.1 运行历史 + 脚本清单：工作流中枢内新分组

落点：`AutomationsSection.tsx:1407-1420` 的 `pageTab === "workflow"` 分支，现渲染
`SavedWorkflowsSection`。改法：该分支改为渲染新的轻容器 `WorkflowHubPage`（或直接在
分支内纵向堆叠两块）：

1. 顶部：现 `SavedWorkflowsSection`（dwf 中枢）——**原样保留**，页头 `header` prop 继续传给它；
2. 其下：新 `ScriptWorkflowsGroup`（「脚本工作流」分组卡），含：
   - 分组标题 + 副标题（讲清两套系统不可互换，§7.5）；
   - 「脚本」小节：definition 行卡（name / description / phaseTitles / scope 徽标 /
     scriptPath 路径展示 / 最近更新时间）；行点击 → 详情展开（正文只读展示 scriptPath
     指向的文件内容——经现有只读文件读通路或仅展示路径 + meta，首版**只展示 meta 与路径**，
     正文预览登记为后续增强，避免引入新的文件读协议）；
   - 「运行历史」小节：run 行卡（logicalStatus 徽标 / name / token 概要 / 时间 /
     stopReason 说明文案）；行操作「查看发起会话」（`toolCallId` + `parentSessionId`
     深链，复用 `onOpenWorkflowRun` 同类回调语义——脚本工作流 run 的侧栏实例视图已存在，
     `workflowRunPanel.ts`）；
   - `truncated` 时显示「仅显示最近 N 条」；错误态显示重试按钮（不伪造空态）。

**否决「第三页级 tab」方案**：页面标题 tab（`AutomationsPageTitle`）现在是
「自动化 / 工作流」两个标题词的顶级切换，语义是「自动化页的两页」；脚本工作流在产品语义上
属于「工作流」这一页的**第二族内容**，不是第三页。加第三标题词还要动
`automationsPageTabMemory`（持久化的 tab 记忆）与深链解析，收益不抵迁移成本。
分组内两小节（脚本 / 运行历史）在移动 Web 宽度下纵向堆叠（DESIGN.md 未见分组 tab 约束，
小节标题用 `text-ui-base font-medium` 层级，与 dwf 中枢 `workflows.hub.sectionTitle` 同款）。

### 7.2 运行历史列（字段 → UI 映射）

| 字段 | 呈现 |
| --- | --- |
| logicalStatus | 徽标：running（进行中，accent）/ completed / failed / cancelled（已取消）/ interrupted（已中断，含「宿主进程退出」说明）/ pending / paused |
| stopReason | cancelled 行副文案：user → 「已手动停止」；processExited → 「进程退出前未结算」 |
| stats | 「N agents · M tools · K tokens」；usageIncomplete → 「tokens: ≥K（账本不完整）」 |
| budgetSpent/Total | 有 budgetTotal 时「spent / total」 |
| 时间 | createdAt 起、completedAt 止；running 行显示 startedAt |
| cwd/workspaceIdentity | 行内不显示（列表已按 workspace 过滤），详情展开时显示 |
| toolCallId | 「查看发起会话」操作 |

### 7.3 设置侧栏论证：**不新增分区，卡片挂进既有 `dynamicWorkflow` 分区页**

- 反方案 A（新增 `scriptWorkflow` 设置分区）：设置侧栏已有 18+ 个 id
  （settingsNavigation.ts:4-24），其中 automations/plugins 等已被产品裁决隐藏
  （:38-48，注释「定时任务是 workspace 主视图，不能再作为设置页分区出现」）。
  脚本工作流的**列表主体**在 workspace 中枢页（同理不该出现在设置侧栏）；
  若只为三档开关单开侧栏分区，会出现「一个分区只有一个开关」的空洞分区，
  与 dwf 的 `dynamicWorkflow` 分区（同样只承载三档）形成两个并列的开关分区，
  用户要在两处找「工作流开关」。
- 反方案 B（开关放工作流中枢页顶）：中枢页是 workspace 主视图，跨项目可用；
  档位是全局设置，出现在项目上下文页里会让人以为档位按项目生效。且中枢页在
  disabled 档仍要渲染（R2），开关内嵌其中会出现「关掉开关的入口随开关消失」的自引用。
- **选定方案 C**：`dynamicWorkflow` 分区页内、`DynamicWorkflowSection` 之下挂
  `ScriptWorkflowSection`。同页两卡，检索路径唯一；分区 id 不变（无导航/深链迁移）；
  分区页顶部描述文案补一句覆盖两卡（见 §7.5 的 `settings.dynamicWorkflow.description`
  增补）。分区标题保持「动态工作流」不动（改名「工作流」会误伤 dwf 语义），
  脚本工作流卡片自带标题与一句分工说明。

### 7.4 disabled 档的 UI 状态

- 设置卡片：三档照常可点（就是它们在改档），当前档回显落盘值。
- 中枢页脚本工作流分组：照常渲染数据（R2）；分组标题旁加一枚「工具已停用」中性徽标 +
  指向设置的说明行（「RunWorkflow 工具当前已停用——历史记录仍可查看；到设置中重新开启」）。
  不弹窗、不阻断查看。
- `/ultracode` 在 disabled 档不注册：命令面板自然不再出现该条目（现有机制，无需新 UI）。

### 7.5 文案（en-US / zh-CN 双语，i18n 键组 `settings.scriptWorkflow.*` 与 `workflows.scriptHub.*`）

| 键 | en-US | zh-CN |
| --- | --- | --- |
| settings.scriptWorkflow.title | Script workflows | 脚本工作流 |
| settings.scriptWorkflow.description | Runs the RunWorkflow tool (the /ultracode orchestration system). Runs are recorded per project; records stay viewable while disabled. | 控制 RunWorkflow 工具（/ultracode 编排系统）的可用性。运行记录按项目留存，停用后仍可查看。 |
| settings.scriptWorkflow.option.disabled | Disabled | 停用 |
| settings.scriptWorkflow.option.disabled.description | The RunWorkflow tool is not registered; /ultracode is unavailable. Existing runs finish on their own. | 不注册 RunWorkflow 工具，/ultracode 不可用；进行中的运行会自行跑完。 |
| settings.scriptWorkflow.option.onDemand | On explicit request | 按需触发 |
| settings.scriptWorkflow.option.onDemand.description | Default. The tool is available when the request explicitly calls for it (saying "ultracode", or /ultracode). | 默认档。用户显式要求（说出 ultracode 或使用 /ultracode）时工具可用。 |
| settings.scriptWorkflow.option.alwaysOn | Always available | 始终可用 |
| settings.scriptWorkflow.option.alwaysOn.description | Same tool surface as on-demand; reserved for a future always-on reminder. | 与按需档工具面相同；为后续常驻提示预留。 |
| settings.scriptWorkflow.saveError | Couldn't save the setting. Please try again. | 设置保存失败，请重试。 |
| workflows.scriptHub.title | Script workflows | 脚本工作流 |
| workflows.scriptHub.description | The other workflow system: plain JavaScript scripts run by the RunWorkflow tool (/ultracode). These are NOT interchangeable with the dynamic workflows above — a script for one system will not run in the other. | 另一套工作流系统：由 RunWorkflow 工具运行的纯 JavaScript 脚本（/ultracode）。与上方动态工作流不可互换——一方的脚本无法在另一方运行。 |
| workflows.scriptHub.scripts | Persisted scripts | 已持久化脚本 |
| workflows.scriptHub.runs | Run history | 运行历史 |
| workflows.scriptHub.empty | No script workflow runs in this project yet. Ask for "ultracode" in a chat to launch one. | 本项目还没有脚本工作流运行记录。在对话中提及 ultracode 即可发起。 |
| workflows.scriptHub.truncated | Showing the most recent {limit} entries. | 仅显示最近 {limit} 条。 |
| workflows.scriptHub.loadError | Couldn't load script workflow data. | 脚本工作流数据加载失败。 |
| workflows.scriptHub.gated | RunWorkflow is currently disabled in settings — history stays viewable. | RunWorkflow 已在设置中停用——历史记录仍可查看。 |
| workflows.scriptHub.stopReason.user | Stopped manually | 已手动停止 |
| workflows.scriptHub.stopReason.processExited | Interrupted: the owning process exited before the run settled | 已中断：所属进程在结算前退出 |
| workflows.scriptHub.usageIncomplete | tokens: ≥{known} (ledger incomplete) | tokens：≥{known}（账本不完整） |
| workflows.scriptHub.openOriginSession | View originating session | 查看发起会话 |
| workflows.scriptHub.status.pending | Pending | 等待开始 |
| workflows.scriptHub.status.running | Running | 进行中 |
| workflows.scriptHub.status.paused | Paused | 已暂停 |
| workflows.scriptHub.status.cancelled | Cancelled | 已取消 |
| workflows.scriptHub.status.interrupted | Interrupted | 已中断 |
| settings.dynamicWorkflow.description（增补后全文，评审必改项 7） | When the dynamic workflow authoring tools (CreateWorkflow and friends) are offered to the agent. The separate card below controls the other system: script workflows (RunWorkflow, the /ultracode orchestration system). | 何时向 agent 提供动态工作流创作工具（CreateWorkflow 一族）。下方独立卡片控制另一套系统：脚本工作流（RunWorkflow，/ultracode 编排）。 |

（状态徽标键位实测（评审必改项 6）：`completed`/`failed` 复用现有键
`chat.toolCall.scriptWorkflow.status.completed` / `chat.toolCall.scriptWorkflow.status.failed`；
现有 `chat.toolCall.scriptWorkflow.*` 键组只有 label/launching/backgrounded/completed/failed/
source.*，**不含** pending/running/paused/cancelled/interrupted——必须用上表新增的
`workflows.scriptHub.status.*` 五键，否则 E1（无裸键名）在运行时必然失败。）

---

## 8. 事件顺序与幂等边界

### 8.1 改档生效顺序（唯一写者 settingService 域；无会话中途刷新，§4.5）

```
用户点三档 → useSettings().update（updateSharedSettings：settingService.update + 同步 + 刷新快照）
   → settings.json 落盘
   → （无推送、无广播——本 spec 不做会话中途改档）
   → 下一次会话创建：services 折叠出口读取 → v4 createSession 信封注入
      scriptWorkflowEnabled → CLI runtime 注册门/reminder 门/命令门/技能面门生效
```

- 时序不变式：**设置落盘先于任何门判定**（每次判定现读，无缓存）→ 不存在「改档后
  新会话仍带旧档」的窗口；也不存在反向窗口（改档不会影响已创建会话——缺席中途刷新）。
- 在跑 run 与新档解耦（R1）：改档不写 `workflow_run` 任何行。

### 8.2 管理面查询顺序

```
UI 挂载/点刷新 → sendCommand(listScriptWorkflowRuns/ListDefinitions)
   → CLI handler → app facade → sessionStore.listScriptWorkflowRuns/ListDefinitions（SQLite 现查）
   → 投影（logicalScriptWorkflowStatus + stopReason + stats 展平）→ ACK.result → UI 渲染
```

- **不用超时掩盖同步**：UI 等待 ACK（in-flight 去重防抖），无轮询、无定时器。
  「run 刚结束但列表没它」由用户显式刷新解决（中枢页对 dwf 列表就是同一条交互：
  手动刷新按钮 + 重新挂载重查）——不做文件监听也不做事件推送，运行实例的实时面
  已由侧栏实例视图（进度投影）承担，列表页只要快照正确。
- 幂等：查询只读；重复查询无副作用；`limit` 截断确定性（同一排序键 + 同一 limit →
  同一前缀，`time_updated` 并列时由 SQLite 稳定顺序保证——若实测发现并列翻转，
  排序补主键 tiebreaker，实现期以真实库验证）。

---

## 9. 验收场景

### A. 运行历史（v4 命令）

- **A1** 项目内发起一次含 2 个 agent 的脚本工作流 run，跑完；打开「自动化 → 工作流」中枢
  页 → 脚本工作流分组 → 运行历史 ≥1 行，状态徽标 completed，token 概要与 run 行
  `stats_json` 一致，时间与 `time_created/time_completed` 一致。
- **A2** 同一脚本在另一项目目录发起 run → 原项目列表**不**出现它（cwd 过滤）。
- **A3** 发起后立即 TaskStop → 列表行显示 cancelled + 「已手动停止」。
- **A4** 模拟宿主进程退出（起 run 后杀进程，重启后触发孤儿收敛）→ 列表行显示
  interrupted + 「进程退出前未结算」（store 行为已有测试语义，这里验投影与文案）。
- **A5** `limit=50`，造 60 条（或以测试桩注入）→ `truncated: true` 且返回 50 条
  （按 `time_updated desc`）。
- **A6** stub 宿主（store 无 port）→ ACK 携带能力不支持错误，UI 显示加载失败而非空态。
- **A7**（statuses × limit × truncated，2026-10-18 P2 修复的验收）
  - **A7a** 造 5 条 completed + 1 条用户取消 + 1 条 interrupted；
    `statuses=["completed"], limit=4` → 恰 4 条 completed（按 `time_updated desc`，
    非匹配行不占页）且 `truncated: true`（第 5 个**匹配行**存在——修复前页外匹配行被
    静默隐藏、truncated 系统性 false）；`limit=5` → 5 条且 `truncated: false`。
  - **A7b** `statuses=["cancelled"]` 只回用户取消行（无 failure 或他码）；
    `statuses=["interrupted"]` 只回 `failure_json.code` 命中 `ScriptWorkflowInterrupted`
    的行；两词不同流通——SQL 展开与唯一映射逐行一致（store 测试互钉）。
  - **A7c** `statuses=["completed","cancelled"], limit=2` → 回组合匹配前 2 条且
    `truncated: true`（组合匹配 6 条 > 2）。
  - **A7d** 仅实现旧写子集的 store（缺 list 读面）→ 管理能力整体缺席，
    ACK 携带能力不支持错误（`V4CapabilityUnsupportedError`），不是 TypeError。
- **A8** usageIncomplete 读数来自 store 的存在性读面：命中标记的 run → 行内
  `stats.usageIncomplete: true`；无 activity 的 run → `false`（SQL exists 与判据
  对同一批 activity 同判，store 测试互钉）。

### B. 已持久化脚本清单

- **B1** 同一脚本文件迭代两次（meta.name 变化）→ 清单出现两行（哈希不同 → definition id 不同，
  这是 upsert 铸造规则的既有事实），各自 scriptPath/scriptHash 正确。
- **B2** 清单行展示 meta.description 与 phaseTitles，顺序与脚本 meta 声明一致。
- **B3** scope 徽标：项目内落盘的脚本 → project；`~/.acode` 侧 → user（依
  `inferScriptWorkflowScope` 既有规则）。

### C. 三档灰度

- **C1** onDemand（缺省）：新会话 RunWorkflow 可注册、`ultracode` 关键词触发 reminder、
  /ultracode 可用——与今天行为逐字一致（无回归基线）。
- **C2** 切 disabled 后**新建**会话：RunWorkflow 不注册（工具列表无它）；含 ultracode 的
  prompt 不注入 reminder；/ultracode 不出现在命令面。
- **C3** disabled 档下已注册的旧会话（改档前创建）行为不变（无中途刷新）。
- **C4** disabled 档下发起中的 run 不被终止，正常结算落库（R1）。
- **C5** 切回 onDemand 后新会话恢复 C1 全部行为。
- **C6** dwf 总闸（dynamicWorkflowMode=disabled）单独关闭时，scriptWorkflowMode=onDemand
  的新会话仍无 RunWorkflow（合取语义 R3），dwf 十工具同样不在（现状不变）。
- **C7** settings.json 手工写非法值（`"scriptWorkflowMode": "bogus"`）→ 校验层拒绝/归一化
  落缺省档，不崩溃，设置页回显 onDemand。
- **C8** dwf 总闸（dynamicWorkflowMode=disabled）+ scriptWorkflowMode=onDemand：新建会话
  无 RunWorkflow（合取 R3）、自动化页无「工作流」tab（脚本工作流分组随之不可见）、
  无脚本历史入口；dwf 总闸恢复 onDemand/alwaysOn 后工作流 tab 与脚本历史重现
  （历史数据保留）。
- **C9**（技能面与三面同结论，2026-10-18 P2 修复）dwf 开 × scriptWorkflowMode=disabled：
  新会话不加载 `script-workflows` SKILL.md，`dynamic-workflows` 保留（dwf 工具仍在）；
  dwf 总闸 disabled：两份技能都不加载；两门全开/缺席：两份都保留。任一组合下，
  技能面的答案与工具注册门/reminder 门/命令面一致。

### D. 字段链与存储

- **D1** 设置页点选三档 → settings.json 出现 `scriptWorkflowMode` 键（且重启后读回——
  object schema 登记验证，505 教训回归）。
- **D2** `pnpm typecheck` / `pnpm lint` 通过；`grep` 确认 legacy
  `packages/shared/src/acode-protocol/index.ts` 相对基线**零新增**方法/字段。

### E. UI 与文案

- **E1** zh-CN 与 en-US 下设置卡片、中枢分组全部文案成对出现，无裸键名。
- **E2** 移动 Web 宽度（≤420px）下分组两小节纵向堆叠不溢出（DESIGN.md 响应式约束）。
- **E3** disabled 档下中枢分组照常渲染数据 + 「工具已停用」徽标（R2）。

---

## 10. 测试计划（实现期，按层）

| 层 | 测试 | 落点惯例 |
| --- | --- | --- |
| shared | script-workflow-feature.ts 纯函数（取值域/归一化/缺省）；v4 schema 校验（payload/result 正反例、limit 上限、stopReason 枚举） | packages/shared 既有 `node --test` 惯例 |
| contracts/adapters | `listScriptWorkflowDefinitions` 对真实 SQLite（迁移后库）跑：空库回空、upsert 两行回两行、排序；`listScriptWorkflowRuns` cwd 过滤与 limit 截断；**logicalStatuses 下推过滤与唯一映射逐行互钉（全逻辑词 × cancelled/interrupted 分流 × 组合闭集 + limit）**；**hasScriptWorkflowUsageIncomplete 的 exists 探测与判据互钉**（script-workflow-management-store.test.mjs） | adapters 既有 store 测试先例（对着真实库，不用假 store——CHECK 约束教训） |
| cli-workflow | 逻辑状态投影（physical→logical→stopReason 全词表） | script-workflow-run-status 已有测试处 |
| bootstrap | handler：能力缺席 → V4CapabilityUnsupportedError；正常投影；错误上行。注册门：includeScriptWorkflow false 只下架 RunWorkflow 不下架 dwf；合取语义。reminder 门：两道门合取。**facade：statuses×limit×truncated 组合对真实 SQLite（A7a-A7c）；旧写子集 store → 管理能力整体缺席（A7d）；技能面门矩阵（C9，script-workflow-mode-gates.test.mjs）** | bootstrap/core 既有测试惯例 |
| services | 折叠出口：缺省/非法/读取异常三分支；两道会话门各自语义：dwf memoized 且异常按 false（:3347），script 每次现读**不 memoize** 且异常按 enabled=true（§8.1，与 dwf 刻意相反） | services 既有测试 |
| ui | ScriptWorkflowSection 三档渲染与保存调用；scriptWorkflowStore 分片与 bypass；文案键双语存在性 | packages/ui 既有测试 |
| E2E | 交互改动需要场景定义。环境受限（本工作区无可跑的桌面 E2E 环境）如实说明：给出场景定义（A1/C1/C2/C4 的端到端版本：桌面 app 内切档→新会话→/ultracode→中枢页验列表），标注「未执行」；可执行部分（协议层、store 层）以真实库/真实 schema 测试替代验证 | —— |

---

## 11. 未做与边界（评审时请确认这些「不做」）

1. **会话中途改档**不实现（§4.5 末行：改档下次会话创建生效）。
2. **脚本正文预览**不实现（§7.1：清单行只展示 meta + scriptPath，正文查看经编辑器/文件面）。
3. **运行历史的事件流/活动明细**不实现（列表只到 run 行；activity/event 明细属于
   会话详情页的后续工作，本 spec 的查询命令不暴露）。
4. **删除/归档 run 行**不实现（journal 是账本，UI 只读，R2）。
5. **definition 的 enabled 开关写路径**不实现（store port 本就没有；清单如实呈现该列）。
6. **listRunsByWorkspace 的 workspace_identity 索引优化**不实现（cwd 精确匹配已命中现成索引，
   §4.1；identity 过滤语义见同节论证）。
7. legacy 协议面**零新增**（含 session/create params 的 scriptWorkflowEnabled，§4.3）。
8. RunWorkflow 的权限面（alwaysAsk 权限块）**不变**（档位门的是可用性，不是确认——
   alwaysAsk 的裁决与理由见 run-workflow.ts:127-146，本 spec 不触碰）。

---

## 12. 实现顺序建议（评审通过后）

1. shared：script-workflow-feature.ts + AppSettings 字段 + validation 三处 + v4 schema（含测试）。
2. adapters/contracts：`listScriptWorkflowDefinitions` port + SQLite 实现（真实库测试）。
3. CLI：注册门 / reminder 门 / 命令门 / runtime config 透传（含测试）。
4. services：折叠出口 + gate + 信封注入（含测试）。
5. bootstrap：facade 方法 + v4 handlers（含测试）。
6. UI：ScriptWorkflowSection + 中枢分组 + store + i18n。
7. 全量门：`npx -y pnpm@10.33.2 typecheck && lint && 相关包 test && architecture:check --changed`
   （警惕 turbo 陈旧缓存，必要时 `--force`）。

---

## 13. 已知限制（登记备查，待产品裁决）

### 13.1 远程 workspace 的 scriptWorkflowMode 裁决发生在远端本机

`scriptWorkflowMode` 是**本机产品开关**（§3.2：无远端下发、无 env 覆盖，只读 AppSettings）。
工作区跑在远端机器（SSH / WSL / Docker）时，折叠出口读的是**远端那台机器的本地设置**；
桌面端的设置页改档只落桌面本机的 settings.json，**没有下发通道**把新档推给远端的
CLI 会话——桌面改档不影响远端 workspace 的 RunWorkflow 可用性，反之亦然。

这是 §3.2「不给 scriptWorkflowMode 配远端下发」裁决的直接后果（本机开关的边界在
「本机」二字上），在单机形态下不是问题；但「桌面端管理远端 workspace」的场景里，
两处设置的归属会让人意外。是否需要一条远端下发通道（对齐 dwf 的
`updateDynamicWorkflowPolicy` 推送先例）是**产品裁决**，不是实现缺口——暂登记为已知
限制，未实现任何变通路径（不在桌面端伪造「已生效」回显，也不在远端加配置面）。
