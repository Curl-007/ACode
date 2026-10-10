# Swarm 编排可观测投影（编排方案 Phase 2 / ②）

来源：[`docs/codex-orchestration-integration-plan.md`](../../../docs/codex-orchestration-integration-plan.md)
§4 Phase 2，经 2026-10-10 对照审计复核（模板全部健在、swarm 四表面零命中确认）后实施。
参照机制：Codex app-server 统一事件面（core → app-server → 前端订阅）。只搬运机制设计。

**分批**：本 spec 覆盖 **P2a 投影链**（contracts 事件 + shared 状态键族 + core 追加方法 +
bootstrap 发射/投影/冷回放）。**P2b GUI 合流**已另行立项并实施（2026-10-11，`db91911`，
规则见 [`packages/ui/specs/orchestration-side-pane.md`](../../../packages/ui/specs/orchestration-side-pane.md)：
packages/ui 把 `subagents` / `workflowRuns` / `swarmPlan` 三键合成统一编排 side pane，
零协议改动；TUI 镜像登记为该 spec 取舍 #2 的后续项——「共用同一 reducer」的纪律已由
shared 单一归约实现保证）。

## 背景（已核实的现状，行号以 dev/0.0.7 @ 372f40f 为准）

- swarm 在 packages/shared、packages/ui、packages/rpc、apps/acode-cli/packages/tui 四处
  源码零命中（审计 C2，含对照组验证）——v4 协议面与 GUI 完全没有 swarm。
- 已有持久化+冷恢复的一半：`swarm_plan` 行（migration 0026）、plan-store hydrate（含
  running→queued 复位，`core/src/swarm/plan-store.ts:154-177`）、wiring hydrate
  （`bootstrap/src/app/swarm-plan-runtime.ts:206-216`）。缺的只是投影链。
- 纯函数投影已存在：`core/src/swarm/projection.ts:62` `buildSwarmPlanStatus`
  （counts/goal/mode/readyGateIds/readyWorkerIds/stalledNodeIds/terminalState/nodes/
  noArtifactRequeues/version），PlanStatus 工具面与 runtime-task 投影共用同一份推导。
- 现有可见面只有三个：PlanSeed/PlanStatus/PlanControl 模型工具、system-reminder 源
  `swarm_plan_status`、runtime-task registry 进程内条目（description 文本摘要）。
- dwf 同名模板全部健在（审计逐条核实）：`shared/src/acode-protocol-v4/workflow-runs.ts`
  状态键家族、`snapshot.ts:483-487` optional 键 wire 兼容注释模式、contracts
  `session.events.ts` 带前缀事件命名（`dynamic_workflow_run_progress`）、core
  `dynamic-workflow-run-progress.ts` 追加方法（rootTraceContext、不冒领 turn）、
  bootstrap `product-projection.ts onDynamicWorkflowRunProgress`（reduce→delta）、
  `v4-bridge.ts replayDynamicWorkflowRunEvents`（冷回放前置到内存事件之前）。

## 产品规则

**R1 专用状态键，不翻译进 dwf 词表**（方案 §7②）。新增 v4 会话快照状态键 `swarmPlan`：
`swarmPlanStateSchema.nullable().optional()`——optional 只服务旧快照 wire 兼容（新 CLI
恒携带该键，`snapshot.ts:483-487` 注释先例）；null = 当前无 plan（清除后/从未 seed）。
swarm 的 gate 对抗审计与 gap 注入循环在 dwf 词表无一等对应物，硬塞会失真。

**R2 事件：一次 plan 提交一条 `SwarmPlanProgress`。**
- 命名 `swarm_plan_progress`，刻意带前缀（与 `dynamic_workflow_run_progress`、legacy
  script workflow 的 `workflow_started/completed` 三方不混淆，`session.events.ts` 先例）。
- 载荷 = **有界状态视图全量**：`buildSwarmPlanStatus` 的完整推导（counts/goal/mode/
  readyGateIds/readyWorkerIds/stalledNodeIds/terminalState/nodes 视图/noArtifactRequeues/
  version）+ `createdAtMs`（代际键）+ `cleared` 标志。plan 清除（onChange plan=null）发
  `cleared:true`。
- 与 dwf 的**结构差异及理由**：dwf 是 append-only journal + 细粒度引擎事件流（reducer 逐条
  归约、节点级 delta 防 O(N²)）；swarm 的权威态是 plan 行本身、提交由 plan-store 单点
  串行化、频率是「模型改图 + 节点状态迁移」量级（每会话数十次，远低于 dwf 每 ask 一条）。
  因此载荷携带全量状态视图、归约是「代际+版本去重后的整体替换」——协议更简单，冷回放
  只需一条合成事件，且全量替换语义**天然自愈**（丢一帧不产生永久漂移）。
- **v4-only**：`shouldExposeSessionEventToProtocol`（v3 面）剥离该事件，legacy 协议只删不增。

**R3 归约本体在 shared，一处实现。** `reduceSwarmPlanState(prior, envelope)` 纯函数：
- `cleared` → `null`（清除是代际终局）；
- 同代际（`createdAtMs` 相等）且 `version <= prior.version` → 返回 `null`（乱序/重复/重放
  不产 delta、revision 不抬——dwf reducer 的同款语义）；
- 其余 → 接受为新的整体状态。
桌面 product-projection、冷回放、P2b 的 TUI 镜像与 GUI 共用这一份（两处各写一份就是两个
时钟，`workflow-runs-reducer` 文件头纪律）。

**R4 投影：键级整体替换 delta。** `product-projection` 加 dispatch case + `onSwarmPlanProgress`
（取载荷 → shared reducer → `state.updated` patch `{ swarmPlan }`，`backgroundWorks` 同款
整体替换先例）。reducer 返回 null 时不产 delta。节点级 diff **不做**（见「未做与取舍」#2）。

**R5 冷回放与重启前逐字节一致。** v4-bridge hydrate 时：经 app facade 从 `swarm_plan` 行读
plan（`SwarmTaskPlanSchema` 校验，坏行跳过 + warn）→ 同一份 `buildSwarmPlanStatus` 推导 →
合成一条 `SwarmPlanProgress` 载荷（`timestamp=new Date(0)`、HYDRATION_TRACE_ID、前置到内存
事件之前，`replayDynamicWorkflowRunEvents` 同款形状）。投影经**同一个 reducer** 归约，
`swarmPlan` 键因此在重启前后一致（`dynamic-workflow-run-introspection.ts:283-296`
「逐字节相同」纪律）。内存事件里已有同代际更新版本时，回放事件被 R3 去重吸收。

**R6 发射点 = 既有 onChange 观测口，追加走 core 方法。**
- `swarm-plan-runtime.ts` 的 `onChange`（abort 推导与 runtime-task 同步的同一个点）追加：
  经绑定 runtime 调 `recordSwarmPlanProgress`；`hydrate()` 后与 `syncSwarmPlanRuntimeTask`
  同点显式补发一次初始态（hydrate 不触发 onChange 的既有纪律）。
- core 新增 runtime 方法 `recordSwarmPlanProgress`（照 `recordDynamicWorkflowRunProgress`：
  `rootTraceContext`、turnId 为空、不冒领任何一轮——run 事件属于 plan，不属于对话轮）。

**R7 有界性（wire 上限，shared limits 常量单点）。**
- nodes 视图 ≤ 512 条（超限截断 + `truncated:true` 置位；原始事实仍在 plan 行，与
  workflow-runs 的 `truncated` 语义同款）；
- 节点 `content` 只带 preview ≤ 160 字符（GUI 详情走 PlanStatus 工具面/后续查询面，不在
  投影键里背 20k 全文）；
- goal ≤ 5000、id ≤ 200、dependsOn 上限对齐 contracts swarm schema（`SWARM_MAX_NODE_DEPENDS`）；
- readyGateIds/readyWorkerIds/stalledNodeIds 各 ≤ 512。

**R8 失败语义：投影永不反噬图。** `recordSwarmPlanProgress` 失败（appendEvent 抛错）→
catch + warn，plan 提交与节点调度照常（观察面纪律，`notifyRunStalled` 「绝不抛异常」同款）；
下一帧全量状态自愈。冷回放读取/解析失败 → 跳过（`swarmPlan` 缺席，warn 留痕）。

## 状态所有权

| 状态 | 唯一所有者 | 其他层如何访问 |
| --- | --- | --- |
| plan 图本体 | core plan-store（既有，不变） | 工具面 / onChange |
| 状态视图推导 | `buildSwarmPlanStatus`（core，纯函数，既有） | 事件载荷 / 冷回放共用 |
| `swarmPlan` 投影键 | product-projection（经 shared reducer） | v4 snapshot/delta 流 |
| 事件流 | session event store（既有） | v4-bridge / listEvents |
| 冷回放事实源 | `swarm_plan` 行（migration 0026，既有） | app facade 读取口 |

## 接口

- **contracts**：`SessionEventType.SwarmPlanProgress = "swarm_plan_progress"`；
  `SwarmPlanProgressPayload`（有界字段 + `cleared` + `createdAtMs` + `version`；字段与
  shared schema 同形——「一次序列化、两个消费者」纪律，v3 面剥离）。
- **shared**：`acode-protocol-v4/swarm-plan.ts`（`swarmPlanStateSchema` + `SWARM_PLAN_LIMITS`
  + `reduceSwarmPlanState`，schema/limits/reducer 分文件对齐 workflow-runs 家族形态）；
  `conversationSnapshotSchema` 加 `swarmPlan` optional 键；delta 的 state patch 键集同步。
- **core**：`recordSwarmPlanProgress`（runtime 方法，internal-methods 登记 + methods/index
  挂 proto + AgentRuntime 公开面透出，照 recordDynamicWorkflowRunProgress 的接线形状）。
- **bootstrap**：`swarm-plan-runtime.ts` onChange/hydrate 发射；app facade 增
  `readSwarmPlanStatus()`（冷回放读取口，返回有界载荷或 undefined）；`product-projection.ts`
  dispatch case + handler；`v4-bridge.ts` `replaySwarmPlanEvent` 前置合成。

## 事件顺序与幂等

```
seed/commit → plan-store 提交（单点串行） → onChange
  ├─ abort 推导（既有） ├─ runtime-task 同步（既有） └─ recordSwarmPlanProgress（新）
       └─ appendEvent(SwarmPlanProgress) → event store → product-projection reduce → delta
崩溃/重启 → v4-bridge hydrate：swarm_plan 行 → buildSwarmPlanStatus → 合成事件前置
  → 同一 reducer → swarmPlan 键与重启前一致（内存中更新版本在场时被 R3 去重吸收）
清除 → onChange(plan=null) → cleared:true → 键置 null
幂等键 = (createdAtMs, version)；同代际 version 去重，跨代际整体接受
```

## 验收场景（P2a）

1. seed/commit 后，v4 客户端收到 `state.updated` 且 `swarmPlan` 与 `buildSwarmPlanStatus`
   推导一致（counts/nodes/readyGateIds/stalledNodeIds/terminalState/version）。
2. 重启冷回放：hydrate 后的 `swarmPlan` 键与重启前最后一次投影**逐字节一致**（同一 reducer）。
3. plan 清除 → `swarmPlan` 为 null；再 seed（新代际）→ 键恢复且不被旧代际 version 挡掉。
4. 乱序/重复载荷（同代际 version ≤ prior）不产 delta、revision 不抬。
5. 超限 plan（>512 节点）载荷有界：nodes 截断 + `truncated:true`。
6. `recordSwarmPlanProgress` 抛错（模拟 appendEvent 故障）：plan 提交与调度不受影响，warn 留痕。
7. v3 面剥离：`shouldExposeSessionEventToProtocol` 不含 SwarmPlanProgress（负向断言）。
8. wire 兼容：不含 `swarmPlan` 键的旧快照照常解析（optional 负向断言）；shared 状态键家族
   不 import contracts（依赖方向守护）。

## 未做与取舍

1. **不翻译进 dwf 词表**（R1，方案 §7② 原样）。
2. **不做节点级 delta**：整体替换的尺寸账 = 提交频率（每会话数十次）× 有界状态（典型
   ≤10KB、上限 ~100KB），远低于 dwf 需要节点级 diff 的 O(N²) 场景；`backgroundWorks`
   整体替换是既有先例。reducer/diff 分层已留出升级位（delta op 不变，仅 diff 实现替换）。
3. **不做 cursor 查询面**（`session/subagents` 三件套形态）：GUI 合流批次（P2b）按面板需要
   再立项，避免预设计查询形状。
4. **P2b GUI/TUI 不在本批**：三键合流的统一编排 side pane、移动端布局与主题合规需要
   DESIGN.md 评审；协议与投影先行，GUI 消费随后（分层交付，先例见「分批」）。
   **后续**：GUI 合流已实施（`db91911`，packages/ui/specs/orchestration-side-pane.md）；
   TUI 镜像仍为登记后续项。
5. **system-reminder 源不动**：`swarm_plan_status` 是模型可见面，与用户可见投影是两个
   消费者，不合并。
