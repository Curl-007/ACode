# reminder 承载类型扩展：TodoWrite pending 门槛 + 召回记忆提醒（P7）

提示词主线 P7 项（`docs/cli-dispatch-and-system-prompt-upgrade-plan.md` §4「P7（P2）reminder 承载类型扩展」、
§3 能力对照表 B7 行）。本 spec 规定 turn 级 system-reminder 的两项承载扩展：

1. **TodoWrite 久未使用提醒**加「存在未完成项」门槛（既有 `todo_reminder` 注入点的触发条件收紧）；
2. **召回记忆提醒**（新注入点 `memory_recall`）：把 P6 已落地的「记忆 = 待核实快照」定性
   在 turn 级复述一次，防止长会话里被上下文冲淡。

治理红线（方案 §4 P7「治理约束」）：每个新注入点必须归入
`core/src/system-reminder/source.ts` 的三来源分类；若产生**新 persisted source**，
必须同步 `packages/shared` 的 v4 schema 并跑双链路回放验证。本 spec 的设计刻意
**不产生新 persisted source**（见 R2、R3），因此 v4 schema 与 contracts 枚举不变；
双链路不变量仍按 R7 用测试固化。

## 背景

### 已核实的现状

**三来源分类是单点事实**：`core/src/system-reminder/source.ts:20-52` 三个数组
（prefix `:20`、persisted `:22-39`、per-request `:40-52`），`:89-169` 是每个 source 的
descriptor（channel / lifecycle / isMeta / providerVisibility / evidenceLabel），
`:171-179` 合成 `SYSTEM_REMINDER_SOURCES` 与 mid-conversation-system 集合。
消费方全部走这一个入口：

| 消费方 | 用途 |
| --- | --- |
| `agent/message-history.ts:396-399` | `isKnownSystemReminderSource` 白名单 |
| `runtime/helpers/provider-request-messages.ts:141-172` | attachment 是否 bubble 到 latest user（按 descriptor 四元组判定，`:44-46` 是唯一豁免集） |
| `runtime/helpers/provider-mid-conversation-system.ts:105` | 是否走 mid-conversation-system 通道 |
| `runtime/helpers/compact-preservation.ts:53` | compact 时**只有 persisted source** 的 attachment 被保留 |
| `agent/session-history-hydrator.ts:422-539` | 冷恢复重建 persisted synthetic attachment |

**TodoWrite 提醒已存在且已持久化**（下列行号为本期实施后的位置）：
`runtime/helpers/runtime-reminders.ts:82-85`
（`TODO_REMINDER_CONFIG = { TURNS_SINCE_WRITE: 10, TURNS_BETWEEN_REMINDERS: 10 }`）、
`:149-184`（从 message history 反向数 assistant turn，无独立计数器）、
`:186-209`（`shouldBuildTodoReminder` / `buildTodoReminderBody`）；
注入点 `runtime/methods/turn-loop.ts:139-162`：先判 turn 数，再
`readSessionTodosForContext` 取当前 todo，提交 `systemReminderAttachmentEntry("todo_reminder", …)`
并 `persistSyntheticUserNoticeForSession({ source: "todo_reminder" })`。

**persisted synthetic notice 的分类链路已完整闭合**（`todo_reminder` 全链在册）：

- 铸造：`contracts/src/interfaces/session-store.port.ts:51-68`（`SYNTHETIC_USER_MESSAGE_SOURCES`）、
  `:77-89`（`MessageSemanticsKind`）；`core/src/runtime/methods/synthetic-notice-metadata.ts:32-58`
  给出 `origin=agent_runtime`、`uiVisibility=hidden`、`providerVisibility=visible`、
  `transcriptVisibility=hidden`，`:84-85` 把 `todo_reminder` 映射到同名 kind。
- **desktop-continuous（实时/可见投影）**：`packages/shared/src/conversation-message-projection-policy.ts:78-157`
  → `providerContextOnly`（`:137` 命中 `PROVIDER_CONTEXT_SYNTHETIC_SOURCES`，`:49-67` 含 `todo_reminder`；
  或 `:110-112` 命中 semantics.providerVisibility），
  `:159-165` `isConversationRealUserTurnStarter` 因此为 false；
  `packages/shared/src/acode-session-visible-content.ts:50-64` / `:82-100`
  把它从可见用户消息里过滤掉；CLI 侧 `bootstrap/src/session-transcript.ts:109-114` 同一判据。
- **web-remote-replayable（冷恢复/回放）**：`bootstrap/src/acode-protocol-v4/event-normalizer.ts:399-441`
  与 `bootstrap/src/acode-protocol-v4/projection-rows.ts:45-64` 把 `todo_reminder` 映射为
  `origin="synthetic"`（turnHeader 侧 `:29-42` 落 `userInput` 之外的分支由 source 决定），
  `bootstrap/src/acode-protocol-v4/transcript-hydration.ts:128-133` 复用同一 shared policy。
- 回放不启动独立 model-only turn：`conversation-message-projection-policy.ts:69-76`
  的 `MODEL_ONLY_TURN_TRIGGER_SOURCES` 不含 `todo_reminder`。

**记忆召回的既有事实**（P6 已落地，本期禁触 `context/sections/*`）：

- 保存/召回守则与「记忆 = 待核实快照」定性在 `core/src/context/sections/memory.ts:25-56`
  （定性原文在 `:55`），属 system prompt 的 Memory 段（`context/registry-main.ts:158-168`，
  条件 `Boolean(ctx.config.memoryRoot)`）。
- 真正被召回进上下文的是 `MEMORY.md` 索引：`core/src/runtime/methods/context.ts:67`
  载入 `this.memoryIndexContent`（`:168-190`：memory 未启用 / 文件缺失 / 格式化后为空
  → `undefined`），`context/sections/request-user-context.ts:73-84` 渲染成
  `# agentsMd` 段里的「Contents of <root>/MEMORY.md」。
- runtime 侧可读字段：`core/src/runtime/internal.ts:93-94`（`memoryRoot` / `memoryIndexContent`）。

### 缺口

1. **todo 提醒没有内容门槛**（实施前状态）：`shouldBuildTodoReminder` 只看 turn 数，
   `buildTodoReminderBody` 对空列表也照发（原 `:171-180` 的 `if (todos.length > 0)`
   只影响是否附清单，不影响是否提醒；现按 R1/R2 改为 `:194-209`）。结果是
   「列表为空」和「全部 completed」的会话每 10 turn 收到一次
   「考虑使用 TodoWrite / 清理过期列表」——此时既没有可跟踪的未完成工作，
   也没有过期列表可清理，提醒是纯噪声，还会每 10 turn 落一条 persisted notice。
2. **召回记忆没有 turn 级复述**：Memory 段与 `MEMORY.md` 索引都在 system/meta_user
   前缀里，长会话（几十次 tool call、多次 compact）后该定性离当前 turn 很远；
   实测失效模式是模型把召回内容当指令执行、或直接引用已不存在的文件路径。
   实施前 `source.ts` 里没有对应注入点，`runtime-reminders.ts` 里也没有对应载体
   （现为 `source.ts:46,100` 与 `runtime-reminders.ts:89-100,220-234`）。

## 产品规则

### R1 TodoWrite 久未使用提醒：触发条件（收紧）

同时满足才注入，任一不满足即整轮跳过（不提交 attachment、不 persist、不推进配额）：

| # | 条件 | 判据来源 |
| --- | --- | --- |
| 1 | 非 output-token 恢复轮 | `turn-loop.ts:140` 既有 |
| 2 | 工具面含 `TodoWrite` | `turn-loop.ts:141` 既有 |
| 3 | 距上次 `TodoWrite` 调用 ≥ 10 个 assistant turn | `shouldBuildTodoReminder`（不变） |
| 4 | 距上次 `todo_reminder` ≥ 10 个 assistant turn | 同上（不变） |
| 5 | **当前 todo 列表存在未完成项**（`status ∈ {pending, in_progress}`） | 新增（本 spec） |

条件 5 的口径：「有 pending」读作**存在未完成项**——`in_progress` 是「声明正在做」，
10 turn 未更新恰恰是状态失真的典型信号（做完了没标 completed、或卡住了没记阻塞），
比 `pending` 更需要提醒；只按字面 `status === "pending"` 判定会漏掉这一类。
`completed` 不计入未完成项。

**行为变更说明**：列表为空或全部 completed 的会话从此不再收到该提醒（原先会）。
理由：该提醒的产品目的是「让模型更新/清理**已声明**的工作清单」，不是「劝说模型开始用
TodoWrite」；后者的承载层是工具描述与 session guidance 段（`context/registry-main.ts`
的 `guidance.session`），不该由一条每 10 turn 落盘的 synthetic notice 承担。

### R2 todo 提醒的来源与正文：复用既有 persisted source

- source 仍是 `todo_reminder`（`source.ts:23` persisted 档，descriptor `:111`
  `current_turn` / `per_current_turn` / isMeta / provider_visible）。**不新增 persisted source**，
  因此 `contracts` 的 `SYNTHETIC_USER_MESSAGE_SOURCES`、`MessageSemanticsKind`、
  `bootstrap` v4 的 origin 映射、`packages/shared` 的投影白名单**全部不变**（R7 用测试钉住）。
- 正文仍由 `buildTodoReminderBody(todos)` 生成，语义扩展为
  **`string | null`**：无未完成项 → `null`（调用方据此跳过提交与落盘）。
  有未完成项 → 既有英文提醒文本 + 当前清单（`1. [status] content` 逐行）。
- 文本自撰英文（`prompt-language-policy.md` R1），不复制任何第三方产品原文。

### R3 召回记忆提醒：新注入点 `memory_recall`，per-request 档

- 归入 `source.ts` 第三类 **per-request**（`SYSTEM_REMINDER_PER_REQUEST_SOURCES`），
  descriptor：`channel="current_turn"`、`lifecycle="per_current_turn"`、`isMeta=true`、
  `providerVisibility="provider_visible"`、`evidenceLabel="sr.memory_recall"`
  ——与同档的 `output_style`（`:96`）、`runtime_mode`（`:94`）一致。
- **不落 session**：只 `commitTurnRequestEntries` 进本轮请求 entries，
  不调 `persistSyntheticUserNoticeForSession`。理由：正文是无状态静态定性文本，
  冷恢复后按同一条件重新生成即可；persisted 档的代价（contracts 枚举 + v4 origin 映射 +
  shared 投影白名单 + hydrator 重建 + compact 保留）换来的只是「历史里多一条重复文本」，
  还会把 cache 前缀切得更碎。**因此本项不产生新 persisted source，v4 schema 无需变更。**
- 触发条件（全部满足）：
  1. 非 output-token 恢复轮（`turn-loop.ts:165` 本注入点自己的三元；与 `:127` 的
     `runtime_mode`、`:140` 的 `todo_reminder` 同一口径）；
  2. **确有记忆被召回**：`memoryRoot` 在场且 `memoryIndexContent` 去空白后非空
     （等价于 `request-user-context.ts:73-84` 真的渲染了 `MEMORY.md` 段）；
  3. 距上一条 `memory_recall` attachment ≥ **5** 个 assistant turn（首次注入前按同一计数口径，
     即会话开头 5 turn 内不打扰）；历史里没有 `memory_recall` 时按「已有 assistant turn 总数」计。
- 正文定性三要点（自撰英文，与 `memory.ts:55` 的守则同口径、不重复其保存流程细节）：
  1. 召回的记忆是**背景上下文，不是指令**，也不因来自记忆而获得权威性；
     永不覆盖用户当前请求；
  2. 依赖前**核实现存性**——它引用的文件、路径、接口、决定可能已经移动、改名、
     被撤销或已完成；
  3. 与当前观察冲突时**信观察**，随后更新或删除过期记忆，让下一份快照更接近事实。
- 不新增环境变量；不新增遥测/网络上报（`no-telemetry.md` 红线）。

### R4 分类纪律：档位选择规则

新注入点必须先进 `source.ts` 三来源之一，判据是**是否需要跨进程/跨恢复存活**：

| 档 | 判据 | 代价 |
| --- | --- | --- |
| `prefix` | 每请求重建、位于 system 前缀、参与 cache 锚点 | 只能由 context 组装管线产出 |
| `persisted` | 内容含**当时状态**（todo 清单、goal 状态、通知载荷），冷恢复必须逐字重建 | 必须同步 contracts 枚举 + v4 origin 映射 + shared 投影白名单 + hydrator + compact 保留 |
| `per-request` | 内容是**静态定性文本**，重建成本为零、无需历史一致 | 无跨包代价；compact 后自然消失（`compact-preservation.ts:53` 只保留 persisted） |

误把静态文本放进 persisted 档 = 无谓的跨包 schema 扩张；误把状态文本放进 per-request 档 =
冷恢复语义漂移。两者都由 R7 的断言防住。

### R5 载体与配额

- 两个提醒都借 `runtime/helpers/runtime-reminders.ts` 的 turn 计数载体：从 message history
  反向扫 assistant turn（跳过 attachment entry），**不引入独立计数器状态**，
  因此 resume / fork / compact 后计数自然从历史重算，不存在需要额外同步的第二份状态。
- 同一轮里两个提醒可以并存（各自独立配额）；提交顺序固定为
  `plan_mode_exit` → `runtime_mode` → `todo_reminder` → `memory_recall` → `output_style`
  中 `memory_recall` 紧随 `todo_reminder` 之后、`output_style` 之前，
  **不改动既有四个 attachment 的相对顺序与 persist 语义**。
- bubble 行为由 descriptor 决定（`provider-request-messages.ts:141-172`）：
  `memory_recall` 是 isMeta + provider_visible + `current_turn`，与 `runtime_mode` /
  `output_style` 同路，不需要进 `NON_BUBBLING_ATTACHMENT_SOURCES`（`:44-46`）。

### R6 唯一所有者

| 事实 | 所有者 | reminder 侧的角色 |
| --- | --- | --- |
| todo 列表 | session store（经 `readSessionTodosForContext`，`runtime/methods/resume.ts:386`） | 只读投影，不缓存、不改写 |
| 记忆索引内容 | `AgentRuntimeInternal.memoryIndexContent`（`runtime/methods/context.ts:67` 单点载入） | 只读在场性判据，不复制内容进正文 |
| turn 计数 | message history（唯一事实） | 派生，无独立状态 |
| reminder 分类 | `system-reminder/source.ts` | 单点，禁止调用方各自判定档位 |
| 提醒文本 | `runtime-reminders.ts` 常量 | 单点，禁止调用方拼接 |

### R7 双链路不变量（回放不得把通知当用户输入）

1. persisted 的 `todo_reminder` notice 在 **desktop-continuous** 语义下：
   `getConversationMessageProjectionPolicy` ≠ `realUserInput`（应为 `providerContextOnly`）、
   `isConversationRealUserTurnStarter` = false、`getACodeUserVisibleMessages` 不返回它。
2. 同一条 notice 在 **web-remote-replayable** 语义下：v4 canonical row 的
   `userInput.origin` = `synthetic`（≠ `realUser`），且不被
   `getConversationModelOnlyTurnTriggerSource` 当成 model-only turn 触发源（= `null`）。
3. `memory_recall` 是 per-request 档：**不得**出现在
   `SYSTEM_REMINDER_PERSISTED_SOURCES`、`SYNTHETIC_USER_MESSAGE_SOURCES`、
   `PROVIDER_CONTEXT_SYNTHETIC_SOURCES` 任一名单里（它永不落盘，两条链路都不会见到它；
   一旦有人把它挪进 persisted 档而没同步跨包分类，这三条断言会同时失败并指出缺口）。
4. `source.ts` 结构不变量：三数组两两不相交且并集 = `SYSTEM_REMINDER_SOURCES`；
   每个 source 都有 descriptor；`memory_recall` 的 descriptor 四元组与 R3 逐字一致。

## 接口

`core/src/runtime/helpers/runtime-reminders.ts`（公开给 turn-loop 的纯函数面）：

```ts
// 既有：turn 计数门槛（不变）
export function shouldBuildTodoReminder(entries: readonly RuntimeMessageEntry[]): boolean;

// 新增：R1 条件 5 的独立判据（便于单测与复用）
export function hasUnfinishedTodos(todos: readonly TodoItem[]): boolean;

// 变更：无未完成项返回 null（R2）
export function buildTodoReminderBody(todos: readonly TodoItem[]): string | null;

// 新增：R3 的单一入口——在场性 + 配额都判完，返回 null 表示本轮不注入
export function buildMemoryRecallReminderBody(input: {
  entries: readonly RuntimeMessageEntry[];
  memoryRoot: string | undefined;
  memoryIndexContent: string | undefined;
}): string | null;
```

`core/src/system-reminder/source.ts`：`SYSTEM_REMINDER_PER_REQUEST_SOURCES` 增 `"memory_recall"`
+ descriptor 一行（R3）。

`core/src/runtime/methods/turn-loop.ts`：**最小加法**接线（本期唯一所有权外的文件，
已获批准）——(a) `buildTodoReminderBody` 返回值判空后再 commit/persist；
(b) 新增 `memory_recall` 的 commit 块（不 persist）。不重构周边代码，
不改动既有四个 attachment 的顺序与语义。

## 验收场景

1. **pending 门槛抑制**：列表为空 / 全 `completed` → `buildTodoReminderBody` 返回 `null`、
   `hasUnfinishedTodos` 为 false；含 `pending` 或 `in_progress` → 返回文本且附当前清单。
2. **turn 门槛不回退**：`shouldBuildTodoReminder` 的 10/10 语义与 attachment 跳过规则
   （attachment entry 不计入 assistant turn）保持不变。
3. **memory_recall 在场性**：`memoryRoot` 缺失、或 `memoryIndexContent` 为
   `undefined`/空串/纯空白 → 返回 `null`；两者在场 → 返回含 R3 三要点的英文文本。
4. **memory_recall 配额**：距上一条 `memory_recall` < 5 assistant turn → `null`；
   ≥ 5 → 文本；历史里已有两条时按最近一条计数（不是累加）。
5. **分类归属**：`memory_recall` ∈ per-request 数组、∉ persisted 数组；
   descriptor = `current_turn` / `per_current_turn` / isMeta / provider_visible /
   `sr.memory_recall`；`isMidConversationSystemSource("memory_recall")` = true；
   `wrapSystemReminderForSource("memory_recall", body)` 产出单层 `<system-reminder>` 包裹。
6. **三数组结构不变量**：两两不相交、并集等于 `SYSTEM_REMINDER_SOURCES`、每个 source 都有 descriptor。
7. **双链路回放分类**（R7 的 1、2）：同一条 `todo_reminder` 持久 notice 在
   desktop-continuous 与 web-remote-replayable 两侧都不被判为真实用户输入。
8. **per-request 不落盘**（R7 的 3）：`memory_recall` 不在三个跨包名单里。
9. **注入点确实到达 provider 请求**：`memory_recall` attachment 经
   `buildProviderRequestMessages` 默认路径投影成最新真实用户输入**之后**的一条
   `role: "system"` 消息（正文原样——mid-conversation-system 通道不需要 wrapper）；
   `useMidConversationSystem: false` 的回退路径投影成单条 `role: "user"` 消息，
   内容逐字等于 `wrapSystemReminderForSource("memory_recall", body)`（只包一层）。
10. **验证命令**（仓库根执行，如实记录）：
   `node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/core/tsconfig.json --noEmit`、
   `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check -- --changed`、
   `node --import tsx --test apps/acode-cli/tests/*.test.mjs`。

## 不在本项范围

- **Memory 段 / env 段正文**：归 P6（`context/sections/memory.ts`、`env-info.ts`），本期禁触。
- **段注册表与 manifest**：归 P2/P3（`system-prompt-section-registry.md`）；该 spec `:263-264`
  已明确「reminder 三来源分类的扩展归 P7，本 spec 不接管 `source.ts:20-51`」。
- **ToolSearch / 延迟工具名单提醒**：归 P5（先测量后立项）。
- **把 `todo_reminder` 迁出 persisted 档**：不做。它的正文含当时的 todo 清单（状态文本），
  按 R4 判据属 persisted；迁移会改变冷恢复语义，且要动 contracts/bootstrap/shared 三处枚举。
- **提醒频率可配置化 / 新环境变量**：不做（`AGENTS.md`：能不做环境变量就不做；
  两个阈值都是命名常量，改一处即全局生效）。
- **A/B、分桶、服务端下发提醒文本**：非目标（方案 §7.1；`no-telemetry.md` 红线）。

## 落地偏差记录（P7 实施，2026-09-29）

1. **载体节奏**：方案 §4 P7 写「借 `runtime-reminders.ts` **每 5 turn** 载体新增：
   TodoWrite 久未使用提醒；召回记忆提醒」。实施时 ① **保留既有 10/10 turn 专用载体**
   （`TODO_REMINDER_CONFIG`）而不是改成 5：该载体已接线、已 persist、已有 turn 计数口径，
   同一个提醒出现两种节奏会造成两个所有者；本期只按 R1 加内容门槛。
   ② `memory_recall` 按方案用 **5 turn** 节奏（`MEMORY_RECALL_REMINDER_CONFIG`），
   它是新注入点、无既有载体可复用。
2. **所有权**：实施范围为 `runtime/helpers/runtime-reminders.ts`、
   `system-reminder/source.ts`、新增测试与本 spec；`runtime/methods/turn-loop.ts`
   是 turn 级 attachment 的唯一提交点（`runtime-reminders.ts` 只导出纯函数、自身无法注入），
   经升级提问获批后做**最小加法**接线（约 12 行），未触碰并行改动中的
   `core/src/tool/scheduler.ts` 与 `runtime/methods/config.ts`。
3. **v4 schema**：本期两个提醒都**不产生新 persisted source**（R2 复用 `todo_reminder`、
   R3 走 per-request 档），因此 `packages/shared` v4、`contracts` 枚举与 `bootstrap` v4
   origin 映射零改动；方案 §4 P7「若产生新 persisted source → 同步 v4 schema」的条件未触发。
   双链路不变量按 R7 以断言固化（含「有人日后把 `memory_recall` 挪进 persisted 档却漏改
   跨包分类」的兜底失败）。
