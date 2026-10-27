# v4 归档会话 header 冷读（`v4/session/headerMeta`）

> 状态：**已实施**（2026-10-28）。本 spec 是 legacy M1 的前置件之一。
> 关联：[../../docs/legacy-protocol-convergence-plan.md](../../../docs/legacy-protocol-convergence-plan.md) M1 节订正、
> [../../packages/ui/specs/](../../../packages/ui/specs/) 的会话投影消费面。

## 1. 问题与背景

UI 的 `hooks/useActiveTaskSnapshotMeta.ts` 为**当前激活任务**提供一层 header 兜底：归档任务不在
`sessions-index` / taskListCache 数据源里（v4 侧 `includeArchived: false`，见
`bootstrap/src/acode-protocol/v4-bridge.ts:1341`），直接打开时只有列表元数据拿不到标题、
provider、traceId。它现在经 **legacy** `readSession`（`acodeProtocolMethods.sessionRead`）取
`ACodeSessionStateSnapshot`，再用 `acodeSessionSnapshotToTaskMeta` 投影。

这条读路径是 legacy M1 的两个真消费方之一，而 v4 侧**没有等价的一次性冷读**：
`V4_METHODS` 只有 subscribe 形态（`conversationSubscribe`）与窄查询（`usageStats` /
`conversationUsage` / `conversationRowsRange`），无「按 sessionId 取一份 header 元数据」的方法。

### 1.1 为什么不能用 `ConversationSnapshot` 直接充当响应

实施期实测推翻了调研阶段的设想（原以为建个「`ConversationSnapshot → ACodeTaskMeta` 映射器」即可）：

- `ACodeTaskMeta` 有 **7 个必填字段**：`taskId` / `traceId` / `title` / `workspacePath` /
  `createdAt` / `updatedAt` / `mode`；
- `conversationSnapshotSchema`（`packages/shared/src/acode-protocol-v4/snapshot.ts:524-560`）的
  **顶层**字段是 `protocolVersion` / `sessionId` / `logEpoch` / `seq` / `revision` / `control` /
  `availability` / `inputRouting` / `meta` / `config` / `modelTransition` / `usage` / `queue` /
  `pendingInteractions` / `pendingCommands` / `backgroundWorks` / `subagents` / `workflowRuns` /
  `swarmPlan` / `pluginStates` / `goal` / `plan` / `workspaceHookAdmission` /
  `composerTurnMetrics` / `sessionToolStats` / `rows`——
  **`traceId` / `workspacePath` / `createdAt` / `updatedAt` 四个身份字段根本不存在**。

即快照只能供出 7 个必填里的 4 个（`title`←`meta.title`、`mode`/`model`/`thought`←`config`、
`status`/`lastError`←`control`、`taskId`←`sessionId`）。**裸快照无法构造合法 TaskMeta**。
旁证：既有同类映射 `packages/ui/src/v4/mapSessionSummaryToTaskMeta.ts` 也必须靠
`options.workspacePath` 与 `previous?.traceId` **外部注入**这四个字段——`SessionSummary`
同样不带它们。

故响应设计为**身份信封 + 投影字段的合成体**（下称 header meta），不返回裸快照。

### 1.2 消费面的真实宽度（决定 schema 的窄口径）

实测 `useWorkspaceActiveTaskState.ts`：渲染只读 5 个字段（`taskId` / `traceId` / `title` /
`provider` / `forkedFromTaskId`），但 `areResolvedTaskMetasEqual`（`:31-55`）按**全部 15 个**
字段做等价判定以稳定 memo 引用。故响应必须足以构造一个**完整且稳定**的 `ACodeTaskMeta`，
不能只回 5 个字段——否则每次刷新都判不等，header 会连续重渲。

## 2. 产品规则

- **R1 只读、无状态、超时重发安全**：与 `usageStats` / `conversationUsage` 同族（一次请求一次
  响应，不建订阅、不改任何状态、不产生副作用）。可安全重发。
- **R2 不激活**会话**运行时**（精确到层级，实施期实测修正）：
  本仓有两个不同层级的「激活」，混为一谈会让本条规则失真：
  - **workspace 级 agent 进程**：session 库活在 CLI agent 子进程内，任何读都必须经它。
    `processManager.getClient(params)` 按 **workspaceKey** 取（`acodeAgentProcessManager.ts:1041-1045`：
    已有未 killed 的进程即复用），**不是**按 session。故本方法与 legacy `readSession` 一样
    需要 workspace agent 进程在场（复用既有、否则启动）——这层**不可避免也不应避免**，
    否则读不到库。
  - **session 级运行时/会话记录**：legacy `readSession` 经 `requireSession`
    （`acode-protocol/server-types.ts:344-368`）要求 `context.sessions` 里有 live record，
    缺席即抛 `sessionUnavailable`；而 live record 的建立伴随会话激活。**本方法不走这条路**：
    只用 `sessionStore.getSession` / `readTarget` / `sessionEntries` 读持久层，
    不建 session record、不进 `context.sessions`、不触发 `activateSessionForResume`。
  - 也**不用** `getReadOnlyClient(params, "existing-only")`：那个分支在无进程时抛
    `createRuntimeUnavailableError`（`acodeAgentService.ts:3228-3230`），会让归档兜底读在
    workspace 进程未起时直接失败——而归档任务恰恰是「进程可能已回收」的典型场景。
  - 一句话：**workspace 进程按需复用/启动（与 legacy 同）；session 运行时零激活（与 legacy 不同）**。
- **R3 归档会话必须可读**：本方法的存在理由就是归档任务不在任何实时数据源里。故不得要求
  session 处于 active 状态；`requireSession`（会因 `context.sessions.get` 缺席而抛
  `sessionUnavailable`，见 `acode-protocol/server-types.ts:344-368`）**不适用**于本路径。
- **R4 会话不存在时的错误形态**：持久层查无此 sessionId → 返回结构化 `notFound`，
  **不抛协议错误**。理由：UI 侧 `taskMetaFromLists` 缺席 + 归档 ID 可能已被清理是正常竞态
  （现有实现的 `.catch(() => setSnapshotMeta(null))` 就是这个语义），用错误码表达会让正常
  竞态在日志里刷 warn。
- **R5 不伪造缺失事实**：`traceId` 缺失时**不生成新 UUID**（legacy 投影用
  `generateTraceId(sessionId)` 即 `createUuid()`，是每次调用新值——那使 header 的等价判定
  永远不成立，见 §1.2）。本方法改为：持久 `SessionInfo.traceID` 有值则用之，否则回
  `session-<sessionId>` 确定性派生（与 `mapSessionSummaryToTaskMeta.ts:58` 同口径）。
  model/thoughtLevel 未持久化则**缺席**，不补默认模型（对齐 legacy 注释「不能为满足协议而
  伪造模型或阻断历史读取」）。
- **R6 标题权威**：`title` 取持久 `SessionInfo.title`，不用投影派生标题——冷读没有消息流，
  派生标题（`resolveACodeVisibleSessionTitle` 要 messages/target）无意义且会与列表侧权威冲突。
- **R7 不触碰 stream/snapshot/queue**：本方法不订阅、不投递、不参与水位/代际，故
  **不需要** `desktop-continuous` / `web-remote-replayable` 双链路真实冒烟
  （AGENTS.md 与 convergence-plan M2 风险条对「触及 stream/snapshot/queue」的要求在此不适用）。
  这一判定是本项能在本轮完成而 M2 不能的原因，必须如实记录以免被误当作跳过了验收。
- **R8 字段集与 legacy 逐字 parity，不多不少**：本项是**读路径替换**，不是行为变更。
  legacy `acodeSessionSnapshotToTaskMeta`（`acodeSessionProjection.ts:174-204`）实测产出
  14 个字段，**不含** `titleOverridden` / `forkedFromTaskId`——故本方法也**不产出**它们。
  多加字段 = 让冷读比热读传递更多信息，下游 `areResolvedTaskMetasEqual`（15 字段等价判定）
  会因冷/热两条路径字段集不同而永远判不等 → header 抖动。
- **R9 `mode` 值域**：持久 `SessionInfo.permission?.mode`（`CollaborationMode`，实测是
  `ACodeTaskMode` 的子集，见 §4.3）缺失时回落 `"build"`，与 legacy `fromACodeMode` 同口径
  （legacy 对 `"build"` 原样返回、其它原样返回，缺省即 build）。
- **R10 `model`/`thoughtLevel` 来源差异（如实登记，非缺陷）**：legacy 从**投影**取
  （`最近消息 info.model ?? settings.model.current`，含「被错误 runtimeModel 覆盖时靠消息
  自愈」的逻辑）；本方法从**持久 `model_selection` entry** 取（`readSessionModelSelection`）。
  对归档会话（无 live 消息流）二者等价——归档后没有新消息去覆盖，持久 entry 就是权威。
  对 live 会话本方法**不适用**（那种情况 `taskMetaFromLists` 在场，hook 根本不调本方法，
  见 `useActiveTaskSnapshotMeta.ts:57-61`）。故差异不影响实际消费面。
- **R11 `status`/`lastError` 缺席**：二者的 legacy 权威源是**runtime 投影**
  （`deriveACodeTaskStatusFromSessionSnapshot` 读 `projection.status`/`runtime`；`lastError`
  读 `projection.lastError`），持久层无等价权威。冷读**不猜测**：缺席即可，由列表侧持久行
  join 时决定（与 `mapSessionSummaryToTaskMeta` 对 `previous?.status` 的处理同理）。
  伪造一个 status 会让归档任务显示错误的运行态。
- **R12 `target`/goal 直通**：持久 `SessionGoal`（`contracts/src/tools/target.ts:46-63`）与
  `ACodeTaskGoal`（`acode-task-types-core.ts:77-93`）**字段逐一相同**（sessionID/targetID/
  objective/summaryTitle/status/tokenBudget/tokensUsed/timeUsedSeconds/activeInputId/
  activeRunStartedAtMs/activeRunLastSeenAtMs/time.{created,updated}），`GoalStatus` 值域也与
  `ACodeTaskGoalStatus` 相同（active/paused/budget_limited/complete）。故 goal **零转换直通**，
  不需要 legacy `fromACodeGoal` 那套 snake_case 兼容与非法值回落（那些分支对经 schema 校验的
  输入不可达。该结论曾由 `packages/ui/test/acodeSessionProjection.test.ts` 专测钉住（喂 snake_case
  + 非法 status 给 goal schema 断言被拒）；该测试随投影桥退役一并删除，结论保留在此与
  shared 叶子的实现里——`session-header-meta.ts` 的 goal schema **未照搬**那三处兜底
  （实测 grep `isACodeTaskGoalStatus|stringValue(record` 命中 0）。

## 3. 状态所有者

| 事实 | 所有者 | 本方法的角色 |
|---|---|---|
| 会话身份（id/title/titleSource/parentID/traceID/时间戳/workspace） | `SessionStorePort`（sqlite `session` 表） | 只读 |
| 权限/协作模式（`mode`） | `SessionInfo.permission.mode`（持久） | 只读，缺失回落 `"build"` |
| 模型与思考档位选择 | `SessionEntryInfo`（type=`model_selection`，持久） | 只读，缺失则字段缺席 |
| goal / target | `SessionStorePort.readTarget` | 只读 |
| 任务状态（running/completed/error） | **无持久权威**（live phase 属 runtime 投影） | **不猜测**：归档冷读的 phase 无权威源，故 `status` 缺席，由列表侧持久行 join 时决定 |
| provider | 常量 `ACODE_AGENT_PROVIDER`（agent 面唯一 provider） | 直接给值 |

**明确不引入第二份状态**：本方法不缓存、不落盘、不写 runtime-task 投影。

## 4. 接口契约

### 4.1 wire 方法

`V4_METHODS.sessionHeaderMeta = "v4/session/headerMeta"`（新增；additive，旧 host 不会调用它，
天然偏斜安全——与 `conversationWorkflowRunEvents` 等新增 query 同一论证）。

### 4.2 params / result（`packages/shared/src/acode-protocol-v4/session-header-meta.ts`）

```ts
// params **只有 sessionId**，与 legacy acodeSessionReadParamsSchema 的定域模型逐字一致
// （实测 index.ts:1586-1593：sessionId + deliveryKind/messageLimit/afterSeq，无 workspace 字段）。
// 为什么不在服务端加 workspace 闸：
//   ① workspace 边界由**进程拓扑**承担——一个 CLI agent 子进程绑定一个 workspace，其 session
//      库路径由 configResult 派生（app/session-store.ts:104-110），跨 workspace 的 sessionId
//      在这个库里根本查不到，天然 notFound；
//   ② UI 侧的 workspace 定域发生在**选哪个 client** 那一层
//      （useACodeSessionService(workspacePath, remoteSessionId, workspaceIdentity)），
//      不在 params 里；
//   ③ 若在 params 里再比一次路径，会引入**假阴性**风险：路径归一化差异（末尾 `/`、大小写、
//      远程 identity 前缀）就能让合法读取判成 notFound——core/runtime/methods/events.ts:579-582
//      正记载过这类漂移事故（末尾 `/` 丢失导致冷恢复落到另一个身份）。加一道会 false-negative
//      的闸，比不加更糟。
v4SessionHeaderMetaParamsSchema = z.strictObject({
  sessionId: z.string().min(1),
});

v4SessionHeaderMetaResultSchema = z.strictObject({
  found: z.boolean(),
  // found=false 时 meta 缺席；found=true 时 meta 必填。
  // 用判别字段而不是抛错（R4）。
  meta: v4SessionHeaderMetaSchema.optional(),
});

v4SessionHeaderMetaSchema = z.strictObject({
  // **字段集 = legacy acodeSessionSnapshotToTaskMeta 的产出（实测 14 个）逐字对齐**：
  // taskId / traceId / title / workspacePath / workspaceIdentity? / createdAt / updatedAt /
  // mode / model? / thoughtLevel? / provider / status? / target?
  // 本项是**读路径替换**不是行为变更，故不多不少：
  //   • 刻意不加 titleOverridden / forkedFromTaskId（legacy 映射器不产出它们，见 R8）；
  //   • 刻意不带 lastError（legacy 取自投影 projection.lastError，持久层无该事实的权威源，
  //     带上等于让冷读发明一个 legacy 也不保证的字段 → UI 在冷读/热读间不一致，见 R11）。
  taskId, traceId, title, workspacePath, workspaceIdentity?,
  createdAt, updatedAt, mode, model?, thoughtLevel?, provider, status?, target?,
});
```

**类型层 parity 钉法**：`v4SessionHeaderMetaSchema` 的 `z.infer` 必须可赋值给
`Pick<ACodeTaskMeta, "taskId" | "traceId" | ... 上述键>`，用一条 `satisfies`/赋值断言在编译期
钉住——将来 `ACodeTaskMeta` 收窄或改名会红，不会静默漂移。

**为什么 result 不复用 `ACodeTaskMeta` 接口、也不另造一套词汇（实施期实测修正）**：

- 初稿曾称「`ACodeTaskMeta` 是 host 侧 UI 词汇，把它当 v4 wire schema 会让 v4 依赖 legacy
  词汇表，与 M4 方向相反」——**该论证不成立**，实测：`ACodeTaskMeta` 定义在
  `packages/shared/src/acode-task-types-core.ts`（shared 中立模块），legacy barrel
  `acode-protocol/index.ts` 对它**零 re-export**（不在 M4 删除范围）；且 v4 叶子**已经**在
  依赖该模块（`command.ts:291`、`telemetry.ts:315` 都 import `ACodeBackgroundTurnAttribution`，
  `workspace-config.ts:11-12` 明写「与 host 侧 ACodeConfigSelectValue（acode-task-types-core）
  结构对齐」）。
- 但 `ACodeTaskMeta` 是**接口不是 zod schema**，而跨进程数据必须可运行时校验
  （AGENTS.md：「当数据会跨越进程…应优先使用可运行时校验的 schema」）。故 wire 侧仍需一份
  zod schema——**关键是它必须是 `ACodeTaskMeta` 的窄 Pick，而不是平行发明一套字段名**
  （平行词汇 = 重复状态，AGENTS.md 明令避免；`workspace-config.ts` 的「结构对齐、零映射直通」
  就是本仓既有范式）。
- 落地形态：`v4SessionHeaderMetaSchema` 用 zod 声明 header 冷读**实际需要**的字段子集，
  并在类型层用 `satisfies`/断言钉住「其 `z.infer` 可赋值给 `Pick<ACodeTaskMeta, …>`」——
  字段名与类型逐一取自 `ACodeTaskMeta`，不新造。这样：① wire 有运行时校验；
  ② 无第二套词汇；③ 将来 `ACodeTaskMeta` 收窄或改名时，类型断言会红而不是静默漂移。
- 由此 UI 侧的「映射器」退化为**填默认值的窄函数**（把 header meta 补齐成完整
  `ACodeTaskMeta`），不是字段翻译层——这是好事，翻译层越少越不会漂。

### 4.3 分层与依赖方向

| 层 | 文件 | 职责 |
|---|---|---|
| shared v4 叶子 | `packages/shared/src/acode-protocol-v4/session-header-meta.ts` | schema + 纯投影函数（**结构化窄输入** → header meta），无 IO、无 CLI 类型依赖 |
| shared v4 transport | `packages/shared/src/acode-protocol-v4/transport.ts` | 加 `V4_METHODS.sessionHeaderMeta` 一行 |
| bootstrap v4 handler | `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/session-header-meta-query.ts` | 取持久层事实（store read）→ 收窄成结构化输入 → 调 shared 纯投影 |
| bootstrap 薄 dispatch | `apps/acode-cli/packages/bootstrap/src/acode-protocol/server.ts` | **一行** `case V4_METHODS.sessionHeaderMeta: return await querySessionHeaderMeta(context, request.params);` |
| services 端口 | `packages/services/src/acode-session/*` + `acode-agent/*` | `readSessionHeaderMeta` 走既有 workspace client（进程级复用），但**不建 session record / 不触发 session 运行时激活**（R2） |
| UI 映射 + hook | `packages/ui/src/v4/mapSessionHeaderMetaToTaskMeta.ts`、`hooks/useActiveTaskSnapshotMeta.ts` | 换读路径；删对 `acodeSessionSnapshotToTaskMeta` 的依赖 |

**shared 叶子不得吃 CLI 类型（实施期实测修正）**：`packages/shared/package.json` 的依赖只有
`@acode/model-option-map` 与 `zod`，**拿不到** `@acode/contracts`（那是 CLI 侧包），故
`SessionInfo` / `SessionEntryInfo` / `SessionGoal` 都不能出现在 shared 叶子的签名里——否则
要么引入非法依赖方向，要么被迫在 shared 里复制一份 CLI 类型（重复状态）。
正确做法：shared 叶子的投影函数吃一个**结构化窄输入**（`{ title, titleSource, parentSessionId,
traceId, createdAt, updatedAt, permissionMode, modelSelection, goal }` 的纯字面量形状），
由 bootstrap handler 负责把持久层事实收窄成它。这样 shared 叶子保持零 CLI 依赖、可离线单测，
且「哪些持久事实参与投影」在 handler 一处可见。

**mode 值域实测可直接映射**：持久侧 `CollaborationMode` = `"plan"|"build"|"edit"|"yolo"|"auto"|"dontAsk"`
（`contracts/src/interfaces/session-shared.ts:20`），UI 侧 `ACodeTaskMode` =
`"yolo"|"plan"|"edit"|"auto"|"autoEdit"|"build"|"dontAsk"`（`acode-task-types-core.ts:154`）——
前者是后者的子集，故 1:1 透传合法，不需要映射表（`autoEdit` 是 UI 侧多出的值，持久层不产生）。
`ACodeProvider` 实测为字面量类型 `"glm"`（`acode-task-types-core.ts:40`），与
`ACODE_AGENT_PROVIDER` 常量一致。

**dispatch 落点的取舍（已与用户对齐）**：handler 与 schema 放 v4 目录，`server.ts` 只加一行
转发。理由：`server.ts`（1,020 行）是**整个 agent 协议的唯一入口**——
`acode-protocol-entrypoint.ts:349` 的 `handleMessage` 绑到 `ACodeProtocolAgentServer`，其
同一个 switch 里既有 59 个 legacy case 也有 31 个 v4 case；`v4-gateway.ts`（3,500 行）自身
不含任何 `V4_METHODS` dispatch。故新增 v4 方法**当前只能**在那里接线（M3 的入口搬迁未完成前）。
把实体逻辑放 v4 目录、只留一行转发，使 M3 搬迁时只需移动这一行，不在待删目录里新增实体债
（与 U08 provider 诊断把 431 行实体放进 legacy 目录形成对比，那使 M3 范围增大 2 文件）。

**依赖方向与环**：handler 复用 `bootstrap/src/app/session-store.ts:54` 的
`readSessionModelSelection`（规范读取器，吃 `Pick<SessionStorePort,"sessionEntries">`，返回
`ModelSelection | undefined`），不自写第二份 entry 解析。实测 `app/session-store.ts` 对
`acode-protocol-v4/` **零 import**，故 v4 目录 → app 目录这条边不成文件级环；
且已有先例（`acode-protocol-v4/model-config-mutation.ts:1` import `../app/types.js`）。

### 4.4 UI 映射器

`mapSessionHeaderMetaToTaskMeta(meta)` → `ACodeTaskMeta`，纯函数、无 IO。
`workspacePath` / `workspaceIdentity` 从 meta 直接取（服务端已从持久 `SessionInfo` 填好，
与 legacy `acodeSessionSnapshotToTaskMeta` 读 `snapshot.session.workspace.workspacePath` 同源），
故映射器**不需要** options 注入——这正是它比 `mapSessionSummaryToTaskMeta`（那个必须靠
`options.workspacePath` 外部补，因为 `SessionSummary` 不带 workspace 事实）更简单的地方。
与后者同族但**不同源**：那个吃 `SessionSummary`（列表实时 detail，需 `previous` 保留手动标题、
并产出 `titleOverridden`/`forkedFromTaskId`），这个吃冷读 header meta（归档兜底，字段集严格
等于 legacy 映射器的 14 项，**不产出** `titleOverridden`/`forkedFromTaskId`，见 R8；标题直接
取持久 `SessionInfo.title`，无需 `previous`）。不合并两者——输入形状、标题权威判据与字段集都
不同，合并会引入分支耦合，还会把冷/热两条路径的字段集差异藏进一个函数里。

## 5. 事件顺序

```
renderer（归档任务被打开，taskMetaFromLists 缺席）
   │  v4/session/headerMeta { sessionId }
   ▼
host services.readSessionHeaderMeta ──► client.request(V4_METHODS.sessionHeaderMeta, …)
   │                    （workspace agent 进程按需复用/启动；但不建 session record、不激活 session 运行时，见 R2）
   ▼
CLI server.ts switch ──► querySessionHeaderMeta(context, params)
   │   ├─ sessionStore.getSession(sessionId)      ← 身份信封（title/titleSource/parentID/
   │   │                                            traceID/时间戳/workspace 路径都在这）
   │   ├─ sessionStore.sessionEntries({type:"model_selection"})  ← model/thought
   │   └─ sessionStore.readTarget({sessionID})    ← goal
   ▼
shared 纯投影（结构化窄输入 → header meta）→ { found: true, meta } 或 { found: false }
   │
   ▼
UI mapSessionHeaderMetaToTaskMeta(meta) → setSnapshotMeta
```

无订阅、无后续帧、无状态变更：一次请求一次响应即结束。

## 6. 幂等与并发

- 幂等：纯读，重发得到同一结果（除 §3 所述 `status` 恒缺席，无时变字段）。
- 并发：不持锁、不写、不建订阅；与同一 session 的 live subscribe 互不干扰
  （本方法不注册 publisher、不进 `rawSequenceStates`）。
- 竞态：UI 侧保留既有 `cancelled` 守卫（任务切换时丢弃过期响应），语义不变。

## 7. 验收场景

| 编号 | 前提 | 操作 | 必须断言 |
|---|---|---|---|
| H1 | 归档会话已持久化（title、permission.mode=plan、model_selection entry 带 reasoningLevel、path/directory、workspaceID、time、traceID） | `v4/session/headerMeta` | `found=true`；meta 的 7 个必填字段齐全且与持久事实逐项相等；`mode="plan"`；`model`/`thoughtLevel` 来自 entry |
| H2 | 同上 | 同上 | **字段集恰为 legacy 14 项的子集**：`titleOverridden` / `forkedFromTaskId` / `lastError` **均缺席**（R8/R11——多产出会让冷热两路径等价判定永远不成立） |
| H2b | 会话有持久 `SessionGoal`（readTarget 命中） | 同上 | `target` 与持久 goal **逐字段相等**（R12 直通，无 snake_case 转换、无非法 status 回落） |
| H3 | sessionId 不存在 | 同上 | `found=false` 且 `meta` 缺席；**不抛协议错误**（R4）；不产生 warn 级日志噪声 |
| H4 | 会话无 model_selection entry | 同上 | `model` / `thoughtLevel` **缺席**，不补默认模型（R5/R10） |
| H5 | `SessionInfo.traceID` 缺席 | 同上 | `traceId === "session-<sessionId>"`（确定性派生，**非** 新 UUID）；两次调用结果相等（R5 反 flake） |
| H6 | 任意 found=true 响应 | 连续调用两次 | 两次 meta **深度相等**（R5/§1.2：等价判定必须成立，否则 header 连续重渲） |
| H6b | 任意 found=true 响应 | 归档会话（无 live runtime） | `status` **缺席**——冷读不猜测运行态（R11），由列表侧持久行 join 决定 |
| H7 | 读路径不激活**会话**运行时 | 调 `querySessionHeaderMeta`（注入 store） | handler 只用 `sessionStore.getSession`/`readTarget`/`sessionEntries`；**不**调 `requireSession`、不建 session record、不进 `context.sessions`。断言：查一个持久层有、但 `context.sessions` 无 live record 的 sessionId 仍 `found=true`（证明走的是持久层而非 live 投影）。（workspace agent **进程**级复用/启动不在本 handler 职责内，见 R2） |
| H8 | UI 映射 | `mapSessionHeaderMetaToTaskMeta(meta)` | 产出通过 `ACodeTaskMeta` 类型检查；`areResolvedTaskMetasEqual` 对同输入两次映射结果为 true；workspacePath 取自 meta 不需外部注入 |
| H9 | 迁移后 legacy 依赖清零 | grep `useActiveTaskSnapshotMeta.ts` | 不再 import `acodeSessionProjection`（M1 的 2 个真消费方之一就此收口） |
| H10 | 类型层 parity | 编译期断言 | `z.infer<typeof v4SessionHeaderMetaSchema>` 可赋值给 `Pick<ACodeTaskMeta, 14 键>`；`ACodeTaskMeta` 相关字段改名/收窄时 typecheck 红（§4.2） |

**不覆盖（如实登记）**：真实 Electron + 真 CLI 子进程的端到端冷读时序——代理无法启动
Electron，逐边界以注入 store 的单测覆盖（H1-H8）。`pnpm --filter @acode/desktop e2e:smoke`
可覆盖 host 启动路径不回归。

## 8. 回退

新增的 v4 方法是 additive：`V4_METHODS` 只增一条、不删任何既有词，旧 host 不调用即无影响。
回退 = 把 `useActiveTaskSnapshotMeta` 改回 legacy 读路径。

**回退的具体做法（2026-10-28 更新）**：本 spec 初稿写的是「改回 `readSession` +
`acodeSessionSnapshotToTaskMeta`，两者都仍在」——该前提**已不成立**。M1 收口时投影桥
`packages/ui/src/lib/acodeSessionProjection.ts` 及其 `acodeSessionSnapshotToTaskMeta`
已随最后一个消费方迁走而**整体删除**（见 docs/legacy-protocol-convergence-plan.md M1 节
2026-10-28 裁决与实施记录）。故回退不再是「翻一个 import」，而要：

1. `readSession` 端口**仍在**（services `acodeSession.ts:146`、`acodeAgentService.ts:3908`，
   仍被 `SessionPane.tsx:1213` 当存在性探针使用），可直接调用；
2. 但**投影函数需重建**——`acodeSessionSnapshotToTaskMeta` 已删。可从 git 历史
   （提交 `d1bcf9f9` 之前）取回，或按本 spec §4.5 parity 表重新实现。

**这是有意的取舍**：保留一个零消费方的死函数只为「回退方便」，等于让 legacy 投影栈永久
留在树上（knip 因测试引用而不报，反而掩盖它已死）。M1 的验收判据是该桥归零，故按裁决删除。
回退成本从「翻 import」升为「取回一个纯函数」，可接受——它无 IO、无状态、有完整 parity 表可照抄。

回退**不得**让 header 显示错误标题或伪造 model（R5/R6 在回退路径同样适用）。

## 9. 非目标

- 不做 v4 归档会话的**列表**面（那是 `sessions-index` 的 `includeArchived` 决策，属产品面）。
- 不替换 legacy `readSession` 的其它消费方（task-index 补正文索引等）——那些要 messages，
  本方法刻意不带 messages（header 兜底不需要正文，带正文就退回 legacy snapshot 的大载荷问题）。
- 不做 M3 的入口搬迁（本 spec 只把实体放 v4 目录以减小 M3 成本，不代替 M3）。
- 不引入 `status` 的持久权威（§3）；若产品需要归档任务显示终态，须先决定权威源，不在本项猜测。
