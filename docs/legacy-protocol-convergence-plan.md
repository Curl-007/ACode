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
- `acode-agent/acodeProtocolClient.ts`（legacy 客户端本体）
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

### M1 — UI 旧投影收口（可与 M2 并行）

- 内容：UI 消费文件从 `acodeSessionProjection` 读路径迁到 v4 snapshot/query 投影。
- 验收：`git grep acodeSessionProjection -- packages/ui/src` 归零；`pnpm --filter @acode/ui test` 绿。
- 风险：SessionPane.tsx 本身是上帝组件（带 max-lines 豁免），改动面大；迁移时不得顺手重构，只换投影读路径。

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
>      subscribe-only）**加** `ConversationSnapshot → ACodeTaskMeta` 映射器（全仓零命中）。
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
> 违反本仓「不假装完成」纪律。**本轮不做 M1**；正确顺序是先补 UI 侧测试与两处 v4 承接面
> （归档单会话冷读 + TaskMeta 映射器、UI workspace-config 消费），再迁投影读路径。

### M2 — services 双栈调用切换（可与 M1 并行）

- 内容：`acode-agent/` 6 文件的 legacy 方法调用逐个迁到 V4_METHODS；`acodeProtocolClient.ts` 退役；`node.ts` 装配同步收口。
- 验收：`git grep -l "acodeProtocolMethods\|acodeProtocolClient" -- packages/services/src` 归零；services/desktop 测试绿。
- 风险（AGENTS.md 要求）：`desktop-continuous` 与 `web-remote-replayable` 两种语义必须同时验证——迁移触及 stream/snapshot/queue 时，本地窗口链路与手机远控恢复链路各跑一遍真实冒烟；owner/lease 与 stale run 防护不得因改名/换路径被绕过。

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

- 内容：删除 `bootstrap/src/acode-protocol/` 48 文件；`v4-bridge.ts` 的过渡钩子内联进 v4 gateway 后删除桥文件；services 作为对端已在 M2 切换，此步是纯删除。
- 验收：目录与桥文件删除；CLI 测试套件绿（当前基线 980）；`acode acp` 冒烟通过（ACP 面依赖 v4 gateway）；desktop 端到端冒烟（起窗口、跑一轮对话、恢复会话）。
- 风险：`server-operations.ts`（3,973 行）内如有仍被 v4 复用的纯函数，先搬进 v4 目录再删（依赖方向只允许旧 → v4，搬运不违反）。

### M4 — 删除 shared legacy 协议文件（依赖 M1+M2+M3）

- 内容：整删 `packages/shared/src/acode-protocol/index.ts`（3,714 行）；甄别 `acode-protocol-legacy-types.ts` 承重类型（迁 v4 或独立命名保留）；同步清理 legacy 词表残留 schema。
- 头注既有约束：「外部零消费 schema 多为存活 schema 联合的内部依赖，随宿主文件一起处理，勿单删」——删除以文件为单位，不做单导出抠除。
- 验收：文件删除；全仓 typecheck + 全部测试绿；knip exports backlog 相应缩减；AGENTS.md 协议条目移除 legacy 文件引用。

## 进度指标（每次发布级验证时更新）

| 指标                                | 2026-10-05 基线 | 2026-10-09 实测                                                         | 2026-10-26 实测                                                              | 目标    |
| ----------------------------------- | --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------- |
| services legacy 消费文件数          | 7               | 6（independentPlanSupport 已切 v4，仅剩 type-only 引用）                | 6（未推进；`acodeProtocolClient.ts` 仍在，independentPlanSupport 仍 type-only） | 0（M2） |
| UI 旧投影消费文件数                 | 8               | 10（新增 v4/composer 两处 `parseModelPickerValue` 消费，M1 需一并迁移） | 12（未降反增：新增 settings/SubagentModelBatch{Bar,Dialog} 两处消费）         | 0（M1） |
| bootstrap legacy server 文件数/行数 | 48 / 14,713     | 48（M3 未启动）                                                         | 48 / 15,188（M3 未启动；行数因 legacy 面内既有演进微增）→ **2026-10-27 订正：50 / 15,690**（U08 `1ead67e2` 新增 2 文件，见下）| 0（M3） |
| shared legacy 协议文件行数          | 3,714           | 3,662（M2-B 已外移 MCP/browser schema 至 acode-protocol-shared）        | 3,652（barrel −2，仅 R2-02 schema 外移所致，非退役；legacy-types 607 行）    | 0（M4） |
| v4-bridge 过渡钩子数                | 6（见桥头注）   | 6                                                                       | 6（M3 未启动，桥头注仍列 6 个钩子）                                          | 0（M3） |

**2026-10-26 状态说明（1.0.4 周期）**：本轮**未推进任何退役里程碑**（M1–M4 全部停滞；M1 的 UI 消费面
未降反增 8→10→12）。**冻结纪律保持**：barrel 本地导出面精确守护——schema 定义基线 **246** 与当前精确
相等（0 增 0 删），并已扩展机械守护到**全部本地导出名 449**（`export const/function/type/…`，含此前未守护的
`acodeProtocolMethods`/`acodeProtocolNotifications` 与 189 个 `export type`），冻结日以来零新违规（详见
`packages/shared/specs/legacy-protocol-freeze.md`「守护门禁」）。测量口径与上表一致：services 用
`git grep -l "acodeProtocolMethods\|acodeProtocolClient" -- packages/services/src`（=6）；UI 用
`git grep -l "acodeSessionProjection" -- packages/ui/src`（=12）。注：`docs/reviews/2026-10-26/shared-protocol.md`
报告的「18」是更宽口径（UI 12 + `packages/shared` 内 6 个引用点，含 barrel 定义本体、spec 与基线 JSON，
非全部为消费方），方向与本表一致——消费面未收敛。

**bootstrap legacy server 增量登记（2026-10-27）**：M3 待删目录 `bootstrap/src/acode-protocol/` 自 1.0.4 后
由 48 增至 **50 文件 / 15,690 行**——U08 provider 诊断（提交 `1ead67e2`）新增 `provider-diagnostics.ts`（352 行）
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
