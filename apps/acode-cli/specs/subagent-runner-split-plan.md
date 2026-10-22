# Subagent runner 拆分前置条件与方案（P2，2026-10-22 review）

状态：**未执行，登记前置条件与拆分方案**。2026-10-22 review cli-core-structure.md §2 P2 点名
`packages/core/src/subagent/runner.ts`（2599 行、靠头注 `max-lines` 豁免）职责过载，建议按
「前台生命周期 / 后台生命周期 / registry / notification 顺序」拆内聚模块、每模块 <400 行、移除豁免。
runner.ts 头注本身即写明前置条件：「拆分前需要先稳定生命周期边界」。

## 为何本轮不硬拆（核实结论）

任务要求「行为必须完全不变：纯结构拆分」。核实后判断**生命周期边界仍不稳，现在拆会改变行为**，
按任务的逃生舱（「若核实后判断生命周期边界仍不稳、拆分会改变行为，不要硬拆」）登记而不硬拆：

1. **边界正在活跃变动**：`git log --since="90 days ago"` 显示 runner.ts 近 90 天 8 次提交，且集中在
   生命周期核心区（background 三态语义 9bb37a47、terminal-first-wins c453fca5、声明键批②
   cce1b4b7、AgentTeams 派生配置嫁接 26671951、注入防御 4d89373f）。这些正是拆分要切开的
   前台/后台生命周期与 notification 顺序本身——边界的形状还在被功能改动推着走。
2. **头注前置条件未满足**：runner.ts:1 明写「拆分前需要先稳定生命周期边界」。在 8 次/90 天的
   churn 下，「稳定」不成立；此刻冻结模块边界会与在飞功能改动直接冲突。
3. **拆分不能只做一半**：runner.ts 是 50 个模块级函数（无共享可变状态，叶子纯函数簇如
   usage 聚合 / artifact 写入本可安全抽出），但纯叶子抽取只能减约 300–500 行，**达不到 <400 行
   的验收线**（2599 → 仍 >2000），却要引入 import 重排与 churn 风险——净负收益，且 `max-lines`
   豁免无法移除。要真正达标必须切开生命周期核心，而那正是当前不稳的部分。

结论：拆分的前置条件（生命周期边界稳定）未满足。硬拆会触碰正被功能改动推着走的边界，
无法保证「行为完全不变」；半拆（仅叶子）达不到验收线反而增加风险。故本轮**登记不拆**。

## 前置条件（满足后方可启动拆分）

- **P1 收敛完成**：`RuntimeTurnState` 剩余字段与「原型注入换显式组合」的长期方案
  （见 `runtime-state-ownership.md` §RuntimeTurnState 剩余字段与后续批次）落地。runner 的
  前台/后台生命周期通过 subagentPort 与 runtime turn 编排耦合；turn 时序状态所有权未收敛前，
  runner 的模块边界会随 `this` 面漂移，切出来的接口不稳定。
- **生命周期 churn 回落**：background 三态、terminal-first-wins、声明键、AgentTeams 嫁接等
  活跃特性收口，runner.ts 近 N 周提交趋于 0（可用 `git log --since` 量化），头注「稳定生命周期
  边界」的前置条件成立。
- **行为测试补齐**：拆分前先补/确认覆盖前台生命周期、后台生命周期、registry 终态守卫、
  notification 顺序四域的关键行为测试。现状：`tests/subagent-terminal-first-wins.test.mjs`、
  `subagent-background-tristate.test.mjs`、`subagent-terminal-race-ordering.test.mjs`、
  `subagent-pending-message-drain.test.mjs`、`subagent-completion-notification-summary.test.mjs`
  已覆盖 registry 终态守卫与 notification first-wins 顺序（本轮实跑 39/39 绿）；前台/后台
  生命周期分界与 watchdog/auto-background timer 的直接单测覆盖需在拆分批次补齐。

## 拆分方案（前置条件满足后执行，行为不变的纯结构拆分）

按内聚域拆为 4–5 个模块，每模块 <400 行，runner.ts 只留 `createExploreSubagentPort`
装配壳与跨域编排；移除 `max-lines` 头注豁免：

| 目标模块 | 迁入的现有函数（runner.ts 行号） | 域 |
| --- | --- | --- |
| `subagent/foreground-lifecycle.ts` | `createSubagentLifecycle`(:972)、`createSubagentLifecycleFromTask`(:1021)、`sendMessageToLocalAgent`(:1072)、`deliverMessageToRunningAgent`(:1110)、`createRuntimeTaskPendingMessage`(:1234)、`createSendMessageSuccess/Failure`(:1251,:1273) | 前台生命周期 |
| `subagent/background-lifecycle.ts` | `runBackgroundAgent`(:1667)、`resumeTerminalAgentInBackground`(:1121)、`createSubagentActivityWatchdog`(:1529)、`createAutoBackgroundTimer`(:830)、`normalizeAutoBackgroundMs`(:823)、`createSubagentTaskAbortController`(:789)、`guardSubagentPromiseWithAbort`(:1608)、`createSubagentSessionReadyGate`(:1718) | 后台生命周期 |
| `subagent/background-finalize.ts` | `finalizeBackgroundCompletion/Failure/Stopped`(:1838,:1922,:2043)、`createBackgroundStoppedTask`(:2014)、`createAgentBackgroundedOutput`(:1820)、`withoutRuntimeMessageState`(:1815)、`createRuntimeTaskSnapshot`(:1788) | registry 终态结算 |
| `subagent/notification-order.ts` | `enqueueBackgroundNotification`(:2203)、`emitBackgroundTaskCompletedEvent`(:2114)、`emitRuntimeTaskBackgroundCompletedEvent`(:2143)、`emitRuntimeTaskSubagentStoppedEvent`(:2174)、`emitSubagentEvent`(:2282)、`createMessageSinkRegistration`(:1745)、`flushPendingMessages`(:1759)、`traceContextFromRuntimeTask`(:2271) | notification 顺序 |
| `subagent/agent-artifacts.ts` | `writeCompleted/Failed/StoppedAgentArtifacts`(:2341,:2358,:2370)、`writeAgentOutputFiles`(:2399)、`writeAgentMetadataFile`(:2407)、`wrapStartupMetadataWriteFailure`(:2455)、`writeTextFile`(:2596) | artifact 落盘（纯叶子，可先拆） |
| `subagent/usage-aggregate.ts` | `aggregateModelUsage`(:2480)、`resolveSubagentToolUseCount`(:2499)、`addUsage`(:2529)、`addOptionalUsageNumber`(:2547)、`resolveTotalTokens`(:2564)、`isRecord`(:2577) | usage 聚合（纯叶子，可先拆） |

拆分纪律（保证行为完全不变）：
- 纯移动，不改任何函数体、签名、调用顺序；跨模块调用改 import，不新增/删除逻辑分支。
- `BACKGROUND_AGENT_STOPPED_STATE`(:2006) 等模块级常量随其消费函数迁移，保持单一所有者，不建第二份。
- profile/allowedTools 解析（`resolveAgentProfileForRequest`:871、`resolveAllowedTools`:2581 等）留
  runner.ts 或随前台生命周期迁，视 import 图最小化决定。
- 每拆一个模块跑一次上列 subagent 测试 + core 包 typecheck，逐步收敛；全部拆完移除 `max-lines` 豁免，
  跑 `npx oxlint apps/acode-cli/packages/core` 确认 0 error 且无 max-lines 告警。
- 纯叶子两簇（`agent-artifacts`、`usage-aggregate`）耦合最低，可作为拆分批次的**第一步先行验证**
  移动纪律（跑绿即证行为不变），再动生命周期核心。
