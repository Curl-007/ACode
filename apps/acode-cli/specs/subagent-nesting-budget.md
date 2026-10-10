# 子代理受约束深度嵌套：谱系、天花板锚根与树级预算（编排方案 Phase 4 / ③）

来源：[`docs/codex-orchestration-integration-plan.md`](../../../docs/codex-orchestration-integration-plan.md)
§4 Phase 4（安全修复 A + 放开嵌套 B + 全局预算 C）与 §5 R1/R3 行；2026-10-10 对照审计
（B1 R1 提权链、B4 §6.1 工厂链泄漏、B5 §6.2 后台孤儿、§6.3 双重镜像均独立复核
confirmed）。参照机制：Codex `agent_max_depth` / `max_concurrent_threads_per_session`。
只搬运机制设计。

**分批与状态**：
- **第一批（A+B 的谱系/天花板/闸门）**：R1-R3 已实施。
- **第二批（2026-10-10 同日内落地）**：R4 树级预算三闸、R5 三条审计前置（§6.1 deny
  门谱系继承、§6.2 级联停止、§6.3 双重镜像抑制）已实施并验收，
  `TREE_BUDGET_ADMISSION_LANDED = true`——配置的 maxDepth 自此生效（被
  `TREE_BUDGET_CAPS.maxDepth` 夹住）；**缺省仍是 1**（maxDepth 缺席 = 原硬深度 1
  逐字节不变）。翻回 false 即恢复 fail-closed 硬封。
- R6 origin 归属（ancestors[]/rootSessionId 进 interaction-origin）仍拆后续 PR（方案原文；
  第一批的 rootSessionId config 字段已是它的事实源）。

## 背景（已核实的现状与风险）

- 硬深度 1 原是五道结构性保证，其中四道纯派生、唯一真语义是 child config 的
  `subagents:{enabled:false}`（审计 B3 逐门核实）。
- **R1 提权链（审计 B1 confirmed）**：旧 `resolveSubagentPermissionMode` 天花板只相对
  **直接父**；`case undefined: return builtInExplore ? "yolo" : parentMode`。放开嵌套后：
  根 build → 内置 Explore 子代理 yolo（depth-1 设计保留，只读工具面）→ 该 Explore 派
  general-purpose 孙代理，`permissionMode===undefined` 走 parentMode → **yolo +
  toolset:"main" 完整可写工具面**，而根是 build——从只读到全权限 yolo 的一跳提权。
- depth 此前完全不被记录（全仓 grep 无 subagentDepth/maxDepth/agentDepth），只能靠
  parentID 链回溯。
- 权限路由回根天然成立（child-client-ports 外层后写 + broker sessionId 无条件覆写，
  任意深度自动正确，审计核实无需改）；进程级 policy floor 仍是唯一 depth 无关护栏，
  但它是地板不是天花板，不能替代 R1 修复。
- Agent handler 零准入检查（R3 失控面）；`scheduler.ts` 的 DEFAULT_MAX_CONCURRENCY=10
  是纯函数式分组器、不是树级闸（树总量 10^depth）。

## 产品规则

**R1 权限天花板锚根。** `resolveSubagentPermissionMode` 带锚参
`{ depth, rootMode }`（缺省 = `{1, parentMode}`，与旧三参签名逐字节同语义，存量回归
不动）：
- depth ≤ 1：天花板 = 直接父（现状语义）；Explore 缺省 yolo 保留（depth-1 只读工具面
  的设计保留，熔断器 + 进程级策略地板兜底）。
- depth ≥ 2：天花板 = `moreRestrictiveMode(parentMode, rootMode)`；**Explore 缺省 yolo
  限定 depth ≤ 1**——depth≥2 的 Explore 可能拿到派发/可写面，不再享受只读豁免。
- 显式 yolo/bypassPermissions 回落天花板（原语义「回落 parentMode」的锚根版）；
  auto/plan 覆盖照旧（只会更严）。

**R2 模式严苛度序（单点，`nesting-policy.ts`）**：`auto < plan < edit < build < yolo`
（auto 当前语义全拒、plan 只读）；未知词按最严处理，双侧缺席回落 auto（fail-closed）。

**R3 depth 谱系：父自填的机械保证。** `AgentRuntimeConfig` 新增事实字段
`subagentDepth?`（根缺席 ≡ 0）、`rootSessionId?`（根缺席 ≡ 自身 sessionId）、
`rootMode?`（根缺席 ≡ 自身当前有效模式）；策略字段 `subagents.maxDepth?`（装配期定值，
缺省 1）。三事实字段**只由父在 child config 构造点计算**（`childDepth =
(this.config.subagentDepth ?? 0) + 1`），不经 request、不由调用方填——request 构造方
给不了错值，`resumeFromStore` 也读不回被篡改的 depth。rootMode/rootSessionId 是
**建链时刻快照**：根后续改模式不放宽已建链的天花板（只会因 parentMode 参与 min 而更严）。
放开闸门单点：child config `subagents.enabled = childDepth < 生效 maxDepth`
（`resolveChildSubagentsEnabled`），其余四道结构性保证（port undefined / includeAgent /
handlers 注册条件 / embedded-search-branch 第二入口）全部由它派生，不各算一份。
派发工具的 allowlist 剔除同判据联动（`allowDispatch`，policy-floor spec 增补 R4 的
「按 depth 判定」落地）：**注册门与 allowlist 永不同真值分叉**。

**R4 树级预算 = 准入闸（已实施，`core/src/subagent/tree-budget.ts`）。** 照 dwf
`budget-caps.ts` 纪律：三闸**不合并**——`maxAgentsPerTree`（总量）/
`maxLiveAgentsPerTree`（积压）/ `maxTokensPerTree`（事后）+ `maxDepth` 维度（clamp 进
`resolveEffectiveSubagentMaxDepth`）；溢出是**结构化拒绝**不静默截断（`AgentErrorCode.
TREE_BUDGET_EXCEEDED`，recoverable，Agent 可并行派发、Promise.all 论证同 dwf）。
单一准入点 = `runAgentToCompletion` 顶部（前台/后台/resume 三路全经的唯一执行原语）；
释放/记账单点 = `emitSubagentEvent` 的 settle 分支（终态事件是 run 生命周期的唯一出口，
释放经 Set 幂等）。状态 = 进程内 `Map<rootSessionId, entry>`，键必须是**树根**不是
runtime 实例（`treeBudgetRootKey = String(config.rootSessionId ?? sessionId)`）；
entries 随进程保留、刻意不设清理点（任何非结算路径的清零都是「预算被悄悄重置」的
bug 模式）。注入经 `modelRequestAdmission` 按引用继承（已覆盖任意深度）；AIMD 并发
治理器同链免费。**定位声明**：本闸是派发前准入判定，不是 turn loop 轮数计数——与
`apps/acode-cli/AGENTS.md`「不用 tool call 次数做硬停止」及已删除 maxTurns 的裁决
（subagent-maxturns-policy.md）不属同类。

**R4a 常量定值记录**（数字即契约，「宽到合理编排碰不到」的 dwf 同款论证）：
- `maxAgentsPerTree = 256`：一棵树累计派发总量（含 resume 重臂——每次派发都消耗真实
  算力）。合理的研究型递归（数层 × 每层数分支）在两位数；256 只拦失控回环。
- `maxLiveAgentsPerTree = 16`：同时在飞积压。父层 scheduler 的并发分组上限是 10
  （DEFAULT_MAX_CONCURRENCY），16 给两层同时在飞留余量、又让第三层的指数积压撞闸。
- `maxTokensPerTree = 2_000_000_000`：与 dwf `maxTokensPerRun` 同量级（事后保险丝，
  宁可不猜 provider 计数）。
- `maxDepth = 4`：策略维度上限；研究型递归超过 4 层几乎必然是失控而非分解。

**R5 审计新增前置（已实施）。**
- §6.1（审计 B4）：`AgentRuntimeConfig.offPeakSubagentExecution` 事实字段随谱系透传
  （depth-1 由 `modelOverride.background==="deny"` 置位，深层原样继承），port 侧
  `offPeakInherited` 使 background 拒绝门按「**有效** override」判定——孙层不再因
  `launchOptions.modelOverride` 缺席而放行，闲时轮凭据经工厂链的复活路径封死。
- §6.3（审计核实）：child eventSink 闭包的镜像条件收紧为「直接子会话的 raw 事件」——
  镜像产物（`payload.source==="subagent"`）与深层 raw 事件（sessionId ≠ 本 child）
  只透传不再镜像，根 timeline 的双重条目与 agentId 错归属消除。
- §6.2（审计 B5）：新增 runtime 方法 `stopInFlightSubagentTasks`（R8），child turn 的
  finally 无条件调用——后台孤儿孙代理类别消除。

**R8 树随派发 run 同生共死（级联收口）。** child turn 结算（完成或取消）时，其 registry
里仍在飞的 local_agent 任务已无通知消费者（child runtime 即将废弃、队列无人再读）——
`stopInFlightSubagentTasks` 经本 runtime 自己的 `subagentPort.stopTask` 逐个停止，每层
只收自己的直接子代理，级联随各层 finally 递归成立；best-effort（单个失败不中断其余）。
语义取舍：**后台孙代理不越过其派发者 run 的寿命**——depth-1 的「后台子代理越过父
turn 存活」语义不变（那是主会话的 registry，主会话生命周期 = 进程），本规则只作用于
subagent_child runtime（taskType 门）。

**R6 origin 归属退化（可拆后续 PR）。** `interaction-origin.ts` 加 `ancestors[]` +
`rootSessionId`（broker 外层追加），波及 contracts/shared 与桌面端——按方案原文单独
排期；第一批的 `rootSessionId` config 字段已为它预留事实源。

**R7 不变量守护。** 默认装配（maxDepth 缺席）下：child config 的 enabled 判定恒
false、子工具面无 Agent/Task、`resolveSubagentPermissionMode` 三参调用语义逐字节等于
修复前——由回归测试钉住（验收场景 1）。第五道门 `embedded-search-branch.ts` 与
`runtime-tools.ts` 的 includeAgent 判定必须同源（`Boolean(runtime.subagentPort)`），
两入口同规则纪律（tool-allowlist.ts 注释）纳入回归。

## 状态所有权

| 状态 | 唯一所有者 | 备注 |
| --- | --- | --- |
| depth/root 谱系事实 | 父 runtime 的 child config 构造点（单点计算） | 不经 request、不可回填 |
| maxDepth 策略 | 装配期 config（create-app / profile 组装） | 运行中不翻转 |
| 生效 maxDepth | `resolveEffectiveSubagentMaxDepth`（纯函数单点） | fail-closed 硬封 |
| 树级预算计数（R4） | 内存 Map（键=树根 sessionId） | 第二批；唯一收尾点 |
| 权限天花板裁决 | `resolveSubagentPermissionMode`（导出纯函数） | 测试面不变 |

## 接口

- `core/src/subagent/nesting-policy.ts`（新）：`TREE_BUDGET_ADMISSION_LANDED`、
  `moreRestrictiveMode`、`resolveEffectiveSubagentMaxDepth`、`resolveChildSubagentsEnabled`
  ——全部纯函数/常量，零 IO。
- `core/src/subagent/tree-budget.ts`（新，第二批）：`TREE_BUDGET_CAPS`、
  `claimTreeBudgetSlot` / `releaseTreeBudgetSlot` / `recordTreeBudgetTokens` /
  `resetTreeBudgetForTest`（进程单例 + 测试重置，process-policy-floor 同款模式）。
- `core/src/runtime/methods/background.ts`：`stopInFlightSubagentTasks`（第二批，
  internal-methods/agent-runtime/methods-index 三点接线，R8）。
- `core/src/runtime/types.ts`：`subagents.maxDepth?`；`subagentDepth?` / `rootSessionId?` /
  `rootMode?` / `offPeakSubagentExecution?`（AgentRuntimeConfig 事实字段）。
- `core/src/subagent/runner.ts`：port options `treeBudgetRootKey?` / `offPeakInherited?`；
  准入在 `runAgentToCompletion` 顶部；释放/记账在 `emitSubagentEvent` settle 分支。
- `core/src/runtime/methods/subagent.ts`：`resolveSubagentPermissionMode` 第四参
  `anchors?: { depth; rootMode }`（可选，缺省=旧语义）；`resolveSubagentToolAllowlist`
  第四参 `{ allowDispatch }`；child config 谱系字段 + enabled 派生 + 闲时轮事实透传；
  eventSink 闭包的镜像抑制双条件。
- `core/src/subagent/tool-policy.ts`：`buildSubagentChildDisallowRules` /
  `filterSubagentChildToolNames` 可选 `options.allowDispatch`（缺省 = 剔除，向后兼容，
  profile.ts 与 runner resolveAllowedTools 两个下游保持严格侧）。
- `contracts/src/tools/agent.ts`：`AgentErrorCode.TREE_BUDGET_EXCEEDED`。

## 验收场景

见 `apps/acode-cli/tests/subagent-nesting-gates.test.mjs`：

1. **默认逐字节回归**：maxDepth 缺席 → `resolveEffectiveSubagentMaxDepth(undefined)=1`、
   任意 configured 值被硬封 1（TREE_BUDGET_ADMISSION_LANDED=false）；
   `resolveChildSubagentsEnabled({childDepth:1, configuredMaxDepth:5})=false`；三参
   `resolveSubagentPermissionMode` 的全部旧行为不变（含 Explore yolo、显式 yolo 回落
   parentMode、auto/plan 直通——存量 subagent-policy-floor 场景 5 原样通过）。
2. **R1 封堵（锚参形态）**：depth=2 + rootMode=build 时——undefined+Explore → build
   （不再 yolo）；undefined+非 Explore、parentMode=yolo → build（天花板锚根）；
   显式 yolo → build；auto/plan 照旧直通。
3. **R2 序**：moreRestrictiveMode 全序对 + 未知/缺席 fail-closed。
4. **R3 谱系**：child config 谱系三字段由父自填（源码断言：构造点表达式在场、
   request 无 depth 字段可填）；enabled 与 allowDispatch 同由 childSubagentsEnabled
   派生（源码断言单点）。
5. **第五道门回归**：embedded-search-branch 与 runtime-tools 的 includeAgent 判定同源。
6. **闸门守护**：`resolveEffectiveSubagentMaxDepth` 是 maxDepth 的唯一出口（源码断言
   无第二处读 `subagents.maxDepth` 做 enabled 判定），并被 `TREE_BUDGET_CAPS.maxDepth`
   夹住；TREE_BUDGET_ADMISSION_LANDED 翻回 false 即恢复硬封（单元断言钳制语义）。
7. **预算三闸行为**（tests/subagent-tree-budget.test.mjs）：积压闸第 17 个在飞拒绝、
   释放一个即恢复、释放幂等；总量闸含重臂计数、越顶结构化拒绝（reason/current/cap）；
   token 事后闸越顶拒新派发、非正值忽略、树间键隔离；端口级准入耗尽时 run 被
   TREE_BUDGET_EXCEEDED 结构化拒绝。
8. **§6.1 deny 门继承**：`offPeakInherited` 在场时无显式 modelOverride 也拒绝
   background 派发；显式 deny（既有 depth-1 门）回归不变；两者缺席照常放行。
9. **§6.2/§6.3 接线不变量**：级联停止挂 child finally（proto 三点接线在场、只收
   local_agent running）；镜像抑制双条件（直接子会话 + 非镜像产物）在闭包单点；
   settle 释放/记账在 emitSubagentEvent 单点。

## 未做与取舍

1. **本批不翻开嵌套**：R4/R5 落地并验收前 `TREE_BUDGET_ADMISSION_LANDED=false`，
   maxDepth 配置存在但无效（fail-closed 优于「flag 可开但护栏缺位」）。
2. **workflow 嵌套仍不放开**（`script-workflow-runtime.ts` "Nested workflow() is
   reserved"）：与 Agent 嵌套的放开理由不同，需单独论证（方案 §8 原文，避免双标）。
3. **swarm 边界不动**：分层分解优先 swarm（护栏完整）；模型驱动嵌套只服务「子代理需
   自主决定再分包、结构无法预先表达成图」的 research/explore 型递归（方案 §4-D 原文）。
   `runtime-tools.ts` 四条 taskType 排除判据不动（「无 UI 可见会话身份」在任意深度成立）。
4. **profiles 不透传给 child**：孙代理只见内置目录 + 显式装配面，防持久化 profile 的
   提权字段经深层复活（project markdown 剥离纪律的谱系延伸）；需要时随第二批单独论证。
5. **origin ancestors[]（R6）拆后续 PR**：波及 contracts/shared/桌面端，与嵌套闸门
   无耦合。
6. **已登记的计量/覆盖边界（第二批）**：stopped 路径的 token 欠账——
   `BackgroundTaskCompleted` 载荷不带 usage，被停 run 的已烧 token 不进树级累计
   （事后闸轻微低估，宁欠不猜，dwf 同款取舍）；live 计数依赖 settle 事件出口，
   若 run 以不发终态事件的异常路径消亡（当前代码面不存在），该 slot 随进程存续——
   有积压闸封顶，不另设兜底清理（清理点越多，「悄悄清零」bug 面越大）。
7. **预算闸只计嵌套（depth≥2）派发**：预算键仅在本 runtime 自己是子代理
   （`subagentDepth ≥ 1`）时下发——根会话的 depth-1 派发（并行兄弟 + 后台代理，
   今天的合法工作流形态）不进树级闸，并发语义逐字节不变。三闸防的是嵌套的
   10^depth 失控（R3 失控证据的正是「handler 零准入 + 树总量指数」），不是既有
   depth-1 形态；全树（含各层）共享同一份以树根为键的计数。
