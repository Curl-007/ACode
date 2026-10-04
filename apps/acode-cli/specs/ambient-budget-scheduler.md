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
- 上限：每任务 `SCHEDULE_MAX_ITEMS = 50`（防滥用堆积），超限给可读错误。

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
| `SCHEDULE_MAX_ITEMS` | `50` | R2 |
| `USAGE_LEDGER_WINDOW_MS` | `24h` | R1 |

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
