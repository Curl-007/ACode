# Agent 间整树寻址 P2：同树跨层 peer 投递（编排方案 Phase 5 / ④-P2）

来源：[`docs/codex-orchestration-integration-plan.md`](../../../docs/codex-orchestration-integration-plan.md)
§4 Phase 5 P2（整树寻址表 + 多层镜像逐级向各自父收口 + 跨层环路/深度守卫）与 §7④
裁决。前置批次全部就绪：P0 进程内同父兄弟
（[`agent-peer-messaging.md`](agent-peer-messaging.md)）、P1 跨进程 store-and-forward
（[`agent-peer-messaging-cross-process.md`](agent-peer-messaging-cross-process.md)）、
嵌套与谱系（[`subagent-nesting-budget.md`](subagent-nesting-budget.md)：childDepth/
rootSessionId 事实、树级预算的键纪律与 claim/release 单点）。

**分批**：本 spec 覆盖 **P2 = 同树跨层 live 寻址**。跨树 live 寻址（bootstrap
sessions 池级）不做——跨树/跨进程一律走 P1 mailbox（取舍 #3）。

## 背景（已核实的现状，基线：当前检出，行号实施前需复核）

- P0 寻址域 = 父 registry 直接子代理（`peer-messaging.ts` R2）：嵌套放开后，堂兄弟
  （不同父的同树 agent）、叔辈、后代都拒——但它们的任务全都活在**同进程**的各自
  父 registry 里，拒绝的唯一原因是没有跨层索引。
- P1 mailbox fallback 只覆盖「目标会话存在于 store」的 store-and-forward：目标明明
  在本进程活跃时，落盘等 hook drain 是错误的降级（延迟 + 语义失真）。
- 树级预算已给出可复用的三件套纪律（`tree-budget.ts` 头注，script-workflow-runtime
  三个真实 bug 的教训）：键 = 树根（rootSessionId）不是 runtime 实例；单一登记/
  注销点（`runAgentToCompletion` 顶部准入 + `emitSubagentEvent` settle 分支，
  `runner.ts:1190-1210/:2073-2081`）；非结算路径不清零。
- rootSessionId 谱系事实已无条件传到任意深度（`subagent.ts:332-333` child config
  `rootSessionId: this.config.rootSessionId ?? this.sessionId`）——每层 runtime 都能
  机械算出树根键，无需新传递链。
- `deliverPendingMessageViaSink(registry, task, message)` 接受任意 registry
  （`message-delivery.ts:9-12`）——跨层投递不需要新投递原语。
- **peerMessaging flag 不透传到 child config**（`subagent.ts` child `subagents` 块只有
  backgroundBashMaxMs/enabled/maxDepth）：嵌套放开后孙代理没有 peer 窄面——P0 时
  嵌套硬关所以无影响，现在是缺口。
- 镜像（P0 R5）落 port 铸造者 = 发送方直接父会话；跨层发送时「共同父」不再是单一
  会话，方案原文的收口方向是「逐级向各自父」。

## 产品规则

**R0 门控与缺省面。** 复用 P0 的 `config.subagents.peerMessaging.enabled`（装配期
定值，默认关）——整树寻址不另设第二个 flag。`maxDepth` 缺省 1 时树中只有根的直接
子代理，全部活在根 registry：本地命中永远先于树表查询，**行为与 P0 逐字节一致**
（负向断言 + 既有 P0 套件回归承担）。flag 关 = 不登记、不查询、零内存面。

**R1 寻址域 = 同树 live agent（跨树不可达是结构保证）。** 表按树根键隔离
（`Map<rootKey, Map<agentId, entry>>`）：查询只在发送方自己树的键下进行，跨树
agentId 结构性 miss → 落 P1 mailbox（存在性校验兜底）或拒绝。**不新增发现面**：
`listPeers()` 仍是同父兄弟只读投影——整树寻址是能力寻址（agentId 必须来自派发
结果、上层摘要或用户上下文），不做枚举（取舍 #1）。

**R2 投递复用既有三语义单点，终态拒绝。** 命中表项后从 entry.registry 取任务快照：
有 sink → steered、无 sink/失败 → queued（`deliverPendingMessageViaSink` 唯一实现，
两条路径永不漂移）；终态任务 → R7 同款结构化拒绝（peer 不复活算力，settled-unregister
竞态窗口内也拒）；表项 stale（registry 已无该任务）→ 静默降级到 mailbox/拒绝链
（stale 是瞬态事实不是错误）。查询顺序固定：**本地 registry → 树表 → mailbox →
拒绝**（即时性递减，每一步 miss 才走下一步）。

**R3 跨层环路/深度守卫。** 域闸（R1 同树）+ 双维度限速扩为**三路径共享窗口**
（sender 20/60s + pair 10/60s，同一 `claimRate` 表——本地/跨层/mailbox 改道绕不开
限额）+ 终态拒绝。hop 字段仍恒 1：无自动转发，跨层环路 = 两侧模型各自决策互发，
联合限速是有效闸（P0 取舍 #4 论证延伸）；hop 累计判定要有结构化转发才有意义
（取舍 #2）。深度不单独设闸——树表深度上限已被 maxDepth clamp（≤4）与树级预算
三闸约束，寻址层不重复造闸。

**R4 镜像逐级向各自父收口。** 跨层成功投递的持久镜像落**发送方直接父会话**
（port 铸造者 = mirror 回调 owner，既有 per-level 机制天然满足）；接收方的痕迹 =
其会话内的注入事件（steered/queued 既有事实）。不写共同祖先会话——发送方可能
根本看不到那个会话（下钻语义各层自洽，与 origin-lineage spec 取舍 #2 同款理由）。
metadata.peerMessage 增 `toAgentSessionId`（表项的 childSessionId），冷目录可归属。

**R5 登记/注销与预算 claim/release 同点配对。** 登记 = `runAgentToCompletion` 顶部
（前台/后台/resume 三路全经的单一执行原语；预算 claim 之后——溢出拒绝的派发不留
表项）；注销 = `emitSubagentEvent` settle 分支（run 生命周期唯一出口；resume 重臂
自动重登记）。键 = 树根 sessionId（每层 runtime 以 `rootSessionId ?? sessionId`
机械自算，与预算键同款纪律）。不设表级清理点——任何非结算路径的清零都是
「地址被悄悄撤掉」的 bug 模式；内存有界性由 settle 注销 + 级联停止
（nesting-budget R5-2）承担，树根键条目本身 O(树数)（取舍 #4：不用 WeakRef）。

**R6 flag 透传到深层。** child config 的 `subagents` 块透传 `peerMessaging`
（与 maxDepth 同款装配期策略透传）：嵌套放开时孙代理同样获得窄面（它自己的兄弟 +
整树寻址 + mailbox fallback 三级链）。默认关 = 不透传 = 零变化。

## 状态所有权

| 状态 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 整树寻址表 | core 模块级 Map（进程内存，键 = 树根） | tree-budget 同款姿态；测试 reset |
| 表项 | {agentId, childSessionId, registry 引用} | registry 是投递面不是句柄透传（窄面纪律不变：无 stop/cancel） |
| 登记/注销 | runner 准入点 / settle 单点 | 与预算 claim/release 同点配对（R5） |
| 树根键 | 每层 runtime config 谱系事实（rootSessionId ?? sessionId） | 机械自算，无新传递链 |
| 速率窗口 | 父 runtime 内存 per-run Map（P0 既有，三路径共享） | R3 |
| 镜像 | 发送方直接父会话 synthetic notice（既有 owner） | R4 |

## 接口

- **core**（不进 contracts——P0 窄面同款 duck-typing 纪律）：
  - `tree-addressing.ts`：`registerTreeAddress / unregisterTreeAddress /
    lookupTreeAddress / resetTreeAddressingForTest`，`TreeAddressEntry {agentId,
    childSessionId, registry}`；
  - `ExploreSubagentPortOptions.treeAddressingRootKey?: string`（subagent.ts 在
    peerMessaging 条件块内下发，**无深度条件**——与预算键的 depth≥1 条件刻意不同，
    寻址覆盖全树含 depth-1）；
  - `createPeerMessagingPort` options 增 `treeAddressing?: { rootKey: string }`。
- **装配**：`subagent.ts` child config `subagents.peerMessaging` 透传（R6）。

## 事件顺序与幂等

```
任意深度子代理 X 派发（flag 开）
  → runAgentToCompletion：预算 claim（可能拒）→ registerTreeAddress(树根键, X)
子代理 A（同树任意层）调 SendMessage(to=B)
  ├─ B ∈ A 的父 registry → P0 路径（逐字节不变）
  ├─ B ∈ 树表（live）→ entry.registry 取快照
  │    ├─ 终态 → R7 拒绝（不复活）
  │    ├─ 限速（三路径共享窗）→ 超限拒绝
  │    └─ deliverPendingMessageViaSink(entry.registry, …) → steered/queued
  │         → R4 镜像落 A 的直接父会话（metadata 含 toAgentSessionId）
  ├─ B ∈ 树表但 stale → 降级下一步
  ├─ mailbox 接缝在场 → P1 store-and-forward（persisted_mailbox）
  └─ 全 miss → P0 拒绝文案（逐字节不变）
X settle → emitSubagentEvent settle 分支：unregisterTreeAddress（幂等）
幂等：登记按 agentId 覆盖写（resume 重臂自动刷新）；注销幂等（delete）；
镜像每成功投递一次；限速按成功尝试递增（P0 语义）
```

## 验收场景

见 `apps/acode-cli/tests/agent-peer-tree-addressing.test.mjs`（实施时落地）：

1. 表原语：register/lookup/unregister/覆盖写（重臂刷新）/resetForTest；跨树键隔离
   （rootKey2 的表项对 rootKey1 的查询结构性 miss）。
2. 跨层投递：本地 registry miss + 树表命中（另一 registry 挂 sink）→ steered，
   pending 带 origin.kind="peer"/hop=1；无 sink → queued 进目标 registry 队列。
3. R7：树表命中但任务终态 → 拒绝且零投递副作用；stale 表项（registry 无任务）→
   降级 mailbox（有接缝时 persisted_mailbox）/拒绝（无接缝时 P0 文案）。
4. R2 顺序：同一 agentId 同时在本地 registry 与树表 → 本地路径生效（P0 语义优先）。
5. R3：三路径共享限速窗（本地 + 跨层混发，sender 第 21 条拒；跨层 pair 第 11 条拒）。
6. R4：跨层成功投递镜像落发送方父回调，metadata.peerMessage 含 delivery/to/
   toAgentSessionId；镜像失败不阻断。
7. R0/R6 负向与装配守护（源文本）：runner 登记在预算 claim 之后、注销在 settle
   分支（与 releaseTreeBudgetSlot 同块）；subagent.ts 的 treeAddressingRootKey 在
   peerMessaging 条件块内且**无** subagentDepth 条件；child config 透传
   peerMessaging；listPeers 未扩（仍同父兄弟过滤）。
8. 默认面回归：无 treeAddressing option 的 port 对跨层目标行为 = P1/P0 现状
   （mailbox/拒绝链），既有 P0/P1 套件全绿承担逐字节断言。

## 未做与取舍

1. **不做发现面**：listPeers 不扩为整树枚举——能力寻址（知道 agentId 才能发）是
   P0 以来的滥用面收敛手段；整树枚举会把「定向消息」变成「广播面」，且深层代理
   的 description 会泄漏兄弟子树的执行意图。
2. **hop 不累计、无自动转发**：每条 peer 消息都是发送方模型的独立决策（hop 恒 1）；
   跨层环路守卫 = 域闸 + 三路径共享限速 + 终态拒绝。结构化转发（收到即转）不存在，
   hop 上限判定没有可累计的事实——字段保留，判定不造。
3. **跨树 live 寻址不做**（方案 §7④ board 纪律的延伸）：另一棵树/另一进程的目标走
   P1 mailbox store-and-forward；sessions 池级的进程内跨树 live 路由 = 事实上的
   board，绕开父中介收口，不做。
4. **不用 WeakRef、不设表级清理**：方案原文「runtime 弱引用」的动机是防泄漏；
   确定性注销（settle 单点 + 级联停止）比「有时可寻址有时不可」的 GC 非确定语义
   更优，内存有界性等价（entry 数 ≤ 在飞 agent 数 + O(树数) 的空键条目，与
   tree-budget 同款量级）。
5. **接收方 presentation 不升级**：跨层来件与兄弟来件共用 subagent_reply_steer
   presentation（PEER_PERMISSION_GUIDANCE / PEER_REPLY_GUIDANCE 文案对两者同样
   成立——回复路径就是同一张三级链）；「来自哪一层」的展示归 prompt 面专项。
