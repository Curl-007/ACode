# AgentTeams 插件与子智能体派生配置链（live-refresh + 插件模型覆盖）

把 `dev/from-acode-2026-10` 分支上的 AgentTeams 插件（`469024e` 部分）与派生配置链
（`476880a` / `8712257`）完整合入本仓，并同批偿还合并裁决 `0cc983f` 登记的三个缺口：
**架构 ratchet 文件拆分**、**ATP-3 dist 构建暂存管线**、**GAP-A live-refresh core 消费点**。
源分支上这三处均未闭合（分支自身不过 typecheck/arch 门禁、loader 造好后 core 端零调用），
本 spec 定义合入后的产品规则、状态所有者、接口与验收场景；实现不做逐字重放，
按本 spec 嫁接（`476880a` 的 subagents.ts diff 含回退本仓 R5 内置目录的删除，禁止原样套用）。

## 背景

### 已核实的现状（基线：dev/0.0.10，行号实施前需复核）

| 事实 | 位置 |
| --- | --- |
| 官方插件 seed 是纯复制 + requiredSeedPaths 完整性门，从不构建；缺必需路径报 `ACODE_PLUGIN_SEED_INCOMPLETE` 拒写缓存，但 marketplace 分区已先写 → 「市场可见但不可用」 | `bootstrap/src/app/bundled-plugins.ts:101,114-129,410-432` |
| 12 个已合入官方插件全部纯静态（无 build script）；dist 依赖型运行时插件先例只有 node-repl-host 与 browser-use，两者已登记 SEA 与桌面两份暂存清单 | `cli/scripts/sea-official-plugin-assets.mjs:20-46`、`packages/desktop/scripts/prepare-agent-node-bundle.mjs:93-117` |
| agent-teams-plugin（分支形态）：TS src + esbuild 产 `dist/mcp/server.js`，`.mcp.json` stdio 入口指向 dist，`dist/` 被 gitignore；分支已注册 definition（无 defaultEnabled）但 SEA/桌面清单缺席 | 分支 `apps/acode-cli/packages/agent-teams-plugin/`、分支 `official-plugin-definitions.ts` |
| 启动装配合并序：核心二内置（normalizeAgentProfiles 播种）< bundled（禁用过滤 + 覆盖烘焙）< user < project < plugin | `bootstrap/src/subagents.ts:84-127`、`core/src/subagent/profile.ts:95-119`、`builtin-subagent-catalog.md` R5 |
| runner port 构造期把 profiles 一次性 normalize 成启动快照，三个派生边界共用；无任何实时重读 | `core/src/subagent/runner.ts:202-204,212,247,513` |
| config→port 桥只转发 profiles 与 builtInModelSelectionOverrides | `core/src/runtime/methods/subagent.ts:102-108` |
| 子代理模型选择优先级：override > profile > 父继承；无 fail-closed 通道 | `core/src/runtime/helpers/subagent-selection.ts:16-43` |
| `AgentProfile` 无 `requireExplicitModelSelection` 字段（分支也缺，分支因此不过 typecheck） | `core/src/subagent/profile.ts:24-40` |
| 插件模型覆盖类型面已在 shared 存在（无需动纳管模块） | `packages/shared/src/subagents-types.ts`（`PluginSubagentModelSelectionOverrides`、`parsePluginSubagentModelSelectionOverrides`、`createPluginAgentStateId`） |
| 架构 ratchet：400 物理行上限；HEAD ≤400 的文件涨过 400 即 new/regrown，baseline 不可抑制；create-app.ts（1301）与 core types.ts/runner.ts 已在 baseline 可小幅增长 | `architecture-policy.yaml:304`、`scripts/architecture/index.mjs:390-402`、`.architecture-baseline.json` |
| `plugin-marketplaces.ts` 注释声称有「默认启用集合一致性」单测机械对照两处名单，**实际不存在**（全仓 grep 零命中） | `packages/shared/src/plugin-marketplaces.ts:26-32` |

### 产品决策（2026-10-15，用户拍板）

- **agent-teams 默认启用（自启动）**：与源分支的 opt-in 不同。开箱即得
  `agent_teams_*` 工具、`/team` 命令与 `agent-teams:member` 子智能体；MCP server
  随会话按需拉起（stdio）。默认启用放大管线缺口后果（seed 失败即全量用户
  「市场可见但不可用」），故 R2 的四份清单登记是本 spec 的硬验收，不是可选项。
- **GAP-A 同批闭环**：live-refresh 链必须落到 core 消费点（R7），不允许再出现
  「loader 造好无人调用」的死代码形态——这正是 0cc983f 剔除本链的理由之一。

## 产品规则

### R1 插件面与默认启用

- 插件包 `apps/acode-cli/packages/agent-teams-plugin`（`@acode/agent-teams-plugin` 0.1.0）
  按分支原样移植：TS src + esbuild 构建（`build: "tsc && node scripts/build.mjs"`）、
  `.mcp.json` stdio server `team`（运行时名 `plugin:agent-teams:team`，入口
  `${ACODE_PLUGIN_ROOT}/dist/mcp/server.js`）、`agents/member.md`、`commands/team.md`、
  `skills/agent-teams/SKILL.md`、docs 与 7 个测试文件。
- 超出 400 物理行的两个 src 文件（`src/state/store.ts` 408、`src/tools/tasks.ts` 410）
  做最小抽取拆分至 ≤400（架构 ratchet 对新文件零容忍）；其余文件不动，保持上游形态。
- `official-plugin-definitions.ts` 新增 agent-teams 条目：分支原样 listing +
  **`defaultEnabled: true`**；`requiredSeedPaths` 五项：`.mcp.json`、`agents/member.md`、
  `commands/team.md`、`dist/mcp/server.js`、`skills/agent-teams/SKILL.md`。
- **两处默认启用名单必须一致**：definitions 的 `defaultEnabled: true` 派生集合与
  `packages/shared/src/plugin-marketplaces.ts` 的 `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`
  手工镜像。注释声称的机械对照单测实际不存在，本批**补上**（bootstrap 侧新单测，
  验收场景 8），两处漂移即红。
- 该定义文件现 394 行，新增条目即超 400：同批拆分（表驱动生成段或接口段抽到兄弟
  文件），15 个既有定义逐字不动。
- 不移植 469024e 中 prompt-snippets 相关面（`bundled-plugins.ts` 的 snippets 白名单、
  definitions 的 prompt-snippets 条目、shared 镜像的 prompt-snippets 行）——该功能
  已被 0cc983f 整体剔除，不在本项范围。

### R2 打包与暂存管线（ATP-3 偿还）

dist 依赖型官方插件的发布链四处登记，缺一即「市场可见但不可用」：

1. **SEA 链**：`cli/scripts/sea-official-plugin-assets.mjs` 的 `officialSeaPlugins`
   加条目（`requiresRuntime: true`、`requiredRuntimePaths: ["dist/mcp/server.js"]`）；
   构建顺序由 `build:sea` 既有的 `turbo run build --filter=!@acode/cli` 前置步保证，
   `assertPluginRuntime` 在漏构建时提前失败。
2. **桌面生产链**：`packages/desktop/scripts/prepare-agent-node-bundle.mjs` 的
   `officialPluginPackages` 加条目（`runtimeBuildScript: "scripts/build.mjs"`、
   `stagedPath: "packages/agent-teams-plugin"`）；dist 在 stage 顶层白名单内。
3. **桌面 dev 链**：`scripts/build-desktop-agent-cli.mjs` 的
   `requiredDevPluginRuntimeBuilds` 加条目（artifact `agent-teams-plugin/dist/mcp/server.js`）。
4. **预构建链**：核对 `scripts/prepare-prebuilds.mjs` 的平行清单，同规则登记。

版本四处一致（package.json / plugin.json / definition / SEA 清单 = 0.1.0）。
knip：`scripts/build.mjs`、`scripts/smoke.mjs` 若不在 import 图则按既有插件先例
声明 entry 或挂 package.json scripts。lockfile 重解析后按 CI Linux 规范重生成
`third-party/inventory.json`。

### R3 插件模型覆盖优先级（applyPluginAgentModelOverrides，纯函数）

- 输入 = 缓存的插件基线 profiles + 插件元数据 + 最新插件覆盖 + 最新内置覆盖；
  不读磁盘。启动装配（`loadPluginAgentProfiles`）与派生边界 live 刷新（R6 loader）
  **共用这一个函数**，保证两处优先级同源。
- 单个 profile 的选择优先级：**插件专属覆盖**（键 `createPluginAgentStateId(pluginId, bareName)`）
  > **AgentTeams 成员的 general-purpose 回退**（仅 `plugin.name === "agent-teams" &&
  bareName === "member"` 且 `!inheritCaptainModel` 时，借用
  `builtInModelSelectionOverrides["general-purpose"]`）> **profile 自身基线**。
- 身份解析三级：命名空间前缀 `${plugin.name}:` → 与命名空间副本共享同一 `path`
  的裸名别名（byPath 复用身份）→ 插件 `rootPath` 包含关系取文件 stem。覆盖键取
  frontmatter 名而非文件名。无法归属的 profile 原样返回（不误改用户/项目 profile）。
- 别名副本与命名空间副本共享同一份 Markdown，必须一起改写；除 modelSelection 与
  `requireExplicitModelSelection` 外其余字段（permissionMode、tools、mcpServers、
  color 等）原样保留。
- `loadPluginAgentProfiles` 重构为「先构造无覆盖基线（命名空间副本 + 唯一裸名别名），
  再委托 `applyPluginAgentModelOverrides`」；保留本仓既有的 `CORE_RESERVED_AGENT_NAMES`
  保留名单与 `agent_ambiguous_name` 诊断语义。

### R4 requireExplicitModelSelection 与 inheritCaptainModel 两分支

- `AgentProfile` 新增可选字段 `requireExplicitModelSelection?: boolean`
  （core `profile.ts`；分支上就缺这个字段导致其不过 typecheck，本批补齐）。
- `inheritCaptainModel === true`（插件 userConfig，默认 false）：成员剥掉
  `requireExplicitModelSelection` 标记，回到既有父模型继承规则
  （`resolveSubagentSelection` 的 parentSelection 分支；权限继承语义不受影响，
  见 `subagent-parent-inheritance.md`——该 spec 只管权限/模式，模型继承边界以本 R 为准）。
- `inheritCaptainModel` 非 true：member profile 打 `requireExplicitModelSelection: true`。
  `resolveSubagentSelection` 对该标记 fail-closed——无 profileSelection 且无
  overrideSelection 时抛 `CoreErrorType.ConfigurationError`（recoverable，
  context `selectionIssue: "selection-missing"`），错误消息含配置引导
  （给 agent-teams:member 或 general-purpose 配模型，或开启 inheritCaptainModel）。
- guard 必须有真实调用点：`methods/subagent.ts` 的 `resolveSubagentSelection` 调用处
  传 `requireExplicitModelSelection: request.profile.requireExplicitModelSelection`
  （分支上此调用点未接线，guard 是死代码；本批接线）。

### R5 派生边界 live 重读（loadCurrentACodeAgentProfiles，fail-closed）

- 已打开的会话在**每次新建子 Agent 前**异步重读一次最新已提交配置：用户/项目
  agents Markdown + `v2/agents-state.json`。只读，不执行任何旧格式迁移
  （迁移仍只在启动装配时发生）。每次调用是独立完整快照，无跨派生可变缓存。
- 失败分类五码（`ACodeAgentConfigError`，全部 fail-closed——拒绝新派生，
  不沿用旧模型、不回退父模型、不吞错）：
  `agent_root_unreadable`（agents 根存在但不可读，含 ENOTDIR/EACCES）/
  `agent_profile_unreadable`（profile 文件读取失败）/
  `agent_profile_invalid`（本次目标 agent 自身解析失败或显式 model 非法）/
  `agents_state_unreadable`（state 文件 IO 失败）/
  `agents_state_malformed`（state JSON 损坏或字段形状非法，消息含修复引导）。
- 合法默认（不抛错）：agents 根目录缺失、state 文件缺失（ENOENT）= 无 profile / 无覆盖。
- **无关文件不阻断**：agents 根还承载普通 Markdown；只有 `agentType` 命中的目标
  agent 文件损坏才抛 `agent_profile_invalid`，无关文件（如 README）沿用启动装配的
  诊断/跳过语义。目标命中判定 = NFKC + 大小写 + 分隔符归一（与派发解析同规则）。
- state 覆盖读取是**严格版**（与启动的宽松 safeParse 刻意不同）：字段存在但形状/
  选择非法直接抛 `agents_state_malformed`，不接受「半损坏」；`plugin:` 前缀外的
  插件覆盖键忽略。内置覆盖键集单点来自 shared `BUILT_IN_SUBAGENT_NAMES`（5 名，
  **不得**回退为源分支的本地 2 名硬编码）。

### R6 live 快照组装：与启动装配同构，bundled 成员不得丢失

`createLiveSubagentProfilesLoader`（bootstrap app 层纯组合工厂，磁盘读取经注入）
每次调用产出 `LiveSubagentProfilesSnapshot`，拼接顺序与启动合并序同构：

```
caller（宿主显式注入） → bundled（最新禁用过滤 + 最新内置覆盖烘焙） → user → project
  → plugin（pristine 基线 + 最新覆盖，裸名别名与 caller/磁盘名冲突时被过滤，
     命名空间副本保留）
```

- **bundled 成员进 live 快照**：`loadCurrentACodeAgentProfiles` 接受
  `bundledProfiles`（启动时 `resolveBundledAgentProfiles` 的原始解析结果），
  用**最新** disabledAgentIds 过滤、用**最新** builtInModelSelectionOverrides 经
  `resolveBundledProfileModelSelection` 烘焙——与启动装配的 bundled 循环同一语义
  （`builtin-subagent-catalog.md` R5 / 回写第 5 条），单一判据不复制。
  源分支的 live 链不含 bundled（GAP-A 落地即丢 Plan/Verify/Review），本批修正。
- **pristine 插件基线**：create-app 启动时另取一次无任何覆盖的
  `loadPluginAgentProfiles` 结果作为基线；刷新时从基线重算覆盖。若从带覆盖的启动
  快照重算，被删除的插件覆盖会继续残留（旧模型被烘焙进去）。
- 快照的 `builtInModelSelectionOverrides` = `{ ...磁盘最新, ...caller 显式 }`
  （与 `resolveAppRuntimeConfig` 既有优先级一致）。
- 插件目录/启停/配置仍来自启动快照，live 链只刷新模型覆盖与用户/项目 profile，
  不重新扫描插件。

### R7 GAP-A：core 消费点（live-refresh 闭环）

- `core/src/subagent/runner.ts`：新增 `CurrentSubagentProfiles` 接口与
  `LoadCurrentSubagentProfiles` 类型；`ExploreSubagentPortOptions` 加可选
  `loadCurrentProfiles` 字段。
- `core/src/runtime/types.ts`：`AgentRuntimeConfig["subagents"]` 加可选
  `loadCurrentProfiles`（bootstrap 注入；core 只消费结果，不缓存跨派生快照）。
- **桥转发**：`methods/subagent.ts` 的 `createExploreSubagentPort` 调用处转发
  `this.config.subagents?.loadCurrentProfiles`（分支缺这步，链路断在桥上）。
- **三个派生边界消费**：runner 的 launch / run / start 在 loader 在场时
  `await loadCurrentProfiles(rawRequest.agentType)` 取最新快照，
  `normalizeAgentProfiles(current.profiles, { builtInModelSelectionOverrides:
  current.builtInModelSelectionOverrides ?? options.builtInModelSelectionOverrides })`
  后解析请求；**loader 缺席时行为与现状逐字节一致**（启动快照，旧宿主/测试替身/
  孙代理只读目录语义全部不变）。launch 的 background 判定与后续 run/start 的解析
  各自独立读取（配置在两次读取间变化时，后一次按最新事实 fail-closed，可接受）。
- loader 抛错（`ACodeAgentConfigError` 或其他）= 派生被拒绝，错误原样上抛给
  工具执行链（消息自带路径与修复引导）；core 不吞错、不回退启动快照。
- **恢复既有 child（SendMessage / resumeFromStore）不走 loader**，始终用启动快照
  ——live 重读只属于「新派生」边界（types.ts 字段注释同款语义）。

### R8 架构 ratchet 下的文件布局（拆分偿还）

所有新文件 ≤400 物理行，零 baseline 登记、零 disable 头注（源分支的
`/* eslint-disable max-lines */` 头注**不移植**）：

| 文件 | 职责 | 预估行数 |
| --- | --- | --- |
| `bootstrap/src/subagents.ts`（既有，瘦身） | 启动装配：loadACodeAgentProfiles（含 bundled 循环）+ loadPluginAgentProfiles（委托覆盖）+ 宽松 state 读取 | ~330 |
| `bootstrap/src/subagent-plugin-overrides.ts`（新） | R3 纯函数 + 身份解析 + 插件 profile 构造（parse/namespace/countBare） | ~220 |
| `bootstrap/src/subagent-live-state.ts`（新） | R5 live 读取 + 五码错误 + 严格 state readers + bundled live 循环 | ~380（超则再拆 readers） |
| `bootstrap/src/subagent-profile-shared.ts`（新） | 启动/live 共用内部件：sanitizeProjectAgentProfile、isDisabledUserProfile、isRecord、结果/状态类型 | ~80 |
| `bootstrap/src/app/subagent-live-profiles-loader.ts`（新） | R6 组合工厂 + LiveSubagentProfilesSnapshot | ~110 |
| `bootstrap/src/app/runtime-config.ts`（既有） | 只加 `subagentLoadCurrentProfiles` 入参与展开，loader 工厂不落在本文件 | ~355 |
| `bootstrap/src/app/official-plugin-definitions.ts`（既有，拆分） | agent-teams 条目 + 拆出兄弟文件保持 ≤400 | 各 ≤400 |

create-app.ts（+~36，baseline 在册 1301 行）与 core types.ts / runner.ts
（baseline 在册）允许小幅增长，不拆。

### R9 已知偏差与后续候选（登记在案，不在本项修）

- **member.md 为中文模型面文本**：与 `prompt-language-policy.md` R1（模型面恒英文）
  存在偏差。本批按上游原样移植（保真、便于与姊妹仓同步），处置模式同
  `builtin-subagent-catalog.md` R9：先登记血缘与偏差，自撰英文重写归独立内容批次。
  `commands/team.md`、`skills/agent-teams/SKILL.md`、`docs/` 同理。
- **member.md frontmatter 的 `maxTurns: 40` 无消费方**：解析器忽略未知键
  （分支上同样无效）。保留字段等待 maxTurns 支持落地或删除，归插件后续批次。
- 476880a 同批的 `packages/ui/src/ToolCallBlocks/toolCallFileChipMenu.{ts,test.ts}`
  与派生配置链无关（仅 fixture 字符串提到 agent-teams，分支上零消费者），**不移植**。

## 状态所有者

```
agents-state.json（~/.acode/v2/）        用户偏好唯一持久化点：内置/插件模型覆盖 + 禁用名单
   │
   ├─ 启动装配（一次性，含迁移）
   │    bootstrap/src/subagents.ts       loadACodeAgentProfiles：bundled 过滤/烘焙 + user/project
   │       ├─ subagent-profile-shared.ts    禁用/清洗判据单点（启动与 live 共用）
   │       └─ subagent-plugin-overrides.ts  插件覆盖优先级单点（R3，启动与 live 共用）
   │    bootstrap/src/app/create-app.ts  装配顺序 + pristine 插件基线（只取一次）
   │
   └─ 派生边界（每次新派生前，只读不迁移，fail-closed）
        bootstrap/src/subagent-live-state.ts        live 重读（R5 五码）+ bundled live 循环（R6）
        bootstrap/src/app/subagent-live-profiles-loader.ts   快照组装（R6 顺序）
           └─ runtime-config.ts → AgentRuntimeConfig.subagents.loadCurrentProfiles
                └─ core/src/runtime/methods/subagent.ts   桥转发（R7）
                     └─ core/src/subagent/runner.ts       launch/run/start 消费（R7）
                          └─ helpers/subagent-selection.ts  requireExplicitModelSelection fail-closed（R4）

apps/acode-cli/packages/agent-teams-plugin/     插件内容与 MCP server 单一事实源
bootstrap/src/app/official-plugin-definitions.ts  官方插件定义（版本/seed 门/默认启用）
packages/shared/src/plugin-marketplaces.ts        DEFAULT_ENABLED 镜像名单（与上者机械对照，场景 8）
sea-official-plugin-assets.mjs / prepare-agent-node-bundle.mjs /
build-desktop-agent-cli.mjs / prepare-prebuilds.mjs   四份发布暂存清单（R2）
```

- 覆盖优先级规则所有权：`subagent-plugin-overrides.ts` 单点；启动与 live 都不得
  另写第二套选择规则。
- 禁用/清洗判据所有权：`subagent-profile-shared.ts` 单点。
- bundled 成员的 live 语义所有权：`subagent-live-state.ts`（复用
  `resolveBundledProfileModelSelection`，不复制判据）。

## 接口

- `core/src/subagent/profile.ts`：`AgentProfile.requireExplicitModelSelection?: boolean`。
- `core/src/runtime/helpers/subagent-selection.ts`：`resolveSubagentSelection` 入参加
  `requireExplicitModelSelection?: boolean`；true 且无 profileSelection 无
  overrideSelection 时抛 ConfigurationError（R4）。
- `core/src/subagent/runner.ts`：`CurrentSubagentProfiles { builtInModelSelectionOverrides?,
  pluginAgentModelSelectionOverrides?, profiles }`、
  `LoadCurrentSubagentProfiles = (agentType: string) => Promise<CurrentSubagentProfiles>`、
  `ExploreSubagentPortOptions.loadCurrentProfiles?`（经 `core/src/subagent/index.ts`
  既有 `export *` 再导出）。
- `core/src/runtime/types.ts`：`AgentRuntimeConfig["subagents"].loadCurrentProfiles?`。
- `bootstrap/src/subagent-plugin-overrides.ts`：`applyPluginAgentModelOverrides(input):
  AgentProfile[]`（纯函数）。
- `bootstrap/src/subagent-live-state.ts`：`ACodeAgentConfigError`（含 `code` /
  `diagnostics`）、`loadCurrentACodeAgentProfiles({ logger?, storageRoot,
  workingDirectory, agentType?, bundledProfiles? }): Promise<LoadACodeAgentProfilesResult>`。
- `bootstrap/src/app/subagent-live-profiles-loader.ts`：`LiveSubagentProfilesSnapshot`、
  `createLiveSubagentProfilesLoader({ callerBuiltInModelSelectionOverrides?,
  callerProfiles?, loadCurrentProfiles, pluginProfiles, plugins }): LoadCurrentSubagentProfiles`。
- `bootstrap/src/app/runtime-config.ts`：`resolveAppRuntimeConfig` 入参加
  `subagentLoadCurrentProfiles?: LoadCurrentSubagentProfiles`，条件展开进
  `subagents.loadCurrentProfiles`。
- 不新增 `ACODE_` 环境变量、不新增协议命令；插件 userConfig 五项
  （stateDir/maxMembers/maxReassignRounds/panelEnabled/inheritCaptainModel）经
  `.mcp.json` 的 `${user_config.*}` 既有通道注入，无新机制。

## 验收场景

1. **插件构建与自测**：`pnpm --filter @acode/agent-teams-plugin build` 产出
   `dist/mcp/server.js`；`pnpm --filter @acode/agent-teams-plugin test` 全绿
   （分支 7 个测试文件原样跑通）；`scripts/smoke.mjs` 冒烟通过。
2. **seed 完整性（dev 形态）**：filesystem seed 后缓存目录含全部五项
   requiredSeedPaths；`ACODE_PLUGIN_SEED_INCOMPLETE` 不触发；dist 缺席时 seed
   拒写（负对照）。
3. **默认启用与名单一致**：definitions 派生的默认启用集合 ==
   shared 镜像集合（新 parity 单测）；agent-teams 在两者中在场。
4. **覆盖优先级与两分支**（`subagents-live.test.ts` 移植 + 适配拆分后模块路径）：
   插件专属覆盖 > general-purpose 回退 > 基线；inheritCaptainModel=true 剥标记走
   父继承；false 时 member 带 `requireExplicitModelSelection`，无模型即
   ConfigurationError（含引导文案）；别名/命名空间副本同步改写；无关 profile 不误改。
5. **live 重读 fail-closed**（同上测试文件）：不缓存、每次重读；缺失目录/state 是
   合法默认；7 种损坏 state → `agents_state_malformed`；目标 agent 损坏/显式非法
   model → `agent_profile_invalid`；无关 Markdown 损坏不阻断；根是文件 →
   `agent_root_unreadable`；不执行迁移（字节级保留原文）。
6. **loader 组合**（`subagent-live-profiles.test.ts` 移植）：拼接顺序 caller →
   bundled → 磁盘 → 插件；同名用户 member 建后插件裸名别名不再遮蔽（命名空间副本
   保留）；覆盖从 pristine 基线重算（删除覆盖后不残留旧模型）；内置覆盖
   `{...磁盘, ...caller}`。
7. **GAP-A 消费点**（新增 core 侧测试）：loader 在场时 launch/run/start 用最新快照
   派生（会话中新建的 user agent 立即可派发；删除的覆盖立即失效）；bundled
   Plan/Verify/Review 在 live 快照中在场且可派发（禁用后立即消失）；loader 抛错 →
   派生被拒、错误上抛；**loader 缺席 → 行为与现状逐字节一致**（既有 runner 测试
   全绿即证）；resume/SendMessage 路径不触发 loader。
8. **回归**：`apps/acode-cli/tests/builtin-subagent-catalog.test.mjs` 全绿
   （R5 bundled 装配未被 476880a 的回退性 hunk 波及）；`pnpm typecheck`、
   `pnpm lint`、`pnpm architecture:check --changed`（new 0 / regrown 0）、
   `pnpm knip` 门禁、受影响包测试与根 `pnpm test` 全绿。
9. **发布链登记核对**：四份清单（R2）逐处含 agent-teams 条目且版本四处一致；
   SEA dry-run 资产收集含 `dist/mcp/server.js`（本机可验证范围内）；桌面安装器
   端到端打包如实登记未验证面。

## 不在本项范围

- member.md / team.md / SKILL.md 的自撰英文重写（R9 登记，独立内容批次）。
- `maxTurns` frontmatter 支持（R9 登记）。
- `toolCallFileChipMenu.{ts,test.ts}` 移植（R9：与本链无关、零消费者）。
- prompt-snippets / web-remote-relay / conversation-export 等 0cc983f 剔除的其余面。
- AgentTeams 插件本体功能演进（DAG 调度、面板、邮箱协议按上游原样，改动归插件后续批次）。
- GUI 侧 AgentTeams 专属界面（插件经既有 marketplace/settings 面暴露，无新 UI）。

## 修订记录

（首版，2026-10-15：合入 0cc983f 剔除的 AgentTeams 链并偿还三缺口；默认启用为
2026-10-15 用户拍板的产品决策。）
