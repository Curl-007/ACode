# 子代理交互请求 origin 的谱系补全（R5/R6，编排方案 Phase 4 拆分单元）

来源：[`docs/codex-orchestration-integration-plan.md`](../../../docs/codex-orchestration-integration-plan.md)
§4 Phase 4 B「origin 归属（可拆后续 PR）」与 §5 R5 行（归属退化：origin 只留最内层、
parentSessionId 指向客户端不可见会话）。嵌套放开（maxDepth>1，
[`subagent-nesting-budget.md`](subagent-nesting-budget.md)）后该退化成为现实缺陷：
根视图的 GUI 拿 `origin.parentSessionId` 无法定位任何可见会话，交互请求的归属链断裂。

## 背景（已核实的现状，基线：当前检出，行号实施前需复核）

- origin 是**单层扁平结构**：`SubagentInteractionRequestOrigin`
  （`contracts/src/interfaces/shared.ts:17-27`）只有发起者（agentId/agentType/
  childSessionId）+ 直接父（parentSessionId/parentToolCallId/parentTurnId）。
- broker 包装链每嵌套一层叠一个（`child-client-ports.ts:44-58` deriveChildClientPorts
  唯一出口，父 runtime 调用、parentSessionId 父自填）；合并语义
  （`subagent-interaction-broker.ts:25-38`）：**sessionId 外层后写**（任意深度最终
  = 根会话，客户端可路由）；**origin 保留内层已有值**（`request.origin ?? build`，
  归属永远是真正发起者）。两个方向都对——缺的只是中间层谱系事实。
- 第二个 origin 构造点 `tool-event-mirror.ts:70`：镜像工具事件按层落**直接父**会话
  事件流，其 origin 的 parentSessionId 就是事件流所在会话，逐层语义本来就正确，
  **不在本 spec 范围**。
- 协议校验面：`packages/shared/src/acode-protocol-legacy-types.ts:178-190`
  `acodeInteractionRequestOriginSchema` 是 **`.strict()`**，被 v4 snapshot
  （`acode-protocol-v4/snapshot.ts:236/:282`）、legacy 反向 RPC（`bots.ts:479`）共用；
  只改 CLI 侧类型不改 shared schema，新字段过协议边界会被整包拒绝
  （先例注释：`interaction-broker.ts:174`「strict，旧桌面多一个字段就丢事件」）。
- 消费方：`product-projection.ts:3903-3910` 用 `origin.childSessionId` 收集
  `waitingChildIds`，驱动根视图 subagent 行的 waiting 状态（`:3929-3933`）——
  depth≥2 时最内层 childSessionId 不在根视图的行集合里，而真正等待中的**直接子**
  （中间层，其子树被交互请求阻塞）不会被标记。UI 徽章
  （`packages/ui/src/InteractionRequestOriginBadge.tsx`）只显示 agentType。

## 产品规则

**R0 缺省面零变化（机械保证）。** 新字段只在**请求实际穿过 ≥2 层 broker 包装**时
出现；maxDepth 缺省 1 = 全树只有一层包装 = origin 与现状逐字节一致（无
`ancestors`/`rootSessionId` 键，负向断言）。也因此旧客户端在缺省配置下**永远不会**
遇到带新字段的 strict schema 载荷——版本偏斜安全性由「嵌套是显式解锁的 flag」承担，
不需要协议版本协商。

**R1 谱系事实 = `ancestors[]` + `rootSessionId`（additive 可选字段）。**
- `ancestors[]`：请求穿过的祖先层，**内→外**排序；每层携带该层 agent 的
  `{agentId, agentType, sessionId, parentSessionId, description?, parentToolCallId?,
  parentTurnId?}`——即该层自己的 origin 视角。
- 不变量（测试断言）：`ancestors[0].sessionId === origin.parentSessionId`；相邻层
  `prev.parentSessionId === next.sessionId`；末层 `parentSessionId === rootSessionId`。
  客户端由此能把发起者一路链回自己认识的根会话。
- `rootSessionId`：客户端可见的根会话（= 外层最后改写出的 sessionId 同值）。

**R2 合并单点在 broker，builder 不动。** 最内层照旧 `buildSubagentInteractionOrigin`
（发起者扁平视角，不 append 自己——它是 origin 主体不是祖先）；外层 broker 见到
`request.origin` 已存在时 append **自己的 context** 为一层并覆写 `rootSessionId =
context.parentSessionId`。`buildSubagentInteractionOrigin` 与 tool-event-mirror
调用点零改动。

**R3 根锚定是机械保证，不需要树知识。** 与 sessionId 改写同款「外层后写」纪律：
每层只覆写为自己看到的 parentSessionId，最外层（直接包根 broker 的那层）最后写，
其 parentSessionId 必然是根会话。任意深度自动正确，无查表、无递归、无对
rootSessionId config 字段的依赖（该字段是 runtime 谱系事实，broker 链不读它——
两个来源会漂移，取机械可证的那个）。

**R4 协议波及 = shared strict schema 同步 additive。** `acodeInteractionRequestOriginSchema`
增 `ancestors`（内层对象亦 strict，字段与 R1 一致）与 `rootSessionId` 可选字段；
新 schema 同时接受新旧两种载荷（additive 可选 = 旧 snapshot/旧 CLI 回放不受影响）。
CLI contracts 类型与 shared schema 字段一一对应（两处都是唯一真源的一部分：
CLI 侧构造、shared 侧校验）。

**R5 消费面本批只修正确性缺口。** `product-projection` 的 waitingChildIds 同时收集
`origin.ancestors[].sessionId`——depth≥2 时根视图的直接子行正确进入 waiting 状态
（发起链整体在等一次授权）。UI 徽章的谱系展示（链式 tooltip「发起者 ← 中间层 ← 根」）
**不在本批**：归 P2b GUI 批次（需要 DESIGN.md/i18n 纪律），数据面先行。

## 状态所有权

| 状态 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 谱系 append | broker 包装链（每层只写自己） | 单点合并，无共享可变状态 |
| rootSessionId | 最外层 broker（后写覆盖） | 机械保证，不读 config 谱系字段 |
| 校验 schema | packages/shared（唯一 wire 真源） | CLI contracts 类型与之对齐 |
| waiting 标记 | product-projection（既有 owner） | 只是收集面扩到 ancestors |

## 接口

- **CLI contracts**（`interfaces/shared.ts`）：`SubagentInteractionOriginAncestor`
  新接口 + `SubagentInteractionRequestOrigin` 增两个可选字段（R1 注释含不变量）。
- **core**（`runtime/helpers/subagent-interaction-broker.ts`）：合并逻辑（R2/R3），
  纯函数 append，无新依赖。
- **shared**（`acode-protocol-legacy-types.ts`）：schema additive 扩展（R4）。
- **bootstrap**（`product-projection.ts`）：waitingChildIds 收集面（R5）。

## 事件顺序与幂等

```
最内层子 C 发起 permission/AskUserQuestion/ExitPlanMode
  → broker(context-C)：origin 缺席 → build 扁平 origin(C)，不 append（R2）
  → broker(context-B)：origin 在场 → append B 层，rootSessionId=SB 的父 SA
  → broker(context-A)：append A 层，rootSessionId=R（外层后写，R3）
  → 根 broker → interaction-broker.ts：sessionId=R 路由客户端，origin 全链随行
  → v4/legacy wire：shared strict schema 校验（R4）
  → product-projection：waitingChildIds = {C} ∪ {SB, SA}（R5，根视图 A 行 waiting）
幂等：每层 append 一次（包装链每请求各走一遍）；无持久化、无重放面
```

## 验收场景

见 `apps/acode-cli/tests/subagent-interaction-origin-lineage.test.mjs` 与
`packages/shared/test/interaction-origin-schema.test.ts`（实施时落地）：

1. depth1：origin 与现状逐字节一致——无 `ancestors`/`rootSessionId` 键（R0 负向断言）；
   sessionId 改写行为不变。
2. depth2：扁平发起者 + `ancestors=[父层]` + `rootSessionId=根`；R1 三条不变量成立。
3. depth3：ancestors 内→外序、链路连续、末层 parentSessionId === rootSessionId；
   任意层数下 sessionId 最终 = 根（外层后写回归）。
4. 调用方预置 origin（内层已有值）：外层仍 append、不覆盖发起者（?? 语义回归）。
5. builder/mirror 零波及：`buildSubagentInteractionOrigin` 输出无新键。
6. shared schema：带全字段载荷 parse 通过；旧载荷（无新字段）parse 通过；非法
   ancestor 条目（缺 sessionId / 多余字段）strict 拒绝。
7. 投影守护（源文本）：waitingChildIds 收集含 ancestors 遍历；徽章组件未被本批改
   （P2b 边界）。

## 未做与取舍

1. **UI 谱系展示不在本批**（R5）：徽章 tooltip 链式展示需要 i18n 文案与 DESIGN.md
   对齐，归 P2b；本批只保证数据面完整且 waiting 状态正确。
2. **tool-event-mirror 的 origin 不加谱系**：镜像事件逐层落直接父会话流，其
   parentSessionId 就是流所在会话，语义本来正确；加了反而制造「事件在 SA 流里、
   origin 却说根是 R」的多余信息（下钻视图各层自洽）。
3. **rootSessionId 不取 config.rootSessionId**：broker 链的机械后写与 config 谱系
   字段是两个独立事实源，取前者（构造顺序可证）；后者服务于预算键与 deny 门
   （nesting-budget R4/R5-1），各司其职不合并。
4. **不做协议版本协商**：R0 的「新字段只在显式解锁嵌套后出现」已覆盖版本偏斜
   （缺省配置的旧客户端见不到新字段）；为 additive 可选字段引入协商机制不成比例。
