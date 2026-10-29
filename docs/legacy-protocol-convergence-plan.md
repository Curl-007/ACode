# Legacy ACode Protocol 收敛时间表

> 生成日期：2026-10-05。行号与计数以 dev/0.0.4 当日检出实测为准（`wc -l` / `git grep`），实施前按文件名+符号名复核。
> 本文是 2026-10-05 深度审查 P1 建议「明确 legacy 协议删除时间表」的落地件。与 [AGENTS.md](../AGENTS.md) 冲突时以 AGENTS.md 为准。

## 现状：三代协议面并存

| 协议面             | 位置                                                                                                  | 规模（实测）                                           | 状态                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| legacy 协议 schema | `packages/shared/src/acode-protocol/index.ts`                                                         | 3,714 行、约 257 个导出                                | 头注已声明删除边界：「上述旧协议 client/server 组删除时，本文件整体删除」         |
| legacy 协议 server | `apps/acode-cli/packages/bootstrap/src/acode-protocol/`                                               | 48 文件 / 14,713 行                                    | 与 v4 并存，靠 `v4-bridge.ts` 单向依赖（只允许旧目录 → v4 目录）做 strangler 迁移 |
| v4 协议            | `packages/shared/src/acode-protocol-v4/` + `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/` | shared 侧约 10.8k 行；bootstrap 侧 51 文件 / 21,737 行 | 目标形态，263 个文件已引用 v4/V4_METHODS                                          |
| （相关面）ACP 适配 | `apps/acode-cli/packages/cli/src/acp/`                                                                | 约 1.8k 行                                             | 独立对外协议面，不在本收敛范围，但依赖 v4 gateway，M3 需一并回归                  |

混合调用的直接证据：`packages/services/src/acode-agent/acodeAgentService.ts` 同时调用 legacy `acodeProtocolMethods.*` 与 `V4_METHODS.*`；`v4-bridge.ts` 头注列出的过渡钩子（`ensureModelReady` / `afterLegacyStateMutation` / `closeSession` / `createSessionRecord` / child record registration / `resumePersistedSession`）全部注入旧协议实现，「随旧协议一同删除」。

## 调用方清单（git grep 实证，2026-10-05）

**services 侧（legacy 方法契约消费方，7 个文件）**——`git grep -l "acodeProtocolMethods\|acodeProtocolClient" -- packages/services/src`：

- `acode-agent/acodeAgentProcessManager.ts`
- `acode-agent/acodeAgentService.ts`
- `acode-agent/acodeProtocolClient.ts`（**订正 2026-10-27**：原标注「legacy 客户端本体」有误。
  它是 legacy 与 v4 **共用**的版本无关 JSON-RPC 传输载体——`acodeProtocolClient.ts:19` 的方法名
  联合已含 `V4Method`，v4 方法经它派发，`transport.ts:370-371` 明写旧协议删除后「这里就是唯一
  协议面」。**它不在退役清单内**，详见 M2 节订正 ①②）
- `acode-agent/independentPlanSupport.ts`
- `acode-agent/pluginReferenceCatalogRequest.ts`
- `node.ts`（组合根装配）

**UI 侧（旧投影读路径，8 个文件）**——`git grep -l "acodeSessionProjection" -- packages/ui/src`：

- `components/workflow-timeline/WorkflowRunSettingsPopover.tsx`、`subagent-model-label.ts`、`workflowRunSettings.ts`
- `hooks/useActiveTaskSnapshotMeta.ts`、`hooks/workspacePrepareRpc.ts`
- `settings/AutomationEditView.tsx`、`settings/SubagentsSection.tsx`
- `v4/SessionPane.tsx`

**CLI 侧**：legacy server 目录自身（48 文件）+ `v4-bridge.ts` 过渡钩子。

**冻结规则（自本文落地起生效）**：新命令、新事件、新 schema 只进 `acode-protocol-v4/`；legacy 面只允许删减与缺陷修复，不允许新增导出。承重类型继续留在 `acode-protocol-legacy-types.ts` 直至 M4 甄别。

## 里程碑

每个里程碑的验收都必须包含：对应 grep 归零命令 + `pnpm typecheck` + `pnpm test`（全仓）+ `pnpm architecture:check`；超限文件数下降时运行 `pnpm architecture:baseline:update` 收紧 ratchet 基线。

### M1 — UI 旧投影收口（可与 M2 并行）——✅ 已完成（2026-10-28）

- 内容：UI 消费文件从 `acodeSessionProjection` 读路径迁到 v4 snapshot/query 投影。
- 验收：`git grep 'from "@/lib/acodeSessionProjection' -- packages/ui/src` 归零（**零 import** 判据，见下「验收口径」）；`pnpm --filter @acode/ui test` 绿。
- 风险：SessionPane.tsx 本身是上帝组件（带 max-lines 豁免），改动面大；迁移时不得顺手重构，只换投影读路径。

> **M1 完成登记（2026-10-28）**：UI 投影桥 `acodeSessionProjection.ts`（272 行、5 导出）已整体退役删除，
> 真实 import = 0（满足「零 import」验收判据），`pnpm --filter @acode/ui test` 772/772 全绿。
> 最后一个产品决策（`workspacePrepareRpc` 预热期 mode 目录来源）已裁决——**mode 是常量**
> （legacy `readWorkspacePresentation` 硬编码 `mode:"build"`，协议从来不是 mode 的权威源），
> 见 `packages/ui/specs/workspace-prepare-mode-source.md`。slashCommands 仍是真实协议事实，
> 归 M2 切换，不在 M1 范围。

> **实测订正（2026-10-27，M1 启动前调研）**：本节的三条前提经源码核验**均需修正**，且 M1
> **不是** bounded 迁移——它阻塞在尚不存在的 v4 协议面上。逐条：
>
> 1. **「8 个 UI 消费文件」实为 12 个**（`grep -l acodeSessionProjection -- packages/ui/src` 实测，
>    与进度表 2026-10-26 列的 12 一致；本节数字是 2026-10-05 基线，未随 M1 消费面增长更新）。
> 2. **`acodeSessionProjection` 不是 legacy barrel 的 schema，而是 UI 本地迁移桥**
>    （`packages/ui/src/lib/acodeSessionProjection.ts`，272 行，5 个导出）。barrel 里同名的
>    `acodeSessionProjectionSchema`（`acode-protocol/index.ts:884-910`）是 legacy
>    `acodeSessionStateSnapshotSchema` 的内部依赖，**12 个 UI 文件无一直接引它**——那是 M4 的面。
>    故验收 grep 命中的是 UI 桥的 import 路径，不是协议 schema。
> 3. **「`taskQueryCacheStore` / v4 conversation projection store 已有承接面」对 12 个中的 2 个为假**：
>    - **10 个只 import 模型选择器字符串工具**（`parseModelPickerValue` / `formatModelPickerValue`），
>      不是投影读取。且 UI 版 `parseModelPickerValue` **不是** shared 版的 re-export：它先跑
>      `decodeCustomModelValue` 处理展示态 `custom:provider:model`（`acodeSessionProjection.ts:74-86`），
>      而 shared 版遇到 `custom:` 串会**抛错**（无 `/` 分隔符，`model-selection.ts:48`）。
>      因此把这 10 处 import 天真改指 `@acode/shared` 会**静默破坏自定义模型**。
>      这 10 个是 bounded 的**搬迁**（把自定义感知的包装器移到中立 UI 模块 + 改 import），
>      但**搬迁它们不会让验收 grep 归零**——桥文件与下面 2 个仍在，grep 依旧非零。
>    - **2 个是真投影消费方，且 v4 承接面不存在**（三项均实测零命中）：
>      `hooks/useActiveTaskSnapshotMeta.ts:76` 用 `acodeSessionSnapshotToTaskMeta(snapshot)`，
>      snapshot 是 legacy `readSession` 返回的 `ACodeSessionStateSnapshot`；要迁需**先建**
>      v4 归档/单会话一次性冷读（`V4_METHODS` 无 `readSession` 等价物，v4 conversation 是
>      subscribe-only）。
>      **订正（2026-10-28，实施期实测）**：本文此前（提交 `9f8aea05`）说需「加
>      `ConversationSnapshot → ACodeTaskMeta` 映射器」——该表述**不成立**，照它施工会产出
>      非法对象。`ACodeTaskMeta` 有 7 个必填字段（`taskId`/`traceId`/`title`/`workspacePath`/
>      `createdAt`/`updatedAt`/`mode`），而 `conversationSnapshotSchema` 的**顶层**只有
>      `sessionId`/`logEpoch`/`seq`/`revision`/`control`/`availability`/`inputRouting`/`meta`/
>      `config`/`usage`/`queue`/`rows` 等，**四个身份字段（`traceId`/`workspacePath`/
>      `createdAt`/`updatedAt`）在快照里根本不存在**（实测 `snapshot.ts:524-560` 顶层字段清单）。
>      快照只能供出 `title`（`meta.title`）、`mode`/`model`/`thought`（`config`）、
>      `status`/`lastError`（`control`）、`taskId`（`sessionId`）——即 7 个必填里的 4 个。
>      **故新冷读命令的响应必须是「身份信封 + 快照投影」的合成体**（identity envelope 携带
>      workspacePath/workspaceIdentity/createdAt/updatedAt/traceId，与快照字段合并后才构成合法
>      `ACodeTaskMeta`），而不是裸 `ConversationSnapshot`。这也解释了为什么既有
>      `mapSessionSummaryToTaskMeta.ts`（sessions-index 侧的同类映射）必须靠 `options.workspacePath`
>      与 `previous?.traceId` **外部注入**这四个字段——`SessionSummary` 同样不带它们。
>      另需登记：`acodeSessionSnapshotToTaskMeta` 里 `fromACodeGoal` 的三处防御分支
>      （snake_case `sessionID`/`targetID` 读取、非法 `status` 回落 `"active"`）对任何通过
>      `acodeSessionGoalSchema`（`.strict()`、camelCase、闭集 enum）校验的输入**不可达**，
>      迁移时不应照搬（曾由 `packages/ui/test/acodeSessionProjection.test.ts` 专测钉住；
>      该测试随投影桥退役删除，结论保留在 spec v4-session-header-meta.md §4.2 与
>      `session-header-meta.ts` 的实现——叶子的 goal schema 未照搬那三处兜底）。
>      `hooks/workspacePrepareRpc.ts:44` 用 `acodeWorkspacePresentationToConfigOptions`，
>      数据来自 legacy `readWorkspacePresentation`；v4 workspace-config topic schema 已存在且
>      services 已发射（`acodeTaskIndexSyncer.ts:1185`），但 **`packages/ui/src` 对其零消费**
>      （`workspaceConfigTopic`/`WorkspaceConfigSnapshot` grep 全空）——承接面是 UI 侧空白，
>      两个候选 store 都不合（`taskQueryCacheStore` 存 task meta 非 workspace 配置目录；
>      `conversationProjectionStore` 是 per-conversation 非 workspace 级）。
> 4. **M1 的第二道验收门无保护力**：全仓无任何测试引用 `acodeSessionProjection`、
>    `acodeSessionSnapshotToTaskMeta`、`acodeWorkspacePresentationToConfigOptions` 或
>    `parseModelPickerValue`（`packages/ui` 与 `packages/shared` 全部测试文件 grep 为空）。
>    故 `pnpm --filter @acode/ui test` **无论迁移对错都恒绿**，捕获不到 `custom:` 回归。
>    迁 M1 前必须先补这批测试，否则「测试绿」不构成任何证据。
> 5. **SessionPane 的 M1 风险远低于本节所述**：它对桥的唯一牵连是 1 处
>    `parseModelPickerValue`（`:2766`，在 `handleRecoverCustomModelSelection` 内，喂的正是
>    `encodeCustomModelValue` 产出的 `custom:` 串）+ 1 行 import；它**不调**
>    `acodeSessionSnapshotToTaskMeta`。故「3,629 行上帝组件改动面大」对本项不成立——
>    真正的难点在上面第 3 条的 2 个消费方。
>
> **结论**：M1 属「需先扩 v4 协议面」类，与 M2 同性质（见 2026-10-09 说明），**不是** 1-2 人日
> 的机械迁移。只搬那 10 个并改名/删文件强行让 grep 归零，会留下 `readSession` /
> `readWorkspacePresentation` 两条 legacy 读路径仍在底下活着——那是**表面通过而非收敛**，
> 违反本仓「不假装完成」纪律。
>
> **实施进展（2026-10-28）**：M1 的两个前置件 + 第一批消费方已落地，M1 从「blocked」推进到
> 「只剩 1 个真 import + 若干产品决策」：
>
> 1. **测试网（M1 先决条件）已补**：`packages/ui/test/acodeSessionProjection.test.ts`（16 测）
>    + `modelPickerValue.test.ts`（10 测），覆盖桥的 3 个投影函数与 2 个 picker 函数，fixture
>    经真实 zod schema 自校验。此前全仓零覆盖、验收门恒绿的问题解除。mutation 验证非空转。
> 2. **第一个真投影消费方已迁 v4**（`useActiveTaskSnapshotMeta`）：新建 v4 归档冷读
>    `v4/session/headerMeta`（spec `apps/acode-cli/specs/v4-session-header-meta.md`；提交
>    `d6cfe2c6` 协议层 + `d833a776` services 端口 + `d1bcf9f9` UI 映射与 hook）。响应是
>    「身份信封 + 投影」合成体（裸 ConversationSnapshot 缺 4 个必填身份字段，实测 snapshot.ts:524-560），
>    不激活会话运行时、只读持久层、字段与 legacy 逐字 parity。
> 3. **10 个 picker 消费方已搬迁**（提交 `eaa9d57a`）：`parseModelPickerValue`/`formatModelPickerValue`
>    移到中立叶子 `packages/ui/src/lib/modelPickerValue.ts`（唯一定义），10 处 import 改指它，
>    桥删本地定义改 import——消除重复实现。**保持 custom: 解码语义不变**（M1 头号陷阱，测试钉住）。
> 4. **真实 import 计数 11 → 1**（`grep -l 'from "@/lib/acodeSessionProjection'` 实测）：
>    只剩 `hooks/workspacePrepareRpc.ts` 用 `acodeWorkspacePresentationToConfigOptions`。
>    （此为 picker 搬迁后的**中间态**；最后 1 个消费方经下方裁决迁走后计数归 0，见「M1 UI 投影收口进展（2026-10-28）」。）
>
> **剩余消费方的裁决（2026-10-28，实测）**：`workspacePrepareRpc` 的 v4 权威源**不是**
> 「modelSelectionService vs workspace-config」二选一——**两个候选都不成立**：
>
> 1. **`modelSelectionService` 结构上不可能**：`ModelSelectionView`
>    （`packages/provider/src/facades.ts:220-224`）只有 `revision` / `providers` /
>    `preferredSelection`，`ModelSelectionProviderView`（`:207-214`）只有
>    `providerId`/`config`/`models`——**没有 mode，也没有 slashCommands**（对
>    `effective-model-selection.ts` 与 `facades.ts` grep `mode|slashCommand` 命中 0）。
>    而 `workspacePrepareRpc` 必须产出这两样（`ACodeWorkspacePrepareResult.configOptions` +
>    `.slashCommands`）。
> 2. **`workspace-config` topic 会引入回归**：它的 CLI 种子 `buildLiveWorkspaceConfigStateV4`
>    （`bootstrap/src/acode-protocol/v4-workspace-config.ts:42-60`）在**无在册会话时返回 null**
>    （`:49` `if (!record) return null;`，注释明写「刻意不建 temporary app」）。而
>    `workspacePrepareRpc` 是**预热路径**（返回 `preparedSessionId: ""`，`:58`），调用时机正是
>    会话尚未建立之时。换成 topic 订阅会让预热拿到空目录——恰是它存在的理由被破坏。
>    且它是 conflated **订阅**，prepare 是**一次性读**，形态不匹配；UI 侧还需新建
>    transport+store（~1000 行）才能消费。
> 3. **mode 从来不是协议事实**：legacy `readWorkspacePresentation`
>    （`bootstrap/src/acode-protocol/workspace-model-runtime.ts:19-37`）**硬编码**
>    `mode: "build" as const`（`:26`），根本不读任何持久/运行态 mode。故「mode 的 v4 权威源」
>    这个提法本身不成立——它没有权威源，是个常量。
>
> **裁决**：不建 workspace-config 订阅库，不改用 modelSelectionService。正确修法是把
> `acodeWorkspacePresentationToConfigOptions` 这个**纯格式化函数**搬出投影桥（与 picker 工具
> 同一手法，提交 `eaa9d57a` 的先例），并改用 shared 的权威 helper——因为它现在**重复实现**了
> `packages/shared/src/acode-agent-model-state.ts:47-57` 的
> `normalizeAvailableACodeMode`/`getACodeAgentModeSelectOptions`，而且**两份已经漂移**：
>
> | | shared 权威（`acode-agent-model-state.ts:15-42`） | UI 桥本地副本（`acodeSessionProjection.ts:25-46`） |
> |---|---|---|
> | mode 档位 | build / edit / plan / yolo / **dontAsk**（5 个） | build / edit / plan / yolo（**4 个，缺 dontAsk**） |
>
> 后果是**潜在缺陷**：桥的 `normalizeAvailableACodeMode("dontAsk")` 因 `dontAsk` 不在其
> 4 元素集合内而**静默回落 `"build"`**（`acodeSessionProjection.ts:202-204`）。
> 实测该缺陷当前**不可见**：v4 composer 的 mode 选择器直接用 shared 的
> `getACodeAgentAvailableModes()`（`V4ComposerModeControls.tsx:62,78`，5 档含 dontAsk），
> 而桥的两个 config-options 函数一个零消费方、一个只服务预热路径且 mode 恒为常量 "build"。
> 但重复实现 + 已漂移 = 下次改档位仍会漏一处，故搬迁时必须改为引用 shared 单一事实源。
>
> **另需订正**：3 处注释（`useWorkflowSubagentModelProviderName.ts:11`、
> `subagent-model-label.ts:67`、`list-models.tsx:170`）把 `modelProviderName` 的
> `providerLabel ?? providerId` 回落行为归给 `acodeSessionSettingsToConfigOptions`——该函数
> **零运行时消费方**（实测）。真实权威是 shared 的
> `acodeSessionSettingsToACodeConfigOptions`（`acode-agent-model-state.ts:92`，同一表达式）。
> 桥里那份是它的重复副本。注释须改指真实权威，否则退役桥文件后 3 处引用悬空。

### M2 — services 双栈调用切换（可与 M1 并行）

- 内容：`acode-agent/` 6 文件的 legacy 方法调用逐个迁到 V4_METHODS；`acodeProtocolClient.ts` **保留为永久载体**（见下方订正与 `apps/acode-cli/specs/m2-prepare.md`）；`node.ts` 装配同步收口。
- 验收：`git grep -l "acodeProtocolMethods\." -- packages/services/src` 归零（只查 legacy **方法名常量**消费，不查客户端类——`acodeProtocolClient.ts` 是 legacy 与 v4 共用载体，M4 删 barrel 不删它）；services/desktop 测试绿。
- 风险（AGENTS.md 要求）：`desktop-continuous` 与 `web-remote-replayable` 两种语义必须同时验证——迁移触及 stream/snapshot/queue 时，本地窗口链路与手机远控恢复链路各跑一遍真实冒烟；owner/lease 与 stale run 防护不得因改名/换路径被绕过。

> **实测订正（2026-10-27，M2 启动前调研）**：本节的验收判据**结构性不可满足**，且「6 文件」
> 的口径含 3 个假阳性。逐条（全部源码核验）：
>
> **① `acodeProtocolClient.ts` 不是「legacy 客户端本体」，而是 legacy 与 v4 共用的版本无关
> JSON-RPC 传输载体——退役它会删掉 v4 的载体。** 证据：
> - `acodeProtocolClient.ts:19`：`type ACodeProtocolClientMethod = ACodeProtocolMethod | V4Method | ProviderDiagnosticsMethod;`
>   （方法名联合**已含 v4**）；`:12` import `V4Method`。
> - `acode-protocol-v4/transport.ts:370-371` 头注明写：「载体复用现有 JSON-RPC（stdio NDJSON /
>     socket），方法名带 v4/ 前缀与旧协议并存；**旧 session/\* 方法删除后，这里就是唯一协议面**」。
> - v4 方法确实经该 client 派发：`acodeAgentService.ts:1257,1803,1824,3890`（`V4_METHODS.networkCaptureSetEnabled`
>   / `conversationUnsubscribe` / `conversationResync` / `usageStats`）；`independentPlanSupport.ts:19`
>   经它调 `V4_METHODS.capabilitiesQuery`。
> - 单一构造点：`acodeAgentProcessManager.ts:1600` `new ACodeProtocolClient(transport, …)`。
>
> **② 因此验收 grep 只能靠改名归零**：`acodeProtocolClient` 这个名字必须在 M4 之后**继续存在**
> （它是唯一协议面的载体）。把它从 grep 里清零的唯一办法是重命名模块——那是**表面通过而非收敛**，
> 正是本节 M1 订正里谴责的失败形态。建议验收判据改为「services 内 legacy **方法**消费 = 0」，
> 并把 client 模块明确认定为永久载体。
>
> **③ 「6 文件」含 3 个假阳性**（被字符串匹配到，并非 legacy 方法消费方）：
> - `node.ts:108` 是 barrel re-export `export { ACodeProtocolClient } from "./acode-agent/acodeProtocolClient.js"`；
> - `acodeAgentProcessManager.ts:45` 只是 import 路径，**该文件 `acodeProtocolMethods.` 消费数实测 = 0**；
> - `acodeProtocolClient.ts` 命中自己的文件名。
> 真消费方只有 3 个：`acodeAgentService.ts`（**66** 个不同 legacy 方法）、
> `pluginReferenceCatalogRequest.ts`（2 个）、`independentPlanSupport.ts`（type-only）。
>
> **④ 68 个 legacy 方法里，0 个有干净的 v4 等价物**（`V4_METHODS` 实测 34 条 vs legacy
> `acodeProtocolMethods` 84 条）：
> - **54 个完全没有 v4 契约**——实测 `transport.ts` 对 plugins / mcp / skills / automation /
>   offPeak / workspace 写路径**零命中**。其中 15 个是 **inbound**（agent→host）handler
>   （`interactionRequestPermission`、`interactionRequestUserInput`、`automationCreate`、
>   `offPeakCreate`、`computerUseOperationEvent` 等），迁移是**两侧协议变更**：必须 CLI 先发
>   v4 形态请求，host 才能改 handler。permissions 尤其不是改名——v4 用 `pendingInteractions`
>   快照行 + `resolveInteraction` 命令**架构性替换**（`command.ts:201`），是 broker 重设计。
> - **14 个有部分 v4 面，但迁移会静默丢字段或收窄值域**（最危险，因为看起来可迁）：
>   `sessionCreate`→`createSession` 丢 `engine`/`persistence`/`importedHistory`/`toolAllowlist`
>   且返回从完整 snapshot 变 `CommandAck`；`sessionCompact`→`compact` 的 v4 payload 是
>   `z.object({})` **空的**，带不了 `instructions`；`sessionSetMode`→`switchCollaborationMode`
>   的 v4 值域**刻意排除 `auto`**（`index.ts:3529` 自己写着）；`sessionMessages`→`conversationRowsRange`
>   分页方向**相反**（legacy `afterMessageId` 前向 vs v4 `beforeRowId` 后向）；`sessionClose`→
>   `deleteSession` 语义不等价（close ≠ delete，且 legacy 断言 `expectedPersistence`）；
>   `sessionSend`→`sendText` 有 `toolDenylist`→`toolDisallowlist` 改名陷阱。
>   其中数个需先做**产品裁决**（`goal show`/`clear` 是否保留？`mode: auto` 是否保留？
>   close 与 delete 是否真是两个语义？）。
> - legacy 源码**自己记录了阻塞**：`index.ts:3543-3544` 对 `workspaceGenerateText` 写
>   「LLM 执行面在 CLI，直连不可行；消费仅 services 内部，**待 v4 workspace 查询/命令面
>   覆盖后移除**」。
>
> **⑤ 本节 2026-10-09 说明的「多数尚无 v4 契约」偏乐观**：对点名的那些家族是**全部 52 个**
> 没有，不是「多数」。唯一有 v4 存在的家族是 `session/*`，且每一条都是「部分等价 + 丢字段」。
>
> **结论**：M2 不是迁移，而是**多周到多月的协议扩展工程**——54 个方法要先按 spec-first 建
> v4 schema + CLI gateway 分支 + skew 安全分析；14 个部分等价项需先做产品裁决再迁；约 13 个
> 触及 stream/snapshot/queue/reconnect，按本节风险条必须跑双链路真实冒烟（headless 不可跑）；
> `sessionSubscribe` 还阻塞在 M1 上。**本轮不做 M2**；唯一诚实可推进的是把 type-only 消费方
> 从具体传输类解耦到中立接口叶子（见 2026-10-27 提交），它让 M2 完成时这两个文件无需再改，
> 但**不构成 M2 进度**（验收判据本身待重写）。

#### M2-0 — 验收判据重写（已落地，2026-10-28）

**裁决**：`acodeProtocolClient.ts` 是 legacy 与 v4 共用的版本无关 JSON-RPC 传输载体，M4 删 barrel 不删它。验收判据从「`acodeProtocolMethods|acodeProtocolClient` 归零」改为「`acodeProtocolMethods.` 归零」——只查 legacy **方法名常量**消费，豁免永久载体文件名。

**新验收判据**（已写入本节第 191 行）：
```bash
git grep -l "acodeProtocolMethods\." -- packages/services/src  # 必须归零
```

**现状基线**（2026-10-28 实测）：`acodeProtocolMethods.` 消费 **75 处 / 2 文件**（`acodeAgentService.ts` 73 + `pluginReferenceCatalogRequest.ts` 2）。

**接口抽离现状**：`acodeAgentRpcClient.ts` 中立接口叶子已就位（2026-10-27），`ACodeProtocolClient implements ACodeAgentRpcClient`。`acodeAgentService.ts` 中 20 处 `ACodeProtocolClient` 类型引用**架构上必须保留**——`wireClient` 需要 `onNotification`/`onRequest`/`onClose`/`respond` 等独有成员，无法换成中立接口。这不是未完成迁移，而是合理依赖。

**spec**：`apps/acode-cli/specs/m2-prepare.md`（含 M4 同步验收判据）。

#### M2-1 — session 配置三件套 + 产品裁决落地（已落地，2026-10-28）

**产品裁决**（orchestrator 默认裁决：保守无能力损失；**产品可推翻**；全文见 `docs/reviews/2026-10-28/m2-scoping.md` §6.3）：

1. **`mode:"auto"` 保留**：v4 `switchCollaborationMode` 值域补 `auto`（`acode-protocol-v4/command.ts`）——legacy `acodeSessionModeSchema` 含 auto 且有残留消费，v4 刻意排除会收窄 legacy 能力；补值 = 放宽，向后兼容（core `CollaborationMode` 本就含 auto）。
2. **`sessionCompact.instructions` 保留**：v4 `compact` 命令 payload 加可选 `instructions?: string`（原 `z.object({})`）。本批只落协议面；compact 消费迁移属 M2-2。
3. **`sessionClose` 与 `deleteSession` 两个真语义都保留**：close=终止/归档 snapshot 写入（保留 legacy `expectedPersistence` 断言语义），delete=删除；v4 侧补 `closeSession` op 属 M2-2。
4. 附加：`sessionDebug` 保留（M2-2 新建 v4 debug query）；`sessionEvents` 保持独立事件日志查询（不并入 conversation frame）；`workspaceGenerateText` 不直接退役（随 M2-8 workspace 域批次迁移）。

**迁移**：`acodeAgentService.ts` 的 `setModel`/`setThoughtLevel`/`setMode` 三处 facade 改经 v4 `command` op（`switchModelConfig`/`switchCollaborationMode`），ACK 后回读快照保持 facade 返回契约；`acodeProtocolMethods.` 消费实测 **75 → 72**（残余 1 处 `sessionSetThoughtLevel` 是 createSession 兼容重试，目标为不认识 thoughtLevel 的旧 Agent—— pre-v4，必须留 legacy）。CLI legacy dispatch 对消费已归零的 `sessionSetModel`/`sessionSetMode` 删注册（`server.ts` + `server-operations.ts`），`sessionSetThoughtLevel` 因兼容重试残余保留。

**冒烟**：本批三方法不在 §4 的 13 个 stream/snapshot/queue 高危名单；headless 环境未跑 desktop-continuous + web-remote-replayable 双链路真实冒烟（环境受限），以协议单测 + 既有套件全绿替代。

#### M2-B — shared schema 边界（已落地，2026-10-09）

v4 命令校验仍需要兼容的 MCP server 与 browser ambient context 载荷，但这些 schema
不能从 `packages/shared/src/acode-protocol/index.ts` 反向导入。两份 schema 已搬到
`packages/shared/src/acode-protocol-shared.ts`；legacy barrel 只重导出以保持现有
consumer API，v4 command 直接依赖中立模块。这样 M4 删除 legacy barrel 时，v4 不会
形成反向依赖或被迫回迁兼容 schema。

验收固定为两层：`apps/acode-cli/tests/architecture-coverage.test.mjs` 的 fixture 必须
拒绝 `acode-protocol-v4 → acode-protocol`，改为 `acode-protocol-shared` 后通过；同时
`packages/shared/src/acode-protocol-v4/command.ts` 的源码不得出现 legacy barrel import。
该 slice 不改变 wire schema、解析结果或 desktop-continuous / web-remote-replayable
传输语义。

### M3 — 删除 CLI legacy 协议 server（依赖 M2）

- 内容：删除 `bootstrap/src/acode-protocol/` 文件；`v4-bridge.ts` 的过渡钩子内联进 v4 gateway 后删除桥文件；services 作为对端已在 M2 切换，此步是纯删除。
- 验收：目录与桥文件删除；CLI 测试套件绿；`acode acp` 冒烟通过（ACP 面依赖 v4 gateway）；desktop 端到端冒烟（起窗口、跑一轮对话、恢复会话）。
- 风险：`server-operations.ts` 内如有仍被 v4 复用的纯函数，先搬进 v4 目录再删（依赖方向只允许旧 → v4，搬运不违反）。

> **实测订正（2026-10-27）**：本节三个计数已陈旧，且 M3 的「纯删除」前提是 M2 已完成——
> 而 M2 本轮已判定为多周协议扩展工程（见 M2 节订正），故 **M3 结构性阻塞，本轮不做**。
> - **目录规模 48 文件 → 50 文件 / 15,690 行**（U08 provider 诊断 `1ead67e2` 新增
>   `provider-diagnostics.ts` 352 行 + `provider-diagnostics-ports.ts` 79 行；已在进度表登记）。
> - **`server-operations.ts` 3,973 行 → 4,058 行**（legacy 面内既有演进微增）。
> - **CLI 测试基线「980」严重陈旧**：实测 `apps/acode-cli/tests/**/*.test.mjs` 现为
>   **3,151 个测试**（`node --import tsx --test` 实跑），M3 验收须以当前基线为准，不能用 980。
> - **v4-bridge 过渡钩子仍是 6 个**（`v4-bridge.ts:8-9` 头注列 ensureModelReady /
>   afterLegacyStateMutation / closeSession / createSessionRecord / child record registration /
>   resumePersistedSession，`:983,995,1001` 等注入点实测仍在）。
> - **阻塞证据（实测，非推断）**：legacy server 仍派发 services 侧仍在发的方法——
>   `server.ts` 对 `acodeProtocolMethods.pluginsList` / `sessionRead` / `mcpList` 各有 1 处
>   dispatch。删除 server 前必须先把 services 的 66 个 legacy 方法调用切到 v4（= M2）。
> - **「纯删除」是错误定性（2026-10-28 补，实测）**：`bootstrap/src/acode-protocol/server.ts`
>   （1,020 行）是**整个 agent 协议的唯一入口**——`acode-protocol-entrypoint.ts:349` 的
>   `handleMessage` 直接绑到 `ACodeProtocolAgentServer.handleMessage`，而该文件的同一个 switch
>   里既有 **59 个 `case acodeProtocolMethods.*`（legacy）也有 31 个 `case V4_METHODS.*`（v4）**
>   （含 `V4_METHODS.command` / `commandsQuery` / `usageStats` / `conversationUsage` 等，
>   其中 29 处经 `requireV4Gateway()` 转发进 v4-gateway）。`v4-gateway.ts`（3,500 行）自身
>   **不含任何 V4_METHODS dispatch**——它只是被 server.ts 调用的 handler 集合。
>   故即便 M2 把 services 侧全部切到 v4，M3 也**不能删掉 `acode-protocol/` 目录了事**：
>   v4 的方法分发与 wire 入口仍住在那里。M3 的真实内容是「把 v4 dispatch + entrypoint 装配
>   **搬到 v4 目录**，再删 legacy 残留」——是**搬迁**而非删除。这会影响 M3 的工作量与验收
>   口径（`acode acp` 与 desktop 端到端冒烟必须覆盖搬迁后的入口，不能只看目录消失）。
>   同一拓扑也解释了本轮 M1 调研为何把新 v4 冷读命令的落点选在 server.ts 而非 v4-gateway：
>   新增 v4 方法**当前只能**在那个 switch 里接线（除非同时做 M3 的搬迁）。

> **M3 已完成（2026-10-29，两段式落地；幸存面登记为 M3 完成形态的一部分，3 项待产品裁决）**：
> spec `apps/acode-cli/specs/m3-legacy-server-removal.md`（含裁决节 + §A.2 逐项核验），
> 实施记录 `docs/reviews/2026-10-29/m3-implementation.md`。
>
> - **启动核验（实施前快照）**：§A.2 九项前置实测 0 完全满足 / 2 部分 / 7 未满足，其中三项
>   硬阻塞经裁决落地（见下）。目录实施前为 **40 文件 / 14,161 行**（非旧档 50/15,690），
>   legacy `case` **12**、v4 `case` **76**。
> - **三项裁决（保守无能力损失默认，标注产品可推翻）**：
>   ① `sessionSubagents` 幸存（v4 无 subagents 分页 query；UI 两面板依赖）；
>   ② `pluginsCancelOperation` 幸存（不推翻 M2-5 §4，shared 不动）；
>   ③ `sessionSend` 附件回退幸存（v4 sendText 只收 attachmentRef，宿主发送侧上传/寄存面未建模）。
>   验收判据随之重写为「除 spec 登记的幸存清单外归零」。
> - **搬迁段**：40 文件整目录迁入 `acode-protocol-v4/`（仅 `v4-bridge.ts → v4-binder.ts` 改名），
>   **25 条 v4→legacy 反向 import 全部解除**；`server.ts` 的 76 个 v4 case + dispatch 装配随迁；
>   entrypoint 只装 v4 server；`transport.ts` 迁 v4 侧。搬迁段测试 3,206 pass / 0 fail。
> - **钩子收编**：6 个过渡钩子收编为 `V4CommandCoreHost`/`V4GatewayHost` 的**必填原生宿主能力**
>   （`ensureModelReady` / `afterLegacyStateMutation` / `closeSession` / `createSessionRecord` /
>   `createSelectionSideSession` / `resumePersistedSession`），执行面在 `v4-binder.ts` 调同目录
>   `session-operations.js`。结构性说明：handler 仅持窄视图（record + host）、无 context 通道，
>   字段保留为必填原生能力而非字面删除——字面删除需重设计 handler 的 context 访问，超出 M3 范围。
> - **删除段**：删 9 个非幸存 legacy case + 对应死 op 函数与级联 helper（`server-operations.ts`
>   3,639 → 3,438 行）+ services catalog 回落链 + transport 的 legacy `sessionStop` 旁路；
>   **`bootstrap/src/acode-protocol/` 目录已删除**，`v4-bridge.ts` 已删除。
> - **终态证据**：CLI `tests 3243 / pass 3206 / fail 0 / skip 37`；services `578/0/7`；
>   bootstrap/cli/cli-workflow/services 四包 `tsc --noEmit` 各 exit 0；
>   `architecture:check --changed` new 0 / regrown 0；`acode --help` 与 `acp`（stdin EOF）冒烟不崩。
> - **幸存清单（M3 完成形态的一部分，3 项待产品裁决）**：`session/subagents`、
>   `plugins/cancelOperation`、`session/send`（附件回退）——终态 grep：
>   services `acodeProtocolMethods.` = 4（全在幸存清单），bootstrap legacy case = 3。
> - **遗留（不阻塞 M3）**：host 侧 17 条 inbound legacy 字面量分支（`acodeAgentService.ts`
>   偏斜期兜底）本批未动，与 CLI 侧 inbound 端口的 `-32601` 回落发送器同属独立偏斜面，
>   建议后续单独裁决；`afterLegacyStateMutation` 的 `state.updated` legacy 广播面未删
>   （services 仍消费）；`packages/ui/src/store/scriptWorkflowStore.ts:109` 一处注释仍引用
>   旧 `v4-bridge.ts` 路径（并发 UI 代理范围，未动）。
> - **台账**：`markdown-table.tsx` 漂移 1 项来自并发 UI 代理，非 M3；交 CI Linux 回补。
>   `.architecture-baseline.json` 定点收窄：删 7 条 `acode-protocol/*` 旧路径条目、加 6 条
>   `acode-protocol-v4/*` 新路径条目（复用仓库 fingerprint 算法，实测复算一致）。

### M4 — 删除 shared legacy 协议文件（依赖 M1+M2+M3）

- 内容：整删 `packages/shared/src/acode-protocol/index.ts`；甄别 `acode-protocol-legacy-types.ts` 承重类型（迁 v4 或独立命名保留）；同步清理 legacy 词表残留 schema。**`packages/services/src/acode-agent/acodeProtocolClient.ts` 保留**——它是 legacy 与 v4 共用的版本无关 JSON-RPC 传输载体（见 M2-0 裁决与 `apps/acode-cli/specs/m2-prepare.md`），M4 删 barrel 不删它。
- 头注既有约束：「外部零消费 schema 多为存活 schema 联合的内部依赖，随宿主文件一起处理，勿单删」——删除以文件为单位，不做单导出抠除。
- 验收：文件删除；全仓 typecheck + 全部测试绿；knip exports backlog 相应缩减；AGENTS.md 协议条目移除 legacy 文件引用。新增：`git grep "acodeProtocolMethods" -- packages/shared/src` 归零（符号已删）；`git grep "acodeProtocolMethods\." -- packages/services/src` 归零（消费已清，M2 已达成）。

> **实测订正（2026-10-27）**：barrel 行数 **3,714 → 3,652**（2026-10-26 列已记；−2 是
> R2-02 schema 外移所致，非退役）。**阻塞证据（实测）**：`acodeProtocolMethods` 在
> `packages/services/src` 与 `bootstrap/src/acode-protocol/` 内仍有 **12 个活跃消费文件**，
> 故 barrel 不可删。M4 依赖链 M1+M2+M3 三条全部未达成（M1 缺 v4 承接面、M2 缺 v4 契约、
> M3 依赖 M2），**本轮不做**。另需注意：barrel 同时被 `onboard-b3-shared-over-limit` /
> `-disables` 两条 `expires: "2026-12-31"` 架构例外覆盖（见本文 deadline 节订正），
> 到期未删会让架构门禁**转红**，故 M4 是硬 deadline 项而非可无限延期的债务。

> **M4 启动前置核验（2026-10-29，M3 完成后实测）：不满足，未执行删除。**
> 依据 `docs/reviews/2026-10-28/m3-m4-w2-dependencies.md` §A.2 checklist 逐项核验，
> **0 项完全满足 / 1 项部分 / 5 项未满足**。spec `apps/acode-cli/specs/m4-shared-barrel-removal.md`
> （含 §0 四项裁决、§2 消费面盘点、§3 checklist、§5 结构阻塞）。
>
> - **消费面实测（AST 级扫描，非 grep）**：barrel 导出面 **464 名**
>   （449 本地 + 15 具名 re-export + 3 `export *`），被 **139 个生产文件 + 11 个测试文件**
>   消费 **196 名**；零外部消费 268 名，但其中 118 个是消费闭包的**传递依赖**，
>   **真正可直接删的只有 142 语句 / 688 行**（−19%，3,652 → 约 2,964 行）。
> - **三向归类**：A 类（v4 有等价物）**89 符号 / 72 生产文件**；B 类（M3 幸存三词闭包）
>   **11 符号 / 13 生产文件**；**D 类（无 v4 等价物、非幸存）89 符号 / 75 生产文件，
>   其中 38 个有运行时消费 / 30 个生产文件**——这是 M4 的真实主体。
> - **四条活链路（结构性阻塞）**：
>   ① **NDJSON RPC 信封 schema 只存在于 barrel**——v4 `wire.ts` 只有 `TopicWireFrame`
>   物理分片，没有 `{id,method,params}` 信封；消费方 bootstrap `transport.ts:9,236`、
>   services `acodeStdioTransport.ts:5,250`、`server-types.ts:223-240` 四个类型守卫。
>   ② **存储启动控制面**（`acodeStorageStartupStateSchema` / preparation frame）v4 目录零命中；
>   消费方含 desktop `storagePreparationProcesses.ts`。
>   ③ **session 投影/事件**（`ACodeSessionStateSnapshot` 14 生产文件、
>   `ACodeSessionEvent` 26 变体 union）与 v4 `conversationSnapshotSchema` **形状不等价**
>   （缺 4 个身份字段，M1 订正已实测）；m2-3 §2.6 已把该 schema 居所显式推给 M4。
>   ④ **inbound 交互 params** 在 v4 是「逐字重复声明」而非同源。
> - **legacy-types 甄别订正**：被 v4 消费的符号实测 **10 个 / 15 个 v4 文件**
>   （旧档记 6 个 / 4 文件）；`protocol-boundary.mjs` 白名单登记 11 个，其中
>   `acodeMessageWithPartsSchema` **无任何 v4 importer**（应收窄）。闭包 36 符号 / 约 465 行。
> - **验收判据重写（裁决 A）**：从「`acodeProtocolMethods` 符号名归零」改为
>   「符号面归零 + **幸存三词 wire 字面量收敛到最小登记模块**」——
>   因为 M3 §0 保留的三词两侧都必须认识，符号名在 M4 完成时仍会出现。
>   新判据见 spec §0 裁决 A（五条命令）。
> - **台账订正**：barrel **不在** `third-party/inventory.json` 的 inputs 内
>   （`packages/shared/src` 下仅登记 `acode-protocol-v4/wire-codec.ts`），删 barrel
>   不产生台账漂移。
> - **分段建议**：M4 拆成 **M4a**（删零消费语句 + 存储/telemetry/session 面迁中立叶或幸存面 +
>   删 barrel/目录 + policy 同步）与 **M4b**（新建 v4 NDJSON 信封 schema——**协议扩展工程**，
>   与 M2 同性质）。详见 spec §6 与实施报告 `docs/reviews/2026-10-29/m4-implementation.md`。

> **M4a 已完成（2026-10-29，四段落地；M4b 登记为协议扩展开放项）**：
> spec `apps/acode-cli/specs/m4-shared-barrel-removal.md`（裁决 A–E 全落档），
> 实施记录 `docs/reviews/2026-10-29/m4-implementation.md`（已改写为终态版）。
>
> - **裁决 E（本批新增，产品可推翻）**：NDJSON 信封按 M2-0 对 `acodeProtocolClient` 的
>   载体先例定性为**版本无关 wire 载体面（永久，非 legacy 债务）**，迁
>   `acode-protocol-envelope.ts`——启动前置核验的结构性阻塞①据此不构成删除阻塞；
>   ②③④ 同理按「迁 v4 或独立命名」口径处置（存储启动面 → `acode-storage-startup.ts`；
>   session 投影/事件 → `acode-session-*` 中立叶族，形状一律不改；inbound params 以 v4 为唯一真源）。
> - **删除**：barrel `acode-protocol/index.ts` 3,652 行 + `acode-protocol-legacy-types.ts` 607 行
>   整删，`packages/shared/src/acode-protocol/` 目录消失；freeze 测试 + 2 份基线 JSON 随删
>   （使命终结）；零消费 142 语句（688 行）随迁删。
> - **收编**：承重面进 14 个有意命名中立模块（合计 2,298 行），其中 legacy 语义面仅
>   `legacy-survivors`（154 行，M3 幸存三词，头注含逐词移除条件）+ `legacy-skew`（41 行，
>   偏斜回落词登记）；其余为载体面/中立命名面。A 类 107 符号 117 消费文件切 v4；
>   `acodeProtocolClient` 类型联合收窄（裁决 B）。
> - **守护**：protocol-boundary 白名单收窄并转 tombstone（复活式引用 fail-closed）；
>   harness-api 红线逐文件登记（1 删 + 15 改）；policy 4 条 paths 定点删；6 测试锚点改指。
> - **终态判据（裁决 A 口径）实测**：`acodeProtocolMethods.`/`acodeProtocolNotifications`
>   代码零命中；barrel 路径仅存历史注释/fixture/红线登记；根入口 re-export 已切中立模块。
> - **门禁**：typecheck exit 0；lint 163w/0e；architecture new 0 / regrown 0；台账
>   **2904 项全符零漂移**（证实前置核验的台账订正）；全仓测试结果见实施记录 §6。
> - **M4b 开放项**：v4 原生信封建模 + `conversationSnapshotSchema` 4 身份字段缺口——
>   协议扩展工程（与 M2 同性质），需双链路冒烟环境前置，待产品/工程排期。
>   M3 遗留偏斜面（host 侧 17 条 inbound 字面量分支、`state.updated` 广播）仍独立待裁决。

## 进度指标（每次发布级验证时更新）

| 指标                                | 2026-10-05 基线 | 2026-10-09 实测                                                         | 2026-10-26 实测                                                              | 目标    |
| ----------------------------------- | --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------- |
| services legacy 消费文件数          | 7               | 6（independentPlanSupport 已切 v4，仅剩 type-only 引用）                | 6（未推进；`acodeProtocolClient.ts` 仍在，independentPlanSupport 仍 type-only）→ **2026-10-29：M2+M3 后 1 文件 / 4 处**（仅 `acodeAgentService.ts`，全部属 M3 幸存清单登记项、待产品裁决；`pluginReferenceCatalogRequest.ts` 2 处 -32601 回落已删） | 0（M2）（幸存 4 处除外） |
| UI 旧投影消费文件数                 | 8               | 10（新增 v4/composer 两处 `parseModelPickerValue` 消费，M1 需一并迁移） | 12（未降反增：新增 settings/SubagentModelBatch{Bar,Dialog} 两处消费）→ **2026-10-28：M1 完成——桥已退役，真实 import = 0**（含 mode 来源裁决，见 M1 节） | 0（M1）✅ |
| bootstrap legacy server 文件数/行数 | 48 / 14,713     | 48（M3 未启动）                                                         | 48 / 15,188（M3 未启动；行数因 legacy 面内既有演进微增）→ **2026-10-27 订正：50 / 15,690**（U08 `1ead67e2` 新增 2 文件，见下）→ **2026-10-29 实测：40 / 14,161**（M2 `caa38080` 删 11 文件）→ **2026-10-29：0 / 0（M3 已完成，目录整体删除）** | 0（M3）✅ |
| shared legacy 协议文件行数          | 3,714           | 3,662（M2-B 已外移 MCP/browser schema 至 acode-protocol-shared）        | 3,652（barrel −2，仅 R2-02 schema 外移所致，非退役；legacy-types 607 行）→ **2026-10-29 实测：barrel 3,652 + legacy-types 607（未推进；前置 checklist 0/6 满足，见下「M4 启动前置核验」）→ 2026-10-29：0（M4a 已完成——barrel + legacy-types 整删；承重面收编 14 个中立模块 2,298 行，其中 legacy 语义面仅 survivors 154 + skew 41 = 195 行登记在案）** | 0（M4）✅（M4b 开放） |
| v4-bridge 过渡钩子数                | 6（见桥头注）   | 6                                                                       | 6（M3 未启动，桥头注仍列 6 个钩子）→ **2026-10-29：0（M3 已完成——6 钩子收编为 `V4CommandCoreHost`/`V4GatewayHost` 必填宿主能力，`v4-bridge.ts` 删除，执行面迁 `v4-binder.ts`）** | 0（M3）✅ |

**2026-10-26 状态说明（1.0.4 周期）**：本轮**未推进任何退役里程碑**（M1–M4 全部停滞；M1 的 UI 消费面
未降反增 8→10→12）。**冻结纪律保持**：barrel 本地导出面精确守护——schema 定义基线 **246** 与当前精确
相等（0 增 0 删），并已扩展机械守护到**全部本地导出名 449**（`export const/function/type/…`，含此前未守护的
`acodeProtocolMethods`/`acodeProtocolNotifications` 与 189 个 `export type`），冻结日以来零新违规（详见
`packages/shared/specs/legacy-protocol-freeze.md`「守护门禁」）。测量口径与上表一致：services 用
`git grep -l "acodeProtocolMethods\|acodeProtocolClient" -- packages/services/src`（=6）；UI 用
`git grep -l "acodeSessionProjection" -- packages/ui/src`（=12）。注：`docs/reviews/2026-10-26/shared-protocol.md`
报告的「18」是更宽口径（UI 12 + `packages/shared` 内 6 个引用点，含 barrel 定义本体、spec 与基线 JSON，
非全部为消费方），方向与本表一致——消费面未收敛。

**M1 UI 投影收口进展（2026-10-28）**：投影桥 `packages/ui/src/lib/acodeSessionProjection.ts`
（272 行，5 导出）已**整体退役删除**。5 个导出的去向：
- `parseModelPickerValue` / `formatModelPickerValue`（纯字符串工具，10 个消费方）→ 搬到
  `lib/modelPickerValue.ts`（提交 `eaa9d57a`）。
- `acodeWorkspacePresentationToConfigOptions`（1 个消费方 workspacePrepareRpc）→ 搬到
  `lib/workspaceModeConfigOptions.ts`，改用 shared 权威 mode 档位表（提交 `07057d79`；
  顺带修掉桥里 4 档副本缺 dontAsk 的漂移）。
- `acodeSessionSnapshotToTaskMeta`（1 个消费方 useActiveTaskSnapshotMeta）→ 由 v4 归档冷读
  `v4/session/headerMeta` + `v4/mapSessionHeaderMetaToTaskMeta.ts` 替代（提交 `d6cfe2c6`/`d833a776`/`d1bcf9f9`）。
- `acodeSessionSettingsToConfigOptions`（**零运行时消费方**，是 shared
  `acodeSessionSettingsToACodeConfigOptions` 的死副本）→ 随桥删除。

**真实 import 计数 11 → 0**（`git grep -l 'from "@/lib/acodeSessionProjection' -- packages/ui/src`）。

**验收口径（2026-10-28 裁决，用户确认）**：M1 的收口判据从「grep 归零」改为**「零 import」**。
原判据 `git grep acodeSessionProjection -- packages/ui/src` 无法归零——它现报 **3 个文件**
（useActiveTaskSnapshotMeta.ts / modelPickerValue.ts / workspaceModeConfigOptions.ts），全部是
**来历说明注释**（记录「这函数原住哪、为什么搬」），零 import。删掉这些注释可让字面 grep 归零，
但会损失「为什么在这里」的上下文，得不偿失。故判据改为：

```
git grep 'from "@/lib/acodeSessionProjection' -- packages/ui/src   # 现 = 0，退出码 1（无匹配）
```

本文件 §M1 的「验收」行、`docs/upgrades/runtime-and-protocol-2026-10.md` 的 M1 数量门禁行、
以及本进度表 UI 行均已按此裁决更新。保留 3 处来历注释。

**M1 UI 侧到此完成，M1 整体也已标记完成（2026-10-28 终态）**：legacy **协议**读路径
`readWorkspacePresentation` 仍在被 workspacePrepareRpc 使用，但**只取 slashCommands**
——`mode` 字段经实测硬编码 `"build"`（`workspace-model-runtime.ts:26`），不是协议事实，
UI 已改为不采信（`packages/ui/specs/workspace-prepare-mode-source.md` 裁决 + spec 化）。
slashCommands 的协议切换属 **M2/M4**（协议退役），不是 M1（UI 投影桥收口）——两者是不同里程碑。
原阻塞「预热期 mode 目录从哪来」是个伪问题（mode 无权威源，本来就是常量），已通过
「接受 mode 是常量」裁决解除。

**bootstrap legacy server 增量登记（2026-10-27）**：M3 待删目录 `bootstrap/src/acode-protocol/` 自 1.0.4 后由 48 增至 **50 文件 / 15,690 行**——U08 provider 诊断（提交 `1ead67e2`）新增 `provider-diagnostics.ts`（352 行）
与 `provider-diagnostics-ports.ts`（79 行）。**这不违反 shared barrel 冻结纪律**：新方法名 `PROVIDER_DIAGNOSTICS_METHODS`
定义在中立叶子 `packages/shared/src/providerDiagnostics.ts:269`（不在冻结 barrel 内），schema 亦在中立叶子；
载体选 bootstrap 协议层是 spec 明确裁决（`packages/services/specs/provider-diagnostics.md:238`「已评估并否决的
载体方案」表：core 层无 `@acode/adapters` 依赖、拿不到 `runProviderDoctor`，故落 bootstrap——它已依赖 adapters
且已是协议适配装配点）。**但需如实登记两点后果**：① 现有冻结守护只覆盖 `acode-protocol/index.ts` 的导出面，
**不拦截新表面落进 bootstrap legacy server 目录**，故这 2 文件对门禁不可见；② M3（删 bootstrap legacy server）
的删除范围因此**增大** 2 文件，且这 2 文件派发的 2 个新 legacy 方法（`server.ts:710-713`）M3 需一并处理——
legacy 债务在「冻结」名义下仍在净增。建议：M3 启动前把 provider 诊断的派发迁到 v4 gateway（其中立 schema
已就绪，只差 v4 method 与 gateway 分支），避免把新表面焊进待删目录。此为登记项，非本轮改动。

> **2026-12-31 例外 deadline（约 9 周）**：M4（删 shared legacy barrel）被停滞的 M2/M3 阻塞，落在通往该
> deadline 的关键路径上。**shared 层同样携带 `expires` 绊线**（2026-10-27 订正，见下），故 barrel 到期未删
> 会直接令架构门禁转红，不存在「shared 无本地绊线」的缓冲。到期前这些白名单必须见底；若 M2/M3 持续停滞，
> legacy 退役将无缓冲地撞上该 deadline。本轮只刷新测量与状态，不重构计划、不新增里程碑。
>
> **订正（2026-10-27）**：本节此前断言「shared 层**不携带**本地 `expires` 绊线（barrel 用
> `oxlint-disable max-lines` 头注，非架构例外）」，经逐行核验为**事实错误**，混淆了两套互不替代的机制：
>
> 1. **barrel 确实在架构例外的 paths 列表内**——`onboard-b3-shared-over-limit`
>    （`architecture-policy.yaml:570`，`rule: max-file-lines`，`expires: "2026-12-31"`）于 `:585` 显式列出
>    `packages/shared/src/acode-protocol/index.ts`；`onboard-b3-shared-disables`（`:602`，`rule: disable-count`，
>    `expires: "2026-12-31"`）于 `:611` 同样列出它。即 barrel 被**两条**到期例外覆盖。
> 2. **`oxlint-disable max-lines` 头注（`index.ts:6`）是 lint 关注点，不替代架构例外**：barrel 3652 物理行
>    vs 全局 `maxFileLines: 400`（`architecture-policy.yaml:334`），靠的正是上述 `max-file-lines` 例外。
> 3. **到期确会转红**：`scripts/architecture/index.mjs:75-88` 遍历 `policy.exceptions`，当
>    `exception.expires < today` 时压入 `rule: "expired-exception"`、`global: true` 的违规（严格 `<`，故
>    2027-01-01 起触发）。
> 4. **42 条 `expires: "2026-12-31"` 的层分布订正**：`grep -c` 总数 42 准确，但其中 **2 条在 shared**
>    （`onboard-b3-shared-over-limit` / `-disables`）、2 条在 server（`onboard-b3-server-*`）、其余在
>    services/session 等层——原文「位于 services/session 等层」低估了 shared 的到期暴露面。
>
> 结论：原文方向性错误——shared 不是「无绊线的缓冲区」，而是与 services/session 同样受 2026-12-31 硬约束。
> 该错误会让人误判 M4 停滞的后果（以为只是计划滑期，实为门禁转红）。

2026-10-09 说明：本批只落地 M2-B（shared schema 边界）与 `v4/capabilities/query` 最小切片；
其余 legacy 调用（plugins/mcp/skills/workflows hub/automation/offPeak/provider/workspace 写路径与
inbound interaction 处理）多数尚无 v4 契约，迁移前需先按「新命令只进 v4」扩展协议面并满足
desktop-continuous / web-remote-replayable 双链路真实冒烟验收，继续按批次推进。
