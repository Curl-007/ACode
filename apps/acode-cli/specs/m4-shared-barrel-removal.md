# M4 shared legacy 协议 barrel 删除：消费面甄别与启动前置

> 状态：**未执行删除——启动前置未满足，本批只落「消费面甄别 + checklist 核验 + 收缩裁决建议」**。
> 日期：2026-10-29（Asia/Shanghai）。分支 `fix/project-review-2026-10-26`（PR #11），
> HEAD `abc37880`（M3 完成）。
> 上游依据：
>
> - `docs/legacy-protocol-convergence-plan.md` M4 节（含 2026-10-27 订正）
> - `docs/reviews/2026-10-28/m3-m4-w2-dependencies.md` §A.2「M4 启动前置」checklist
> - `apps/acode-cli/specs/m3-legacy-server-removal.md` §0（幸存三词裁决）
> - `apps/acode-cli/specs/m2-prepare.md`（`acodeProtocolClient` 永久载体裁决）
> - `apps/acode-cli/specs/m2-5-plugins.md` §4（`pluginsCancelOperation` 保留裁决）
> - `packages/shared/specs/legacy-protocol-freeze.md`（冻结纪律与守护门禁）

---

## 0. 裁决（2026-10-29，本批新增）

沿用 M2/M3 季先例（`docs/reviews/2026-10-28/m2-scoping.md` §6.3：保守无能力损失默认、
标注产品可推翻）。本节裁决**只解除「口径」类问题，不解除结构阻塞**——见 §5。

### 裁决 A：M4 验收判据按 M3 先例重写

M4 原判据（`docs/legacy-protocol-convergence-plan.md:369`）为
「`git grep "acodeProtocolMethods" -- packages/shared/src` 归零」。该判据**在幸存三词仍存活时结构性不可满足**：
`sessionSubagents` / `pluginsCancelOperation` / `sessionSend`（附件回退）三个 wire 字面量
在 M3 §0 被裁决保留，且**服务端与客户端两侧都必须认识它们**——services 发送（4 处
`acodeProtocolMethods.`）与 bootstrap v4 server 派发（3 个幸存 `case`）都还在。

**新判据（M4 完成时必须同时满足）**：

```bash
test ! -f packages/shared/src/acode-protocol/index.ts          # barrel 已删
test ! -d packages/shared/src/acode-protocol                    # 目录消失
git grep "acodeProtocolMethods\b" -- packages apps              # 退出码 1（符号面归零）
git grep "acodeProtocolNotifications\b" -- packages apps        # 退出码 1（符号面归零）
git grep -l "acode-protocol/index" -- packages apps | grep -v '\.md$'   # 退出码 1（真实 import 归零）
```

**关键改写**：验收对象从「文件名/符号名」改为「**wire 字面量收敛到最小登记模块**」。
幸存三词的 wire 字面量（`"session/subagents"` 等）**允许继续存在**，但只许出现在：
① 新建的最小 legacy-survivor 模块；② services 的 4 处发送点；③ bootstrap v4 server 的 3 个 case。
**绝不为幸存面扩新能力**（M3 硬性要求的继续）。

### 裁决 B：`acodeProtocolClient` 保留，但类型联合收窄

`packages/services/src/acode-agent/acodeProtocolClient.ts` **保留**（永久传输载体，
m2-prepare.md 裁决 1）。M4 时其方法名联合 `ACodeAgentRpcMethod` 的第一项
`ACodeProtocolMethod`（来自 barrel）必须换成 survivor 模块导出的
`ACodeLegacySurvivorMethod`。文件名不动（判据只查符号名）。

### 裁决 C：`acode-protocol-legacy-types.ts` 不整删，按符号甄别

607 行中，被 v4 消费的符号**实测 10 个（非旧档记的 6 个）**——见 §2.2。
其余按归属处理：属于幸存三词闭包 / v4 有等价物的迁出，其余随 barrel 删除。

### 裁决 D：三处测试锚点同步改指，不豁免

`apps/acode-cli/tests/acp-host-adapter.test.mjs:1074`、
`architecture-coverage.test.mjs:57`、`todo-dependency-fields.test.mjs:60` 是对 barrel
**路径字面量**的引用（读文件内容做断言 / 造 fixture / 取一个 schema）。删除时同步更新。

### 裁决 E：NDJSON 信封定性为版本无关 wire 载体面（编排方裁决，2026-10-29，产品可推翻）

`acodeProtocolMessageSchema` / `ACodeProtocolMessage` 及信封族按 M2-0 对
`acodeProtocolClient` 的裁决先例定性为**版本无关 wire 载体面（永久，非 legacy 债务）**，
迁入有意命名的中立模块 `packages/shared/src/acode-protocol-envelope.ts`。
§2.6 识别的「v4 无 RPC 信封」结构性阻塞据此**不构成 M4a 的删除阻塞**：载体面与
legacy 词表面分离处置，barrel 仍可整删。

**M4b（v4 原生信封建模）作为独立协议扩展项登记**：与 M2 同性质（新协议面设计 +
双链路真实冒烟环境前置，见 m2-scoping.md §4），待产品/工程排期；不阻塞 M4a，
也不是 barrel 删除的前置。同理处置的其余 §2.6 阻塞面：存储启动控制面 →
`acode-storage-startup.ts`；session 投影/事件形状 → `acode-session-*` 中立叶族
（形状一律不改，v4 conversationSnapshotSchema 的 4 身份字段缺口留给 M4b 性质的
协议工程）；inbound params 重复声明 → v4 声明为唯一真源，barrel 副本随删。

**裁决 C 实施结果注记**：甄别完成后，legacy-types 的 10 个 v4 消费符号全部迁入
中立叶（映射登记在 `scripts/architecture/protocol-boundary.mjs` 白名单头注），
文件本体无剩余承重面，随 barrel 一并删除——「不整删」的裁决意图（先甄别后处置）
以此形式落地，白名单保留为 tombstone（复活式引用 fail-closed）。

---

## 1. 范围与判据

### 1.1 M4 原定内容（收敛计划 §M4）

1. 整删 `packages/shared/src/acode-protocol/index.ts`（3,652 行）；
2. 甄别 `acode-protocol-legacy-types.ts`（607 行）承重类型；
3. 同步清理 legacy 词表残留 schema；
4. 保留 `acodeProtocolClient.ts`。

### 1.2 本批实际结论

**M4 未执行。** 原因：§A.2 checklist 实测 0/6 完全满足、1 项部分满足、5 项未满足，
其中**结构性阻塞 4 项**（§5 逐项 file:line 证据）。强行删除会断生产——这正是收敛计划
M1 订正里谴责的「表面通过而非收敛」。

本批交付：完整消费面甄别（§2）、checklist 核验（§3）、结构阻塞与真实工作量（§5）、
保守裁决建议（§6）。

---

## 2. 消费面盘点（动手前必须完成，本节为实测结果）

### 2.1 方法：AST 级扫描（不是 grep）

`git grep` 对 `@acode/shared` 根导入无法区分「来自 barrel」与「来自其它 136 个 `export *` 模块」，
且会把注释/spec 计入。故用 TypeScript AST 扫描 `packages/` + `apps/` 下全部 `.ts/.tsx/.mjs/.js`：

1. 用 AST 提取 barrel 的导出面：**449 个本地导出 + 15 个具名 re-export + 3 个 `export *`**（合计 464 名）；
2. 对每个 `import ... from "@acode/shared"` / `@acode/shared/index.js` / `../acode-protocol/index.js`
   提取被导入的源符号名，与 barrel 导出面求交；
3. 用 barrel 之外的 136 个 `export * from "./x.js"` 反查该符号是否**另有**根入口路径
   （若有，消费方应当切到那条路径，不构成阻塞）。

脚本落在 scratch（临时目录，不入库），口径见本 §与 §9。

### 2.2 结果总览

| 口径                                   |                                                                                                            数值 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------: |
| barrel 导出名（本地 + 具名 re-export） |                                                                                                         **464** |
| 被仓库内**消费**的名字                 |                                                                      **196**（189 本地定义 + 7 具名 re-export） |
| 零外部消费的名字                       |                                                                           **268**（260 本地定义 + 8 re-export） |
| 其中**可随 barrel 直接删**             |                                                  **142 个语句 / 688 行**（其余 118 个本地名是消费闭包传递依赖） |
| 消费方文件（生产）                     |                                                                                                         **139** |
| 消费方文件（测试）                     |                                                                                                          **11** |
| `acodeProtocolMethods` 点号消费        | **25 处 / 9 文件**（bootstrap 8 文件 21 处 + services `acodeAgentService` 4 处；`acodeProtocolClient.ts` 0 处） |
| `acodeProtocolNotifications` 点号消费  |                                                        **14 处 / 7 文件**（bootstrap 5 文件 + services 2 文件） |

> 7 个被消费的名字走 barrel 的**具名 re-export**（`acode-protocol-shared.ts` 3 个 +
> `account-access-types.ts` 4 个），不在本地定义面。删 barrel 后根入口需直接
> `export * from` 这两个模块，否则 `@acode/shared` 根会丢这 7 个名字。

生产消费方按包分布：`packages/ui` 54、`apps/acode-cli` 43、`packages/services` 32、
`packages/shared` 6、`packages/desktop` 2、`packages/server` 2。

### 2.3 消费符号的三向归类（本批核心产出）

| 类    | 定义                         | 符号数 | 运行时值 | 仅类型 | 生产文件 | 判据              |
| ----- | ---------------------------- | -----: | -------: | -----: | -------: | ----------------- |
| **A** | v4 已有同名/近名等价物       | **89** |       30 |     59 |       72 | 消费方切 v4       |
| **B** | 幸存三词专属 schema/类型     | **11** |        6 |      5 |       13 | 迁 survivor 模块  |
| **D** | 无 v4 等价物、且不属幸存三词 | **89** |   **38** |     51 |   **75** | **无归属 → 阻塞** |

> 注：A/B/D 合计 189（另有 7 个符号只出现在 barrel 的 re-export 面，归零消费）。

### 2.4 A 类（89）——切 v4 可行，但**不是机械改名**

A 类里 30 个是运行时值（schema），59 个仅类型。它们有 name-map 到 v4 的等价物，
例如 `ACodeSavedWorkflowEntry → V4SavedWorkflowEntry`、`acodeAutomationListResultSchema →
v4AutomationListResultSchema`、`ACodePluginsListResult → V4PluginsListResult`。
但这**不等于零风险替换**：

- UI 侧 47 个生产文件消费 A 类（大量 saved-workflows / plugin 类型）；
- v4 的 `v4*` schema 与 legacy 同名 schema 是**逐字 parity 的两份定义**（`plugins-queries.ts`
  头注明写「形状与 legacy barrel 逐字 parity」），换 import 会改变类型身份但不改 wire——
  需要 **parity 测试**钉住，否则两侧漂移无守护；
- `acodeSessionReadParamsSchema → v4SessionReadParamsSchema` 这类是 bootstrap 内部自用，
  可随 server-operations 一起改，风险低。

**工作量估算**：72 个生产文件 + 6 个测试文件，其中 47 个在 UI。属**多日机械迁移 + API 面收敛**，
不是本批一次能落地的量。

### 2.5 B 类（11）——幸存三词闭包，迁最小模块

| 符号                                                                                                | 消费方                          | 说明            |
| --------------------------------------------------------------------------------------------------- | ------------------------------- | --------------- |
| `acodeSessionSubagentsParamsSchema` / `...ResultSchema` / `ACodeSessionSubagentsResult`             | services 1 + bootstrap 1 + UI 4 | 裁决 1（M3 §0） |
| `ACodeSessionEndedSubagent` / `ACodeSessionRunningSubagent`                                         | UI 5 + CLI tui 1 + services 1   | 同上            |
| `acodePluginsCancelOperationParamsSchema` / `...ResultSchema` / `ACodePluginsCancelOperationResult` | services 2 + bootstrap 1        | 裁决 2（M3 §0） |
| `acodeSessionSendParamsSchema` / `...ResultSchema` / `ACodeSessionSendResult`                       | services 3 + bootstrap 1        | 裁决 3（M3 §0） |

依赖闭包（AST 求闭包）：`acodeSessionSubagentBaseSchema`、`acodeSessionSubagentsResultSchema`
引用的 `nonEmptyString`；`acodeSessionSendParamsSchema` 依赖 `modelSelectionSchema`
（已在 `model-selection.ts`）、`modelExecutionSchema`（`model-execution.ts`）、
`acodeBrowserAmbientContextSchema`（`acode-protocol-shared.ts`）、
`acodeAutomationBotDeliveryTargetSchema`（`bots.ts`）——**全部已是中立叶，不阻塞**。

### 2.6 D 类（89）——**M4 的硬阻塞**

38 个有运行时消费的 D 符号，消费方 **30 个生产文件**（apps/acode-cli 20 / services 7 /
shared 1 / desktop 2）：

| 分组                     | 代表符号                                                                                                                                                                                                                                                 | 无 v4 等价物的原因                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RPC 信封**（8 个符号） | `acodeProtocolMessageSchema` / `ACodeProtocolMessage` / `...Request` / `...Notification` / `...Response` / `...Error` / `...RequestId` / `...Trace`                                                                                                      | **v4 目录完全没有 NDJSON RPC 信封 schema**（v4 `wire.ts` 只有 topic frame 物理分片，不是 RPC 信封）。消费方：bootstrap `transport.ts`（`decodeLine` 逐行 parse）、services `acodeStdioTransport.ts:250`、`server-types.ts` 的四个类型守卫 |
| **方法/通知词表**        | `acodeProtocolMethods` / `acodeProtocolNotifications` / `ACodeProtocolMethod` / `acodeProtocolErrorCodes`                                                                                                                                                | M3 幸存三词 + 8 条 notification 仍活（见 §2.2）；`ACodeProtocolMethod` 是 `server-types.ts:205` 与 `server.ts:888` 的 `requestClient` 签名                                                                                                |
| **存储启动控制面**       | `acodeStorageStartupStateSchema` / `ACodeStorageStartupState` / `acodeStoragePreparationFrameSchema`                                                                                                                                                     | v4 目录零命中（`git grep storageStartup -- packages/shared/src/acode-protocol-v4` 空）。消费方：bootstrap `storage-startup.ts`、services `acodeStorageStartupGate.ts`、desktop `storagePreparationProcesses.ts`                           |
| **telemetry / 资源采样** | `acodeMcpTelemetryEventSchema` / `acodeMcpResourceSamplesSchema` / `acodeProcessResourceSampleSchema` / `acodeToolExecResourceSchema` + 类型 + 三个常量                                                                                                  | v4 无等价物；`packages/shared/src/validation.ts:19-23` **在 shared 内部**消费 3 个 schema                                                                                                                                                 |
| **session 投影/事件**    | `acodeSessionStateSnapshotSchema` / `ACodeSessionStateSnapshot`（14 生产文件）/ `acodeSessionEventSchema` / `ACodeSessionEvent`（8 文件）/ `acodeSessionEventsResultSchema` / `ACodeSessionSettingsState`（5 文件）/ `acodeSessionCreateParamsSchema` 等 | `conversationSnapshotSchema` 是**不同形状**（缺 4 个身份字段，M1 订正已实测）；`ACodeSessionEvent` 的 26 变体 discriminated union 在 v4 无对应                                                                                            |
| **inbound 交互**         | `acodePermissionRequestParamsSchema` / `acodeUserInputRequestParamsSchema` + 类型                                                                                                                                                                        | v4 `inbound-interaction.ts` 的 params **逐字重复声明**在 v4 侧，但**未与 legacy 同源**（两处独立定义）                                                                                                                                    |
| **model 常量/枚举**      | `DEFAULT_ACODE_MODEL_CONTEXT_BUDGET_STRATEGY`（7 文件）/ `ACodeModelContextBudgetStrategy`（4）/ `ACodeModelOption`（4）/ `ACodeDeliveryKind`（6）/ `ACodeSessionMode`（9）/ `McpServerFailureKind`（5）                                                 | v4 有**近名但不等价**的定义（如 `v4WorkspaceSessionModeSchema` 只在 workspace-runtime.ts 局部声明）；`McpServerFailureKind` 在 v4 侧是 `V4McpServerFailureKind`，值域不同                                                                 |
| **其它**                 | `ACodeWorkspaceRef`（10 文件）/ `ACodeProtocolEmptyResultSchema` / `ACodePluginOperationProgressNotification` / `ACodeComputerUseOperationEvent` 等                                                                                                      | `ACodeWorkspaceRef` 的 schema 在 legacy-types（幸存面），但**类型别名**只在 barrel 里                                                                                                                                                     |

**D 类不是「没人用的死代码」——它是 M4 的真实主体。** 收敛计划把 M4 描述为
「整删 barrel + 甄别 legacy-types」，隐含假设「barrel 里剩下的都是死词」。实测不成立：
barrel 仍承担 **RPC 信封 + 存储启动面 + telemetry + session 投影/事件**四条活链路。

---

## 3. §A.2「M4 启动前置」checklist 逐项核验（2026-10-29 实测）

> 命令均在 worktree 根执行。判定口径：✅ 满足 / ⚠️ 部分 / ❌ 未满足。

| #   | checklist 项                                                                                             | 判定 | 实测证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | services 3 文件全部清零（`acodeAgentService` / `pluginReferenceCatalogRequest` / `acodeProtocolClient`） | ⚠️   | `pluginReferenceCatalogRequest.ts` **已清零**（M3 删回落链）。`acodeAgentService.ts` 仍 **4 处**（全在 M3 幸存清单：`:4291` sessionSubagents / `:4776` pluginsCancelOperation / `:5191,5216` sessionSend）。`acodeProtocolClient.ts` 自身 **0 处点号消费**（命中的是文件名自指 + 注释），但其类型联合仍引 `ACodeProtocolMethod`（barrel 符号）                                                                                                                                                                                                 |
| 2   | bootstrap 9 文件全部清零                                                                                 | ❌   | M3 已把目录搬成 `acode-protocol-v4/`，**8 个文件仍消费** `acodeProtocolMethods.`：automation-port(5) / browser-control-broker(4) / interaction-broker(3) / offpeak-port(3) / server(3, 幸存 case) / official-mcp-auth-port(1) / provider-runtime-headers(1) / server-operations(1)                                                                                                                                                                                                                                                             |
| 3   | `acodeProtocolMethods` 与 `acodeProtocolNotifications` 两个非 Schema 导出零消费                          | ❌   | `git grep -l` → `acodeProtocolMethods` **9 文件**（bootstrap 8 + services 1），`acodeProtocolNotifications` **7 文件**（bootstrap 5 + services 2）。**全部在幸存清单或 M3 遗留偏斜面内**，不是遗漏                                                                                                                                                                                                                                                                                                                                             |
| 4   | `acode-protocol-legacy-types.ts` 按 2026-10-26 review §2 甄别（6 schema 幸存）                           | ❌   | **实测 10 个符号**被 15 个 v4 文件 import（旧档记 6 个）：`acodeWorkspaceRefSchema`(12 文件)、`acodePermissionResponseSchema`(2)、`acodeInteractionRequestOriginSchema`(2)、`acodeSessionGoalSchema`(2)、`acodeDeliveryKindSchema`(1)、`acodeSessionInfoSchema`(1)、`acodeSessionModeSchema`(1)、`acodeContextUsageBreakdownSchema`(1)、`acodeSessionContextCacheUsageSchema`(1)、`acodeSyntheticUserMessageSourceSchema`(1)。`protocol-boundary.mjs` 白名单登记 **11 个**（多出 `acodeMessageWithPartsSchema`，实际**无 v4 文件 import 它**） |
| 5   | 4 处 v4→legacy-types import 不能扩面                                                                     | ❌   | 已扩到 **15 文件 / 10 符号**（M2 各批 additive 增长）。门禁在位且绿（白名单覆盖 10 个真实符号 + 1 个未用符号），但「不扩面」的前提已失效——是**合法增长后未更新文档**                                                                                                                                                                                                                                                                                                                                                                           |
| 6   | barrel 头注的两个删除触发条件都已发生（M3 server 删除 + M2 services 切换）                               | ❌   | 头注（`index.ts:6-18`）写「上述旧协议 client/server 组删除时，本文件整体删除」。M3 已删 server、M2 已切换方法消费，但**barrel 仍被 139 个生产文件消费**——触发条件只是形式成就，实质上 barrel 仍承重                                                                                                                                                                                                                                                                                                                                            |

**结论：0 项 ✅、1 项 ⚠️、5 项 ❌。**

### 3.1 与 `git grep` 口径的差异（必须记下）

任务书给的三处测试锚点实测**全部是真锚点**，但**不是全部**——实测真引用共 **13 处**：

| 位置                                                                                  | 实际内容                                                                                               | 处置                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `apps/acode-cli/tests/acp-host-adapter.test.mjs:1074`                                 | `readFileSync(join(REPO_ROOT, "packages/shared/src/acode-protocol/index.ts"))` + `assert.doesNotMatch` | **真锚点**：断言对象消失，须改                                     |
| `apps/acode-cli/tests/architecture-coverage.test.mjs:57,168`                          | 57 行造 fixture 文件；168 行 `protocolBoundaryFixture(t, "../acode-protocol/index.js")`                | **真锚点**：fixture 需改（改为断言「目录不存在」或指向新幸存文件） |
| `apps/acode-cli/tests/todo-dependency-fields.test.mjs:60`                             | `await import("../../../packages/shared/src/acode-protocol/index.ts")` 取 `acodeSessionTodoItemSchema` | **真锚点**：需改指新家                                             |
| `packages/shared/src/index.ts:87`                                                     | `export * from "./acode-protocol/index.js"`                                                            | **根入口 re-export，必须删**                                       |
| `packages/shared/src/acode-agent-model-state.ts:11`                                   | `import type { ACodeSessionMode, ACodeSessionSettingsState }`                                          | **真 import**（D 类，切新家）                                      |
| `packages/shared/src/acode-session-task-status.ts:6`                                  | `import type { ACodeSessionStateSnapshot }`                                                            | **真 import**（D 类）                                              |
| `packages/shared/src/acode-session-visible-content.ts:7`                              | `import type { ACodeSessionGoal }`                                                                     | **真 import**（D 类）                                              |
| `packages/shared/src/coding-plan-reset.ts:42`                                         | `import type { ACodeAccountAccess, ACodeProviderAccountAccess }`                                       | **真 import**（A 类，改指 `account-access-types.js`）              |
| `packages/shared/src/mcp.ts:7`                                                        | `import type { ACodeMcpReconnectSuspension, McpServerFailureKind }`                                    | **真 import**（前者已在 `acode-protocol-shared.ts`；后者 D 类）    |
| `packages/shared/src/plugin-display-name.ts:1`                                        | `import type { ACodePluginStoreListing }`                                                              | **真 import**（A 类 → `V4PluginStoreListing`）                     |
| `packages/shared/src/validation.ts:19-23`                                             | 3 个 telemetry schema                                                                                  | **真 import**（D 类）                                              |
| `packages/shared/test/{mcp-status-suspension,tool-media-client-mode-command}.test.ts` | `from "../src/acode-protocol/index.js"`                                                                | **真 import**（任务书未列）                                        |
| `packages/shared/tests/protocol-boundary.test.mjs:6`                                  | `await import("../src/acode-protocol/index.ts")`                                                       | **真 import**（任务书未列，4 条测试依赖）                          |

**另有 4 处是路径字面量断言（非 import，但删文件后会红）**：

| 位置                                                            | 内容                                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/shared/test/legacy-protocol-barrel-freeze.test.ts:20` | `barrelPath = join(here, "..", "src", "acode-protocol", "index.ts")` —— 整份冻结守护需随 barrel 退役删除或改写 |
| `packages/shared/test/providerDiagnostics.test.ts:407-417`      | `readFileSync(... acode-protocol/index.ts)` 断言不得含 provider 诊断契约                                       |
| `packages/server/tests/harness-api.test.mjs:716-717`            | 仅测试数据字符串（模拟 `git status` 输出），**无需改**                                                         |
| `packages/ui/test/workspaceModeConfigOptions.test.ts:57`        | 注释提「`acode-protocol/index.ts:3529`」，保留（来历注释，同 M1 先例）                                         |

**终态 `git grep -l "acode-protocol/index" -- packages apps` 的归零口径必须排除 `.md` 与上述
「来历注释」类**——与 M1「零 import」裁决同型（`docs/legacy-protocol-convergence-plan.md:413-424`）。

---

## 4. legacy-types 甄别（M4 必须继承的清单）

### 4.1 被 v4 消费的 10 个符号（实测，非旧档的 6 个）

| 符号                                    | v4 导入方（文件数） | 归属建议                                                                                                                                                                             |
| --------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `acodeWorkspaceRefSchema`               | 12                  | **迁 v4 中立叶**（`acode-protocol-shared.ts` 或新建 `workspace-ref.ts`）——它是 v4 与 legacy 双向共用的身份契约                                                                       |
| `acodePermissionResponseSchema`         | 2                   | 迁 v4 或 survivor（属 inbound 交互面）                                                                                                                                               |
| `acodeInteractionRequestOriginSchema`   | 2                   | 同上                                                                                                                                                                                 |
| `acodeSessionGoalSchema`                | 2                   | 迁 v4（goal wire 形态；M2-2 已显式登记）                                                                                                                                             |
| `acodeDeliveryKindSchema`               | 1                   | 迁 v4（v4 侧已有逐字副本 `topicFrameDeliveryKindSchema`，**但值域不同**：legacy 是 `desktop-continuous`/`web-remote-replayable`，v4 是 `initial`/`online`/`recovery`——**不可合并**） |
| `acodeSessionInfoSchema`                | 1                   | **迁 survivor 或 v4**（依赖闭包含 goal/workspace/kind/status/mode，链长）                                                                                                            |
| `acodeSessionModeSchema`                | 1                   | 同上（`workspace-runtime.ts` 已本地复制一份，需收敛）                                                                                                                                |
| `acodeContextUsageBreakdownSchema`      | 1                   | 迁 v4                                                                                                                                                                                |
| `acodeSessionContextCacheUsageSchema`   | 1                   | 迁 v4                                                                                                                                                                                |
| `acodeSyntheticUserMessageSourceSchema` | 1                   | 迁 v4                                                                                                                                                                                |

### 4.2 legacy-types 的 AST 闭包

以这 10 个符号为种子求闭包：**36 个符号 / 约 465 行**（607 行中）。
被闭包排除的 23 个符号（`acodeSessionRuntimeStateSchema`、`acodeSessionGoalVerificationSchema`、
`textFromACodeMessageParts`、`OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME` 等）**仍被 barrel 外的
代码消费**（`git grep` 实测 1-5 个文件各），不能盲删——它们要按 A/B/D 三向归类另判。

### 4.3 `protocol-boundary.mjs` 白名单的现状偏差

白名单登记 **11 个符号**，其中 `acodeMessageWithPartsSchema` **无任何 v4 importer**
（`git grep acodeMessageWithPartsSchema -- packages/shared/src/acode-protocol-v4` 空）。
另 10 个与实测 import 一一对应。M4 白名单同步时应收窄到实际 10 个 + 更新指向新家。

---

## 5. 结构阻塞（M4 未执行的原因，逐项 file:line）

### 阻塞 1：v4 没有 NDJSON RPC 信封 schema（**最硬**）

- `packages/shared/src/acode-protocol-v4/` 全目录**零** `acodeProtocolMessageSchema` /
  `ACodeProtocolMessage`（AST 扫描 + `git grep` 双验）。
- v4 `wire.ts` / `wire-codec.ts` 是 **topic frame 物理分片**（`TopicWireFrame`，
  `wireVersion`/`kind: "complete"|"fragment"`），不是 `{id, method, params}` RPC 信封。
- 三个生产消费点：bootstrap `acode-protocol-v4/transport.ts:9,236`（`decodeLine` 逐行
  `safeParse`）、services `acodeStdioTransport.ts:5,250`（`parse` 每一行）、
  `server-types.ts:223-240` 四个类型守卫（`isRequest`/`isNotification`/`isResponse`/`isErrorResponse`）。
- **后果**：删 barrel 即删掉整个 CLI↔host 的 wire 解码面。这不是 M4 的「甄别」，是**新建 v4 信封协议**。

### 阻塞 2：存储启动控制面在 v4 无任何对应

- `acodeStorageStartupStateSchema` / `ACodeStorageStartupState` / `acodeStoragePreparationFrameSchema`
  在 v4 目录零命中。
- 消费方：bootstrap `storage-startup.ts:6,34`、services `acodeStorageStartupGate.ts`、
  desktop `storagePreparationProcesses.ts:15`（host 侧 worker 协议）。
- 这条链路是**启动期私有控制帧**（`startup/storagePath` / `storagePrepared` / `storageState`），
  刻意不进业务事件——它本来就不是「协议面」的一部分，但**物理上住在 barrel 里**。

### 阻塞 3：session 投影/事件形状与 v4 snapshot 不等价

- `ACodeSessionStateSnapshot`（14 生产文件）+ `acodeSessionStateSnapshotSchema`：
  v4 `conversationSnapshotSchema` 是**不同形状**（M1 订正已实测：缺 `traceId`/`workspacePath`/
  `createdAt`/`updatedAt` 四个身份字段）。
- `ACodeSessionEvent`（8 文件）+ 26 变体 discriminated union：v4 无等价物。
- `ACodeSessionSettingsState`（5 文件）+ schema：v4 `sessionConfigStateSchema` 字段集**不同**
  （legacy 有 `available`/`thoughtLevel.available`，v4 是扁平 `provider`/`model`/`thought`）。
- **m2-3 spec §2.6 已把这件事显式推给 M4**：「schema 居所 consolidation 归 M4（legacy-types
  幸存面收编）」——即 v4 自己不复制这份闭合，**等 M4 收编**。M4 现在要把这 26 变体搬进
  legacy-types 幸存面或 v4，是**数百行搬迁 + parity 钉住**。

### 阻塞 4：inbound 交互 params 在 v4 是「逐字重复声明」而非同源

- `acodePermissionRequestParamsSchema`（4 生产文件）、`acodeUserInputRequestParamsSchema`（4 文件）
  在 v4 `inbound-interaction.ts` 有**独立的同名形态定义**（本地 `z.object(...)`），
  两边靠 `protocol-boundary.test.mjs` 的 parity 断言钉住——但**不是同一份定义**。
- 删 barrel 需要把它们收敛成单一真源（迁 v4 或中立叶），否则 v4 侧那份成为孤儿。

### 阻塞 5（口径类，已被本批裁决 A 解除）

`acodeProtocolMethods` / `acodeProtocolNotifications` 因 M3 幸存三词**不能归零符号名**，
只能归零「除幸存清单外的符号名」。裁决 A 已处理。

---

## 6. 保守裁决建议（待编排方/产品确认，本批未执行）

按「保守无能力损失默认、标注产品可推翻」先例，M4 的可执行路径是**分三段**，
每段独立可验收：

### 段 1（低风险，可立即做）：只删「零外部消费且不在消费闭包内」的 142 个语句

- **不是 268 个**。268 是「零外部消费的名字数」，但其中 **118 个是消费闭包的传递依赖**
  （如 `acodeProtocolRequestSchema` 被 `acodeProtocolMessageSchema` 引用、
  `acodeSessionTodoItemSchema` 被 `acodeSessionProjectionSchema` 引用），删了会断已消费符号。
- AST 闭包实测：**142 个语句 / 688 行**可删（barrel 3,652 行 → 约 2,964 行，−19%）；
  保留 307 语句 / 2,295 行。
- 段 1 **不改变任何消费方**，只削 barrel 体量，为段 2/3 铺路。
- 需同步处理 shared src 内那 7 处真 import 吗？——**不需要**：那 7 处消费的
  符号都在闭包内（被保留）。测试锚点 6 处在段 3 删文件时统一处理。

### 段 2（本体，需先做协议扩展）：四条活链路

| 链路               | 需要的新 v4 面                                                    | 已有先例                            |
| ------------------ | ----------------------------------------------------------------- | ----------------------------------- |
| RPC 信封           | 新建 `v4 NDJSON 信封 schema`（`{id, method, params}` 四元 union） | 无——**这是新协议面**，须 spec-first |
| 存储启动           | 迁中立叶（不是 v4 面——它是启动期私有帧）                          | `acode-protocol-shared.ts` 模式     |
| session 投影/事件  | 26 变体事件 union 迁 legacy-types 幸存面或 v4                     | m2-3 §2.6 已裁决「归 M4 收编」      |
| telemetry/资源采样 | 迁中立叶                                                          | 同 M2-B 模式                        |

### 段 3（收尾）：删 barrel + 删目录 + 白名单/policy/baseline 同步

段 1+2 完成后，barrel 只剩幸存三词闭包 → 迁 survivor 模块 → 删目录。

### 替代方案（更保守，本批推荐）

**M4 拆成 M4a（段 1+3 结构件）/ M4b（段 2 协议扩展）。** M4b 与 M2 同性质——是
**协议扩展工程**，不是退役工程。收敛计划的 M4 描述「整删 barrel」低估了这一层。

---

## 7. 验证边界（本批）

本批**只做只读甄别**，未改任何生产代码。已执行的门禁（基线快照，供后续批次对照）：

| 门禁                                                      | 结果                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `node scripts/check-workspace-freshness.mjs`              | 基线新鲜（ahead 74 / behind 0，阈值 50）                      |
| `pnpm typecheck`                                          | **exit 0**（32/32 tasks，15.0s）                              |
| `pnpm lint`                                               | **163 warnings / 0 errors**（与任务书基线一致）               |
| `pnpm architecture:check --changed`                       | **new 0 / regrown 0**（violations 0 / legacy over-limit 413） |
| `pnpm --filter @acode/shared test`                        | **478 pass / 0 fail**（与基线一致）                           |
| `node scripts/licenses.mjs reproducibility --inputs-only` | **2902 项全部相符**（barrel 不在 inventory inputs 内，见 §8） |

---

## 8. 台账影响（M4 实施时才需要）

**实测：barrel 不在 `third-party/inventory.json` 的 inputs 内。**
`keys.filter(k => k.includes("acode-protocol"))` → 只有
`packages/shared/src/acode-protocol-v4/wire-codec.ts` 一项。`packages/shared/src` 下仅 **1 个**
文件被台账登记。

**含义（订正任务书假设）**：删 barrel **不会**产生台账结构性漂移。`reproducibility --inputs-only`
当前 2,902 项全绿，删 barrel 后仍然全绿。若 M4 段 1/2 改了**被登记**的文件（如
`wire-codec.ts`），才需要按「内容哈希单条定点回补」处理。

---

## 9. 复现口径（脚本在 scratch，不入库）

AST 扫描脚本（临时目录 `C:\Users\Administrator\.acode\cli\scratch\`）：

- `m4-consumers.mjs` — 提取 barrel 导出面 + 全仓 import 交点；
- `m4-classified.mjs` / `m4-domains.mjs` — 按来源/域归类；
- `m4-abc.mjs` — A/B/D 三向分类；
- `m4-v4mapping.mjs` / `m4-fuzzy.mjs` — v4 同名/近名映射；
- `m4-lt-closure.mjs` — legacy-types 闭包；
- `m4-real-imports.mjs` — 区分真 import 与注释/字符串引用。

关键判据命令（可独立复跑）：

```bash
# 真 import 归零（现状：13 处真引用，见 §3.1）
git grep -l "acode-protocol/index" -- packages apps | grep -v '\.md$'

# 符号面（现状：acodeProtocolMethods 9 文件 / acodeProtocolNotifications 7 文件）
git grep -ln "acodeProtocolMethods\b" -- packages apps | grep -v '\.md$'
git grep -ln "acodeProtocolNotifications\b" -- packages apps | grep -v '\.md$'

# legacy-types v4 导入面（现状：15 文件 / 10 符号）
git grep -c "acode-protocol-legacy-types" -- packages/shared/src/acode-protocol-v4 | wc -l
```

---

## Acceptance scenarios（M4 真正实施时）

1. §0 裁决 A 的五条判据**全部**满足；
2. `pnpm typecheck` exit 0 / `pnpm lint` ≤163 warnings 0 errors / `pnpm architecture:check --changed`
   new 0 regrown 0；
3. 五个包测试全绿：shared(478) / services(578 pass, 7 skip) / ui(1231) / cli(3243, 3206 pass,
   37 skip) / server(114)；
4. `protocol-boundary.mjs` 白名单改指新家且**只含实际被 import 的符号**（当前多登
   `acodeMessageWithPartsSchema`）；
5. `architecture-policy.yaml` 的 `onboard-b3-shared-over-limit` / `-disables` 两节移除
   barrel 与 legacy-types 的 paths 条目（**定点 Edit**）；
6. `docs/legacy-protocol-convergence-plan.md` M4 标完成 + 进度表「shared legacy 协议文件行数」→ 0。
