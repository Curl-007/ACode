# 命令与子代理终态语义的完整闭合审计（D3）

调度主线 P1 项，**Phase 0 只读审计**。本 spec 不是功能设计，而是一份**审计任务书 +
结论登记处**：定义三个必须回答的问题、每个问题的证据标准与判定口径，并把结论区留空待回填。

审计动因来自方案 D3：上游内部文档自曝两处终态缺口（到顶终态误报 completed；admission
丢弃后无终态）。这两处**是 ACode 的自查清单，不是照抄模板**——ACode 的 CommandInbox 设计
成熟度高于上游自曝水平，照抄其队列语义重写会破坏 admission 不变量（治理红线，方案 D3
「备选与取舍」已明确否决）。

**本项不预设结论**。审计发现缺口才立最小修复项；未发现缺口则把「已闭合」的证据钉进测试。

## 背景

### 已核实的现状（审计起点清单）

以下事实在起草本 spec 时逐条核实过，作为审计的起点，**不是**结论。行号以当前检出为准，
审计执行时需复核。

#### 起点 1：`maxTurns` 是装配了但未见强制点的配置字段

- 声明处：`core/src/runtime/types.ts:131`（`RuntimeConfig.maxTurns?`）、
  `:137-146`（`subagents` 配置块，`:144` 为 `subagents.maxTurns?`）。
- 装配处：`core/src/runtime/methods/subagent.ts:269`
  （`maxTurns: request.maxTurns ?? this.config.subagents?.maxTurns ?? 4`，即方案 D3 引用的
  「默认 4」）；`bootstrap/src/app/script-workflow-child-runtime.ts:115`
  （workflow 子 runtime 从 `input.request.opts?.maxTurns ?? input.deps.runtimeConfig.maxTurns` 取）。
- 脚本侧上界：`contracts/src/workflow/script.ts:6,51`
  （`MAX_WORKFLOW_AGENT_TURNS = 200`，`maxTurns` 的 zod 上界）。
- **已核实的强制点只有一处**：`core/src/memory/memory-agent-loop.ts:47,58`
  （`for (; turns < input.maxTurns; turns += 1)`）——那是 memory agent 自己的循环，
  不是主/子代理的 turn loop。
- **已核实的零引用**：`grep -n "maxTurns" packages/core/src/runtime/methods/turn-loop.ts`
  与 `grep -n "maxTurns" packages/core/src/runtime/agent-runtime.ts` 均无命中
  （起草本 spec 时执行，命令与输出见「审计证据要求」E1 的复现方式）。
- 与之呼应的既有产品决定：`apps/acode-cli/AGENTS.md:11`
  「长程任务优先：核心 agent loop 默认面向可持续运行的复杂任务设计，**不用 tool call 次数做硬停止**。
  资源与安全边界应由 token/context limit 自动 compact、用户取消、权限拒绝、工具超时、输出截断、
  provider retry 上限等明确条件承担。」

> **因此方案 D3 的问题 1 需要重述**：原问法「subagent `maxTurns` 到顶的终态是否误报
> completed」预设了「到顶」这件事存在。按当前检出，主/子代理循环里可能**根本不存在到顶**，
> 真问题是「这个字段是不是悬空配置」——这与 P4 对 `language` 字段的判定同构
> （见 `prompt-language-policy.md`：悬空配置 vs 缺失功能）。重述后的问题见 R1 问题 1。

#### 起点 2：CommandInbox 的丢弃路径**有**同步终态 ack，但不进内存幂等表

- 表结构：`bootstrap/src/acode-protocol-v4/command-inbox.ts:107-113`
  （`inFlight` / `liveInputs` / `settled` 三张表 + `admissionSeq` + 两道 gate；
  `:1-2` 模块注释明写「三类事实严格分离：in-flight / live input 永远 pinned；
  只有 settled 进入 512/session LRU」）。
- `decide()`（`:308-430`）的每条丢弃路径都返回带 `status` + `reasonCode` 的 ack：
  - `proto.sessionNotFound`（`:315-321`，`remember: false`）
  - `proto.missingBaseRevision`（`:329-334`，`remember: false`）
  - `proto.staleLogEpoch`（`:343-348`，`remember: false`）
  - `proto.staleRevision`（`:355-360`，`remember: false`）
  - row-target guard 的 `stale` / `reject`（`:370`、`:383`，`remember: false`）
  - 业务 guard 的 `stale` / `reject`（`:400`、`:413`，`remember: false`）
  - 业务 guard 的 `noop`（`:426`，**`remember: true`**）
  - 解析失败 `proto.invalidPayload`（`:117-127`，走 `ackOnly`）
- **`remember: false` 的含义**：`handle()` 在 `:157-162` 只对 `remember` 为真的 ack 调
  `rememberSettled`；其余的 ack 只同步返回给调用方，**不进 `settled` LRU**
  （`rememberSettled:487-496`，容量 `PROTOCOL_V4_LIMITS.idempotencyTablePerSession = 512`，
  `packages/shared/src/acode-protocol-v4/core.ts:82`）。
- **晚到 duplicate 的回源路径**：`lookupExact` 依次查 inFlight → 四个持久化 lookup
  （`lookupTranscriptCommand` / `lookupTimelineCommand` / `lookupChildCommand` /
  `lookupDiscardedCommand`，host 接口声明 `:34-38`，调用点 `:296-305`）。
  即：被丢弃命令的终态能否被晚到的重复查询找回，**取决于 `lookupDiscardedCommand`
  是否被宿主实现、以及丢弃事实是否真的落了盘**——这正是问题 2 的审计点。
- **锁序与 settle 纪律**（改动时的不变量，审计只读不改）：`:139-141` 固定锁序
  key gate → per-session admission gate，session gate 持有到 settle；`:183-203` settle 幂等 +
  所有同 key 请求共享同一个 `final` promise + 释放 session FIFO 前看到同一终态
  （`:197-201` 注释记录了「在途 duplicate 过去直接拿 admission ACK … ACK 丢失重试会导航失败」
  这个已修的坑）；`:175-181` 先 pin 再释放 key gate（注释记录了旧单表 LRU 在 >512 条 churn 时
  淘汰在飞命令、随后 query 返回 unknown、重试再次执行的坑）。
- **重试语义**：`retryAck:446-448`——`failed` 是终态事实，不得被 duplicate 状态覆盖后
  让 UI/服务误判为可接受。

#### 起点 3：子代理终态有三处独立表达

- runtime task 快照状态：`core/src/subagent/runner.ts` 里出现 `status: "running"`（`:187,247,454,494,998,1039`）、
  `"started"`（`:282,523`）、`"completed"`（`:342,363,376,1171`）、`"failed"`（`:391,408,1250`）；
  `:1338` 用 `isTerminalRuntimeTask` 判终态，缺省回落 `{ status: "lost" }`。
- 通知文案：`core/src/subagent/completion-notification.ts:4`
  （`type LocalAgentTaskNotificationStatus = "completed" | "failed" | "stopped"`）、
  `:21-40`（`formatLocalAgentTaskNotification` → `formatTaskNotification`，带 usage 四项）、
  `:42-51`（`formatLocalAgentNotificationSummary`：单行 `Agent <type> task "<desc>" <status>.`，
  failed 时追加与 `<error>` 相同的失败原因，注释说明这行是 Agent 卡「子智能体输出」的来源）。
- 前台/后台转换：`runner.ts:291-334` 的 `Promise.race`（completed / backgrounded /
  auto-background timer 三赢家），转后台后 `:317-330` 挂 completion/failure finalize。

> 方案 A10 残留项要求「顺带对照上游『后台任务机器可读结果摘要』约定核验
> `completion-notification.ts`」——起点 3 的第二条就是这个核验对象：summary 已经是**单行**
> 且 failed 时带原因，形态上符合；审计需确认的是三处状态表达之间**是否存在不一致的终态**
> （例如快照 `lost` 会不会发出一条 `completed` 通知）。

### 治理约束（审计期间同样适用）

- **只读**：本项不改产品代码。发现的缺口另立最小修复项（各自走 spec-first）。
- **不重写 CommandInbox**：方案 D3 已明确否决。审计若发现缺口，修复必须落在
  「补一条终态回传」或「补一个测试钉住既有语义」的量级，不得改锁序、三态分离、
  CAS、admissionSeq 任一条不变量。
- **测试先行**：三问每问都要有可执行的测试或复现脚本作为证据，不接受「读代码认为没问题」。

## 产品规则

### R1 三问的定义与判定口径

#### 问题 1：`maxTurns` 的终态语义（重述版）

**问**：主 agent loop 与 subagent loop 里，`maxTurns`（`runtime/types.ts:131,144`；
装配于 `methods/subagent.ts:269`、`script-workflow-child-runtime.ts:115`）是否存在**强制点**？

- **1a**：若存在强制点 → 到顶时 runtime task 快照、Agent 工具返回值、task-notification
  三处的终态分别是什么？是否存在「到顶却报 completed」的路径？
- **1b**：若不存在强制点（起点 1 的证据指向这个分支）→ 该字段是**悬空配置**。
  处置必须二选一并写明理由：
  - (i) **删除**该字段与其装配链（含 `contracts/src/workflow/script.ts:51` 的 schema 成员
    与 `MAX_WORKFLOW_AGENT_TURNS`），与 `apps/acode-cli/AGENTS.md:11` 的长程任务优先一致；
  - (ii) **保留并实现**，且到顶终态必须是**可区分的失败/截断态**，不得复用 `completed`
    （否则调用方无法区分「做完了」与「被切断了」）。
- **判定口径**：「误报 completed」= 存在一条路径，其工作未因模型自然收尾而结束，
  但对外表达为 `status: "completed"` 且**不携带**任何截断/到顶标记。

#### 问题 2：admission 丢弃路径的终态可观察性

**问**：起点 2 列出的每条丢弃路径（`remember: false` 的七类 + `ackOnly` 的解析失败），
其终态对**晚到的重复查询**是否可观察？

- **2a**：逐条列出七个 `reasonCode`，对每条回答：同步 ack 是否到达调用方（起点 2 显示是）；
  `settled` LRU 里是否查得到（`remember: false` → 查不到）；
  `lookupDiscardedCommand`（`:38,300`）在当前宿主装配里**是否被实现**、
  丢弃事实是否落盘、落哪张表。
- **2b**：若某条路径的丢弃事实**不落盘** → 晚到的 duplicate 会得到 `unknown`
  （`queryOne:271-276`，其 `:276` 就是 `(await this.lookupExact(key)) ?? "unknown"` 的回落；
  批量入口 `query():217-221`），
  客户端可能重试；重试再次被同样丢弃是否**幂等**（不产生第二次副作用）？
- **2c**：`noop`（`:426`，`remember: true`）与 `stale`/`reject`（`remember: false`）的
  差别是否有文档化理由？若无，是缺口还是有意（内存表只为「需要被重试认出的」终态保留位置）？
- **判定口径**：「有可观察终态」= 调用方在**同步 ack** 或**后续 query** 二者之一能拿到
  一个非 `unknown` 的终态；「闭合」= 两者都不返回 `unknown`，或返回 `unknown` 时重试幂等。

#### 问题 3：cancel / complete 竞态的次序语义

**问**：同一个子代理（或同一条命令）同时发生「取消」与「自然完成」时，终态由什么决定？
是否有**文档化**的约定与测试？

- **3a**：`runner.ts:291-334` 的 `Promise.race` 三赢家（completed / backgrounded /
  auto-background）之间，以及 `taskAbort`（`:317-330` 的 `detachParent` / `dispose`）与
  `finalizeBackgroundCompletion` / `finalizeBackgroundFailure` 之间，谁先写终态？
  是否存在「已 completed 又被写成 cancelled」或反向的窗口？
- **3b**：`engine-settlement.ts` 的 first-wins（`:22-23,41-42,67-68` 的 `isRunSettled()` 守门）
  是 workflow run 级的既有答案；子代理侧是否有等价物（`runner.ts:1315` 的
  `settle(() => resolve(completed))` 幂等收口、`:1338` 的 `isTerminalRuntimeTask`）？
- **3c**：CommandInbox 侧：`:183-203` 的 settle 幂等（`if (settled) return`）+
  共享 `final` promise 是否已覆盖「取消与完成同时到达」？`:446-448` 的
  「`failed` 是终态事实，不得被 duplicate 覆盖」是否也覆盖 cancel 方向？
- **判定口径**：「有明确文档化约定」= 存在注释或 spec 说明**谁是赢家**及为什么，
  且有一条测试钉住该次序；只有代码行为、没有约定文字 → 判「未文档化」，
  即使行为正确也要补约定（因为下一次改动无从判断是否破坏它）。

#### 附带核验（方案 A10 残留项）

**问**：`completion-notification.ts:42-51` 的单行 summary 是否满足「后台任务的机器可读结果摘要」
（单行、含 status、failed 时含原因）？三处终态表达（起点 3）之间是否存在不一致组合
（快照 `lost` / 通知 `completed`；通知 `stopped` 但快照非终态等）？

### R2 审计证据要求

每个结论必须同时具备以下三项，缺一即视为**未回答**（结论区不得填）：

- **E1 命令与输出**：实际执行的命令与原始输出。代码事实用
  `grep -n <pattern> <path>`（记录 pattern、path、命中行号）；
  行为事实用测试或复现脚本的运行命令与输出（例：
  `node --import tsx --test apps/acode-cli/tests/<file>.test.mjs`，从仓库根执行；
  裸 `node --test` 解析不了内部 `.js → .ts` 导入）。
- **E2 `file:line` 证据**：结论依赖的每一处代码位置，路径相对仓库根，行号以审计执行时的检出为准
  （**不得直接沿用本 spec 起点清单里的行号**——那只是起草时的基线，会漂移）。
- **E3 测试覆盖**：结论对应一条可重复执行的测试（新写或指出既有测试文件与用例名）。
  「已闭合」的结论尤其需要测试钉住，否则下一次改动无从发现回退。
  新测试遵循既有约定：`apps/acode-cli/tests/*.test.mjs`（`node:test` + `assert`），
  写之前先读一两个既有文件（如 `tests/managed-policy-floor.test.mjs`、`tests/no-telemetry.test.mjs`）学约定。

### R3 结论的处置规则

- **判「已闭合」**：写明 E1/E2/E3，并在结论区标 `已闭合（测试钉住）`。不改产品代码。
- **判「有缺口」**：写明缺口的**最小**修复范围（哪个文件、哪条路径、补什么终态/字段/测试），
  标 `需修正 → <新 spec 或本 spec 的追加小节>`。修复项各自走 spec-first，**不在审计 PR 里改**。
- **判「无法判定」**：写明卡在哪（例：`lookupDiscardedCommand` 在当前装配里找不到实现方，
  需要运行时证据），标 `待验证`，并登记进方案 §8.2 的待验证项清单。
  **不得**用推测填结论。
- **不得改动的不变量**（审计与后续修复都受约束）：锁序（`:139-141`）、settle 前不放行
  （`:183-203`）、baseRevision + baseLogEpoch CAS 拒 stale（`:337-361`）、
  admissionSeq 权威顺序（`:163-164`）、三态分离（`:107-113`）、owner/lease 路由、
  stale run 防护。任何触碰队列的修复必跑 CommandInbox 不变量测试套件，
  并同步验证 `desktop-continuous` 与 `web-remote-replayable` 双语义链路。

### R4 审计完成的判据

本项视为完成，当且仅当：

1. R1 的三问 + 附带核验各有结论区条目，且每条都带齐 E1/E2/E3（或明确标 `待验证` 并说明卡点）。
2. 每条 `需修正` 都有对应的最小修复项登记（新 spec 文件名或本 spec 追加小节标题）。
3. 结论区引用的行号已在审计执行时复核过（与本 spec 起点清单的行号可能不同，以复核结果为准）。
4. 方案 §8.2 待验证清单的第 2 项（「subagent maxTurns 到顶终态是否误报 completed」）
   据实更新为本次审计的结论。
5. `pnpm lint`（root，oxlint，期望 0 error）与
   `pnpm architecture:check -- --changed`（期望 0 violations）在新增测试文件后仍通过；
   如实记录执行结果，既有失败不得写成通过。

## 状态所有者

本项是只读审计，**不新增任何状态所有者**。审计对象的所有权现状（审计不得改变）：

```
命令 admission 与终态     bootstrap/src/acode-protocol-v4/command-inbox.ts
                            ├─ inFlight / liveInputs / settled 三张表（:107-113，唯一所有者）
                            ├─ admissionSeq（:163-164，权威顺序）
                            └─ 持久化回源：host 的四个 lookup（:34-38）——事实所有者是宿主装配，
                               不是 inbox 本身（问题 2a 的审计点正在于此）

子代理生命周期与终态      core/src/subagent/runner.ts（快照状态的唯一写入点）
                            └─ core/src/subagent/completion-notification.ts（通知文案的唯一产出点）

workflow run 终态         dynamic-workflow/src/engine/engine-settlement.ts（三条路径 + first-wins）
                            └─ journal（持久化事实的唯一所有者）

turn 循环                 core/src/runtime/methods/turn-loop.ts（问题 1 的强制点查证对象）
memory agent 循环         core/src/memory/memory-agent-loop.ts:47,58（当前唯一的 maxTurns 强制点）
```

## 接口

本项**不定义新接口**。审计需要读清的既有接口（结论区引用它们时必须写全签名）：

- `command-inbox.ts:16-21` `GuardDecision`（`allow` / `stale` / `reject` / `noop` 四裁决）
- `command-inbox.ts:25-39` `CommandInboxHost`（含 `lookupDiscardedCommand?: PersistentLookup`）
- `command-inbox.ts:217-221` `query(keys): Promise<Array<{ key; result: CommandAck | "unknown" }>>`
  （单键实现 `queryOne:271-276`，`lookupExact:284-306`）
- `command-inbox.ts:446-448` `retryAck(ack): CommandAck`
- `runner.ts:1338` `isTerminalRuntimeTask(task)`
- `completion-notification.ts:21-40` `formatLocalAgentTaskNotification(input): string`
- `engine-settlement.ts:22,40,66` `settleCompleted` / `settleStopped` / `settleFailed`

若审计判定需要新增接口（例：给丢弃事实补一个可查询的落库端口），**在本 spec 追加小节里定义**，
不在审计 PR 里实现。

## 验收场景

本项的验收对象是**审计产出**，不是代码行为：

1. 结论区三问 + 附带核验共四条，每条状态为 `已闭合（测试钉住）` / `需修正 → X` / `待验证（卡点：Y）`
   三者之一，无空白、无「大概」「应该」。
2. 每条结论的 E1 可复现：按记录的命令重跑，得到记录的输出（行号漂移导致的差异需注明）。
3. 每条 `已闭合` 都指得出钉住它的测试文件与用例名；新写的测试遵循
   `apps/acode-cli/tests/*.test.mjs`（`node:test` + `assert`）约定，并能以
   `node --import tsx --test <文件>`（仓库根）跑通。
4. 每条 `需修正` 的修复范围是最小的：指明文件、路径、要补的终态/字段/测试，
   且**不含**任何对 R3 不变量的改动。
5. CommandInbox 不变量测试套件在审计前后均全绿（审计只读，若有红说明工作区被误改）。
   记录实际执行的命令与结果。
6. 双语义链路无回归：`desktop-continuous`（后台完成 → 父队列直写 → mid-turn 吸收路径不变）、
   `web-remote-replayable`（cold-session-resume / replay 三段归约对终态字段的处理不变）。
   审计阶段以既有测试全绿为证；若审计新增了测试，注明其覆盖的是哪条链路。
7. 方案 §8.2 待验证清单第 2 项已据实更新（这是本项与方案文档的唯一回写点）。

## 审计结论区（已回填）

> 回填规则见 R2/R3。执行日期 2026-09-29；执行基线 = 工作区 `dev/0.0.1`（HEAD `7578e1e`，
> 含本 spec 等未提交新增文件）。**本节所有行号均为本次执行时复核的结果**，与背景章起点清单
> 存在漂移（例：起点清单记 `decide()` 为 `:308-430`，实际为 `:308-444`；记 `retryAck` 为
> `:446-448`，实际为 `:446-449`），以本节为准。E1 命令一律从仓库根执行。
> E3 引用的四个测试文件均为本次审计新增，路径见下。

### E1 执行记录（全部命令与结果）

| 命令（仓库根执行） | 结果 |
| --- | --- |
| `node --import tsx --test apps/acode-cli/tests/subagent-maxturns-dangling.test.mjs` | 8 tests / 8 pass / 0 fail |
| `node --import tsx --test apps/acode-cli/tests/command-inbox-discard-terminal-state.test.mjs` | 15 tests / 15 pass / 0 fail |
| `node --import tsx --test apps/acode-cli/tests/subagent-terminal-race-ordering.test.mjs` | 8 tests / 8 pass / 0 fail |
| `node --import tsx --test apps/acode-cli/tests/subagent-completion-notification-summary.test.mjs` | 9 tests / 9 pass / 0 fail |
| 上述四路径合跑一条命令 | `exit=0`，`tests 40 / pass 40 / fail 0` |
| 8 个既有 CLI 测试文件合跑（回归基线，路径逐个列出） | `exit=0`，`tests 62 / pass 62 / fail 0` |
| `pnpm lint` | `Found 76 warnings and 0 errors.`（warnings 数 = 既有基线） |
| `pnpm architecture:check -- --changed` | `architecture: OK` / `violations: 0` / `baseline: 0` / `new: 0` |
| `pnpm typecheck` | `exit=0`，无诊断输出。覆盖面是 `packages/*`，**不含** `apps/acode-cli` |
| `grep -rn "maxTurns" apps/acode-cli/packages/core/src/runtime/methods/turn-loop.ts` | 无命中，`exit=1` |
| `grep -rn "maxTurns" apps/acode-cli/packages/core/src/runtime/agent-runtime.ts` | 无命中，`exit=1` |
| `grep -rn "maxTurns" apps/acode-cli/packages/core/src/runtime/` | 3 处命中：`types.ts:131,144`、`methods/subagent.ts:269`、`helpers/project-memory-extraction.ts:155` |
| `grep -rn "new CommandInbox(" apps/ packages/`（全仓） | 1 处命中：`v4-gateway.ts:632` |
| `grep -rn "guard:" apps/acode-cli/packages/bootstrap/src/` | 无命中 → 生产宿主从不提供 `guard` |
| `grep -rn "lookupDiscardedCommand" .`（全仓，排除 dist/node_modules） | 5 处命中：`command-inbox.ts:38,300`、`v4-gateway.ts:317,656`、`v4-bridge.ts:1622` |
| `grep -rn "missingBaseRevision" packages/ apps/acode-cli/packages/` | 1 处命中：`command-inbox.ts:333`（唯一产出方） |
| `grep -rln "CommandInbox\|command-inbox" --include="*.test.ts" --include="*.test.mjs" …`（全仓） | 只命中本次新增的两个文件 |

**未执行 / 未验证（据实登记）**：

- `pnpm --dir apps/acode-cli typecheck` 与 `… lint` **未执行**：turbo 不在 PATH（环境限制）。
  `apps/acode-cli/packages/cli` 另有既有环境红（`@acode/tui` dist 未构建 → TS2307），
  按本项约定不作为门禁。
- 三个已知既有红（`packages/desktop/tests/no-official-platform.test.mjs`、
  `packages/ui/tests/no-telemetry.test.mjs`、`packages/ui/test/nonCliAcpRetirement.test.ts`）
  **未运行**：本项只新增 `apps/acode-cli/tests/*.mjs` 与 spec 文本，不触碰它们的输入。
- `dynamic-workflow` / `dynamic-workflow-runtime` 的 typecheck **未单独运行**（后者需先构建前者）；
  本项未改动这两个包，只读引用了 `engine-settlement.ts` 作为问题 3b 的对照物。
- 验收场景 5 要求的「CommandInbox 不变量测试套件」**在仓内不存在**（见上表最后一条 grep）。
  该场景无法按原文执行；本次以「新增的 `command-inbox-discard-terminal-state.test.mjs`
  15 例全绿 + 审计只读、未改动 `command-inbox.ts` 一行」作为等价证据，并把它登记为修正项 #7。
- 验收场景 6 的双语义链路（`desktop-continuous` / `web-remote-replayable`）**未做端到端验证**：
  本项无产品代码改动，无法产生回归；新增测试覆盖的是 CLI 进程内的 registry / inbox / 通知格式，
  不跨这两条链路。据实登记为未覆盖，不写成已验证。

### 问题 1：`maxTurns` 的终态语义

| 子问 | 结论 | E1 命令与输出 | E2 `file:line` | E3 测试 | 处置 |
| --- | --- | --- | --- | --- | --- |
| 1（强制点是否存在） | **不存在**。主/子代理 turn loop 是无条件 `while (true)`，只由 model step 返回 `"break"` 收口；`"break"` 的三个来源（automation 创建上限命中、assistant text-only 自然收口、工具主动请求停轮）没有一个是轮数上限。四个相关文件对 `maxTurns` 零引用 | `grep -n "maxTurns" …/turn-loop.ts` → 无命中 `exit=1`；同款 grep 于 `agent-runtime.ts` → 无命中 `exit=1`；`grep -rn "maxTurns" packages/core/src/runtime/` → 只命中声明与装配，无消费 | `apps/acode-cli/packages/core/src/runtime/methods/turn-loop.ts:47,215`；`methods/turn-stop.ts:167,193,236`；`methods/turn-tools.ts:54,462`；`runtime/agent-runtime.ts` 全文零命中 | `apps/acode-cli/tests/subagent-maxturns-dangling.test.mjs` 用例 (1)(2) | **需修正 → 修正项 #1** |
| 1a（到顶终态三处表达） | **对主/子代理不适用**（不存在到顶，故三处表达无从谈起）。唯一真实强制点是 memory agent loop，其到顶终态**不自描述**：返回值只有 `{messages, turns}`，无 capped/truncated/finishReason 标记；唯一调用方丢弃返回值、无条件 `finishCompleted()` + `return "success"`，于是「被 5 轮切断」与「模型自然收尾」对外完全同形 | 测试 (6) 实测：桩模型每轮索取工具、`maxTurns: 2` → `result.turns === 2`、`generateText` 调用 2 次、`Object.keys(result).sort()` 恰为 `["messages","turns"]`；对照组（模型不要工具）→ `turns === 1`、键集相同。测试 (7) 断言抽取侧 `catch` 之前不出现 `turns`、且出现 `finishCompleted()` 与 `return "success" as const` | `core/src/memory/memory-agent-loop.ts:47,58,118`；`core/src/runtime/helpers/project-memory-extraction.ts:19,148,155,163-164` | `subagent-maxturns-dangling.test.mjs` 用例 (6)(7) | **需修正 → 修正项 #2**（范围仅 memory 抽取的可观测性，不涉主/子代理终态） |
| 1b（悬空字段的处置） | **判悬空配置，且它带用户可写面**——比背景章起点 1 更重一层：`maxTurns` 是 agent markdown frontmatter 的合法字段，`services` 双向序列化、设置页保存时原样带回、`shared` 类型在案，另有两条 i18n 文案**全仓无消费点**。用户手写 `maxTurns: 2` 会被完整解析并透传到 child runtime 边界（测试 (8) 实测桩件收到 `request.maxTurns === 2`），随后**无人读取**，child 照 `while(true)` 跑到底、终态仍是 `completed`。处置取 **(i) 删除**：与 `apps/acode-cli/AGENTS.md:11`「不用 tool call 次数做硬停止」直接一致，且当前无任何消费面因删除而失效。若产品坚持保留该设置面，则必须走 (ii)，到顶终态为**可区分的截断态**，不得复用 `completed` | 测试 (5)(8) 实测；`grep -rn "settings.subagents.form.maxTurns" packages/`（排除 `locales/`）→ 无命中 `exit=1`；`grep -rn "maxTurns\|MAX_WORKFLOW_AGENT_TURNS" packages/ apps/acode-cli/tests/` → 命中面见 E2 | `core/src/runtime/types.ts:131,144`；`core/src/runtime/methods/subagent.ts:269`；`bootstrap/src/app/script-workflow-child-runtime.ts:115`；`contracts/src/workflow/script.ts:6,51`；`core/src/subagent/profile.ts:27,186,217`；`core/src/subagent/runner.ts:77,1146,1170-1171`；`packages/services/src/subagents/subagentMarkdown.ts:69,119-120`；`packages/shared/src/subagents-types.ts:57,102`；`packages/ui/src/settings/SubagentsSection.tsx:1023`；`packages/ui/src/i18n/locales/en-US.ts:3633-3634`、`zh-CN.ts:3405-3406` | `subagent-maxturns-dangling.test.mjs` 用例 (3)(4)(5)(8) | **需修正 → 修正项 #1** |

**问题 1 对方案 §8.2 第 2 项的直接答复**：原问法「subagent `maxTurns` 到顶的终态是否误报
`completed`」**前提不成立**——按当前检出主/子代理循环里不存在「到顶」，因此不存在「到顶误报
completed」。按 R1 判定口径逐字核：`status: "completed"` 由 `runner.ts:1170-1171` 无条件写出，
但触发它的是 child 自然收尾（`turn-stop.ts:236` 的 text-only break），不是被切断，故**不构成**
「误报 completed」。真缺口是 1b 的悬空配置（含用户可写面）与 1a 的 memory 抽取到顶不可区分。

### 问题 2：admission 丢弃路径的终态可观察性

生产装配事实（决定下表哪几行可达）：`CommandInbox` 全仓只被构造一次
（`bootstrap/src/acode-protocol-v4/v4-gateway.ts:632-657`），该宿主提供 `getRevision` /
`getLogEpoch` / `validateRowTarget` / 四个 lookup / `now`，**不提供 `guard`**
（`grep -rn "guard:" apps/acode-cli/packages/bootstrap/src/` 无命中）。因此
`command-inbox.ts:394` 的 `this.host.guard?.(envelope) ?? { verdict: "allow" }` 恒为 allow，
业务 guard 的三条分支（含唯一 `remember: true` 的 `noop`）在当前装配下**不可达**。

| reasonCode | 同步 ack 到达 | settled LRU 可查 | `lookupDiscardedCommand` 是否实现/落盘 | 晚到 duplicate 结果 | 重试幂等 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `proto.invalidPayload`（解析失败，`command-inbox.ts:119-127`，走 `ackOnly`） | 是（`status:"rejected"`）。**例外**：信封连 `commandId` 都不是字符串时 `extractCommandId` 返回 `""`（`:498-504`），ack 仍同步到达但无法被 query 指名 | 否（`ackOnly` 不经 `rememberSettled`） | 已实现（`v4-bridge.ts:1622` → `persistentCommands.lookup("discarded", …)`），但**不落盘**：事实源只有 `session_input` 行，解析失败从不建该行 | `"unknown"`（`queryOne:276`） | 是：重放同一坏信封仍 `rejected`/`proto.invalidPayload`，**不**被折叠成 `duplicate`（折叠只发生在 `lookupExact` 命中时） | **已闭合（测试钉住）** |
| `proto.sessionNotFound`（`:312-323`，`remember:false`） | 是（`rejected`，`revisionAtDecision:0`） | 否 | 同上，不落盘 | `"unknown"` | 是：`decide()` 只读 `host.getRevision`，无副作用；不分配 `admissionSeq`（`:162-164` 在 ack 分支之后） | **已闭合（测试钉住）** |
| `proto.missingBaseRevision`（`:326-337`，`remember:false`） | **不可达**：`parseCommandEnvelope` 对 CAS 命令缺 `baseRevision`／row-targeting 缺 `baseLogEpoch` 先行拒绝（`packages/shared/src/acode-protocol-v4/command.ts:347-362`），同一条件被报成 `proto.invalidPayload` | — | — | — | — | **死分支 → 修正项 #6**（全仓唯一产出方就是 `:333`） |
| `proto.staleLogEpoch`（`:340-351`，`remember:false`） | 是（`stale`，带 `revisionAtDecision`） | 否 | 不落盘 | `"unknown"` | 是：比较 `envelope.baseLogEpoch` 与 `host.getLogEpoch()`（读投影快照），纯函数 | **已闭合（测试钉住）** |
| `proto.staleRevision`（`:352-363`，`remember:false`） | 是（`stale`） | 否 | 不落盘 | `"unknown"` | 是：连续重放 3 次得到同一裁决，且从未产出 `kind:"execute"` | **已闭合（测试钉住）** |
| row-target `stale` / `reject`（`:367-379` / `:380-392`，`remember:false`；生产裁决方 `v4-gateway.ts:639-652`，reasonCode 来自 `proto.staleTarget` / `proto.invalidPayload` / resolver） | 是（带 `message` 原文上行） | 否 | 不落盘 | `"unknown"` | 是：`validateRowTarget` 委托 `publisher.resolveRowActionTarget` → `product-projection.ts:762`，同步只读投影查询 | **已闭合（测试钉住）** |
| 业务 guard `stale` / `reject`（`:397-409` / `:410-422`，`remember:false`） | 装上 guard 后是（测试 (6b) 实测两条分支各自可达且 ack 正确） | 否 | 不落盘 | `"unknown"` | 是（同上，guard 契约是纯裁决） | **代码正确但生产未接线 → 待验证（卡点见下）** |
| 业务 guard `noop`（`:423-435`，**`remember:true`**） | 装上 guard 后是（`status:"noop"`） | **是**（唯一进 LRU 的丢弃路径，`:157`） | 不需要落盘即可被 query 命中 | 非 `unknown`：query 得 `noop`；重放经 `retryAck` 折叠成 `duplicate` 且保留 `reasonCode` | 是 | **代码正确但生产未接线 → 待验证** |

**2b（`unknown` + 重试幂等）**：七类可达丢弃路径**全部**不落盘，晚到 duplicate 一律得
`"unknown"`；但按 R1 判定口径仍判「闭合」，因为 (a) 同步 ack 一定到达调用方（非 `unknown` 终态），
(b) 重试幂等——丢弃分支不分配 `admissionSeq`、不产出 `execute`、不建 `session_input`，
`decide()` 是 (信封 × 只读宿主/投影状态) 的纯函数（测试 (11) 实测两条丢弃后首条被 admit 的命令
`admissionSeq === 1`）。`v4-gateway.ts:2360-2364` 对 `kind === "ack"` 直接 return，不做任何持久化，
这是「不落盘」的决定性证据。

**2c（`noop` 与 `stale`/`reject` 的 `remember` 差别）**：**行为正确且必需，但没有文档化理由**。
`remember:false` 对 CAS 丢弃不是遗漏而是**必要条件**：`handle()` 在 `decide()` 之前先查
`lookupExact`（`:136-137`、`:149-153`），若把 `stale` 记进 settled LRU，客户端读到
`revisionAtDecision` 后修正 `baseRevision`、用**同一 commandId** 重发时会被短路成
`duplicate(stale)`，永远无法被 admit（测试 (7) 正向钉住：修正重试确实拿到 `kind:"execute"`）。
`noop` 反之必须记住——它表示「该命令的效果已成立/无需再做」，重试方需要认出它。
`command-inbox.ts` 全文对这条非对称**没有任何注释** → 判「未文档化」，登记修正项 #4（只补文字）。

**branchGeneration 过期丢弃（方案 D3 问题 2 点名的第一条）**：位置不在方案所写的
`runtime-command-active-loop.ts`，而在 `core/src/runtime/methods/runtime-command-generation.ts:6-30`
（`isStaleBranchRuntimeCommand`），由 `runtime-command-active-loop.ts:41-43` 调用——命令**先**被
`removeById` 出队，**再**判 stale 并 `continue`。可观察终态：只有 `logger.debug`
（`runtime-command-generation.ts:20-28`，event `runtime.command.stale_branch_dropped`），
按根 `AGENTS.md` 的日志分级，`debug` 生产不落盘。**判已闭合**，理由有二且都有文字依据：
(a) 约定已文档化——`:18-19` 明写「rewind 与后台 completion 存在竞态；命令即使已入队，也必须在
持久化和 provider 注入前再次校验 generation，**旧分支结果只留诊断日志**」；
(b) 终态并未丢失——被丢的是**通知注入**，任务自身的终态仍在 registry 快照里
（`isStaleBranchRuntimeTaskEvent:55` 只读 `registry.get(taskId)`，不改它），
`waitForTerminal` 不做 branch fencing（`registry.ts:197-204`），等待方照常拿到终态。
姊妹路径 `isStaleBranchRuntimeTaskEvent:32-66` 同款（丢事件、留快照、只 debug 日志）。
→ 登记修正项 #5（把这条约定从注释提升进 spec，并补一条测试钉住「丢通知不丢终态」）。

**duplicate collapse（方案 D3 问题 2 点名的第二条）**：**已闭合**。在飞 duplicate 不拿 admission
ACK，而是挂在同一个 `final` promise 上（`command-inbox.ts:134-135`、`:144-148`、`:166-170`、
`:197-201`），settle 时 `inFlight.delete` 与 `live.ack = ack` 在**同一同步块**内完成
（`:191-196`），所以不存在「live 已可见但 ack 还是 admission 版」的窗口。测试 (10) 实测：
settle 前第二条 `handle()` 不返回；settle 后它拿到 `duplicate` 且携带 `result`；
第二次 `settle` 被 `:184` 的 `if (settled) return` 吃掉，query 仍是首次终态。

### 问题 3：cancel / complete 竞态的次序语义

| 子问 | 谁是赢家（约定） | 约定是否已文档化 | E2 `file:line` | E3 测试 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 3a（子代理：race 三赢家 × taskAbort × finalize） | **代码行为 = 最后一个 `registry.update` 赢**，而不是「先到者赢」。前台 race 的三赢家（completed / backgrounded / auto-background）之间是互斥的 `Promise.race`，无竞态；真正的竞态在**转后台之后**：`finalizeBackgroundCompletion`、`finalizeBackgroundFailure`、`createBackgroundStoppedTask`→`finalizeBackgroundStopped` 三条终态路径各自「读快照判终态 → **await 真实文件 I/O** → 写快照」，而底层原语 `InMemoryRuntimeTaskRegistry.update()` **不带任何终态守卫**、无条件覆盖。守卫与写入之间的 I/O 是 `mkdir`+`writeFile`，窗口真实存在，且**双向**都能被覆盖（`completed`→`killed` 与 `killed`→`completed`）。另有一条通道分叉：`resolveWaiters` 首次结算即 `delete` 整组 waiter，所以 `waitForTerminal` 是 first-wins、`registry.get()` 是 last-wins | **否**。`runner.ts` 与 `registry.ts` 全文都不含 `first-wins` 字样，三处守卫都没有「谁是赢家/为什么」的注释，`update()` 的注释也没写「不得覆盖终态」。唯一相关的文字是 `runner.ts:1007`（SendMessage resume 失败不得覆盖原 terminal task）与 `:1055-1056`，都只覆盖 resume 方向 | `core/src/runtime-task/registry.ts:132-143`（update 无守卫）、`:103-110`（TERMINAL_STATUSES）、`:238-243`（resolveIfTerminal）、`:256-270`（resolveWaiters 先 delete）、`:145-152`（requestBackground 有守卫）、`:197-204`（waitForTerminal）、`:284-286`；`core/src/subagent/runner.ts:309-316`（race）、`:318-330`（转后台 + 挂 finalize）、`:332-351`（前台 completed 写入）、`:382-397`（前台 failed 写入）、`:1501-1502`→`:1504`→`:1519-1530`（completion 守卫/await/写入）、`:1580-1581`→`:1589`→`:1600-1608`（failure 同款）、`:1667-1668`→`:1701`→`:1702-1705`（stopped 同款）、`:556`（stopTask 终态早退）、`:1847-1857`+`:1881-1888`（通知层 `notified` 二次去重）、`:1923-1938`/`:1940-1950`/`:1952-1979`/`:2139-2142`（守卫与写入之间的真实文件 I/O） | `subagent-terminal-race-ordering.test.mjs` 用例 (1)(2)(3)(4)(5)(6) | **需修正 → 修正项 #3**（行为在串行方向正确、并发方向无原子性保证；约定文字完全缺失） |
| 3b（子代理侧是否有 first-wins 等价物） | **有等价物，但不是等价强度**。workflow 侧是「一处文档化约定 + 三条路径第一行同步守门」：`isRunSettled()` 与 `markSettled()` 之间**无 await**，所以 first-wins 是原子的。子代理侧是「三处分散守卫 + 第四层通知去重」，每处守卫与其写入之间都夹着 await，且原语层不兜底。串行两个方向实测都正确：先完成后取消 → `stopTask` 原样返回 `completed`、不追发通知；先取消后 child 失败 → 快照仍 `killed`、不追发通知 | **workflow 侧是；子代理侧否**。`engine-settlement.ts:7` 明写「first-wins 由 `isRunSettled()` 守在每条路径的第一行」，`:77` 明写「三条终态路径都经这里，所以 driver 的 dispose 恰好一次、first-wins 自然成立」 | 对照物：`dynamic-workflow/src/engine/engine-settlement.ts:7,22-24,41-48,66-68,77`（三处 `if (state.isRunSettled()) return;` + `state.markSettled(` 同步相邻）。子代理侧：`core/src/subagent/runner.ts:1338`（`?? { status: "lost" }` 读取兜底）、`:1501-1502`/`:1580-1581`/`:1667-1668` | `subagent-terminal-race-ordering.test.mjs` 用例 (4)(5)(6)——(6) 同时钉住「workflow 侧约定文字在案 + 三处同步守卫形状」与「子代理侧无 first-wins 字样 + 守卫与 update 之间确有 await」 | **需修正 → 修正项 #3** |
| 3c（CommandInbox：settle 幂等 + retryAck 是否覆盖 cancel 方向） | **覆盖，但是顺带覆盖**。`settle` 的 `if (settled) return` 与 gateway 的 `settleOnce`（`if (settledAck) return settledAck`）都是**同步**幂等，检查与置位之间无 await，所以「取消与完成同时到达」在 inbox 侧不可能产生第二次改写；所有同 key 请求共享同一 `final`。**cancel 方向靠归一化覆盖**：`CommandAck.status` 枚举里**没有 `cancelled`**，取消在持久事实层被投影成 `status:"failed"` + `reasonCode:"fault.command.inputCancelled"`，再由 `retryAck` 的「`failed` 是终态事实」保住不被折叠成 `duplicate` | **部分**。`:183-203` 文档化了共享 `final` 与「在途 duplicate 过去直接拿 admission ACK」的已修坑；`:446-447` 文档化了 `failed` 是终态事实。但**两处都没有点名 cancel**——取消方向是被「取消→failed」这一步归一间接保护的，约定文字里查不到 | `bootstrap/src/acode-protocol-v4/command-inbox.ts:183-203`（`:184` 同步幂等、`:191-196` 同块删除+改 ack、`:197-201` 共享 final 的理由）、`:446-449`（retryAck）；`bootstrap/src/acode-protocol-v4/v4-gateway.ts:2375-2384`（settleOnce）、`:2385-2393`（cancelDurableInput）、`:2453-2458`（accepted）、`:2461-2468`（noop）、`:2477-2487`（failed）、`:2489-2499`（finally 兜底 failed）；`packages/shared/src/acode-protocol-v4/command.ts:436`（status 枚举无 cancelled）；`bootstrap/src/acode-protocol-v4/persistent-command-facts.ts:88-132`（cancelled/discarded → `failed` + `fault.command.inputCancelled`） | `subagent-terminal-race-ordering.test.mjs` 用例 (7)(8)；`command-inbox-discard-terminal-state.test.mjs` 用例 (9)(10) | **已闭合（测试钉住）+ 补文字 → 修正项 #4** |

**3a 的可达性说明（不夸大）**：测试 (1)(2) 证明的是**原语层缺少不变量**（`update()` 可双向覆盖终态；
waiter 与快照分叉），这是确定的。测试 (4)(5) 证明的是**两个串行方向都正确**。
「并发方向真的被覆盖过」需要一次运行时复现（两条 finalize 路径的 I/O 交错），本次审计
**未做该复现**，故按 R3 登记为：不变量缺失 = 已确认；线上是否已发生 = **未确认**。
修正项 #3 的最小修复正是不依赖该复现也能成立的那一条（把 first-wins 收进原语层）。

### 附带核验：后台任务的机器可读结果摘要

| 核验点 | 结论 | E1 | E2 | E3 |
| --- | --- | --- | --- | --- |
| summary 单行 / 含 status / failed 含原因 | **满足**。`formatLocalAgentNotificationSummary` 产出单行 `Agent <type> task "<desc>" <status>.`；`failed` 且 `error` 非空白时追加与 `<error>` **同文**的原因，故只读 summary 一行即知「失败了 + 为什么」，不必再开 outputFile。`completed`/`stopped` 不追加（空白 error 也不追加，无尾随空格）。整条通知是结构化 XML，`<task-id>`/`<tool-use-id>`/`<output-file>`/`<status>`/`<summary>`/`<result>`/`<error>`/`<usage>` 各成节，`<usage>` 内是 `<subagent_tokens>`/`<tool_uses>`/`<duration_ms>` 三个机读字段；超 120k 截断并标 `[truncated]`。description 里的 `"`/`<`/`&` 被转义，summary 的单行性与可解析性不被破坏 | 测试 (1)(2)(3)(7)(8) 实测：三种 status 的 summary 逐字符相等断言；failed 的 summary 与 `<error>` 同文；含 `"` `<` `&` 的 description 转义后不含裸 `<b>`；`truncateTaskNotification` 在 120_000 处不加尾、120_001 处加 `[truncated]` | `core/src/subagent/completion-notification.ts:4,21-41,43-51`（`:46` 单行模板、`:47` 仅 failed 取 error、`:50` 追加）；`core/src/runtime-task/notification.ts:144-158`（local_agent 的 XML 形状）、`:333-348`（usage 三字段）、`:18,380-383`（120k 截断）、`:385-402`（escapeXml）；调用方 `core/src/subagent/runner.ts:1505-1517`（completed）、`:1590-1599`（failed）、`:1692-1700`（stopped） | `apps/acode-cli/tests/subagent-completion-notification-summary.test.mjs` 用例 (1)(2)(3)(7)(8) |
| 三处终态表达之间是否存在不一致组合 | **未发现已确认可达的不一致组合**，但记录四处必须知道的非对称：<br>(a) **`stopped` 的 summary 不带原因**（`:47` 只对 `failed` 取 error，`finalizeBackgroundStopped` 调用时也不传 `error`）。原因不是丢失，而是搬到别处：registry 快照的 `error` 字段 = `"Background agent task stopped."`，输出文件与 `metadata.json` 同文。判**不违反**约定（约定只要求 failed 含原因），但跨通道读原因的位置不同，需登记。<br>(b) **同一次停止在四条通道上是四个词**：registry `killed` / notification `stopped` / subagent event `stopped` / background event `cancelled`，由 `BACKGROUND_AGENT_STOPPED_STATE` 一处常量集中定义。跨通道一致性**必须按这张表判，不能按字符串相等判**。<br>(c) **快照 `lost` 不会产出 `completed` 通知**：`lost` 在 `runner.ts` 里只作为**读取兜底**出现一次（`:1338`），从不被写入 registry；通知入口另有 `task_missing` 守卫（`:1847-1857`）在条目缺失时拒发。故「快照 lost + 通知 completed」不可达。<br>(d) **未确认项**：`finalizeBackgroundCompletion` 的守卫是 `current && isTerminalRuntimeTask(current)`——条目**缺失**时守卫不触发，随后 `registry.update` 返回 `undefined`（不写快照）、通知被 `task_missing` 拒发、`BackgroundTaskCompleted` 被 `if (task)` 挡掉，但 `emitSubagentEvent(SubagentStopped, status:"completed")` 是**无条件**的。审计遍历了 `runner.ts` 全部 4 处 `registry.remove(lifecycle.agentId)`，都是 setup 失败即 `throw` 的路径、发生在 `completionPromise` 之前，**未找到可达产出方** → 按 R3 登记为「未确认」，不写成已确认缺口 | 测试 (4)(5)(6)(6b) 实测；`grep -n '"lost"' packages/core/src/subagent/runner.ts` → 1 处命中（`:1338`）；`grep -n 'registry\.remove(lifecycle.agentId);' …/runner.ts` → 4 处命中（`:195,271,461,512`），逐一读上下文确认均为 setup 失败即 throw | `completion-notification.ts:43-51`；`runner.ts:1338`（lost 读取兜底）、`:1655-1661`（四通道词表）、`:1663-1684`（`createBackgroundStoppedTask` 写 `error`/`registryStatus`）、`:1692-1700`（stopped 通知不传 error）、`:1847-1857`（task_missing 守卫）、`:1952-1979`（停止原因写进输出文件与 metadata）、`:1501-1502`+`:1538`+`:1542-1559`（(d) 的三段无条件/有条件分界）、`:195,271,461,512`（四处 remove） | `subagent-completion-notification-summary.test.mjs` 用例 (4)(5)(6)(6b) |

### 修正项登记

> 全部为**另立项**，本审计 PR 不含任何产品代码改动（R3）。逐条注明是否触及 R3 不变量。

| # | 来源问题 | 最小修复范围 | 落点 | 是否触及 R3 不变量 |
| --- | --- | --- | --- | --- |
| 1 | 问题 1（1 + 1b） | **删除悬空的 `maxTurns`**：`core/src/runtime/types.ts:131,144` 两个字段、`methods/subagent.ts:269` 与 `script-workflow-child-runtime.ts:115` 两处装配、`contracts/src/workflow/script.ts:51` 的 schema 成员与 `:6` 的 `MAX_WORKFLOW_AGENT_TURNS`、`core/src/subagent/runner.ts:77,1146` 的透传、`core/src/subagent/profile.ts:27,186,217` 与 `packages/services/src/subagents/subagentMarkdown.ts:69,119-120` 的 frontmatter 往返、`packages/shared/src/subagents-types.ts:57,102` 的类型成员、`packages/ui/src/settings/SubagentsSection.tsx:1023` 的保留逻辑、`en-US.ts:3633-3634` 与 `zh-CN.ts:3405-3406` 两条孤儿文案。**兼容性**：已写了 `maxTurns:` 的用户 frontmatter 会变成未知键——需确认 profile 解析对未知键是忽略还是报 diagnostic，并据此决定是否给一条迁移提示。若产品选择保留设置面，改为实现 (ii)：到顶终态必须是可区分的截断态（新 status 或 `completed` + 显式截断标记），**不得**裸复用 `completed` | 新 spec `subagent-maxturns-policy.md` | 否 |
| 2 | 问题 1（1a） | **让 memory 抽取的到顶可区分**：`memory-agent-loop.ts:118` 的返回值增加一个截断标记（例 `capped: boolean`，或 `finishReason: "tool_calls_exhausted" \| "max_turns"`）；`project-memory-extraction.ts:163-164` 据此分流，不再对到顶无条件 `finishCompleted()` + `return "success"`。范围仅这两个文件，不改循环语义、不改 `EXTRACTION_MAX_TURNS` | 本 spec 追加小节 **§A memory 抽取到顶的可观测性** | 否 |
| 3 | 问题 3（3a + 3b） | **把 first-wins 收进原语层并写下约定**：在 `runtime-task/registry.ts:132-143` 的 `update()` 增加终态保护（已终态的条目拒绝被另一个终态覆盖；重臂路径 `background-task-registry.ts:100,113-114` 已显式复位结算面，需确认它走的是 `register` 而非 `update`，避免被新守卫挡住），或在 `runner.ts` 三处把「判终态 + 写终态」收进一次同步 patch、把文件 I/O 移到写入之后。同时在 `registry.ts` 的 `update()` 与 `runner.ts` 三处守卫补注释，明写「谁是赢家、为什么」，对齐 `engine-settlement.ts:7` 的表达强度。**验收**：并发方向也 first-wins；`waitForTerminal` 与 `registry.get()` 不再分叉；重臂（resume 新生命）不被新守卫误挡 | 新 spec `subagent-terminal-first-wins.md` | 否（不涉 CommandInbox 锁序 / 三态分离 / CAS / admissionSeq） |
| 4 | 问题 2（2c）+ 问题 3（3c） | **只补约定文字，不改行为**：在 `command-inbox.ts` 的 `remember` 分派处（`:157` 与 `decide()` 的各 `remember` 字面量）写下「CAS/guard 丢弃必须 `remember:false`，否则修正重试会被 `lookupExact` 短路成 duplicate；`noop` 必须 `remember:true`，因为它的效果已成立」；在 `retryAck`（`:446-449`）补一句「cancel 方向靠 persistent-command-facts 把 cancelled/discarded 归一成 `failed` 来覆盖，`CommandAck.status` 无 `cancelled`」 | 本 spec 追加小节 **§B CommandInbox 终态约定文字** | 否（纯注释） |
| 5 | 问题 2（branchGeneration） | **把已有约定从注释提升进 spec + 补一条测试**：`runtime-command-generation.ts:18-19` 的「旧分支结果只留诊断日志」是正确且已文档化的产品决定，但它只活在源码注释里。把它写进 spec（丢的是通知注入，不是终态；终态仍在 registry 快照，`waitForTerminal` 不做 branch fencing），并补测试钉住「stale-branch 丢弃后 registry 终态仍可观察」。可选：把 `:20` 的 `debug` 提为 `info`——按根 `AGENTS.md`，`debug` 生产不落盘，而「队列丢弃」被 `apps/acode-cli/AGENTS.md:81` 明列为必须可观测的面 | 本 spec 追加小节 **§C stale-branch 丢弃的可观测性约定** | 否 |
| 6 | 问题 2（`proto.missingBaseRevision`） | **删除死分支或补注说明**：`command-inbox.ts:326-337` 经 `handle()` 不可达（`command.ts:347-362` 的 parse 层先拒成 `proto.invalidPayload`），全仓唯一产出方就是 `:333`。二选一：删掉该分支；或保留并注释为「parse 层的纵深防御，正常路径不可达」。**取舍**：若客户端可能绕过 `parseCommandEnvelope` 直接调 `decide()`（当前不能，`decide` 是 private），删除更安全 | 本 spec 追加小节 **§B CommandInbox 终态约定文字** | 否 |
| 7 | 验收场景 5 | **补 CommandInbox 不变量测试套件**：R3 与验收场景 5 都假定它存在，实际全仓为零（只有本次新增的 15 例）。至少覆盖 R3 点名的四条不变量：固定锁序（key gate → session gate，`:139-141`）、settle 前不放行（`:183-203`）、`baseRevision` + `baseLogEpoch` CAS 拒 stale（`:337-363`）、`admissionSeq` 权威顺序（`:162-164`）、三态分离（`:107-113`，含 >512 churn 时在飞命令不被淘汰）。本次新增的 `command-inbox-discard-terminal-state.test.mjs` 已覆盖 CAS 拒 stale、admissionSeq 顺序、settle 幂等与 duplicate collapse，可作为起点 | 新测试文件 `apps/acode-cli/tests/command-inbox-invariants.test.mjs` | 否（只加测试） |
| 8 | 问题 2（业务 guard 未接线） | **待验证，需产品/host 侧意图确认**：`CommandInboxHost.guard`（`:33`）与它的三条裁决分支（`:394-435`，含唯一 `remember:true` 的 `noop`）在生产装配里从不被提供（`v4-gateway.ts:632-657` 只接 `validateRowTarget`）。代码本身正确（测试 (6b)(6c) 实测装上 guard 后三条分支各自可达、语义正确）。卡点：这是**有意预留的扩展点**还是**遗漏接线**，代码侧无法判定；若属遗漏，需要指明哪些 product-protocol guard id 该由它承载。判定前不动代码 | 登记进方案 §8.2 待验证清单（新增第 7 项） | 否 |

### 审计判定汇总

| 条目 | 判定 |
| --- | --- |
| 问题 1 | **需修正**（修正项 #1 悬空配置含用户可写面；#2 memory 抽取到顶不可区分）。原问法「到顶误报 completed」前提不成立 |
| 问题 2 | **主体已闭合（测试钉住）**：同步 ack 全覆盖、重试幂等、duplicate collapse 与 branchGeneration 丢弃都有终态可观察或有文档化理由。附带 4 条登记：#4 约定文字缺失、#5 约定只在注释、#6 死分支、#7 不变量套件不存在；#8 待验证 |
| 问题 3 | **需修正**（修正项 #3）：子代理侧 first-wins 强度弱于 workflow 侧且**完全无文档化约定**；CommandInbox 侧已闭合但 cancel 方向是顺带覆盖（#4 补文字） |
| 附带核验 | **已闭合（测试钉住）**：summary 满足「单行 / 含 status / failed 含原因」。四处非对称据实记录，其中 (d) 标 **未确认**（无可达产出方） |

## 追加小节（修正项落地的规格，2026-09-29 回填）

> R3 规定「需修正」的修复项各自走 spec-first；修正项 #2/#4/#5/#6 的落点登记为**本 spec
> 追加小节**（见上表）。三个小节的实现已在工作区落地（各节「实现落点」给出复核后的
> `file:line`），本节是它们的规格文字——产品约定的**规范来源**在这里，源码注释只做
> 就地摘要并回指本节。回填动因：实现先行时源码注释已引用 §A/§B/§C，而小节本体尚未
> 写入本 spec（2026-09-29 盘点登记的悬空引用，同日补齐）。

### §A memory 抽取到顶的可观测性

**来源**：修正项 #2（问题 1/1a——唯一真实 `maxTurns` 强制点的到顶终态不自描述）。

**产品规则**：

1. `runMemoryAgentLoop` 的返回值必须携带显式截断标记 `capped: boolean`：
   `true` = 循环因 `maxTurns` 用尽而退出（模型最后一轮仍在索取工具）；
   `false` = 模型自然收尾（某轮不再索取工具）。
   **`turns` 单独不构成可区分信号**：自然收尾在 break 前 `turns += 1`、到顶由循环头
   `turns += 1`，`maxTurns=1` 时两者都返回 `turns=1`——这是 `capped` 必须存在的理由，
   不是锦上添花。
2. 调用方（project memory 抽取）**必须消费 `capped`**，不得丢弃返回值后无条件报成功：
   到顶时记一条 `warn` 级日志（事件 `memory.extraction.turn_capped`，带 `maxTurns` 与
   `turns`）——按根 `AGENTS.md` 日志分级，「memory 文件可能只写了一半」属可恢复异常。
3. **到顶仍返回 `success`（cursor 照常推进），这是登记在案的取舍而非缺口**：
   `MemoryExtractionExecutionStatus` 是 extraction.ts 内的闭合四值联合
   （success/no-op/error/aborted），没有「截断」档；而 error/aborted 都不推进 cursor，
   会让同一窗口每次触发都重抽（每轮最多 `EXTRACTION_MAX_TURNS` 次模型调用）且不保证收敛。
   本项只补可观测性，不改重抽策略；若产品要求「到顶重试」，须另立项并给出重试上界。
4. 范围边界：本节只约束 memory 抽取链路。主/子代理 turn loop 不存在轮数上限
   （问题 1 结论），配置面 `maxTurns` 已整体删除（`subagent-maxturns-policy.md`）；
   `EXTRACTION_MAX_TURNS = 5` 是硬编码常量，不接任何用户/配置可写面。

**实现落点**（2026-09-29 复核）：`core/src/memory/memory-agent-loop.ts:24-37`
（`capped` 字段与「为什么必须显式带出」的注释）、`:66-71`（`finishedNaturally` 只在自然
收尾置真）、`:91-95`（自然收尾分支）、`:132`（`capped: !finishedNaturally`）；
`core/src/runtime/helpers/project-memory-extraction.ts:23`（`EXTRACTION_MAX_TURNS = 5`）、
`:159`（唯一喂入点）、`:167-179`（capped 分流 + warn）、`:180-186`（success 取舍注释）。

**测试**：`apps/acode-cli/tests/subagent-maxturns-dangling.test.mjs` 用例 (6)（到顶/自然
收尾/`maxTurns=1` 同 turns 三组行为断言）与 (7)（抽取侧消费 capped、warn 事件、success
取舍文字在案）。

### §B CommandInbox 终态约定文字

**来源**：修正项 #4（问题 2/2c + 问题 3/3c——行为正确但约定未文档化）与修正项 #6
（`proto.missingBaseRevision` 死分支处置）。**本小节只登记约定文字，不改任何行为。**

**约定 1（`remember` 的非对称是必要条件，不是遗漏）**：

- **CAS / guard 的丢弃一律 `remember: false`**（不进 settled LRU）。这些终态描述的是
  「以客户端当时的 baseRevision/baseLogEpoch 为前提不成立」；客户端读到
  `revisionAtDecision` 后会用**同一 commandId** 修正重发。若把 stale 记进 LRU，重发会在
  `handle()` 的 `lookupExact` 处被短路成 `duplicate(stale)`，修正**永远无法被 admit**。
- **guard 的 `noop` 必须 `remember: true`**（`decide()` 唯一的 true）。noop ≠ 丢弃：
  它表示该命令的效果已成立或无需再做，是需要被晚到重试认出的终态事实。
- 推论（审计问题 2b 已证）：`remember: false` 的丢弃对晚到 duplicate 表现为 `unknown`，
  闭合性由「同步 ack 必达 + 重试幂等（`decide()` 是信封 × 只读宿主状态的纯函数）」承担，
  不靠 LRU。

**约定 2（cancel 方向靠归一化覆盖）**：`retryAck` 把非 `failed` 的既有终态折叠成
`duplicate`，`failed` 原样保留——「`failed` 是终态事实，不得被 duplicate 覆盖」。
`CommandAck.status` 枚举（`packages/shared/src/acode-protocol-v4/command.ts:436`）里
**没有 `cancelled`**；取消在持久事实层就被归一成 `status:"failed"` +
`reasonCode:"fault.command.inputCancelled"`
（`bootstrap/src/acode-protocol-v4/persistent-command-facts.ts:108-119`），所以取消的
终态走的正是 failed 分支、同样不可被折叠。**这条约定有上下两半**（status 枚举 +
归一投影），改动任何一半都必须重新核对另一半。

**约定 3（修正项 #6 的处置：死分支保留 + 注明）**：`proto.missingBaseRevision` 分支经
`handle()` 不可达——parse 层对同一条件先拒成 `proto.invalidPayload`
（`packages/shared/src/acode-protocol-v4/command.ts:347-362`），且 `decide()` 是 private、
当前无旁路调用方。**取舍记录**：选择「保留 + 注明纵深防御」而非删除，理由：
(a) 删掉也不失守——`baseRevision` 缺失会落到 `envelope.baseRevision !== revision` 比较
（`undefined !== number` 恒真）被拒成 `staleRevision`，只是 reasonCode 不够精确；
(b) 保留的分支自带「正常路径不可达」注释，未来出现绕过 parse 的调用方时语义仍然正确。
若日后 `decide()` 被暴露为可旁路调用，本分支从纵深防御升级为主防线，届时删除本注释。

**实现落点**（约定文字全部已写进源码，2026-09-29 复核）：
`bootstrap/src/acode-protocol-v4/command-inbox.ts:314-325`（`decide()` docstring：约定 1）、
`:156-163`（`handle()` 的 remember 分派注释）、`:449-455`（noop 的 remember:true 就地理由）、
`:475-485`（`retryAck`：约定 2 含上下两半的核对提醒）、`:344-351`（missingBaseRevision
死分支注释，取舍回指本节；分支体 `:352-363`）。

**测试**：`apps/acode-cli/tests/command-inbox-discard-terminal-state.test.mjs` 用例
(3)（死分支不可达）、(6c)（noop 进 LRU + 重放折叠 duplicate）、(7)（remember:false 对
修正重试的必要性）、(9)（failed 不被折叠）；`apps/acode-cli/tests/command-inbox-invariants.test.mjs`
用例 (7)（约定文字与 §B 互引在案，防注释被静默删除）。

### §C stale-branch 丢弃的可观测性约定

**来源**：修正项 #5（问题 2 的 branchGeneration 过期丢弃——约定正确但只活在源码注释里；
可选的 debug→info 提升一并落地）。

**产品规则**：

1. **丢弃的是通知注入，不是终态**。rewind 与后台 completion 存在竞态；命令即使已入队，
   也必须在持久化和 provider 注入前再次校验 generation，旧分支结果只留诊断日志。
   任务自身的终态仍在 runtime task registry 的快照里：两条丢弃路径
   （`isStaleBranchRuntimeCommand` / `isStaleBranchRuntimeTaskEvent`）对 registry
   **只读不写**，且 `waitForTerminal` **不做 branch fencing**——等待方照常拿到终态。
   「丢弃」≠「终态丢失」。
2. **日志分级的非对称是刻意的**：
   - 命令丢弃路径用 **info**（事件 `runtime.command.stale_branch_dropped`，带 commandId /
     branchGeneration / currentBranchGeneration / mode / trace 关联）：一条被丢命令一行、
     不会成突发，而「队列丢弃」是 `apps/acode-cli/AGENTS.md` 明列必须可观测的面，
     debug 生产不落盘等于生产不可见（这就是修正项 #5 的可选提升，已实施）。
   - 事件丢弃路径**保持 debug**（事件 `runtime.task_event.stale_branch_dropped`）：
     按事件粒度触发，一个 stale-branch 任务在 rewind 后可连发多条
     BackgroundTaskUpdated / SubagentMessage，提到 info 会造成日志突发。终态可观察性
     不依赖这条日志（规则 1）。
3. **调用点形状**：active-loop 先把命令 `removeById` 出队，**再**判 stale 并 continue——
   出队事实不回滚，丢弃的只是后续的持久化与 provider 注入。改动此顺序即改变本节约定，
   须回到本 spec 复核。

**实现落点**（2026-09-29 复核）：`core/src/runtime/methods/runtime-command-generation.ts:18-27`
（约定注释，回指本节）、`:28-36`（info 日志与分级理由）、`:63-68`（事件路径只读 registry +
刻意不同级的理由）、`:69-76`（debug 日志）；调用点 `core/src/runtime/methods/runtime-command-active-loop.ts:41-43`；
只读面 `core/src/runtime-task/registry.ts:227-234`（`waitForTerminal` 无 generation 判断）。

**测试**：`apps/acode-cli/tests/stale-branch-terminal-observability.test.mjs`（7 例，
2026-09-29 新增）：(1) 丢弃后 get/waitForTerminal 两通道终态仍可观察；(2) 两条路径对
registry 只读不写；(3) 命令路径 info + 对账字段；(4) 事件路径刻意 debug + 四类事件与
agentId 回退识别；(5) waitForTerminal 跨代不 fencing；(6) 对照组（同代/围栏外 mode/
无 taskId/任务不存在/围栏外事件不丢弃）；(7) 约定文字与调用点形状防回退。

## 不在本项范围

- **重写 CommandInbox**：方案 D3 明确否决（ACode 现有设计成熟度高于上游自曝水平；
  重写破坏 admission 不变量）。
- **任何产品代码改动**：本项只读。修复另立项，各自 spec-first。
- **cron 空闲触发验证**：归方案 D6（独立验证项，有自己的集成测试判据）。
- **workflow 预算保险丝**：归 `workflow-budget-fuses.md`（D2）。本项只把
  `engine-settlement.ts` 的 first-wins 作为问题 3b 的**对照物**，不审它的预算语义。
- **上游队列语义的移植**：上游自曝的两处缺口只作为自查清单使用；不把它们当作目标形态，
  也不引用其内部标识符（方案 §7.2 合规要求）。
- **遥测/上报**：审计产出不含任何外发通道；结论只落本 spec 与测试（`no-telemetry.md` 红线）。
