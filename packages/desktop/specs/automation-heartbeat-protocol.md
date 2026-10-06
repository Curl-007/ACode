# Spec（草案·待审）：Automation Heartbeat 通知决策协议

> 状态：**草案**，供所有者审阅后实施（`docs/capability-uplift-plan.md` 批次 1 C2）。
> 机制来源：zoode 对 Codex desktop heartbeat 协议的研究产出（强制单个 NOTIFY/DONT_NOTIFY
> 决策、默认安静、过期自删）。按边界纪律只搬运机制设计，实现为 ACode 自有代码。

## 背景

### 已核实的现状（dev/0.0.2）

- **终态无条件标未读**：`packages/desktop/src/host/index.ts` 的 run 终态订阅回调里，
  `settleCronRunTerminalOutcome` 之后固定执行 `setTaskUnread({..., unread: true})`
  （注释原文「定时任务在后台完成后统一置为未读」）。每次触发都产生未读红点，
  高频 automation 造成通知刷屏；「触发完成」本身被当成了通知理由。
- **Bot 回推与未读是两条独立通道**：`cronBotDelivery.ts#watchCronRunBotDelivery`
  在派发前订阅（防快速任务漏推），只要有 `botDeliveryTarget` 就回推终态，同样无决策门。
- **无过期清理**：`automationService.ts` 在 endAt/maxRuns 耗尽时置
  `lifecycleStatus:"completed"` 并持久保留；删除只有显式 `delete()`。
  `automationRepo.ts#pruneRuns(maxAgeMs)`（「删除超过 maxAgeMs 的历史 run」）
  **零调用方，是死代码**。且 `AUTOMATION_CREATE_LIMIT = 20` 计数**含所有生命周期状态**
  （`automation-types.ts:9-10`）——僵尸 completed automation 永久占用创建额度。
- **数据模型无通知字段**：`ACodeAutomation` / `ACodeAutomationRun`
  （`packages/shared/src/automation-types.ts`）均无通知决策相关成员。
- **run 级作用域锚点已存在**：派发的 prompt 以 `runId` 为 traceId
  （`host/index.ts` `const promptTraceId = request.runId as TraceId`），终态回调按
  `result.inputId === params.traceId` 过滤——通知决策的解析天然可按 run 定位，
  绑定任务（targetTaskId 复投同一 task）多 run 共存也不串扰。
- **无关同名词**：`cronRunLifecycle.ts` 的 `MANUAL_CLAIM_HEARTBEAT_MS` 是 manual 触发
  的 claim 租约保活，与本协议无关，不动。

### 目标

把「触发完成 = 通知」改为「**模型对每次 run 显式裁决是否值得通知，默认安静**」，
并给僵尸 automation / run 台账建立清理路径。

## 产品规则

### R1 默认安静（default-quiet）

- 定时/手动触发本身不构成通知理由。run 成功终态**不再无条件** `setTaskUnread(true)`；
  仅当本次 run 的通知决策为 `notify` 时才标未读。
- 失败终态（`outcome:"failed"`）**恒标未读**：这是系统级事实，不问模型
  （automation 坏了用户必须知道；与 Codex「确定性规则先于模型裁决」同哲学）。
- `stopped`（用户中止）安静。**实施批次修正**：V4 终态映射从不产出 `stopped`
  （interrupted → `turn.completed` → `succeeded`，`acodeTaskIndexSyncer.ts:84-85`），
  该分支当前不可达，保留语义定义、不做专门测试。
- **第二个未读写入方必须同批设门（实施批次修正，侦察障碍 A）**：host settle 的
  `setTaskUnread(true)` 不是唯一自动未读来源——syncer 对每个后台终态附
  `unreadSignal:"background_terminal"`（`acodeTaskIndexSyncer.ts#resolveTerminalUnreadSignal`），
  UI 侧 `taskStatusUnreadSync.ts` 见信号即对非活动任务写未读。只改 host 侧红点照旧。
  门控落在**信号源头**（syncer `applyTerminalTransition`）：`applyAgentPatch` 返回的
  taskMeta 满足 `isCronTask`（`cronAutomationId || automationId`，
  `packages/shared/src/acode-task-types.ts`）时不附 `unreadSignal`——automation 任务的
  未读归 host 决策点唯一所有，UI 侧无需改动（无信号即无动作）。
- **已登记边界（bound task）**：`targetTaskId` 复投的普通聊天任务，其 taskMeta 不带
  automation 标记，syncer 无法区分「本轮终态是 automation run 还是用户自己的 turn」，
  该子路径保持既有聊天任务未读行为（host 侧跳过仍生效，但 UI 信号路径不门控）。
  彻底解决需要 turn 级 attribution 进 task index，登记为后续项，不在本批。

### R2 决策协议（派发注入 + 终态解析）

- **注入**：`dispatchCronRun` 发送 prompt 时，在 automation prompt 之后拼接 host 常量
  指令段（英文，遵守 `prompt-language-policy`），要求最终回复**恰好一个**决策标签：
  `<automation-notice>NOTIFY</automation-notice>` 或 `<automation-notice>DONT_NOTIFY</automation-notice>`。
  指令文本是 host 侧常量，**不是**第二条可被 automation 作者覆写的指令源；作者 prompt
  原文保持在前、语义不被改写。
- **解析（实施批次修正，侦察障碍 B）**：不存在按 inputId/traceId 作用域的消息**读取**
  API（`ACodePersistedMessage` 无 trace/input 标记；`getModelTrajectory.traceId` 是会话根
  trace 而非 runId；V4 `turn.completed.response` 文本被终态映射丢弃）。落地方式改为
  **流式累积**：`trackCronRunOutcome` 在既有终态订阅之外，同窗订阅
  `onDynamicStreamEvent(taskId)`，仅累积 `type==="agent_message_chunk"` 且
  `inputId===runId`（派发 prompt 的 traceId=runId，adapter 已对齐事件 inputId）且
  `!parentToolUseId`（主 agent 正文）的 chunk 文本，滚动保留尾部
  `AUTOMATION_NOTICE_BUFFER_MAX_CHARS`（8 KB，决策标签在最终回复末尾，尾部足够且有界）。
  终态时对尾部缓冲跑共享纯函数解析。该机制与 bots 侧既有 `assistantParts` 累积同源。
- **fail-safe**：决策缺失 / 非法 / 多于一个 → 按 `dont_notify` 处理并记
  `notifyDecision:"absent"` + warn 日志。宁漏一次红点，不让刷屏回潮。
  解析取**最后一个**合法标签（`parseAutomationNotice` last-match 语义），多标签不崩溃。

### R3 Bot 回推与未读同源

- **实施批次修正（侦察障碍 C）**：bot watch 原本无 runId，且其推送触发在 stream
  `task_complete`，早于 host 台账写入——「bot 读台账」方案有竞态且缺 runId。裁决采用
  **共享纯函数、两处评估**：解析器 `parseAutomationNotice` 与指令常量归口
  `packages/shared`（automation 领域词汇唯一家），host settle 与 bots 终态各自对
  **自己累积的本 run 文本尾部**评估同一函数——语义单一来源，评估点两个，无跨进程
  台账读取、无竞态。`BotAutomationRunWatchParams` 增 `runId`，host 的
  `watchCronRunBotDelivery` 调用点透传。
- 回推规则：`notify` 回推、`dont_notify`/`absent` 不回推、`task_error`（失败）恒回推
  （与 R1 一致）。Bot 用户与桌面用户看到同一个「值不值得打扰」判定。
- 普通聊天任务的 bot watch（无 automation 上下文）行为完全不变。
- 回推仍为 best-effort（既有纪律：订阅/凭据失败不阻断派发与结算）。

### R4 决策持久化（run 台账）

- `ACodeAutomationRun` 增可选 `notifyDecision?: "notify" | "dont_notify" | "absent"`；
  sqlite 列 `notify_decision text` nullable。
- **实施批次修正（侦察障碍 E）**：tasks-index.sqlite 的迁移账本是
  `tasks_schema_migration`（当前最后 id `0003_official_glm_selection`）。0001 的
  `columns` 冻结列表是 checksum 输入，**不得追加**（会令全部既有 DB checksum 失配）；
  正确形态是新增 `0004_automation_notify_decision` 定义（冻结 SQL 常量同时作
  checksumInput，仿 0003），并把迁移 body 分派的 else 直通改为显式 else-if + fail-loud。
- **重试复位**：`upsertRunClaimed` 的 `ON CONFLICT(run_id) DO UPDATE` 分支已复位
  `outcome/error`，必须同批复位 `notify_decision = NULL`（同轮重试不得继承上次决策）。
- 写入路径：`markRunOutcome(runId, outcome, error?, notifyDecision?)`（`COALESCE` 写，
  仅 settle 提供；`running` 起始写不触碰）。
- 所有者唯一：`automationRepo` run 台账。UI/诊断只读投影，不落第二份状态。

### R5 过期自清

- **(a) run 历史台账**：`pruneRuns` 接上调用方——**scheduler utility process 的
  `main()` 启动序列**（`packages/desktop/src/scheduler/index.ts`，紧随
  `repo.ensureReady()`，与既有 `offPeakRepo.recoverInterrupted` 同款一次性启动清理；
  scheduler 是 app 单例、纯 DB 进程，host 是 per-window，故归属 scheduler）。
  保留窗口 `AUTOMATION_RUN_HISTORY_RETENTION_MS`（30 天，归口
  `packages/shared/src/automation-types.ts`）。
- **(b) 耗尽 automation 保留策略**：repo 新增
  `pruneExhaustedAutomations(maxAgeMs)`——单条 SQL 删
  `lifecycle_status='completed' AND updated_at < cutoff`（`failed` 终态**不**自动删，
  用户要能看到坏掉的任务；`active/paused` 不删）。窗口
  `AUTOMATION_EXHAUSTED_RETENTION_MS`（7 天，Q1 裁决）。同一启动清理执行，释放
  `AUTOMATION_CREATE_LIMIT` 额度。
- **孤儿 run 说明（侦察障碍 F）**：`repo.delete` 不级联 `automation_runs`（无外键），
  (b) 删除的 automation 其历史 run 行由 (a) 的窗口清扫——两步在同一启动序列，顺序
  无依赖（都以各自时间窗判定）。

### R6 双链路语义（AGENTS.md 要求显式区分）

- 决策与未读都发生在 **host 侧 settle 路径**（desktop-continuous 实时链路）。
- web-remote-replayable 回放链路只重放既有事件/台账，**不重新评估决策**：远端看到的
  未读状态来自 host 写入的事实，回放侧无独立判定。
- off-peak 任务的终态是否与 cron 共用本订阅路径：**实施前核实**（Q4）；若不同源，
  off-peak 接入登记为后续项，本 spec 不隐式覆盖。

### R7 工具面文案同步

- **实施批次修正（侦察障碍 G/H）**：`CronCreate` 描述补一句：运行时会在派发的
  prompt 末尾自动追加通知决策协议，作者无需（也不应）自带 NOTIFY 指令。
  **`OffPeakCreate` 本轮不改**——off-peak 是独立 settle 链路（Q4 裁决：后续项），
  其派发路径没有注入协议，改描述会说假话。
- **同批修正既有矛盾句**：`cron.ts` CronCreate modelInstructions 的
  「Finite automations become completed and retain their history; they are not
  session-only or auto-deleted.」与 R5(b) 自动清理直接矛盾，改为如实描述
  （completed 历史保留 7 天后自动清理）。
- 文本恒英文（`prompt-language-policy`）。golden 快照核查已完成：无任何
  snapshot/golden/prompt-manifest 钉住 CronCreate/CronUpdate/OffPeakCreate 描述
  （manifest 0 处 CronCreate；SECTION_GOLDEN 只覆盖 session-guidance 段），
  零测试需随描述改动更新。

## 状态所有者与事件顺序

```
scheduler(utilityProcess) 触发 / 手动 Run now
   │
   ├─ dispatchCronRun（host）
   │    ├─ createTask 或 resumeTask(绑定 task)          ← targetTaskId 路径不变
   │    ├─ watchCronRunBotDelivery（派发前订阅，既有）     ← R3 决策门在回推处生效
   │    └─ sendPrompt(作者 prompt + host 决策指令段)      ← R2 注入点，traceId=runId
   │
   └─ onDynamicTaskTerminalOutcome(taskId) 按 inputId==runId 过滤（既有）
        ├─ settleCronRunTerminalOutcome → run 台账写 outcome + notifyDecision   ← R4 唯一所有者
        ├─ 决策=notify 或 outcome=failed → setTaskUnread(true)；否则跳过        ← R1
        └─ 启动清理（低频）：pruneRuns(窗口) + 耗尽 automation 过期删除          ← R5

唯一事实源：automationRepo（automation + run 台账）。UI 未读、Bot 回推、诊断展示
都是台账/决策的只读投影；不存在第二条通知判定路径。
```

## 接口

- `packages/shared/src/automation-types.ts`：`ACodeAutomationRun.notifyDecision?`（R4）。
- 终态回调改造（R1/R2/R3 执行点）与 `dispatchCronRun` prompt 拼接（R2 注入点，指令文本为
  host 常量）：原落点 `packages/desktop/src/host/index.ts`，2026-10-05 host 领域拆分后
  位于 `packages/desktop/src/host/cronRunDispatch.ts`（派发/注入）与
  `packages/desktop/src/host/cronRunTracking.ts`（终态回调/订阅追踪）；守护测试
  `tests/automation-heartbeat-protocol.test.mjs` 的扫描目标已同步迁移。
- `packages/desktop/src/host/cronRunLifecycle.ts`（或同目录新模块）：决策解析纯函数
  `parseAutomationNotice(messageText): "notify" | "dont_notify" | "absent"`——纯函数、
  无 IO，可单测。
- `packages/services/src/session/automationRepo`：`notify_decision` 列 migration +
  写入/读回；`pruneRuns` 调用方接入（R5a）；耗尽 automation 清理查询（R5b）。
- 不改：runId 契约（`parseAutomationRunId` 唯一解析入口）、claim 租约语义、
  `offPeakDispatchPlan` 的 resume/bound-first-run/init 分支。

## 验收场景

1. **默认安静**：成功的 schedule run、模型未输出决策标签 → 不标未读、台账
   `notifyDecision:"absent"`、warn 日志一条。
2. **NOTIFY**：最终消息含 `<automation-notice>NOTIFY</automation-notice>` → 标未读；
   DONT_NOTIFY → 不标。多标签/非法值 → 按 absent fail-safe。
3. **失败恒通知**：`outcome:"failed"` → 无论决策如何都标未读且 Bot 回推。
4. **绑定任务多 run 不串扰**：同一 targetTaskId 连跑两次，第一次 NOTIFY、第二次
   DONT_NOTIFY → 只有第一次标未读（按 traceId=runId 作用域解析）。
5. **Bot 同源**：notify run 回推、dont_notify run 不回推、failed run 回推。
6. **台账兼容**：旧 DB 升级后历史 run `notify_decision` 为 null、读回等价
   `absent`；回滚旧代码忽略新列读写正常。
7. **R5 清理**：pruneRuns 有调用方（启动后窗口外 run 台账被清）；耗尽且过保留期的
   automation 被删、额度释放；保留期内不删。
8. **不变量守护测试**（仿 no-telemetry 模式）：终态回调源码不再含无条件
   `unread: true`；决策解析纯函数的 fail-safe 分支全覆盖；工具描述 golden 快照更新。
9. **验证命令**：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check -- --changed`、
   新增 host/services 测试 + `pnpm dev:desktop` 手测（建高频 automation 观察未读行为；
   桌面与手机远控两种语义各验一遍）。

## 不在本 spec 范围

- 通知的 UI 呈现形态改造（红点/列表样式）——沿用既有未读机制。
- automation 作者自定义通知策略（per-automation notify 配置面）——先验证协议本身，
  配置面是后续产品项。
- scheduler 触发/重试/租约逻辑——零改动。

## 开放问题裁决记录（2026-10-03，所有者批复「按建议」）

- **Q1 耗尽 automation 保留窗口**：7 天自动删除；**暂不做 per-automation opt-out**
  （最小面；后续出现真实需求再加 `keepHistory`，见「不在本 spec 范围」的作者自定义
  配置面）。
- **Q2 Bot 通道**：与桌面未读**同批**落地（R3），避免两通道行为分叉期。
- **Q3 指令注入形态**：**prompt 后缀拼接**（host 常量指令段，作者 prompt 原文在前）。
- **Q4 off-peak settle 路径**：实施首日侦察核实是否共用终态订阅；不同源则登记后续项，
  本批不隐式覆盖。
