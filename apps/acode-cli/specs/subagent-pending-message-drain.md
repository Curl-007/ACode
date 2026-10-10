# 子代理挂起消息的 turn 起点 drain（编排方案 Phase 3 前置修复 / peer-5）

来源：[`docs/codex-orchestration-integration-plan.md`](../../../docs/codex-orchestration-integration-plan.md)
§4 Phase 3「前置 bug 修复」与 §5 peer-5 行。2026-10-10 对照审计（C1，独立复核
confirmed）核实悬挂路径仍在本检出原样存在。Phase 3（agent-peer-messaging，另行立项）
以本修复为阻塞前置：peer 的「空闲目标 enqueue 起新 turn」路由依赖同一个 drain 钩子。

## 背景（已核实的悬挂机制）

- `pendingMessages` 的**唯一** flush 点是 sink 注册（`core/src/subagent/runner.ts`
  `createMessageSinkRegistration` → `flushPendingMessages` → `registry.drainMessages`，
  全仓唯一消费方）；sink 注册每 run 一次（`core/src/runtime/methods/subagent.ts` 的
  runExploreAgent 闭包，`registerMessageSink` 在 `childRuntime.executeTurn` **之前**调用）。
- 注册即 flush 与 turn 实际启动之间存在**竞态**：flush 经 `createSubagentMessageSink`
  → `steerTurn`，turn 未激活时返回 `no_active_turn`，重试窗口仅 20×10ms≈200ms
  （`message-steering.ts`）；而 turn 启动前的初始化（会话持久化、上下文构建、模型
  选择）很容易超过该窗口。竞态输掉 → 消息被 `queueMessage` 回队（`runner.ts`
  deliverMessageToRunningAgent 的 catch 分支同款）→ **本 run 内不再有任何 flush 点**，
  消息悬挂到 run 终态后由 resume 路径重注册 sink 才冲。
- run 中段的 steer 失败回队同样落入该悬挂（区别只在触发时机）；「queued」投递语义
  本身合法（`subagent.port.ts` 三投递语义），bug 是**活跃 run 内缺失下一个 drain 时机**。

## 产品规则

**R1 turn 起点 drain 钩子。** `ExecuteTurnOptionsBase` 新增可选 `onTurnStarted?: () => void`：
turn 激活点（`turn.ts` 的 `beginActiveTurn` 之后、turn.started 日志同址）**恰好一次**回调。
子代理链路把该钩子接到 `ExploreSubagentRuntimeRequest.drainQueuedMessages`（runner 提供，
经 sink 重放队列）。turn 激活是 steer 可投递的**确定性边界**——注册期竞态输掉的消息在
这里被补投，不再有「等 resume」的悬挂窗口。

**R2 钩子永不伤及 turn。** turn.ts 侧 try/catch 兜底（钩子契约本就是不抛，违反契约时
turn 优先）；subagent.ts 接线处同样包裹；drain 内部失败保持既有 re-queue 语义
（`flushPendingMessages` 的失败回队 + warn 不变）。

**R3 无周期 drain、无双投递。** 修复是**事件驱动单点钩子**，不引入定时器/轮询（现状
「进程内无周期性 drain」是事实描述，不是要补第二套机制）。并发安全由既有原语保证：
`registry.drainMessages` 原子取批——注册 flush 与 turn 起点 drain 同时触发也只有一方
拿到消息；终态任务不 drain（`isTerminalRuntimeTask` 守卫，resume 路径自会重注册 flush）。

**R4 投递语义不变。** 三投递语义（steered/queued/resumed_background）与 SendMessage 的
返回值形状零变化：本修复只缩短 queued → steered 的等待窗口，不改任何对外契约。

## 状态所有者

| 状态 | 唯一所有者 | 变化 |
| --- | --- | --- |
| pendingMessages 队列 | RuntimeTaskRegistry（父 runtime 内存，既有） | 不变 |
| flush 触发时机 | sink 注册（既有）+ turn 激活钩子（新增，事件驱动） | +1 个确定性触发点 |
| turn 激活事实 | child AgentRuntime（beginActiveTurn） | 不变，只读出回调 |

## 接口

- `core/src/runtime/types.ts`：`ExecuteTurnOptionsBase.onTurnStarted?: () => void`（可选，
  其余 executeTurn 调用方零影响）。
- `core/src/runtime/methods/turn.ts`：`beginActiveTurn` 后单次回调（try/catch 兜底）。
- `core/src/subagent/runner.ts`：`ExploreSubagentRuntimeRequest.drainQueuedMessages?: () => void`；
  `runAgentToCompletion` 的**单一**请求构造点提供实现（前台/后台/resume 三路共用该构造，
  一处接线全覆盖）。
- `core/src/runtime/methods/subagent.ts`：executeTurn options 传
  `onTurnStarted → request.drainQueuedMessages`（包裹不抛）。

## 事件顺序与幂等

```
run 启动 → registerMessageSink（flush #1：竞态窗口 ~200ms）
  ├─ 竞态赢：队列冲净，turn 起点 drain 拿空批（no-op）
  └─ 竞态输：消息 re-queue → executeTurn → beginActiveTurn → onTurnStarted
       → drainQueuedMessages（flush #2：经当前 sink 重放）
            ├─ 成功 → steered（迟到投递，语义与注册期 flush 相同）
            └─ 失败 → re-queue（保持既有语义；终态后走 resume flush）
幂等：drainMessages 原子取批，双触发无双投递；终态守卫防向死 run 投递
```

## 验收场景

见 `apps/acode-cli/tests/subagent-pending-message-drain.test.mjs`：

1. 注册 flush 竞态输掉（sink 首发失败）→ 消息 queued → turn 起点 drain（钩子调用）→
   消息经同一 sink 送达，无双投递。
2. 钩子抛错不冒泡（turn 侧兜底）；drain 失败消息仍在队列（re-queue 语义保持）。
3. 终态任务 drain 为 no-op（源码级守卫断言 + 行为级：run 结束后钩子不再投递）。
4. 接线不变量：turn.ts 在 beginActiveTurn 后回调 onTurnStarted；subagent.ts 把钩子接到
   drainQueuedMessages；runner.ts 单一构造点提供实现且带终态守卫。
5. 负向断言：runner.ts 的 drain 路径无 setInterval/周期轮询（R3「事件驱动单点」）。

## 不在本项范围

- peer 间点对点传输/围栏/持久镜像（Phase 3 `agent-peer-messaging.md`，以本修复为前置）。
- run 中段 steer 失败后的 run 内重投（终态后 resume flush 已覆盖；run 内追加时机需要
  turn 内事件面，留给 Phase 3 的速率/环路设计一并考虑）。
- `RuntimeCommandQueue` 的 task-notification 路径（与本队列无关，不动）。
