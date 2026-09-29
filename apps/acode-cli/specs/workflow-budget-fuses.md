# dynamic-workflow 预算保险丝与 resume 预算继承（D2）

调度主线 P1 项（token 硬顶为 P2）。给 dynamic-workflow 补**总量**保护：现有的自适应并发控制器
控的是**速率**（一个 provider key 上的 AIMD 状态机），没有任何机制限制一个 run 累计能烧多少。
一个脚本里写了失控回环（`while(true) { agent().ask(...) }`）时，今天唯一会停下来的理由是
provider 配额、用户取消或进程被杀。

本 spec 遵循仓库既有的 cap 惯例（三个已存在的 cap 模块，见背景），不发明新形态。
红线：不用超时掩盖同步问题、不新增第二条写入路径、run 的裁决权归引擎
（`dynamic-workflow-runtime/src/harness.ts:24` 与 `:348-349` 的注释已把这条定死）。

## 背景

### 已有的总量/上限机制（已核实）

仓库里已经有**三组** cap，它们确立了本 spec 必须遵守的设计惯例：

| cap 模块 | 执行侧 | 溢出策略 | 关键论证（模块注释原文要点） |
| --- | --- | --- | --- |
| `facade/world-read-caps.ts`（`WORLD_READ_CAPS`：glob 2000 文件、grep 2000 命中 / 256 KB、git.log 100 条、world.run stdout/stderr 各 256 KB） | driver | **节点级拒绝**（`WorldReadCapExceeded`，脚本可 `catch`） | 「绝不截断后加个标志位」——截断把悄悄残缺的世界视图交给脚本，而脚本接下来拿它去扇出，扇出才是贵的那一步。常量住纯包（数字即契约），执行在 driver（只有它能「不生产」） |
| `facade/report-caps.ts`（`REPORT_CAPS`：每 run 256 条、单条序列化 32 KB） | 引擎核心 | **失败整个 run**（`ReportCapExceeded`） | 不是严重程度的判断，而是**拒绝通道**的事实：`report` 返回 `void`，脚本没地方 `catch`。也正因作者写不出恢复路径，数字必须宽到讲道理的脚本永远碰不到 |
| `facade/artifact-caps.ts`（`ARTIFACT_CAPS`：32 个 id、每 id 16 版、file 20 MB、markdown 256 KB、title 120 字符、description 500 字符、spec 8 KB、id 64 字符） | **按成员族分裂**：id 数/版本数在引擎核心，字节数/文本长度在 driver | **按成员族分裂**：内容成员（`file`/`markdown`）返回 promise → 节点级拒绝（`ArtifactTooLarge` / `ArtifactVersionCapExceeded` / `ArtifactCapExceeded`）；预置成员返回 void → failRun | 同一条论证：有无 catch 通道决定拒绝层级 |

**这条惯例就是本 spec 的判定规则**：溢出走哪一层，取决于脚本有没有 catch 通道；常量一律住
纯包（`facade/*-caps.ts`）并有名字，让引擎测试与 driver 测试断言同一份常量而不是各抄一份。

其余已具备的相关机制：

- **速率控制**：`engine/concurrency.ts:1-40` 的 `ConcurrencyController`（降 0.75 倍、连成 4 次升 1、
  下限 1、空闲 300 s 重置），度量单位是模型请求；派发闸在
  `engine/scheduler.ts:398`（`activeAsks >= host.caps.maxConcurrency` 即不再派发）。
- **Caps 类型**：`engine/types.ts:119-121` 只有 `maxConcurrency` 一个成员；引擎自留一份副本
  （`engine.ts:231`，注释说明是为了不被一次 retune 改写调用方对象），`setMaxConcurrency`
  （`engine.ts:579-589`）整份换掉并发 `run-caps-changed`（`types.ts:582`），抬高时多一次 `pumpAll()`。
- **每 ask 的修复预算**：`REPAIR_ATTEMPTS = 3`（`types.ts:941`）、`NUDGE_ATTEMPTS = 1`
  （`types.ts:944`）；用尽在 `engine/scheduler-submit.ts:41,51` 抛 `WorkflowError`。
  这是**单节点**预算，不是 run 级总量。
- **脚本侧的 per-ask 上限**：`contracts/src/workflow/script.ts:4-7` 的
  `MAX_WORKFLOW_AGENT_TOOLS = 128` / `MAX_WORKFLOW_AGENT_SKILLS = 64` /
  `MAX_WORKFLOW_AGENT_TURNS = 200` / `MAX_WORKFLOW_AGENT_TIMEOUT_MS = 86_400_000`。
  同样是**单 ask** 的量，不是 run 累计。
- **token 记账已存在且已跨生命周期继承**（这是本 spec 最重要的既有事实）：
  `engine.ts:218` `spentTokens` 字段注释明写「累计 token 用量（观察面：只记账、只广播，
  **永远不会让 run 失败**）」；累加点 `engine.ts:615`（`+= stats.tokens`）、落库
  `engine.ts:618`（`journal.updateRunUsage`，端口声明 `types.ts:886`）、广播
  `engine.ts:625`（`usage-updated` 事件，`types.ts:600`）。
  amend 起账 `engine.ts:308-309`（`config.inheritedTokens`，归一化：非有限值与负数按缺席、
  小数下取整，理由见 `:305-307` 注释——这个数要落 `spent_tokens` 列，脏值必须死在写库之前）；
  resume 恢复 `engine.ts:362`（`this.spentTokens = existing.spentTokens`）；恢复后补发一条
  `usage-updated`（`engine.ts:383`，理由见 `:378-382` 注释：投影把 `run-started` 当作用量清零）。
  harness 侧 `inheritedTokens` verbatim 转交（`harness.ts:176`）。
- **run 级计数器的 resume 恢复法已有两个先例**：`reportCount`（`engine.ts:207` 字段注释 +
  `:355` 按 journal 里 `kind:"report"` 的行数恢复）与 `artifacts`（`engine.ts:216` 字段注释 +
  `:358-361` 按 `kind:"artifact" ∧ status:"completed"` 行重建）。两处注释都写了同一条理由：
  **上限是 run 级的事实，跨 resume 必须连续计数，否则一个反复 resume 的 run 可以无限报告/发布**。
  本 spec 的新计数器必须照这个形状做。
- **三条终态路径**：`engine/engine-settlement.ts:22-33`（`settleCompleted`）、`:40-64`
  （`settleStopped`，五个 `RunStopReason`，`types.ts:466`）、`:66-73`（`settleFailed`，收
  `WorkflowError`）。first-wins 由 `isRunSettled()` 守在每条路径第一行。
- **错误码词汇表**：`engine/errors.ts:41-76`（`WorkflowErrorCode` 联合，含
  `WorldReadCapExceeded` / `ReportCapExceeded` / `ArtifactCapExceeded` 等既有 cap 码）。

### 已确认的缺口

1. **无 run 级 agent 总量保险丝**。journal 里 `kind:"ask"` 的行数没有任何上界
   （`NodeKind` 见 `types.ts:429`）；`registerActor` 只按站点数已存在的行
   （`scheduler.ts:79-90`），不判总量。
2. **无 fan-out 宽度上界**。一个 `Promise.all([...N 个 ask...])` 会把 N 个节点全排进队列，
   `scheduler.ts:398` 只按 `maxConcurrency` 控制**同时派发**几个，队列长度本身无界。
3. **token 只观察不设顶**。`spentTokens` 已记账、已落库、已跨 resume/amend 继承，但
   `engine.ts:218` 的注释明写它永远不会让 run 失败——即计量面**已经存在**，缺的只是阈值判定。

### 对方案 D2 原文的一处更正（实施前必读）

方案 D2 写的是「单次 `parallel()`/`pipeline()` 条目数上限」。**当前检出没有这两个 API**：
`facade/dts.ts` 声明的全部脚本面是 `agent()`（`:65`）、`log()`（`:71`）、`report()`（`:103`）、
`artifact.*`（`:191`）、`phase()`（`:256`）、`files.*`（`:278`）、`git.*`（`:346`）、`world.*`
（`:403`）、`args`（`:424`）——没有 `parallel`，也没有 `pipeline`。fan-out 是脚本里的普通
TypeScript：`Node<T> extends PromiseLike<T>`（`dts.ts:20-23`，注释「await it, or combine with
`Promise.all` for joins」），并发由 analyzer **派生**而非声明
（`analysis/constants.ts:22`：「`parallel` stays derived — incomparability in the ordering
already defines concurrency, and storing it would be a second source of truth」）。

因此本 spec 把「单次条目数上限」重述为**待决 ask 积压（fan-out 宽度）上限**——即同一时刻
已入队未结算的 ask 节点数。这是脚本 `Promise.all` 宽度在引擎侧的真实投影，也是唯一能被引擎
观察到的「一次扇出有多少条」。**不引入 `parallel()`/`pipeline()` API**（那是脚本面扩张，
与本项无关，且会与 analyzer 的派生语义打架）。

## 产品规则

### R1 三道保险丝与常量归属

新增纯包模块 `dynamic-workflow/src/facade/budget-caps.ts`，与既有三个 cap 模块同级同姿态
（常量住纯包、数字即契约、执行侧在注释里写明）：

```ts
export const BUDGET_CAPS = {
  /** 一个 run 内最多能结算/派发多少个 ask 节点（agent 总量保险丝）。 */
  maxAsksPerRun: <实施时定，见 R2>,
  /** 同一时刻最多能有多少个未结算的 ask 节点（fan-out 宽度保险丝）。 */
  maxPendingAsks: <实施时定，见 R3>,
  /** 一个 run 累计 token 硬顶（P2 后置；0/undefined = 不设顶）。 */
  maxTokensPerRun: <P2 实施时定，见 R4>,
} as const;
```

- 三个数字的**定值原则**沿用 `report-caps.ts` 的论证：宽到一份讲道理的脚本永远碰不到。
  定值必须在实现 PR 里给出依据（例：现有 bundled 脚本/workflow 的最大实际用量 × 安全倍数），
  并回写本 spec 的「常量定值记录」小节。
- `maxTokensPerRun` 是**唯一**允许「不设顶」的成员（P2 后置期间保持不设顶 = 零行为变化）。
  前两个必须在 P1 落地即有值。

### R2 agent 总量保险丝（run 级）

- **计数口径**：一个 run 内**派发过**的 ask 节点总数（含 repair/nudge 重试轮？——**不含**：
  `REPAIR_ATTEMPTS`/`NUDGE_ATTEMPTS` 是同一个 ask 节点内的往返，journal 里仍是同一行；
  计数按 `kind:"ask"` 的**行数**，与 `reportCount` 的 `nodes.filter(n => n.kind === "report").length`
  同法，`engine.ts:355`）。
- **恢复法**：resume 时按 journal 行重建（与 `reportCount` / `artifacts` 同一处、同一次
  `listNodes` 读取——`engine.ts:354` 的注释已说明「节点行只读一次，下面的报告计数与产物恢复
  共用它」，新计数器加进同一趟遍历，不得多读一次 journal）。
- **溢出策略：节点级拒绝**，新增错误码 `AgentBudgetExceeded`（加进
  `engine/errors.ts:41-76` 的 `WorkflowErrorCode` 联合）。
  判定依据是既有惯例而非方案原文：`agent().ask()` 返回 `Node<T>`，它是 `PromiseLike`
  （`dts.ts:20-23,38-46`），**脚本有 catch 通道**，因此按 `artifact-caps.ts` 的内容成员先例走
  节点级拒绝，而不是按 `report-caps.ts` 的 void 先例走 failRun。
  > 与方案 D2 原文「超限结算 failed」的偏离在此明确记录：方案原文是在
  > 「`parallel()`/`pipeline()` 显式报错」的语境下写的，而当前脚本面的真实 catch 通道存在，
  > 节点级拒绝既显式（抛结构化 `WorkflowError`，不静默截断）又给作者留了收尾机会
  > （`catch` 后仍可 `report()` 已完成的部分——这正是 `report` 存在的意义，见 `dts.ts:75-100`
  > 对「run 死在第 12/40 个任务上，前 11 个的成果靠 reported items 活下来」的说明）。
  > 若实现 PR 判定必须 failRun，须在本小节写明理由并同步改验收场景 2。
- **不落 `stopped`**：预算耗尽不是「被停下可 resume」的语义（`RunStopReason` 五值
  `user|model|provider|interrupted|superseded`，`types.ts:466`，没有一个表达预算），
  因此走节点级 `WorkflowError`；只有脚本没 catch 而让它冒到顶层时，才由既有路径结算
  `errored`（`engine-settlement.ts:66-73`），journal 的 `failure_json` 带
  `code: "AgentBudgetExceeded"`——这就是方案要求的「原因入 journal」。
  > **实现记录（2026-09-29，D2 P1）**：上一句的「既有路径」需要一处补齐才成立。沙箱线形态
  > 本就携带 code（`protocol.ts` 的 `WireError`；`child-source.ts` 的 `__complete` 原样回带
  > name/message/stack/code/violations/finalText），但 harness 的 `complete{ok:false}` 分支
  > 此前把一切脚本顶层抛错**一律折成 `DriverError`**——码会丢，场景 1 的后半不成立。本项在
  > `harness.ts` 增加 `scriptThrowError` 归一：`code` 过 `isWorkflowErrorCode` 词汇表 guard
  > 的按**原码**重建（violations/finalText 同车），其余仍归 `DriverError`（普通脚本抛错的
  > 既有语义零回归，测试 H3 钉住）。guard 挡的是词汇表污染（脚本可自造 `e.code`，沙箱不是
  > 安全边界）：表外码归 DriverError（H4）；表内码与真拒绝不可区分，如实钉住（H4b）。
  > `details` 不过沙箱线（WireError 未加宽——`protocol.ts`/`child-source.ts` 不在本项
  > 所有权内，且 R3 已论证两道闸的恢复动作相同，脚本无需在 catch 里区分）：cap/actual/limit
  > 三个数在 message 文本里存活，`failure_json.details` 缺席（H2 钉住现状）。

### R3 fan-out 宽度保险丝（待决 ask 积压）

- **计数口径**：同一时刻「已创建未结算」的 ask 节点数，即 `scheduler.ts:46` 的
  `liveNodes`（`Map<string, AskNode>`，key 为 `siteId@ordinal`）中 `kind` 为 ask 的条目数。
  该表已存在且已在结算时清理（`scheduler.ts:508`），本保险丝**不新增状态**。
- **溢出策略：节点级拒绝**（同 R2 的论证：有 catch 通道），复用 `AgentBudgetExceeded`
  错误码但在 `details` 里区分 `limit: "pending"` vs `"total"`——两个限额共用一个码，
  因为脚本作者的恢复动作相同（收窄扇出）。
- **判定点**：ask 节点创建时（入 `liveNodes` 之前），不是派发时。派发闸
  （`scheduler.ts:398`）管速率、本闸管积压，两者不得合并——合并会把「同时跑几个」和
  「一共排了几个」耦成一个数字，retune 并发时意外改变积压上界。
- **绝不静默截断**：不得「只取前 K 个、其余丢弃」。`Promise.all` 的语义要求每个元素都有
  结果；静默截断会让脚本 await 一个永不结算的 promise。

### R4 token 预算硬顶（P2；2026-09-29 已落地，见本节末实现记录）

- **计量面已存在，不新建**：直接用 `engine.ts:218,615-625` 的 `spentTokens`
  （已落 `dwf_run.spent_tokens`、已广播 `usage-updated`、已跨 resume/amend 继承）。
  本项只加**阈值判定**，不改记账口径、不改事件字段。
- **阈值来源优先级**：run 创建时显式传入 > `BUDGET_CAPS.maxTokensPerRun` > 不设顶。
  显式传入的值必须落 journal（与 `caps` 同路，`types.ts:473` 的 `run-started` 事件已带 `caps`），
  resume 时从 journal 读回，**不接受调用方给的新阈值**——与 `engine.ts:318-320` 对 `args`
  的既有纪律同一条（「resume 从这里读回重放，绝不接受调用方给的新实参」）。
- **溢出策略：failRun**（`settleFailed`，`engine-settlement.ts:66-73`），新增错误码
  `TokenBudgetExceeded`。判定依据仍是既有惯例：token 累计**不在任何单次调用的返回通道上**
  （它是 `askStats` 结算后由引擎累加的，`engine.ts:615`），脚本没有 catch 通道，
  因此按 `report-caps.ts` 的 void 先例走 run 级失败。
- **判定点**：`spentTokens` 每次累加之后（`engine.ts:615-618` 之间），即**事后**判定。
  不做请求前预估——预估会把 provider 的 token 计数变成引擎的猜测，而既有记账是事实。
  事后判定意味着可能超顶一个 ask 的量，这是刻意的取舍（宁可不猜）。
- **观察面语义不变**：`usage-updated`（`types.ts:600`）仍是纯观察事件；设顶后它的字段不变，
  不因超顶而多发或少发。
  > **实现记录（2026-09-29，D2 P2）**：R4 已按本节落地，三处执行细节的精确化（均在本节
  > 规则边界内，测试 T1–T8 钉住）：
  > 1. **判定点的落位**：记账与判定住在 `engine-caps.ts` 的 `recordAskUsage`
  >    （`engine.askStats` 的方法体——engine.ts 抵 oxlint max-lines 门，按仓库既定拆分
  >    先例迁出，公开面不变）。顺序是载荷性的：累加 → `updateRunUsage` 落库 →（run 已
  >    结算则只记账早退）→ `usage-updated` 照发 → **然后**才比较阈值。本节「:615-618
  >    之间」与 R6「不因超顶而少发 usage-updated」以此调和：越过阈值的那笔累加照常上账、
  >    照常广播，run 级失败紧随其后（事件序 usage-updated → run-settled，T1 钉住）。
  > 2. **边界语义**：`spent > budget` 才越顶（严格大于，恰等不触发，T2 钉住）。
  >    `TokenBudgetExceeded` 不带结构化 details——`WorkflowError.details` 是
  >    AgentBudgetExceeded 两道闸的区分面（limit total/pending），token 闸自成一码、
  >    无歧义，不再给它造第二个词汇；累计与阈值两个数在 message 文本里。
  > 3. **阈值的装配与读回**：`EngineConfig.tokenBudget`（显式通道）优先于
  >    `caps.maxTokensPerRun`（载体成员），生效值 = 与 `BUDGET_CAPS.maxTokensPerRun`
  >    取更严（`creationCaps`；归一同处：非有限值与非正数按缺席、小数下取整——与
  >    `inheritedTokens` 同一条纪律）。落 journal 随**第一世** `run-started` 事件的 caps
  >    （零 SQL：生产仓储的 `dwf_run.caps_max_concurrency` 列只存并发，编解码器不持久化
  >    其余成员——事件是阈值唯一的持久化家）。resume 时 `resumedCaps` 从第一世
  >    run-started 读回，调用方本次带来的值**一律丢弃**（更松更严都算新阈值）；第一世没
  >    记录过阈值（本特性之前的老 run）时回落常量缺省——「缺席 = 用 BUDGET_CAPS 常量」
  >    与 Caps 成员同一条规则，只有常量本身不设顶时成员才缺席。amend 跨越：花费
  >    起账走既有 `inheritedTokens`（lineage 连续，T5 钉住判定基于 lineage 累计用量）；
  >    阈值在后继 run 缺省为常量，显式继承前驱阈值属于 run service 的装配面（bootstrap
  >    不在本项所有权内，未接线——引擎侧通道已就绪）。
  > 4. **harness 侧**：`RunWorkflowOptions.tokenBudget` verbatim 转交（与
  >    `inheritedTokens` 同规，不读不加工不推断）；P1 加的 `scriptThrowError` 归一随
  >    engine.ts 同款 max-lines 压力迁到 `dynamic-workflow-runtime/src/script-error.ts`
  >    （行为不变，T8 端到端钉住透传与码保真）。

### R5 resume / amend 的预算继承（三道一律 run 级连续）

- 三个计数器（ask 总数、token 累计）**跨 resume 与 amend 连续**，一律从 journal 恢复，
  恢复法与既有 `reportCount`（`engine.ts:355`）、`artifacts`（`engine.ts:358-361`）、
  `spentTokens`（`engine.ts:362`）、`inheritedTokens`（`engine.ts:308-309`）同法同处。
- **fan-out 宽度不继承**：它是「当前时刻」的量，resume 时在飞的 ask 由既有
  `recoverImportClosure` / `wasLiveBeforeResume` 路径重建（`engine.ts:364-369`、`:295-299`），
  新计数器直接读重建后的 `liveNodes`，不另立恢复逻辑。
- **反复 resume 不得刷新预算**：这是既有两处注释已经点明的攻击面
  （「否则一个反复 resume 的 run 可以无限报告」）。amend（`resumedFrom` lineage，
  `harness.ts:152-160,229`）同理：`inheritedTokens` 已经做了 token 的继承，ask 总数必须
  以同一姿态从**前驱 run 的 journal** 继承（若实现选择让 amend 起新账，必须在本小节写明
  并给出「amend 不是刷预算的后门」的论证——`imported-cache.ts` 的导入命中不产生新 ask，
  所以缓存命中的那部分工作天然不重复计费）。
  > **实现记录（2026-09-29，D2 P1）：amend 采用「按本 run 物化行起账」**。后继 run 的
  > `askTotalCount` = **它自己 journal** 里 `kind:"ask"` 的行数——导入命中物化的行计入、
  > 每行恰好一次，不叠加前驱计数。论证（本小节要求的「amend 不是刷预算的后门」）：
  > 1. **攻击面与闸门不重叠**：保险丝防的是脚本内的失控回环，而回环只能烧它所在的那个
  >    run；amend 是外部显式动作（`AmendWorkflow` 由主代理/用户发起，前驱被 supersede
  >    停掉），脚本侧没有任何代码路径能触发它——失控脚本无法自己刷新自己的预算。
  > 2. **继承法与「命中不重复计入」在行口径下互斥**：导入命中会在后继 journal 落**真行**
  >    （`importedAskRecord`，且这是链式修订的既有前提），若再叠加前驱计数，同一份工作
  >    必然被计两次（正是验收场景 5 禁止的）；要剔除就得给行加「导入物化」标记或另立
  >    事件——违反 R6「不新增 journal 写入路径 / 不做 migration」，并制造第二份真相。
  > 3. **刷新额度有界、且比继承法更严不更松**：重放到后继里的工作自己消耗预算——全命中
  >    amend 的可用额度 = 常量 − 物化行数，与继承法趋同；只有「新脚本明确跳过的工作」
  >    释放额度，而跳过意味着那些派发不会再发生。
  > 4. **主攻击面（同 runId 反复 resume）与本选择无关**：resume 一律按行数恢复（R2 恢复法），
  >    测试 A2/A3 钉住「连 resume 三次仍触发同一道闸」。
  >
  > token 面保持既有继承（`inheritedTokens`）不变：token 记的是「整条 lineage 花掉的
  > 钱」，ask 计数记的是「本 run 物化了多少行」——两个口径各自自洽。场景 5 的「同时
  > 成立」= 同一次 `resumedFrom` 配置下，token 起账（spentTokens 落前驱值）与 ask 闸按
  > 本 run 行判定并存（测试 D1 钉住：起账 1234 + 两条导入命中各计一次 + 第 3 条 fresh
  > 在 cap=2 处被拒）。
- **scriptHash 闸在前**：resume 的脚本一致性校验（`engine.ts:336-350`，不一致**同步抛出**
  而不是先接受再 failRun）先于任何预算恢复；预算恢复失败不得把 run 标成终态。

### R6 事件、落库与协议面不回退

- `run-started`（`types.ts:473`）与 `run-caps-changed`（`types.ts:582`）的既有字段
  （`runId` / `caps` / `previous`）**不回退、不改名**。`Caps`（`types.ts:119-121`）
  可**扩宽**为可选成员（例如 `maxAsksPerRun?: number`），使既有消费者不受影响；
  扩宽后 `setMaxConcurrency`（`engine.ts:579-589`）的「整份换掉 `this.caps`」必须保留
  其余成员，不得只写 `maxConcurrency` 而丢掉新成员。
- 新错误码进 `WorkflowErrorCode` 联合（`engine/errors.ts:41-76`）即进
  `WorkflowErrorJson` 的可序列化形态；跨包消费者（`packages/shared` v4 schema、UI 的 run
  失败展示）若枚举该联合，须同步（跨包公开入口纪律）。
- **不做 migration**：三个计数器全部由 journal 行派生，不新增 `dwf_run` / `dwf_node` 列
  （与 `types.ts:478,491` 的「零 SQL：锚点活在 journal 事件里，不在 dwf_run 列上（刻意不做迁移）」
  同一哲学）。token 已有的 `spent_tokens` 列是既有事实，不动。
- **journal 写入路径不新增**：计数器的持久化事实一律是既有的节点行/`updateRunUsage`，
  不为保险丝单开一张表或一条事件类型（`usage-updated` 已足够表达 token 面）。

### R7 不用超时掩盖、不绕引擎裁决

- 三道保险丝都是**确定性判定**（计数 vs 常量），不是超时。不得用「跑太久就杀」替代
  （根 `AGENTS.md`：不能用超时掩盖同步问题）。既有的墙钟超时（`harness.ts:24` 提到的
  harness 侧超时 → `engine.fail`）与本项正交，不合并。
- 触发保险丝时的 run 裁决仍归引擎：driver/harness 不得自行判定预算并直接写 journal
  （`harness.ts:348-349`：「run 的裁决归引擎所有，journal 与调用方看到的结果不分叉」）。

## 状态所有者

```
facade/budget-caps.ts（新）        BUDGET_CAPS 常量（数字的唯一所有者；纯包，无 I/O、不读时钟）
   │
   ├─► engine/engine.ts            askTotalCount（新字段，与 reportCount:207 / artifacts:216 /
   │      │                        spentTokens:218 同席；resume 恢复共用 :354 那一趟 listNodes）
   │      ├─ R2 总量闸：ask 节点创建前判 askTotalCount
   │      ├─ R4 token 闸：spentTokens 累加后判（:615-618 之间）
   │      └─ 落库：journal.updateRunUsage（:618，既有）／节点行（既有）
   │
   └─► engine/scheduler.ts         R3 积压闸：liveNodes（:46）现读，创建前判；
                                    派发闸（:398，caps.maxConcurrency）不动、不合并

engine/errors.ts:41-76             WorkflowErrorCode 词汇表（+AgentBudgetExceeded / +TokenBudgetExceeded）
engine/engine-settlement.ts:66-73  settleFailed（R4 的唯一 run 级失败出口；first-wins 由 isRunSettled 守）
engine/types.ts:119-121            Caps（可扩宽为可选成员，R6）
dynamic-workflow-runtime/harness.ts:176,218   inheritedTokens / caps 的 verbatim 转交（不加工、不推断）
journal（JournalStorePort）         持久化事实的唯一所有者；三个计数器全部由它派生（R6 不做 migration）
```

- **预算事实的所有者是 journal**，引擎内存里的计数器只是它的派生投影——崩溃/resume 后
  必须能从 journal 逐字节重建（R5）。
- **常量的所有者是纯包**，引擎与 driver 都从它读；测试断言同一份常量（三个既有 cap 模块的
  模块注释都把这条写成理由，本模块照办）。
- **run 裁决的所有者是引擎**；harness/driver 只转交与执行。

## 接口

- `dynamic-workflow/src/facade/budget-caps.ts`（新）：`export const BUDGET_CAPS`（R1）。
  经包公开入口再导出（与 `WORLD_READ_CAPS` / `REPORT_CAPS` / `ARTIFACT_CAPS` 同一出口）。
- `dynamic-workflow/src/engine/errors.ts`：`WorkflowErrorCode` 联合新增
  `"AgentBudgetExceeded"`、`"TokenBudgetExceeded"`（P2）。
  > **实现记录（P1）**：`"AgentBudgetExceeded"` 已落地；`"TokenBudgetExceeded"` 已随 P2
  > 落地（2026-09-29，均登记进 `isWorkflowErrorCode` 的穷尽码表）。
  > 同文件新增：`AgentBudgetDetails`（`{ limit: "total"|"pending"; cap: number; actual: number }`，
  > 即 `details` 的可序列化形态）与 `isWorkflowErrorCode`（词汇表的运行时 guard；
  > `Record<WorkflowErrorCode, true>` 码表让穷尽登记成为编译期义务——联合加码而漏登记
  > 直接 typecheck 失败）。`WorkflowError` / `WorkflowErrorJson` 增 `details?`
  > （toJSON/fromJSON 往返），与 guard 一起经 `engine/index.ts` 与包公开入口导出。
- `dynamic-workflow/src/engine/types.ts`：
  - `Caps`（`:119-121`）可选扩宽：`maxAsksPerRun?: number`、`maxPendingAsks?: number`、
    `maxTokensPerRun?: number`（缺席 = 用 `BUDGET_CAPS` 的常量；显式值只允许**更严**，
    与「只能收紧」的既有哲学一致，见 `managed-policy-floor-and-bypass-immune-breakers.md` R1）。
    > **实现记录**：三个成员均已落地（maxTokensPerRun 随 P2，2026-09-29）；生效值的归一
    > （更严方向取小、非有限按缺席、ask 两闸下限钳 1）在 `scheduler-types.ts` 的
    > `effectiveAskBudget`（每次判定现读 caps）与 `engine-caps.ts` 的 `effectiveTokenBudget`
    > （创建/resume 装配时一次成型，见 R4 实现记录）。
  - `EngineConfig` 新增 `tokenBudget?: number`（run 创建时显式传入，落 journal，R4）。
    > **实现记录**：已随 P2 落地（装配与读回在 `engine-caps.ts` 的 creationCaps /
    > resumedCaps）；ask 两闸不经 EngineConfig——计数由本 run 的 journal 行派生（R5
    > 实现记录），无需注入。
  - `WorkflowError` 的 `details` 允许携带 `{ limit: "total" | "pending"; cap: number; actual: number }`
    以便 UI 与日志说清是哪道闸（`errors.ts:90-115` 的现有形态）。
- `dynamic-workflow/src/engine/engine.ts`：新增私有 `askTotalCount`（与 `reportCount` 同姿态）；
  `setMaxConcurrency`（`:579-589`）保持只改并发、保留其余 caps 成员。
  > **实现记录（P1）**：构造期自留的 caps 副本同样必须带上两个可选成员（构造丢字段 =
  > 显式 caps 在第一次 retune 后静默失效）；判定与记账的执行点在 `scheduler.ts` 的
  > pendingLive 闭包（行创建前判、行创建的同一步记账），计数所有权在引擎
  > （`SchedulerHost.askTotalCount/countAskAdmitted`）。
  > **实现记录（P2）**：`setMaxConcurrency` 的方法体与 caps 装配（creationCaps/resumedCaps）、
  > 用量记账 + R4 判定（recordAskUsage）一并迁入新兄弟模块 `engine-caps.ts`（engine.ts 抵
  > max-lines 门，与 engine-settlement.ts 等同款拆分；类上留薄委托，公开面零变化），
  > `EngineState` 接缝相应扩宽（caps/applyCaps/pumpAll/noteStats/spentTokens/addSpentTokens）。
- `dynamic-workflow-runtime/src/harness.ts`：`RunWorkflowScriptOptions` 增
  `tokenBudget?: number`（verbatim 转交，与 `inheritedTokens:176`、`caps:94,218` 同规：
  harness 不读、不加工、不推断）。
  > **实现记录（P1）**：`tokenBudget` 当时随 R4 后置；P1 步 `RunWorkflowOptions` 无新字段
  > ——两道 ask 闸走既有 `caps` 通道（`Caps` 已扩宽，harness 照旧 verbatim 转交）。P1 对
  > harness 的改动只有一处：`complete{ok:false}` 的 `scriptThrowError` 归一——带词汇表内
  > code 的未捕获错误按原码重建，其余仍归 DriverError（见 R2 实现记录）。
  > **实现记录（P2）**：`RunWorkflowOptions.tokenBudget` 已落地（verbatim 转交
  > `EngineConfig`）；`scriptThrowError` 随 harness.ts 抵 max-lines 门迁到同包新模块
  > `script-error.ts`（线形态 ↔ 错误词汇表的边界翻译，行为不变）。
- **不新增 `ACODE_` 环境变量**：三个数字是契约常量，不做成 env 开关
  （`apps/acode-cli/AGENTS.md:21`：能用配置/常量表达的优先不做成环境变量）。
  若将来需要 per-run 覆盖，走 `EngineConfig` / harness options，不走 env。

## 验收场景

1. **总量闸触发**：构造一个会派发超过 `maxAsksPerRun` 个 ask 的脚本 → 第 N+1 个 ask 以
   `WorkflowError(code:"AgentBudgetExceeded", details.limit:"total")` 拒绝；脚本 `catch` 后
   `report()` 仍能落 journal；脚本不 catch 时 run 结算 `errored` 且 `failure_json.code`
   为 `AgentBudgetExceeded`（`engine-settlement.ts:66-73` 路径）。
2. **积压闸触发**：`Promise.all` 宽度超过 `maxPendingAsks` → 超出的 ask 以
   `details.limit:"pending"` 拒绝，**不被静默丢弃**；断言没有任何 promise 悬挂
   （脚本能在有限时间内结算）。
3. **resume 预算连续**：跑到接近上限 → 停（`stopped(interrupted)`）→ resume →
   计数器从 journal 恢复到停之前的值（不是从 0 起），再派发同样数量即触发闸；
   断言 journal 的 `kind:"ask"` 行数与引擎内存计数一致。
4. **反复 resume 不刷预算**：连续 resume 三次，每次都试图派发新 ask → 第三次仍触发同一道闸
   （回归 `engine.ts:207,216` 注释点明的攻击面）。
5. **amend 记账回归**：`resumedFrom` 路径下 `inheritedTokens` 起账（`engine.ts:308-309`）
   与 ask 总数继承同时成立；导入缓存命中的工作（`imported-cache.ts`）不重复计入 ask 总数。
6. **token 硬顶（P2）**：设 `tokenBudget` 后越过阈值 → `settleFailed(TokenBudgetExceeded)`；
   阈值落 journal 且 resume 读回原值、**拒绝**调用方给的新阈值（与 `engine.ts:318-320` 对
   `args` 的纪律一致）；不设顶时行为与改动前逐项一致（零回归）。
7. **事件字段不回退**：`run-started` / `run-caps-changed` / `usage-updated` 三个事件的字段集合
   在改动前后相同（新增可选 caps 成员不改变既有字段）；`setMaxConcurrency` 抬高并发后
   新 caps 成员仍在（R6）。
8. **不做 migration**：断言 schema/migration 目录无新增文件；三个计数器全部可由 journal 行
   派生（给一个空 journal + 若干节点行，重建出的计数与引擎一致）。
9. **常量单一来源**：引擎测试与 driver 测试都 import `BUDGET_CAPS`，无本地复制的数字
   （一条断言：测试文件里不出现与 `BUDGET_CAPS` 同值的字面量）。
10. **验证命令**（从仓库根执行，如实记录结果）：
    - `node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/dynamic-workflow/tsconfig.json --noEmit`
    - `dynamic-workflow-runtime` 的 typecheck 需先构建 `dynamic-workflow`
      （`pnpm --dir apps/acode-cli --filter @acode/dynamic-workflow build`，或按该包 pretypecheck 的等价步骤）
    - 测试入口以 `packages/dynamic-workflow/package.json` 与实际测试文件为准；
      engine 结算单测、resume 集成测试（journal 断言）、amend-resume 记账回归各一条。
    - `pnpm lint`（root，oxlint，期望 0 error）、`pnpm architecture:check -- --changed`（期望 0 violations）。

## 常量定值记录

> 实现 PR 填写。每行记：常量、定值、依据（现有脚本/workflow 的实测最大用量 × 安全倍数，
> 或其他可复核依据）。**未填写即视为定值无依据，PR 不得合入。**

| 常量 | 定值 | 依据 |
| --- | --- | --- |
| `maxAsksPerRun` | 4096 | （2026-09-29 实测）仓库内唯一现存 workflow 脚本 `.zcode/workflow-drafts/实施-CLI-调度与提示词升级方案.dwf.ts`（492 行，即本项实施所在 run 的编排脚本）有 17 个 `agent()` 调用站点——定值 ≈ 实测用量 × 240。代码库自己对「大 run」的设计规模参照是 2000 个 agent（`engine/types.ts` 的 `node-dispatched` 事件注释：「2000 个 agent 的 run 会在头几秒里把全部 actor-created / node-queued 发完」，读面表正是按它设计的）——定值 ≈ 设计规模 × 2。讲道理的脚本碰不到，失控回环仍在有限步内被停住（测试 E4 按常量实跑验证）。 |
| `maxPendingAsks` | 2048 | 同一实测脚本的同步扇出 join 最宽为 4（三处 `Promise.all`，宽度 3/2/4）。设计规模参照同上：2000-agent run「头几秒全部排队」⇒ 单 burst 积压可达约 2000，定值取覆盖它的 2 的幂。**不变式：严格小于 `maxAsksPerRun`**——否则 R3 永远不会先于 R2 触发，单 burst 的行洪峰（每条准入即落一行 running）失去独立刹车（测试 S1 钉住该不变式；E3 验证宽松显式值被常量压回）。 |
| `maxTokensPerRun` | 2000000000（2B） | （2026-09-29 实测）本机生产 journal（`~/.zcode/cli/db/db.sqlite`，只读查询 `dwf_run`）：已完结 run 的最大 `spent_tokens` = 121,264,599（9 个 ask），进行中 run 已达 115,643,265（15 个 ask，仍在增长）——实测单 ask 均价 ≈ 13M tokens（子代理是整段实现任务的重型会话）。计量口径：driver 每轮 turn 解析回报 `usage.totalTokens`（`workflow-driver-helpers.ts:187`），多轮 ask 逐轮累加，故数字远大于终态上下文。定值 ≈ 实测最大用量 × 16：重型 ask 有 ≈150 个任务的额度、轻型 ask（审阅/解析类，250K 量级）有 ≈8000 个的额度——轻型面先被 R2 的 4096 拦住、重型面由 R4 拦住，两闸互补；失控回环的最坏烧钱（4096 ask × 最坏 ≈30M/ask ≈ 123B）被截在 2B 量级。 |

## 不在本项范围

- **`parallel()` / `pipeline()` API**：当前脚本面没有它们（见「对方案 D2 原文的一处更正」），
  本项不引入。fan-out 仍由 analyzer 派生（`analysis/constants.ts:22`）。
- **速率控制**：`ConcurrencyController`（`engine/concurrency.ts`）与派发闸
  （`scheduler.ts:398`）不动、不与总量闸合并（R3）。
- **每 ask 的修复/nudge 预算**：`REPAIR_ATTEMPTS` / `NUDGE_ATTEMPTS`（`types.ts:941,944`）
  是单节点语义，本项不改。
- **旧 WorkflowGraphScheduler**：只动 dynamic-workflow；旧图调度不扩权、不新增能力
  （方案 §9 风险表）。
- **服务端配额 / 计费联动**：无服务端依赖产品面；三个数字全是本地契约常量。
- **上游机制的二次代码级核对**：方案 D2 测试段要求「实施前须对上游机制做二次代码级核对」
  （zoode 侧 R-5：并发帽/预算为产物确认但未经对抗复核）。该核对是**实施前置动作**，
  其结论回写本 spec 背景章，不在本 spec 的规则里。
