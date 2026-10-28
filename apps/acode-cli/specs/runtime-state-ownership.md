# AgentRuntime 状态所有权分簇与不变量登记

状态：类型级分簇已实施；CLI-05 本批进一步封装 reservation、command drain 与 branch generation 的实际写权限（2026-10-09）。其余状态仍为分簇登记，不宣称整体 runtime 已隔离。
同日增补（2026-10-09 批次）：`RuntimeSessionLifecycleState` 最后四个扁平可变字段（`shuttingDown` / `permissionFullAccessPending` / `lastPermissionGrantId` / `pendingModelChangeTimeline`）收敛到 owner 只读 getter + 有限写端口，该簇不再保留任何扁平可写字段。
2026-10-22 增补（CLI-05 P1 第一切片，review R1-01）：`RuntimeTurnState` 的 7 个高频时序字段（`turnNumber` / `activeTurn` / `pendingInputSequence` / `pendingInputReservations` / `pendingInputDrains` / `queueAutoDrain` / `queueExternalDrainActive`）收敛到新的 `RuntimeTurnTimingOwner`（`runtime-turn-timing.ts`）——只读 getter + 有限写端口，形态与 turn-coordination/permission-grant 完全一致。这是「原型注入 `this` 面绕过 owner 只读约束」这条 P1 的有界第一切片，剩余字段与后续批次见 §RuntimeTurnState 剩余字段与后续批次。
2026-10-28 增补（R1-01 批次 B1）：`RuntimeCacheDiagnosticsState` 4 字段（`mainTurnCacheHitAggregate` / `pendingCacheMissCause` / `cacheMissCauseCounts` / `autoCompactConsecutiveFailures`）+ 迁入的 `lastRequestModelId`（原 MessageProjection，cache 归因输入）+ `lastAssistantCompletedAtMs`（原 TurnState 剩余，cache 归因输入）共 6 字段收敛到新的 `RuntimeCacheDiagnosticsOwner`（`runtime-cache-diagnostics.ts`）——只读 getter + 有限写端口，含原子归因事务 `recordMainTurnUsage`（聚合累计 + 消费 pending + 计数累计 + 模型记录更新）与重建端口 `resetMainTurnCacheHitAggregate` / `resetCacheMissCauseCounts` / `restoreLastAssistantCompletedAtMs`。负向 tsc 诊断数 18 → 24（+6 字段），运行时拒写与端口冻结由新增用例「cache diagnostics fields are owned by a finite write port」钉住。详见 §R1-01 批次 B1：CacheDiagnostics + 派生游标。
代码：`packages/core/src/runtime/internal.ts`（分簇子接口 + 组合）；`packages/core/src/runtime/agent-runtime.ts`（构造与原型安装）；`packages/core/src/runtime/turn-coordination.ts`（关键状态 owner）；`packages/core/src/runtime/runtime-turn-timing.ts`（turn 时序字段 owner，2026-10-22 新增）；`packages/core/src/runtime/runtime-cache-diagnostics.ts`（cache 诊断字段 owner，2026-10-28 新增）。

## 背景

当前 methods/ 下 102 个 TS 文件、270 处 `this: AgentRuntimeInternal` 共享 93 个 property，此前字段以扁平列表堆放：任何新模块都能悄悄读写任意字段，并发时序不变量只存在于散落注释。第一批把字段按所有权分为 7 簇（`RuntimeIdentityConfig` / `RuntimeInjectedDeps` / `RuntimeContextMemoryState` / `RuntimeTurnState` / `RuntimeMessageProjectionState` / `RuntimeCacheDiagnosticsState` / `RuntimeSessionLifecycleState`）。这些计数是本批开工前测量，后续按源码复测，不作为固定产品契约。

第一批分簇是纯类型级重组。本批保留未迁移字段的扁平访问；三个关键字段改为 readonly getter，类型和真实运行时均不提供 setter。有限写端口仅供对应 reservation、drain、恢复/rewind 与通知持久化路径使用，不向 `@acode/core` 公共入口导出，不迁移其余 methods 文件。

## CLI-05：关键状态写权限封口

`turn-coordination.ts` 的私有 owner 是三项状态的唯一保存方；它以 WeakMap 绑定 runtime 生命周期，构造时安装只读 getter，没有第二份 accepted queue 或业务状态。`AgentRuntimeInternal` 不含该 owner，也不含任意 `setState`/`setGeneration` 方法。

I4 的首个封口切片同步落地：`runtime-lifecycle.ts` 的 `RuntimeLifecycleOwner` 以
`WeakMap` 持有 `runtimeRestartReminderEmitted`，runtime 只暴露不可替换的只读 getter；
turn-loop 通过 `getRuntimeLifecyclePort(this).consumeRuntimeRestartReminder()` 原子地
「评估即消费」。本批继续把 `sessionTitleGenerationAttempted` 收敛到同一个 owner：
标题 sidecar 在通过配置、会话和首轮输入门槛，且没有 provider headers 延迟时，调用
`consumeSessionTitleGenerationAttempted()`；method 不再读取或写回布尔字段。两个消费端口
都只有一次性消费操作，没有 `set`、`reset` 或布尔值回写路径；重复调用返回 `false`，
因此同一 runtime 实例不会重复启动孤立的标题 sidecar。其余一次性 flag 仍按本节 I4
规则逐项迁移，不能因为本切片已封口而视为整体完成。

Plan 退出提醒也归入同一个 lifecycle owner。它不是由 runtime method 直接写回的普通
布尔字段，而是一个可重新 arm、每次 arm 只能消费一次的 pending token：
`armPlanModeExitReminder()` 只在已提交的 `planEnabled: true → false` 转换完成后调用；
`consumePlanModeExitReminder()` 在非 output-token recovery 的 turn 请求边界原子消费，
重复消费返回 `false`。同一 pending token 消费后，普通 mode/config 更新不会重新 arm；
只有新的 `true → false` 转换才能再次 arm。`false → false`、`false → true`、mode-only
变更及失败/未提交的转换都不能 arm，也不能清除一个已 arm 但尚未消费的 token。该 owner
同时提供只读 `needsPlanModeExitReminder` view，禁止 `AgentRuntimeInternal`、execution-state、
config 或 turn-loop 直接赋值。

`sessionStartHookRan` 也由同一个 owner 保存，并采用显式的 claim → activate/run →
commit 协议。`tryClaimSessionStartHook()` 在成功结果或已有进行中领取时返回 `false`，
因此并发的 resume/startup 不会重复调用 workspace admission 或 Hook runner；只有领取者
可以在 activate 与 Hook runner 都成功后调用 `commitSessionStartHook()`。activate、模型选择
或 Hook runner 抛错时必须调用 `releaseSessionStartHookClaim()`，保持 `sessionStartHookRan`
为 `false` 并允许后续调用重试。领取期间的其他调用直接返回空 Hook 结果，不取得第二个
领取；成功提交后所有后续调用也返回空结果。该旗标同样只读、不可替换，不提供布尔 setter。

后台 Bash 通知封口（I5）也由独立的 `RuntimeNotificationSealOwner` 保存。它只对
`taskType === "subagent_child"` 生效；父 runtime 或普通 runtime 调用 seal 入口时不改变
状态。child 第一次 `sealBackgroundTaskNotifications(reason)` 将 `sealed` 从 `false` 提交
为 `true` 并冻结 `reason`，后续调用是幂等 no-op，不能把 `subagent_terminal` 改回
`subagent_cancelled`（或反之）。`background-notifications` 与 `runtime-tools` 只能通过
只读 view 判断是否封口及读取原因；任何 method 都不能给两个 getter 或 reason 写回。
封口提交是同步的，不等待 registry、store 或子进程，因此不会用超时掩盖状态竞态。

```text
subagent child terminal/cancel path
  → seal port (first commit only)
  → readonly suppression checks
  → Bash/local_bash notification dropped after the seal
```

会话模型选择（I6）由独立的 `RuntimeModelSelectionOwner` 保存。
`sessionModelSelection` 是 resume、配置模型更新、首条持久化和模型准备共同读取的会话
事实；调用方只能通过 `getSessionModelSelection()` 取得防御性副本，或通过
`setSessionModelSelection(selection)` 提交替换/清除。execution-scope 的临时模型只传给
当前 turn，不得写入该 owner。owner 不负责 session store 写入；持久化仍由现有
model-selection service 在 set 成功后执行，因此内存选择与 durable selection 的顺序保持
`set → persist → ModelSelected`。

```text
resume/config/constructor → model-selection owner (clone + commit)
                         → get defensive copy → model preparation / persistence
execution-scope model ────────────────────────┘ (no session mutation)
```

本批（2026-10-09）把 `RuntimeSessionLifecycleState` 的四个剩余扁平字段收敛进 owner：

`shuttingDown` 归入既有 `RuntimeLifecycleOwner`（与其余单调生命周期旗标同一所有者）。
`beginShutdown()` 通过 `commitShutdown()` 提交一次，false → true 幂等，重复调用是
no-op，不存在写回 false 的端口；memory 提取调度、后台通知抑制与 runtime-tools 的读面
只经不可替换的 readonly getter 观察，property 名保持不变，读点无需改动。

完全访问授权（I7）由独立的 `RuntimePermissionGrantOwner` 保存。
`permissionFullAccessPending` 不是一次性旗标，而是 in-flight 互斥 guard：授权路径在
任何队列/模式变更前通过 `tryBeginPermissionFullAccess()` 原子预约，已 pending 时返回
`false`，调用方沿既有语义抛 "Queue mutation is busy; retry approval"；
`pendingInputReservations` / `pendingInputDrains` 的 busy 检查与顺序保持不变。预约发生
在 unpublished grant 的 recover 之后，因此重入的 recover 授权不会被外层自己预约的
guard 拒绝（与迁移前的时序一致）。`endPermissionFullAccess()` 只在授权 finally 中释
放；没有预约时释放是安全 no-op，不引入租约或超时。`lastPermissionGrantId` 归同一个
owner：`setLastPermissionGrantId(id)` 是 replace/clear 语义，调用方不得读-改-写；唯一
写方是 permission-full-access 事务提交后的 applied-grant dedupe 块（写入）与
permission-grant-resume 的恢复/重置路径。v4 bridge 等读面只经 readonly getter 读取。

```text
grant request → busy check（pending / reservations / drains，原顺序）
             → recover unpublished grant（重入授权在此完成）
             → tryBeginPermissionFullAccess()（false → 原 busy 拒绝）
             → 事务提交 → setLastPermissionGrantId（仅首次 applied）
             → finally endPermissionFullAccess()
```

模型切换 timeline（I8）由独立的 `RuntimeModelChangeTimelineOwner` 保存；不并入
lifecycle owner，因为它不是单调旗标而是可替换、可清除的 pending 记录，消费语义
（set/consume）与 I4 的一次性消费不同。`recordPendingModelChange` 同步计算既有的
replace-or-clear 规则后经 `setPendingModelChangeTimeline(timeline | undefined)` 提交；
`persistPendingModelChangeTimeline` 通过 `consumePendingModelChangeTimeline()` 原子地
取出并清空，空时得到 `undefined`。owner 在入库时浅冻结记录：现有路径从不原地修改
存储对象，冻结不改变行为，只阻止未来读面反向改写。

| 状态                                         | 有限写端口                                                         | 唯一调用方与规则                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTurnStartReservation`                 | reserve / release                                                  | `steering.ts`；首次 await 前同步预约；已有 active turn 或 reservation 拒绝；释放只能匹配 turnId，reservation 本体冻结                                                        |
| `runtimeCommandDrainActive`                  | tryAcquire → lease.release                                         | `runtime-command-queue.ts`；同一 runtime 一次只允许一个 drain lease；finally 释放自己持有的 lease，旧 lease 不能释放后来者                                                   |
| `branchGeneration`                           | restoreFromSession / prepareRewind → transition.commitAfterPersist | `resume.ts` 从持久 session 恢复；`rewind-message.ts` 取得下一代转换；串行授权覆盖取消与持久化，成功后推进；不接受任意数字 setter，不回退当前代际，registry 由同一 owner 同步 |
| `backgroundTaskNotificationsSealed` + reason | `RuntimeNotificationSealOwner.seal(reason)`（首次提交）            | `subagent.ts` 的 child terminal/cancel finally；只允许 false → true 一次，reason 首次提交后冻结；读取面只能观察 readonly view                                                |
| `sessionModelSelection`                      | `RuntimeModelSelectionOwner.set(selection)`                        | constructor/resume/config 通过公开 set 入口提交；owner 保存 clone，get 返回 clone；execution-scope 不得写入；store persistence 由调用方负责                          |
| `shuttingDown`                               | `RuntimeLifecycleOwner.commitShutdown()`                           | 仅 `agent-runtime.beginShutdown()`；false → true 幂等提交一次，无写回 false 的端口；memory 提取 / 后台通知 / runtime-tools 读面只经 readonly getter                       |
| `permissionFullAccessPending`                | `RuntimePermissionGrantOwner.tryBeginPermissionFullAccess()` → `endPermissionFullAccess()` | 仅 `permission-full-access.ts`；变更前原子预约，已 pending 时 tryBegin 返回 false 并沿用既有 busy 拒绝；只在 finally 释放，无预约的释放是 no-op                          |
| `lastPermissionGrantId`                      | `RuntimePermissionGrantOwner.setLastPermissionGrantId(id)`         | 仅两处写方：`permission-full-access.ts` 事务提交后的 applied-grant dedupe 块与 `helpers/permission-grant-resume.ts` 的重置/恢复；replace/clear 语义，读面（含 v4 bridge）只读 getter |
| `pendingModelChangeTimeline`                 | `RuntimeModelChangeTimelineOwner.setPendingModelChangeTimeline` / `consumePendingModelChangeTimeline` | 仅 `methods/timeline-persistence.ts`；set 实现 replace-or-clear，consume 原子取出并清空、空时返回 undefined；存储记录浅冻结，读面不能改写                              |

```mermaid
sequenceDiagram
  participant Admission as prompt admission / steering
  participant Owner as 私有 runtime coordinator
  participant Drain as command drain
  participant Store as session persistence
  Admission->>Owner: reserve(turnId)，第一次 await 前
  Admission->>Drain: enqueue 已接受 command
  Drain->>Owner: tryAcquire drain lease
  Drain->>Admission: beginActiveTurn，消费自己的 reservation
  Drain->>Owner: finally 释放自己的 lease
  Note over Owner,Drain: 读面只有 getter；取消只能释放匹配 turnId
  Admission->>Owner: prepareRewind(persisted session)
  Admission->>Owner: transition.commitAfterPersist（取消 / 持久化命令）
  Owner->>Store: 串行授权期间写下一代 revert
  Store-->>Owner: 持久化完成
  Note over Owner: 推进 generation 并同步 registry<br/>并发 restore 等待，旧转换在写入前拒绝
  Note over Owner,Drain: 旧分支 command/event 在持久化与模型注入前仍按 generation fencing
```

分支恢复、rewind 与通知初始化/持久化共用串行写授权。旧 rewind 转换必须在取消任务或写入 revert 前拒绝；授权期间的 restore 等待，避免先把持久行回退、事后才发现内存 generation 已推进。`commitAfterPersist(persist, afterCommit)` 持久成功后先推进 owner/registry，再持有同一授权执行历史重建与 RewindTriggered；重建失败保留已落盘代际，不回滚。`restoreAndHydrate(load, hydrate)` 在授权内读取 session 与 messages，更新 owner 后执行完整恢复与 SessionResumed/hooks；过期 session 快照在重建前拒绝。回调不能重复获取分支授权。

该变更不改变 Desktop continuous / Web replayable 的消息语义，也不移动 Host owner/lease、CommandInbox admission 或任务终态。I4 生命周期一次性旗标与其余字段写权限继续按独立批次治理。

通知持久化规则：background batch 与 subagent message 由同一 owner 的 `persistNotificationIfCurrent(expectedGeneration, persist)` 在取得授权后重新校验代际。通过后，context 初始化、history append、synthetic message/part 与 notification ledger promotion 均处于同一次分支写授权；restore/rewind 在等待期间排队，避免初始化本身越代覆写 context。拒绝返回 null，外层 drain 与 active-loop 不启动模型、不登记消费条目，并沿现有 info 日志留痕。先获授权的通知允许作为旧分支事实完成持久化；排队的分支转换完成后，外层复查仍禁止其启动新模型轮。任务自身终态不被改写。外层恢复的通知批次必须同代际，不能把首项代际当作混合批次授权。

模型注入规则：普通 turn 在首次 await 前捕获当前 generation，传入 loop 与 model request。active-loop 持久化返回后再次检查该 command 代际；实际 `generateText` / `streamText` 调用前（媒体路径投影 await 之后）核对 turn 捕获的代际。分支已变化则按现有 turn cancellation 类型拒绝模型请求，并以 info 记录旧代际丢弃。通知触发的 goal loop 继续携带原 command generation；目标读取、验证模型调用/重试与验证结果返回后仍需复查，禁止重捕获新代际后续跑。验证通过的目标完成写入由同一 owner 的有限提交端口授权，读/写/TargetChanged 在同一分支授权内；旧验证结果不能完成新分支目标。此规则封闭 context、synthetic persistence 和 provider request preparation 的已确认窗口。

恢复快照规则：调用方提供的 `ResumeSessionOptions.persistedMessages` 未绑定代际或消息修订，不能作为重建事实；恢复在分支授权内从 store 重新读取，并返回 `persistedMessagesReloadRequired` 让复用旧数组的上层刷新。该兼容字段保留，代价是这类恢复增加一次权威读取。

目标状态写入规则：`commitTargetStateIfCurrent` 仅授权当前代际的 verifier 完成或取消暂停；包含目标 read/write/event。取消事件的异步发布期间发生换代时，旧 verifier 不得暂停新目标，允许保留旧验证生命周期事件。成功模型用量事实先记录一次，旧代际结果不能再次进入完成/续跑路径。

重入契约：分支授权内会等待 `appendEvent` 的外部 `onSessionEvent` 回调。回调不得 await 同一 runtime 的 resume/rewind/通知持久化或目标状态提交，否则会等待自己持有的授权；当前内置 sink 不执行此重入，不引入超时兜底。

```mermaid
sequenceDiagram
  participant Drain as notification drain / active-loop
  participant Owner as 私有 runtime coordinator
  participant Store as session persistence
  participant Restore as resume / rewind
  participant Model as provider invocation
  Drain->>Owner: persistNotificationIfCurrent(command generation)
  alt 当前分支
    Owner->>Owner: await context initialization（同一授权）
    Owner->>Store: append synthetic message / part / promote ledger
    Restore->>Owner: restore / rewind（等待同一授权）
    Store-->>Owner: persistence completed
    Owner-->>Drain: persisted message
    Owner-->>Restore: 执行下一条分支转换
    Drain->>Drain: 复查 command generation；turn 捕获当前 generation
    Drain->>Model: request preparation awaits
    Model->>Model: invocation 前复查捕获的 generation
  else 已过期
    Owner-->>Drain: null，零 history / store / 模型注入
  end
```

边界：本批保护通知初始化/持久化、resume/rewind 重建和普通 turn 的 provider 调用；没有把整个普通 turn、任意工具内部/compact 模型调用或 adapter 鉴权/重试后的 HTTP 发送纳入全程事务。已经发出的 provider 请求、旧任务终态与已有持久历史仍遵循原有取消和恢复语义，不宣称所有 runtime 状态均已封装。

## CLI-05 P1 第一切片：RuntimeTurnState 高频时序字段收敛（2026-10-22，review R1-01）

### 根因

`methods/` 下约 180 个函数经 `installAgentRuntimeMethods`（`methods/index.ts:203-398`）以
`proto.X = X` 动态挂到 `AgentRuntime.prototype`，签名一律 `this: AgentRuntimeInternal`。
该类型（`internal.ts:240-251`）组合全部 7 簇，含 `RuntimeTurnState` 的扁平可写字段。即便
reservation/drain/generation 已收敛到 turn-coordination owner，`this` 面仍让任意 method 能
读写 `turnNumber`/`activeTurn`/`pendingInput*`/`queue*Drain*` 等时序字段——owner 只读约束对其余
字段无效。这是本轮唯一 P1。

### 本切片范围（有界，不做全量重构）

把 `RuntimeTurnState` 的 7 个高频时序字段迁到新的 `RuntimeTurnTimingOwner`
（`runtime-turn-timing.ts`），形态与既有 owner 完全一致：WeakMap 持有真值、构造期用
`Object.defineProperty` 装只读 getter（无 setter、`configurable:false`）、写面只经
`getRuntimeTurnTimingPort(this)` 的有限端口。读面（`this.turnNumber`、
`this.pendingInputReservations.has(...)` 等）保持不变，只把**赋值/增删点**改为端口调用，行为逐点等价。

| 字段 | 有限写端口 | 唯一调用方与规则 |
| --- | --- | --- |
| `turnNumber` | `advanceTurn()` / `setTurnNumber(n)` | turn/compact/rewind/control-only-turn 完成推进用 `advanceTurn`；resume/rewind-message 从持久消息数重建用 `setTurnNumber`（整体替换，非自增） |
| `activeTurn` | `setActiveTurn(t)` / `clearActiveTurn()` | `steering.beginActiveTurn` 建立、`finishActiveTurn` 清除；owner 保存引用**不冻结**（pendingInputs 数组仍由 steering 原地 splice/push，本切片只收窄整体赋值/清除）；读面 identity 比较（`this.activeTurn === options.activeTurn`）不变 |
| `pendingInputSequence` | `nextPendingInputSequence()` | `steering.createPendingInputId` 自增铸造 pending id（原 `+=1` 后读取的原子化） |
| `pendingInputReservations` | `reservePendingInput(id,resId)` / `releasePendingInputReservation(id)` | steering 的 sendQueuedNow 预约/释放/撤销；读面 `size/has/get` 不变（返回 ReadonlyMap）；缺键 release 是 no-op |
| `pendingInputDrains` | `beginPendingInputDrain()` / `endPendingInputDrain()` | `steering.drainPendingInput` 的 try/finally 配对；owner 用 0 表示无 in-flight，读面映射回 `undefined`（迁移前 `number \| undefined` 语义不变） |
| `queueAutoDrain` + `queueExternalDrainActive` | `applyQueueAutoDrainChange(autoDrain)` / `pauseQueueAutoDrain()` / `completeExternalQueueDrain()` | `applyQueueAutoDrainChange` = v4 `setQueueAutoDrain`（原三写点等价：false→true 打开外层 FIFO 窗口、→false 关闭、autoDrain 赋值）；`pauseQueueAutoDrain` = turn 失败/取消同步（compact.ts / turn.ts 的成对 `queueAutoDrain=false; queueExternalDrainActive=false`）；`completeExternalQueueDrain` = CLI 投影确认队列已空 |

### 事件顺序（turn 时序字段所有者）

```text
构造期  AgentRuntime ctor → initializeRuntimeTurnTiming(runtime)
                          → 装只读 getter（turnNumber/activeTurn/pendingInput*/queue*Drain*）
                          → owner 缺省：turnNumber=0, activeTurn=undefined,
                                        pendingInputSequence=0, reservations=∅, drains=0(undefined),
                                        queueAutoDrain=true, queueExternalDrainActive=false

turn 编排（唯一写入方）
  steering.beginActiveTurn → reservationPort.release(turnId) → timingPort.setActiveTurn(turn)
  steering.finishActiveTurn → (identity 命中) timingPort.clearActiveTurn()
  steering.createPendingInputId → timingPort.nextPendingInputSequence()
  steering.drainPendingInput → timingPort.beginPendingInputDrain() … finally endPendingInputDrain()
  steering.reserve/releasePendingInput → timingPort.reserve/releasePendingInputReservation()
  turn/compact/rewind/control-only-turn 完成 → timingPort.advanceTurn()
  resume/rewind-message 重建 → timingPort.setTurnNumber(持久消息数)
  steering.setQueueAutoDrain → timingPort.applyQueueAutoDrainChange(autoDrain)
  turn 失败/取消同步 → timingPort.pauseQueueAutoDrain()
  CLI completeExternalQueueDrain → timingPort.completeExternalQueueDrain()

读面（不变）  methods/* 经 this.<field> 只读；任何 this.<field> = … 运行时抛 TypeError、tsc 报 readonly
```

### 验收（本切片）

- 非 owner 的 `AgentRuntimeInternal` writer 在 TypeScript 编译中不能赋值这 7 个字段；负例并入
  `tests/runtime-state-ownership.test.mjs` 的「TypeScript rejects direct state writers」用例
  （真实 tsc checker，diagnostics 计数从 11→18、readonly 违例 2540 从 10→17）。
- 真实 `AgentRuntime` 的 7 个 getter 不可赋值/不可重定义（并入「non-writable, non-replaceable
  state getters」清单）；owner 端口行为由新增用例「turn timing fields are owned by a finite write
  port」钉住（advanceTurn/setTurnNumber、set/clear activeTurn、序号自增、reserve/release、
  drain 计数、queueAutoDrain 三转换）。
- **机械门禁**（review §2 P1 验收项，钉住「原型注入面失控」）：新增用例「R1-01 gate: every
  proto-injected method is declared on the AgentRuntime type surface」——用 tsc 取
  `AgentRuntime`（class + declaration-merged interface）与 `AgentRuntimeInternal` 的实例成员并集，
  断言 `AgentRuntime.prototype` 的自有键（`installAgentRuntimeMethods` + `installAutoResumeRuntimeMethods`
  注入面）全部落在该并集内；出现 proto 上未声明的方法即红。
- 行为不变：迁移点的既有回归全绿——core 包 130/130、runtime-state-ownership 31/31、
  cron-idle-trigger / compact-invariants / queue-guide-fellback / steering 相关 36/36。
  用 fake-runtime 桩直接调真实 `beginActiveTurn`/`setQueueAutoDrain` 的既有测试
  （compact-invariants、cron-idle-trigger）在桩上补 `initializeRuntimeTurnTiming`（与真实构造期一致）。

## R1-01 批次 B1：CacheDiagnostics + 派生游标（2026-10-28）

**字段**（6 个）：D1 `mainTurnCacheHitAggregate`、D2 `pendingCacheMissCause`、D3 `cacheMissCauseCounts`、D4 `autoCompactConsecutiveFailures`、迁入 M4 `lastRequestModelId`（从 MessageProjection 拆出）、迁入 T5 `lastAssistantCompletedAtMs`（从 TurnState 剩余拆出）。

**Owner**：`runtime-cache-diagnostics.ts`（`RuntimeCacheDiagnosticsOwner`），形态与 `runtime-turn-timing.ts` 完全一致——WeakMap 持有真值、构造期 `Object.defineProperty` 装只读 getter（无 setter、`configurable:false`）、写面只经 `getRuntimeCacheDiagnosticsPort(this)` 的有限端口。

**端口形态**：

| 端口 | 语义 | 唯一调用方 |
| --- | --- | --- |
| `recordAssistantCompleted(atMs)` | turn 完成时推进 `lastAssistantCompletedAtMs` | `turn-model-step.ts:661`（原 `this.lastAssistantCompletedAtMs = Date.now()`） |
| `recordMainTurnUsage(input)` | 原子事务：聚合累计 + miss 计数累计 + pending 消费即清 + `lastRequestModelId` 更新 | `turn-model-step-usage.ts:138-174`（原 5 个字段的扁平读写） |
| `setPendingCacheMissCause(cause)` | 显式事件点写入 pending（compaction / control_only_turn / context_refresh / conversation_rewind） | `compact-active.ts:771`、`microcompact.ts:81`、`control-only-turn.ts:116`、`context-refresh.ts:47`、`rewind-message.ts:742` |
| `clearPendingCacheMissCause()` | resume 重建后清空 pending | `resume.ts:240` |
| `consumePendingCacheMissCause()` | 原子「读 + 清」（供 resolveCacheMissCause 归因消费） | `turn-model-step-usage.ts`（内部） |
| `peekPendingCacheMissCause()` / `peekLastRequestModelId()` / `peekLastAssistantCompletedAtMs()` | 只读快照（resolveCacheMissCause 归因输入，不消费） | `turn-model-step-usage.ts`（内部） |
| `resetMainTurnCacheHitAggregate(aggregate)` | resume/rewind 从持久消息反推重建聚合 | `resume.ts:233`、`rewind-message.ts:744` |
| `resetCacheMissCauseCounts()` | resume/rewind 重建后清空 miss 计数（不可从持久 tokens 重建，spec R3 诚实边界） | `resume.ts:239`、`rewind-message.ts:743` |
| `resetAutoCompactFailures()` | compact 成功后重置失败计数为 0 | `compact.ts:305,460`、`rewind-message.ts:753` |
| `recordAutoCompactFailure()` | compact 失败后计数 ++ 并返回新值（用于日志） | `compact.ts:320,473` |
| `restoreLastAssistantCompletedAtMs(atMs)` | resume/rewind 从 latest assistant 消息时间反推 | `resume.ts:197`、`rewind-message.ts:735` |

**关键设计**：`recordMainTurnUsage` 是 6 字段中事务密度最高的端口——`resolveCacheMissCause`（`turn-model-step-usage.ts:185-204`）把 `pendingCacheMissCause` / `lastRequestModelId` / `lastAssistantCompletedAtMs` 作为**同一归因事务的输入**读取；`recordMainTurnUsage` 同时写 D1/D2/D3/M4。分 owner 会切开原子性，故 6 字段必须同一 owner 持有。

**验收**：
- 负向 tsc 诊断数 18 → 24（+6 字段的 readonly 违例）；
- 运行时拒写与端口冻结由「cache diagnostics fields are owned by a finite write port」用例钉住；
- 既有 cache 归因测试套件（`prompt-cache-diagnostics.test.mjs` 9/9）全绿，fake-runtime 桩同步迁移到「先 `initializeRuntimeCacheDiagnostics` + 端口回放 overrides」形态；
- R1/R3 事件点与重建复位守护的源码字符串断言同步换成端口调用形式（不变量本身不变）。

## RuntimeTurnState 剩余字段与后续批次

本切片**未**迁移 `RuntimeTurnState` 的其余扁平可写字段，它们仍经 `this` 面共享读写，登记为后续批次：

| 剩余字段 | 语义 | 建议后续批次顺序 |
| --- | --- | --- |
| `activeForegroundExecution` | 前台执行状态（stop barrier、preserveQueueAutoDrainOnCancel） | 批次 2（与 foregroundPromotionLease 同族） |
| `foregroundPromotionLease` | sendQueuedNow 的 Core 调度权 | 批次 2 |
| `runtimeCommandQueue` | 命令队列实例（容器本身不变，内容经 queue 端口） | 批次 3（评估：可能只需 readonly 化引用） |
| `currentTurnFileChanges` | turn 内文件改动图 | 批次 3 |
| ~~`lastAssistantCompletedAtMs`~~ | 最近 assistant 完成时间戳 | **已迁出**（R1-01 B1，归 RuntimeCacheDiagnosticsOwner） |

其余 4 簇（`RuntimeContextMemoryState` / `RuntimeMessageProjectionState` / `RuntimeCacheDiagnosticsState`
以及 `RuntimeTurnState` 上述剩余）28 个扁平字段（ContextMemory 19 + MessageProjection 5 +
CacheDiagnostics 4；含 TurnState 剩余 5 个则共 33），按「时序不变量密度」优先级分批：TurnState 剩余 →
ContextMemory（并发初始化最密）→ MessageProjection/CacheDiagnostics（派生游标，最低优先）。
**2026-10-28 更新**：R1-01 B1 已完成 CacheDiagnostics 4 字段 + 迁入 `lastRequestModelId`（MessageProjection）
+ `lastAssistantCompletedAtMs`（TurnState 剩余）共 6 字段；剩余 27 个扁平字段（ContextMemory 19 +
MessageProjection 4 + TurnState 剩余 4）。

**长期方案（review R1-01 建议，本切片未做，需单独立项）**：把「原型注入 + `this: AgentRuntimeInternal`」
换为**显式组合**——构造期把方法绑到实例或委托对象，使 `this` 面不再等于全字段并集。这是根治 P1 的
唯一路径（owner getter 只能收窄写权限，无法阻止 `this` 面读越权），但会触及约 180 个方法的签名与
declaration-merging 结构，属不可一次验证的大重构，必须独立立项、分批推进、每批配负例与门禁。
在此之前，owner + 只读 getter + 有限写端口 + R1-01 机械门禁共同把「写权限失控」和「注入面失控」
两条风险钉住。

## 簇 → 唯一写入方

| 簇                            | 写入方                                                                             | 可变性                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| RuntimeIdentityConfig         | 构造函数                                                                           | 不可变                                                   |
| RuntimeInjectedDeps           | 构造函数（deps 注入，无 late binding）                                             | 不可变（Set/Map 容器内容除外，容器所有者见各 port 契约） |
| RuntimeContextMemoryState     | methods/context-\*、memory 提取/召回 helpers、MCP 启动路径                         | 会话内可变                                               |
| RuntimeTurnState              | turn 编排路径（methods/turn.ts、methods/prompt-admission.ts、command-queue drain） | turn 内高频可变——**时序不变量最密集**                    |
| RuntimeMessageProjectionState | 事件发布/reducer 路径                                                              | 派生游标                                                 |
| RuntimeCacheDiagnosticsState  | 模型请求路径                                                                       | 进程内累计，resume/rewind 后重置                         |
| RuntimeSessionLifecycleState  | 各一次性 flag 的消费点（评估即消费）                                               | 单调旗标                                                 |

新增字段必须归入一个簇并写明唯一写入方；无法归簇 = 所有权不清，先对齐再落码（根 AGENTS.md「明确唯一所有者」）。

## 不变量登记（当前为注释/测试钉住，断言化候选）

| #   | 不变量                                                                                                                                                                                                     | 现状载体                                                                           | 断言化落点（后续批次）                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | `activeTurnStartReservation` 建立前不得出现第二条 turn（reservation 建立前的异步窗口会产生双 turn）                                                                                                        | 私有 owner 的同步 reserve / turnId release                                         | 真实 runtime 的并发 admission、取消后再次 admission；getter 与 reservation 不可写                                                                                                                                                                                      |
| I2  | `runtimeCommandDrainActive` 期间不得重入 drain                                                                                                                                                             | 私有 owner 的 drain lease                                                          | 真正 drain 等待期间并发 drain 不重复执行；释放后队列继续；迟到 release 不释放新 lease                                                                                                                                                                                  |
| I3  | `branchGeneration` 单调递增；resume/rewind 后旧分支写入必须被拒                                                                                                                                            | 私有 owner 的持久恢复与下一代 transition                                           | 持久恢复/rewind 更新 registry；旧 branch 通知拒绝、任务自身终态仍可观察                                                                                                                                                                                                |
| I4  | 一次性/单调 flag（`runtimeRestartReminderEmitted`、`sessionTitleGenerationAttempted`、`sessionStartHookRan`、`shuttingDown` 等）只能由 owner 消费/提交，不得回写 false；`shuttingDown` 只经 `commitShutdown()` false→true 幂等提交一次；进行中的 session-start claim 只能有一个，失败必须可重试 | `runtime-lifecycle.ts` owner + 各 flag spec（runtime-restart-task-reminder R3 等） | 已完成：重启提醒与 session title 使用不可替换消费 port；session-start 使用 claim/commit/release port，并由并发与失败重试测试钉住；Plan 退出提醒使用 `true→false` arm + 一次性 consume，重复/并发消费和再次转换由行为测试钉住；`shuttingDown` 由 `beginShutdown()` 提交、重复 commit 与直接赋值由行为测试钉住；其余 flag 继续按相同 owner/port 规则迁移 |
| I5  | subagent child 的后台 Bash 通知只能在 terminal/cancel 后封口一次；reason 与封口状态保持一致，普通 runtime 不受影响                                                                                         | `runtime-notification-seal.ts` 的 `RuntimeNotificationSealOwner` + seal port       | child 首次 seal 提交并冻结 reason；重复 seal、非 child seal、readonly getter/直接赋值和 Bash/local_bash suppression 按行为测试钉住                                                                                                                                     |
| I6  | session model selection 只能由 owner 通过 clone-safe set/get 访问；execution-scope 模型不覆盖 session 事实，直接 writer 必须被拒                                                                                     | `runtime-model-selection.ts` 的 `RuntimeModelSelectionOwner` + model selection port | constructor/resume/config set/get 与输入变更行为；输入/读取副本不可反向修改；execution-scope 和 clear 语义；TypeScript readonly 负例                                                                                                                                    |
| I7  | 完全访问授权必须先经 `tryBeginPermissionFullAccess()` 原子预约再变更队列/模式；busy 拒绝语义与检查顺序（pending / reservations / drains）不变；释放只在授权 finally（`endPermissionFullAccess()`），无预约释放是 no-op；`lastPermissionGrantId` 只能由 permission-full-access 与 permission-grant-resume 两处写方经 `setLastPermissionGrantId` 替换/清除 | `runtime-permission-grant.ts` 的 `RuntimePermissionGrantOwner` + grant port | 双并发授权只预约一个、第二个得到既有 busy 拒绝；重入 recover 不被外层预约拒绝；tryBegin/end 配对与无预约 end 的 no-op、set/clear 与 readonly getter 由行为测试钉住；TypeScript readonly 负例 |
| I8  | `pendingModelChangeTimeline` 只能经 set/consume 端口写入；consume 即取出并清空，空时返回 `undefined`；replace-or-clear 规则保持在 `recordPendingModelChange`；存储记录浅冻结，读面不能改写 | `runtime-model-change-timeline.ts` 的 `RuntimeModelChangeTimelineOwner` + timeline port | 二次 consume 返回 undefined；from/to 相同的记录被清除；直接赋值在 TypeScript 与运行时 getter 上均被拒 |

后续断言化批次要求：每条断言先有对应的不变量测试（真实 runtime + 桩端口），再上 dev-only 断言（生产路径不抛），避免把时序 bug 变成线上崩溃。本批 getter 和有限端口是结构性写权限收窄，复用已有 reservation 拒绝，不增加轮询或超时同步。

## 验收（本批次）

- 非 owner 的 `AgentRuntimeInternal` writer 在 TypeScript 编译中不能赋值三个字段，也不能改 reservation.turnId；负例由真实 TypeScript checker 验证。
- 真实 AgentRuntime 的 getter 不能被赋值或替换；并发 admission、取消释放、drain lease、分支恢复与旧通知 fencing 按上表行为验证。
- session-start hook 的并发调用只允许一次 activate/runner；activate 失败释放 claim，下一次调用可以重试，成功后 commit 并永久跳过。
- child runtime 首次 seal 后，Bash 与 `local_bash` 通知被抑制，重复 seal 不改变首次 reason；非 child runtime 的 seal 调用不改变 sealed/reason；非 owner writer 在 TypeScript 与运行时 getter 上均被拒绝。
- session model selection 的 owner 在 set/get 时复制 selection；修改调用方或 getter 返回值不会改变 owner；execution-scope model preparation 不调用 set；clear 后 getter 为 `undefined`，直接 writer 在 TypeScript 与运行时 getter 上均被拒绝。
- `shuttingDown` 由真实 runtime 的 `beginShutdown()` 提交一次；第二次 `commitShutdown()` 是幂等 no-op；getter 不能直接赋值或重定义，读面（memory 提取 / 后台通知 / runtime-tools）行为不变。
- `tryBeginPermissionFullAccess()` 已预约时返回 `false`，授权路径沿用既有 "Queue mutation is busy" 拒绝；`endPermissionFullAccess()` 释放后可再次预约，无预约的释放是 no-op；`lastPermissionGrantId` 只能经 `setLastPermissionGrantId` 替换/清除，getter 只读、不可替换。
- `pendingModelChangeTimeline` 的 `consumePendingModelChangeTimeline()` 第二次返回 `undefined`；等价 from/to 的记录被 `setPendingModelChangeTimeline(undefined)` 清除；存储记录被冻结，直接赋值在 TypeScript 与运行时 getter 上均被拒绝。
- 使用受控 await 验证通知等待分支转换时，换代后零 context 初始化、零 append、零 ledger promotion、零模型轮；先获授权的 context/synthetic persistence 期间 restore 必须等待，随后换代不启动旧模型轮、active-loop 返回零消费条目。resume/rewind 重建期间新代际通知必须等待；turn/provider 准备等待后换代不调用 generate/stream。
- 实际执行当前可用的 admission/cancel/rewind/background 相关回归与 core 类型、Lint、架构检查，如实记录结果，不沿用第一批旧测试数量。
