# 子代理拓扑持久化 + 崩溃恢复（编排方案 Phase 1 / ①）

来源：[`docs/codex-orchestration-integration-plan.md`](../../../docs/codex-orchestration-integration-plan.md) §4 Phase 1，
经 2026-10-10 对照审计（[`docs/codex-orchestration-plan-audit-2026-10-10.md`](../../../docs/codex-orchestration-plan-audit-2026-10-10.md)）
复核后按当前检出实施。审计带来的两处方案修订已吸收：迁移编号 **0030**（0028/0029 已被
`c453fca` 的 workflow-run-owner 族占用）；`session-store.port.ts` 契约面已因
`claimWorkflowSessionOwner` 破例，但本 spec 仍沿用 swarm 的「不进 contracts」纪律（理由见
「未做与取舍」#2）。

参照机制：Codex `agent-graph-store`（SQLite parent→child 边表，进程重启后恢复 agent 树元数据）。
只搬运机制设计，不复制源码。

## 背景（已核实的现状，行号以 dev/0.0.7 @ 372f40f 为准）

- agent 树是**三处投影合成**、无独立持久拓扑表：`SessionInfo.parentID` 链
  （`core/src/runtime/methods/events.ts:591` 写入）+ 父会话 `SubagentSpawned/Stopped` 事件 +
  **纯内存** `RuntimeTaskRegistry`（`core/src/runtime-task/registry.ts:19`
  `InMemoryRuntimeTaskRegistry`，每 runtime 一份）。
- 事件默认只进内存：`emitParentEvent → appendEvent`（`core/src/runtime/methods/subagent.ts:79-81`
  的 port 选项闭包），事件存储缺省 `createInMemorySessionEventStore`
  （`bootstrap/src/app/create-app.ts:765`、`bootstrap/src/acode-protocol/server.ts:249`）。
- 崩溃后 durable 痕迹只剩：Agent tool part（launch ACK）、metadata sidecar、子会话
  session/message/part 行；后台子代理目录整体靠合成层兜底终态 `"lost"`
  （`bootstrap/src/acode-protocol/subagent-session-query.ts:373`）。
- 命令队列纯内存（`core/src/runtime/methods/background-notifications.ts:61-63` 注释原文）；
  resume 清扫把残留 admitted 收口为 `discarded(session_resumed)`
  （`core/src/runtime/methods/steering.ts` `discardPersistedPendingSteerInputs`，
  调用点 `core/src/runtime/methods/resume.ts:246`）。
- 崩溃后无任何东西自动拉起 Agent 子代理（对照 dwf：`dwf-journal.ts` `listNonTerminalRuns` +
  `dynamic-workflow-run-reconcile.ts` 孤儿收敛）。
- 事件发射**单点**：`core/src/subagent/runner.ts:1938` `emitSubagentEvent`，八个发射点全经它
  （:236/:354/:399/:482/:1025/:1547/:1627/:1777），payload 字段足够铸边。
- 既有模板全部健在（审计逐条核实）：migration `0026-swarm-plan-row.ts` 形状、
  `repositories/swarm-plans.ts` 纯函数仓库、`core/src/swarm/runtime-binding.ts` duck-typing
  能力探测（三方法全有或全无、缺席降级不伪装成功）、`migration-runner.ts:301-315` 历史不可变。

## 产品规则

**R1 边表是拓扑权威，不是运行态权威。** `subagent_edge` 表（每 agentId 一行）是**事后审计 /
UI 冷恢复**的拓扑事实源；**运行态**（messageSink、pendingMessages、waiters、branchGeneration、
isBackgrounded 等）永不进表，其唯一所有者仍是 `RuntimeTaskRegistry`。边表**不是准入判定源**：
派发准入、权限、计费判定一律不读边表（方案 §7③ 取舍：准入判定不能是同步查库阻塞点，且持久
谱系与在飞树在 resume/fork 下会不一致）。

**R2 写入单点。** 边的唯一铸造路径是 `emitSubagentEvent` 钩子（八个发射点天然全经它）：
- `SubagentSpawned` → **upsert**（插入或整行重置为 `running`，清空终态字段——resume 重臂
  复用同一 agentId，重臂是合法的新生命，对齐 registry `register()` 重臂语义）；
- `SubagentStopped` / `BackgroundTaskCompleted`（taskKind=subagent 且 status 为终态）→
  **settle**（终态 **first-wins**：当前行已是终态则拒绝覆盖，对齐
  `specs/subagent-terminal-first-wins.md` 的 registry 纪律；行缺失时允许直插终态行）。

**R3 失败语义：边写入永不影响代理执行。** 钩子内部 catch + `logger.warn`（可恢复异常），
事件发射与代理运行照常。持久化能力缺席（测试替身 / 未来远程 store 未提供该方法）→ 整链
按「无持久化」降级，读侧回退既有事件/工具部件合成，**不伪装成功**（swarm runtime-binding
探测纪律）。

**R4 崩溃收敛。** session resume 时（挂 `resume.ts` 既有清扫点旁），把该父会话的全部
`status='running'` 边一次性收口为 `lost`，`error="session_resumed"`、`ended_at=now`——对齐
合成层既有 `lost` 语义与命令队列 `discarded(session_resumed)` 先例。收敛**只动 running**
（幂等；终态行不可触碰）。收敛不是自动拉起：不 respawn 任何子代理（R6）。

**R5 读侧优先序。** 合成层（`projectSessionSubagents`）新增可选 `edges` 输入，终态判定
优先序：**live 源（background task / child projection）> tool part error（已记录的失败
事实；launch 失败场景多半无边行，两者几乎不相交）> 边表终态 > 事件合成（stoppedStatus）>
state/output/childOutcome 兜底**。边表的 `running` 不构成 live 事实（崩溃残留由 R4 收敛
负责），且**抑制后台候选的乐观 running 推断**——残留边收敛为 lost 后，冷目录必须呈现
ended(lost) 而非「可恢复的 running」；`childSessionId` 恒等式 `createSessionId("subagent_"+agentId)`
保留为最后兜底（`runner.ts:807` ↔ `subagent-session-query.ts:183` 两侧同一规则）。
`collectSubagentChildSessionIds` 合并边表 child_session_id（工具部件缺失/不可解析时边表兜底）。

**R6 不自动拉起。** 崩溃后边表只提供「真实终态可恢复」，不提供「继续执行」——Agent 子代理
没有 dwf 那样的 journal replay 语义，自动 respawn 会造成重复副作用。恢复执行走既有
`resumeTerminalAgentInBackground` 用户/模型显式路径。

**R7 迁移边界。** `0030-subagent-edge.ts`（头注 + `export const *_MIGRATION_SQL`，注册进
`SQLITE_MIGRATIONS`，appVersion 随当前系列 "0.16.9"）。**无 down migration**
（`migration-runner.ts` 强制历史不可变；回滚 = 旧代码不读不写该表）。**不加 FK**
（0019 纪律：子会话可能无 session 行，FK 会挡合法记录）。

**R8 不进 contracts。** `SessionStorePort` 不新增任何 subagent edge 方法；core / bootstrap
经结构化 duck-typing 消费 `SqliteSessionStore` 的委托方法（swarm K4 先例，三方法全有或全无）。

**R9 状态词表。** 边 `status` 复用 registry 词表：`running` + 终态集
`completed/failed/cancelled/killed/stopped/lost`（`runtime-task/registry.ts:10-17`）。
未知状态词在派生层丢弃（debug 日志），不入库。

## 状态所有权

| 状态 | 唯一所有者 | 其他层如何访问 |
| --- | --- | --- |
| 拓扑事实（边：谱系/终态/计量） | `subagent_edge` 表（adapters repository 唯一读写面） | store 委托方法 → duck-typing 绑定 |
| 运行态（sink/queue/waiter/后台标志） | `RuntimeTaskRegistry`（内存，不变） | 既有 contract |
| 实时事件流 | session event store（不变，缺省内存） | 既有 appendEvent |
| 目录/投影呈现 | `projectSessionSubagents` 合成层 | edges 是其输入之一（R5 优先序） |
| 写入触发 | `emitSubagentEvent` 单点钩子 | — |
| 收敛触发 | session resume（`resume.ts` 单点） | — |

## 接口

**表** `subagent_edge`（14 列，方案原样）：`agent_id text primary key, parent_session_id text
not null, child_session_id text, agent_type text, parent_tool_call_id text, description text,
background integer not null default 0, model text, output_file text, status text not null,
started_at integer, ended_at integer, total_tokens integer, error text` +
`subagent_edge_parent_idx on (parent_session_id)`。

**repository**（`adapters/src/storage/session-store/repositories/subagent-edges.ts`，纯函数 +
db 第一参，照 swarm-plans 形状；写路径 `touchSession` 对齐先例）：
- `upsertSubagentEdge(db, input)` — 插入或整行重置（R2 spawn/重臂）；
- `settleSubagentEdge(db, input)` — 终态 first-wins（SQL `where` 守卫，R2）；
- `listSubagentEdges(db, { sessionID })` — 按父会话列边（读侧/审计）；
- `listSubagentDescendants(db, { sessionID })` — 递归 CTE 沿
  `parent_session_id → child_session_id` 展开整棵子树（depth 上限 32 防腐坏行成环；
  Codex `list_thread_spawn_descendants` 对位物，验收「descendants 可查」）；
- `convergeNonTerminalSubagentEdges(db, { sessionID, now })` — running → lost（R4）。

**store 委托**（`sqlite-session-store.ts`，写方法过 `throwBeforeWrite()`）：
`readSubagentEdges / upsertSubagentEdge / settleSubagentEdge / listSubagentDescendants /
convergeSubagentEdges`。

**core**（`core/src/subagent/edge-persistence.ts`，新文件 ≤400 行）：
- `bindSubagentEdgePersistence(store: unknown)` → 能力面全有或全无，缺席返回 `undefined`；
- `subagentEdgeCommandFromEvent(type, request, payload)` — 纯函数，事件 → 边命令
  （防御性读 payload 字段，R9 词表校验）；
- `convergeSubagentEdgesOnResume(store: unknown, input)` — resume 收敛的 duck-typing 入口。

**runner**：`ExploreSubagentPortOptions.persistSubagentEdge?: (command) => Promise<void>`；
`emitSubagentEvent` 内在发射事件**之前**执行边持久化（durable 优先；失败按 R3 吞掉）。

**bootstrap**：`readPersistedSubagentEdges(store: unknown, sessionID)`（本地探测，query 文件内）；
`ProjectSessionSubagentsInput.edges?: readonly PersistedSubagentEdge[]`；两个调用方
（`server-operations.ts listSessionSubagents`、`app/subagent-observation.ts`）加载并传入。

## 事件顺序与幂等

```
spawn:   onSessionReady → upsert(running) → emit SubagentSpawned
settle:  emit 前 → settle(终态, first-wins) → emit SubagentStopped / BackgroundTaskCompleted
resume:  hydrate → discardPersistedPendingSteerInputs → converge(running→lost) → SessionResumed 事件
重臂:    resumeTerminalAgentInBackground → onSessionReady → upsert 重置 running（合法覆盖终态）
崩溃窗:  upsert 与 emit 之间进程死亡 → 边在（durable）、事件丢（内存）→ 读侧仍有拓扑事实；
         emit 后 settle 前死亡 → 边停 running → 下次 resume 收敛为 lost（真实终态不可知，诚实标注）
```

幂等键 = `agent_id`。重复 settle 被 first-wins 守卫吸收；收敛幂等（只动 running）；upsert
天然幂等。多进程并发写同一 db 由 SQLite WAL 串行化（单语句 upsert，无读-改-写窗口）。

## 验收场景

1. 迁移后 `subagent_edge` 表存在、14 列齐、无 FK、有 parent 索引；`SQLITE_MIGRATIONS` 含
   `0030_subagent_edge`；无 down。
2. Spawned 事件派生 upsert：谱系字段（agentId/parentSessionId/childSessionId/agentType/
   parentToolCallId/description/background/model/outputFile）与 payload 对齐，status=running。
3. Stopped(completed/failed) 派生 settle：终态 + ended_at + total_tokens/error 落行；
   同一 agentId 第二个终态被拒（first-wins）；resumed spawn 重臂重置为 running 并清空终态字段。
4. resume 收敛：running 边 → `lost` + `error="session_resumed"`；终态边不动；无持久化能力时
   静默跳过。
5. 能力缺席（store 无委托方法）：绑定返回 undefined，写入/收敛/读取全链降级零报错，
   合成层行为与今天逐字节一致。
6. 冷恢复端到端：kill 进程重启后 `listSessionSubagents` 的 ended 列表从边表恢复真实终态
   （completed/failed 不再兜底成 lost）；`listSubagentDescendants` 返回整棵子树。
7. 边写入抛错（模拟 store 故障）：事件照常发射、代理照常运行、warn 留痕。
8. 负向断言（不变量守护，仿 no-telemetry 模式）：contracts 的 `SessionStorePort` 无
   subagent edge 方法；repository 不 import core；全仓无任何准入/权限路径读 `subagent_edge`；
   `subagent-edge` 相关新文件不出现 `down` migration 词样。

## 未做与取舍

1. **不自动拉起崩溃残留子代理**（R6）：Agent 无 journal replay 语义，respawn = 重复副作用。
   边表把「不可恢复」从「无从知晓」升级为「诚实标注 lost + 可查谱系」。
2. **不进 contracts**：`claimWorkflowSessionOwner` 已破例（审计 A2），但那是跨进程 owner
   lease 的端口级语义；边表是单 store 的投影存储，swarm duck-typing 纪律更贴合。若未来远程
   store 需要边能力，再按先例升格进 port。
3. **不复用 `session_task_link`**（方案 §7①）：workflow 域表、FK 指向 legacy `workflow_run`、
   无枚举读取方；新表语义专属。
4. **不建事件序号/journal**：边表是**状态表**非事件日志，upsert 幂等已覆盖并发；dwf 的
   `max(sequence)+1` 纪律适用于 append-only 事件流，不适用。
5. **运行态不进表**（R1）：进表即制造第二事实源，违反「唯一所有者」纪律。
