# AgentTeams 角色能力包（批次 5 / G8 前半：add_member 角色引用 + 成员 profile 选择）

覆盖 `docs/upgrades/orchestration-acceptance-2026-11.md` §5 **批次 5（G8 前半，可选）** 与
附录 C。批次 0/1 见 `agent-teams-acceptance-loop.md` 与
`agent-teams-acceptance-loop-2-in-review.md`；批次 2 见 `coordinator-readonly-preset.md`；
批次 3 见 `host-team-wake.md`；批次 4 见 `packages/ui/specs/`（不在本 spec 范围）。

本 spec 是契约冻结先行（EI-137）：先冻结角色引用的语义、解析责任、降级与测试矩阵，实现
独立提交。方案是提案，本 spec 是实现契约，冲突以本 spec 冻结面为准。

**落点裁决（新建 vs 扩 `agent-teams-derived-config.md`）**：新建本文件。
`agent-teams-derived-config.md` 承载的是**宿主派生配置链**的实现契约（启动装配 / live
重读 / 插件模型覆盖的优先级）；本项是**插件对外接口与角色引用语义**的增量，宿主契约
（AgentProfile 形状、派发解析、live-refresh 消费点）**一字不改**。按 EI-2 指针策略引用
derived-config 的 R3–R7 作为 live-refresh 真源，不复述其规则；把插件侧引用语义塞进
那份 spec 会让「宿主链」与「插件接口」两个语义面互相污染。

**与 Fynvra Role 的关系（EI-131）**：只借**契约形状**——「一个可命名、可导入导出、可由
稳定 id 引用的角色能力单元（提示词 + Skills/MCP + 模型/思考档 + 工具策略 + 审批档）」，不抄
其 Role JSON 实现、不新建 Role 存储、不做 Role 编辑器。ACode 的等价能力单元**已经是**
宿主的 `AgentProfile`（Markdown frontmatter + body），因此本项只做「插件成员按稳定 id 引用
宿主已有的 AgentProfile」，不搬第二套。

## 背景与已核实事实

基线 `feature/cli-agent-teams-acceptance-loop`；插件路径相对
`apps/acode-cli/packages/agent-teams-plugin/`（下称「插件」），其余相对仓库根。

| 断言 | 核实结果 |
| --- | --- |
| 插件成员由**队长经宿主原生 `Agent` 工具** spawn，插件自己不起会话 | 属实：`add_member` 只登记成员并返回 `spawn_instruction {tool:"Agent", subagent_type:"agent-teams:member", run_in_background:true, prompt}`（`src/tools/members.ts:93-101,38-40`）；`bind_member` 回填宿主返回的 agentId |
| 成员 profile 唯一来源是插件内 `agents/member.md`（写死，无角色选择面） | 属实：`add_member` 的 `subagent_type` 硬编码 `"agent-teams:member"`（`src/tools/members.ts:96`）；`agents/member.md` frontmatter `name: member` + `mcpServers: [plugin:agent-teams:team]` + `disallowedTools` 固定 |
| 宿主把插件 `agents/<stem>.md` 命名空间成 `${plugin.name}:${stem}`，并按 `subagent_type` 精确/归一化匹配派发 | 属实：`bootstrap/src/subagents.ts:147-175` 的 `loadPluginAgentProfiles` + `subagent-plugin-overrides.ts:194-199` 的 `namespacePluginAgentProfile`；解析在 `core/src/subagent/runner.ts:929-965`（NFKC + 小写 + 去空白/破折号/下划线，精确命中优先） |
| 宿主对未知 `subagent_type` **fail loudly** 并列出可用类型 | 属实：`core/src/subagent/runner.ts:913-926` 抛 `UNKNOWN_AGENT_TYPE`，message 含 `Available agents: ...`，recoverable |
| 员工具的 `role`/`charter` 是自由文本标签，不选择 profile | 属实：`addSchema.role/charter` 仅 min/max，写入 `TeamMember`（`src/state/types.ts:53-73`），spawn prompt 里作为文字拼接（`members.ts:78-87`） |
| 派生配置链已有 live-refresh（每次**新派生**前重读 profile）与插件模型覆盖 | 属实：[agent-teams-derived-config.md](./agent-teams-derived-config.md) R3–R7；插件模型覆盖按 `createPluginAgentStateId(pluginId, bareName)` 只作用于**插件命名空间**的 profile |
| 插件零 core 依赖 | 属实：插件 `package.json` dependencies 仅 `@modelcontextprotocol/server`；看不到宿主 profile 注册表（无 import 面） |
| 宿主 `agent_teams_status` 已原样回成员对象 | 属实：`src/tools/team-status.ts:131` `members: refreshed.members`——`TeamMember` 的新增字段自动随 status 可见 |
| 桌面/手机面板投影按字段白名单收窄，未知字段被忽略 | 属实：`packages/ui/src/v4/teamPanelModel.ts:287-305` 逐字段构造 `ConversationStatusPanelTeamMember`，快照多字段不判形状不符 |
| 版本四处 parity 当前**已红**（既有漂移，非本项引入） | 属实：`package.json`/`plugin.json` = `0.5.0`，`official-plugin-definitions.ts:329` 与 `sea-official-plugin-assets.mjs:65` = `0.4.0`；`apps/acode-cli/tests/agent-teams-registration-parity.test.mjs`「版本四处一致」失败 |
| 成员 profile 必须自带团队 MCP，否则成员根本调不到团队工具 | 属实：团队工具经 `mcpServers: [plugin:agent-teams:team]` 注入（`agents/member.md:6-7`）；`.mcp.json` 的 stdio server 名 `team` |

## 状态所有者与事件顺序

```
角色定义（权威）                                      引用（插件只存透明 id）
  宿主 AgentProfile 体系                                  TeamMember.roleRef
  ├─ 插件 profile：agents/<stem>.md                       （opaque string，插件不解释、
  │   命名空间名 `agent-teams:member`（默认成员）           不校验是否存在）
  ├─ 用户级 agents/*.md（用户自建角色，需自带团队 MCP）
  └─ 项目级 agents/*.md
        ▲                                                      │
        │ 派生边界 live 重读（derived-config R5/R7）            │
        │ （每次新派生重读 Markdown，无缓存）                    ▼
  宿主 core runner 按 subagent_type 解析 ── 命中 ──► 派发成员会话
        │                                              （角色能力 = 该 profile 的
        │                                              提示词/Skills/MCP/模型/工具/审批）
        └─ 未命中 → UNKNOWN_AGENT_TYPE（列出可用类型）——插件不换默认值，不静默回退

插件写入路径（单一）：add_member ──► TeamMember.roleRef ──► spawn_instruction.subagent_type
                                                              （缺省 = "agent-teams:member"）
投影链（只读，EI-48）：status 原样成员对象 / panelState.members[].roleRef
  └─ 宿主 UI 受检投影（白名单收窄，未知字段忽略）
```

- **角色定义所有权**：宿主 AgentProfile 体系（Markdown 文件 + 派生链），**插件的唯一事实源
  是它自己写入的 `roleRef` 字符串**，两者不重合、不互写。
- **解析所有权**：宿主派发边界（`runner.ts` 的 `resolveAgentProfileByType`）。插件**没有**
  解析 profile 内容的实现、也不新增一条解析路径（EI-2）。
- **写入所有权**：`add_member` 是 `roleRef` 的唯一写入点（团队状态经 `store.withLock`
  读-改-写，磁盘唯一真相）；不新增 amend/switch role 工具（EI-146，见 R4）。

## 产品规则

### R1 `roleRef` 是宿主 AgentProfile 的不透明稳定标识

- `roleRef` 的取值 = **宿主 `Agent` 工具的 `subagent_type` 取值**，即 AgentProfile 的
  `name`（插件命名空间形如 `agent-teams:member`，用户/项目 profile 形如其 frontmatter
  `name`）。这满足 EI-144：引用用稳定 id（profile 名）作键，显示名（`role`/`charter`）
  可自由改名不影响引用。
- 插件**只存字符串、不解释、不校验存在性**（零 core 依赖，看不到 profile 注册表）。
- 插件**不定义** Role 的 JSON 格式、不存在插件的角色目录、不建第二套角色存储（EI-2）。
  「导入导出」= 宿主既有的 AgentProfile Markdown 文件形态：导出 = 把该 Markdown 分享；
  导入 = 放进用户/项目 agents 目录按 frontmatter `name` 引用。插件不新增导入导出工具。

### R2 `add_member` 新增可选 `roleRef`；缺省回退现状

- `agent_teams_add_member` schema 增可选 `roleRef`（additive）。缺省（不传）时行为与现状
  **逐字节一致**：`spawn_instruction.subagent_type = "agent-teams:member"`，成员使用插件
  `agents/member.md`，`TeamMember.roleRef` **不写入**（字段缺席，不写 `null`——EI-25 字段
  缺失表达「未指定」在本场景是既有惯例，见 state/types.ts 的可选字段用法）。
- 传了 `roleRef` 时：写入 `TeamMember.roleRef`，`spawn_instruction.subagent_type =
  roleRef`（原样、逐字、**不做任何映射/归一化/回退**）。
- 形状校验（插件侧，唯一能做的一层）：trim 后必须匹配 `ROLE_REF_PATTERN`
  （`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`，1–64 字符，不含空白/换行/控制字符）。不匹配 →
  `invalid_input`，**且不登记成员、不建工作树**（与 member_exists / member_limit_exceeded
  同一位次：所有输入与名册校验在第一个写操作之前完成）。
- `spawn: false` 时仍写入 `roleRef`（登记即记录引用；后续由队长按 `spawn_instruction`
  执行——与现状 `spawn` 语义一致，`spawn=false` 只是不回指令）。

### R3 spawn 指引与成员 brief 文案携带引用

- `spawn_instruction` 除 `subagent_type` 外，回带 `roleRef`（当显式指定时）与
  `profile_source: "host"`，并在 `followup` 后保持「spawn 后立刻 `bind_member`」的既有指令。
- `roleRef` 显式指定时，spawn prompt（`spawn_instruction.prompt`）追加一段说明：本次会话
  的角色能力来自宿主 profile `<roleRef>`；`role`/`charter` 与任务契约仍是范围边界（
  `agents/member.md` 的任务书纪律照旧适用）。缺省时 prompt 不变。
- 成员自述（`docs/protocol.md` / `agents/member.md`）登记「你的角色能力可能由队长在
  spawn 时按 profile 指定；profile 里若没有团队 MCP，你调不到团队工具——如实回报队长」。

### R4 fail loudly 与降级（EI-1 / EI-4 / EI-17）

分两层，各自 fail-closed 且**永不静默回退**：

1. **形状非法**（插件可判）：`invalid_input`（R2）。这是「明确未执行」——不登记成员。
2. **宿主解析不到**（插件不可判）：`spawn_instruction.subagent_type` 原样带 `roleRef`，
   宿主 `Agent` 工具返回 `UNKNOWN_AGENT_TYPE` 并列出可用类型（明确未执行，可安全重试）。
   插件**没有**「解析失败就改用默认成员类型」的分支——该分支不得存在（测试负向钉死）。
- 降级裁决（宿主无 profile 体系 / 无该类型）：插件**不降级、不替代**，如实把宿主错误暴露给
  队长与用户；`add_member` 返回的 `notes` 明示「profile 由宿主解析，`Agent` 工具报未知类型
  时不要静默改用默认成员类型，向用户报告（EI-17 中性语言：保留了什么、缺了什么）」。
- 已知限制如实登记（EI-9）：**成员 profile 必须自带 `plugin:agent-teams:team` MCP，
  否则被 spawn 出来的成员调不到团队工具**（无法 status/claim/回报）。插件不校验这一点
  （做不到），由队长/用户在选定 `roleRef` 前负责；症状是成员报「调不到团队工具」。
  这是「角色能力包」在本插件形态下的真实边界，不包装成「任意 profile 都能当成员」。
- **不新增错误码**（沿批次 0 的 OQ-8 纪律：复用 `invalid_input` 承载形状拒绝，不扩错误码面）。

### R5 投影 additive（面板 / status）

- `TeamPanelState.members[]` 增可选 `roleRef?: string`（显式指定时出现；缺省不出现——旧宿主
  读不到即不显示，不判形状不符，additive v 仍为 1）。
- `agent_teams_status` 原样回 `TeamMember` 对象，`roleRef` 自动可见（无需代码改动）；这是
  队长侧的主要消费点（派工前/成员异常时确认「这名成员跑的是哪个 profile」）。
- `packages/ui/src/v4/teamPanelModel.ts` 的成员投影是字段白名单（未知字段忽略），**本批
  不改 UI**：字段先落地于插件快照与 status；UI 若需展示（如角色徽标）归 UI 批次。

### R6 live-refresh 语义（沿 derived-config，指针引用）

- 引用的 profile 内容（模型/思考档/Skills/MCP/工具/审批）由宿主在**每次新派生**时按
  [agent-teams-derived-config.md](./agent-teams-derived-config.md) R5/R7 **重读**：改用户/项目
  agents Markdown 或 `v2/agents-state.json`，**下一次** spawn 即生效；插件不缓存、不投影
  profile 内容。
- 插件模型覆盖（R3）与 `inheritCaptainModel`（R4）继续按**profile 名**裁决：
  `roleRef = "agent-teams:member"`（插件命名空间）时沿用插件覆盖 / general-purpose 回退 /
  `requireExplicitModelSelection` fail-closed；`roleRef` 指向用户/项目 profile 时，该 profile
  按用户/项目 profile 的既有规则解析（不受插件覆盖影响）。插件不得另写第二套选择规则（EI-2）。
- **已运行的成员不换 profile**：`roleRef` 只在 `add_member` 写入、只影响 spawn；改角色需
  `remove_member` → `add_member`（新 `roleRef`）→ 重新 spawn/bind。不新增「热切换 profile」
  能力（无宿主支持面，且与「一次性派生」语义冲突）。
- 插件是否启用/可用的 profile 存在于 live 快照，由宿主保证；插件不做任何文件 watcher，
  不读插件/工作区 agents 布局（沿 host-team-wake R1 的同款纪律：不建第二真源）。

### R7 版本（含既有漂移修复）

- 版本 `0.5.0 → 0.6.0`，四处一致：`package.json`、`.acode-plugin/plugin.json`、
  `bootstrap/src/app/official-plugin-definitions.ts`（agent-teams 条目）、
  `cli/scripts/sea-official-plugin-assets.mjs`（officialSeaPlugins 条目）。后两者当前停在
  `0.4.0`，与 `package.json`/`plugin.json` 已漂移 → 本批**一并修正**（`agent-teams-registration-parity.test.mjs`
  的「版本四处一致」当前红，修正后转绿；属既有漂移，非本项引入，报告时如实归属）。
- 同批同步：`src/server.ts` 的 `Server({ version })` 与 `docs/usage.md` 的版本标注/变更说明
  （与四处口径一致）。
- 不新增 `ACODE_` 环境变量、不新增协议命令、不改 `.mcp.json`（`roleRef` 不经 userConfig）。

## 接口

- `src/state/types.ts`：`TeamMember.roleRef?: string`（additive，read-only，写在
  `state/types.ts` 的成员形状）；一并导出 `ROLE_REF_PATTERN`（校验单点，供 tools 与本测试共用）。
- `src/tools/members.ts`：`addSchema` 增 `roleRef: z.string().regex(ROLE_REF_PATTERN)`（可选）；
  handler 在名册校验位次后校验形状、写入 `roleRef`、按 R2/R3 组装 `spawn_instruction` 与
  spawn prompt；`notes` 按 R4 说明宿主解析责任。
- `src/panel-state.ts`：`TeamPanelState.members[]` 增可选 `roleRef`（additive）。
- 不改：`src/state/store*.ts`（成员对象原样存取）、`src/tools/registry.ts`（无新工具、
  `agent_teams_add_member` 仍 `memberAllowed:false`）、`identity.ts`、`.mcp.json`、
  `state/machine.ts`（角色与任务状态机正交）。

## 验收场景（测试落 `tests/role-packs.test.ts`，内存态 + temp 根，仿 tools.test.ts 惯例）

| # | 场景 | 断言要点 |
| --- | --- | --- |
| 1 | 正向：`add_member(roleRef: "agent-teams:member")` | 返回 `spawn_instruction.subagent_type === "agent-teams:member"`、`roleRef` 回带；`team.json` 的成员带 `roleRef` |
| 2 | 正向：`add_member(roleRef: "my-reviewer")`（用户自建角色） | `subagent_type === "my-reviewer"` **逐字**（无映射/归一化）；`notes` 含宿主解析与「不静默回退」指引 |
| 3 | 正向：自定义角色名带命名空间/点号（如 `team-x:auditor.v2`） | 通过形状校验并逐字透传（EI-144 稳定 id 允许 separator） |
| 4 | 缺省回退：不传 `roleRef` | `subagent_type === "agent-teams:member"`；成员对象**不含** `roleRef` 键；spawn prompt 与旧文案一致 |
| 5 | 负向·形状：`""` / whitespace / 含换行 / 含空格 / 65+ 字符 / 前导 `-` / 含 `$` 等 shell 元字符 | 全部 `invalid_input`；**名册未变**（成员数不变、无工作树创建）——负向断言「不该写入就一定没写」 |
| 6 | 负向·无静默回退：给定一个宿主解析不到的 `roleRef` | 插件仍返回逐字 `subagent_type`（无「回退到 member」分支）；测试以「输出恒等于输入」与「未出现默认值」钉死该分支不存在 |
| 7 | 兼容·旧状态：磁盘上写入**无 `roleRef`** 的旧 `team.json` | status/panel 读取不报错；面板成员投影**不含** `roleRef` 键（additive 缺席即不显示，不判形状不符） |
| 8 | 投影 additive：面板快照 | 指定 `roleRef` 的成员在 `members[]` 带 `roleRef`；未指定的成员该键缺席；`v` 仍为 1；`counts`/其他字段不变 |
| 9 | status 自动可见 | 指定 `roleRef` 后 `agent_teams_status`（队长视角）返回的成员对象带 `roleRef` |
| 10 | 权限矩阵不变 | `ALL_TOOLS` 仍 21 个、无新增；`memberAllowed` 集合不变；成员调 `add_member` → `forbidden_for_caller` |
| 11 | 成员生命周期兼容 | `remove_member` → 同名 `add_member(roleRef: ...)` 新条目带新 `roleRef`，旧条目（removed）保留自己的引用（按名取活动条目，不复活旧引用） |
| 12 | 版本 parity 回归 | 四处版本一致且 = `0.6.0`（复用 `apps/acode-cli/tests/agent-teams-registration-parity.test.mjs`；本批转为绿） |

## 不做清单（EI-131 / EI-2 / EI-146）

- 不新建插件侧角色存储 / 角色目录 / `roles.json`；不做 Role 的插件内导入导出工具。
- 不在插件内解析 AgentProfile 内容（frontmatter/模型/工具），不校验 profile 是否存在。
- 不新增 `profileRef` 等同义别名字段（一个语义一份实现；`roleRef` 单字段）。
- 不改成员 spawn 的宿主机制（不经 `Agent` 工具以外的通道、不动 `runner.ts` 解析规则、
  不新增宿主协议命令 / v4 事件；宿主侧仅版本字符串一处 additive）。
- 不新增 `amend_member` / 热切换 role 工具；不加 `memberAllowed` 放宽。
- 不改 `state/machine.ts`、任务状态机、验收闭环（角色与验收正交）。
- 不改 UI（`packages/ui`）渲染；快照字段先落地，UI 展示归 UI 批次。
- 不把角色能力包做成第二套权限/工具策略真源——工具/审批/模型面仍由宿主 profile 与既有
  策略地板裁决。

## 开放问题与实施回写

（无待裁决开放问题：解析责任、fail loudly、回退语义、版本口径均按上文冻结。）

实施回写（2026-11-02 实现批次）：

1. **单字段裁决**：采用 `roleRef` 单字段，不提供 `profileRef` 别名（任务描述中的
   `roleRef/profileRef` 二者择一，理由见不做清单第 3 条）。
2. **`ROLE_REF_PATTERN` 落点**：`src/state/types.ts`（与 `MEMBER_NAME_PATTERN` /
   `TASK_ID_PATTERN` 同级导出；`state/helpers.ts` 已有 `export {...} from "./types.js"` 面，
   但为最小改动不追加 re-export，tools 直接从 `state/types.js` 取——与 members.ts 现有
   `TEAM_ID_PATTERN` 从 helpers 取并存，两个来源都是 types.ts 单点）。
3. **版本漂移**：definition/SEA 由 `0.4.0` 提到 `0.6.0`，同时修掉既有红测（归属既有漂移）。
4. 未新增任何工具、错误码、环境变量、协议命令；`server.ts` 只改一行版本号（397/400 行预算
   内，无外迁）。