# R1-01 下一批次 scoping 调研报告

**调研日期**：2026-10-28（Asia/Shanghai）。基线分支：`fix/project-review-2026-10-26`，提交 `1b56f0b4`。
**触发**：[2026-10-26 review](../2026-10-26/cli-core-structure.md) 第 13 行 R1-01（P1）确认 7/~33 切片完成，剩 26 字段未收敛。
**spec 登记**：[runtime-state-ownership.md §252-274](../../../apps/acode-cli/specs/runtime-state-ownership.md)（「RuntimeTurnState 剩余字段与后续批次」「长期方案」两节）。

**调研方法**：只读源码枚举 + grep 写入/读取面。所有论断附 `file:line` 证据。本报告不修改代码。

---

## 0. 一句话结论

> R1-01 剩 26 字段，分 4 批，预估总工作量 **5-7 人日**；4 批做完后，「原型注入 + 共享 this」的 P1 根因**仍未修**——只是把它能滥写的字段全部收窄为只读 getter + owner。最终的根治（长期方案 §269-274：原型注入换显式组合）是另一个独立项目，不在 R1-01 内。

---

## 1. 33 个扁平可变字段清单

口径：字段在 `internal.ts` 的簇接口中**仍以非 readonly 形式声明**（可直接 `this.X = ...`），且运行时尚未由 `Object.defineProperty` 装上只读 getter。依据 [internal.ts](../../../apps/acode-cli/packages/core/src/runtime/internal.ts) 与 [agent-runtime.ts](../../../apps/acode-cli/packages/core/src/runtime/agent-runtime.ts) 的 `private` 声明对照。

### 1.1 RuntimeTurnState 剩余（5 个）

`internal.ts:202-208` `interface RuntimeTurnState extends RuntimeTurnCoordinationView, RuntimeTurnTimingView` — 7 个高频字段已收敛（turn-coordination + runtime-turn-timing），剩下 5 个仍是扁平可写：

| # | 字段 | 类型 | internal.ts 行号 | agent-runtime.ts 声明 |
|---|---|---|---|---|
| T1 | `activeForegroundExecution` | `ActiveForegroundExecutionState \| undefined` | :203 | `agent-runtime.ts:254`（mutable） |
| T2 | `foregroundPromotionLease` | `ForegroundPromotionLeaseState \| undefined` | :204 | `agent-runtime.ts:256`（mutable） |
| T3 | `runtimeCommandQueue` | `RuntimeCommandQueue` | :205 | `agent-runtime.ts:252`（mutable） |
| T4 | `currentTurnFileChanges` | `RuntimeTurnFileChangeMap` | :206 | `agent-runtime.ts:248`（mutable） |
| T5 | `lastAssistantCompletedAtMs` | `number \| undefined` | :207 | `agent-runtime.ts:249`（mutable） |

注：spec §257-262 把这 5 字段的「建议批次顺序」分别排为批次 2 与批次 3；本报告基于实际耦合关系给出更精确的划分（见 §4）。

### 1.2 RuntimeContextMemoryState（19 个）

`internal.ts:153-185` `interface RuntimeContextMemoryState` — 整簇**没有任何 owner 收敛**，19 个字段全部扁平可写：

| # | 字段 | 类型 | internal.ts 行号 | agent-runtime.ts 声明 |
|---|---|---|---|---|
| C1 | `messageHistory` | `MessageHistory` | :154 | `agent-runtime.ts:197` |
| C2 | `readFileState` | `ReadFileStateMap`（容器） | :155 | `agent-runtime.ts:198` |
| C3 | `cachedTools` | `ModelToolContract[] \| null` | :156 | `agent-runtime.ts:199`（默认 `null`） |
| C4 | `toolSearchContext` | `ToolSearchExecutionContext \| undefined` | :163 | （注入面）|
| C5 | `contextBuilder` | `ContextBuilder \| null` | :164 | `agent-runtime.ts:200` |
| C6 | `contextInitialized` | `boolean` | :165 | `agent-runtime.ts:201`（默认 `false`） |
| C7 | `contextSourceSnapshot` | `ContextSourceSnapshot \| undefined` | :166 | `agent-runtime.ts:202` |
| C8 | `latestContextBuildResult` | `ContextBuildResult \| undefined` | :167 | `agent-runtime.ts:203` |
| C9 | `memoryRoot` | `string \| undefined` | :168 | `agent-runtime.ts:204` |
| C10 | `memoryIndexContent` | `string \| undefined` | :169 | `agent-runtime.ts:205` |
| C11 | `promptFileRouting` | `PromptFileRouting \| undefined` | :171 | （注入面）|
| C12 | `memoryExtractionScheduler` | `ProjectMemoryExtractionScheduler \| undefined` | :172 | `agent-runtime.ts:206` |
| C13 | `memorySemanticRecallChannel` | `MemorySemanticRecallChannel \| undefined` | :178 | （注入面）|
| C14 | `mcpStartupPromise` | `Promise<McpConnectionSnapshot> \| undefined` | :179 | `agent-runtime.ts:210` |
| C15 | `mcpInitializationPromise` | `Promise<void> \| undefined` | :180 | `agent-runtime.ts:212` |
| C16 | `mcpInitialized` | `boolean` | :181 | `agent-runtime.ts:214` |
| C17 | `mcpToolsRegistered` | `boolean` | :182 | `agent-runtime.ts:215` |
| C18 | `skillLoadOutcome` | `SkillLoadOutcome \| undefined` | :183 | `agent-runtime.ts:228` |
| C19 | `residencyBlockingWorkCount` | `number` | :184 | `agent-runtime.ts:213`（默认 `0`） |

注：C1 (`messageHistory`) 与 C2 (`readFileState`) 是「容器实例」而非原始值——method 不直接 `this.messageHistory = ...` 重新赋值（除 `resume.ts:140` 一处），但容器**内容**（`addUser/addEntries/replaceMessages/delete`）由 ~19 个 method 文件直接改写。owner 化对这类字段只能封「整体替换」写面，容器内写面收口需要更深的端口设计（见 §3.2）。

### 1.3 RuntimeMessageProjectionState（5 个）

`internal.ts:210-217` `interface RuntimeMessageProjectionState` — 整簇未收敛：

| # | 字段 | 类型 | internal.ts 行号 | agent-runtime.ts 声明 |
|---|---|---|---|---|
| M1 | `latestConversationMessageId` | `MessageId \| undefined` | :212 | `agent-runtime.ts:234` |
| M2 | `latestAssistantMessageId` | `MessageId \| undefined` | :213 | `agent-runtime.ts:235` |
| M3 | `latestAssistantTurnId` | `TurnId \| undefined` | :214 | `agent-runtime.ts:236` |
| M4 | `lastRequestModelId` | `string \| undefined` | :215 | `agent-runtime.ts:247` |
| M5 | `lastEmittedLocalDate` | `string \| undefined` | :216 | `agent-runtime.ts:250` |

### 1.4 RuntimeCacheDiagnosticsState（4 个）

`internal.ts:220-229` `interface RuntimeCacheDiagnosticsState` — 整簇未收敛：

| # | 字段 | 类型 | internal.ts 行号 | agent-runtime.ts 声明 |
|---|---|---|---|---|
| D1 | `mainTurnCacheHitAggregate` | `MainTurnCacheHitAggregate` | :221 | `agent-runtime.ts:237-242`（初始化字面量） |
| D2 | `pendingCacheMissCause` | `PromptCacheMissCause \| undefined` | :226 | `agent-runtime.ts:245` |
| D3 | `cacheMissCauseCounts` | `Partial<Record<PromptCacheMissCause, number>>` | :227 | `agent-runtime.ts:246`（默认 `{}`） |
| D4 | `autoCompactConsecutiveFailures` | `number` | :228 | `agent-runtime.ts:251`（默认 `0`） |

### 1.5 已收敛（对照参考，13 个）

7 个 turn 时序字段（`turnNumber`/`activeTurn`/`pendingInputSequence`/`pendingInputReservations`/`pendingInputDrains`/`queueAutoDrain`/`queueExternalDrainActive`）由 `runtime-turn-timing.ts` owner 持有（`agent-runtime.ts:173,257-270` 全为 `declare private readonly`）；3 个 turn-coordination 字段（`activeTurnStartReservation`/`branchGeneration`/`runtimeCommandDrainActive`）由 `turn-coordination.ts` owner 持有；`sessionModelSelection`/`shuttingDown`/`permissionFullAccessPending`/`lastPermissionGrantId`/`pendingModelChangeTimeline`/`runtimeRestartReminderEmitted`/`sessionTitleGenerationAttempted`/`needsPlanModeExitReminder`/`sessionStartHookRan`/`backgroundTaskNotificationsSealed`/`backgroundTaskNotificationSealReason`/`sessionPersisted` 已由 lifecycle/notification-seal/model-selection/permission-grant/model-change-timeline/session-persistence 6 个 owner 分持。**这些字段不在本批次范围。**

---

## 2. 每族字段的写入方与读取方

下表逐字段列出 `this.X = ...`（含 `+=`、`-=`、`??=`、`Object.assign` 等价语义）的写入位置。**写面=赋值**，容器内修改单独标注。

### 2.1 RuntimeTurnState 剩余（5 字段）

| 字段 | 写入方（file:line） | 读取方 | 写面收敛工作量 |
|---|---|---|---|
| `activeForegroundExecution` | `runtime-command-queue.ts:427` (set state)、`:437` (clear to undefined)。容器内写：`runtime-command-queue.ts:476` (`active.preserveQueueAutoDrainOnCancel = ...`) | `prompt-admission.ts:36`、`runtime-command-queue.ts:104,105,129,436,460,485`、`compact.ts:150-152`、`target-completion-verification.ts:64,194-195`、`turn.ts:371,759-761` | 2 个方法（`beginForegroundExecution`/`finishForegroundExecution`）；容器内 1 个写点 |
| `foregroundPromotionLease` | `runtime-command-queue.ts:87` (clear)、`:137` (set)、`:149` (clear) | `runtime-command-queue.ts:69,75,104,121,148`、`prompt-admission.ts:35` | 3 个方法（`acquireForegroundPromotionLease`/`releaseForegroundPromotionLease`/`dequeueNextRunnableBatch`） |
| `runtimeCommandQueue` | 构造期 `agent-runtime.ts:326`（唯一赋值点） | 19 处读：`runtime-command-queue.ts:27,34,69,76,78,82,107,131,202,224,229,240,245,257,269,291`、`runtime-command-active-loop.ts:25,41`、`subagent-messages.ts:71`、`target-continuation-loop.ts:60`、`prompt-admission.ts:38` | **0 个 method 写入**——容器实例本身仅构造期赋值一次，运行时从未重赋值。**只需 readonly 化引用**（`declare private readonly` + tsc 负向断言），不必引入 owner |
| `currentTurnFileChanges` | `turn.ts:141` (reset to `new Map()`)、`rewind-message.ts:752` (reset)。容器内写：`tools.ts:261`（`recordTurnFileChange(map, ...)`） | `turn-model-step.ts:619`（`buildTurnFileChangeSummary`） | 2 个 method（`turn.ts`、`rewind-message.ts` 的 reset）+ 1 个容器内写点（保持现状即可，owner 只封 reset 写面） |
| `lastAssistantCompletedAtMs` | `turn-model-step.ts:661` (`Date.now()`)、`resume.ts:197`、`rewind-message.ts:735` | `microcompact.ts:54`、`turn-model-step-usage.ts:198` | 3 个 method 写点；最简单（单值游标） |

**写入面收敛到 owner 需要改的方法数：5 个 method**（`beginForegroundExecution`/`finishForegroundExecution`/`acquireForegroundPromotionLease`/`releaseForegroundPromotionLease`/`dequeueNextRunnableBatch`），另加 `turn.ts`/`rewind-message.ts`/`turn-model-step.ts` 各一处 `currentTurnFileChanges = new Map()` 与 `lastAssistantCompletedAtMs = Date.now()` 端口调用改写。

### 2.2 RuntimeContextMemoryState（19 字段）

按「写面性质」分四组：

**组 A：一次性初始化字段**（写点集中在 `ensureContextInitialized`，`methods/context.ts:32-82`）：

| 字段 | 写入方 | 读取方 |
|---|---|---|
| `contextInitialized` | `agent-runtime.ts:370`（构造期 true 分支）、`context.ts:81`（true）、`resume.ts:142`（false） | `context.ts:37`、`turn.ts:255`、`context-refresh.ts:11`、`session-shell-environment.ts:206` |
| `contextBuilder` | `agent-runtime.ts:367`（构造期）、`context.ts:76`、`config.ts:261`、`resume.ts:141`（null）、`context-refresh.ts:16,32` | `context.ts:11,26,32,37`、`subagent.ts` 隐式（经 `getContextBuilder`） |
| `contextSourceSnapshot` | `context.ts:64`、`session-shell-environment.ts:221-223` | `context-refresh.ts:30`、`session-shell-environment.ts:207,223`、`subagent.ts:188,206,392` |
| `latestContextBuildResult` | `context.ts:296`、`context-refresh.ts:44` | `context-usage.ts:124` |
| `memoryRoot` | `context.ts:67` | `context.ts:76`、`turn-loop.ts:211`、`context-refresh.ts:18,33` |
| `memoryIndexContent` | `context.ts:68` | `context.ts:77`、`turn-loop.ts:212`、`context-refresh.ts:20,35` |
| `promptFileRouting` | `context.ts:72` | `context.ts:152,153`、`title-generation-sidecar.ts:121` |
| `skillLoadOutcome` | `context.ts:66` | `context.ts:92,125,144`、`context-usage.ts:330`、`plugin-reference.ts:54`、`tools.ts:118`、`turn.ts:153`、`helpers/runtime-tools.ts:249` |

**组 B：MCP 并发字段**（写点分散在 `mcp.ts`，存在并发初始化竞争）：

| 字段 | 写入方 | 读取方 |
|---|---|---|
| `mcpStartupPromise` | `mcp.ts:71,116` | `mcp.ts:49,72,124`、`subagent.ts:828` |
| `mcpInitializationPromise` | `mcp.ts:141`（assign）、`:145`（clear） | `mcp.ts:135-136` |
| `mcpInitialized` | `mcp.ts:50` | `mcp.ts:49` |
| `mcpToolsRegistered` | `mcp.ts:53,158,196,205` | `mcp.ts:131,153` |

**组 C：缓存字段**：

| 字段 | 写入方 | 读取方 |
|---|---|---|
| `cachedTools` | `config.ts:156`（compute）、`:178`（invalidate to `null`） | `config.ts:155,160,165` |
| `toolSearchContext` | `tool-search-request.ts:63`（clear）、`:73`（set） | `helpers/runtime-tools.ts:245`（getter） |

**组 D：会话级 sidecar 字段**：

| 字段 | 写入方 | 读取方 |
|---|---|---|
| `memoryExtractionScheduler` | `helpers/project-memory-extraction.ts:81`（`??=` 惰性构造） | `agent-runtime.ts:403`（shutdown）、`residency.ts:26`（hasPendingWork）、`helpers/project-memory-extraction.ts:84,91` |
| `memorySemanticRecallChannel` | `helpers/memory-semantic-recall.ts:170`（惰性构造） | `helpers/memory-semantic-recall.ts:152` |
| `residencyBlockingWorkCount` | `residency.ts:14`（`+=1`）、`:16`（`Math.max(0, ...-1)`） | `residency.ts:25` |
| `messageHistory` | `agent-runtime.ts:324`（构造期 `new MessageHistoryImpl()`）、`resume.ts:140`（`new MessageHistoryImpl()`）。**容器内写**：19 个 method 文件直接调 `addUser/addEntries/addAttachment/replaceMessages/init/setCacheHit/setCacheMiss/reset`（grep 计数：34 处 `this.messageHistory.`） | 同左（`borrowReadOnlyRuntimeEntries/getCacheStats/getMessageCount` 等） |
| `readFileState` | `agent-runtime.ts:325`（构造期 `new Map()`）。**容器内写**：`context.ts:196`（`runtime.readFileState.set`）、`helpers/compact-post-reminders.ts:116`（`input.readFileState.delete`） | `compact-active.ts:633,780`、`resume.ts:149`、`rewind-message.ts:714`、`helpers/runtime-tools.ts:288`、`helpers/project-memory-agent.ts:74,121` |

**写入面收敛到 owner 需要改的方法数**（按子批次算）：

- **组 A（8 字段）**：写点集中在 `ensureContextInitialized` + `resume` + `context-refresh` + `session-shell-environment` + `config.getContextBuilder` 5 个 method；语义是「首轮一次性提交 + resume 重建 + shell 选择 patch」。适合合并成**一个** `RuntimeContextInitOwner`（与 model-selection 同形态，但接受一次性 payload 整体提交）。
- **组 B（4 字段）**：写点全在 `mcp.ts` 一个文件（`startMcpStartup`/`initializeMcp`/`initializeMcpOnce`），但语义含并发守卫（`mcpInitializationPromise` 的 claim/release、`mcpToolsRegistered` 的单调提交、失败路径的 `:196` 一次性 flag 提交）——是 4 个字段一组的并发事务。适合**一个** `RuntimeMcpLifecycleOwner`（与 turn-coordination 的 drain lease 同形态）。
- **组 C（2 字段）**：`cachedTools` 是「派生缓存 + invalidate」，`toolSearchContext` 是「请求级单点写入 + executor 读缝」。两个字段写入方各只有 1 个 method 文件，但语义完全不同。**建议分别独立 owner**（`RuntimeToolCacheOwner` / `RuntimeToolSearchContextOwner`），或者**并入组 A**——把 `cachedTools` 视为「context 派生缓存」由 ContextInit owner 持有。
- **组 D（3 字段）**：`memoryExtractionScheduler` 与 `memorySemanticRecallChannel` 都是「`??=` 惰性构造 + 唯一 owner」——已经是事实上的单写者，但**赋值点未经 readonly 保护**。`residencyBlockingWorkCount` 是计数器（+=/Math.max(-1)），是 `trackResidencyBlockingWork` 单个 method 的唯一写入方。这 3 个字段都简单，**建议独立成一批**（各自一个小 owner，或合并成 `RuntimeSidecarOwner`）。
- **组 E（容器实例：messageHistory + readFileState）**：写面分两层——「整体替换」只在 `agent-runtime.ts:324-325` 构造期与 `resume.ts:140`；「容器内写」由 19 个 method 文件分散调用。**本批次不试图收敛容器内写**（那是显式组合阶段的事），只把「整体替换」写面 readonly 化。这是最低成本也最低收益的一档。

### 2.3 RuntimeMessageProjectionState（5 字段）

| 字段 | 写入方 | 读取方 |
|---|---|---|
| `latestConversationMessageId` | `message-persistence.ts:63,218,292`、`compact-active.ts:760`、`control-only-turn.ts:137`、`resume.ts:194`、`rewind-message.ts:732`、`turn-stop.ts:68` | `compact-active.ts:331`、`timeline-persistence.ts:59,67,125`、`turn-stop.ts:27,67`、`helpers/project-memory-extraction.ts:55` |
| `latestAssistantMessageId` | `message-persistence.ts:293`、`resume.ts:195`、`rewind-message.ts:733`、`turn-stop.ts:72` | `target-completion-verification.ts:261`、`turn-stop.ts:25,71` |
| `latestAssistantTurnId` | `message-persistence.ts:295`、`resume.ts:196`、`rewind-message.ts:734`、`turn-stop.ts:74` | `steering.ts:231`、`target-completion-verification.ts:262`、`turn-stop.ts:26` |
| `lastRequestModelId` | `turn-model-step-usage.ts:157` | `turn-model-step-usage.ts:192-193` |
| `lastEmittedLocalDate` | `turn.ts:914`、`resume.ts:143`（重置） | `turn.ts:913` |

**写入面收敛需要改的方法数：6 个 method 文件**（`message-persistence.ts`、`compact-active.ts`、`control-only-turn.ts`、`resume.ts`、`rewind-message.ts`、`turn-stop.ts`），写点共 ~14 处。`turn-stop.ts` 的写入比较特殊：它是「TurnStop 时从持久化 anchor 恢复 projection cursor」——是事件驱动的 cursor 推进，语义简单。

`lastRequestModelId` 与 `lastEmittedLocalDate` 与 MessageProjection 的 ID 游标语义不同——前者是 cache-miss 归因输入（`turn-model-step-usage.ts:192-193`），后者是「日期变化提醒注入」游标。**建议把这两个字段从 MessageProjection 拆出来**：`lastRequestModelId` 并入 CacheDiagnostics（见下），`lastEmittedLocalDate` 独立成「会话内日期游标」（或并入 MessageProjection，但语义注释需要更新）。

### 2.4 RuntimeCacheDiagnosticsState（4 字段）

| 字段 | 写入方 | 读取方 |
|---|---|---|
| `mainTurnCacheHitAggregate` | `resume.ts:233`（重建）、`rewind-message.ts:744`（重建）、`turn-model-step-usage.ts:138-144`（累计） | `turn-model-step-usage.ts:139-143,159` |
| `pendingCacheMissCause` | `compact-active.ts:771`、`microcompact.ts:81`、`control-only-turn.ts:116`、`rewind-message.ts:742`、`context-refresh.ts:47`、`turn-model-step-usage.ts:156`（消费即清）、`resume.ts:240`（清） | `turn-model-step-usage.ts:189` |
| `cacheMissCauseCounts` | `resume.ts:239`（重置）、`rewind-message.ts:743`（重置）、`turn-model-step-usage.ts:150-153`（`{...spread, [cause]: +1}`） | `turn-model-step-usage.ts:151-152,160,174` |
| `autoCompactConsecutiveFailures` | `compact.ts:305,460`（reset 0）、`:320,473`（`++`）、`rewind-message.ts:753`（reset 0） | `compact.ts:214,325,478` |

**写入面收敛需要改的方法数：5 个 method 文件**（`compact-active.ts`、`microcompact.ts`、`control-only-turn.ts`、`compact.ts`、`turn-model-step-usage.ts`），加 `resume.ts`/`rewind-message.ts`/`context-refresh.ts` 三处重置。

**关键观察**：`turn-model-step-usage.ts:138-174` 是**唯一**对 `mainTurnCacheHitAggregate`/`cacheMissCauseCounts`/`pendingCacheMissCause`/`lastRequestModelId`/`lastAssistantCompletedAtMs` 做累计/消费的函数——这一函数应该作为 CacheDiagnostics owner 的**唯一写入端点**，其他写入点（`resume`/`rewind-message` 的「重建」、`compact-active`/`microcompact`/`control-only-turn`/`context-refresh` 的「写入 pending 事件点」）都收敛为端口调用。**`lastRequestModelId` 与 `lastAssistantCompletedAtMs` 应并入这个 owner**——它们是 `resolveCacheMissCause` 归因函数（`turn-model-step-usage.ts:185-204`）的输入，与 cache 归因事务同事务。

---

## 3. runtime-turn-timing.ts 切片模式分析

### 3.1 模式骨架（200 行模板）

`runtime-turn-timing.ts` 的形态（与 `turn-coordination.ts`/`runtime-lifecycle.ts`/`runtime-notification-seal.ts`/`runtime-model-selection.ts`/`runtime-permission-grant.ts`/`runtime-model-change-timeline.ts` 同型）：

```text
1. export interface RuntimeTurnTimingView { readonly X: T; ... }
   — 公开读面类型（`internal.ts` 的簇接口 extends 它）
2. export interface RuntimeTurnTimingPort { op(...): ...; ... }
   — 有限写端口签名（Object.freeze 实例化）
3. class RuntimeTurnTimingOwner { #x: T; get x(): T; readonly port = Object.freeze({...}); }
   — 私有 owner；# 字段 + 公开 getter + 冻结 port
4. const owners = new WeakMap<object, Owner>();
   — 模块级 WeakMap，key = runtime 实例
5. export function initializeRuntimeTurnTiming(runtime: object): void
   — 幂等（owners.has 短路）；Object.defineProperties 装只读 getter
     （configurable: false, enumerable: true, get: () => owner.x），无 setter
6. export function getRuntimeTurnTimingPort(runtime: object): Port
   — 取端口；未初始化抛错
```

**约束**（spec §181-207 钉住）：

- 写面只经 port 方法；运行时 `this.X = ...` 抛 TypeError（无 setter），tsc 报 2540 readonly 违例
- port 实例 `Object.freeze`——不能 `port.advanceTurn = ...` 反向篡改
- owner 用 `#private` 字段——运行时不经 port 拿不到真值
- getter `configurable: false`——不能 `Object.defineProperty` 重定义
- 构造期幂等（`owners.has` 短路）——重复 initialize 不替换
- WeakMap——runtime GC 时 owner 同步回收

**验收门禁**（spec §234-250）：

- 负向 tsc：`tests/runtime-state-ownership.test.mjs:963-1024` 用真实 TypeScript checker 跑一段「试图 `runtime.X = ...`」的虚拟源文件，断言诊断数 == 18（17× code 2540 readonly + 1× 2339/2551 不存在 setter）。**每加一批 owner，诊断数相应增加**。
- 运行时拒写：测试用例「non-writable, non-replaceable state getters」用 `assert.throws(() => { runtime.X = ...; }, TypeError)`。
- 机械门禁：`:1026-1074` 断言 `Object.getOwnPropertyNames(AgentRuntime.prototype)` ⊆ `AgentRuntime` + `AgentRuntimeInternal` 类型面成员并集。这个门禁**与字段是否 owner 化无关**——它钉的是「原型注入面」本身。

### 3.2 该模式能否直接套到剩下 4 族？适配差异点

**能套，但每族都有适配点。** 直接复用「WeakMap + 只读 getter + 冻结 port + 负向 tsc + 机械门禁」五件套即可，但 port 形态与初始化时机有差异：

| 族 | 直接套用？ | 适配点 |
|---|---|---|
| **TurnState 剩余 5 字段** | 完全可套 | ① `runtimeCommandQueue` 只需 readonly 引用（**无需 port**——零 method 写它）。② `activeForegroundExecution` 需要 port 暴露 `begin(state)`/`finish(state)`，且 port 内部要支持「容器内写」（`preserveQueueAutoDrainOnCancel = true`），最简形态是 port 返回的 state 引用不冻结（与 `activeTurn` 同先例，见 `runtime-turn-timing.ts:27` 注释）。③ `foregroundPromotionLease` 是「acquire/release/原子消费」——port 形态与 `permissionFullAccessPending` 的 `tryBegin/end` 完全一致（`runtime-permission-grant.ts:39-49`）。 |
| **ContextMemory 19 字段** | 可套，但要**拆 5 个子 owner** | 不能套一个「大 owner」——19 字段写入方分 5 组（§2.2 组 A-E），合并会重新把写面集中到一个拥有 19 个 port 方法的 god object。必须按写入事务边界拆：ContextInit / McpLifecycle / ToolCache+ToolSearch / Sidecar / MessageHistory 整体替换 readonly 化。 |
| **MessageProjection 5 字段** | 可套，且**最简单** | 5 字段都是「单值游标，事件驱动推进」——port 只需 `recordConversationMessage(id)` / `recordAssistantMessage(id, turnId)` / `reset()` 等少量方法。`lastRequestModelId` 应**迁出**并入 CacheDiagnostics（它是 cache 归因输入，不是消息投影）；`lastEmittedLocalDate` 语义独立（日期变化 reminder 游标），可以留在 MessageProjection 或独立。 |
| **CacheDiagnostics 4 字段** | 可套，**收益最大** | 4 字段加 2 个迁入（`lastRequestModelId`、`lastAssistantCompletedAtMs`）形成完整「cache 归因事务」。port 形态：① `recordMainTurnUsage(input)` 累计聚合 + 消费 pending + 更新 lastRequestModelId 的原子事务（封装 `turn-model-step-usage.ts:138-174`）；② `setPendingMissCause(cause)`（显式事件点写入）；③ `reset()`（resume/rewind 重建）。这是 4 个 owner 里事务密度最高的。 |

---

## 4. 批次划分建议

按「事务内聚度」与「写入方收敛成本」排序，**不推荐** spec §257-262 的「批次 2/3」划分（那把 `activeForegroundExecution` 与 `foregroundPromotionLease` 同批，`runtimeCommandQueue`/`currentTurnFileChanges`/`lastAssistantCompletedAtMs` 同批——但前者真的是一对，后者三个语义无关）。下面是按实际耦合重新划分的 **4 批**：

### 批次 R1-01-B1：Cache Diagnostics + 派生游标（**收益最高**，先做）

**字段**（6 个）：
- D1 `mainTurnCacheHitAggregate`
- D2 `pendingCacheMissCause`
- D3 `cacheMissCauseCounts`
- D4 `autoCompactConsecutiveFailures`
- 迁入：M4 `lastRequestModelId`（从 MessageProjection 拆出）
- 迁入：T5 `lastAssistantCompletedAtMs`（从 TurnState 剩余拆出）

**理由**：`turn-model-step-usage.ts:185-204` 的 `resolveCacheMissCause` 把 `pendingCacheMissCause` / `lastRequestModelId` / `lastAssistantCompletedAtMs` 作为**同一个归因事务的输入**读取；`:138-174` 的累计函数同时写 D1/D2/D3/M4。这 6 个字段属于**一个并发事务**，分 owner 会切开原子性。`autoCompactConsecutiveFailures` 虽然只被 compact 用，但同样是「失败计数器 + 成功重置」语义，与 cache miss 归因的「pending 消费即清」同形态，合并有协同。

**需要迁移的方法数**：7 个文件 ~20 个写点
- `turn-model-step-usage.ts:138-174`（核心累计函数，1 处大改写）
- `turn-model-step.ts:661`（`lastAssistantCompletedAtMs = Date.now()`）
- `compact-active.ts:771`、`microcompact.ts:81`、`control-only-turn.ts:116`、`context-refresh.ts:47`（4 处 `pendingCacheMissCause = ...` 事件点）
- `compact.ts:305,320,460,473`（4 处 `autoCompactConsecutiveFailures` reset/increment）
- `resume.ts:197,233,239,240`、`rewind-message.ts:735,742,743,744,753`（重建路径，~9 处端口调用替换）

**新增 owner 模块**：`runtime-cache-diagnostics.ts`（新文件，~250 行，参考 `runtime-turn-timing.ts` 形态）。

**Owner 端口形态**：

```ts
interface RuntimeCacheDiagnosticsPort {
  recordMainTurnUsage(input: MainTurnUsageInput): MainTurnCacheHitSummary;  // 原子：D1累计 + D2消费 + D3累计 + M4更新 + T5更新
  setPendingCacheMissCause(cause: PromptCacheMissCause): void;             // 4 处显式事件点
  recordAutoCompactFailure(): number;                                       // 返回新 failureCount（用于日志）
  resetAutoCompactFailures(): void;
  resetAfterRewindOrResume(aggregate: MainTurnCacheHitAggregate, lastAssistantCompletedAtMs?: number): void;
}
```

**验收测试**：
- 负向 tsc 诊断数 18 → 24（+6 字段）
- 运行时 `assert.throws(() => { runtime.mainTurnCacheHitAggregate = ...; })` 等 6 个 getter
- 既有 cache 归因测试套件全绿（`prompt-cache-diagnostics` spec 的用例）
- resume/rewind 重建后计数从空开始（spec `runtime-state-ownership.md` §220 的不变量）

**预估工作量**：**2 人日**（写点最多，但模式已成熟；测试需要新建一组 cache 归因事务用例）。

### 批次 R1-01-B2：TurnState 剩余（foreground execution + promotion lease）

**字段**（4 个）：
- T1 `activeForegroundExecution`
- T2 `foregroundPromotionLease`
- T3 `runtimeCommandQueue`（readonly 化即可，**无需 port**）
- T4 `currentTurnFileChanges`

**理由**：T1/T2 是「前台执行 + 队列调度 lease」的并发对——`dequeueNextRunnableBatch`（`runtime-command-queue.ts:74-89`）需要在持有 lease 的同步片内一并完成「找到 promoted command + 出队 + 清 lease」。它们都在 `runtime-command-queue.ts` 一个文件中写入。T3 是「容器实例」引用，零 method 写它，readonly 化是无脑胜利。T4 是「turn 内文件改动图」，写点只在 turn/rewind 的 reset 点。

**需要迁移的方法数**：5 个（全在 `runtime-command-queue.ts` + `turn.ts`/`rewind-message.ts`）
- `beginForegroundExecution` / `finishForegroundExecution`（`runtime-command-queue.ts:402-439`）
- `acquireForegroundPromotionLease` / `releaseForegroundPromotionLease`（`runtime-command-queue.ts:113-153`）
- `dequeueNextRunnableBatch`（`runtime-command-queue.ts:74-89`）
- `turn.ts:141` / `rewind-message.ts:752` 两处 `currentTurnFileChanges = new Map()` reset

**新增 owner 模块**：`runtime-foreground-execution.ts`（新文件，~200 行）。`runtimeCommandQueue` 直接 `declare private readonly`（`agent-runtime.ts:252` 改 declare），**不进 owner**。

**Owner 端口形态**：

```ts
interface RuntimeForegroundExecutionPort {
  beginForegroundExecution(state: ActiveForegroundExecutionState): void;
  finishForegroundExecution(state: ActiveForegroundExecutionState): void;
  tryAcquirePromotionLease(input: {...}): AcquireForegroundPromotionLeaseResult;
  releasePromotionLease(leaseId: string): boolean;
  /** 原子操作：找到 promoted command → 出队 → 消费 lease。返回 null 表示无 promoted command。 */
  consumePromotedCommandWithLease(): { commandId, leaseId } | null;
  resetTurnFileChanges(): void;   // currentTurnFileChanges = new Map()
}
```

**验收测试**：
- 负向 tsc +4（T1/T2/T4 + `runtimeCommandQueue` readonly）
- 运行时拒写
- 既有 `acquireForegroundPromotionLease`/`releaseForegroundPromotionLease`/`stopActiveForegroundExecution` 测试套件全绿（spec `runtime-state-ownership.md` 的 I1/I2 不变量保持）
- `preserveQueueAutoDrainOnCancel` 容器内写：测试钉住「port 返回的 state 不冻结、容器内写仍可行」（与 `activeTurn` 同先例）

**预估工作量**：**1.5 人日**。

### 批次 R1-01-B3：MessageProjection（4 字段，M4 已迁出）

**字段**（4 个）：
- M1 `latestConversationMessageId`
- M2 `latestAssistantMessageId`
- M3 `latestAssistantTurnId`
- M5 `lastEmittedLocalDate`

**需要迁移的方法数**：6 个文件 ~14 个写点
- `message-persistence.ts:63,218,292-295`（持久化路径，4 处）
- `compact-active.ts:760`（compact 路径，1 处）
- `control-only-turn.ts:137`（控制轮，1 处）
- `turn-stop.ts:67-74`（停止时 anchor 恢复，4 处）
- `resume.ts:143,194-196`、`rewind-message.ts:732-734`（重建路径，4 处）
- `turn.ts:913-914`（日期游标，1 处）

**新增 owner 模块**：`runtime-message-projection.ts`（新文件，~150 行，最简单）。

**Owner 端口形态**：

```ts
interface RuntimeMessageProjectionPort {
  recordUserMessage(messageId: MessageId): void;
  recordAssistantMessage(messageId: MessageId, turnId?: TurnId): void;
  recordControlOnlyMessage(messageId: MessageId): void;
  restoreFromPersistenceAnchor(anchor: { latestConversationMessageId?, latestAssistantMessageId?, latestAssistantTurnId? }): void;
  rebuildFromMessages(input: { latestConversationMessageId?, latestAssistant?, lastEmittedLocalDate? }): void;  // resume/rewind
  emitLocalDateReminder(currentDate: string): boolean;  // 原子：比较 + 更新；返回是否变化
}
```

**验收测试**：
- 负向 tsc +4
- 运行时拒写
- 既有 message-persistence / compact / turn-stop / resume 测试套件全绿

**预估工作量**：**1 人日**。

### 批次 R1-01-B4：ContextMemory（19 字段，**最复杂**，最后做）

**字段拆分**（5 个子 owner）：

| 子 owner | 字段 | 写面特征 |
|---|---|---|
| **RuntimeContextInitOwner** | C6 `contextInitialized`、C5 `contextBuilder`、C7 `contextSourceSnapshot`、C8 `latestContextBuildResult`、C9 `memoryRoot`、C10 `memoryIndexContent`、C11 `promptFileRouting`、C18 `skillLoadOutcome` | 「一次性提交 + resume 重建 + shell patch」事务；port 提供 `commitInitial(snapshot)`/`resetForResume()`/`patchShellSelection(sel)` |
| **RuntimeMcpLifecycleOwner** | C16 `mcpInitialized`、C14 `mcpStartupPromise`、C15 `mcpInitializationPromise`、C17 `mcpToolsRegistered` | 「startup 一次性 + initialize claim/release + tools 注册单调提交」并发事务；port 提供 `claimStartup()`/`completeStartup(promise)`/`tryClaimInitialization()`/`releaseInitialization()`/`commitToolsRegistered()` |
| **RuntimeToolCacheOwner** | C3 `cachedTools`、C4 `toolSearchContext` | 「派生缓存 + invalidate」+「请求级单点写入」；port 提供 `getOrCompute(compute)`/`invalidate()` + `setForRequest(ctx)`/`clearAfterRequest()` |
| **RuntimeSidecarOwner** | C12 `memoryExtractionScheduler`、C13 `memorySemanticRecallChannel`、C19 `residencyBlockingWorkCount` | 惰性构造 + 计数器；port 提供 `getOrCreateScheduler(factory)`/`getOrCreateRecallChannel(factory)`/`trackWork(promise)` |
| **messageHistory + readFileState readonly 化** | C1 `messageHistory`、C2 `readFileState` | 容器实例整体替换写面（构造期 + `resume.ts:140` 一处）；**容器内写不在本批范围**（19 个 method 文件的 34 处 `this.messageHistory.` 调用是显式组合阶段的事）。readonly 化即可，**不进 owner**。 |

**需要迁移的方法数**：~10 个 method 文件，~30 个写点（最大批次）。

**新增 owner 模块**：4 个新文件（`runtime-context-init.ts` ~250 行、`runtime-mcp-lifecycle.ts` ~200 行、`runtime-tool-cache.ts` ~150 行、`runtime-sidecar.ts` ~150 行）；C1/C2 走 `declare private readonly` + 构造期赋值。

**验收测试**：
- 负向 tsc +19
- 运行时拒写
- 既有 context/mcp/residency/compact/skill 测试套件全绿
- **并发用例**：`initializeMcp` 并发调用只允许一次真实注册（沿用 `mcpInitializationPromise` 的 claim 语义）；`ensureContextInitialized` 并发调用只允许一次真实初始化（沿用 `contextInitialized` 的单调提交语义）

**预估工作量**：**2.5 人日**（含并发用例新写 + 5 个子 owner 的接口设计）。

### 4 批汇总

| 批次 | 字段数 | 方法写点数 | 新 owner 文件 | 预估工作量 |
|---|---|---|---|---|
| R1-01-B1 CacheDiagnostics+游标 | 6 | ~20 | 1（~250 行） | 2 人日 |
| R1-01-B2 TurnState 剩余 | 4 | ~7 | 1（~200 行） | 1.5 人日 |
| R1-01-B3 MessageProjection | 4 | ~14 | 1（~150 行） | 1 人日 |
| R1-01-B4 ContextMemory | 19 | ~30 | 4（~750 行） | 2.5 人日 |
| **合计** | **33** | **~71** | **7 个新文件** | **7 人日** |

注：每批都需扩 `tests/runtime-state-ownership.test.mjs` 的负向 tsc 计数与运行时拒写断言；机械门禁用例无需修改（它检查的是 proto 注入面完整性，与 owner 化正交）。

---

## 5. 长期方案门槛（spec §269-274）

### 5.1 最终形态

spec §269-274 明确登记：**把「原型注入 + `this: AgentRuntimeInternal`」换为显式组合**——构造期把方法绑到实例或委托对象，使 `this` 面不再等于全字段并集。这是根治 P1 的唯一路径。

具体而言（基于 spec 与代码现状推断的可行形态）：

```ts
// 当前（原型注入）
class AgentRuntime { /* 46 个 private 字段 + declare readonly 字段 */ }
installAgentRuntimeMethods(AgentRuntime);  // proto.X = X 把 180 个 method 挂上
// 每个 method 的 this: AgentRuntimeInternal 隐含「能看到全部字段」

// 目标（显式组合）
class AgentRuntime {
  private readonly turnCoordination = new RuntimeTurnCoordinationContext(...);
  private readonly turnTiming = new RuntimeTurnTimingContext(...);
  private readonly contextInit = new RuntimeContextInitContext(...);
  // ... 每个 owner 一个字段，不再共享 this

  readonly turn = new TurnMethods(this.turnCoordination, this.turnTiming, ...);
  readonly context = new ContextMethods(this.contextInit, ...);
  // 每个 Methods 类的构造函数显式声明它需要的 owner 集合
}
// 调用方：runtime.turn.execute(...) 而非 runtime.executeTurn(...)
```

### 5.2 4 批做完后是不是就完成了？

**不是。** 4 批做完后达成的是「**写权限收窄完备**」——`AgentRuntimeInternal` 不再持有任何可扁平赋值的字段；任何 method 都不能 `this.X = ...` 绕过 owner。

但 P1 的根因**依然存在**：

1. **读越权未封**：`this.X` 仍能**读**任何 owner 暴露的 getter。例如 `compact.ts` 仍能 `this.turnNumber`、`this.contextInitialized`、`this.latestConversationMessageId` 读取与它无关的字段。owner getter 只挡写，不挡读。
2. **容器内写未收**：`messageHistory`/`readFileState`/`currentTurnFileChanges` 的容器**内**修改（`addUser`/`set`/`delete`）在 4 批中保持原状——owner 化只封了「整体替换」写面。19 个 method 文件仍能 `this.messageHistory.addUser(...)`。
3. **port 获取无鉴权**：`getRuntimeTurnTimingPort(this)` 是公开导出函数，任何 method 拿到 `this` 就能调 port。owner 只保证「写必须经 port」，不能保证「只有合法的写入方能拿到 port」。
4. **declaration merging 仍把全部字段合成一个 this**：`AgentRuntimeInternal` 接口（`internal.ts:240-251`）仍 `extends` 全部簇接口，每个 method 的 `this` 类型仍是「全字段并集」。tsc 不能帮我们发现「这个 method 不该读这个字段」。

### 5.3 距长期方案还差什么

| 缺口 | 当前状态 | 长期方案需要 |
|---|---|---|
| 写权限失控 | **本 4 批收口** | — |
| 注入面完整性（机械门禁） | 已钉住（`runtime-state-ownership.test.mjs:1026-1074`） | 显式组合后改为「methods 类显式声明依赖」 |
| 读越权 | 完全开放 | 每个 Methods 类只持它需要的 owner 引用 |
| 容器内写 | 完全开放（19 个 method 直写 messageHistory） | messageHistory 私有化为 owner，暴露 `appendUser(entry)` 等领域方法 |
| port 鉴权 | 任何 method 可 `getPort(this)` | port 只在 Methods 类构造期注入，不暴露公共取 port 函数 |
| declaration merging | `AgentRuntimeInternal` 仍是大接口 | 拆分为 `TurnMethodsThis`/`ContextMethodsThis` 等小子接口 |

### 5.4 长期方案的规模与门槛

- **规模**：~180 个 method、102 个文件、7 个 owner + 即将新增的 7 个（本 4 批）。
- **门槛**：spec §272 明确「属不可一次验证的大重构，必须独立立项、分批推进、每批配负例与门禁」。预估**独立项目**，工作量 15-30 人日（按方法簇分批迁移）。
- **前置依赖**：本 4 批必须先做完——否则「显式组合」要同时处理「写字段」与「绑方法」两个变量，无法逐点等价验证。
- **建议立项时机**：4 批 merge 后，另开 review 周期立项。

---

## 6. 建议的下一步

**立即可做**（按优先级）：

1. **R1-01-B1 立项**：CacheDiagnostics + 派生游标 6 字段，2 人日。收益最高——`resolveCacheMissCause` 是真实事务，且迁入 `lastRequestModelId`/`lastAssistantCompletedAtMs` 能立即把 MessageProjection 瘦到纯消息 ID 投影。
2. **R1-01-B2 立项**：TurnState 剩余 4 字段，1.5 人日。`runtimeCommandQueue` 是无脑 readonly 化胜利。
3. **R1-01-B3 立项**：MessageProjection 4 字段，1 人日。最简单，但写点分散。
4. **R1-01-B4 立项**：ContextMemory 19 字段，2.5 人日。**最复杂**——含 5 个子 owner 的接口设计与 MCP/context 并发用例。

**总预估**：**7 人日**（不含 review/merge 周期），分 4 个 PR。

**长期方案（原型注入换显式组合）单独立项**——不在 R1-01 范围，预估 15-30 人日，需在 4 批 merge 后另开 review 周期。

---

## 附录 A：证据文件清单

- `apps/acode-cli/packages/core/src/runtime/internal.ts`（251 行）——分簇接口定义
- `apps/acode-cli/packages/core/src/runtime/agent-runtime.ts`（797 行）——构造与 declare
- `apps/acode-cli/packages/core/src/runtime/turn-coordination.ts`（229 行）——reservation/drain/generation owner
- `apps/acode-cli/packages/core/src/runtime/runtime-turn-timing.ts`（200 行）——turn 时序字段 owner（**切片模板**）
- `apps/acode-cli/packages/core/src/runtime/runtime-lifecycle.ts`（146 行）——lifecycle flags owner
- `apps/acode-cli/packages/core/src/runtime/runtime-notification-seal.ts`（70 行）——notification seal owner
- `apps/acode-cli/packages/core/src/runtime/runtime-model-selection.ts`（62 行）——model selection owner
- `apps/acode-cli/packages/core/src/runtime/runtime-permission-grant.ts`（82 行）——permission grant owner
- `apps/acode-cli/packages/core/src/runtime/runtime-model-change-timeline.ts`（66 行）——model change timeline owner
- `apps/acode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`（487 行）——T1/T2 写点
- `apps/acode-cli/packages/core/src/runtime/methods/context.ts`（364 行）——C5/C6/C7/C8/C9/C10/C11/C18 写点（ensureContextInitialized）
- `apps/acode-cli/packages/core/src/runtime/methods/mcp.ts`（MCP 写点集中）
- `apps/acode-cli/packages/core/src/runtime/methods/turn-model-step-usage.ts`（241 行）——D1/D2/D3/M4/T5 写点（核心累计函数）
- `apps/acode-cli/packages/core/src/runtime/methods/message-persistence.ts`（M1/M2/M3 写点）
- `apps/acode-cli/tests/runtime-state-ownership.test.mjs:963-1074`（负向 tsc + 机械门禁用例）
- `apps/acode-cli/specs/runtime-state-ownership.md`（316 行，§252-274 登记后续批次与长期方案）

## 附录 B：grep 验证口径

| 模式 | 命中数 | 用途 |
|---|---|---|
| `this.<field> = ` 每字段 | 见 §2 各表 | 写面（赋值） |
| `this.messageHistory\.` | 34（19 文件） | C1 容器内写 |
| `this.activeForegroundExecution\b` | 14 | T1 全读写面 |
| `this.foregroundPromotionLease\b` | 9 | T2 全读写面 |
| `this.runtimeCommandQueue\b` | 22（其中 21 读、1 写=构造期） | T3 证明可 readonly 化 |

每个论断都可由上述命令在干净基线（`1b56f0b4`）上重放验证。
