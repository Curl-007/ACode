# todo 完成置信度语义：completionConfidence、工具自有 confidenceHistory 与完成门槛（J2-1）

调度可信批次 P1 项。给 `TodoWrite` 的 `completed` 状态加**证据语义**：可选的
`completionConfidence`（标完成时点的证据状态，语义有序枚举）、工具自有的
`confidenceHistory`（追加式观测轨迹，模型自报一律 strip）、以及**完成门槛**
（新标记 completed 的项必须携带足够证据状态，否则校验报错并点名 id）。

裁剪边界（J2-1 任务指令原文）：**不做** spike 检测、turn 末质量门 replay、
double-check 回合、任何 nudge 逻辑（J2-2 评估项）；**不做**前瞻 `confidence`
双字段（本项只有 `completionConfidence` 一个模型可写字段）；**协议/UI 投影本轮收缩**
（见 R7——数据通路上的 4 个中间文件全部在本项所有权之外，宁可收缩也不做半吊子协议改动）。

## 背景

### 已核实的现状

- `contracts/src/tools/todo.ts:54-69`：`TodoItemSchema` = content/status/priority + D4 三字段
  （id/blockedBy/metadata），未知键 strip；`:71` `type TodoItem = z.infer<TodoItemSchema>`；
  `:78-84` `TodoItemViewSchema = TodoItemSchema.extend({ available })`（只出现在输出面）；
  `:105-124` `TodoWriteInputSchema` 顶层 `.strict()` + `superRefine(validateTodoList)`；
  `:198-219` `todoItemsFromToolResultContent` 历史结果宽容解析（D4 实施记录第 6 条）。
- `core/src/tool/handlers/todo.ts:50-81`：write handler 顺序 parse → normalize → views →
  `readTodos`(:73) → `updateTodos`(:74) → 返回 `{oldTodos, todos, summary}`；`:88-92`
  `toTodoViews`（规范化幂等 + available 派生）；`:155-162` 工具描述；`:215-223` `summarizeTodos`。
  **completed 是模型自报的裸状态，没有任何证据要求**（J2-1 方案「现状与证据」）。
- 持久化（D4 形态）：`adapters/src/storage/session-store/repositories/todos.ts` delete-all +
  按下标重插，列 `session_id, content, status, priority, position, time_created, time_updated,
  deps_json`；`codecs.ts:184-226` `decodeTodoRow`/`encodeTodoDeps`/`decodeTodoDeps`
  （null/坏 JSON/strict 校验失败 → 整列忽略）；`rows.ts:57-67` `TodoRow`；
  `migrations.ts` 最后一条为 `0023_todo_deps_json`（appVersion "0.16.9"）。
- 端口：`contracts/src/interfaces/session-store.port.ts:1194-1195` `readTodos`/`updateTodos`
  直接引用 `TodoItem` 类型——`TodoItem` 变宽时端口自动变宽（D4「只是 TodoItem 变宽」同款手法，
  端口文件零改动）。
- 协议面：`bootstrap/src/acode-protocol/server-operations.ts:3632-3649` `readSnapshotTodos` →
  `buildSessionSnapshot` → `session-mapper.ts:133` `input.todos?.map(mapTodoItem)`；
  `mapTodoItem`（`session-mapper.ts:1069-1078`）**显式重建**三字段 + D4 三字段——CLI 侧
  `TodoItem` 新增字段不会漏进协议 payload，根 `acodeSessionTodoItemSchema`
  （`packages/shared/src/acode-protocol/index.ts:856-867`，`.strict()`）不受影响。
- UI 面：`packages/ui/src/ToolCallBlocks/renderers/todo.tsx` 的数据来自
  `packages/shared/src/tool-plan-adapter.ts` `parsePlanStep`（只投影 `{id, title, status}`）；
  历史恢复走 `packages/services/src/acode-agent/acodeTaskServiceAdapter.ts:3830-3841`
  `sessionTodosToPlanSteps`（只读 content/status）。两条投影都不携带置信度。
- TUI：`tui/src/app-events.ts:399` `parseTodoItem` 自有宽容解析，逐字段挑取，新字段被忽略
  （类型加宽为可选成员，编译兼容）。
- 既有测试基线：`tests/todo-dependency-fields.test.mjs`（D4 验收，场景 3/4/5 含
  **新生 completed 项**的写入——本项门槛是有意的行为变更，需适配，见「D4 测试适配记录」）。

### jcode 参照机制（只读提炼，自撰 TypeScript 实现）

- `crates/jcode-task-types/src/lib.rs:390-398`：`ConfidenceState` 语义有序枚举
  Speculative→Plausible→Validated→Verified（带 legacy 0-100 数值双向映射；**ACode 没有
  legacy 数值分历史，不做数值映射**——只取「语义有序枚举替代数值分」机制）；
  `lib.rs:433-470` `TodoItem`：`confidence`（前瞻）/`completion_confidence`（完成时点）/
  `confidence_history`（工具维护，注释原文「Maintained by the todo tool (not the model)」）。
- `crates/jcode-app-core/src/tool/todo.rs:26-68` `merge_confidence_history`：每次工具写入
  每项**最多贡献一个观测**（「单次完成更新不能制造虚假的中间步骤」）、连续重复不追加
  （`history.last() != Some(&value)`）、模型自报 `confidence_history` 被忽略；用途是区分
  证据驱动爬升（75→85→95→100）与任务末批量盖章（75→100）。
- `crates/jcode-base/src/todo.rs:129-131` `completion_confidence_passes`：
  `state >= ConfidenceState::Validated`；`:690-724` 完成门槛的 continuation 消息
  **点名条目但不暴露 evaluator 语言、分数与阈值**（注释原文）。
- 机制差异：jcode 的门槛走 auto-poke continuation（nudge）；ACode 无 nudge 基建且 J2-1
  指令明确「不做任何 nudge 逻辑」，因此门槛落点 = **工具校验报错**（`InvalidInput`，
  模型同回合内可修正重发）。

## 产品规则

### R1 completionConfidence：可选语义枚举，向后兼容

- `TodoItemSchema` 新增**可选**成员
  `completionConfidence: z.enum(["speculative","plausible","validated","verified"])`。
  四级语义（进 schema `describe`，模型可见）：
  - `speculative`：未核查的猜测；
  - `plausible`：有推理但未实际核查；
  - `validated`：有直接证据核查过；
  - `verified`：端到端复现验证过。
- **有序性是实现细节**：排序（speculative < plausible < validated < verified）只存在于
  contracts 的私有 rank 映射里，供门槛判定；**不出现在任何模型可见的报错文案中**（R3/R6）。
  枚举成员顺序在 JSON schema 里天然可见，这不算泄露——保密对象是**门槛边界**。
- 向后兼容：缺省 = 未声明（旧格式列表照常解析）；未知键继续 strip（不加 `.strict()`，
  D4 R5 同款论证）。非法枚举值 → zod 类型报错（与 status/priority 同级，非本项新增失败面）。
- **不做前瞻 `confidence` 字段**：jcode 的双字段（工作中前瞻 + 完成时点）收缩为单字段。
  理由：前瞻字段的价值（证据爬升轨迹）由 `completionConfidence` + 工具自有 history 已可
  承载（模型可在 in_progress 阶段就开始报告完成证据状态）；双字段翻倍提示词与持久化面，
  而 J2-2（消费爬升轨迹的 spike 检测）尚未立项。登记在「不在本项范围」。

### R2 confidenceHistory：工具自有，只出不进

- **所有权**：`confidenceHistory` 是工具（handler 唯一写入路径）维护的追加式轨迹；
  **模型自报一律 strip**——它不是可写面 `TodoItemSchema` 的成员，zod 默认 strip 让任何形状
  的自报值（数组、字符串、垃圾）都被静默丢弃而不是让整次 `TodoWrite` 失败（与 D4 R5
  「多带一个键不应失败」同一论证；jcode 同款「Model-supplied confidence_history is ignored」）。
- **追加规则**（每次 `TodoWrite`，每项最多一条观测，纯函数 `appendConfidenceObservation`）：
  - 观测 = 本次提交该项的 `completionConfidence`（与 status 无关——非 completed 项报告的值
    同样入轨迹，这正是「证据爬升」的记录面）；
  - 观测缺席 → 轨迹原样保留（`undefined` 保持 `undefined`，**不物化空数组**——旧格式项
    读写前后逐字节不变，零回归基线）；
  - 与轨迹末位相同 → 不追加（连续去重，jcode `history.last() != value` 同款）；
  - 不同 → 追加到末位。
- **有界**：`TODO_CONFIDENCE_HISTORY_MAX = 16`，超限滑动窗口保留**最新** 16 条。
  与 metadata 的「超限报错不截断」不同，这里截窗口是合法的：history 是**工具自有**数据，
  报错会让模型为工具自己的累积负责（无法通过修改提交来修复）；4 个枚举值 + 连续去重下，
  溢出需要 ≥16 次震荡改写，属病态路径，窗口保存储有界（16×~12B ≈ 200B/项）。
- **id 匹配的局限与身份判据**：history 随 D4 稳定 id 跨写入追踪（`priorById`，与 jcode
  同款）；缺显式 id 的项按位置派生 id 匹配——列表重排时轨迹会跟错项。这是 D4 派生 id 的
  既有语义（`todo-dependency-fields.md` R1），需要稳定轨迹的作者应给显式 id；不为此加
  第二套匹配规则（避免重复状态）。**轨迹继承与 R3 豁免共用 id+content 双匹配判据**
  （对抗复核 F1）：同 id 但 content 变更的项**不继承**旧轨迹，轨迹从本次观测重新开始——
  否则补位/换内容的项继承前项 `["verified"]` 类轨迹，制造伪爬升，污染 J2-2 spike
  检测的数据源。
- **并发写入的观测丢失（对抗复核 F5 登记）**：同会话并发 `TodoWrite` 是
  last-writer-wins（`todo-dependency-fields.md` 场景 10 既有语义）；该语义下被覆盖提交里
  已追加的 confidenceHistory 观测会随整表替换一起丢失。J2-2 消费 history 时**不得假设
  轨迹无丢失**（缺口的成因是并发覆盖而不是证据造假，爬升/震荡类判据必须容忍缺口）。
- 输出面：`TodoItemViewSchema` 携带 `confidenceHistory` 只读投影（模型与 UI 可见）；
  `TodoRead`/`TodoWrite` 输出都带。**不进 summary 计数**（`summarizeTodos` 五计数不变）。

### R3 完成门槛：新转移受检、点名 id、文案保密

- **判定**（纯函数 `findCompletionGateViolations`，输入 = 本次提交规范化列表 + 持久化
  旧列表规范化结果，两者按 id+content 双匹配，见豁免判据）：对每个 `status === "completed"`
  的提交项——
  - **豁免（grandfather，id+content 双匹配）**：旧列表中同 id **且 content 逐字相同**的项
    已是 `completed` → 不受检。整表替换语义下已完成项每次都要重发；重检旧完成项会
    （a）让升级前会话的存量 completed 项（无置信度）永久卡死整张列表，（b）违反「旧格式
    读写正常」兼容基线。**content 匹配是豁免判据的必要部分**（对抗复核 F1，2026-09-30
    实证）：派生 id = `todo-<index>` 位置即身份，「剪掉已完成项 → 后项补位到同 id」「重排」
    这类日常列表整理，以及显式 id 换内容重发，在 id-only 匹配下都让新完成转移不带任何
    `completionConfidence` 写入成功（洗白完成门槛），且显式 id 一旦 completed 即成永久
    免检令牌。内容变更 = 新完成转移，重新受检；存量 completed 原样重发（content 不变）
    仍豁免，升级兼容不受影响；
  - 其余（新完成转移：pending/in_progress → completed、旧列表无此项的 born-completed、
    重开后再完成、同 id 换内容后再次完成）→ 要求 `completionConfidencePassesGate`：
    值在场且 rank ≥ `validated`；
  - 缺失或不足 → 违规。
- **豁免面就这一条**（无 trivial 清单豁免）：「什么算 trivial」本身会成为第二条判定路径，
  且门槛恒可被诚实报告满足（模型总能为真做完的项报告证据状态）。若落地后摩擦数据高发，
  按 J2-2 登记判据评估，不在本轮预设豁免。
- **报错形态**：handler 在 `readTodos` 之后、`updateTodos` 之前抛
  `createCoreError(CoreErrorType.InvalidInput, …, { recoverable: true, context: { todoIds } })`
  ——违规时**持久化零写入**（D4 场景 1「不静默断边」同款验收：`updateTodos` 未被调用、
  旧表无变化）；`recoverable: true`：模型补做验证、修正提交后同回合可恢复。
- **文案规则**（对齐 jcode「不暴露 evaluator 语言、分数、阈值」）：
  - 必须点名全部违规 id（例 `todos "a", "b" are marked completed …`）；
  - **禁止出现**：四个枚举值单词、"threshold"、"at least"、rank/排序表述、数值边界——
    模型应从证据出发重估，而不是瞄准门槛边界报值；
  - 指引动作：做验证工作，然后按实际拥有的证据重报 `completionConfidence`
    （字段名与枚举成员在 JSON schema 里本就可见，说字段名不算泄密；**哪个值过线**才是密）。
  - 单一文案模板覆盖「缺失」与「不足」两种违规——区分它们等于告诉模型
    「你报的 speculative 不够」，泄露边界。
- **落点在 handler 而不是 schema `superRefine`**：门槛需要旧列表（grandfather 判定），
  而 `superRefine` 是纯 schema 层、无 I/O（D4 R3 纪律）。handler 是唯一写入路径
  （`core/src/tool/handlers/todo.ts`），门槛与 history 追加同点收口。
- **subagent 同门槛**：子代理 session 有独立 todo 表，但走同一个 handler——无特判
  （J2-1 方案「风险与边界」的隔离问题，答案：同门槛、天然隔离）。

### R4 类型与宽容解析

- **`TodoItem` 域类型加宽为存储形状**：`todo.ts` 新增
  `StoredTodoItemSchema = TodoItemSchema.extend({ confidenceHistory: array(enum).max(16).optional() })`，
  `export type TodoItem = z.infer<typeof StoredTodoItemSchema>`。
  这是 D4「TodoItem 变宽、端口签名形状不变」的同款手法：`session-store.port.ts`、
  `codecs.ts`、`session-mapper.ts`、runtime/TUI 消费方**零改动**自动兼容
  （可选成员加宽对读写两个方向都是结构兼容的）。
  `z.infer<typeof TodoItemSchema>`（模型可写面）保持**不含** history——可写面与域类型
  故意不同形，这是「只出不进」的类型级表达。
- `TodoItemViewSchema` 改为 `StoredTodoItemSchema.extend({ available })`：输出视图 =
  可写字段 + 工具自有 history + 派生 available。executor 的 `runtimeOutputSchema`
  校验因此接受 history（漏改的症状是输出校验失败或字段被剥）。
- `todoItemsFromToolResultContent`（宽容解析，D4 实施记录第 6 条）：元素 schema 改为
  `TodoItemSchema.extend({ confidenceHistory: array(enum).optional() })`——**不带 max**
  （窗口上限是存储不变量，不是解析不变量；未来版本放宽窗口后回滚，历史结果仍可解析）。
  D4 之前（三字段）、D4 之后（+id/blockedBy/metadata/available）、J2-1 之后
  （+completionConfidence/confidenceHistory）三种历史结果形状照常解析；`available`
  等视图字段继续 strip。
- `formatTodoStateForModel`、`buildTodoReminderBody`（todo_reminder 文本）**不变**：
  不把置信度注入 reminder 文本面（golden 快照零风险；轨迹对模型的可见面 = TodoWrite/
  TodoRead 输出，已足够重估用）。

### R5 持久化：confidence_json 列（参照 deps_json 的做法）

- `todo` 表新增 **nullable 列 `confidence_json text`**，存
  `{ completionConfidence?, confidenceHistory? }` 的规范化序列化；migration
  `0024-todo-confidence-json.ts`，登记 `id: "0024_todo_confidence_json"`、
  `appVersion: "0.16.9"`（当前 CLI 版本）。
- **不扩 deps_json**：`TodoDepsJsonSchema` 是 `.strict()`，往里加成员会让旧版本代码
  safeParse 失败 → 回滚时连 id/blockedBy 一起丢（违反 0023 的回滚承诺）。独立新列的
  回滚语义与 0023 完全同款：**回滚 = 旧代码忽略该列**（`decodeTodoRow` 显式挑字段），
  已写入数据成为惰性数据，重新升级原样读回，不需要 down migration。
- 编解码（`codecs.ts`）：`encodeTodoConfidence`——只存在场成员，两成员全缺席写 null
  （与旧行同形）；空数组 history 不写（不物化）。`decodeTodoConfidence`——null/坏 JSON/
  `TodoConfidenceJsonSchema`（strict）校验失败 → `{}`（整列忽略，单行脏数据不能拖垮整个
  会话的 todos，与 `decodeTodoDeps` 同一纪律）。序列化形状由 contracts 的
  `TodoConfidenceJsonSchema` 唯一定义（跨存储边界走 schema）。
- **维护者确认记录**（`apps/acode-cli/AGENTS.md`「修改数据库结构前，应与模块维护者确认」）：
  方案由 J2-1 实施指令（2026-09-30，工作流下发）明确指定「参照 deps_json 列的做法加列 +
  migration」，与 0023 同一确认先例：nullable、可逆、回滚 = 忽略列、不改主键
  （`position` 仍是主键的一半，delete-all + re-insert 不变）。
- `repositories/todos.ts` insert 列表加 `confidence_json`，值 = `encodeTodoConfidence(todo)`
  ——repository 不做第二份规范化/门槛（唯一写入路径在 handler，存储层是哑持久化）。

### R6 提示词纪律

- `TodoWrite` 工具描述（`handlers/todo.ts`）新增两条 bullet（调用细节层，D4 R6 同款承载）：
  - `completionConfidence`：按实际观察到的证据报告完成证据状态；证据不足标 completed
    会被拒绝并点名条目（**不说哪个值过线**）；
  - `confidenceHistory`：返回值携带工具维护的轨迹；提交任何 history 会被忽略。
- 枚举四级语义进 schema 成员 `describe`（JSON schema 可见面），语义描述不等于门槛披露。
- **不动** system 动态段（`dynamic-sections.ts` 的 D4 纪律句不变）、不动 todo_reminder
  文本、不动 `dispatch-discipline-prompt.md` 承载层。文本语言：工具描述恒英文
  （`prompt-language-policy.md` R1）。
- 保密自检清单（测试钉住）：报错文案与工具描述都不得出现「门槛值/排序/阈值」表述。
- **指引措辞与报错同源（对抗复核 F2）**：工具描述的完成指引不使用 validat* 词根
  （与过线值 `validated` 同源，向模型暗示门槛边界）；报错文案已刻意避开该词根
  （"run the checks that prove the work is done"），描述用同源措辞
  （"run the checks first"）。

### R7 所有权边界与协议/UI 收缩决定

**本轮收缩为 CLI 侧闭环（contracts + core + adapters），不改 packages/shared 与 packages/ui。**

依据（已逐一核实）：置信度要到达 UI todo 面板，数据通路上有 4 个中间文件**全部在本项
所有权之外**——

| # | 文件 | 需要的改动 | 所有权归属 |
| --- | --- | --- | --- |
| 1 | `apps/acode-cli/packages/bootstrap/src/acode-protocol/session-mapper.ts:1069-1078` | `mapTodoItem` 透传两新字段（snapshot 通路） | bootstrap 不在 J2-1 所有权清单 |
| 2 | `packages/shared/src/acode-protocol/index.ts:856-867` | `acodeSessionTodoItemSchema` 最小加宽两可选成员 | **在**所有权内，但无 #1 时是无人发送的死宽度 |
| 3 | `packages/shared/src/tool-plan-adapter.ts` + `acode-task-types-core.ts` | `parsePlanStep` 读取 + `ACodePlanStep` 加可选成员（live 工具输出通路，UI 面板唯一数据源） | 不属于「协议 todo schema」条目 |
| 4 | `packages/services/src/acode-agent/acodeTaskServiceAdapter.ts:3830-3841` | `sessionTodosToPlanSteps` 投影（历史恢复通路） | packages/services 完全在所有权外 |

只改 #2（我唯一拥有的通路文件）= schema 接受一个没有任何生产方发送、没有任何消费方读取
的字段——正是任务指令禁止的「半吊子协议改动」；只改 UI 面板则无数据可展示。故按指令的
收缩条款执行，后续方案登记如下（供下一批次一次做全，避免两次半吊子）：

**后续协议/UI 投影方案（登记，不实施）**：
1. #1 `mapTodoItem` 加 `...(todo.completionConfidence !== undefined ? { completionConfidence: todo.completionConfidence } : {})` 与 history 同款透传；
2. #2 schema 加 `completionConfidence: z.enum([...]).optional()` + `confidenceHistory: z.array(同枚举).optional()`（保持 `.strict()`，D4 实施记录第 4 条同款最小加宽 + 升级裁决流程）；
3. #3 `ACodePlanStep` 加可选 `completionConfidence?: string`，`parsePlanStep` 用 `readString` 宽容读取（注意 `extractPlanStepsFromValue` 的全有或全无判定，`:78-82`——新字段必须可选且不引发解析失败）；
4. #4 `sessionTodosToPlanSteps` 投影同字段（历史恢复与 live 通路一致后，徽标不再「刷新即消失」）；
5. UI：`todo.tsx` 面板逐项徽标（DESIGN.md 色板，desktop/web 双端 truncation 不破）+ i18n 键（en-US/zh-CN，注意并行批次正在改这两个 locale 文件）；不新增 UI 测试基建，root `pnpm typecheck` 保障；
6. 验收补：v4 双语义链路核查（desktop-continuous live 徽标 + web-remote-replayable 回放后徽标恢复；D4 实施记录第 5 条的核查路径同款）。

### 观察项（对抗复核 2026-09-30 登记，非本项行为变更）

- **`todoItemsFromToolResultContent` 是全有或全无解析（对抗复核 F3）**：顶层 `todos`
  数组中任一元素 safeParse 失败 → 整份结果返回 `undefined`——单个毒化元素会毁掉整份
  历史结果的恢复价值。当前仓库内无生产调用方（knip 基线内保留的公开契约助手）；
  **接入回放链路前需先决定逐项宽容策略**（坏元素丢弃或占位、好元素照常解析），
  不在本轮实施。
- **blockedBy 未清的项可标 completed（对抗复核 F4）**：完成门槛只读
  `completionConfidence`，不检查 `blockedBy` 是否已清——依赖未解除就标 completed 是
  D4 既有语义（`available` 只是派生只读投影，不参与写入合法性）。绕过依赖做完工作可能
  是合法路径（依赖中途失效、工作范围变更）；若需要拦截，属新 spec（依赖与完成状态的
  一致性规则），不在本项范围。

## 状态所有者

```
模型提交 TodoWrite（整表；可带 completionConfidence；自报 confidenceHistory 被 strip）
   │
   ├─ contracts/src/tools/todo.ts        TodoItemSchema（+completionConfidence，可写面）、
   │                                       StoredTodoItemSchema（+confidenceHistory，域/存储形状）、
   │                                       TodoItemViewSchema（+available，输出视图）、
   │                                       superRefine(validateTodoList) 不变（D4 规则）
   ├─ contracts/src/tools/todo-confidence.ts  纯函数唯一实现：rank（私有）/门槛判定/违规点名/
   │                                       文案构造/history 追加/TodoConfidenceJsonSchema
   ├─ core/src/tool/handlers/todo.ts     唯一写入路径：readTodos(prior) → 门槛（R3，违规即抛，
   │                                       updateTodos 不执行）→ history 追加（R2）→ views → updateTodos
   │
   └─ adapters/.../repositories/todos.ts 持久化唯一所有者（delete-all + re-insert 不变）
          │                               └─ confidence_json 列（新，nullable，migration 0024）
          ▲                                     { completionConfidence?, confidenceHistory? } 的唯一持久化家
   adapters/.../codecs.ts                 encodeTodoConfidence / decodeTodoConfidence（坏数据整列忽略）
          ▲
   bootstrap/.../session-mapper.ts:1069   mapTodoItem 显式重建——新字段暂不进协议（R7 收缩，后续方案 #1）

唯一事实源：todo 表。confidenceHistory 由 handler 在写入时从 prior + 本次观测推导，
不存在第二条写入路径；available 与门槛判定都是当次快照的纯函数（根 AGENTS.md
「避免重复状态和多条写入路径」）。
```

## 接口

- `contracts/src/tools/todo-confidence.ts`（**新文件**，J2-1 纯函数段；机制参照 jcode (MIT)
  `crates/jcode-app-core/src/tool/todo.rs`、`crates/jcode-base/src/todo.rs`，自撰实现。
  任务指令原文写的是「todo.ts + todo-deps.ts」，实施时拆分独立文件——todo-deps.ts 加段后
  达 423 行，超 AGENTS.md 单文件 400 行上限；文件名仍在所有权模式 `todo*.ts` 内，
  经 `todo.ts` 原样再导出，消费方导出面不变，见「实施记录」第 1 条）：
  ```ts
  export const TODO_CONFIDENCE_HISTORY_MAX = 16;
  export const TodoCompletionConfidenceSchema = z.enum(["speculative","plausible","validated","verified"]);
  export type TodoCompletionConfidence = z.infer<typeof TodoCompletionConfidenceSchema>;
  export const TodoConfidenceJsonSchema = z.object({
    completionConfidence: TodoCompletionConfidenceSchema.optional(),
    confidenceHistory: z.array(TodoCompletionConfidenceSchema).max(TODO_CONFIDENCE_HISTORY_MAX).optional(),
  }).strict();
  export type TodoConfidenceJson = z.infer<typeof TodoConfidenceJsonSchema>;
  export interface TodoCompletionGateViolation { id: string; index: number }
  export function completionConfidencePassesGate(value: TodoCompletionConfidence | undefined): boolean;
  export function findCompletionGateViolations(
    submitted: readonly NormalizedTodo[], prior: readonly NormalizedTodo[],
  ): TodoCompletionGateViolation[];
  export function completionGateErrorMessage(violations: readonly TodoCompletionGateViolation[]): string;
  export function appendConfidenceObservation(
    priorHistory: readonly TodoCompletionConfidence[] | undefined,
    observation: TodoCompletionConfidence | undefined,
  ): readonly TodoCompletionConfidence[] | undefined;
  /** 对抗复核 F1：R3 豁免与 R2 轨迹继承共用的 id+content 双匹配谓词（id 命中由调用方的 priorById 完成）。 */
  export function isSameTodoContent(submitted: NormalizedTodo, prior: NormalizedTodo): boolean;
  ```
  rank 映射与门槛最小值（`validated`）为**模块私有**，不导出（保密面的代码级表达）。
- `contracts/src/tools/todo.ts`：`TodoItemSchema` + `completionConfidence`（describe 含四级语义）；
  `StoredTodoItemSchema`；`type TodoItem` 改指 stored 形状；`TodoItemViewSchema` 基于 stored；
  `TodoResultContentSchema` 元素改宽容 stored 形状（不带 max）；上述新符号全部原样再导出
  （`tools/index.ts:19` `export * from "./todo.js"` → `@acode/contracts` 公开入口自动可达）。
- `core/src/tool/handlers/todo.ts`：`todoWriteHandler` 顺序改为
  parse → readTodos → normalize(submitted/prior) → 门槛（抛 `InvalidInput`）→ history 追加 →
  views → updateTodos；描述 +2 bullet（R6）。`todoReadHandler`/`toTodoViews`/`summarizeTodos`
  逻辑不变（类型自动变宽）。
- `adapters`：`rows.ts` `TodoRow.confidence_json: string | null`；`codecs.ts`
  `encodeTodoConfidence`（导出，测试用）+ `decodeTodoConfidence`（私有）+ `decodeTodoRow`
  spread；`repositories/todos.ts` insert 加列；`migrations/0024-todo-confidence-json.ts` +
  `migrations.ts` 登记。
- 不新增环境变量、不新增 system-reminder source、不改 `TodoSummary`、不改端口签名。

## 验收场景（测试 `tests/todo-confidence-semantics.test.mjs` 钉住）

1. **批量盖章被拒且点名 id**：prior pending → 提交 completed 无 `completionConfidence` →
   抛 `InvalidInput`，消息含该 id；**born-completed**（空 store 首写即 completed）同样被拒；
   prior pending → completed 带 `plausible`（不足）同样被拒；三种情况下 `updateTodos`
   均未被调用、旧表快照无变化。
2. **validated/verified 通过**：prior pending → completed 带 `validated` / `verified` →
   写入成功；**grandfather 豁免**：prior 已 completed（无置信度，升级前存量）→ 原样重发 →
   成功且不物化 history；重开后再次完成（completed→pending→completed）重新受检。
3. **history 忽略模型自报**：提交项带 `confidenceHistory`（数组或垃圾形状）→ parse 后
   可写面不含该键（strip）；写入后存储轨迹 = 工具追加结果，与自报值无关。
4. **追加语义**：跨三次写入 speculative→plausible→validated 逐项追加成爬升轨迹；同值连发
   去重；超 `TODO_CONFIDENCE_HISTORY_MAX` 滑动窗口保留最新；无观测时 `undefined` 保持
   `undefined`（不物化空数组）。
5. **旧格式读写正常**：无新字段的 pending/in_progress 列表首写成功、存储逐字节 =
   提交值 + 派生 id（无 history/completionConfidence 键）；`confidence_json = null` 旧行
   decode 等价旧格式；坏 JSON / strict 校验失败（含未来成员）整列忽略；
   `todoItemsFromToolResultContent` 对 D4 前 / D4 后 / J2-1 后三种历史结果形状照常解析。
6. **报错文案不泄露枚举边界**：违规消息不匹配
   `/speculative|plausible|validated|verified|threshold|at least|rank|order|≥|>=/i`；
   工具描述不含「哪个值过线」表述（`/required/i` 与枚举值同现即失败）。
7. **持久化往返**：真实 SQLite（`createSqliteSessionStore`）：migration 0024 已登记执行；
   handler 两次写入（爬升）→ `readTodos` 逐字段相等（含 completionConfidence + history）；
   关库重开数据原样；协议投影 `mapTodoItem` **不带**新字段（R7 收缩的现状钉住）。
8. **输出面**：`TodoWrite`/`TodoRead` 输出视图携带 history；`TodoWriteOutputSchema`/
   `TodoReadOutputSchema` safeParse 通过（executor `runtimeOutputSchema` 强制校验模拟）；
   `summarizeTodos` 五计数不受新字段影响。
9. **验证命令**（从仓库根执行，如实记录）：
   - `node --import tsx --test apps/acode-cli/tests/todo-confidence-semantics.test.mjs`
   - `node --import tsx --test apps/acode-cli/tests/todo-dependency-fields.test.mjs`（适配后回归）
   - `node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/{contracts,core,adapters}/tsconfig.json --noEmit`
   - `pnpm typecheck`（root，证明 shared/ui 未破坏——本项未改它们）
   - `pnpm lint`（0 error 基线）

## D4 测试适配记录（有意的行为变更）

门槛让「新生 completed 项无置信度」从成功变为拒绝——`tests/todo-dependency-fields.test.mjs`
三个场景需最小适配（本项所有权内的 todo 测试文件）：
- 场景 3（handler 输出）：completed 项 `b` 加 `completionConfidence: "verified"`；
- 场景 4（旧格式快照）：`fakeStore` 以同一份 legacy 列表作 prior 种子——已 completed 项走
  grandfather 豁免，**三字段逐字节断言与四计数断言原样保留**（这恰好钉住 R3 豁免条款
  与 R2 不物化）；
- 场景 5（SQLite 往返）：completed 项 `b` 加 `completionConfidence: "verified"`，
  readBack 期望补 `confidenceHistory: ["verified"]`（工具追加）；`legacyRow` 字面量补
  `confidence_json: null`。
其余场景（1/2/6/7/8/9/10、R6）不受影响：parse 级失败先于门槛、pending 项不触发门槛、
reminder/golden 文本零改动。

## 实施记录（2026-09-30，J2-1 实施批次）

1. **纯函数物理家拆分为新文件 `todo-confidence.ts`**（任务指令原文为 todo.ts + todo-deps.ts）：
   J2-1 段并入 todo-deps.ts 后该文件达 423 行，超 `apps/acode-cli/AGENTS.md`「单个源文件
   默认不能超过 400 行」上限；拆分后 todo-deps.ts 291 行（D4 原样 + 一行指针注释）、
   todo-confidence.ts 140 行。文件名仍在所有权模式 `contracts/src/tools/todo*.ts` 内；
   `todo.ts` 对两个物理家原样再导出，消费方导出面与「接口」节一致（D4 实施记录第 3 条
   同款手法）。运行时依赖方向：todo-confidence → (type-only) todo-deps，无循环。
2. **协议/UI 按 R7 收缩**：packages/shared、packages/ui、bootstrap session-mapper 零改动；
   所需 4 个所有权外文件的改动清单已登记在 R7 后续方案（供下一批次一次做全）。
   bootstrap 零改动兼容性经 `tsc -p packages/bootstrap/tsconfig.json --noEmit` 实证（0 error）。
3. **contracts dist 重建**：core/adapters 经 `@acode/contracts` 的 dist（package.json
   main/types）解析类型，改 contracts 源码后必须
   `node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/contracts/tsconfig.json`
   （不带 --noEmit）重建 dist，core/adapters 的 --noEmit 检查才能见到新导出。
4. **rank/门槛最小值保持模块私有**：`COMPLETION_CONFIDENCE_RANK` 与
   `COMPLETION_CONFIDENCE_GATE_MIN` 不导出（保密面的代码级表达，R1/R3）；
   导出面只有谓词 `completionConfidencePassesGate`。
5. **D4 测试适配**：见「D4 测试适配记录」——场景 3/5 的 completed 项补
   `completionConfidence: "verified"`（场景 5 readBack 期望补工具追加的
   `confidenceHistory: ["verified"]`）、场景 4 改为 grandfather 重发形态（prior 种子 =
   同一份 legacy 列表，三字段逐字节断言与四计数断言原样保留）、场景 6 legacyRow 字面量补
   `confidence_json: null`。
6. **对抗复核修复批次（2026-09-30，F1/F2，J2/J3 复核后）**：
   - **F1（high）**：grandfather 豁免 × 位置派生 id 的洗白面——修复前探针实证三条路径
     全部 WRITTEN（剪掉已完成项后补位项无证据完成、显式 id 换内容免检令牌、
     原样重发对照），其中补位/换内容属日常列表整理即可触发的洗白，且继承前项轨迹
     （跨 SQLite 重启同样成立）。修法 = R3 豁免与 R2 轨迹继承统一收紧为 id+content
     双匹配：新增共享谓词 `isSameTodoContent`（contracts，经 `todo.ts` 原样再导出，
     单一实现两处共用），`findCompletionGateViolations` 与 core handler
     `mergeConfidenceHistory` 改用之。升级兼容不受影响（存量 completed 原样重发
     content 不变仍豁免，探针 B 实证）。F1 回归 6 例进语义测试文件（标 F1）。
   - **F2（low）**：工具描述指引措辞 "do the validation work first" → "run the checks
     first"（与门槛报错 "run the checks that prove the work is done" 同源）。全仓检索
     无其他引用点、无 prompt parity/描述快照测试基线依赖该词句，选择直接改词而非
     spec 豁免登记；R6 新增「指引措辞与报错同源、不用 validat* 词根」纪律并由测试钉住。
   - **F5/F3/F4（low）**：并发 last-writer-wins 的观测丢失、宽容解析全有或全无、
     blockedBy 未清可标 completed——均登记进 spec（R2 与「观察项」节），不实施行为变更。

## 不在本项范围

- **spike 检测、turn 末质量门 replay、double-check 回合、任何 nudge 逻辑**：J2-2 评估项
  （任务指令原文「明确不做」）。本项落地的 history 轨迹正是 J2-2 登记判据的数据源。
- **前瞻 `confidence` 字段与 legacy 0-100 数值映射**：R1 已说明收缩理由；ACode 无数值分历史。
- **协议/UI 投影**（shared schema、bootstrap mapper、tool-plan-adapter、services 投影、
  UI 徽标、TUI 展示）：R7 收缩决定 + 后续方案登记；本轮 `mapTodoItem` 继续显式重建，
  新字段不出 CLI。
- **reminder / system 段 / golden 文本注入置信度**：R4/R6 已说明不动的理由。
- **豁免面扩展（trivial 清单等）**：R3——豁免只有 grandfather 一条，摩擦数据归 J2-2 判据。
- **门槛的运行时硬停止或自动补验**：门槛只拒绝写入，不代做验证、不打断回合
  （与「不做 nudge」一致）。
