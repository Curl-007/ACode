# expert workflow 类型化 artifact + critic 点名校验（J2-3）

调度可信批次 P1 项（docs/jcode-inspired-upgrade-plan.md §J2-3）。给 expert workflow 补两件事：

1. **类型化 artifact**：节点完成提交除路径式 markdown 产物外，可携带结构化 typed 段
   （findings / evidence(file:line) / validation / openQuestions / confidence / whatINotChecked）；
2. **critic 不能橡皮图章**：`final_critic` 的 pass 裁决必须按节点 id 逐一点名审计范围内的
   done 节点（词边界匹配防短 id 误命中）；`confidence: low` 的节点未被点名处理时 gate 不通过。

红线：**既有 light 档八阶段流程行为零回归**（提示词字节不变、事件序列不变、无 typed 数据时
所有新规则不触发，测试钉住）；全量点名校验与 artifact-or-nothing 只在 workflow definition
显式声明 deep preset 时生效；**dynamic-workflow 脚本引擎完全不动**。

机制参照 jcode (MIT) `crates/jcode-plan/src/dag/mod.rs`（HandoffArtifact 契约）与
`crates/jcode-plan/src/dag/ops.rs`（validate_artifact / validate_gate_pass / mentions_node_id /
GATE_COVERAGE_ENUMERATION_CAP），自撰 TypeScript 实现，未拷贝任何文件。

## 背景与现状证据（已核实）

### 节点完成提交链路：不是 submit_result 工具，而是子会话末轮 response

- expert workflow 的 phase/node 由子 `AgentRuntime` 会话执行：
  `bootstrap/src/app/workflow-facade.ts:81-133` 的 `workflowAgentRunner.run` → `executeTurn` →
  返回 `result.response`（末轮 assistant 文本）。
- 子会话是 `taskType: "workflow_child"`（`workflow-facade.ts:289`），**没有**注入
  `workflowSubmitPort`，也没有 `coordinatorResponsePort`；`submit_result` 与
  `respond_to_coordinator` 两个工具都不注册给它
  （`core/src/runtime/helpers/runtime-tools.ts:56-59`：注册门分别是端口在场 +
  `taskType === "subagent_child"`）。这两个工具属于 dynamic-workflow actor 与 subagent 链路。
- 因此 expert workflow 的「节点完成提交」= `core/src/workflow/scheduler/node-runner.ts:90-143`
  里 `runtime.runner.run(...)` 返回的 response 文本；它被原样写成
  `artifacts/exec/<node>.md` 并记入 `WorkflowArtifactSchema`（路径式，
  `contracts/src/workflow/index.ts:155-162`），**没有任何内容校验**。
- `core/src/tool/handlers/submit-result.ts` 是通用转交 handler（文件头注释：per-ask schema
  校验由引擎在 port 侧完成；port 实现在 `bootstrap/src/app/workflow-driver-submit-bridge.ts`，
  服务 dynamic-workflow）。**本项不改这两个 handler**：改 submit-result 会波及 dwf actor 链路
  （越界），改 respond-to-coordinator 与 workflow_child 无关（工具根本不注册）。

### final_critic 现状

- `core/src/workflow/expert/critic-loop.ts:36-51`：`runPhase` 跑 critic 子会话 →
  `parseCriticResult`（JSON verdict：pass/fail + reasoning + acceptanceGaps + reopenProposals）→
  verdict pass 直接 `critic_passed` 返回。fail 且有 reopenProposals 时重开节点、重置 exec 与
  critic phase、重跑（迭代封顶 `strategy.finalCritic.maxIterations`，耗尽 →
  `critic_iteration_limit_reached` → phase failed）。
- 审计事实来源：graph 节点状态（done = completed/cancelled/skipped，
  `scheduler/graph.ts:14` COMPLETED_NODE_STATUSES）；节点的产物经 activity
  （`nodeId` + `artifactPath`）关联到 `snapshot.artifacts`。

### jcode 参照机制（只读提炼）

- `dag/mod.rs` HandoffArtifact：findings / evidence / edge_cases_considered / validation /
  open_questions / confidence / what_i_did_not_check；deep 模式下 findings 与
  what_i_did_not_check 必填、confidence 必须可解析——「强迫 agent 列出没查的东西」。
- `dag/ops.rs` validate_gate_pass 三段检查（most-specific first）：
  1. **StaleGateScope**：审计范围内有非 done 节点 → 拒绝 pass；
  2. **UnaddressedLowConfidence**：done 节点自报 low confidence 且未被 gate 文本按 id 点名 →
     拒绝（gate 自己的 what_i_did_not_check 不算点名）；
  3. **UncoveredSiblings**：范围 ≤ `GATE_COVERAGE_ENUMERATION_CAP`(20) 时必须点名**每个**
     done 节点；> 20 时只放宽 high-confidence 节点（medium/low/不可解析仍必须点名）。
- `mentions_node_id`：词边界匹配。id 字符 = 字母数字 + `-_.:`；前置字符是 id 字符则不算命中
  （短 id "a" 不会命中 "cat"）；结尾 `.`/`:` 只有后随 id 字符时才视为 id 的延伸
  （"checked node.a." 句尾标点算点名，"node.a.b" 是另一个 id）。
- deep/light 单引擎双预设：light 接受任意 artifact、不强制 gate；deep 才有
  artifact-or-nothing（worker 回合结束未提交 artifact → re-queue 一次、再犯 fail，
  `no_artifact_requeues` 封顶）。

## 产品规则

### R1 typed 段契约（contracts）

`WorkflowArtifactSchema` 新增可选 `typed` 段，路径式字段全部保留、语义不变：

```ts
WorkflowArtifactConfidenceSchema = z.enum(["low", "medium", "high"])
WorkflowArtifactTypedSchema = z.object({
  confidence: WorkflowArtifactConfidenceSchema.optional(),
  evidence: z.array(z.string().max(10_000)).max(200).default([]),   // 约定 file:line / commit ref / path 引用，不强校验格式
  findings: z.string().max(100_000).default(""),
  openQuestions: z.array(z.string().max(10_000)).max(200).default([]),
  validation: z.string().max(100_000).optional(),
  whatINotChecked: z.array(z.string().max(10_000)).max(200).default([]),
})
```

- schema 层全字段宽容（缺省给默认值、未知键剥离），**严格类型**由 zod 保证；
  「deep 必填」是引擎校验规则（R3），不进 schema——light 档允许部分 typed 段。
- 既有 artifacts（无 typed）解析结果与现在逐字节一致 → 完全向后兼容。
- **长度上限（对抗复核 F-4）**：单字符串字段（findings/validation）≤ 100_000 字符（约 2.5 万
  token，覆盖一切合理结论文本）；数组 ≤ 200 项；数组条目 ≤ 10_000 字符（file:line / 路径 /
  commit 引用实际远短于此，超长条目几乎必然是模型跑飞）。依据：typed 段随 run snapshot
  持久化，上限防病态模型输出把 snapshot 写爆。超限后果 = 整块 invalid（同下方 R2 解析结果
  处理：deep 烧一次 requeue 后按违规 fail，light 忽略、节点照常完成）。上限只可放宽不可
  收紧：snapshot 读取路径复用本 schema，收紧会让历史 snapshot 解析失败。上限只拦**入口**
  （response 提取时）。
- 常量导出：`WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH`(100_000)、
  `WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH`(200)、`WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH`
  (10_000)（contracts，供测试与调用方引用，避免魔法数字漂移）。

### R2 传输通道：response 里的 ```acode-artifact 围栏块

expert workflow 子会话没有 submit_result 端口（见背景），typed 段随节点完成的 response 文本
传输：response 末尾的 ```` ```acode-artifact ```` 围栏 JSON 块，**取最后一个**（末态生效）。
宽容归一化后再过 R1 schema：

- 键别名登记表（规范名 ← 别名；实现 `typed-artifact.ts` 的 `normalizeTypedCandidate`
  必须与本表**同名同集**——少一个别名 = deep 档提交该拼写时字段静默变空 → R3 判违规 →
  白烧一次 requeue、第二次直接 fail；多一个未登记别名 = 契约不可审计）：
  - `findings` ← `summary`
  - `evidence` ← `references`
  - `validation` ← `verification`
  - `openQuestions` ← `open_questions`
  - `whatINotChecked` ← `what_i_not_checked` / `what_i_did_not_check` / `what_i_didnt_check`
- loose-key 归一化（同 `expert/parsers/json.ts`：小写 + 去非字母数字）使 camelCase 拼写
  自动落到同一语义别名（`whatIDidNotCheck` / `whatIDidntCheck` 无需单列）；未登记的相似
  拼写（`wat_i_not_checked`）**不猜**，交给 zod 剥离 → 字段取默认值。
- 规范名与别名同时出现时规范名优先（`readLooseValue` 先按登记顺序做精确匹配）。
- `confidence` **仅**做大小写/空白归一（`"Low"`→`"low"`，trim 由 `readLooseString` 承担）；
  **不做** jcode `ConfidenceLevel::parse` 式自由文本档位解析（对抗复核 F-2 如实登记）。后果：
  非枚举 confidence（例如把「sloppy 但诚实的 low 自报」写成 `"pretty confident"` 或
  `"low - shaky on X"`）→ zod 拒绝 → **整块 invalid**：deep 档按 R4 白烧一次 requeue、第二次
  按违规 fail；light 档整块静默忽略，节点照常完成，typed 数据蒸发（「sloppy 但诚实的 low
  自报」在 light 档拿不到置信度债务保护——这是接受的代价，不是 bug）。宽容解析（把自由文本
  映射到 low/medium/high 档位）登记为**后续可选加固**，本轮不实现：映射规则进入契约前，
  宁可拒绝也不猜。

解析结果处理：

- **light**：块存在且有效 → 挂到该节点的 `WorkflowArtifact.typed`；块无效/缺失 → 忽略，
  节点照常完成（零回归：既有 run 的 response 不含该围栏，行为不变）。
- **deep**：见 R3/R4。

### R3 deep 薄 artifact 校验（镜像 jcode validate_artifact）

deep 档节点完成时，typed 段必须存在且非薄，违规列表（可修复文案）：

- `findings` 去空白后非空；
- `whatINotChecked` 非空数组（真查尽了才允许写 "nothing, fully covered" 这类显式条目）；
- `confidence` 在场且 ∈ low/medium/high（诚实的 low 会被路由成后续工作，不是惩罚）。

### R4 artifact-or-nothing（deep 档，封顶计数）

**强制范围 = worker 节点**：判定唯一所有者是 `isArtifactGateWorkerNode(node)`
（`core/src/workflow/artifact-gate.ts`，即 `node.kind === "task"`），node-runner 的
artifact-or-nothing 分支与 R5 的 critic 审计范围共用它，不各写一份。phase 容器节点
（`kind === "phase"`）**不强制**，即使它被当作工作单元派发——见下条边界说明。
提取与挂载不受此限：任何节点（含 phase 节点）自愿提交的合格 typed 段照样挂到
`WorkflowArtifact.typed`（强制与提取解耦，数据不浪费）。

deep 档 worker 节点回合结束未提交有效 typed artifact（缺失或 R3 违规）：

- 第 1 次：**requeue**——节点回 `pending`、`artifactRequeues` +1、`error` 记录违规文案，
  本次 activity 记 `failed`（带 error），发既有 `node_failed` 事件
  （payload `{ artifactRequeue: true, artifactRequeues, retry: true }`，**不新增事件枚举**）；
  调度器按既有 ready 语义重新派发；requeue 返回 `ok: true`，不计入 consecutiveErrors
  （它是修复通道，不是执行错误）。
- 第 2 次（`artifactRequeues` 已达封顶 `maxArtifactRequeues`，缺省 1）：节点 `failed`，
  发 `node_failed`（payload `{ artifactRequeue: true, retry: false }`），返回 `ok: false`
  计入 consecutiveErrors（与既有 error-retry 同形，error_threshold 保险丝继续生效）。
- `artifactRequeues` 是 `WorkflowGraphNodeSchema` 新增可选累计计数，reopen 不重置
  （节点级总预算，防 critic reopen 与 artifact requeue 相乘放大）。
- 重派发时 deep 档节点提示词附带上一次 requeue 的 error 反馈（修复指引）；light 档提示词
  不含任何新增段落。

### R5 critic 审计范围与点名文本

- **审计范围**：`graph.nodes` 中 `kind === "task"` 的节点。phase 节点（`phase:*`）是阶段
  容器/引擎簿记，不是工作单元，且 critic 自己的 phase 节点在裁决时尚未 done，故排除。
- **done**：状态 ∈ COMPLETED_NODE_STATUSES（completed/cancelled/skipped），与
  `scheduler/graph.ts:14` 同一集合（导出复用，不另立第二份定义）。
- **confidence 解析**：节点 → 最新一条 `status === "completed"` 且带 `artifactPath` 的
  activity → `snapshot.artifacts` 按 path 命中 → `artifact.typed?.confidence`。
- **点名文本**（critic 结论的机械化投影）：`reasoning`、`acceptanceGaps[]`、
  `reopenProposals[]`（nodeId 与 reason 都算）。匹配用 `mentionsNodeId`（词边界，
  移植 jcode mentions_node_id 语义，见背景）。

### R6 分档 gate 规则

`evaluateCriticGate`（纯函数）对 critic 的 **pass** 裁决产出 issue 列表
（kind ∈ `stale_gate_scope` / `unaddressed_low_confidence` / `uncovered_siblings`）：

| 规则 | light | deep |
| --- | --- | --- |
| stale scope：范围内存在非 done 的 task 节点 | 不检查 | 拒绝 |
| 置信度债务：done 节点 `typed.confidence === "low"` 未被点名 | **拒绝**（唯一的轻量规则） | 拒绝 |
| 覆盖债务：done 节点未被逐个点名（≤ `CRITIC_COVERAGE_ENUMERATION_CAP` = 20 全点名；> 20 只放宽 high-confidence 节点） | 不检查 | 拒绝 |

- light 档置信度债务即任务书「low-confidence 节点路由后续工作」：现有 run 无人提交 typed
  段 → 无 low 节点 → 规则不触发 → 零回归；一旦有节点诚实自报 low 而 critic 想默默 pass，
  gate 把它转成后续工作（R7）。
- fail 裁决不受 gate 约束（fail + reopenProposals 本来就是 critic 在履行职责）。

### R7 拒绝与补充通道

critic pass 被 gate 拒绝时：

1. 发既有 `critic_failed` 事件（payload 附 `gateIssues`、`preset`），**不发** `critic_passed`；
2. **置信度债务**（两档）：为每个未点名的 low 节点合成 reopen proposal
   （severity `major`，reason 说明「自报 low 且 pass 未点名」），并入 critic 自带 proposals
   去重后走**既有** reopen → 重置 exec/critic → `runScheduledPhase` 重跑通道；
   封顶由既有 `maxReopens`(2) 与 `maxIterations` 保证；
3. **覆盖/stale 债务**（deep）：不重开节点（工作本身可能没问题，薄的是审计），把 critic
   phase 重置 pending，下一轮 `runPhase` 的提示词尾部附**补充要求**（点名缺失的 node id
   清单 + 必须逐个给出结论的指令），即「拒绝并要求补充」；
4. 迭代耗尽 → 既有 `critic_iteration_limit_reached` → phase failed。

> 通道说明：任务书原文「走 respond-to-coordinator 既有通道」。经核实该工具只注册给
> `subagent_child` 会话（`runtime-tools.ts:56`），expert workflow 的 critic 子会话
> （`workflow_child`）没有该端口，也没有 mid-turn 消息注入通道；把端口接进 workflow 子会话
> 需要改 bootstrap/runtime 装配（本项所有权边界外）。引擎侧的等价修复通道 = critic-loop
> 既有迭代重跑 + 下一轮提示词携带违规清单，与 submit_result reject→violations→同会话修复
> 的语义同构（拒绝理由存活到模型可见的下一轮输入）。

### R8 deep 档提示词契约（light 档字节不变）

- deep 节点提示词（`buildScheduledNodePrompt` / `buildDefaultNodePrompt`）尾部追加 typed
  artifact 契约：围栏标签、字段形状、R3 三条必填规则、缺失后果（requeue 一次后 fail）；
  `artifactRequeues > 0` 时附带上次 requeue 的 error 反馈。
- **契约段与强制范围必须一致**（不告知就不判违规）：`buildScheduledNodePrompt` 对
  `kind === "phase"` 且属于本阶段的节点早退到 `buildPhasePrompt`，该分支只在
  `behavior === "critic"` 时追加 deep 段，因此 phase 容器节点的提示词**不含**契约段与
  requeue 反馈段——对应地 R4 的强制也**不覆盖**它。二者由同一个
  `isArtifactGateWorkerNode` 口径保证同进同退。
- deep critic 提示词（`buildPhasePrompt`，仅 `behavior === "critic"`）追加：必须按 id 点名
  每个 done 节点并给出结论；附当前 done task 节点清单（id/status/confidence）。
- **light 档（含未声明 gatePolicy 的全部既有 definition）所有提示词与现状逐字节一致。**

### R9 preset 声明（workflow definition 可选字段）

```ts
WorkflowGatePresetSchema = z.enum(["light", "deep"])
WorkflowGatePolicySchema = z.object({
  maxArtifactRequeues: z.number().int().nonnegative().optional(),  // deep 缺省 1
  preset: WorkflowGatePresetSchema.default("light"),
})
WorkflowDefinitionSchema += { gatePolicy: WorkflowGatePolicySchema.optional() }
```

- 内建 expert definition **不声明** gatePolicy → light（零回归的结构性保证）；
- deep 只属于 definition 作者（用户目录 definition JSON）；
- 解析入口唯一：`resolveWorkflowGateSettings(definition)`（core/workflow/artifact-gate.ts），
  critic-loop / scheduled-phase / prompts 都从它取，不各自读 raw 字段。

### R10 dynamic-workflow 边界

`packages/dynamic-workflow*`、`bootstrap/src/app/workflow-driver*`、
`core/src/tool/handlers/submit-result.ts`、`respond-to-coordinator.ts` 一律不动。
dwf 脚本编排有自己的类型化 ask 结果系统（per-ask schema + SubmitViolation 修复通道），
typed artifact 契约先落 expert workflow，验证后再评估推广（方案文档 §J2-3 目标设计）。

### R11 planner 输出节点 id 防护（对抗复核 F-1）

planner/seed 输出的节点 id 一律 `z.string().trim().min(1)`（`WorkflowGraphPlannerNodeSchema.id`；
`WorkflowGraphSeedSchema` 复用同一节点 schema，自动同规则）：

- **动机（缺陷链，对抗复核实证）**：schema 仅 `z.string()` 时，planner 输出
  `{"nodes":[{"id":"","title":"x"}]}` 直接通过 `parseWorkflowPlannerResult` 的 direct 解析 →
  空 id 节点进图 → deep 档 critic gate 的 `mentionsNodeId(text, "")` 恒 false → 任意
  coverageTexts 都判 uncovered_siblings → critic 永不 pass → maxIterations 耗尽 phase failed
  （确定性死路）。seed 路径的 `normalizeWorkflowGraphSeedNode` 本就经 `stringValue` trim 后
  滤空白（`expert/parsers/graph-seed.ts`），direct 路径没有等价防护。
- **消费面核查（路线依据）**：`WorkflowGraphPlannerNodeSchema` 只出现在 **planner LLM 输出
  解析**的四个点——`expert/parsers/planner-result.ts`（direct + 宽容 fallback）、
  `scheduler/planner-expansion.ts`（扩张前再校验）、`expert/parsers/graph-seed.ts`（seed 归一）、
  `lifecycle.ts` `applyWorkflowGraphSeed`（内存 seed 再 parse）。持久化解析走独立的
  `WorkflowRunSnapshotSchema` / `WorkflowGraphNodeSchema` / `WorkflowGraphRecordSchema`
  （id 仍为 `z.string()`，不动）——因此直接在 schema 上 `.trim().min(1)` **不会拒历史数据**，
  无需只在解析点过滤。
- **语义**：`"  abc  "` → trim 为 `"abc"` 入图（与 seed 路径 `stringValue` 同口径，id 身份稳定）；
  `""` / `"  "` → schema 拒绝。`parseWorkflowPlannerResult` 在 direct 解析前**显式探测**空白
  id（宽松键 `nodes`/`newNodes`/`new_nodes` + `id`/`name`/`nodeName`/`node_name`，值 trim 后
  为空字符串），命中即抛「blank node id」解析错误——**fail-loud 不静默丢弃**：schema 拒绝后
  若落入宽容 fallback，会被 seed 归一化静默滤掉，「进图死路」变成「静默蒸发」。id 键整体缺失
  仍按既有宽容归一化丢弃（乱入 junk 对象，不属本条范围）。
- **fail-loud 通道（不新增事件枚举）**：解析错误沿既有通道可见——scheduled-phase 的
  plannerRunner 抛出 → collection-planner catch → 既有 `planner_failed` 事件（errorCount+1，
  达 error_threshold 后 collection exhausted，与既有 planner 错误重试同形）；
  `applyPlannerExpansion` 的 schema 再校验抛错包装为可读的
  「Planner returned an invalid graph expansion」，同样落 `planner_failed`。
- **两档行为一致**：入口防护与 gate 分档无关（light/deep 同样拒绝）；差别只在无防护时的后果
  严重性——deep 是 critic 确定性死路（本条主缺陷），light 只是图里多一个不可点名的脏节点。

## 状态所有权

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| `WorkflowArtifact.typed` | run snapshot（store 持久化） | 节点完成时一次写入；addArtifact 按 path 去重覆盖 → 重跑后末态生效 |
| `WorkflowGraphNode.artifactRequeues` | graph 节点记录 | 累计、reopen 不重置；只被 node-runner 的 artifact-or-nothing 路径写 |
| gate 设置 | workflow definition（`gatePolicy`） | **以 resume 时 definition 文件为准**（对抗复核 F-3 口径修正，原「run 内不变」无结构性保证）：preset 不持久化进 run snapshot，resume 经 `resolveWorkflowDefinition` 重读 definition 文件（`workflow-facade.ts` `workflowRuntimeForLookup` → `workflowDefinitionStore.readDefinition`），跨进程「暂停 → 改 gatePolicy → resume」会**静默切换 preset**。切换后果：light→deep——已 done 的 task 节点没有 typed confidence，deep 覆盖债务要求对它们全量点名（≤cap 时一个不漏），stale scope 还会拒绝尚有 pending task 节点的 pass；deep→light——强制放松，已累计的 `artifactRequeues` 与违规历史保留，但不再产生新的强制。`resolveWorkflowGateSettings` 单点解析不变。**后续加固项（登记，本轮不实现）**：把解析后的 gate 设置持久化进 run snapshot（`WorkflowRunSnapshotSchema` 增 gatePolicy 投影），resume 时以 run 快照为准、definition 文件仅供建 run |
| gate 裁决 | 纯函数 `evaluateCriticGate` / `validateDeepNodeArtifact` | 无状态；critic-loop / node-runner 调用并落事件（`critic_failed` / `node_failed` payload） |
| 补充要求（supplement request） | critic-loop 迭代内局部变量 | 不落盘；每轮重新评估，跨 resume 不需要恢复（resume 后 critic 重跑即重新点名） |

事件顺序（deep，critic 覆盖债务）：
`critic_started` → (子会话) → `critic_failed{gateIssues:[uncovered_siblings]}` →
critic phase 重置 pending → 下一轮 `critic_started` → …（点名齐全）→ `critic_passed`。

事件顺序（deep，artifact-or-nothing）：
`node_started` → (子会话无 typed 块) → `node_failed{artifactRequeue:true,retry:true}` →
`node_started`（重派发，提示词带反馈）→ (仍无) → `node_failed{artifactRequeue:true,retry:false}`
→ 节点 failed（attempts 语义不变，error_threshold 保险丝继续生效）。

## 接口

contracts（`contracts/src/workflow/index.ts`，全部新增导出）：
`WorkflowArtifactConfidenceSchema/…Confidence`、`WorkflowArtifactTypedSchema/…Typed`（含 R1
长度上限）、`WORKFLOW_TYPED_ARTIFACT_TEXT_MAX_LENGTH`、`WORKFLOW_TYPED_ARTIFACT_LIST_MAX_LENGTH`、
`WORKFLOW_TYPED_ARTIFACT_ITEM_MAX_LENGTH`、`WorkflowGatePresetSchema/…Preset`、
`WorkflowGatePolicySchema/…Policy`；
`WorkflowArtifactSchema.typed?`、`WorkflowDefinitionSchema.gatePolicy?`、
`WorkflowGraphNodeSchema.artifactRequeues?`；
`WorkflowGraphPlannerNodeSchema.id` 收紧为 `z.string().trim().min(1)`（R11/F-1，
`WorkflowGraphSeedSchema` 经复用同规则；持久化节点 schema 不变）。

core（`core/src/workflow/`）：

- `typed-artifact.ts`：`TYPED_ARTIFACT_FENCE`、`extractTypedArtifact(response)` →
  `{ok:true,typed} | {ok:false,reasons[]} | null`（无块）、`validateDeepNodeArtifact(typed)` →
  违规文案数组、`typedArtifactContractLines()`（提示词契约段）。
- `artifact-gate.ts`：`mentionsNodeId(text,id)`、`CRITIC_COVERAGE_ENUMERATION_CAP`(20)、
  `DEFAULT_MAX_ARTIFACT_REQUEUES`(1)、`resolveWorkflowGateSettings(definition)`、
  `isArtifactGateWorkerNode(node)`（R4 强制范围与 R5 审计范围共用的唯一判定）、
  `collectCriticAuditScope(snapshot)`、`collectCriticCoverageTexts(critic)`、
  `evaluateCriticGate({coverageTexts,preset,scope})` → `CriticGateIssue[]`。
- 修改：`scheduler/graph.ts`（导出 COMPLETED_NODE_STATUSES；updateGraphNode patch 扩
  `artifactRequeues`）、`scheduler/types.ts`（run options 增 `artifactGate?`）、
  `scheduler/node-runner.ts`（R2-R4 + typed 挂载）、`scheduler/prompts.ts` 与
  `expert/prompts.ts`（R8，light 字节不变）、`expert/phase-runner.ts`（透传 prompt 附加段）、
  `expert/scheduled-phase.ts`（下传 artifactGate）、`expert/critic-loop.ts`（R6/R7）。

## 验收场景（tests/workflow-typed-artifacts.test.mjs）

- **A 契约向后兼容**：无 typed 的既有 artifact JSON 解析不变；带 typed 解析成功；
  非法 confidence 拒绝；definition 无 gatePolicy 解析输出与现状一致；带 gatePolicy deep 可解析；
  typed 段超限（findings > 100k / 数组 > 200 项 / 条目 > 10k）→ 整块 invalid（R1/F-4）；
  带空白两侧的 planner 节点 id 被 trim 入图、空白 id 被拒（R11/F-1）。
- **B 词边界匹配**："a" 不命中 "cat"；`node.a.` 句尾命中 `node.a`；`node.a.b` 不命中
  `node.a`；精确命中；连字符/下划线/冒号 id。
- **C gate 纯函数**：deep 橡皮图章（未点名全部 done 节点）→ uncovered_siblings；
  low-confidence 未点名 → 两档都出 unaddressed_low_confidence；点名后通过；
  >20 节点时 high-confidence 可豁免、medium 仍须点名；stale scope（deep）；light 无
  stale/coverage issue。
- **D artifact-or-nothing（scheduler 端到端，fake runner/store）**：deep 首次缺块 → requeue
  （pending + artifactRequeues=1 + node_failed retry:true）；第二次缺 → failed + retry:false；
  deep 有效块 → completed 且 artifact.typed 落 snapshot；deep 薄 artifact（findings 空 /
  whatINotChecked 空 / confidence 缺）→ requeue；light 无块 → completed（回归）。
  R2 别名登记表逐条生效（含 `what_i_didnt_check` 与 camelCase 变体 → `whatINotChecked`
  非空且 deep 校验零违规）、规范名优先于别名、未登记的相似拼写不被猜成别名；
  deep + **回退派发的 phase 容器节点**（`executableNodeIdsForPhase` → `["phase:exec"]`，
  提示词无契约段）→ 照常 completed、`artifactRequeues` 不产生、无 node_failed，
  同一 gate 下 task 节点仍 requeue→fail（强制没有被整体关掉），phase 节点自愿提交的
  合格 typed 块仍挂载到 artifact；
  超限 typed 块（F-4）：deep → 按 invalid 走 artifact-or-nothing（requeue 一次后 fail），
  light → 整块忽略、节点照常 completed；
  confidence 非枚举自由文本（F-2 登记的后果钉住）：deep → 整块 invalid → requeue；light →
  块忽略、节点 completed、无 typed 挂载。
- **E critic-loop / 全流程**：light 八阶段端到端（橡皮图章 pass、无 typed）→ 事件序列与
  终态和现状一致（critic_passed、run completed）——零回归钉住；light + low-confidence
  未点名 → pass 被拒、节点被 reopen、exec 重跑；deep + 橡皮图章 → 拒绝 + 补充要求 +
  第二轮点名齐全 → critic_passed；deep + low-confidence 未处理 → gate 不通过；
  deep + **exec 阶段无 task 节点**（arch_decompose 未产出可解析图 → 回退派发 phase
  容器节点）→ run completed、exec phase completed、无 node_failed（修复前是
  requeue→fail→`scheduler paused`→run paused）；light 同场景 completed（语义未变）；
  deep + 正常 seed 出 task 节点 → worker 强制照旧生效。
- **F 提示词回归**：light 档三个 prompt builder 输出与现状逐字节一致（快照）；deep 档
  包含契约段与 requeue 反馈。
- **G planner 输出空白 id 防护（R11/F-1）**：`parseWorkflowPlannerResult` 喂
  `{"nodes":[{"id":"","title":"x"}]}` / `"  "` id / 合法节点混空白 id → 解析报错（fail-loud，
  不静默丢弃）；schema 层空白 id 被拒、`" abc "` trim 为 `"abc"`；`applyPlannerExpansion`
  对含空白 id 的扩张抛可读错误；E2E deep：collection planner 首轮返回空白 id 节点 →
  `planner_failed` 事件在场、空白节点从未进图、随后正常扩张照常跑完 run；E2E light 同场景
  同防护（fail-loud 与分档无关）；deep critic 对干净图可 pass（E3 已钉）。

## 边界与非目标

- 不动：dynamic-workflow、bootstrap 装配、submit-result / respond-to-coordinator handler、
  todo / bash / permission / compact / memory / doctor。
- 不新增事件枚举（UI 事件时间线零改动）；`typed` 为可选段，UI 展示不在本项范围。
- phase 级 agent 产物（clarify/task_analysis 等）不强制 typed 段：artifact-or-nothing 只约束
  scheduled graph 的 worker 节点（jcode deep 亦只对 worker 强制）。这条边界必须覆盖
  **回退派发**的形态：scheduled 阶段没有 task 节点时（例如 arch_decompose 那一轮没产出
  可解析的图，`seedGraphFromPhaseArtifact` 原样返回），`executableNodeIdsForPhase`
  （`expert/ids.ts:15`）回退派发 phase 容器节点，它跑的就是一次 phase 级 agent 回合
  （提示词 = `buildPhasePrompt`，无契约段），因此同样不强制——否则 deep 档该场景是
  「强制但不告知」的确定性 requeue→fail，整个 run 停在 `scheduler paused`（light 档
  不强制，既有 run 不受影响）。判定见 R4 的 `isArtifactGateWorkerNode`。
- `evidence` 的 file:line 格式不做机器校验（jcode 同为「引用而非断言」的自由文本数组），
  由提示词约定。
- typed 段长度上限（R1，F-4）只拦 response 提取入口；上限参数只可放宽不可收紧（snapshot
  读取路径复用同一 schema，收紧会让既有 snapshot 解析失败）。
- **快照写并发窗口（对抗复核 F-4 登记，独立后续项，本轮不修）**：`scheduler/node-runner.ts`
  的 `getSnapshot → await writeSnapshot → setSnapshot` 序列存在既有并发债——同节点 requeue
  /完成路径与其它写者交错时，后写者可能基于过期快照互相覆盖窗口内的字段更新；既有 fail-safe
  方向是 deadlock paused（不会让 run 假完成），但窗口内更新可能回滚。该债务属 scheduler 并发
  语义（与 artifact-gate 无关），**另立项处理**，本轮不动 scheduler 并发时序。
- planner 输出的 id 键**整体缺失**（非空白字符串）仍按既有宽容归一化丢弃（R11 只拦「键在场
  但值空白」）；planner 输出空白 **edge** 端点由既有 `validateNewEdges` 的 unknown-node 检查
  拒绝（fail-loud 已有）。
