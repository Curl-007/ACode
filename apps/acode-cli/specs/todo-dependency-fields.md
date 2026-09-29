# todo 依赖字段：blockedBy / metadata 语义、环检测与向后兼容（D4）

调度主线 P2 项（Phase 3）。给 `TodoWrite` 的任务清单加**最小依赖形态**：可选的
`blockedBy`（列表内 id 引用）与可选的 `metadata`（有界标注），并在工具输出里区分
「现在可做的」与「还被挡着的」。

裁剪边界（方案 D4 原文）：**不做** owner / 认领 / `blocks` 反向边 / TaskList 四件套——
ACode 没有多 peer 协作的产品面，加这些是投机设计。本 spec 只做「一个 agent 自己排的清单
能表达先后依赖」这一件事；未来若出现 team 机制，以本 spec 为演进基础。

## 背景

### 已核实的现状

**数据形态是扁平三字段，没有 id**：

- `contracts/src/tools/todo.ts:26-30` `TodoItemSchema = z.object({ content, status, priority })`
  ——`content` 非空字符串、`status` 枚举 `pending|in_progress|completed`、`priority` 枚举
  `high|medium|low`。**没有 `id` 成员**，所以今天没有任何东西可以被 `blockedBy` 引用。
- `z.object` 未加 `.strict()`，即 Zod 默认的 **strip** 行为：模型今天若发 `blockedBy`，
  它会被静默丢弃而不是报错。这是本项要修的第一个事实——静默丢弃让作者以为依赖生效了。
- `contracts/src/tools/todo.ts:53-59` `TodoWriteInputSchema` 外层是 `.strict()`
  （未知**顶层**键报错），但严格性不传导进数组元素。
- `:57` 的 `describe` 写着「At most one item may be in_progress at a time」。

**「恰一个 in_progress」在 schema 层已停用**（对方案 A8 表述的一处更正）：
`contracts/src/tools/todo.ts:60-70` 是整段注释掉的 `superRefine`，注释原文说明理由——
「多 subagent / 并行任务下需要允许多个 in_progress，旧的 schema 硬拒绝会让 TodoWrite 失败
并触发后续调度组被跳过；先整段注释保留，便于回滚或对比」。
所以方案 A8 说的「『恰一个 in_progress』纪律已同源具备」只在**工具描述**层成立
（`core/src/tool/handlers/todo.ts:139` 的第三条 bullet「Keep one item `in_progress` at a time
and mark it `completed` when done」），schema 层不强制。本 spec **不恢复**该 `superRefine`
（恢复会与并行子代理场景冲突，且注释里已记录了它造成的调度组跳过故障）。

**整表替换语义**：

- 工具描述明写「Send the full list each call; it replaces the previous one」
  （`handlers/todo.ts:138`）。
- handler：`handlers/todo.ts:47-72`——`:64` 先 `readTodos` 取旧值、`:65` `updateTodos` 写新值、
  `:67-71` 返回 `{ oldTodos, todos, summary }`；`summary` 由 `:191-198` `summarizeTodos` 产出
  四个计数（total / pending / inProgress / completed）。
- 持久化：`adapters/src/storage/session-store/repositories/todos.ts` 的 `updateTodos` 在一个
  `begin immediate` 事务里 **delete-all + 按数组下标重插**
  （`for (const [position, todo] of input.todos.entries())`），列固定为
  `session_id, content, status, priority, position, time_created, time_updated`。
- 表结构：`adapters/src/storage/session-store/migrations.ts:64-75`
  （`create table if not exists todo (... primary key(session_id, position))` +
  `todo_session_idx`）。**`position` 是主键的一半**，且每次写入按新数组下标重算。

**四处 narrowing / 投影（新字段必须逐一核对，否则写了读不回来或投影不一致）**：

| 位置 | 现在做什么 |
| --- | --- |
| `adapters/src/storage/session-store/codecs.ts:182-188` `decodeTodoRow` | 从 `TodoRow`（`rows.ts:57-65`，含 `position`）显式挑出 `content`/`status`/`priority`，**丢弃 `position`** |
| `bootstrap/src/acode-protocol/session-mapper.ts:1063-1069` `mapTodoItem` | 显式重建 `{ content, priority, status }` 三字段 |
| `packages/services/src/acode-agent/acodeTaskServiceAdapter.ts:3830-3841` `sessionTodosToPlanSteps`（**仓库根，CLI 之外**） | 投影成 UI 的 `ACodePlanStep`（`packages/shared/src/acode-task-types-core.ts:613-617`，成员为 `id`/`title`/`status`），其中 **`id` 由位置派生**：`` id: `todo-${index}` `` |
| `packages/shared/src/tool-plan-adapter.ts:23-48` `parsePlanStep`（**仓库根，CLI 之外**） | 从工具 input/output 里直接解析 plan 步骤（`extractPlanStepsFromToolInput:129-140` / `extractPlanStepsFromToolOutput:142-160`，工具名判据 `isTodoPlanToolName:108-110`）。**它已经读 `id`**：`:44` `id: readString(value.id) ?? title`；title 取自 `content`/`step`/`title`/`text`/`activeForm`（`:32-37`），`priority` 被忽略 |

后两处是本项最重要的既有事实：**UI 侧已经有 id 概念，而且两个投影的派生法互不相同**——
`acodeTaskServiceAdapter.ts:3836` 用 `` `todo-${index}` ``（位置派生；同文件 `:3849-3867` 的
`sessionTodoGroupsToRuntime` 同样派生 `` `${group.id}-todo-${index}` ``），
而 `tool-plan-adapter.ts:44` 用 **content 文本本身**当 id、缺席才回落。
位置派生的 id 在整表替换下不稳定（插入一项就全移位），所以今天 UI 的 React key 会随每次
`TodoWrite` 漂移；content 派生的 id 则在两项文本相同时**直接撞车**。
本项引入作者提供的稳定 id 后，这两个既有 wart 都有了修法——但修它们要动
`packages/services` 与 `packages/shared`，**超出 CLI 所有权**，见 R7 与「不在本项范围」。

一个必须知道的脆弱点：`tool-plan-adapter.ts:78-82` 的 `extractPlanStepsFromValue` 是
**全有或全无**（`steps.length === collection.length ? steps : null`）——列表里任何一项解析失败，
整个 plan 投影返回 null。本项新增的三个字段不会触发失败（`parsePlanStep` 只要求
title + 合法 status，`:39-41`），但任何让某一项多带一个**非法 status** 的改动都会
静默抹掉整块 UI 摘要。验收场景 9 据此加了一条断言。

### 消费面

- `TodoRead`（`handlers/todo.ts:25-45,74-128`）：只读 session 本地任务状态，
  `sideEffectScope: "none"`、`readOnly: true`、`concurrentSafe: true`。
- `TodoWrite`（`handlers/todo.ts:130-189`）：`sideEffectScope: "session"`、`readOnly: true`
  （不触碰外部世界）、**`concurrentSafe: false`**（`:142`）——这条与本项直接相关：
  并发写整表替换本来就是最后写入者胜，依赖字段不改变这一点，但**环检测与 available 派生
  必须在同一次写入的快照上判定**，不得跨调用读取（见 R4）。
- 提醒载体：`system-reminder/source.ts:22-38` 的 `todo_reminder` 是 PERSISTED source
  （descriptor `:106`，channel `current_turn`、lifecycle `per_current_turn`）；
  方案 P7 计划新增「TodoWrite 久未使用提醒」，与本项正交。

## 产品规则

### R1 稳定 id：可选写入、规范化补齐、只在单次提交内解析

- `TodoItemSchema` 新增 **可选** `id: z.string().min(1).max(64).optional()`。
  64 字符与 `ARTIFACT_CAPS.maxIdLength`（`dynamic-workflow/src/facade/artifact-caps.ts`）同量级，
  理由是同一个：id 会进 journal/DB/提示词，必须有界。
- **规范化（normalize）**：写入前对整个列表做一次纯函数规范化——
  - 有显式 `id` 的项原样保留；
  - 缺 `id` 的项按**数组下标**铸 `todo-<index>`（0 起）。
    这个派生法与 `packages/services/.../acodeTaskServiceAdapter.ts:3836` 的既有 UI 投影
    **逐字同形**，因此即使该投影一行不改，两边算出的 id 也一致（不产生第二套 id 词汇）。
    注意它与另一处投影 `packages/shared/src/tool-plan-adapter.ts:44`（content 当 id）**不同形**；
    本 spec 选位置派生而不选 content 派生，因为 content 派生在两项文本相同时会撞车，
    而 R1 要求 id 列表内唯一。统一两处投影属跨包项（R7）。
  - 规范化后的 id 必须**列表内唯一**；显式 id 与派生 id 撞车（例：作者写了 `id: "todo-0"`
    而第 0 项缺 id）→ schema 报错，不做静默改名。
- **`blockedBy` 只在同一次提交的列表内解析**：
  - 类型 `z.array(z.string().min(1).max(64)).max(32).optional()`（每项一个 id 引用；
    32 条上界防一个项把整张表当成自己的前驱）。
  - 引用必须命中**本次提交规范化后**的某个 id；命中不了 → schema 报错（悬空引用），
    **不静默忽略**。静默忽略会让作者以为依赖生效了，与 strip 掉 `blockedBy` 是同一类错误。
  - 被引用项**必须有显式 id**：因为模型无法预知缺 id 项会被派生成什么，允许引用派生 id
    等于让作者猜。判定：若 `blockedBy` 里某个字符串只命中一个**派生** id → 报错，
    错误消息要求作者给被引用项写上 `id`。
  - **不做跨调用的持久依赖解析**：整表替换（`handlers/todo.ts:138`、
    `repositories/todos.ts` 的 delete-all+re-insert）之下，上一次提交的 id 在下一次提交里
    没有任何保证仍存在。跨调用追踪依赖等于引入第二份状态（违反根 `AGENTS.md`
    「避免重复状态和多条写入路径」）。
- **自引用**（`blockedBy` 含自己的 id）算环，见 R3。

### R2 metadata：有界、纯标注、不参与任何决策

- `TodoItemSchema` 新增 **可选** `metadata: z.record(z.string(), z.unknown()).optional()`，
  并受以下上界约束（超任一即 schema 报错，**不截断**——与
  `dynamic-workflow/src/facade/world-read-caps.ts` 的「绝不截断后加个标志位」同一条论证：
  截断把悄悄残缺的数据交给消费者）：
  - 键数 ≤ 16；
  - 单个键 ≤ 64 字符；
  - 规范化 JSON 序列化后 ≤ 4 KB（与 `REPORT_CAPS.maxItemSerializedBytes` 的 32 KB 相比更严，
    因为 metadata 是**每项**都有，而 report 是每 run 256 条）。
- 值必须 JSON 可序列化（plain object / array / string / number / boolean / null；
  函数、类实例、`Date`、promise 一律拒绝——与 `facade/dts.ts:75-100` 对 `report` item 的
  同一套要求）。
- **纯标注语义**：`metadata` 不参与 available 判定、不参与环检测、不参与排序、
  不进 `summarizeTodos`（`handlers/todo.ts:191-198`）的任何计数。它只是作者给未来消费者
  （UI 徽章、审计、外部脚本）留的挂载点。**任何**读 `metadata` 做调度决策的代码都违反本条。
- 常量归口：三个上界写进 `contracts/src/tools/todo.ts` 的命名常量
  （`apps/acode-cli/AGENTS.md:13`：字符串、数字等常量应提取为命名变量，不散落字面量）。

### R3 环检测：显式报错，不静默断边

- 判定对象是**本次提交规范化后的整张表**：把每项看作节点、`blockedBy` 看作入边，
  检测有向环（含长度 1 的自引用环）。
- 命中环 → schema 层报错（`TodoWriteInputSchema` 的 `superRefine`），错误消息必须**点名环上的 id
  序列**（例：`a → b → a`），不能只说「有环」——作者要能一眼定位。
- **不做的三种退让**：
  1. 不静默删掉造成环的那条边（等于悄悄改了作者的意图）；
  2. 不把环上的项标成 available（那会让「被挡着」与「可做」同时成立）；
  3. 不自动拓扑重排列表顺序（顺序是作者的表达，`position` 是 DB 主键的一半，
     `migrations.ts:64-73`；重排等于替作者做决定）。
- 环检测是**纯函数**，输入规范化后的列表、输出 `undefined | { cycle: string[] }`；
  不读时钟、不做 I/O、不读 DB（与 `dynamic-workflow/src/engine/concurrency.ts:5-8`
  对纯包的同款纪律）。

### R4 available 过滤：派生只读投影，不落库

- `TodoWriteOutput`（`contracts/src/tools/todo.ts:100-102`，现为 `{ oldTodos, todos, summary }`）
  与 `TodoReadOutput`（`:39-47`，现为 `{ todos }`）**增加 available 视图**。
  ~~形态二选一，在实现 PR 里定并回写本小节~~（**已回写**：实施批次选定推荐的
  **(i)+(ii) 同时给**——`summary.available` 计数 + 每项派生布尔 `todos[i].available`；
  逐项布尔经 `TodoItemViewSchema`（`TodoItemSchema.extend({ available })`）只出现在输出
  schema，不进写入面、不落库）：
  - (i) 在 `summary` 里加计数：`summary.available: number`（`TodoSummary` 见 `:76-81`）；
  - (ii) 每项加派生布尔：`todos[i].available`（**只在输出**上出现，不进 `TodoItemSchema`
    的写入面，不落库）。
  - 推荐 (i)+(ii) 同时给：计数供提示词与 UI 摘要用，逐项布尔供作者定位。
- **available 的定义**：`status === "pending"` 且（`blockedBy` 缺席 / 为空数组 /
  其引用的每一项在本次提交里 `status === "completed"`）。
  即「指向已完成项的依赖视为已解除」——这让作者不必在标记完成的同时手工删边。
- **它是派生投影，不是第二份状态**：不落 `todo` 表、不进 journal、不由 handler 缓存。
  每次读取/写入时从当次列表重算（`concurrentSafe: false` 的整表替换语义下，
  跨调用缓存 available 必然陈旧）。
- **`in_progress` 与 `completed` 项永不 available**：available 只回答「下一个能开工的是哪些」，
  已经在做的和已经做完的都不在这个问题的答案里。

### R5 向后兼容与持久化

- **旧格式提交（无 `id` / `blockedBy` / `metadata`）行为逐项不变**：规范化只铸派生 id，
  不改 content/status/priority；available 对无 `blockedBy` 的 pending 项恒为 true；
  `summary` 的既有四个计数（total/pending/inProgress/completed）值不变。
  这是本项的零回归基线，必须有快照测试钉住。
- **strip 行为改为显式**：`TodoItemSchema` 加 `id`/`blockedBy`/`metadata` 后，
  仍未知的键**继续 strip**（不加 `.strict()`）。理由：加 strict 会让既有客户端
  （含旧版本的插件/脚本）因多带一个键而整次 `TodoWrite` 失败，而失败会触发
  `contracts/src/tools/todo.ts:60-70` 注释里记录过的同类故障（调度组被跳过）。
  三个新键从「被 strip」变成「被解析」，这是本项唯一的兼容性方向变化。
- **CLI 侧的两处 narrowing 必须同批改**（背景表前两行）：`codecs.ts:182-188` `decodeTodoRow`、
  `session-mapper.ts:1063-1069` `mapTodoItem`，以及 CLI 侧任何重建 `TodoItem` 的位置。
  漏一处的症状是「写进去了、读回来只剩三字段」，且**不报错**——必须有往返测试
  （write → read → 逐字段相等）钉住。
- **CLI 之外的两处投影不需要改，但必须核对**（背景表后两行）：
  `acodeTaskServiceAdapter.ts:3830-3841` 只读 `status`/`content`，
  `tool-plan-adapter.ts:23-48` 只读 `content` 族 + `status` + `id`——
  新增的 `blockedBy`/`metadata` 在两处都被忽略（不会报错、不会破坏投影），
  而新增的 `id` 会被 `tool-plan-adapter.ts:44` **直接采用**（它本就是 `readString(value.id) ?? title`）。
  这意味着本项落地后，经工具 input/output 解析出来的 plan 步骤会立刻用上稳定 id，
  而经 session snapshot 投影出来的仍是位置 id——两处**短暂不一致**是预期的，
  由 R7 的跨包项收口。验收场景 9 钉住这个事实。
- **DB schema 变更（需按 `apps/acode-cli/AGENTS.md:14` 先与模块维护者确认）**：
  `todo` 表现有七列固定、`primary key(session_id, position)`（`migrations.ts:64-73`）。
  推荐方案：**加一个 nullable 列 `deps_json text`**，存规范化后的
  `{ id?, blockedBy?, metadata? }` 序列化结果；migration 序号接在现有最后一个之后
  （当前为 `migrations/0022-backfilled-session-reasoning.ts`，即新增 `0023-*`）。
  - 选一个 JSON 列而不是三个新列的理由：`blockedBy` 本身是数组（要么再开一张边表，
    要么 JSON），而 `metadata` 是开放记录；三个字段一起进一个 JSON 列，
    未来扩展不再改表，也避免为依赖关系建第二张表（= 第二份状态）。
  - **前向兼容已天然成立**：`decodeTodoRow` 显式挑字段（`codecs.ts:183-187`），
    旧版本代码执行 `select *` 读到新列也会忽略它。因此**回滚策略 = 忽略该列**，
    不需要 down migration；已写入的 `deps_json` 在回滚后成为惰性数据，
    重新升级后原样读回（不丢依赖）。
  - **不改主键**：`position` 仍是主键的一半，`updateTodos` 仍是 delete-all + re-insert
    （`repositories/todos.ts`）。稳定 id 存在 `deps_json` 里，不取代 `position`——
    取代它就是改主键，那是远大于本项的迁移。
  - 若模块维护者否决加列，备选是把三字段编码进 `content`（**本 spec 否决**：污染作者文本、
    破坏 UI 的 `title: todo.content` 投影，`acodeTaskServiceAdapter.ts:3839`）。
    此时本项降级为「只在单次工具调用内有效、不持久化」，必须在实现 PR 里写明降级事实。

### R6 提示词纪律（挂 D1 的承载层规则）

- `TodoWrite` 工具描述（`handlers/todo.ts:135-139`）新增三条 bullet，说明
  `id` / `blockedBy` / `metadata` 的**调用细节**（how to call）：id 列表内唯一、
  `blockedBy` 引用同批 id、被引用项必须显式给 id、成环会报错、metadata 有界且纯标注。
- **跨工具工作策略**（「最小可用 id 优先」「开工前核对 blockedBy 已清空」
  「更新前重读防陈旧」）按 `dispatch-discipline-prompt.md` R1 的分层规则，
  归 **system 动态段**而不是工具描述——因为「更新前重读」同时涉及 `TodoRead` 与 `TodoWrite`，
  是跨工具策略。该段以一句话挂在 D1 的纪律节里（`dispatch-discipline-prompt.md` R2 的
  承载层），本 spec 不新建 system 段。
- 「恰一个 in_progress」的既有 bullet（`handlers/todo.ts:139`）**保留为提示**，不升级为
  schema 硬约束（R 背景章的更正）。
- 文本语言遵守 `prompt-language-policy.md` R1/R2：工具描述与 system 段恒英文；
  UI 侧新增的依赖展示文案走 i18n。

### R7 所有权边界：CLI 之外的消费面只登记不改动

- 本项的改动范围限于 `apps/acode-cli`：`contracts/src/tools/todo.ts`、
  `core/src/tool/handlers/todo.ts`、`adapters/src/storage/session-store/{codecs.ts,rows.ts,
  repositories/todos.ts,migrations.ts,migrations/0023-*}`、
  `bootstrap/src/acode-protocol/session-mapper.ts`。
  - **2026-09-29 实施批次修正（升级裁决）**：改动范围补上仓库根
    `packages/shared/src/acode-protocol/index.ts` 的 `acodeSessionTodoItemSchema` **一处**
    （最小加宽：新增可选 `id`/`blockedBy`/`metadata`，保持 `.strict()`）。原因见
    「实施记录」第 4 条——本节原分析漏列了这第 5 处 narrowing。
- **仓库根的 `packages/services` 与 `packages/shared` 不在本项改动范围**：
  - `sessionTodosToPlanSteps`（`acodeTaskServiceAdapter.ts:3830-3841`）继续用位置派生 id
    也能正常工作（因为 R1 的派生法与它逐字同形，缺 id 时两边一致）。
  - `tool-plan-adapter.ts:23-48` **不需要改就会用上稳定 id**（`:44` 已是
    `readString(value.id) ?? title`）；这是本项落地后两处投影短暂不一致的来源（R5）。
  - 统一两处投影的 id 派生（并顺带修掉 UI 的 React key 漂移与 content 撞车）是一个
    **独立的跨包项**，需要动 `ACodePlanStep` 的两个生产方；本 spec 把它登记在
    「不在本项范围」，不在此实现。
- 若实现 PR 判定必须同批改 UI 投影，须先按根 `AGENTS.md` 的跨包纪律走公开入口，
  并在本小节追加记录（含改动文件与验证命令）。

## 状态所有者

```
模型提交 TodoWrite（整表）
   │
   ├─ contracts/src/tools/todo.ts        TodoItemSchema（+id/blockedBy/metadata）、
   │                                       TodoWriteInputSchema.superRefine（R1 唯一性 / R3 环检测 /
   │                                       R2 上界）——写入合法性的唯一判定点
   ├─ core/src/tool/handlers/todo.ts     规范化（铸派生 id）+ available 派生（R4，纯函数、不落库）
   │                                       └─ :64 readTodos 旧值 / :65 updateTodos 新值（既有顺序不变）
   │
   └─ adapters/.../repositories/todos.ts 持久化唯一所有者：todo 表（delete-all + re-insert，
          │                               position = 数组下标，primary key(session_id, position)）
          └─ deps_json 列（新，nullable）  id/blockedBy/metadata 的唯一持久化家
                 ▲
          adapters/.../codecs.ts:182-188  decodeTodoRow（读回时必须带上三字段，R5）
                 ▲
          bootstrap/.../session-mapper.ts:1063-1069  mapTodoItem（协议投影，必须带上三字段，R5）
                 ▲
          packages/services/.../acodeTaskServiceAdapter.ts:3830-3841（CLI 之外，位置派生 id，
                 本项不改；R7）

唯一事实源：todo 表。available 与派生 id 都是**当次列表的纯函数投影**，
不存在第二份状态、不存在第二条写入路径（根 AGENTS.md「避免重复状态和多条写入路径」）。
```

## 接口

- `contracts/src/tools/todo.ts`：
  ```ts
  export const TODO_ID_MAX_CHARS = 64;
  export const TODO_BLOCKED_BY_MAX_ITEMS = 32;
  export const TODO_METADATA_MAX_KEYS = 16;
  export const TODO_METADATA_MAX_KEY_CHARS = 64;
  export const TODO_METADATA_MAX_SERIALIZED_BYTES = 4 * 1024;

  export const TodoItemSchema = z.object({
    content: z.string().min(1),
    status: z.enum(["pending", "in_progress", "completed"]),
    priority: z.enum(["high", "medium", "low"]),
    id: z.string().min(1).max(TODO_ID_MAX_CHARS).optional(),             // R1
    blockedBy: z.array(z.string().min(1).max(TODO_ID_MAX_CHARS))
      .max(TODO_BLOCKED_BY_MAX_ITEMS).optional(),                        // R1
    metadata: z.record(z.string(), z.unknown()).optional(),              // R2（上界在 superRefine）
  });

  export interface TodoSummary { total; pending; inProgress; completed; available }  // R4(i)
  ```
  `TodoWriteInputSchema` 保持 `.strict()` 于顶层、数组元素保持 strip（R5）；
  新增 `superRefine` 承载 R1 唯一性/显式 id 要求、R2 上界、R3 环检测。
- `core/src/tool/handlers/todo.ts`：
  - `normalizeTodos(todos: TodoItem[]): NormalizedTodo[]`（纯函数，铸派生 id）
  - `detectTodoCycle(todos: readonly NormalizedTodo[]): { cycle: string[] } | undefined`（纯函数，R3）
  - `computeAvailable(todos: readonly NormalizedTodo[]): boolean[]`（纯函数，R4）
  - `todoWriteToolEntry.metadata.description` 增三条 bullet（R6）；
    `summarizeTodos`（`:191-198`）增 `available` 计数。
- `adapters/src/storage/session-store/rows.ts:57-65`：`TodoRow` 增 `deps_json: string | null`。
- `adapters/src/storage/session-store/codecs.ts:182-188`：`decodeTodoRow` 读回三字段。
- `adapters/src/storage/session-store/migrations/0023-*.ts`（新）：`alter table todo add column deps_json text`。
- `bootstrap/src/acode-protocol/session-mapper.ts:1063-1069`：`mapTodoItem` 带上三字段。
- `contracts/src/interfaces/session-store.port.ts:1194-1195`：`readTodos` / `updateTodos`
  **签名形状不变**（参数与返回仍是 `{ sessionID }` / `TodoItem[]`），只是 `TodoItem` 变宽。
- 不新增 `ACODE_` 环境变量（`apps/acode-cli/AGENTS.md:21`：能用 schema/常量表达的不做成 env）。
- 不新增 system-reminder source（`system-reminder/source.ts:20-51` 的三来源分类不动；
  P7 的「TodoWrite 久未使用提醒」是独立项）。

## 验收场景

1. **环检测**：`a.blockedBy=[b]`、`b.blockedBy=[a]` → schema 报错且消息点名 `a → b → a`；
   自引用 `a.blockedBy=[a]` → 报错；三元环 → 报错并点名完整序列；
   无环（链式 `c←b←a`）→ 通过。**不静默断边**：断言报错时 `updateTodos` 未被调用
   （`handlers/todo.ts:65` 未执行，DB 无变化）。
2. **悬空引用与派生 id 引用**：`blockedBy` 指向列表内不存在的 id → 报错；
   指向一个**缺显式 id** 的项（只会命中派生 id）→ 报错，消息要求给被引用项写 `id`。
3. **available 过滤**：
   - `pending` 且无 `blockedBy` → available；
   - `pending` 且 `blockedBy` 全指向 `completed` 项 → available（R4「已解除」）；
   - `pending` 且 `blockedBy` 含一个 `pending`/`in_progress` 项 → 不 available；
   - `in_progress` / `completed` 项 → 永不 available；
   - `summary.available` 与逐项布尔的计数一致。
4. **旧格式向后兼容快照**：提交一份只有 `content`/`status`/`priority` 的列表
   （本项之前的形态）→ 写入成功；`readTodos` 返回的三字段逐字节等于提交值；
   `summary` 的 total/pending/inProgress/completed 四个计数与改动前实现一致；
   规范化只额外铸出 `todo-<index>` 形式的派生 id。
5. **往返一致（CLI 侧两处 narrowing）**：write → read → 逐字段相等，含
   `id`/`blockedBy`/`metadata`；经 `session-mapper.ts:1063-1069` 的协议投影后三字段仍在（R5）。
6. **migration 前后**：
   - 在**未升级**的 DB 上跑新代码 → migration 0023 执行、旧行 `deps_json` 为 null、
     读回等价于旧格式（三字段缺席）；
   - 在**已升级**的 DB 上跑旧代码（回滚场景）→ 旧 `decodeTodoRow` 忽略新列、读写正常
     （前向兼容，R5）；
   - 升级后再回滚再升级 → 之前写入的 `deps_json` 原样读回，依赖不丢。
7. **metadata 上界**：键数 17 / 单键 65 字符 / 序列化 4 KB+1 → 各自报错，**不截断**；
   非 JSON 可序列化值（函数、`Date`、类实例）→ 报错；
   `metadata` 不影响 available、环检测、排序与 `summarizeTodos` 的任何计数（R2 纯标注）。
8. **不恢复单 in_progress 硬约束**：提交含两个 `in_progress` 的列表 → 写入成功
   （`contracts/src/tools/todo.ts:60-70` 的 `superRefine` 保持注释状态）。
9. **CLI 之外的两处投影不回归**（本项不改它们，R5/R7）：
   - `acodeTaskServiceAdapter.ts:3830-3841` 在缺 id 与有 id 两种提交下都产出合法的
     `ACodePlanStep[]`，且缺 id 时的 id 与 CLI 侧规范化铸出的派生 id **逐字相同**
     （若不同说明 R1 的派生法与既有投影不同形，判为缺陷）；
   - `tool-plan-adapter.ts:23-48,78-82`：有 id 时 `parsePlanStep` 采用该 id（`:44`）；
     新增的 `blockedBy`/`metadata` 不导致任何一项解析失败，因此
     `extractPlanStepsFromValue` 的**全有或全无**判定（`:82`）仍返回完整步骤数组而不是 null；
   - `packages/ui/src/ToolCallBlocks/renderers/todo.tsx` 的渲染快照不变。
10. **并发写不引入新竞态**：两次并发 `TodoWrite`（`concurrentSafe: false`，
    `handlers/todo.ts:142`）→ 最后写入者胜，与改动前一致；available 与环检测
    都只在各自那次提交的快照上判定，不跨调用读取（R4）。
11. **验证命令**（从仓库根执行，如实记录结果）：
    - 测试：`node --import tsx --test apps/acode-cli/tests/todo-dependency-fields.test.mjs`
      （新文件，遵循 `apps/acode-cli/tests/*.test.mjs` 的 `node:test` + `assert` 约定；
      写前先读 `tests/managed-policy-floor.test.mjs`、`tests/no-telemetry.test.mjs` 学约定）
    - 类型检查：`node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/contracts/tsconfig.json --noEmit`
      与 `... -p apps/acode-cli/packages/core/tsconfig.json --noEmit`
      （不用 `pnpm --dir apps/acode-cli typecheck`：turbo 不在 PATH；
      `cli` 包有既有环境红 TS2307，不作为门禁）
    - `pnpm typecheck`（root，覆盖 `packages/*`，用于验证 UI/services 侧未被破坏）
    - `pnpm lint`（root，oxlint，期望 0 error；约 76 warnings 是基线）
    - `pnpm architecture:check -- --changed`（期望 0 violations）

## 实施记录（2026-09-29，D4 实施批次）

按 R4/R5 的回写要求与 `apps/acode-cli/AGENTS.md:14` 的确认纪律，记录本批次的实施决定：

1. **migration 0023 的维护者确认已给出**：数据库结构变更方案（`alter table todo add column
   deps_json text`，nullable，回滚 = 旧代码忽略该列、不需 down migration）经主代理升级裁决
   于实施时确认（2026-09-29），确认理由：可逆、nullable、本 spec R5 已定义回滚语义。
   落地为 `migrations/0023-todo-deps-json.ts` + `migrations.ts` 登记
   `id: "0023_todo_deps_json"`、`appVersion: "0.16.9"`。
2. **R4 形态选择**：(i)+(ii) 同时给（回写见 R4 小节）。`summary.available` 与逐项布尔从
   **同一份视图数组**派生（`handlers/todo.ts` 的 `toTodoViews` → `summarizeTodos(views)`），
   计数恒一致（验收场景 3 有断言）。
3. **纯函数落点修正**：「接口」节原把 `normalizeTodos` / `detectTodoCycle` / `computeAvailable`
   列在 `core/src/tool/handlers/todo.ts`；实际落在 **`contracts/src/tools/todo-deps.ts`**
   （经 `contracts/src/tools/todo.ts` 原样再导出，消费方导出面与「接口」节一致），core handler
   导入使用。理由：R3 要求环检测在 `TodoWriteInputSchema.superRefine`（contracts）判定，而
   R1/R4 要求 handler（core）用同一套规范化与派生——依赖方向 core→contracts 决定单一实现
   只能放 contracts，两处各自实现必然漂移。常量物理家同在 `todo-deps.ts`（避免与 `todo.ts`
   的运行时循环导入），`todo.ts` 再导出，导出面满足 R2「常量归口」。
4. **R7 原分析漏列第 5 处 narrowing（根协议 schema），经升级裁决按 AGENTS.md 协议同步规则
   加宽**：`packages/shared/src/acode-protocol/index.ts:856` 的 `acodeSessionTodoItemSchema`
   是 `.strict()` 三字段，且桌面接收方 `packages/services/src/acode-agent/acodeAgentService.ts`
   以它校验入站 snapshot——`mapTodoItem` 若携带新字段而根 schema 不加宽，桌面整条 snapshot
   解析失败（strict 拒绝未知键），类型层也因 `ACodeSessionStateSnapshot` 由该 schema 推断而
   被超属性检查封死。裁决：最小加宽（仅三个可选成员，保持 `.strict()`，不动该文件其他内容），
   与 mapper 同批落地。桌面接收方无消费方破坏（`sessionTodosToPlanSteps` 只读
   content/status）。
5. **v4 链路核查结论（双语义链路验证）**：v4 **不逐字段重建 TodoItem**——
   `acode-protocol-v4/product-projection.ts` 的 `todoPlanDeltas` 经 `@acode/shared`
   tool-plan-adapter 投影 `{ id, content, status }`（新字段被忽略、稳定 id 被直接采用、
   全有或全无判定不因新字段触发）；`event-normalizer.ts:433` 与 `projection-rows.ts:59` 仅把
   `todo_reminder` 归类为 synthetic origin，与 todo 项字段无关。web-remote-replayable 回放
   分类不变，v4 无需改动。
6. **`todoItemsFromToolResultContent` 改为宽容解析**：原实现用 strict 的
   `TodoReadOutputSchema`/`TodoWriteOutputSchema` 解析历史结果 JSON；输出形状加宽（逐项
   `available`）后，为保证 D4 之前的历史结果仍可解析，改用只要求顶层 `todos` 数组的宽容
   schema（元素按 `TodoItemSchema` strip 解析）。当前仓库内该函数无调用方（grep 核实），
   行为保持向后兼容。
7. **提示词承载**：R6 的三条调用细节 bullet 进 `TodoWrite` 工具描述；跨工具一句话纪律进
   `# Delegating work` 纪律节（`dynamic-sections.ts` `buildDelegatingWorkLines` 第 6 条），
   并**额外按 TodoRead+TodoWrite 同时在工具面门控**——不把依赖纪律注入没有 todo 工具的
   会话（dispatch-discipline-prompt.md R3/R5 同方向）。既有 golden 快照的工具面不含 todo
   工具，`dispatch-discipline-prompt.test.mjs` 的 SECTION_GOLDEN 因此无需改动。

## 不在本项范围

- **owner / 认领 / `blocks` 反向边 / TaskList 四件套**：方案 D4 明确裁剪（无多 peer 产品面）。
  未来 team 机制以本 spec 的 id + `blockedBy` 为演进基础。
- **跨调用的依赖持久追踪**：R1 已说明为什么不做（整表替换 + 会引入第二份状态）。
- **UI 采用稳定 id（修 React key 漂移）**：跨包项，需动 `packages/services` 与
  `packages/shared`（R7）。本项只保证派生 id 与既有投影同形，使 UI 不改也不坏。
- **恢复「恰一个 in_progress」的 schema 硬约束**：`contracts/src/tools/todo.ts:60-70`
  的注释已记录它造成的故障（并行子代理场景下 TodoWrite 失败 → 调度组被跳过），不恢复。
- **`todo_reminder` 的注入策略与「久未使用提醒」**：归方案 P7；本项不动
  `system-reminder/source.ts` 的三来源分类。
- **依赖图的可视化**：UI 侧新增展示形态是独立 UX 项。
- **全局任务调度 / 自动开工**：available 只是**只读投影**，回答「哪些能做」；
  由谁去做、什么时候做仍归模型与既有调度（`tool/scheduler.ts` 的拓扑排序 + 并行分组、
  `RuntimeCommandQueue` 的 now/next/later 三档）。本项不给 available 加任何自动执行语义
  （与 `dispatch-discipline-prompt.md` 的「不做运行时硬约束」同一姿态；
  并发治理的只读投影归方案 D5）。
