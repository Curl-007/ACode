# 并发治理面只读诊断投影（D5）

调度主线 P2 项（方案文档 `docs/cli-dispatch-and-system-prompt-upgrade-plan.md` 第 3 章 D5）。
并发上限今天分散在四个互不相识的域里，没有任何一处能回答「这个会话此刻的并发治理事实是什么」。
本 spec 定义一个**只读诊断投影**：各调度器向 runtime 暴露统一的 `caps / current / degraded`
快照，供 debug 日志与文档引用；参数调整权留在各域。

**明确否决**（方案文档已裁定，此处登记为规则）：全局信号量统一 admission——三域语义不同
（turn 内 / run 级 / 会话级），统一会破坏 CommandInbox 与 owner/lease 边界（治理红线：
不能仅按单一路径删边界判断）。本项**不引入任何调度决策变化、不引入全局信号量、不新增写入路径**。

## 背景：四个并发域的现状（已核实）

| 域 | 上限事实 | 载体 | 备注 |
| --- | --- | --- | --- |
| tool scheduler | `DEFAULT_MAX_CONCURRENCY = 10`（`core/src/tool/scheduler.ts:48`），可配 `config.toolConcurrency?.maxConcurrency`（`core/src/runtime/agent-runtime.ts:253`） | turn 内并行组分组 | 调度是纯函数（`schedule()` 返回分组），执行在 executor 的 batch-runner；scheduler 自己不跟踪在飞数 |
| dynamic-workflow | run 级 `Caps.maxConcurrency`（`dynamic-workflow/src/engine/engine-caps.ts`）+ 进程级 AIMD 自适应控制器（`dynamic-workflow/src/engine/concurrency.ts`：降 0.75 倍、连成 4 次 +1、地板 1、空闲 300 s 重置），治理器按 provider key 分桶（`bootstrap/src/app/workflow-concurrency-governor.ts`，进程级单例 `:356-367`） | run 级 + 进程级 | 主 runtime 经 `deps.modelRequestAdmission = governor.observer()` 挂到治理器（`bootstrap/src/app/create-app.ts:750`）；`ConcurrencyController.snapshot()` 只读快照已存在（`concurrency.ts:88-103`） |
| Plan 模式 Explore | `planResearchAgentCount = 3`（`core/src/runtime/helpers/runtime-reminders.ts:24`） | **提示词层纪律**（Plan Workflow 文案），不是运行时信号量 | 投影必须如实标注「非强制」，不得让读面误以为存在硬闸 |
| subagent 后台 | **无显式上限**（全仓 grep 无 background 并发 cap；`MAX_BACKGROUND_RESULT_TITLES = 3` 是通知标题条数，非并发） | 会话级 registry 事实：`RuntimeTaskSnapshot.isBackgrounded`（`core/src/runtime-task/registry.ts:48`） | 实际并发受模型请求准入与 provider 配额间接约束 |

既有的只读投影先例：`getActiveTurnInfo()`（`core/src/runtime/methods/config.ts:124-134`）——
同步、纯读、供协议/调试面消费；debug 级本地日志先例：`context_usage_snapshot`
（`core/src/runtime/methods/context-usage.ts:45-57`，每模型请求一条，`model.ts:139`）。

## 产品规则

### R1 统一快照形状：caps / current / degraded

每个域投影成同一个形状（`ConcurrencyDomainSnapshot`）：

- `caps: number | undefined`——该域当前生效的并发上限；**`undefined` = 该域无显式上限**
  （不得用 `Infinity`/`-1` 之类的哨兵值伪造数字）。
- `current: number`——该域当前并发水位。**口径按域定义**（见 R3），字段旁必须带口径说明，
  读面不得跨域直接比较。
- `degraded: boolean`——该域是否处于降级事实（自适应控制器压低于天花板、Retry-After 冷却中等）。
  配置性下调（用户把 `toolConcurrency.maxConcurrency` 配成 5）**不是** degraded——那是配置事实，
  不是降级。
- `facts?: Record<string, unknown>`——域内附加只读事实（AIMD 桶明细、后台任务按类型分解等），
  只放已存在的数字/字符串事实，不放推测。

聚合快照 `ConcurrencyDiagnosticsSnapshot = { generatedAtMs, domains }`，四个固定域 id：
`tool_scheduler` / `dynamic_workflow` / `plan_explore` / `subagent_background`。

### R2 纯投影纪律（验收红线）

- 快照接口**不得改变任何调度决策**：不新增 admission 判断、不改分组、不改 caps 生效值。
- **无新增写入路径**：投影只读既有状态。`ToolScheduler` 允许在 `schedule()` 内多记一个
  **纯诊断**私有字段（最近一次调度的并行组宽度），该字段不被任何调度分支读取——分组结果
  在记录之前已完全确定，返回值逐字节不变（测试断言）。
- 数据缺失时投影「未知」，**不得猜测**：治理器端口缺席 → `dynamic_workflow.facts.admission =
  "unavailable"`；`concurrencyCeiling` 方法缺席 → `caps: undefined`。
- debug 级本地日志承载，遵守 `no-telemetry.md` 红线：只写本地日志，不产生任何网络上报、
  不进遥测通道、不落持久化存储。

### R3 各域口径（唯一权威定义）

| 域 | caps | current | degraded |
| --- | --- | --- | --- |
| `tool_scheduler` | scheduler 生效的 `maxConcurrency`（默认 10） | **最近一次 `schedule()` 产出的最大并行组宽度**（0 = 本会话尚无调度）。scheduler 是纯函数、不跟踪在飞执行，这是它唯一能如实报告的水位 | 恒 `false`（无自适应机制；配置下调是配置事实） |
| `dynamic_workflow` | run 级并发天花板 `DynamicWorkflowRunPort.concurrencyCeiling()`（缺席 → `undefined`）。**刻意不投影每 run 的 caps**：那是 run 头的既有读面（`GetWorkflowRun` / run-caps-changed 事件），诊断面不重复建第二条读路径 | 本 runtime registry 中 `type === "local_dynamic_workflow"` 且 `status === "running"` 的 run 数 | 任一 provider key 治理桶 `cap < ceiling`，或冷却中（`cooldownUntil > now`）；治理桶不可见时 `false` + facts 标 unavailable |
| `plan_explore` | `planResearchAgentCount`（3，`runtime-reminders.ts` 导出的同一常量——文档与提示词引用同一个值，不各抄一份） | registry 中 `type === "local_agent"`、`agentType === EXPLORE_AGENT_TYPE`、`status === "running"` 的任务数 | 恒 `false`；`facts.enforced = false`、`facts.carrier = "prompt"`——如实标注这是提示词层纪律，非运行时硬闸 |
| `subagent_background` | `undefined`（无显式上限，如实投影） | registry 中 `isBackgrounded === true` 且 `status === "running"` 的 `local_agent` 任务数 | 恒 `false`；`facts` 给全部后台 running 任务按 type 的分解（local_agent/local_bash/local_dynamic_workflow/…） |

### R4 治理器只读投影经契约走公开入口

core 不得 import bootstrap（依赖方向）。AIMD 桶事实经 `@acode/contracts` 的
`ModelRequestAdmission` 新增**可选**只读成员 `concurrencyBuckets?(): ModelRequestAdmissionBucketSnapshot[]`
暴露：governor 的 observer admission 实现它（`bootstrap/src/app/workflow-concurrency-governor.ts`），
runtime 按能力探测消费（可选成员先例：`tryAcquire?`、`DynamicWorkflowRunPort.concurrencyCeiling?`）。
契约成员是纯类型（interface），零运行时面变化；老宿主/stub 缺席该成员时投影按 R2 报「未知」。

### R5 runtime 诊断面与 debug 日志点

- `AgentRuntime.getConcurrencyDiagnostics(): ConcurrencyDiagnosticsSnapshot`——公开只读方法
  （同步，先例 `getActiveTurnInfo`），实现住 `core/src/runtime/methods/concurrency-diagnostics.ts`。
- debug 日志点：每 turn 至多一条 `concurrency_diagnostics_snapshot`（`executeTurnCommand`
  入口处，带 turn traceContext）。选每 turn 而非每模型请求/每工具批：并发治理事实的变化
  粒度是 turn 级，更高频只是重复噪声（debug 高频诊断纪律，根 AGENTS.md 日志节）。
- 子代理 runtime 是独立 AgentRuntime 实例，走同一方法——各自投影各自的 registry 事实。

## 状态所有者

| 状态 | 所有者 | 投影角色 |
| --- | --- | --- |
| 工具并行分组与 `maxConcurrency` | `ToolScheduler`（core） | 只读 |
| run 级 caps、AIMD cap/epoch/inFlight/waiters/cooldown | dynamic-workflow 引擎 + bootstrap 治理器 | 只读 |
| Plan Explore 并行纪律 | 提示词层（runtime-reminders） | 只读常量 |
| 后台任务生命周期 | `RuntimeTaskRegistry`（core） | 只读 |
| 聚合快照与 debug 日志 | runtime 诊断面（methods/concurrency-diagnostics.ts） | 唯一聚合点，无自有状态 |

投影**不持有任何跨调用状态**：每次调用现算，算完即弃。唯一的例外是 R2 允许的
`ToolScheduler` 纯诊断字段（所有者仍是 scheduler 自己）。

## 接口

```ts
// @acode/contracts（model/index.ts）
export interface ModelRequestAdmissionBucketSnapshot {
  key: string;        // provider key：`${providerId}/${modelId}`
  ceiling: number;    // CPU 推导天花板（初值与上界）
  cap: number;        // AIMD 当前 cap
  inFlight: number;   // 已准入未结算的模型请求数
  waiters: number;    // 排队请求数
  cooldownUntil?: number; // Retry-After 冷却截止（ms epoch）；缺席 = 不在冷却
}
export interface ModelRequestAdmission {
  // …既有成员不变…
  /** D5 只读诊断投影；缺席 = 宿主未装配投影面。实现不得因它改变任何准入决策。 */
  concurrencyBuckets?(): ModelRequestAdmissionBucketSnapshot[];
}

// @acode/core（runtime/methods/concurrency-diagnostics.ts，经包公开入口再导出）
export type ConcurrencyDomainId =
  | "tool_scheduler" | "dynamic_workflow" | "plan_explore" | "subagent_background";
export interface ConcurrencyDomainSnapshot {
  caps: number | undefined;
  current: number;
  degraded: boolean;
  facts?: Record<string, unknown>;
}
export interface ConcurrencyDiagnosticsSnapshot {
  generatedAtMs: number;
  domains: Record<ConcurrencyDomainId, ConcurrencyDomainSnapshot>;
}

// ToolScheduler（core/src/tool/scheduler.ts）
export interface ToolSchedulerSnapshot {
  maxConcurrency: number;
  lastScheduleMaxParallelGroupWidth: number; // 0 = 尚无 schedule()
}
```

## 验收场景

1. **默认形状**：新建 runtime（无任务、无治理器）→ 四域齐全；`tool_scheduler.caps === 10`、
   `plan_explore.caps === 3`、`subagent_background.caps === undefined`、全部 `current === 0`、
   全部 `degraded === false`。
2. **registry 事实**：注册 1 个 running Explore agent + 1 个 backgrounded running agent +
   1 个 running dwf run → `plan_explore.current === 1`、`subagent_background.current === 1`、
   `dynamic_workflow.current === 1`。
3. **降级投影**：治理桶 `cap < ceiling` 或冷却中 → `dynamic_workflow.degraded === true`；
   端口缺席 → `degraded === false` 且 `facts.admission === "unavailable"`（不猜）。
4. **纯投影**：同一输入连续两次 `schedule()`，中间穿插任意次 `snapshot()` 读取 → 两次分组
   结果 deep-equal；`snapshot()` 反映最近一次 schedule 的组宽度。
5. **日志红线**：投影与日志不产生网络调用、不写持久化存储（源码级断言 + no-telemetry 套件不红）。

## 不在本项范围

- 全局信号量 / 统一 admission（R0 否决项）。
- 每 run caps 的第二读面（走既有 GetWorkflowRun / run 头投影）。
- 把快照暴露给协议客户端（v4 session event / GUI 面板）——出现明确产品需求方时另立 spec。
- 任何参数调整逻辑（各域保留调整权：`setMaxConcurrency`、AIMD 信号、配置项均不动）。

## 实现记录（2026-09-29）

- 落地文件：`contracts/src/model/index.ts`（R4 契约成员）、`bootstrap/src/app/workflow-concurrency-governor.ts`
  （observer admission 实现 `concurrencyBuckets()`，只映射既有 `ConcurrencyController.snapshot()` 事实）、
  `core/src/tool/scheduler.ts`（`snapshot()` + schedule() 内纯诊断记录）、
  `core/src/runtime/helpers/runtime-reminders.ts`（导出 `planResearchAgentCount`）、
  `core/src/runtime/methods/concurrency-diagnostics.ts`（聚合 + debug 日志）、
  `methods/index.ts` / `internal-methods.ts` / `agent-runtime.ts`（公开面装配）、
  `methods/turn.ts`（executeTurnCommand 入口一条 debug 日志）。
- `dynamic-workflow` 包本体零改动：`ConcurrencyController.snapshot()` 既有只读接口即为投影源，
  刚落地的 token 预算改动（specs/workflow-budget-fuses.md R4/R5/R6）语义未被触碰。
- 测试：`apps/acode-cli/tests/concurrency-diagnostics.test.mjs`（验收场景 1–4 + 契约成员形状）。
