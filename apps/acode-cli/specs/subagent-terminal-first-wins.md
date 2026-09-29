# 子代理终态 first-wins：runtime task registry 的终态不可覆盖约定（D3 修正项 #3）

来源：`command-terminal-state-audit.md` 结论区问题 3（3a + 3b），登记为**修正项 #3**。
审计已确认「不变量缺失」，本 spec 定义修复后的产品规则、状态所有者与验收场景。

审计的原话（结论区 3a）：终态可被**双向**覆盖（实测 `completed`↔`killed`）；`waitForTerminal`
是 first-wins 而 `registry.get()` 是 last-wins，两通道分叉；且 `runner.ts` / `registry.ts`
全文没有 `first-wins` 字样、没有任何「谁是赢家」的约定文字，而对照物
`dynamic-workflow/src/engine/engine-settlement.ts:7` 既有约定又是同步原子守卫。

**本项不触及 R3 不变量**：不涉 CommandInbox 的锁序、三态分离、CAS、admissionSeq；
不重写 CommandInbox；不改 `dynamic-workflow/*`（只读引用它作为对照物）。

## 背景

### 已核实的现状（起草本 spec 时逐条读过，行号以当前检出为准）

#### 1. 原语层 `update()` 无任何终态守卫

`core/src/runtime-task/registry.ts:132-143`：

```ts
update(id, patcher) {
  const current = this.tasks.get(id);
  if (!current) return undefined;
  const next = patcher(current);      // ← patcher 想写什么就写什么
  this.tasks.set(id, next);           // ← 无条件覆盖
  this.resolveIfTerminal(id, next);
  this.resolveIfBackgrounded(id, next);
  return next;
}
```

同文件 `:103-110` 已定义 `TERMINAL_STATUSES`（`completed` / `failed` / `cancelled` /
`killed` / `stopped` / `lost`），`:284-286` 已导出 `isTerminalRuntimeTask`，
`:145-152` 的 `requestBackground` **已经**用它守门（`if (!task || isTerminalRuntimeTask(task)) return false;`）。
即：终态判据与守卫模式在同一个文件里都有先例，只有 `update()` 没有。

#### 2. 两条读通道的语义分叉

- `waitForTerminal`（`:197-204`）→ `resolveIfTerminal`（`:238-243`）→ `resolveWaiters`
  （`:256-270`）：**首次**结算即 `waitersByTask.delete(id)`，整组 waiter 一次性拿到当时的
  快照 → **first-wins**。
- `registry.get(id)`（`:160-162`）：直接读 `tasks` map，永远看到**最后一次** `update` 的结果
  → **last-wins**。

同一次停止/完成竞态里，等待方与轮询方可以读到两个不同的终态。

#### 3. 三处「读快照判终态 → await 真实文件 I/O → 写快照」

`core/src/subagent/runner.ts`：

| 路径 | 守卫 | 中间的 await | 写入 |
| --- | --- | --- | --- |
| `finalizeBackgroundCompletion` | `:1501-1502` | `:1504` `writeCompletedAgentArtifacts`（`mkdir` + `writeFile`） | `:1519` `registry.update(… status:"completed")` |
| `finalizeBackgroundFailure` | `:1580-1581` | `:1589` `writeFailedAgentArtifacts` | `:1600` `registry.update(… status:"failed")` |
| `createBackgroundStoppedTask` → `finalizeBackgroundStopped` | `:1666-1668` | `:1700` `writeStoppedAgentArtifacts` | `:1701-1705` `registry.update(… status:"killed")` |

守卫与写入之间的 I/O 是真实文件写，窗口客观存在；原语层不兜底，于是「谁先写谁输」——
后写者覆盖先写者。

#### 4. 对照物：workflow run 侧的 first-wins 是**同步原子**的

`dynamic-workflow/src/engine/engine-settlement.ts:7` 明写「first-wins 由 `isRunSettled()`
守在每条路径的第一行」，`:22-24`、`:41-48`、`:66-68` 三条终态路径的
`if (state.isRunSettled()) return;` 与 `state.markSettled(…)` **相邻且之间无 await**，
`:77` 明写「三条终态路径都经这里，所以 driver 的 dispose 恰好一次、first-wins 自然成立」。

子代理侧要达到同等强度，不必照搬 workflow 的 run-state 结构（那是 run 级、有 journal），
只需把「已终态的条目不得被另一个终态覆盖」这条判据收进**唯一的写入原语**——因为
`runner.ts` 的三处守卫与 I/O 交错是既有的产物写入结构，把 I/O 挪到写入之后会改动
artifact 与 registry 的先后契约（超出最小修复）。

#### 5. 必须不被新守卫误挡的既有写入（逐条核实过）

新守卫是加在 `update()` 里的，所以**所有** `update()` 调用方都要过一遍：

| 调用方 | 写入内容 | 是否改 status | 期望 |
| --- | --- | --- | --- |
| `runner.ts:340` 前台 completed | `status:"completed"` + output/usage | 是（→终态） | 受守卫（前台 race 三赢家互斥，正常不撞） |
| `runner.ts:389` 前台 failed | `status:"failed"` + error | 是（→终态） | 受守卫 |
| `runner.ts:1407` `createMessageSinkRegistration` | `messageSink` | 否 | **必须放行**（可能在终态后到达） |
| `runner.ts:1519` / `:1600` / `:1701` 三条后台终态 | 终态 | 是 | 受守卫（本项的修复对象） |
| `runner.ts:1881-1888` `enqueueBackgroundNotification` | `notified:true` | 否 | **必须放行**（认领令牌写在终态条目上） |
| `tool/executor/background-task-registry.ts:110` 晚挂载合并 | `status:"running"` + 身份面 | 是（终态→running） | **必须放行**（见下） |
| `background-task-registry.ts:127-147` `updateRuntimeBackgroundTask` | 终态/running | 自带守卫：`isTerminalRuntimeTask(current) ? current : {…}` | 不受影响（终态时 `next === current`） |
| `background-task-registry.ts:175-179` claim / `:189-191` release | `notified` | 否 | **必须放行** |
| `registry.ts:172-175` `queueMessage`（内部走 `update`） | `pendingMessages` | 否 | **必须放行** |

**重臂（resume 新生命）已确认走 `register` 而非 `update`**：
`background-task-registry.ts:84` 的 `newLife = rearm && existing !== undefined && isTerminalRuntimeTask(existing)`，
`:109-115` 只有 `existing && !newLife` 才走 `update()`；新生命剥掉继承的
`branchGeneration` 后走 `:115` `register(fresh)`，而 `register`（`registry.ts:118-126`）
直接 `tasks.set`，不经 `update()`。所以**重臂不被本守卫触及**。

`finalizeBackgroundStopped` 的**回滚**路径（`runner.ts:1712-1715`：通知未入队则
`registry.register(stopped.previousTask)` 后 throw）同样走 `register`，回滚能力不受影响。

## 产品规则

### R1 终态一经写下即为权威事实（first-wins）

**规则**：runtime task 条目进入 `TERMINAL_STATUSES` 之后，它的 `status` **不得**被另一个
终态覆盖。第一个写下终态的路径就是赢家；后到者读到赢家的快照，不改写它。

**为什么是 first-wins 而不是 last-wins**：终态是对外已经承诺过的事实——`waitForTerminal`
的等待方、`BackgroundTaskCompleted` 事件、模型通知都可能已经基于第一个终态发出。
后写者覆盖会让「已收到 completed 的等待方」与「随后 `get()` 到 killed 的轮询方」互相矛盾，
且无法回收已发出的通知。

**判据**：写入前后 `status` 都在 `TERMINAL_STATUSES` 内且**不相等** → 拒绝。

### R2 守卫落在原语层，不落在调用方

`InMemoryRuntimeTaskRegistry.update()` 是终态的**唯一**覆盖入口（`register` 是登记/重臂/回滚，
`remove` 是删除，`requestBackground` 已自带守卫）。把判据放这里，`runner.ts` 三处守卫与
文件 I/O 的交错窗口就都被兜住，不需要重排 artifact 写入顺序。

**拒绝时的返回值 = 当前（赢家）快照，不是 `undefined`**。理由：`undefined` 在本接口里的
既有含义是「条目不存在」（`:137`），调用方据此走 `task_missing` 分支
（例：`runner.ts:1533` 的 `if (task)`、`background-task-registry.ts:180` 的
`task === undefined ? true : claimed`）；把「写入被拒」也表达成 `undefined` 会让调用方
误判条目消失。返回赢家快照让后到者能读到权威终态并据此收口。

### R3 非终态写入与同终态写入一律放行

守卫**只**拦「终态 → 另一个终态」。以下必须继续可用（背景 §5 已逐条核实）：

- 不改 `status` 的字段写入：`notified` 认领/释放、`messageSink`、`pendingMessages`、
  `output`/`usage`/`resultText` 补齐。
- 终态 → 非终态：`background-task-registry.ts:110` 的晚挂载合并（Bash/Agent 的 task id
  一轮即弃，但 tracker 晚挂载会撞上已认领的终态条目）。本项**不改**这条既有语义。
- `register()`：首次登记、重臂（新生命）、`finalizeBackgroundStopped` 的回滚。

### R4 约定文字必须与守卫同处一地

对照 `engine-settlement.ts:7` 的表达强度：约定写在**被守的原语**上，不是写在某个调用方。
因此

- `registry.ts` 的 `update()` 注释明写「谁是赢家、为什么、拒绝时返回什么」；
- `runner.ts` 三处 finalize 守卫注释明写「本处守卫是快速路径（省掉无谓的 artifact I/O），
  真正的原子性由 registry 的 first-wins 兜底」。

只有代码行为、没有约定文字 = 审计判「未文档化」，下一次改动无从判断是否破坏它。

### R5 两条读通道必须一致

修复后 `waitForTerminal` 与 `registry.get()` 对同一条目报告**同一个终态 status**：
等待方拿到的是第一个终态快照，`get()` 因为覆盖被拒也停在同一个终态。
`resolveWaiters` 的 first-wins（首次结算即删除整组 waiter）是既有语义，本项不改它；
一致性由 R1 保证，而不是由改动 waiter 语义保证。

## 状态所有者

```
runtime task 终态事实        core/src/runtime-task/registry.ts
                              ├─ tasks: Map<id, RuntimeTaskSnapshot>（唯一存储）
                              ├─ update()（:132-152）——终态覆盖的唯一入口，first-wins 守卫在此
                              ├─ register()（:118-126）——登记 / 重臂 / 回滚，不经守卫
                              └─ terminalWaiters（:116）+ resolveWaiters（:256-270）——first-wins 的读通道

终态的产出方（三个，都不拥有事实）
                              core/src/subagent/runner.ts
                                ├─ finalizeBackgroundCompletion（:1494-）→ completed
                                ├─ finalizeBackgroundFailure（:1571-）→ failed
                                └─ createBackgroundStoppedTask（:1663-）+ finalizeBackgroundStopped（:1685-）→ killed
                              core/src/tool/executor/background-task-registry.ts
                                └─ updateRuntimeBackgroundTask（:118-148）——自带终态守卫

对照物（本项不改）           dynamic-workflow/src/engine/engine-settlement.ts:7,22-24,41-48,66-68,77
```

## 接口

本项**不新增对外接口**，只收紧既有原语的语义。签名不变：

```ts
// core/src/runtime-task/registry.ts
update(
  id: string,
  patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
): RuntimeTaskSnapshot | undefined;
// 返回值语义（本 spec 新增约定）：
//   undefined            → 条目不存在
//   next（≠ current）    → 写入生效
//   current（=== 传入前的快照）→ 写入被 first-wins 拒绝，返回的是赢家快照
export function isTerminalRuntimeTask(task: Pick<RuntimeTaskSnapshot, "status">): boolean;
```

调用方**不得**依赖「被拒」与「生效」的引用相等性做业务分流（那只是可观察的副作用）；
需要知道赢家是谁时读 `registry.get(id)`。

## 验收场景

1. **终态不可被另一终态覆盖（双向）**：条目为 `completed` 后 `update` 写 `killed` →
   `get().status === "completed"`；反向（`killed` → `completed`）同样被拒。
2. **并发方向也 first-wins**：两条 finalize 路径的「守卫 → await → 写入」交错时
   （守卫都通过，写入先后到达），最终快照是**先写者**的终态。
3. **两通道不再分叉**：场景 2 之后，`waitForTerminal` 的结算快照与 `registry.get()`
   的 `status` 相同。
4. **拒绝时返回赢家快照**，不是 `undefined`（R2）。
5. **非终态写入不被误挡**：在 `completed` 条目上写 `notified:true`、写 `messageSink`、
   `queueMessage` 追加 pendingMessages 都生效（R3）。
6. **重臂不被误挡**：终态条目经 `register()` 复位成 `running` 的新生命照常成立
   （`background-task-registry.ts:84,109-115` 的形状），且 `updateRuntimeBackgroundTask`
   在终态条目上仍返回 `current` 原样。
7. **晚挂载合并（终态 → running，走 `update`）不被误挡**（R3 第二条）。
8. **约定文字在案**：`registry.ts` 的 `update()` 与 `runner.ts` 三处守卫都能 grep 到
   first-wins 约定（R4）。
9. 测试文件：`apps/acode-cli/tests/subagent-terminal-first-wins.test.mjs`
   （`node --import tsx --test <文件>`，仓库根执行）。既有
   `apps/acode-cli/tests/subagent-terminal-race-ordering.test.mjs` 里「断言缺口存在」的用例
   随修复更新为「断言缺口已闭合」。

## 评审补强（2026-09-29）：finalizeBackgroundStopped 的输家分支

独立评审发现原语层守卫闭环后仍留有一个 runner 级窗口：`finalizeBackgroundStopped`
对 `registry.update` 的返回值不做判定，写入被拒（child 在 `writeStoppedAgentArtifacts`
的 I/O 窗口内抢先完成）时仍继续 `enqueueBackgroundNotification`，且 enqueued=false 时走
`register(stopped.previousTask)` 回滚。后果：(a) 赢家已认领 notified 时，回滚用陈旧
running 快照无条件覆盖赢家的 completed 终态并 throw——`register()` 不经守卫，registry
停在 running，`waitForTerminal`（已结算 completed）与 `get()` 分叉，构成 R5 反例；
(b) 赢家未认领时，给实际 completed 的任务发「已停止」通知。双重 stop 交错
（killed-over-killed，两侧 status 相等、守卫不拒）同形。该窗口为修复前既有行为的延续，
非守卫引入的回归；「不在本项范围」中对 `register()` 的排除（不加守卫）维持不变——
本补强收敛的是**调用方对输赢的判定**，不是 register 语义。

**规则（R6）**：`finalizeBackgroundStopped` 的 patcher 在写入前自查条目是否已终态
（含 killed-over-killed），已终态则原样返回赢家、不置 `stopCommitted`；`stopCommitted`
为 false 时函数立即返回赢家快照（条目被移除时返回 undefined）——不发停止通知、
不走 `register(previousTask)` 回滚、不发 stopped 事件。`register` 回滚仅保留给
「停止快照确已提交、但通知入队失败」的撤销场景（其原有语义）。

**验收场景 10**：runner 级交错三例——① 停止路径 I/O 窗口内 completion 抢先（赢家已认领
notified）：`stopTask` 返回赢家 completed、零通知入队、registry 不回滚；② 同①但赢家
未认领：仍零通知（认领留给赢家自己的路径）；③ 双重 `stopTask` 并发：仅一条停止通知，
两次调用都返回 killed，registry 停在 killed+notified。测试落在
`apps/acode-cli/tests/subagent-terminal-first-wins.test.mjs` 的 (9) 组用例。

## 不在本项范围

- **CommandInbox**：锁序、三态分离、CAS、admissionSeq 一律不动（审计 R3 不变量）。
  CommandInbox 侧的约定文字归修正项 #4（`command-terminal-state-audit.md` §B）。
- **`dynamic-workflow/*`**：只读引用 `engine-settlement.ts` 作对照物，不改一行。
- **重排 artifact I/O 与 registry 写入的先后**：审计给的另一条备选（「在 runner 三处把
  判+写收进一次同步 patch、把文件 I/O 移到写入之后」）会改动「产物先落盘再对外宣布终态」
  的既有契约，风险大于收益；本项选原语层守卫。
- **`register()` 的无条件覆盖**：它是登记/重臂/回滚的入口，覆盖是它的语义。给 `register`
  加终态守卫会直接打死重臂与回滚（背景 §5）。
- **附带核验 (d)「快照 lost + 事件 completed」**：审计已遍历 4 处 `registry.remove`
  未找到可达产出方，按 R3 登记为未确认，本项不处理。
- **前台 race 三赢家**（`runner.ts:309-316`）：`Promise.race` 互斥，审计判无竞态，本项不改。
