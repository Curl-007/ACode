# Ambient 预算感知调度：usage 滚动账本 + 双层调度（K6）

方案条目：`docs/k-series-upgrade-plan.md` §K6。机制参照 jcode (MIT)
`crates/jcode-ambient-types`（ScheduledItem/ScheduleTarget/AmbientStatus）、
`crates/jcode-app-core/src/ambient/{scheduler,runner,persistence}.rs`（AdaptiveScheduler
预算反推 interval、指数退避、活跃暂停、单例锁、wake nudge），自撰 TypeScript 实现，
未拷贝任何文件。

给 ACode 补「准主动型助手」的调度底座：agent 在会话中可**提议**未来某个时刻醒来做事
（schedule 工具），**系统层**按 token 预算与用户活跃度决定实际唤醒间隔——agent 提议、
系统约束，两层各司其职（jcode 双层调度的核心设计）。与既有体系的关系：

- **cron**（`packages/services/src/session/automationRepo.ts` 一族 + `CronCreate` 工具）：
  用户显式的定时任务（时刻语义、session 触发），**不动**；
- **off-peak**（`offPeakTaskService.ts` 一族）：服务器驱动的闲时算力排队，**不动**；
- **ambient（本项）**：agent 提议 + 本地预算感知的后台 agent 周期唤醒——三者语义正交，
  不合并存储、不合并调度器。

红线：cron/off-peak 域零改动；ambient 消耗走**用户已配置的 provider 与凭据**
（无隐藏配额、无免费额度假设——预算账本防的是「background agent 吃光用户配额/费率
窗口」，不是平台的免费午餐）；默认**关闭**（feature flag，`config.ambient.enabled`），
开启是显式用户决策。

裁剪边界：不做 Telegram/邮件外部消息注入回环（jcode `inject_message`/IMAP 批准——
ACode 的 bots 渠道是独立域，将来经渠道事件对接，登记不做）；不做 ambient 会话的独立
权限面（沿用 J1 分级与 permission 管线，background 语义下默认更严——R5）；UI 管理
面板是 UI 批次。

---

## 背景：已核实的现状与 jcode 参照

> ACode 行号以 dev/0.0.2 `7798f76` 检出为准，实施首日复核。

### ACode 已有面

1. **计量点已有**：`core/src/runtime/methods/turn-tool-usage.ts` 与
   `usage-observability.ts`（turn 级 usage 记录面）——滚动账本的数据源接入点；
2. **调度基建已有**：services 层 automation 体系（repo/service/cron/intervalCarrier，
   磁盘持久化 + claim/stale 语义，`automationRepo.ts:39-45` 的重试/认领常量族）；
   runtime 层 turn 后调度点（K1/K2/K3 同款挂点先例）；
3. **任务 fork**：`acodeTaskService.ts:701` `sourceTaskId`（K3 同款复用）；
4. **用户活跃信号**：host attachment/CommandInbox busy 状态（AGENTS.md 进程协议章的
   owner/lease 体系）——「用户会话活跃」判定接既有 busy 信号，不新造。

### jcode 参照机制（只读提炼）

- **提议层**：`ScheduleTool`（create/list/cancel；wake_in_minutes/wake_at + priority +
  target 三态：Ambient=喂给后台 agent / Session=投回某交互会话 / Spawn=派生新会话）→
  磁盘 JSON 队列（`pop_ready`：到期项按 priority 降序+时间升序）；
- **系统层 AdaptiveScheduler**：
  `ambient_budget = (tokens_remaining − 用户1h滚动速率 × window_remaining) × (1 − user_budget_reserve)`
  除以近 5 cycle 均值 token（缺省保守 1 万）得可跑 cycle 数 →
  `interval = window_remaining / cycles_available`，clamp [5min, 120min]；
  `user_budget_reserve = 0.8`（ambient 最多拿 20% 余量）；用户 session 活跃 → Paused；
- **指数退避**：限流命中 backoff ×2（上限 64），成功 cycle 重置 1；
- **UsageLog**：滚动 24h 磁盘日志（每 10 条落盘）；
- **单例锁**：PID 文件 + 持锁进程存活检测（多实例防双跑）；
- **wake nudge**：任何时刻可被提前唤醒（direct-delivery 项到期）；
- **cycle 结束自提议**：agent 在 cycle 结果里提议下次唤醒（Complete+有请求 →
  Scheduled，否则 Idle）。

## 产品规则

### R1 前置子项：usage 滚动账本（`core/src/ambient/usage-ledger.ts`）

- 数据源：turn 成功路径的 usage 记录点（`turn-tool-usage.ts` 既有面）追加旁路写：
  `{ ts, tokensIn, tokensOut, taskId, kind: "user"|"ambient" }` ——**kind 区分是预算
  公式的前提**（ambient 自身消耗要从用户速率里剔除）；
- 存储：`getACodeDataRootDir()/cli/ambient/usage.jsonl`（追加写、滚动保留 24h、
  启动时裁剪旧段——对齐 K1 R8 账本形态，无凭据无内容，只有计数）；
- 查询面：`getHourlyRate(now)`（1h 窗口 sum，排除 ambient kind）与
  `getRecentCycles(n)`（ambient kind 最近 n cycle 消耗均值）；
- **失败语义**：账本读失败（损坏/缺失）→ 全部按最保守值（用户速率=无穷大 → ambient
  不跑）——fail-closed 方向与 jcode 一致（宁可不振醒，不可吃配额）。

### R2 提议层：Schedule 工具（core `tool/handlers/schedule.ts`）

```
Schedule({ action: "create"|"list"|"cancel",
           wakeInMinutes?: number(1-1440), wakeAt?: ISO 时间,
           priority?: "low"|"normal"|"high",
           target?: "ambient"|"session"|"spawn",
           taskDescription: string, context?: string,
           relevantFiles?: string[], scheduleId?(cancel/list 用) })
```

- **target 三态映射**：`ambient` → 后台 agent cycle（R3）；`session` → 到期把提醒消息
  投回**当前会话**（用户可见的「到点了提醒我」——本质是会话内提醒，走 reminder 体系，
  不起 agent）；`spawn` → 到期 fork 新任务执行 taskDescription（K3 同款 fork 链）；
- `session`/`spawn` 是 **direct-delivery**（不走预算调度，到点即投——用户显式定时语义，
  与 cron 的差别是「由 agent 在对话中受托创建」而非用户手填 cron 表达式；语义重叠处
  提示词引导：周期性用 cron、一次性受托用 schedule）；
- 创建即持久化（磁盘 JSON 队列，`getACodeDataRootDir()/cli/ambient/queue.json`——
  与 services automation 存储分离，ambient 域自持有，不共享表）；
- 上限：每来源会话（`createdBySession`）`SCHEDULE_MAX_ITEMS = 50` + 全局软上限
  `SCHEDULE_GLOBAL_MAX_ITEMS = 200`（批次C F11 归属化，偏差登记见附录 A6），超限给可读错误；
- list 默认只列当前会话创建的项（`all: true` 显式要求才列全部——单用户 CLI 形态的
  隐私取舍，批次C F11，附录 A6）；cancel 只能取消当前会话创建的项，他人项给可读错误。

### R3 系统层：AmbientRunner + AdaptiveScheduler（core `core/src/ambient/`）

- **runner 循环**（runtime 内单实例，feature flag 门控启动）：
  `sleep = min(scheduler.calculateInterval(), 下一个 direct 项到期, 下限30s)` → 到点
  判定：用户活跃（busy 信号）→ Paused（60s 后重查）；否则跑一个 ambient cycle →
  cycle 成功/失败反馈 scheduler（退避/重置）→ 重算 interval → 续循环；
- **cycle 语义**：fork 隐藏 ambient 任务（`taskType` 扩展 `"ambient"`），prompt =
  「后台周期检查」指令 + 到期项的 taskDescription/context/relevantFiles + workspace
  状态摘要；cycle 结束 agent 可在 response 尾部带 ```acode-schedule 围栏 JSON 提议
  下次唤醒（Complete+有提议 → 保持 Scheduled，无 → Idle 停循环直到新 schedule 创建）；
- **预算公式**（对齐 jcode，常量见下表）：
  `budget = (窗口内剩余额度估计 − 用户1h速率 × 窗口剩余) × (1 − reserve)`；
  `额度估计`的数据源：GLM 套餐的配额面（provider 包的账号套餐信息，**实施首日核实
  可得的配额字段**；不可得时额度估计=+∞，公式退化为「只按速率余量约束」——仍优于
  无约束，降级路径进 spec 附录）；
- **指数退避**：限流/失败 → backoff ×2（cap 64）；成功重置 1；
- **单例**：同 runtime 内单 runner（模块级 guard + store 归属检查）；跨进程（多窗口）
  防双跑走队列文件的 claim 时间戳（automationRepo 的 `CLAIM_STALE_MS` 同款语义，
  不引入 PID 文件——ACode 进程模型下 claim 更贴）。

### R4 ambient 会话的权限收紧

background 语义下默认更严：ambient cycle 的 permission 上下文 = 当前用户策略与
**「非交互」**标记的交集——需要 confirm 以上级别的操作在 ambient 会话直接拒绝
（不排队等审批——jcode 的邮件批准回环不做，拒绝+记录是诚实行为）；拒绝事件写入
cycle 结果，用户回来可见。**不新建权限层**，复用 J1 分级与 permission 管线的
现有「无人值守拒绝」路径（实施首日核实该路径的现有形态，若无则本条新增为
permission 域的小扩展并在其 spec 补记——预计 ≤50 行）。

### R5 状态所有权

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| usage 账本 | 磁盘 JSONL + 启动裁剪 | 滚动 24h |
| schedule 队列 | 磁盘 JSON（ambient 域自持有） | 持久 |
| AdaptiveScheduler 状态（backoff/interval） | runner 实例内存 | 进程 |
| ambient cycle 任务 | 任务存储（fork 链） | 持久 |
| 活跃判定 | host busy 信号（既有） | 实时 |
| feature flag | `config.ambient.enabled`（缺省 false） | 配置 |

不变量：调度层与队列层只有 runner 一个消费者（claim 后消费）；预算公式是**建议性
约束的固化**（宁可不振醒不可吃配额——R1 fail-closed）；runner 永不绕过 R4 权限收紧。

## 常量（`core/src/ambient/constants.ts`）

| 常量 | 值 | 出处 |
| --- | --- | --- |
| `AMBIENT_MIN_INTERVAL_MS` / `MAX` | `5min` / `120min` | R3（jcode 同值） |
| `AMBIENT_USER_BUDGET_RESERVE` | `0.8` | R3 |
| `AMBIENT_CYCLE_TOKEN_FALLBACK` | `10_000` | R3（无历史时的保守均值） |
| `AMBIENT_BACKOFF_CAP` | `64` | R3 |
| `AMBIENT_TICK_FLOOR_MS` | `30_000` | R3 |
| `AMBIENT_QUEUE_CLAIM_STALE_MS` | `10 * 60_000` | R3 |
| `AMBIENT_CLAIM_RENEW_SEGMENT_MS` | `⌊STALE/3⌋ = 3min20s` | R3（批次C F2：长 sleep 心跳分段） |
| `SCHEDULE_MAX_ITEMS` | `50`（每 createdBySession） | R2（批次C F11 归属化） |
| `SCHEDULE_GLOBAL_MAX_ITEMS` | `200`（全局软上限） | R2（批次C F11 spec 偏差，附录 A6） |
| `USAGE_LEDGER_WINDOW_MS` | `24h` | R1 |
| `USAGE_LEDGER_TRIM_REWRITE_THRESHOLD` | `0.1`（裁剪量占比 ≤10% 不重写） | R1（批次C F7） |
| `USAGE_LEDGER_MAX_PENDING_LINES` | `1000`（flush 失败回填后的缓冲上限） | R1（批次C F8） |

## 接口

core 新增：`core/src/ambient/{usage-ledger,scheduler,runner,queue,constants}.ts`、
`tool/handlers/schedule.ts`；contracts：`Schedule*Schema`、`RuntimeTaskType` 增
`"ambient"`（K3 同款联合扩展）；turn 成功路径一处旁路写（R1 数据源接线，单一写入点）。

## 验收场景

测试：`apps/acode-cli/tests/ambient-budget-scheduler.test.mjs`（时钟桩 + fake cycle）。

1. **账本**：user/ambient 双 kind 记账正确；`getHourlyRate` 排除 ambient；损坏账本 →
   保守值（不跑）+ warn；24h 裁剪；
2. **预算公式**：手工数值对照（剩余 100k、用户速率 10k/h、窗口 2h、reserve 0.8、
   cycle 均值 5k → 可跑 4 cycle → interval 30min，clamp 生效两边界）；无历史 →
   fallback 10k 参与计算；
3. **退避**：连续限流 → interval ×2 链到 cap 64；成功 cycle 重置 1；
4. **两层取交集**：agent 提议 5min 后醒，scheduler 算出 30min → 实际 30min 醒；
   direct-delivery 项到期提前唤醒（sleep 被 nudge 截短）；
5. **活跃暂停**：busy 信号在 → Paused、零 cycle；释放后 60s 内恢复；
6. **target 三态**：session 投回 reminder（零 agent）；spawn fork 新任务（mock 断言
   fork 参数）；ambient 走 cycle；
7. **cycle 自提议**：response 带 ```acode-schedule 围栏 → 队列保持 Scheduled；
   无围栏 → Idle（循环停，新 schedule 创建可重启）；
8. **权限收紧**：ambient cycle 内 confirm 级操作被拒且记录（R4）；交互会话同操作
   行为不变（旁路不影响主域——permission 域回归测试全绿）；
9. **单例**：双 runner 实例并发启动 → claim 互斥，单跑；
10. **默认关**：flag 缺省 false → 零 runner、Schedule 工具不注册；
    cron/off-peak 源码零命中（域边界钉住）。

## 未做与取舍

1. **外部消息注入**（Telegram/IMAP 批准回环）：bots 渠道域后续，jcode
   notify-email 的「自然语言批准解析」设计已记入附录供届时参照；
2. **配额面不可得的降级**（R3）：额度估计 +∞ 只按速率约束——降级不静默：runner 启动
   warn 一次「配额面不可用，ambient 按速率余量约束」；
3. **不做 ambient 的 UI 面板**：状态/队列/暂停管理走 config + Schedule(list) 工具，
   UI 批次；
4. **不做多 workspace 并行 ambient**：每 runtime 单 runner 单 workspace 起步；
   跨 workspace 的 ambient 资源分配是并发治理新题，等单 workspace 验证后另立。

## 第三方归属

`core/src/ambient/` 文件头注明「机制参照 jcode (MIT)：crates/jcode-ambient-types
（ScheduledItem/ScheduleTarget/AmbientStatus 三态）与 jcode-app-core/src/ambient/
（AdaptiveScheduler 预算公式、指数退避、活跃暂停、wake nudge）」，自撰实现。

---

## 附录：实施首日探测结论（dev/0.0.3 实施批登记）

### A1 额度面探测（R3 数据源）

**结论：可得，但不在 core 的依赖面内——以注入端口承载，缺省降级。**

- 配额面真实存在：`packages/services/src/model-provider/zaiStartPlanBilling.ts` 的
  `fetchZaiStartPlanBalanceEnvelope`（GLM/ZAI Start Plan 余额接口），返回
  `balances[].remaining_units / available_units / period_start / period_end`——
  正是「窗口剩余额度 + 窗口剩余时间」的形状；
- 但 `@acode/core` 不依赖 `@acode/services`（依赖方向：services → 上，core 平级），
  且该接口的计量单位是套餐 entitlement 的 unit（按 meter 折算），不是纯 token——
  直接换算需要账号上下文；
- 因此额度估计以 `AdaptiveSchedulerDeps.getQuotaSnapshot?(): Promise<
  {remainingTokens, windowRemainingMs} | null>` 注入端口承载：bootstrap 装配处
  （接线批）绑定时调 zaiStartPlanBilling 面做 unit→token 折算；端口缺席/返回 null =
  降级模式（额度 +∞，interval 钉 MAX=120min，账本读坏时速率 ∞ → 不跑），runner
  启动 warn 一次（`ambient.quota.degraded` 事件），不静默。

### A2 R4 权限收紧的落点（fork configOverrides 层，非新权限层）

**探测结论：core permission 管线没有既有「无人值守拒绝」路径**——
`core/src/permission/service.ts` 及全 permission/ 目录无 non-interactive/unattended
语义；现有 unattended 先例（off-peak）走的是 permissionMode=yolo 的**放开**方向，
与 R4 的「收紧」相反。

落点选择：`AmbientCycleRequest.permission = { nonInteractive: true }`（runner →
fork 端口的请求字段）。绑定层（bootstrap 接线批）把它翻译为 fork configOverrides
的最小拒绝面：confirm 及以上级别的操作直接拒绝（不排队等审批），拒绝清单经
`AmbientCycleResult.deniedOperations` 写回 cycle 结果（`denied` 事件），用户回来
可见。permission 域零改动（场景 8 源码断言钉住）。

### A3 注入形态登记（写面受限的替代承载）

- **feature flag**：`config.ambient.enabled` 的 config schema 扩展（`AgentRuntimeConfig`）
  不在本批写面——runner 以 `startAmbientRunner({ enabled })` 注入形态消费 flag，
  缺省 false 的语义由调用方（bootstrap 接线批）保证；接线时补 config schema 字段；
- **ambient 会话标记**：`session-kind.ts` 的进程内标记面（`markAmbientSession`）——
  fork 端口绑定处登记，turn 计量旁路写（`usage-observability.ts` 的
  `appendAmbientUsageForTurn`，位于 usageStore 早退之前）按它判定 kind；
- **共享账本实例**：`setSharedAmbientUsageLedger` 是装配/测试注入缝；缺省
  `defaultAmbientDataRootDir()`（镜像 services getDataBaseDir 优先级：env
  ACODE_DATA_BASE_DIR > HOME > homedir，拼 `.acode`）；首次使用即 24h 裁剪
  （等价启动裁剪，装配层无需显式调用 loadAndTrim）。

### A4 测试口径补充

- 预算公式 cycles 取 **ceil**（验收场景 2 的手工对照 16000/5000=3.2 → 4 → 30min）；
- 退避倍率作用于 clamp 后的基础 interval，**可越过 MAX**（限流拉长间隔正是退避目的，
  5min × 64 = 320min 是合法值）；MAX clamp 只约束预算公式的基础节奏；
- runner 的 sleep 下限 30s（AMBIENT_TICK_FLOOR_MS，spec R3「下限30s」），上限
  120min（预算判 Infinity 时周期性重算，判定可恢复）；
- 迭代级容错：Windows 原子 rename 的瞬态锁（EPERM/EBUSY）按有限重试 + runner 退避
  处理，连续 5 次迭代异常才停循环（真死循环防护，见 runner.ts MAX_ITERATION_ERRORS）。

### A5 接线批装配登记（dev/0.0.3 接线批）

**config flag**：`AgentRuntimeConfig.ambient?.enabled`（缺省 false）。解析收口在
bootstrap 的 runtime-config 工厂（`ambient.enabled = options.runtimeConfig?.ambient?.enabled
=== true`）；CLI/协议 call-level runtimeConfig 是唯一入口——adapters 的 config 文件
schema（features 面）不承载域级开关，本批不改 adapters。下游两处门（runtime-tools
的 Schedule 注册、ambient 装配的 runner 启动）都只读该字段。

**依赖方向结论（quota 绑定）**：`fetchZaiStartPlanBillingEnvelope` 位于
`@acode/services`，而 CLI agent 装配链（cli → bootstrap → core）**零包依赖 services**
（三者的 package.json 均无 `@acode/services`；services 侧调用还需
ICredentialService/IAccountRequestAuthService 这两个 services 内部构造）。因此 quota
绑定落 bootstrap 层新文件 `ambient-quota.ts`：以「同 URL + 同 envelope 形状」的最小
GET 实现承载（URL = shared `buildRuntimeACodeEndpointUrls().acodePlanBillingBalanceUrl` +
`app_version`，与 services `buildZaiStartPlanBalanceUrl` 等价）；账号上下文从 provider
装配面取（registry 的 `zhipu-account` access 判家族 +
`providerRuntimeHeadersPort.refreshBeforeModelRequest` 刷请求凭据，Bearer 前缀归一与
services 同口径）。server/desktop 形态将来直接复用 services 面时，经该文件的端口缝
替换注入。

**unit → token 折算：按 1:1 记账（`AMBIENT_QUOTA_UNIT_TO_TOKENS = 1`），需产品确认。**
套餐余额的计量单位是 entitlement 的 unit（按 meter 折算），不是纯 token；在产品给出
正式折算表之前按 1:1——预算公式的方向语义（余量约束）不受折算精度影响，绝对值偏差
由 `AMBIENT_USER_BUDGET_RESERVE` 的保守系数吸收。桶选择：capabilities 匹配当前模型
的桶优先，无匹配取 period_end 最晚的桶；无 period_end 的桶跳过（算不出 interval 分母）。

**R4 翻译落点**：nonInteractive → fork configOverrides 的 `mode: "plan"`。这是
configOverrides 上唯一现成的「非交互直接拒绝」面（plan 对非只读操作同步 deny：
`mode.plan.nonReadOnly`，不排队等审批），比 R4 字面的「confirm 及以上拒绝」更严
（edit 级也拒）——方向一致（收紧），「后台周期检查 = 只读观察」语义下保守面更贴；
此偏差在此登记。被拒操作经子会话 turn events 的 PermissionDenied 投影收集为
`deniedOperations` 写回 cycle 结果。overnight 沿用父 mode 是「不放宽」；ambient 收紧
到 plan 是 R4 的无人值守红线。

**target=session 投递载体**：`runtime.recordGoalStateChangeReminder`（K1/K2 的
reminder 载体先例：messageHistory attachment + persisted synthetic notice，不起
agent；active turn 在场时自带 deferral 防护）。跨会话/跨进程残留项跳过并 warn
（direct 项一次性语义，投错会话比丢失更糟）。

**busy 信号**：`runtime.hasActiveOrQueuedTurnWork()`（activeTurn + CommandInQueue
pending，prompt-admission 的 busy 判定同源）——「用户会话活跃」不新造信号。

**数据根**：装配期 `defaultAmbientDataRootDir(env)` 显式注入（ledger/queue 同根），
账本经 `setSharedAmbientUsageLedger` 成为 turn 旁路写的单一实例；**无论 flag 开关
都注入**（usage 记录是数据面，调度消费是另一个面——开启 flag 时才有历史速率可用）。

**引擎导出面补齐**：引擎批未从 `core/src/index.ts` 出口 ambient 面（bootstrap 跨包
导入纪律：不开深路径）。接线批补六模块导出（constants/queue/scheduler/runner/
usage-ledger/session-kind；turn-usage-hook 与 proposal 是 core 内部消费面不出口）+
`forkSourceMessagesForSession`（ambient fork 目标必须复用 session-fork 的 active 分支
语义）。`AgentRuntimeDeps.ambientSchedulePort` 是 Schedule 工具的依赖闭包注入缝
（queue + onScheduleCreated；automationPort 同款流向）——runtime/types.ts 的这一处
超出「config 字段」字面写面，是接线必需的最小补齐，在此单独说明。

### A6 批次C对抗复核修复登记（F2/F3/F7/F8/F9/F10/F11/F12）

**F2 claim 续租缺口双跑（P1）**：runner 的 renewClaim 返回值原先被忽略，且单次 sleep
可达 120min（AMBIENT_MAX_INTERVAL_MS）远超 CLAIM_STALE=10min——claim 被其他窗口接管后
原 runner 无从察觉、继续消费（双跑）。修复：① renewClaim 返回 false → 立即停循环
（dispose 语义，warn `ambient.claim.lost`，不再 releaseClaim——claim 已属新 owner）；
② 长 sleep 按 `AMBIENT_CLAIM_RENEW_SEGMENT_MS = ⌊STALE/3⌋` 分段，每段醒先续租再继续
剩余睡眠；nudge 信号照常打断整段睡眠（打断即重算，不累积漂移）。

**F3 队列 RMW 无原子性 + 共享 tmp 名（P1）**：read→write 无串行化 + writeShape 固定
`${filePath}.tmp`——并发 rename 撞 tmp 抛 ENOENT 丢写。修复三件：① tmp 名加
`${pid}-${randomUUID().slice(0,8)}` 唯一段；② ENOENT 并入瞬态 rename 名单（重试时
重建 tmp 后再 rename，重试耗尽 fail-loud）；③ 进程内写串行化——每队列实例的
create/cancel/popReady/tryClaim/renewClaim/releaseClaim 全部经 promise 链互斥入口
（swarm plan-store mutate 同款模式）。
**已知限制（风险接受）**：跨进程 lost-update 仍存在——两个 ACode 进程（多窗口）同时
read→write 时后写覆盖先写。单用户 CLI 形态下多窗口同时操作 schedule 队列是低概率
场景，且 schedule 是建议性唤醒（可重建，队列层宽松方向）；文件锁（flock/LockFileEx）
列为后续项，本次不实现——理由：Node 无跨平台 flock 原语（flock 非 Windows），引入
第三方锁或 proper-lockfile 增加依赖面与死锁面，超出「精确修复」批次边界。

**F7 usage.jsonl 多进程并发（P2）**：① loadAndTrim 对半截尾行宽容——追加写的天然
中间态（尾段无换行符且解析失败）丢弃该行而不整本判 corrupted；文件以 `\n` 结尾时
中间行解析失败仍是真损坏（fail-closed 不变）。② trim 重写窗口缩小：仅当裁剪量
> `USAGE_LEDGER_TRIM_REWRITE_THRESHOLD`（10% 行数）才重写文件，缩小与他进程 append
的交错窗口。**多进程语义（风险接受，同 F3）**：trim 重写仍可能截掉他进程刚 append
的行；单用户 CLI 多窗口形态接受该损失——代价是速率被低估（偏激进方向），但被
`AMBIENT_USER_BUDGET_RESERVE=0.8` 的保守系数部分吸收，且半截读不再永久停跑。

**F8 flush 失败丢缓冲（P2）**：pendingLines 先清后 append、失败不回填。修复：失败把
行回填 pendingLines 头部 + warn（下次 flush 重试）；有界——回填后仍超
`USAGE_LEDGER_MAX_PENDING_LINES`（1000）才丢最旧。flush 自此成为全函数（不再向上
抛错，dispose 路径安全）。

**F9 spawn 计入 ambient kind（P2）**：spawnTask 复用 forkAmbientChildRuntime →
markAmbientSession → spawn 的消耗从用户速率消失（反保守）。修复：fork 函数加 kind
参数，spawn 路径不标记 ambient session——spawn 是用户显式定时的工作单，消耗计入
user 速率（保守方向）；ambient cycle 路径照旧标记。

**F10 workflow_child 拿到 Schedule 工具（P2）**：注册门原先只排除 subagent_child。
修复：`taskType === "subagent_child" || "workflow_child" || "nested_workflow_child"`
都不注册 Schedule（swarmPlanReadOnly 的收紧先例同款）——workflow 子会话是编排域的
执行单元，不该再自建唤醒提议。

**F11 上限全局化 + 无归属校验（P2）**：原先上限是全局 50 且 list/cancel 无归属。
修复：① 上限判定按 createdBySession 计数（每会话 50，**spec 偏差补记**：全局软上限
`SCHEDULE_GLOBAL_MAX_ITEMS = 200` 防总量失控——R2 字面的「每任务 50」在无归属校验的
旧实现里被写成了全局 50，本批修正为每会话 50 + 全局 200）；② list 默认只列当前
会话的项（`all: true` 显式要求才列全部——**单用户 CLI 形态的隐私取舍补记**：多窗口
共写一份数据根时，A 窗口的模型不应在 list 里看到 B 窗口的提醒文本）；③ cancel 只能
取消自己会话的项，他人项给可读错误（单用户形态下防误删并行窗口的工作单）。

**F12 scheduler 窗口已过取激进（P3）**：windowRemainingMs ≤ 0 时原先经 clamp 落到
MIN（最激进）。修复：窗口非正（或非有限）→ 返回不可跑判定（interval=Infinity，
保守方向——「宁可不振醒」）。配额端口的「窗口已收口 → null」判定仍在上游，此处是
调度器对注入端口的独立防御。
