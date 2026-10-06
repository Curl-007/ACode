# AgentRuntime 状态所有权分簇与不变量登记

状态：类型级分簇已实施（2026-10-05，深度审查 P2「AgentRuntime god object」第一批）；断言化为登记后续项。
代码：`packages/core/src/runtime/internal.ts`（分簇子接口 + 组合）；`packages/core/src/runtime/agent-runtime.ts:installAgentRuntimeMethods`（95 个 methods 文件原型注入，本次未动）。

## 背景

methods/ 下 95 个文件共享同一个 `this: AgentRuntimeInternal`（约 110 个字段），此前字段以扁平列表堆放：任何新模块都能悄悄读写任意字段，并发时序不变量只存在于散落注释。本次把字段按所有权分为 7 簇（`RuntimeIdentityConfig` / `RuntimeInjectedDeps` / `RuntimeContextMemoryState` / `RuntimeTurnState` / `RuntimeMessageProjectionState` / `RuntimeCacheDiagnosticsState` / `RuntimeSessionLifecycleState`）。

**关键约束：分簇是纯类型级重组**——`AgentRuntimeInternal` 仍是扁平字段的 extends 组合，所有 `this.fieldX` 访问、构造器对象字面量、95 个 methods 文件零改动、零运行时变化（`@acode/core` tsc --noEmit 全绿验证）。分簇接口不导出，不扩公共 API 面。

## 簇 → 唯一写入方

| 簇 | 写入方 | 可变性 |
| --- | --- | --- |
| RuntimeIdentityConfig | 构造函数 | 不可变 |
| RuntimeInjectedDeps | 构造函数（deps 注入，无 late binding） | 不可变（Set/Map 容器内容除外，容器所有者见各 port 契约） |
| RuntimeContextMemoryState | methods/context-*、memory 提取/召回 helpers、MCP 启动路径 | 会话内可变 |
| RuntimeTurnState | turn 编排路径（methods/turn.ts、methods/prompt-admission.ts、command-queue drain） | turn 内高频可变——**时序不变量最密集** |
| RuntimeMessageProjectionState | 事件发布/reducer 路径 | 派生游标 |
| RuntimeCacheDiagnosticsState | 模型请求路径 | 进程内累计，resume/rewind 后重置 |
| RuntimeSessionLifecycleState | 各一次性 flag 的消费点（评估即消费） | 单调旗标 |

新增字段必须归入一个簇并写明唯一写入方；无法归簇 = 所有权不清，先对齐再落码（根 AGENTS.md「明确唯一所有者」）。

## 不变量登记（当前为注释/测试钉住，断言化候选）

| # | 不变量 | 现状载体 | 断言化落点（后续批次） |
| --- | --- | --- | --- |
| I1 | `activeTurnStartReservation` 建立前不得出现第二条 turn（reservation 建立前的异步窗口会产生双 turn） | `methods/prompt-admission.ts:15-19` 注释 | prompt-admission 入口 dev 断言 + `tests/` 不变量测试（参照 command-inbox-invariants 模式） |
| I2 | `runtimeCommandDrainActive` 期间不得重入 drain | drain 路径注释 | drain 入口断言 |
| I3 | `branchGeneration` 单调递增；resume/rewind 后旧分支写入必须被拒 | 分支代际字段注释 | 写入点代际校验断言 |
| I4 | 一次性 flag（`runtimeRestartReminderEmitted`、`sessionTitleGenerationAttempted` 等）评估即消费，不得回写 false | 各 spec（runtime-restart-task-reminder R3 等） | 类型收窄（消费后 narrow）或 setter 封口令 |

断言化批次要求：每条断言先有对应的不变量测试（真实 runtime + 桩端口），再上 dev-only 断言（生产路径不抛），避免把时序 bug 变成线上崩溃。

## 验收（本批次）

- `@acode/core` `tsc --noEmit` 0 错误（已验证）。
- CLI 测试套件 980 全绿（随本批终验执行）。
- 字段数量与分簇前一一对应（漏字段会被构造器 excess-property 检查与 methods 读取双向捕获）。
