# 协调者只读预设（AgentTeams 队长会话的写工具宿主硬禁用）

覆盖 `docs/upgrades/orchestration-acceptance-2026-11.md` §5 **批次 2（G4）**。第 1/2 册
（批次 M0+0、批次 1）见 `agent-teams-acceptance-loop.md` 与
`agent-teams-acceptance-loop-2-in-review.md`；批次 3/4/5 不在本 spec 范围。

本 spec 是契约冻结先行（EI-137）：先冻结判定来源、位次、生效/解除时机、文案与测试矩阵，
实现独立提交。方案是提案，本 spec 是实现契约，冲突以本 spec 冻结面为准。

**落点裁决（新建 vs 扩两份策略地板 spec）**：新建本文件，不扩
`subagent-policy-floor-inheritance.md` / `managed-policy-floor-and-bypass-immune-breakers.md`。
理由：① 二者承载的是**托管策略地板**（管理员下发、strictest-wins、进程级不变量）与
**子代理继承**，而本项是**会话级、宿主自定的协调协议默认值**，强度、来源、生命周期都不同，
塞进去会把「地板」的语义泡松（EI-2 单一语义）；② 本项只**复用** `service.ts:406-417` 的
disallowedTools 位次，按 EI-2 指针策略引用那两份 spec，不复述其规则；③ 二者已各自承载
完成的能力，追加会把判定来源与验收场景搅在一起。命名沿用地板 spec 建议名
（`coordinator-readonly-preset.md`，而非验收闭环系列的「第 3 册」），见「开放问题 Q6」。

## 背景与已核实事实

基线 `feature/cli-agent-teams-acceptance-loop`，路径相对仓库根；插件路径相对
`apps/acode-cli/packages/agent-teams-plugin/`（下称「插件」）。

| 断言 | 核实结果 |
| --- | --- |
| disallowedTools 硬禁用位于所有模式分支之前，策略地板 deny 更在其前 | 属实（`core/src/permission/service.ts:406-417`；policy floor 在 :381-404） |
| 技能激活期 deny 与 disallowedTools 同位次（其后、模式分支之前） | 属实（`service.ts:419-436`） |
| `PermissionConfig.disallowedTools` 是硬禁用唯一消费集合 | 属实（`service.ts:1326-1352`；`defaultPermissionConfig` :1357） |
| 宿主可经 `toolDisallowlist` 把工具并入该集合 | 属实（`bootstrap/src/app/app-config-options.ts:20-23` → `permission.disallowedTools`） |
| 插件零 core 依赖，仅 stdio MCP | 属实（`package.json` deps 只有 `@modelcontextprotocol/server`；`trust-wrapper.ts:22-24`） |
| 队长身份持久在团队 JSON `captainSessionId`，create/adopt 写入 | 属实（`state/types.ts:108`；`tools/team.ts:90`；`tools/team-adopt.ts:59-64`） |
| 插件已把 `captainSessionId` 作为宿主可见字段推送 | 属实（`panel-state.ts:52-58,168`：additive 字段，**按工作区推送给同项目所有会话**） |
| 宿主已消费该字段做 UI 过滤（同一字段的既有先例） | 属实（`packages/ui/src/v4/teamPanelModel.ts:91-99` 按 `captainSessionId===ownerSessionId` 过滤） |
| 插件状态通知经 adapter 归约为 `{pluginId,key,state}`（pluginId 权威注入） | 属实（`adapters/src/mcp/index.ts:1719-1736`；`contracts/src/interfaces/mcp.port.ts:32-39`） |
| `identity_missing` 错误码已预留但零消费 | 属实（`state/types.ts:179`；全仓仅此一处） |
| 请求上下文 `session_id`/`runtime_scope` 由宿主在 MCP 调用注入 | 属实（`adapters/src/mcp/index.ts:2568-2590`） |
| `AGENT_TEAMS_STATE_DIR` 只注入插件子进程，core 不持有 | 属实（`.mcp.json:10`；`adapters/src/plugins/mcp.ts:434-447` 展开 user_config；core 无引用） |
| 插件默认状态根 = `<workspace>/.agent-teams`（插件私有解析） | 属实（`state/store.ts:350-356` `resolveStateRoot`） |
| core 实际文件写工具名只有 Write / Edit / ApplyPatch | 属实（`tool/handlers/{write.ts:235,edit.ts:278,apply-patch.ts:589}`；**无** NotebookEdit/MultiEdit） |
| 会话级作用域注入有既有先例（skill activation scope） | 属实（`agent/skill-activation-scope.ts:149-158`；`permission-flow.ts:110` 注入 PermissionContext） |
| 复核链路未注入 skillActivationRules（奇偶差异） | 属实（`permission-input-recheck.ts:47-71` 无该字段） |
| 架构 ratchet：新文件 ≤400 物理行 / maxPublicMethods 12 | 属实（`architecture-policy.yaml:341-343`） |

**与方案假设不符（2 处，影响批次 2 定义，需主 agent 裁决）**：

1. **方案 §3 G4 把 Bash 列为待禁的「写工具」**。本 spec 裁决**默认不禁 Bash**（见 R1.3）：
   Bash 同时是只读审查命令面（`git diff`/`log` 等），一刀切禁用会同时废掉读能力；而写向
   Bash 的残余（重定向/`node -e`）无法靠名单消除。差异登记为开放问题 Q1。
2. **插件现行队长协议**允许队长自助改代码：`commands/team.md` 第 12 条「你自己也可以接管
   任务：`agent_teams_reassign_task(assignee:"captain")`…随后用 `update_task` 完成」，
   `tools/registry.ts:179-186` 的 `requireMember({allowCaptain:true})` 为其鉴权通道。
   硬禁用 Write/Edit 会**打断这条已文档化的路径**。这是本 spec 最重的产品冲突，见 Q2。

## 产品规则

### R1 预设内容与注入点

- **R1.1 预设集合单一事实源**：新增常量 `COORDINATOR_DISALLOWED_TOOLS`（模块
  `core/src/permission/coordinator-readonly.ts`），成员 = 当前 core 的**文件写工具**
  `["Write", "Edit", "ApplyPatch"]`。不用「按模式/风险级推导」——按名单收口，并配
  `tests/coordinator-readonly.test.mjs` 的漂移守护：每个成员必须是 core 已注册工具名
  （改名/删除即红），且 `tool/handlers/` 下任何声明文件写语义的新工具必须登记进名单
  （评审清单项，见 R8.3）。
- **R1.2 注入位次**：在 `PermissionService.evaluatePermission` 内、`disallowedTools`
  硬禁用（`service.ts:406-417`）**之后**、技能激活期 deny（`:419-436`）**之前**新增判定：
  `context.coordinatorReadOnly?.tools` 含 `context.toolName` → `deny`，ruleId
  `rule.coordinator.readonly`。该位次与 disallowedTools 同档：**在所有模式分支之前**
  （yolo 直通 `:596` 之前、plan transition、auto 分类器、项目规则之前），压不过
  策略地板 deny/ask（`:383-404`），不被任何 allow 分支（allowedTools/项目 allow/TTL）
  放宽。用**独立 ruleId**（而非并入 `rule.disallowedTools`）的理由：R6 的中性文案、
  R4 的 `identity_missing`、R5 逃生阀可验证与决策日志归因都需要可区分的归因面。
- **R1.3 集合边界**：默认**不含** Bash / PowerShell / Task / Agent / 读工具 / MCP 工具 /
  团队工具。Bash 是已知残余面：队长仍可经 Bash 重定向或 `node -e` 写文件（方案 §4.1 已把
  该面登记为「防失误不防注入」）。本 spec 如实登记，不包装成「队长完全无法写代码」（EI-9）。
- **R1.4 会话级作用域，非进程级**：判定读 `PermissionContext.coordinatorReadOnly`
  （会话级快照，与 `skillActivationRules` 同型），**不改** `PermissionConfig.disallowedTools`
  的进程值、**不**复用进程级 `setProcessManagedPolicyFloor`（后者是管理员地板语义，见
  `subagent-policy-floor-inheritance.md` R1，混用会误表强度）。

### R2 生效与解除时机（判定来源冻结）

- **R2.1 权威判定来源 = 插件声明字段，不是磁盘布局**：宿主从**插件状态通知**（logger
  `acode-plugin-state:agent-teams`，`server.ts:322`；adapter 归为 `{pluginId:"agent-teams",
  key:"agent-teams", state}`）里已声明的 `state.teams[].captainSessionId`
  （`panel-state.ts:168`，multi-team additive 形状）派生：
  `isCoordinator(sessionId) = ∃ t ∈ state.teams : t.captainSessionId === sessionId`。
  `teams[]` 是**活跃集**（draft/active/paused），归档项不进 `teams[]`。
- **R2.2 生效**：本会话成为某活跃团队的 `captainSessionId` 即生效（`agent_teams_create`
  与 `agent_teams_adopt_team` 都会把调用方 `session_id` 写进该字段，见背景表）。
  生效信号在该次 MCP 工具调用**收尾**时经状态通知到达（`server.ts:136-149,223-260`）；
  MCP 变更类工具 `concurrentSafe:false`（`core/src/mcp/index.ts:241`），同一批工具调用
  顺序执行，故「先 create 后 Write」这类同批序列中 Write 的判定前信号已到。
- **R2.3 解除**：任一次**新的**插件状态（`teams[]` 在场）显示本会话不再是任何活跃团队的
  captain → 解除。覆盖三条路径：`agent_teams_delete(archive:true/false)`（`teams[]` 移除，
  `server.ts:229-244` 归档项只进 `primary`/`recentEnded`，**不参与判定**）；他会话
  `agent_teams_adopt_team` 接管（`team-adopt.ts:59-64` 改绑 `captainSessionId`）；最后一支
  团队归档。**判定只用 `teams[]`**；`primary` 与 `recentEnded` 是归档展示投影，拿它们判会在
  删除后仍显示队长 → 永不解除，故显式排除。
- **R2.4 解除来源一致性（R2.3 只对「本会话自己的状态通知」成立）**：插件状态内容是**整个
  工作区**（`panel-state.ts:52-58` 注释「按工作区推送给同项目所有会话」），但推送动作发生在
  **本会话自己的** MCP `tools/call` 收尾（`server.ts:136-149,223-260`），故每会话只收到
  自己触发的推送。被接管换下的旧队长在**它自己的下一次插件状态推送**（下一次 agent-teams
  工具调用）或**会话恢复重放**后解除。空窗期内旧队长**仍只读**——方向为**过严**（fail-closed），
  绝不产生漏放行。**实现期须核实**该推送归属（若实际是跨会话广播，空窗更短，R2.4 结论不变；
  若采用面板 HTTP 作为兜底刷新，须保证与 MCP 通道同源，不造第二份判定）。
- **R2.5 会话恢复**：插件状态已落为 `PluginStateUpdated` 会话事件并投影进 `pluginStates`
  （`create-app.ts:719-733`；`product-projection.ts:4400-4413`），会话恢复/重连时由重放恢复，
  故队长在**恢复后首次工具调用前**即被判定为只读，无需额外拉取。
- **R2.6 团队归档或队长身份消失的判定来源**：**唯一**来源是 `teams[].captainSessionId`
  派生（R2.1）；不从「会话是否已停止/超时」（EI-28：不从旁路信号推断终止）、不从任务状态、
  不从磁盘 mtime 推断。

### R3 宿主感知队长身份的方案裁决（a/b/c 与失效模式）

- **采纳（c，本 spec 选定的既有机制）**：**读插件已声明的 `captainSessionId` 宿主可见字段**
  （R2.1）。它复用既有插件状态通道与既有字段（UI 已按同字段过滤），是插件自己声明、
  additive、带 `v:1` 版本的宿主可见面——宿主只取这一个**安全事实字段**，不解业务状态
  （不枚举任务/成员/邮箱），不落第二份编排台账（不做清单 §8.9；EI-48）。
- **不采纳 (a)「core 在 MCP 管道按 `agent_teams_create/adopt_team` 工具名观察成功」**：
  ① core（`core/src/mcp/index.ts` 的 `createMcpToolEntry`）是**插件无关**的通用面，
  按插件工具名硬编码会把市场插件知识沉进 core（本仓 core 只对 host 工具 `node_repl` 做
  结构化特判，不对市场插件）；② 同一事实已由插件状态声明，再观察一次等于**第二真源**
  （EI-2）；③ 它天然看不见已被接管/归档的存量判定。备选登记（若将来需要「同批并发」即时
  性）：由 bootstrap（`official-plugin-definitions.ts` 已合法特判 agent-teams）在
  `onPluginStateNotification` 之外补观察，**不进 core**。
- **不采纳 (b)「宿主读 `AGENT_TEAMS_STATE_DIR` 下团队 JSON 的 `captainSessionId`」**：
  ① core **不持有**该 env（`.mcp.json` 只注入插件子进程；`adapters/src/plugins/mcp.ts:434-447`
  在宿主侧展开为 spawn env，不进 core 判定面）；② 默认状态根由插件私有 `resolveStateRoot`
  解析（`state/store.ts:350-356`），宿主自行实现等于**复制插件私有规则**并解释其磁盘布局，
  直接违反 EI-2 与 `panel-state.ts:13` 声明的「宿主不解释内容」；③ 引入新的读取失败面
  （目录不可读/布局漂移/多布局迁移版本，`server.ts:63-65` 已登记旧平铺迁移）。
- **失效模式（采纳方案必须处理的清单）**：
  | 场景 | 行为 |
  | --- | --- |
  | 状态通知从未到达（会话刚起、未调任何 agent-teams 工具） | 未建立 → 不施加预设（不猜，R4.2） |
  | `teams[]` 缺席（旧插件、非 multi-team 形状） | 判定不可得；本会话未建立 → 不施加（R4.2） |
  | `state` 形状不符/损坏（非对象、`teams` 非数组） | 同上，按「不可得」处理，不抛（拒告警一次，R6） |
  | 状态目录不可读 / 多布局 | **不影响**（本方案不读磁盘） |
  | 多团队 | `teams[]` 逐项判定；任一团队仍以本会话为队长 → 保持 |
  | 接管换队长 | 新队长即时生效（adopter 自己的通知）；旧队长于其下次推送/恢复时解除（R2.4） |
  | 会话恢复 | 由会话事件重放恢复（R2.5） |
  | 会话 id 缺失/注入异常（`_meta` 无 `session_id`） | 无法比对 → 判定不可得 → R4 |

### R4 fail-closed（EI-4，显式决定并写下来）

- **R4.1 粘性**：一旦为某会话建立过「协调者」判定（R2.2），该会话在本进程内**粘性只读**——
  任何后续「判定不可得」（`teams[]` 缺席/状态缺失/会话 id 不可得）**不得**解除，保持只读并
  发一次 `identity_missing` 诊断（去重，见 R6.3）。解除只能由 R2.3 的**正向**解除证据触发。
  实现：宿主维护会话级 `coordinatorBasis: boolean`，由 R2.1 派生**置真**，由 R2.3 派生置假；
  `undefined`（不可得）**不覆盖**既有值。为避免跨进程恢复丢失粘性，basis 随会话存储持久化
  （单布尔派生事实，真源仍是插件状态；登记为新增的最小持久面，见 Q3）。
- **R4.2 不猜**：从未建立过判定的会话，遇到「不可得」时**不施加**预设（不因缺证据把普通主
  会话误锁为只读）。这条与 R4.1 共同构成：**不确定时沿用已确立的判定，从不放宽**。
- **R4.3 非静默**：R4.1 的不可得经 `warn` 审计（通道复用 `permissionAuditLogger`，
  event `permission.coordinator_readonly.identity_missing`，字段 `sessionId`/`reason`）并
  在工具拒绝文案里带 `identity_missing`；不阻断、不降级为可写。

### R5 逃生阀（EI-149 / EI-152，且必须可验证）

- **R5.1 唯一逃生阀 = 用户显式配置**：`AgentTeams` 插件 userConfig 新增布尔
  `captainReadOnly`（`.acode-plugin/plugin.json` schema，**默认 true**），宿主按插件 userConfig
  实际值决定是否施加预设。三级默认（EI-152）：用户显式选择（`captainReadOnly`）> 用户偏好
  （同键的上一持久值）> 硬编码回落（true）。**不自动回退到逃生阀**：判定不可得走 R4（保持
  只读），绝不因解析失败而「自动当作用户放开」（EI-149）。
- **R5.2 生效语义**：`captainReadOnly:false` → 该工作区**不施加**预设（队长写工具按常规权限
  判定），会话保持可写；此为用户显式决定，记录在案（`info` 一条，含来源=用户配置）。开关只
  影响 R1 判决，**不**放松策略地板/项目 deny/熔断器。
- **R5.3 可验证**：验收场景 ③ 以「同一 fixture 下 `captainReadOnly:false` 时 Write 回到 build
  判定（allow/ask 按常规）」与「未显式配置时 Write 被 `rule.coordinator.readonly` 拒」成对断言。
- **R5.4 不新增环境变量**：依 `apps/acode-cli/AGENTS.md`「能用配置表达的能力优先不做 env」，
  escape 走插件 userConfig，不新增 `ACODE_*`。

### R6 可见性（EI-1 / EI-17，中性语言）

- **R6.1 队长系统提示词**：预设生效期间，宿主在会话上下文注入一行中性说明（自撰英文，依
  `prompt-language-policy` R7），文案冻结为：
  「This session is the coordinator of an AgentTeams team. File-writing tools
  (Write/Edit/ApplyPatch) are disabled by the team protocol; dispatch changes to a member
  instead. Read-only tools remain available.」
  注入落点 = `core/src/context/sections/env-info.ts` 的既有「宿主事实」段（与 `scratchDir` 行
  同型，R5.3 先例）；不新增 `system-reminder` source（`system-reminder/source.ts` 是闭集）。
  缺席（未生效）零渲染，段内容逐字节不变。
- **R6.2 首次拒绝文案**：`rule.coordinator.readonly` 的 `reason` 冻结为：
  「This session is the coordinator of an AgentTeams team; file-writing tools are disabled
  by the team protocol. Dispatch the change to a member instead.」
  中性描述**保留了什么**（读工具与团队工具照常）与**该怎么做**（派成员），不描述为错误、
  不用无法验收的形容词（EI-17），且**不**与 plan/auto 的模式文案混写（见 R7.4）。
- **R6.3 `identity_missing` 文案**：与 R6.2 同文案 + 追加「coordinator status could not be
  re-confirmed; the session stays read-only (identity_missing)」；同一会话同一 turn 只发一次
  （去重），避免噪声。
- **R6.4 文档同步（同批必须做）**：`docs/usage.md`（若涉）、插件 `README.md`、
  `commands/team.md`、`skills/agent-teams/SKILL.md`、`agents/member.md` 与相关工具
  `description` 文本同步（全局规范 §4：接口变化同步受影响入口与文档）；队长协议正文须说明
  「宿主已按团队协议禁用写工具」（与 R1.3 的 Bash 残余如实并列，不夸大）。

### R7 与 plan / auto / 技能 deny 的裁决优先级链（不双重拒绝、不矛盾文案）

- **R7.1 冻结链**（自上而下，取第一个命中即终局；「同档 deny」不叠加 ruleId）：

  ```text
  evaluatePermission（core/src/permission/service.ts）
    ├ 0 policyFloor.deny        → deny  rule.policy.deny        （绝对最高）
    ├ 1 policyFloor.ask         → 托底 ask（不提前返回，仍过熔断/反射门）
    ├ 2 disallowedTools(用户∪项目∪策略) → deny rule.disallowedTools
    ├ 2.5 【本项】协调者只读预设 → deny rule.coordinator.readonly   ← 在所有模式分支之前
    ├ 2.6 技能激活期 deny       → deny rule.skillActivation.deny
    ├ 3 plan transition / 4 userInteraction / 5 alwaysAsk / 6 熔断器
    ├ 7 yolo fast-path（isYoloTrustBypassActive）
    └ 8 auto 分类器 / 项目 deny·ask / plan 只读 / TTL / 项目 allow / allowedTools / edit·build
  ```

- **R7.2 yolo 不复活**：2.5 在 7 之前，故 yolo 下写工具仍被 `rule.coordinator.readonly` 拒——
  与 disallowedTools 的既有不变量一致（`service.ts:406-409` 注释自认的 wart 修复）。
- **R7.3 与 plan 叠加**：plan 模式本就拦写；2.5 先于 plan，故报 `rule.coordinator.readonly`。
  两者结论同向（都拒），无矛盾文案；R6.2 文案是中性陈述，不与 plan 语义冲突。
- **R7.4 不双重拒绝**：终局 deny 恰一个 ruleId（首个命中即返回），故不产生「同时报两条拒绝」；
  拒绝文案只描述协调协议事实，不并列模式文案，避免用户看到两条互相解释的拒绝。
- **R7.5 与技能 deny 同向共存**：若某工具同时被活跃技能 deny，2.5 先命中 → 报协调协议；
  这是**归因**取舍（同向拒），不是放行；反向（技能 deny 早于本项）不做，因为协调协议是会话级
  更强约束，且技能 deny 目前**未**接入复核链路（`permission-input-recheck.ts:47-71`）。
- **R7.6 复核链路同源**：`permission-flow.ts:110` 与 `permission-input-recheck.ts` 两处
  `PermissionContext` 构造点都注入 `coordinatorReadOnly: snapshotSessionCoordinatorScope(deps.sessionId)`；
  本项**不**顺带修 skillActivationRules 的复核缺口（超范围，登记为既有事实）。

## 状态所有者与事件顺序

```text
插件（唯一权威：团队 JSON captainSessionId）
  │ agent_teams_create / adopt_team → 写 captainSessionId = 调用方 session_id
  │ tools/call 收尾 emit notifications/message (logger acode-plugin-state:agent-teams)
  ▼
adapter（pluginId 权威注入，不解释内容）→ {pluginId:"agent-teams", key:"agent-teams", state}
  ▼
宿主会话投影 pluginStates["agent-teams:agent-teams"]（PluginStateUpdated 事件 → 键级替换）
  ▼  R2.1 派生（只取 state.teams[].captainSessionId）
宿主会话级 coordinatorBasis（粘性；持久化以便恢复，R4.1）
  ▼  注入
PermissionContext.coordinatorReadOnly（permission-flow + input-recheck 两构造点）
  ▼  R1.2 判定（位次 2.5）
PermissionService.evaluatePermission → deny rule.coordinator.readonly
```

## 接口

- `core/src/permission/coordinator-readonly.ts`（新，≤400 行）：
  - `COORDINATOR_DISALLOWED_TOOLS: readonly string[]`（R1.1）
  - `resolveCoordinatorDeny(input: { toolName: string; scope?: CoordinatorScope }): { ruleId: string; reason: string } | undefined`
  - `COORDINATOR_READONLY_RULE_ID = "rule.coordinator.readonly"`（单一出处，禁第二份字面量）
- `core/src/agent/coordinator-scope.ts`（新，≤400 行；仿 `skill-activation-scope.ts`）：
  会话级 store 的 `setSessionCoordinatorBasis(sessionId, basis: boolean | undefined)` /
  `snapshotSessionCoordinatorScope(sessionId): CoordinatorScope | undefined` /
  `clearSessionCoordinatorScope(sessionId)`。
- `core/src/permission/service.ts`：`PermissionContext.coordinatorReadOnly?: CoordinatorScope`
  （`{ tools: readonly string[] }`）；`evaluatePermission` 新增 2.5 判定（不改其它位次）。
- `core/src/tool/executor/{permission-flow.ts,permission-input-recheck.ts}`：两构造点注入。
- `core/src/context/sections/env-info.ts`：`buildEnvInfoSection` 增可选入参，生效渲染 R6.1 一行，
  缺席零渲染。
- `core/src/permission/auto-deny-reasons.ts`：`rule.coordinator.readonly` → 新 token
  `PermissionDenialReason.CoordinatorReadOnly = "coordinator_readonly"`（闭集映射，勿漏）。
- 宿主（`bootstrap/src/app/create-app.ts` + 一个 `coordinator-readonly-derivation` 模块）：
  读插件 userConfig `captainReadOnly`；订阅既有 `onPluginStateNotification` 派生 basis 写入
  scope store；会话 attach/恢复时按重放的 `pluginStates` 重建 basis。
- 插件：`.acode-plugin/plugin.json` 增 `captainReadOnly`（boolean，default true）；
  文案/命令/SKILL 同步（R6.4）。**不改 legacy 协议面**（`packages/shared/src/acode-protocol/`），
  不新增 v4 命令/事件（本项只读既有 `PluginStateUpdated`）。

## 测试矩阵（EI-21 穷举；固定时钟、内存态隔离）

| # | 角色 | 模式 | 工具 | 期望 |
| --- | --- | --- | --- | --- |
| 1 | 队长 | build | Write/Edit/ApplyPatch | deny `rule.coordinator.readonly` |
| 2 | 队长 | edit / plan / auto / yolo / dontAsk | Write/Edit/ApplyPatch | 同上（yolo 不复活；plan 无双重拒绝） |
| 3 | 队长 | 全模式 | Read/Glob/Grep/Bash/agent_teams_* | 不受影响（allow/ask 按常规） |
| 4 | 成员（subagent） | 全模式 | Write/Edit/ApplyPatch | 与基线逐项一致（不施加预设） |
| 5 | 非团队主会话 | 全模式 | Write/Edit/ApplyPatch | 与基线逐项一致 |
| 6 | 队长 | — | Write + `captainReadOnly:false` | 回到 build 判定（逃生阀可验证） |
| 7 | 队长（basis 粘性） | build | Write，plugin state 缺失/`teams[]` 缺席 | 仍 deny + `identity_missing` 一次 |
| 8 | 从未建立 | build | Write，状态缺失 | 不施加（可写） |
| 9 | 队长 + 策略地板 deny Write | build | Write | `rule.policy.deny` 优先（地板压过本项） |
| 10 | 队长 + 用户/项目 disallowedTools 含 Write | build | Write | `rule.disallowedTools` 优先（用户显式配置优先） |
| 11 | 队长 + 活跃技能 deny Write | build | Write | `rule.coordinator.readonly` 优先（同向拒） |
| 12 | 队长 | — | hook 改写 input 后复核 | 两构造点同源，仍 deny（复核链路 parity） |
| 13 | 队长 → adopt 接管给他人 → 本会话下次推送 | build | Write | 解除，可写（R2.3/R2.4） |
| 14 | 队长 → delete 归档 | build | Write | 解除（`teams[]` 移除；归档 `primary` 不参与） |
| 15 | 队长 → 恢复会话 | build | Write | 恢复后首次调用前即 deny（重放恢复，R2.5） |
| 16 | 多团队：本会话是其中 1 支队长 | build | Write | deny（任一团队仍以本会话为队长） |
| 17 | env-info 段 | — | — | 生效渲染 1 行；缺席零渲染（逐字节） |
| 18 | 漂移守护 | — | — | `COORDINATOR_DISALLOWED_TOOLS` ⊆ 已注册工具名；`identity_missing` 字面量与插件 `TEAM_ERROR_CODES` 一致（parity 测试，仿 `agent-teams-registration-parity.test.mjs`） |

## 验收场景（方案 §5 批次 2 ①-⑤ 细化为可测试断言）

1. **① 队长 Write 被拒且理由可读、含派成员指引**：队长会话（basis 已建立）调用 Write → 拒，
   `ruleId === "rule.coordinator.readonly"`，`reason` 含冻结文案（R6.2）与「dispatch … to a
   member」；决策日志含该 ruleId 与 `denyReason === "coordinator_readonly"`。
2. **② 成员不受影响**：同一 fixture 下，`runtime_scope:"subagent"` 成员调 Write 的判定与
   本项落地前逐项一致（负向断言：成员路径从不命中 `rule.coordinator.readonly`）。
3. **③ 用户显式放开生效**：`captainReadOnly:false` → 队长 Write 回到 build 判定；同一 fixture
   不设该键（默认 true）→ 被拒。成对断言，证明逃生阀真实生效且默认收紧。
4. **④ 身份缺失 → 只读 + `identity_missing`**：basis 已建立的会话，插件状态缺失或 `teams[]`
   缺席 → Write 仍拒，且拒绝文案/审计携带 `identity_missing`；从未建立的会话同一条件 → 可写
   （R4.1/R4.2 两侧断言）。
5. **⑤ plan/auto/yolo 三模式行为一致且各有测试**：三模式下队长 Write 均 deny
   `rule.coordinator.readonly`（矩阵 #2）；三模式下非队长 Write 与基线一致（矩阵 #4/#5）；
   并证明无双重拒绝（终局 deny 恰一条决策日志）。

## 实施约束与不做清单

- **R8.1 行数与架构**：新文件 ≤400 物理行、maxPublicMethods 12（`architecture-policy.yaml:341-343`，
  新文件零容忍）；`service.ts` 已在 baseline 可小幅增长，判定体量控制在数行，不新建大类。
- **R8.2 不改 legacy 协议面**（方案 §8.5）：`packages/shared/src/acode-protocol/index.ts` 只删不增；
  本项不新增 v4 命令/事件，只读既有 `PluginStateUpdated` 与插件 userConfig。
- **R8.3 单一事实源**：工具名单、ruleId、文案、`identity_missing` 字面量各只一处（EI-2）；
  `tool/handlers/` 新增文件写工具必须同批登记进 `COORDINATOR_DISALLOWED_TOOLS` 并补矩阵行。
- **R8.4 不造第二真源**：不落第二份团队台账、不读插件私有磁盘布局、不在 core 硬编码市场插件
  工具名（不做清单 §8.9；EI-48）。
- **R8.5 验证分层**：核心不变量（位次、yolo 不复活、粘性、逃生阀、parity）用测试钉死
  （EI-120）；完整 lint/test 交 Check/Test；`pnpm --filter @acode/agent-teams-plugin test` 与
  根 `pnpm test` 覆盖插件侧文案与 parity。
- **不在本项范围**：Bash/PowerShell 的写向封锁（Q1）；队长自助改代码的协议去留（Q2）；
  唤醒（批次 3）；`run_checks` 执行面（批次 0）；UI 呈现；`subagent-policy-floor-inheritance.md`
  与 `managed-policy-floor-and-bypass-immune-breakers.md` 的既有规则；skillActivationRules
  的复核链路缺口（既存，登记不修）。

## 开放问题（需主 agent 裁决）

- **Q1 Bash 面**：方案 §3 G4 括注把 Bash 列为待禁写工具；本 spec 裁决默认不禁（R1.3）。
  是否要一个「严格档」额外禁 Bash/PowerShell？若禁，队长的只读审查命令面如何替代（依赖批次 0
  的 `review_member_diff`/`run_checks`）？
- **Q2 队长自助改代码**：插件现行协议（`commands/team.md` 第 12 条）允许队长 `reassign_task
  (assignee:"captain")` 后自己改代码；硬禁用会打断它。裁决：① 同批改插件协议，撤掉队长自助
  （本 spec 倾向）；② 保留自助并让预设与「队长持有进行中 attempt」互斥（复杂）；③ 明确记录
  该路径失效并要求用户用逃生阀。
- **Q3 basis 持久化**：R4.1 的 `coordinatorBasis` 是否落会话存储（保证跨进程恢复粘性），
  还是仅内存 + 由重放 `pluginStates` 重建（弱化粘性，零新持久面）？
- **Q4 ruleId/token 面**：是否接受新增 `rule.coordinator.readonly` + `coordinator_readonly`
  token（本 spec 倾向），还是并入 `rule.disallowedTools`/`DisallowedTool`（省一处契约改动，
  但失去 R6.2/R4.3/R5.3 的可区分归因）？
- **Q5 感知来源再确认**：是否认可「读插件已声明的 `captainSessionId`」（R3 采纳）而否决
  读 `AGENT_TEAMS_STATE_DIR` 磁盘布局？若主 agent 坚持磁盘读，需先定义**跨包状态根解析单一
  事实源**与布局版本契约（当前不存在）。
- **Q6 文件名**：本文件按地板 spec 建议名 `coordinator-readonly-preset.md`；验收闭环系列
  现有「第 1/2 册」命名（`agent-teams-acceptance-loop*.md`）。是否改名为
  `agent-teams-acceptance-loop-3-coordinator-readonly.md` 以对齐系列？