# 运行时重启后的孤儿后台任务提醒（W6）

提示词优化批次（2026-10-03）P1 项。CLI 运行时进程重启（crash、升级、手动 kill；
**不含** chat-lane 空闲回收——`chat-lane-idle-reclaim.md` 的静默判据本身排除活跃任务）
后冷恢复会话时，重启前启动的后台任务（后台子代理、后台 Bash）已随旧进程消亡，
但历史里只有它们的 launch 记录、永远等不到终态通知。模型因此会：

1. 无期限等待一个永远不会到达的 task-notification（违反「禁轮询」纪律的前提——
   通知会来——在此场景不成立）；
2. 或把 launch 记录当作「仍在运行」向用户汇报错误状态。

本 spec 增加一个**一次性**提醒：冷恢复后的首个模型 turn，若从持久化历史中检出
「有 launch、无终态、且本进程 registry 不认识」的后台任务 id，注入一条 per-request
system-reminder 告知其已不在运行、要求先核实实际状态再决定重建。

治理红线（`reminder-extensions.md` R4）：新注入点归入 `system-reminder/source.ts`
三来源分类；本项**不产生新 persisted source**（判定见 R2），v4 schema、contracts 枚举、
shared 投影白名单零改动。

## 背景（已核实的现状）

- **registry 是进程内存态**：`InMemoryRuntimeTaskRegistry`（`runtime-task/registry.ts:112`）
  以 Map 持有 running 与 terminal 快照，`get(id)` 可查「本进程是否认识该任务」；
  进程重启后为空。
- **launch 与终态记录都持久化在会话历史里**：
  - 子代理后台 launch：Agent 工具结果文本 `Async agent launched successfully.\nagentId: <id> (internal ID…)`
    （`tool/handlers/agent.ts` `formatAgentOutputForModel`）；registry taskId = agentId
    （`subagent/runner.ts` 以 `lifecycle.agentId` 注册/移除）。
  - Bash 后台 launch：工具结果文本 `Command running in background with ID: <taskId>` /
    `moved to the background with ID: <taskId>` / `manually backgrounded by user with ID: <taskId>`
    （`tool/handlers/bash-model-content.ts:120-131`）。
  - 终态：`<task-notification>` XML 的 `<task-id>`（三种 local 任务格式统一含该元素，
    `runtime-task/notification.ts`），作为 persisted synthetic notice 进历史
    （source `task_status` / `queued_system_notification`，冷恢复由
    `agent/session-history-hydrator.ts:412-420` 重建）。
- **注入点与载体先例**：turn-loop 的 per-request reminder 链
  （`runtime/methods/turn-loop.ts:122-182`：plan_mode_exit → runtime_mode → todo_reminder →
  memory_recall → output_style），一次性 flag 先例 `needsPlanModeExitReminder`；
  runtime_local lifecycle 先例 `plan_mode_exit` / `date_change`。

## 产品规则

### R1 检出判据（纯函数，孤儿 = 三条同时成立）

对给定历史 entries 与「本进程 registry 是否认识该 id」的谓词：

1. entries 中存在该 id 的 **launch 标记**（上述两类文本形态之一；agent 形态要求
   `Async agent launched successfully.` 上下文，避免把前台完成结果里的
   `agentId: X (use SendMessage…)` 误判为后台 launch）；
2. entries 中**不存在**含该 id 的终态标记（`<task-id>` 或 `<agent-id>` 元素值）；
3. registry **不认识**该 id（`get(id) === undefined`）——排除本进程内运行中/已结算的任务。

id 列表按首次出现顺序去重，注入上限 **10** 个（超出部分以「and N more」收尾）；
提取失败（历史被 compact 掉 launch 记录等）自然得出空列表 = 不注入，无需特判。

### R2 档位：per-request 新 source `runtime_restart_tasks`，不落 session

- 归入 `SYSTEM_REMINDER_PER_REQUEST_SOURCES`，descriptor：
  `channel="current_turn"`、`lifecycle="runtime_local"`（一次性触发、由运行时 flag 消费，
  与 `plan_mode_exit`/`date_change` 同档）、`isMeta=true`、
  `providerVisibility="provider_visible"`、`evidenceLabel="sr.runtime_restart_tasks"`。
- **不落 session**（不调 `persistSyntheticUserNoticeForSession`）。R4 判据核验：
  正文含任务 id 列表（状态性内容），但它是**持久化历史的确定性派生**——launch 与终态
  记录都在 session store 里，任何一次冷恢复重算得到同一结果；「跨恢复存活」的需求
  由派生来源满足，不需要提醒本身逐字存活。再次重启后重新检出、重新注入恰恰是
  正确语义（任务仍然死着）。这与 `memory_recall` 的 per-request 判定同一逻辑
  （重建成本为零、无需历史一致），差异仅在正文是派生列表而非静态定性——
  此偏差在本条显式登记，评审视为已知决定而非分类漏洞。
- 因此 contracts `SYNTHETIC_USER_MESSAGE_SOURCES`、`MessageSemanticsKind`、
  bootstrap v4 origin 映射、shared 投影白名单**全部不变**；
  `runtime_restart_tasks` 不得出现在任何 persisted 名单（测试钉住，
  同 `reminder-extensions.md` R7-3 的兜底方向）。

### R3 触发与一次性语义

- 注入点：turn-loop 的 per-request reminder 链，位置在 `runtime_mode` 之后、
  `todo_reminder` 之前（既有四个 attachment 的相对顺序与 persist 语义不变，
  `reminder-extensions.md` R5 同方向）。
- 门控：`!outputTokenRecoveryActive`（与其余 reminder 同口径）+ 运行时实例级
  一次性 flag（先例 `needsPlanModeExitReminder`）：每个 runtime 实例至多注入一次；
  注入即消费。首个 turn 时本进程尚未可能发起任何后台任务（launch 只发生在 turn 内），
  registry 判据在该时点恒真，flag 防的是后续 turn 对同一批孤儿的重复注入。
- 冷恢复的会话由新 runtime 实例承载 → 首 turn 自然重新评估；同进程内继续的会话
  flag 已消费 → 不重复。

### R4 正文（自撰英文，要素固定）

1. 事实句：这些后台任务在本运行时之下已不再运行（措辞不断言重启原因——crash/升级/
   手动 kill 都成立），也永远不会再发来完成通知。
2. 行为要求：不要等待它们；依赖其结果前先核实实际状态（磁盘、git、已存在的输出文件）；
   仍需要的工作重新发起。
3. id 列表逐行（`- <id>`），上限见 R1。
   不复制 launch 记录的描述文本（历史里有，正文只给 id 供模型回查）。

### R5 语言与遥测

英文自撰（`prompt-language-policy.md` R1/R7）；无新增环境变量、无遥测/网络上报
（`no-telemetry.md`）。

## 状态所有者

| 事实 | 所有者 | reminder 侧角色 |
| --- | --- | --- |
| launch/终态记录 | session store（经 message history entries） | 只读派生，不回写 |
| 本进程任务在册性 | `runtimeTaskRegistry`（runtime 内部成员） | 只读谓词 `get(id) !== undefined` |
| 一次性触发 | `RuntimeLifecycleOwner`（`core/src/runtime/runtime-lifecycle.ts`）持有 flag；turn-loop 仅调用 `consumeRuntimeRestartReminder()` | `WeakMap` 绑定 runtime、进程内状态，不落盘；消费后无 reset/set 回写路径 |
| reminder 分类 | `system-reminder/source.ts` | 单点登记（R2） |
| 提醒文本 | `runtime/helpers/runtime-reminders.ts` | 单点，禁止调用方拼接 |

## 接口

- `core/src/system-reminder/source.ts`：`SYSTEM_REMINDER_PER_REQUEST_SOURCES` 增
  `"runtime_restart_tasks"` + descriptor 一行（R2）。
- `core/src/runtime/helpers/runtime-reminders.ts`（纯函数面）：
  ```ts
  export const RUNTIME_RESTART_REMINDER_MAX_IDS = 10;
  export function findOrphanedBackgroundTaskIds(input: {
    entries: readonly RuntimeMessageEntry[];
    isTaskKnownToRuntime: (taskId: string) => boolean;
  }): string[];
  export function buildRuntimeRestartReminderBody(orphanIds: readonly string[]): string | null;
  ```
- `core/src/runtime/methods/turn-loop.ts`：最小加法接线（flag + commit 块，
  形态照抄 memory_recall 块）；不重构周边。

## 验收场景

1. **配对逻辑**：launch(agent)+无终态+registry 不认识 → 检出；有 `<task-id>` 终态 → 不检出；
   registry 认识（running 或 terminal 快照在册）→ 不检出；前台完成结果里的
   `agentId: X (use SendMessage…)` 不误判为 launch；Bash 三种 background 文案都检出。
2. **上限与去重**：12 个孤儿 → 正文含前 10 个 id + 「and 2 more」；同一 id 两次 launch → 一行。
3. **空列表**：`buildRuntimeRestartReminderBody([])` → `null`（不注入空提醒）。
4. **分类归属**：`runtime_restart_tasks` ∈ per-request 数组、∉ persisted 数组；
   descriptor 四元组与 R2 逐字一致；不在 contracts/shared/bootstrap 任何 persisted 名单
   （grep 级断言，防日后挪档漏改跨包分类）。
5. **一次性接线**：源码级断言 turn-loop 含 flag 消费块（同 dispatch 测试读源码的先例）；
   注入位置在 runtime_mode commit 块之后、todo_reminder 门控之前。
6. **语言合规**：正文无 CJK。
7. **验证命令**（仓库根执行，如实记录）：`pnpm typecheck`、`pnpm lint`、
   `pnpm architecture:check -- --changed`、
   `node --import tsx --test apps/acode-cli/tests/*.test.mjs`。

## 不在本项范围

- **workflow run 的孤儿检出**：dynamic workflow 有自己的持久化 run 状态与
  ResumeWorkflowRun 通道（`runtime-task/workflow-notification-copy.ts` 的恢复文案），
  不适用「重新发起」话术，检出面只覆盖 local_agent 与 local_bash 两类 launch 标记。
- **通知丢失但进程未重启的场景归因**：R1 判据在「终态通知从未送达」时同样触发提醒，
  这是有意的宽进（提醒内容在该场景同样正确：任务不再运行、先核实再重建），
  不另做根因区分。
- **UI 侧的孤儿任务展示**：投影/时间线如何呈现该提醒归 shared 投影策略的常规维护
  （per-request 档不落 session，UI 历史里本来就不会出现它）。
