# 对话内 Swarm 任务图：模型自组织 DAG + artifact dataflow（K2）

方案条目：`docs/k-series-upgrade-plan.md` §K2。机制参照 jcode (MIT)
`crates/jcode-plan/src/dag/`（mod.rs TaskGraph/TaskNode/HandoffArtifact、ops.rs 验证式图变更、
schedule.rs 确定性调度、sim.rs 模拟器先行）、`docs/SWARM_TASK_GRAPH.md`（DAG-first 纲领：
「DAG 是主对象，agent 是可替换 worker」）、`jcode-plan/src/lib.rs:150`（VersionedPlan——plan
与 session todos 刻意分离），自撰 TypeScript 实现，未拷贝任何文件。

**定位**：给 ACode 补第三种编排形态。现状两种——expert workflow（definition 预定义图 +
planner 扩张，引擎驱动八阶段）与 dynamic-workflow（确定性 TS 脚本编排）——都不是
「**模型在主对话中维护的持久任务图**」。K2 让模型经工具族（PlanSeed / PlanExpand /
PlanCompleteGate / PlanStatus / PlanControl）构建与演化 TaskGraph，引擎在 turn 间隙调度
执行，typed artifact 沿依赖边流动，gate 强制对抗审计。**typed artifact 契约、gate 三连检、
artifact-or-nothing 语义全部复用 J2-3 已落的面**（`contracts` WorkflowArtifactTypedSchema、
`core/src/workflow/artifact-gate.ts` / `typed-artifact.ts`），本项新增的是图引擎与
dataflow，不是第二套可信调度语义。

红线：**expert workflow 与 dynamic-workflow 行为零回归**（含 J2-3 全部验收场景重跑全绿）；
subagent / todo / bash / compact 域不动；**不搬 jcode 的 swarm member/channel/broadcast
体系**（那是其多进程 TUI 生态的产物）——worker = 无名 workflow 子会话，死 worker 的节点
走 requeue，不存在「成员管理」面。

裁剪边界：不做跨会话/跨进程共享 plan（plan 随单任务生命周期）；不做 channel 消息与
coordinator 槽位选举；不做 worktree 隔离策略（复用既有 workspace 语义）；UI 投影
（plan 可视化）登记后续批次。

---

## 背景：已核实的现状与 jcode 参照

> ACode 行号以 dev/0.0.2 `7798f76` 检出为准，实施前复核。

### ACode 已有面（K2 的复用地基）

1. **typed artifact 契约已落（J2-3）**：`contracts/src/workflow/index.ts:186`
   `WorkflowArtifactTypedSchema`（findings/evidence/openQuestions/validation/whatINotChecked/
   confidence）、`:103` `WorkflowGatePresetSchema`（light/deep）；提取链
   `core/src/workflow/typed-artifact.ts`（response 尾部 ```acode-artifact 围栏、别名归一、
   `validateDeepNodeArtifact` 薄校验）。
2. **gate 语义已落（J2-3）**：`core/src/workflow/artifact-gate.ts:26-133`——
   `CRITIC_COVERAGE_ENUMERATION_CAP=20`、`mentionsNodeId` 词边界匹配、
   `evaluateCriticGate` 三连检（stale_gate_scope / unaddressed_low_confidence /
   uncovered_siblings）、`resolveWorkflowGateSettings`、`isArtifactGateWorkerNode`。
3. **节点执行原语在 expert scheduler**：`core/src/workflow/scheduler/node-runner.ts`
   ——子会话执行（`taskType: "workflow_child"` 经 `bootstrap/src/app/workflow-facade.ts`
   runner）、response→artifact 提取、artifact-or-nothing requeue（`artifactRequeues`
   封顶）、typed 挂载进 run snapshot。**K2 把它的「单节点执行 + artifact 提取 + requeue」
   抽成共享原语**（重构不改 expert 行为，零回归红线）。
4. **并行子会话调度已有先例**：`core/src/tool/scheduler.ts` parallelGroups（concurrentSafe
   并行分组）；`core/src/subagent/`（22 文件）的子会话派发基建。
5. **turn 后调度点模式已有先例**：memory extraction 挂在成功 Main turn 后
   （`core/src/runtime/methods/turn.ts:703-708`，J3-2 核实）——K2 的图引擎调度挂同款
   调度点。
6. **runtime-task 体系**：`core/src/runtime-task/registry.ts`（后台任务快照/终态判定/
   活跃探测）——plan 执行的对外可见面复用它，不新发明任务注册表。

### jcode 参照机制（只读提炼，含其文档声明的设计 rationale）

- **TaskGraph{mode: Deep|Light} 一个引擎两个预设**：数据模型/调度器/dataflow 完全相同，
  deep 只多开「强制 root gate + 严格 artifact 校验 + 废除 auto-complete」；
  `NodeStatus` 只有 Queued/Running/Done/Failed，**故意不存 Blocked——由调度器从依赖
  状态推导，单一事实源**。
- **TaskNode 关键字段**：`id`、`content`、`kind`（Explore/Implement/Verify/Fix/Synthesize/
  Critique）、`owner`（dispatch 分配，只有 owner 能 expand/complete）、`parent`（分解来源）、
  `depends_on`（**既是依赖边也是数据流通道**）、`expanded`、`is_gate`、`planner`（分解者，
  synthesis 再唤醒时亲和复用）、`priority`、`output: HandoffArtifact`、
  `origin`（Seed/Expand/Gap/Gate）。
- **验证式图变更（全部 clone-stage-commit：克隆上做、验环、再提交）**：
  - `seed` 幂等重放（相同定义 no-op，传输重试安全）；deep 强制插 root gate
    （依赖所有 root 节点——「否则扁平 seed 全部原子执行完会零 gate 收场，deep 静默退化
    为 light」）；re-seed 把已 terminal 的 gate 重新 Queued（「re-seed 的 plan 永不可能
    未被审计就保持 finished」）。
  - `expand_node`：父节点翻 composite join（Queued、保留原上游依赖、追加 children+gate
    边、planner 记录后 owner 清空使 synthesis 可被任意 worker 领取）；deep 在 children
    与 synthesis 间自动插 gate；**children 边保留**（「dataflow 水合只读直接依赖，去掉
    会让 synthesis 收不到子 artifact」——即使 gate 已依赖全部 children）。
  - `complete_node`：deep 非 gate 走薄 artifact 校验（findings/what_i_did_not_check 非空
    + confidence 可解析，否则 ThinArtifact 拒绝）；gate 走三连检。
  - `inject_from_gate`：gate 不分解自己，向同一 composite parent 下加 **Gap 兄弟节点**、
    把自己重新 Queued 并依赖它们（re-critique 循环）；parent 也直接依赖 gap 节点
    （dataflow 同理）。
  - `requeue_failed`：清 owner 重新排队——「没有它 failed deep gate 会永久卡死 composite」。
- **调度器**：ready = Queued 且全部 dep Done；priority 升序 + id 字典序（确定性）；
  失败**不传播**——失败节点停住，依赖它的节点永远不 ready（sim 定义为 stalled）。
- **deep 的 turn 结束防线**：彻底废除 auto-complete——turn 结束仍 Running →
  RequeueNoArtifact（换 worker 一次）→ 再犯 FailNoArtifact（「typed artifact 契约只有在
  不存在绕过它的 done 路径时才是真的」）；light 的 running 节点 turn 结束 AutoComplete
  （宽纵）。
- **上限**：`MAX_PLAN_ITEMS=1024`（「plan 是协调状态不是日志」）；
  并发受 `swarm_max_concurrent_agents`（RAM 预算）。
- **模拟器先行**：`dag/sim.rs` 闭包 worker + WorkerAction——引擎先在模拟器里验证
  再接 live session（K2 的测试形态直接采纳）。

### 与 jcode 的两处**有意偏移**（ACode 架构差异，不是遗漏）

1. **引擎调度替代模型手动 dispatch**：jcode 是 TUI 常驻 coordinator 经 swarm 工具手动
   assign_next/run_plan；ACode 主对话是 UI 驱动 turn loop，无常驻循环。K2 由**引擎在
   turn 间隙批派发 ready 节点**（见 R4），模型只负责图结构（seed/expand）与 gate 审计。
   消除「模型忘了 dispatch」这类卡死源；调度确定性（priority+id）保留。
2. **gate 节点执行者是主对话模型而非子会话**：审计是模型的自省职责，派给子会话等于
   让学生给自己批卷。gate 节点经 `PlanCompleteGate` 工具由主对话提交（见 R5）。

## 产品规则

### R1 数据模型（contracts 新 `contracts/src/swarm/index.ts`）

```ts
SwarmPlanNodeKindSchema = z.enum(["explore","implement","verify","fix","synthesize","critique"])
SwarmPlanNodeStatusSchema = z.enum(["queued","running","done","failed"])   // 不存 blocked（推导）
SwarmPlanNodeOriginSchema = z.enum(["seed","expand","gap","gate"])
SwarmPlanNodeSchema = z.object({
  id: z.string().min(1).max(200),
  content: z.string().min(1).max(20_000),
  kind: SwarmPlanNodeKindSchema,
  status: SwarmPlanNodeStatusSchema,
  owner: z.string().nullable(),          // 执行实例 id；expand 后清空（jcode 同款）
  parent: z.string().nullable(),
  dependsOn: z.array(z.string()).max(100),
  expanded: z.boolean(),
  isGate: z.boolean(),
  planner: z.string().nullable(),        // 分解者（synthesis 亲和）
  priority: z.number().int().min(0).max(9),
  output: WorkflowArtifactTypedSchema.nullable(),   // 复用 J2-3 契约（含长度上限）
  origin: SwarmPlanNodeOriginSchema,
  artifactRequeues: z.number().int().nonnegative(), // J2-3 同款累计、reopen 不重置
})
SwarmTaskPlanSchema = z.object({
  version: z.number().int(),
  goal: z.string().max(5_000),
  mode: WorkflowGatePresetSchema,        // light/deep 复用 J2-3 preset 语义
  nodes: z.array(SwarmPlanNodeSchema).max(SWARM_MAX_PLAN_ITEMS),
  noArtifactRequeues: z.number().int().nonnegative(),  // deep 废除 auto-complete 的计数
  createdAtMs / updatedAtMs: z.number(),
})
```

- `output` 复用 `WorkflowArtifactTypedSchema`（含 J2-3 F-4 全部长度上限——上限只可放宽
  不可收紧的既定约束继续有效）；
- **plan 与 todo 刻意分离**（jcode 同款声明）：todo 是 session 本地进度自报，plan 是
  引擎持有的协调状态（所有者不同、可信级不同——plan 的 done 需 typed artifact 或 gate
  审计，todo 不需要）。提示词层面明确二者分工，防模型混用。

### R2 图引擎（core 新 `core/src/swarm/graph/`，纯函数、零 IO）

对齐 jcode `dag/`：`graph/ops.ts`（变更 op）、`graph/schedule.ts`（ready/stalled 推导）、
`graph/validate.ts`（环/引用/上限校验）。全部 **clone-stage-commit**：输入只读图 →
克隆变更 → 校验（未知依赖引用、环检测〔expand 只向已有节点追加出边，环即拒绝〕、
`SWARM_MAX_PLAN_ITEMS` 上限、id 唯一）→ 返回新图或具名错误（`SwarmGraphError` 闭合枚举：
`unknown-node` / `duplicate-id` / `cycle` / `limit-exceeded` / `not-owner` / `invalid-state` /
`thin-artifact` / `gate-rejected` / `gate-scope-stale` / `blank-id`）。

- `seedPlan(goal, defs, mode)`：**幂等重放**（同 goal+相同 defs 集合 no-op，防工具重试
  双写）；deep 模式**强制插 root gate**（kind=critique 的合成节点，依赖全部无 parent 的
  节点；re-seed 时已 terminal 的 gate 重置 queued 并把新 root 纳入依赖——「新工作重开
  审计」）；blank id 拒绝（J2-3 R11 同款防 deep 死路：不可点名的节点 id 让 gate 永不通过）；
- `expandNode(plan, id, children)`：仅 owner 或无主 queued/running 非 gate 未 expanded 节点；
  父节点翻 composite（queued、`expanded=true`、保留原 dependsOn、追加 children+〔deep〕
  gate 边、planner 记录后 owner 清空）；**children→parent 数据边保留**（jcode 同款：
  dataflow 水合只读直接依赖）；deep 在 children 与 parent 间自动插 gate；
- `completeWorkerNode(plan, id, typed)`：引擎侧（非模型工具面）调用；deep 走
  `validateDeepNodeArtifact`（复用）失败 → thin-artifact 错误 → 上层 requeue/fail（R4）；
  light 任意产出接受；
- `completeGateNode(plan, id, verdict)`：verdict = {pass, reasoning, acceptanceGaps,
  gapProposals}；pass 走 `evaluateCriticGate`（复用，审计范围=plan 内全部非 gate 节点，
  done 判定复用 COMPLETED_NODE_STATUSES 语义）；被拒的错误载荷带 issue 列表与
  gapProposals → 引擎执行 `injectGap`；fail 结论同样产 gap 注入（jcode inject_from_gate）；
- `injectGap(plan, gateId, gaps)`：gap 节点（origin=gap）挂在 gate 的 parent 下作兄弟、
  gate 重置 queued 并依赖 gap、parent 直接依赖 gap（dataflow）；
- `requeueNode(plan, id)`：清 owner、status→queued（失败恢复路径；`artifactRequeues` 不清零）。

### R3 dataflow：节点输入装配

- ready 节点派发时，子会话 prompt = 节点 content + **全部 Done 直接上游的 `output`
  渲染段**（按 dependsOn 顺序、每 artifact 截断 `SWARM_ARTIFACT_RENDER_MAX_CHARS=2_000`、
  总截断 `SWARM_ARTIFACT_RENDER_TOTAL_MAX_CHARS=16_000`——jcode「引用传递控制上下文体积」
  的 ACode 具体化）；无 Done 上游时不附段；
- 渲染段含不可信声明（artifact 是上游输出，非指令——与 K1/J3-2 同款防注入口径）；
- deep worker 节点 prompt 尾部附 typed artifact 契约段（复用
  `typedArtifactContractLines()`），light 不附（J2-3 R8「不告知就不判违规」同款对称）。

### R4 执行模型（core 新 `core/src/swarm/runner.ts` + 接线）

- **调度点**：成功 Main turn 之后（与 memory extraction 同款挂点），引擎把 ready 节点
  按确定性序（priority 升序、id 字典序）批量派发，活跃执行数上限
  `SWARM_MAX_CONCURRENT_WORKERS`（缺省 4，config 可调）；
- **worker 节点执行**：经共享执行原语（从 `scheduler/node-runner.ts` 抽取的「子会话执行 +
  response→typed 提取 + artifact-or-nothing」核心；**抽取重构不改 expert 行为**）以
  workflow 子会话形态执行（`taskType: "workflow_child"` 同型，无 submit 端口——与 J2-3
  背景核实一致）；执行完成引擎调用 `completeWorkerNode` 落图；
- **deep 废除 auto-complete**（jcode 关键防线）：worker 子会话回合结束无有效 typed
  artifact → `noArtifactRequeues` +1 → requeue 换新执行一次；再犯 → 节点 failed
  （复用 J2-3 requeue 语义与计数封顶）；light：回合结束即 done（宽纵，artifact 可空）；
- **失败不传播**：failed 节点停住；依赖它的节点永不 ready（`schedule.ts` 的
  `stalledNodeIds(plan)` 推导暴露给 PlanStatus）；整图终态判定：
  `allDone && gatesAllDone` → plan completed；存在 failed/stalled 且无 running/queued
  可推进 → plan stalled（主对话经 reminder 收到 stalled 通知，模型用 PlanControl.retry
  或 Expand 改道）；
- **对 runtime-task 的投影**：plan 作为 background runtime task 注册（快照含
  done/failed/running/stalled 计数与图摘要），复用 `runtime-task/registry.ts`——不新建
  任务可见面。

### R5 工具面（contracts `swarm/tools` + handlers）

| 工具 | 输入要点 | 谁可用 |
| --- | --- | --- |
| `PlanSeed` | goal、nodes[{id,content,kind,dependsOn,priority}]、mode | 主对话 |
| `PlanExpand` | nodeId、children[]（同上形状） | 主对话 |
| `PlanCompleteGate` | gateId、verdict{pass,reasoning,acceptanceGaps[],gapProposals[]} | 主对话（gate 节点唯一执行通道） |
| `PlanStatus` | （无参）→ 图投影：节点状态/ready/stalled/上游 artifact 摘要 | 主对话 + workflow 子会话（只读） |
| `PlanControl` | action: retry/cancel-node/cancel-plan | 主对话 |

- 工具注册门：runtime 级 `swarmPlanPort` 在场（与 `workflowPort` 同款装配模式，
  `runtime-tools.ts:67` 先例）；**注册给 workflow 子会话的只有 PlanStatus（只读）**，
  图变更工具仅主对话——防 worker 自改图（jcode「防 worker 给自己解锁无限增长」同源）；
- 工具错误即 `SwarmGraphError` 的用户可读投影（不裸抛枚举名）；
- 提示词：PlanSeed/PlanExpand 描述中声明 plan-vs-todo 分工、deep 模式的 gate 契约
  （「inject_gap 即成功」「增长的图就是系统在正常工作」——jcode gate 指令的对抗性
  话术移植）；不新增 reminder 事件枚举之外的 UI 事件。

### R6 状态所有权与持久化

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| SwarmTaskPlan | runtime 内 plan store（单任务单图；随任务持久化面落盘，对齐 todo 持久化路径——实施首日核实 todo 落盘链路并对齐，不新建第二存储引擎） | 任务 |
| 图变更 op | 纯函数（R2），无状态 | — |
| 调度与执行 | swarm runner（turn 间隙调度点驱动） | 任务 |
| gate 裁决 | 复用 `evaluateCriticGate`（纯函数） | — |
| runtime-task 投影 | runtime-task registry（既有） | 任务 |

不变量：图只经 R2 ops 变更（工具与 runner 都是 ops 的调用方，无第三写路径）；克隆提交
保证读者永远见一致快照；`owner` 只由 runner 分配/清空（模型工具面不写 owner）；
`noArtifactRequeues` 单调递增不重置。禁止用超时掩盖图一致性错误（环/引用校验失败即拒绝，
不重试）。

### R7 提示词与提醒

- plan 建立后每个主 turn 注入一次 plan 进展 reminder（动态段，同 K1 载体模式）：图摘要
  （done/running/queued/failed/stalled 计数）+ 待模型处理的 gate 队列（gate ready 时
  提示用 PlanCompleteGate）+ stalled 告警；
- gate 节点 ready 且分配给主对话时，reminder 明确「当前有 N 个 gate 待审计」——deep
  模式下这是模型不可绕过的收尾义务（root gate 不 pass，plan 永不 completed）。

## 常量（`contracts/src/swarm/index.ts`，改这里即改协议）

| 常量 | 值 | 出处 |
| --- | --- | --- |
| `SWARM_MAX_PLAN_ITEMS` | `1024` | R2（jcode 同值） |
| `SWARM_MAX_CONCURRENT_WORKERS` | `4`（config `swarm.maxConcurrentWorkers` 可调 1-16） | R4 |
| `SWARM_ARTIFACT_RENDER_MAX_CHARS` | `2_000` | R3 |
| `SWARM_ARTIFACT_RENDER_TOTAL_MAX_CHARS` | `16_000` | R3 |
| `SWARM_MAX_NODE_DEPENDS` | `100` | R1 schema |
| `SWARM_DEFAULT_NO_ARTIFACT_REQUEUE_CAP` | `1` | R4（J2-3 DEFAULT_MAX_ARTIFACT_REQUEUES 同值） |

## 接口（新增导出面）

contracts：`SwarmTaskPlanSchema` 及全部子 schema、`SwarmGraphError` 判别联合、
上表常量、`SwarmPlanTool*Schema`（五工具入参/出参）。
core：`core/src/swarm/graph/{ops,schedule,validate}.ts`（纯函数引擎）、
`core/src/swarm/plan-store.ts`（runtime 内 store + 持久化对齐 todo 链路）、
`core/src/swarm/runner.ts`（调度点接线 + 共享执行原语消费）、
`core/src/tool/handlers/plan-{seed,expand,complete-gate,status,control}.ts`；
`core/src/workflow/scheduler/node-runner.ts` 抽取共享原语（导出
`executeNodeSubsession` 形态，expert node-runner 与 swarm runner 共同消费，
**expert 调用点行为零变化**）。

## 验收场景

测试：`apps/acode-cli/tests/swarm-task-graph.test.mjs`（引擎纯函数 + fake runner 端到端，
J2-3 测试形态；**模拟器先行**：全部调度/失败/gate 序列先在 fake runner 矩阵里跑通再接
真实子会话——jcode sim.rs 方法论）。

**引擎（R2/R3）**：
1. seed 幂等：同 defs 二次 seed → no-op；deep 强制 root gate 在场且依赖全部 root；
   re-seed 后已 done 的 root gate 重置 queued 且依赖新 root；blank id 拒绝（J2-3 R11 同款）；
2. expand：父 composite 化、children 边保留（合成节点 dataflow 能收到子 artifact——
   R3 装配断言）、deep 自动子 gate、owner 清空、planner 记录；未知依赖/环/超 1024 上限
   → 具名错误拒绝；
3. completeWorkerNode：deep 薄 artifact（findings 空/whatINotChecked 空/confidence 缺）
   → thin-artifact；light 任意产出接受；
4. completeGateNode：橡皮图章（未点名）→ gate-rejected + issue 载荷；低置信未点名 →
   拒绝（两档）；点名齐全 → done；fail 结论 → gap 注入（gate 重置 queued 依赖 gap、
   parent 依赖 gap）；
5. 失败不传播：A failed → 依赖 A 的 B 出现在 stalledNodeIds；retry 后 B 回 ready。

**执行（R4，fake runner 端到端）**：
6. turn 后调度点批派发：ready 按 priority+id 序、并发上限 4（第 5 个等位）；dataflow
   装配含 Done 上游 artifact 渲染段（截断生效）与不可信声明；
7. deep 废除 auto-complete：fake runner 返回无 artifact 回合 → requeue 一次（换执行
   实例）→ 再犯 failed；`noArtifactRequeues` 单调；light：回合结束即 done；
8. 整图终态：全部 done+root gate pass → completed；存在 stalled → stalled 状态 +
   reminder 告警；runtime-task 投影快照字段齐；
9. **deep 全链路对抗**：seed(3 节点+root gate) → 并行执行 → 一节点自报 low confidence
   → root gate 必须点名处理否则 plan 停在 gate-rejected 循环 → inject gap → gap 执行
   → gate 复审 pass → completed。事件/状态序列断言（对齐 J2-3 的事件序列钉法）。

**工具面与边界（R5）**：
10. 五工具经 `swarmPlanPort` 注册门；workflow 子会话只见 PlanStatus；模型工具面无 owner
    写路径（源码断言）；plan 与 todo 独立（todo 域零命中）；
11. **零回归红线**：expert workflow 既有测试全量重跑（含 J2-3 workflow-typed-artifacts
    全场景）+ dynamic-workflow 测试全绿 + 抽取重构后 expert 事件序列快照不变。

**提示词（R7）**：12. reminder 动态段含图摘要与 gate 待办；无 plan 时零注入。

## 未做与取舍

1. **不搬 member/channel/broadcast**：worker 无身份（fungible），死执行实例=节点 requeue
   （R4 的 no-artifact/fail 路径覆盖）；跨 worker 通信只有 artifact dataflow——这是
   jcode DAG 文档的既定方向（channel 已标弃用），不是简化遗漏。
2. **递归 swarm（worker 起 swarm）不开放**：jcode 递归是 deep 专属且防 worker 自解锁；
   ACode 的 worker 子会话没有图工具面（R5），结构性禁止，无需运行时判定。
3. **gate 由主对话执行的推论**：主对话 compact 后 plan reminder 仍持图摘要（plan 在
   runtime store，不受 transcript 压缩影响）——这是 gate 归主对话的必要条件，已在 R7
   实现；若未来 gate 积压超限（连续 3 个主 turn 未处理 gate），reminder 升级为阻断式
   提示——阈值与文案登记后续调优。
4. **UI 可视化**（图/时间线）：desktop/web 投影后续批次，本项只保证 runtime-task 快照
   字段完备。
5. **plan 持久化细节**（落盘格式/迁移）：实施首日对齐 todo 的持久化链路后在此 spec 补
   记附录；若 todo 链路不可复用，走 task metadata 存储（单一事实源原则不变）。

## 第三方归属

`core/src/swarm/graph/` 文件头注明「机制参照 jcode (MIT)：crates/jcode-plan/src/dag/
（ops/schedule/sim 的 clone-stage-commit 语义、ready 推导、失败不传播、模拟器先行）与
docs/SWARM_TASK_GRAPH.md（DAG-first、children 边保留 rationale、deep 废除 auto-complete
rationale）」，自撰 TypeScript 实现。gate/artifact 复用面是本仓 J2-3 既有实现（其归属
声明已在 `specs/workflow-typed-artifacts.md`）。
