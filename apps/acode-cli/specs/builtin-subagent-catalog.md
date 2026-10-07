# 内置子智能体目录（bundled 官方预置层，C1）

给 ACode 增加一组**官方预置子智能体**（Plan / Verify / Review），与既有两个核心内置
（general-purpose / Explore）并存。预置层以 markdown 形式随 CLI 的 bundled 内容包分发，
复用现有加载、覆盖、禁用、模型选择机制；本 spec 定义目录内容、承载层、合并语义、
只读硬保证与 GUI 同步规则。

不改派发运行时（runner / 后台 / SendMessage / 恢复语义全部维持现状），不改 fan-out
深度门控，不新增协议命令。文本一律自撰英文（`prompt-language-policy.md` R1/R7），
禁止复制第三方产品提示词原文。

## 背景

### 已核实的现状（基线：当前检出，行号实施前需复核）

| 事实 | 位置 |
| --- | --- |
| 核心内置仅 general-purpose / Explore，TS 硬编码 profile + prompt | `core/src/subagent/profile.ts:65-129`（`createBuiltInExploreAgentProfile` / `createBuiltInGeneralPurposeAgentProfile`）、`general-purpose.ts`、`explore.ts` |
| profile 合并：先播种两个核心内置，再按数组顺序 `active.set(name)`，**后进者覆盖同名** | `core/src/subagent/profile.ts:88-112`（`normalizeAgentProfiles`） |
| markdown profile 加载根：`~/.acode/agents`（user）→ `<workspace>/.acode/agents`（project），数组顺序即 user 在前、project 在后 | `bootstrap/src/subagents.ts:54-57` |
| frontmatter 支持 name/description/tools/disallowedTools/model/color/permissionMode/memory/skills/background/injectAgentsMd/mcpServers | `core/src/subagent/profile.ts:153-224`（`parseAgentProfileFromMarkdown`） |
| `AgentProfileSource` 已含 `"built-in"`；project 级 frontmatter 的 permissionMode 被剥离，user/built-in 不剥离 | `core/src/subagent/profile.ts:16-18,182-184`、`bootstrap/src/subagents.ts:115-124` |
| permissionMode 仅 `auto | plan`，子运行时侧「profile 只能更严不能更松」 | `core/src/subagent/profile.ts:61`、`runtime/methods/subagent.ts:475-487` |
| 插件 bare-name 不得撞保留名单（现为硬编码二名） | `bootstrap/src/subagents.ts:47,131-134,160-174` |
| `subagent_type` 是自由字符串，新 profile 名无需改 contracts | `contracts/src/tools/agent.ts:16-25` |
| profile description + 工具清单被烘焙进 Agent 工具描述（装配期构建，每次对话常驻） | `core/src/subagent/profile.ts:131-151`（`formatAgentProfilesForPrompt`）、`tool/handlers/agent.ts`（`buildAgentProviderDescription`，见 `dispatch-discipline-prompt.md` R4） |
| bundled 内容包已存在且解决三形态分发（dev/Electron 原地读取、SEA 内容 hash 解压、远端 stage），包内已含 code-review / verify / run / research-report / dynamic-workflows 技能 | `bootstrap/src/app/bundled-skills.ts:1-40`（`resolveBundledSkillRoots`、`BUNDLED_SKILL_PACK_REQUIRED_PATHS`、`SEA_BUNDLED_SKILL_ASSET_PREFIX`）、`apps/acode-cli/packages/bundled-skills/skills/` |
| GUI 内置目录**第三处硬编码**：name/description/color/tools 在 services 侧重复一份，readOnly、恒 enabled | `packages/services/src/subagents/subagentsService.ts:82-140`（`createBuiltInAgents`、`BUILT_IN_AGENT_NAMES`）、`:788`（createAgent 保留名拒绝） |
| 禁用机制 `disabledAgentIds` 仅作用于 source `"user"` 的 markdown profile | `bootstrap/src/subagents.ts:93-95,304-318` |
| 内置模型覆盖通道按名字硬编码二键 | `bootstrap/src/subagents.ts:292-302`（`normalizeBuiltInSelectionOverrides`）、`core/src/subagent/profile.ts:12-14`（`BuiltInSubagentModelSelectionOverrides`）、services `:830-840` 同形 |
| 子代理汇报契约 / 工作纪律已全量注入每个子代理（common notes），profile prompt 不得复述 | `specs/subagent-report-contract.md` R1/R2、`core/src/subagent/system-prompt.ts`（`buildSubagentCommonNotes`） |

### 为什么不是「再加三个核心 TS 内置」

核心内置路线每加一个名字都要动五处按字面名硬编码的面：core profile 播种、contracts
`AgentType` 常量（可选）、bootstrap 保留名单、`BuiltInSubagentModelSelectionOverrides`
类型键、services `createBuiltInAgents`。目录内容（prompt / 工具面 / 描述）是**高频迭代、
低风险**的资产，绑死在 TS 发版周期里得不偿失。bundled markdown 路线让目录内容与
CLI 二进制解耦、天然被用户/项目同名覆盖（`normalizeAgentProfiles` 既有语义）、
并且分发问题已被 bundled-skills 包整体解决。

### 与 bundled skills 的关系（不重复承载）

包内已有 `verify` / `code-review` / `run` 技能：技能承载**方法**（怎么做一次验证/评审），
agent 承载**身份与工具面**（谁去做、能用什么工具、产出什么形态）。预置 agent 通过
frontmatter `skills` 引用**同包 bundled 技能**，prompt 只写身份、任务边界与红线，
不复制技能正文。技能门关闭时 profile 照常加载，skills 引用按 runtime 既有语义降级
（见验收场景 8）。

### 对照分析记录（oh-my-pi，2026-10-06）

对照来源是开源项目 oh-my-pi（omp，pi-mono fork）的**结构性分析**（仅本地只读克隆，
任何第三方 prompt 原文不进仓库、不进本 spec，`prompt-language-policy.md` R7 同款合规）。
omp 内置 5 个 task agent（scout / reviewer / security-reviewer / task / sonic），
定义形态为构建期内嵌 markdown + frontmatter、用户/项目同名文件整体替换内置——
与本 spec R1/R5 的承载层与覆盖语义同构，视为路线佐证。逐项吸收/拒绝结论：

- **吸收**：只读身份对父模型可见（omp 按工具面计算并打标；本 spec 改用
  `permissionMode: plan` 判据，R4）；findings 过滤判据归技能/prompt 分层
  （omp reviewer 的过滤器与其方法文本同层，我们拆给 code-review 技能，R3）。
- **记录在案的相反赌注**：omp 把验证留在编排者（子代理从不验证、产出标记为
  "claimed artifacts unverified"）；本目录保留 Verify 成员，依据是
  `dispatch-discipline-prompt.md` R2 第 5 条「独立验证要新起」（实现假设污染验证）
  与主会话「转述前查证」纪律——Verify 的报告本身即证据面（汇报契约 R1）。
- **拒绝**（详见「不在本项范围」）：模型角色别名绑定、常驻第二意见门（advisor/
  watchdog 形态）、prewalk / speculative launch、领域评审 agent（security-reviewer
  类，权限形态与 Review 重叠，违反 R2 判据 1）。
- **移交候选**（归其他 spec，不在本项落地）：omp scout 的「空结果先换策略再下
  结论」坚持条款，与 `explore.ts` 的诚实条款（`subagent-report-contract.md` R3）
  互补，候选进该 spec 的后续批次；omp yield ladder 的反虚构条款（不得编造终止
  理由）同理候选进汇报契约。

### 对照分析记录（zoode 还原件 / 第三方产品，2026-10-06）

对照来源是 zoode 工作区的第三方产品还原件（Claude Code CLI 2.1.275 / 2.1.283，
仅本地只读静态分析；**任何第三方原文不进仓库、不进本 spec**，
`prompt-language-policy.md` R7 与 `dispatch-discipline-prompt.md` 修订记录同款合规）。
原件的可派发内置目录为 8 类（general-purpose / Explore / Plan / 文档问答 /
statusline 配置 / 条件注入的网页阅读代理 / 后台 catch-all / coordinator worker）
+ fork 伪类型，全部 TS 硬编码注册、黑名单式工具面、目录经动态 reminder 注入
而非烘焙进工具描述。逐项吸收/拒绝结论：

- **吸收**：强制尾部输出契约（原件 Plan 以固定小节收尾列出实现关键文件，父侧
  可机械提取——本 spec R3 第 6 条给三个成员各定尾部契约）；description 负边界
  条款（原件 full 版 description 含「不适用于 X + 失败机理」句——R3 description
  三要素）；Plan 的 perspective 一等参数（派单 prompt 可带视角、多视角可并行
  扇出——R3 第 7 条，复用既有单消息多派发语义，零新机制）。
- **记录在案的分歧**：原件对只读 agent **省略**项目记忆注入（省 token）；
  本目录维持 `injectAgentsMd: true`——Plan/Verify/Review 的产出必须有仓库
  依据（命令、架构规则、spec 流程都在 AGENTS.md），且 R3 第 3 条「prompt
  仓库无关」的前提就是仓库事实经注入获得。原件模型绑定为 inherit + 上限
  （只读分析类跟随父模型但封顶）：需要先扩 ModelSelection 能力，归
  「不在本项范围」。
- **拒绝**：黑名单式工具面（白名单更严、fail-safe 方向一致）；fork / 团队
  协调 / worktree 隔离 / 深度 3 调度面（本 spec 钉住派发运行时不动，深度维持
  现状）；固定模型档位名（与其模型体系耦合，档位名不可移植）。原件「到深度
  上限物理摘除派发工具」的能力剥夺原则，ACode 现状（子运行时结构性关闭
  subagents，`dispatch-discipline-prompt.md` 背景节）已是同款实现，无需动作。
- **移交候选**：三态纪律（失败即停并说明、歧义取最可能解释并声明假设、同一
  失败路径不二次重试）与权限拒绝回报格式，所有权在 common notes
  （`subagent-report-contract.md`），候选进其后续批次。
- **血缘确认与合规登记**：现有核心内置 general-purpose 与 Explore 的 description
  与还原件原文逐字一致（Explore 为其精简版，缺少完整版的负边界清单与第三档
  搜索广度），证据位置见 zoode 工作区 `claudecli` / `Claude` 两处 bundle 与
  提取件索引。与 `prompt-language-policy.md` R7 的存量冲突，处置方向已经
  产品拍板（2026-10-06）：**自撰重写**，规则归 R9；其余存量模型面文本不在
  本批（R9 第 5 条）。

## 产品规则

### R1 承载层：bundled 内容包新增 `agents/` 子目录，不新建分发通道

- 预置 agent markdown 存放于 `apps/acode-cli/packages/bundled-skills/agents/<name>.md`，
  与 `skills/` 平级。复用该包既有的三形态解析（dev/Electron 原地、SEA 资产前缀 +
  内容 hash 解压、远端 stage），**不新增** SEA 资产前缀、manifest 或 stage 脚本。
- `BUNDLED_SKILL_PACK_REQUIRED_PATHS` 追加全部 `agents/*.md` 路径：包内文件是必需资产，
  缺任何一个拒绝整包（与技能同款 all-or-nothing 语义，`bundled-skills.ts:26-30`）。
- 包不重命名（重命名牵动 SEA 前缀、远端 stage 路径与桌面 resources 布局，收益不抵风险）；
  在包 README 与 `bundled-skills.ts` 头注释补一句「本包同时承载官方预置 agent」。
- bootstrap 侧新增解析函数从同一 pack root 取 `agents/` 目录（接口节），加载结果
  `source: "built-in"`、`path` 指向实际文件（GUI 侧展示 `bundled:<name>` 形态别名，见 R7）。
- general-purpose / Explore **维持核心 TS 内置不迁移**：两者的 prompt 依赖运行时分支
  （`explore.ts` 的 embedded-search 变体）且被 `isBuiltInExploreAgentProfile` 等按
  name+source 判定消费；迁移是独立重构，不进本项（见「不在本项范围」）。

### R2 目录内容（v1 三个，全部动词命名，与 Explore 风格一致）

| 字段 | Plan | Verify | Review |
| --- | --- | --- | --- |
| 定位 | 只读调研 + 产出实现方案/spec 草案 | 跑 typecheck/lint/test、在真实表面驱动改动面，如实报告 | 对 diff/分支/commit 范围做评审，只输出 findings |
| tools | `Read, Grep, Glob, Bash, WebFetch, WebSearch, TodoWrite` | `Bash, Read, Grep, Glob, TodoWrite` | `Read, Grep, Glob, Bash, Grep, TodoWrite`（去重后 `Read, Grep, Glob, Bash, TodoWrite`） |
| disallowedTools | — | `Edit, Write, ApplyPatch`（实现决定回写第 1 条：NotebookEdit 系已移除的占位死名，不写入） | — |
| permissionMode | `plan` | 不设（需要 Bash 执行测试/构建） | `plan` |
| skills | — | `verify`（同包 bundled 技能） | `code-review`（同包 bundled 技能） |
| background | `false`（产出直接决定父会话下一步） | `true`（长跑、完成通知） | `true` |
| injectAgentsMd | `true` | `true` | `true` |
| color | `purple` | `green` | `yellow` |
| modelSelection | 不设（继承父模型，R5） | 不设 | 不设 |

设计判据（增删目录成员前先过这张表）：

1. **按权限形态划分，不按业务领域划分**。三个新成员各占一个与现有二者不重叠的权限形态：
   Plan/Review = 运行时只读地板（permissionMode plan）；Verify = 可执行不可编辑
   （白名单无编辑工具）；general-purpose = 全权限；Explore = 只读搜索白名单。
   「React 专家」「SQL 专家」类领域 agent 是用户/项目 markdown 的空间，不进官方目录。
   领域评审 agent（安全评审类）与 Review 权限形态相同、仅方法不同——方法归技能
   （同 R3 第 5 条的分层），不进目录（对照分析记录中的拒绝项）。
2. **数量上限即 token 预算**：每个 profile 的 description + 工具清单常驻每次对话的
   Agent 工具描述（背景表倒数第四行）。目录扩容须以「权限形态不重叠」为准入判据，
   不以「有用」为判据。
3. **Fix 类（可写修复代理）不进 v1**：general-purpose + 汇报契约 R2 五条纪律
   （scope / 验证后完成 / git 卫生 / 被拒协议 / resume）已覆盖该形态；单独立项等
   出现「收窄写权限」的真实需求（见「不在本项范围」）。

### R3 description 与 prompt 写作纪律

- **description**（进 Agent 工具描述，面向父模型的选择判据）：每条 ≤ 350 字符，
  三要素齐备——定位句、"Use when …" 触发句、**负边界句**（不适用于什么 +
  失败机理，如「评审整仓历史请用 Review——它只读节选，做逐行审计会漏」；
  能力边界如 "Cannot edit files." 可与负边界合并成句）。负边界是对照吸收项
  （对照分析记录·zoode）：误派发的成本远高于 description 多一句话的 token 成本。
  不复述工具参数（归工具描述层，`dispatch-discipline-prompt.md` R1 分层表）。
- **prompt 正文**（markdown body → `systemPrompt`）：
  1. 自撰英文，无 CJK，无第三方产品原文（`prompt-language-policy.md` R1/R7，
     测试同款断言，验收场景 9）。
  2. **不复述** common notes / 汇报契约 / 派发纪律（它们已全量注入每个子代理；
     复述稀释两处文本各自所有权，`subagent-report-contract.md` R2 约束同向）。
  3. **仓库无关**：不写死本仓库的命令与路径；仓库特定事实（测试命令、架构规则、
     spec 目录）依赖 `injectAgentsMd: true` 注入的 AGENTS.md。
  4. 结构对齐既有内置：身份/任务定位 → strengths → guidelines → 红线（参照
     `explore.ts` 只读红线段的写法；红线含「找不到就明说、不用记忆补」同款诚实条款）。
  5. 每个 agent 的专属红线：Plan 不产出代码文件、方案落笔为可转述文本；
     Verify 不修代码、失败原样报告不粉饰（与汇报契约 R1「区分验证与意图」同口径）；
     Review 只报告 findings 不动手修。**Review 的 findings 方法学归同包
     `code-review` 技能**（过滤器判据：本次变更引入、离散可操作、带 file:line
     证据——技能文本已承载，prompt 引用不复述）；prompt 只约束**产出形态**：
     逐条 findings + 严重度 + 证据位置，末尾一句可转述结论（汇报契约 R1 同口径）。
  6. **强制尾部输出契约**（对照吸收项·zoode）：每个 prompt 定义一个固定标题的
     收尾小节，让父侧可机械提取、也让「完成」有可检验的形态——
     Plan：`### Critical Files for Implementation`（3-5 个对落地最关键的文件，
     各配一句为什么）；Verify：`### Check Results`（逐项 检查点 → 执行的命令 →
     PASS/FAIL/SKIPPED，SKIPPED 必须给原因）；Review：`### Verdict`（一句
     可转述判决：可合入 / 需先修复哪些 findings）。小节标题是 prompt 自撰英文
     的一部分，进文件本体，不是运行时机制。
  7. **Plan 的 perspective 契约**（对照吸收项·zoode）：Plan prompt 声明输入
     契约——派单 prompt 可携带一个可选视角（如 简洁性 / 性能 / 可维护性 /
     根因 vs 绕行），带视角时方案全程贯彻该视角并在开头声明，不带时均衡权衡。
     父侧多视角并行扇出（一条消息派多个不同视角的 Plan）复用既有单消息多派发
     语义（`dispatch-discipline-prompt.md` 背景节），**不新增**任何调度机制、
     不写并行数量（数字归模式 reminder，该 spec R6）。

### R4 只读硬保证：两层，提示词只是第三层

- Plan / Review 设 `permissionMode: plan`：子运行时侧「只能更严」既有保证
  （`runtime/methods/subagent.ts:475-487`）+ 进程策略地板
  （`subagent-policy-floor-inheritance.md` R1/R3）承担硬保证。
- Verify 需要 Bash 执行测试，不能用 plan 地板；其「不可编辑」由工具白名单承担
  （无 Edit/Write/ApplyPatch + `disallowedTools` 双写防白名单解析回退）。
  **已知边界（记录在案，不做命令级拦截）**：白名单含 Bash 即可写文件，与 Explore
  的既有边界同款；由 prompt 红线 + 汇报契约约束，不引入 Bash 命令级拦截
  （成本高且与 `subagent-report-contract.md` W4 结论「硬保证不依赖提示词清单」一致）。
- 实现时核验：plan 地板下 Plan 子代理的**只读 Bash**（grep/find/git log 等）仍可用；
  若 plan 模式拦截面过宽导致调研不可行，Plan 降级为 Verify 同款白名单形态
  （去掉 permissionMode），决定回写本 spec「实现决定回写」节（验收场景 4）。
- **父侧可见性（对照吸收项）**：`formatAgentProfilesForPrompt` 对
  `permissionMode === "plan"` 的 profile（含用户/项目 markdown）在描述行追加
  `(read-only)` 标注，让父模型在派发前就能看到只读硬保证。判据**必须是权限地板
  而不是工具面推断**：Bash 在 Explore/Verify 白名单内但可写文件，按工具面计算
  会漏标 Explore（其只读性由 prompt 红线 + 无编辑工具承担，描述文本已自述）
  或误标 Verify（可执行）。签名不变，行为扩展（接口节）。

### R5 合并语义与命名保护

- **加载顺序**：bundled root 解析出的 profiles 插入 markdown profiles 数组**最前**，
  即 `normalizeAgentProfiles` 的覆盖序为：核心内置（播种）< bundled < user < project。
  用户/项目同名 markdown **整体替换** bundled profile（含 tools/prompt，非字段级合并），
  与既有「同名覆盖内置 Explore」语义一致（`profile.ts:84-86` 注释判例）。
- **保留名单动态化**：`RESERVED_AGENT_NAMES` 从硬编码二名改为「核心内置二名 ∪
  bundled 包 agents 目录文件名」；插件 bare-name 撞名单仍走 `agent_ambiguous_name`
  诊断 + 仅暴露命名空间名（`bootstrap/src/subagents.ts:160-174` 行为不变）。
  GUI `createAgent` 的保留名拒绝（services `:788`）同步读到同一名单（R7）。
- **禁用**：`isDisabledUserProfile` 扩展至 source `"built-in"` 且 path 位于 bundled 包的
  profile（核心内置二名维持不可禁用现状）；state id 用既有
  `createAgentStateId({ name, scope: "built-in", source: "built-in" })`。
  禁用后 CLI 不装配该 profile、Agent 工具描述不含该条目。
- **模型选择**：v1 预置不钉模型档位（可用模型矩阵因账号而异，钉死即错默认值），
  继承父模型。GUI 覆盖通道：`BuiltInSubagentModelSelectionOverrides` 的键集从字面
  二名扩为 `BuiltInSubagentName` 联合（shared 类型 + core `profile.ts:12-14` +
  bootstrap `normalizeBuiltInSelectionOverrides` 改为遍历联合而非硬编码二键 +
  services 同形 normalize）。旧 state 文件含未知键时忽略不报错（既有 safeParse 方向）。

### R6 prompt/description 的单一事实源是 markdown 文件本身

- 不建第二份目录 manifest（TS/JSON 镜像 frontmatter）：镜像必漂移。core / bootstrap /
  services 消费的都是**解析后的 AgentProfile**。
- 现有三处核心内置硬编码（core profile.ts、bootstrap 保留名单、services
  `createBuiltInAgents`）维持现状不动——本项不做结构性重构（R9 的 description
  文本替换除外），只保证**新增目录成员不再进入硬编码面**：bootstrap 保留名单
  动态化（R5）后，services 侧名单同样从 bundled root 派生（R7），core 播种
  函数不新增。

### R7 GUI 同步（packages/services）

- `SubagentsServiceOptions` 新增可选 `bundledAgentsRoot?: string`：desktop host 用与
  CLI 同款的包解析（`resolveBundledSkillRoots` 同源 pack root + `agents/` 子目录）
  传入；缺省（Web/未接线环境）时 GUI 不显示 bundled 成员，不伪造条目。
- `list()` 结果中 bundled 成员排在核心内置之后、user 之前：`source: "built-in"`、
  `scope: "built-in"`、`path: "bundled:<name>"`（展示别名；真实文件路径留在 CLI 侧
  诊断）、`readOnly: true`（内容不可编辑、不可删除）、`enabled` 随 `disabledAgentIds`
  （R5，与核心内置的恒 enabled 不同）。
- 模型覆盖与禁用走既有 `agents-state.json` 通道；`updateAgent` / `deleteAgent` 对
  bundled 成员抛错（同核心内置的 readOnly 处理）。
- settings 页无需新 UI 形态：bundled 成员复用既有 built-in 卡片，仅多一个启停开关。

### R8 诊断与失败姿态

- bundled markdown 解析出 diagnostic（缺 frontmatter、缺 name/description、非法
  memory/mcpServers）时：该文件不装配、diagnostic 照既有通道上报
  （`loadACodeAgentProfiles` 返回值），**不静默**。因文件随包分发，正常发版路径
  不可能触发；触发即分发资产损坏，与 R1 all-or-nothing 校验同向。
- bundled 包整体缺席（三形态解析全失败）：warn 日志（同 `bundled-skills.ts:70-76`
  姿态），目录降级为现状二内置，CLI 正常启动。

### R9 存量核心内置 description 的自撰合规重写（方向已拍板，2026-10-06）

血缘事实见「对照分析记录·zoode」：general-purpose 与 Explore 的 description 为
第三方还原件原文（Explore 系其精简版）。处置方向经产品拍板为**自撰重写**，
不维持原文兼容。规则：

1. **兼容面 = 名字与行为，不是 prose**：`general-purpose` / `Explore` 名字字面量、
   `subagent_type` 派发命中、工具面、Explore 的 medium / very thorough 两档广度
   参数语义全部不变，只替换 description 文本。`Task` 别名的兼容目的
   （`tool/compat.ts`）不受影响。
2. **重写要求**：自撰英文，满足 R3 description 三要素（定位 / 触发 / 负边界句）；
   Explore 的负边界句补回其精简时丢失的反用途语义（不做代码评审 / 逐行审计类
   任务——只读节选会漏）。**不新增第三档广度**：单点快查档与
   `dispatch-discipline-prompt.md` 既有判据「单事实查询直接搜」冲突，加档反而
   鼓励用 Explore 替代直搜。
3. **同步替换点**：core `profile.ts` 两个 createBuiltIn*Profile 的 description
   字符串 + services `createBuiltInAgents` 的重复简版文本（保持为同一自撰文本的
   简版投影，不引入第二套措辞）。
4. **合规断言方式**：golden / 描述快照同批更新（与验收场景 2 的三变量矩阵、
   R4 标注共用一次快照更新完成）+ 人工审查；**不做与还原件字符串的自动比对**——
   那需要第三方原文进仓库测试代码，本身违反 `prompt-language-policy.md` R7。
5. 其余存量模型面文本（common notes 既有条目等）不在本批；如需合规审查归其
   所有权 spec（`subagent-report-contract.md`）的后续批次。

## 状态所有者

```
apps/acode-cli/packages/bundled-skills/agents/*.md   目录内容与 prompt 的单一事实源（R1/R6）
   │
   ├─► bootstrap/src/app/bundled-agents.ts（新）      pack root 解析（复用 bundled-skills 三形态）
   │      └─ bootstrap/src/subagents.ts               bundled root 加载（source "built-in"，数组最前）
   │             ├─ RESERVED_AGENT_NAMES ← 核心二名 ∪ 包内文件名（R5，动态）
   │             └─ isDisabledUserProfile ← agents-state.disabledAgentIds（R5，扩展至 bundled）
   │
   ├─► core/src/subagent/profile.ts                   normalizeAgentProfiles 合并序（不改函数，
   │      （现状态：播种二内置 → 数组后者覆盖）          只约束入参数组顺序，R5）
   │
   ├─► core/src/tool/handlers/agent.ts                Agent 工具描述（formatAgentProfilesForPrompt
   │                                                    既有出口，不改，R2 数量上限的动因）
   │
   └─► packages/services/src/subagents/               GUI list/启停/模型覆盖（R7，
          subagentsService.ts                           bundledAgentsRoot 注入，不硬编码新成员）

agents-state.json（~/.acode/v2/）  disabledAgentIds + builtInModelSelectionOverrides
                                    —— 用户偏好唯一持久化点（现状文件，仅键集扩展，R5）
runtime/methods/subagent.ts        permissionMode plan 地板 + 工具白名单解析（现状，不改，R4）
```

- prompt 文本所有权：bundled markdown 文件；任何 TS 面不得镜像其内容（R6）。
- 「哪些名字是保留名」所有权：核心二名常量 ∪ 包目录派生名单（bootstrap 单点计算，
  services 经 R7 通道获得），不得再出现第四份硬编码名单。
- 合并顺序所有权：bootstrap 装配层（数组顺序）；core `normalizeAgentProfiles`
  函数本身不改。

## 接口

- `bootstrap/src/app/bundled-agents.ts`（新文件）：
  `resolveBundledAgentProfiles(options: { cliStorageRoot: string; logger?: Logger }): Promise<{ profiles: AgentProfile[]; diagnostics: AgentProfileParseDiagnostic[] }>`
  ——内部复用 `bundled-skills.ts` 的 pack root 解析（导出一个共用的
  `resolveBundledContentPackRoot`，skills 侧改调用它，行为不变）；返回的 profiles
  `source: "built-in"`、`path` 为实际文件路径。
- `bootstrap/src/subagents.ts`：`loadACodeAgentProfiles` 增加可选入参
  `bundledProfiles?: readonly AgentProfile[]`（由 create-app 装配时先解析再传入，
  避免 bootstrap 内部两处各自解析 pack root）；内部把 bundled profiles 置于
  markdown profiles 数组最前。`RESERVED_AGENT_NAMES` 改为
  `coreReservedNames ∪ bundled 派生名单` 的单点函数。
- `core/src/subagent/profile.ts`：`BuiltInSubagentModelSelectionOverrides` 键集扩为
  `BuiltInSubagentName`（shared 联合类型扩 `Plan | Verify | Review` 字面量）；
  `normalizeAgentProfiles` / `parseAgentProfileFromMarkdown` 签名不变；
  `formatAgentProfilesForPrompt` 签名不变、行为扩展——`permissionMode === "plan"`
  的条目描述行追加 `(read-only)` 标注（R4 父侧可见性）；两个
  `createBuiltIn*AgentProfile` 的 description 字符串同批自撰重写（R9，签名与
  其余字段不变）。
- `packages/services/src/subagents/subagentsService.ts`：`SubagentsServiceOptions`
  新增 `bundledAgentsRoot?: string`；`createBuiltInAgents` 二内置硬编码**结构**
  不动（description 文本按 R9 同批替换为自撰简版投影），新增
  `loadBundledAgentSummaries(root)`（复用 `subagentMarkdown.ts` 宽松解析），
  list 合并顺序 = 核心内置 → bundled → user → workspace → plugin runtime。
- `bundled-skills.ts`：`BUNDLED_SKILL_PACK_REQUIRED_PATHS` 追加
  `agents/Plan.md`、`agents/Verify.md`、`agents/Review.md`；
  导出 `resolveBundledContentPackRoot`（现 `resolveFilesystemBundledSkillPackRoot` +
  `materializeSeaBundledSkillPack` 的组合上提，skills 消费方行为不变）。
- 不新增 `ACODE_` 环境变量、不新增协议命令、不新增 reminder source。

## 验收场景

1. **三形态分发**：dev/Electron 从 `packages/bundled-skills/agents/` 原地解析；
   SEA 形态 agents 文件随包资产解压（manifest 含 `agents/*.md`，缺文件拒绝整包）；
   远端 stage 目录含 agents 子目录。既有 bundled-skills 测试扩展断言，不新起通道。
2. **装配在场**：默认配置下 `normalizeAgentProfiles([])` 结果含 5 个 profile
   （二核心 + 三 bundled）；Agent 工具描述含三条新条目及各自工具清单；
   Plan / Review 条目描述行含 `(read-only)` 标注，general-purpose / Explore /
   Verify 不含（判据 = permissionMode，R4）；`dispatch-discipline-prompt.md`
   验收场景 5 的三变量描述快照矩阵同批更新且全绿。
3. **覆盖与保留名**：user 目录放同名 `Plan.md` → 装配结果该名为 user profile
   （tools/prompt 整体替换）；project 同名压过 user 同名（既有顺序不变）。
   插件 agent bare name = `Verify` → 仅暴露 `plugin:Verify` + `agent_ambiguous_name`
   诊断；GUI createAgent 以 `Review` 为名被拒（保留名单动态含 bundled 名）。
4. **只读地板**：派发 Plan / Review 子代理，子运行时工具面无 Edit/Write/ApplyPatch
   且 permissionMode 为 plan（策略地板继承测试同款断言）；**并实测** plan 地板下
   只读 Bash（grep/git log）可执行——若被拦截，按 R4 降级白名单形态并回写
   「实现决定回写」。派发 Verify：工具面无编辑工具、Bash 可跑测试命令。
5. **禁用**：GUI 禁用 Verify → `agents-state.json` 写入 disabledAgentIds →
   CLI 重新装配后无该 profile、工具描述无该条目；核心二内置不受禁用影响
   （无开关）。重新启用即恢复。
6. **模型覆盖**：GUI 给 Review 设模型 → `builtInModelSelectionOverrides.Review`
   持久化 → 派发时 `resolveSubagentSelection` 生效（override > profile > 父继承
   优先级不变）；旧 state 文件（仅二键）加载不报错。
7. **GUI list**：settings 页显示三个 bundled 成员（source/scope "built-in"、
   path `bundled:<name>`、readOnly、有启停开关）；updateAgent/deleteAgent 对其抛错；
   `bundledAgentsRoot` 缺省时不显示、不报错（Web 环境姿态）。
8. **skills 引用降级**：技能门关闭的环境下 Review profile 照常加载与派发，
   `skills: [code-review]` 按 runtime 既有语义静默降级（不产生派发失败）。
9. **语言与内容合规**：三个 markdown 的 description 与正文无 CJK；正文不含
   common notes / 汇报契约 / 派发纪律的复述句（人工审查 + 无 CJK 自动断言，
   `subagent-report-contract.md` R4 同款）；description 各 ≤ 350 字符且含
   负边界句（R3）；三个 prompt 各自定义强制尾部小节（Plan 关键文件清单 /
   Verify 逐项检查结果 / Review 一句判决，R3 第 6 条），Plan prompt 含
   perspective 输入契约句（R3 第 7 条）。
10. **R9 存量重写**：general-purpose / Explore 的 description 重写后满足 R3
    三要素（含负边界句），Explore 描述保留 medium / very thorough 两档字面量、
    无第三档；services 简版文本与 core 为同一自撰文本投影；派发行为不变
    （`subagent_type` 二名命中同一 profile、工具面与广度语义不变，由既有
    派发链路测试断言）；description 快照与场景 2 同批一次更新全绿。
11. **验证命令**（仓库根执行，如实记录）：`pnpm typecheck`、`pnpm lint`、
    `pnpm architecture:check -- --changed`、
    `node --import tsx --test apps/acode-cli/tests/builtin-subagent-catalog.test.mjs`（新）、
    既有 `apps/acode-cli/tests/subagent-*.test.mjs`、`dispatch-discipline-prompt.test.mjs`
    与 services 侧 subagents 测试全量；触及 prompt 段则
    `pnpm prompt-manifest:generate && pnpm prompt-manifest:check`（apps/acode-cli 下）。

## 不在本项范围

- **Fix / Debug 类可写修复代理**：general-purpose + 汇报契约 R2 纪律已覆盖该形态；
  「收窄写权限的修复代理」待真实需求出现后单独立项（R2 判据 3）。
- **领域评审 agent（安全评审类）**：权限形态与 Review 重叠，方法归技能或用户
  markdown（R2 判据 1、对照分析记录拒绝项）。
- **general-purpose / Explore 迁入 bundled 包**：两者 prompt 有运行时分支与
  name+source 判定消费方，迁移是独立重构；迁完后核心播种函数才可退役。
- **模型角色别名绑定与 inherit+cap**（对照分析的两种档位形态：@smol/@slow 式
  角色别名，一处配置全目录换档；或 只读分析类跟随父模型但设上限）：均需要先扩
  ModelSelection / 新增 modelRoles 类配置面与解析链，v1 仅继承 + 既有覆盖通道；
  出现多 agent 差异化档位的真实需求后再立项。
- **Agent Hub 式运行时 roster GUI**（在跑/已停 agent 的实时观察、转向、复活面板）：
  现状由 task-notification 与后台任务面板承载基础可见性；独立立项。
- **advisor / watchdog 式常驻第二意见门**（含同步 agent-end 评审、EmissionGuard
  噪声抑制）：引入无界等待与隔离机制，对照分析明确拒绝。
- **prewalk（首次编辑中途换模型）/ speculative launch（流式解析中途启动 spawn）**：
  高复杂度，omp 侧亦为默认关/可选，拒绝。
- **Bash 命令级拦截**（只读代理的白名单内写命令）：与 W4 结论一致不做，
  硬保证归策略地板三层。
- **目录国际化 / 按 locale 分叉 prompt**：`prompt-language-policy.md` 单一文本原则。
- **fan-out 深度、fork/team/coordinator 形态**：维持既有 spec 判定
  （`dispatch-discipline-prompt.md`「不在本项范围」节）。

## 实现决定回写

> 实施 PR 合入时按各 R 中的授权填写（至少含：R4 plan 地板实测结论、
> 接口节 `resolveBundledContentPackRoot` 上提的最终形态）。

1. **Verify 的 disallowedTools 不含 NotebookEdit**（2026-10-06 内容实施批次）：
   核实 `core/src/tool/provider-visible-order.ts` 头注释，NotebookEdit 是工具面
   已移除的占位死名（prompt-corpus-audit F7 判例）；写入不存在的工具名无拦截
   效果且污染 profile。实际双写白名单为 `Edit, Write, ApplyPatch`，R2 表已同步。
   判例登记于 `tests/bundled-agent-content.test.mjs` 中文注释。
2. **`resolveBundledContentPackRoot` 最终形态**（2026-10-06 bootstrap 实施批次）：
   `async (options: ResolveBundledSkillRootsOptions) => Promise<string | undefined>`
   ——SEA 物化 ?? 文件系统候选；缺席返回 undefined，warn 降级姿态由各消费方自持；
   `resolveBundledSkillRoots` 改为调用它，skills 侧行为逐字不变。`bundled-agents.ts`
   另导出 `loadBundledAgentProfilesFromRoot(packRoot, logger)` 供 pack root 已知方
   （services `bundledAgentsRoot` 通道）复用，避免第二套解析。
   `createReservedAgentNames(bundledProfiles?)` 为保留名单单点函数；create-app 装配
   传入的是**包内容派生名**而非装配结果名——被禁用的 bundled 成员仍占用保留名单
   （禁用是用户偏好，不应把名字释放给插件 bare-name 抢注）。
3. **分发脚本缺口（实施中发现，独立批次跟进）**：`sea-bundled-skill-assets.mjs`
   只 walk `skills/` 且自带与 bootstrap 常量漂移的 required-paths 副本；
   `prepare-prebuilds.mjs` 的 `topLevelPaths: ["skills"]` 会裁掉 `agents/`；
   desktop `prepare-agent-node-bundle.mjs` 疑似同款。缺口后果是 SEA/远端形态
   物化包缺 agents 文件 → 完整性门拒绝**整包**（技能+agent 一起降级）。
   验收场景 1 的三形态中 dev 形态已绿，SEA/远端形态归打包脚本批次闭合。
4. **GUI 侧 bundled root 解析形态**（2026-10-06 services 实施批次）：
   `subagentStorage.ts` 新增 `resolveBundledAgentsRoot()`——复用 services 既有
   `findACodeAgentRuntimeNodeBundle()` 资源定位链（打包态 resources/glm、dev
   staged bundle、安全加固 env 门）取 bundle 同级 `packages/bundled-skills/agents`，
   monorepo dev 兜底仓库源目录，全部缺席返回 undefined（R7 缺省姿态）。
   desktop 不依赖 `@acode/bootstrap`，故未直接复用 `resolveBundledContentPackRoot`，
   留有 TODO 待依赖方向定案（services 内自持 vs 下沉共享包）——集成期核对
   architecture:check 结果后回写定案。接线点：`createLocalServices` 可选透传
   （node.ts）+ desktop 本地/远程两处 host 调用点注入。
   附带修复：`deleteAgent` 此前对 `built-in:*` 别名路径静默"成功"（rm 非文件
   路径），现对 bundled/built-in 别名显式抛错（与 updateAgent 同守卫）。
   dev staged bundle 尚未含 agents/（stage 早于内容落地），GUI 按候选链自动
   回退仓库源目录，不受影响；打包脚本批次（第 3 条）闭合后随下次 stage 对齐。
5. **模型覆盖的派发级生效点与成员判定单点**（2026-10-06 core+shared 收尾批次）：
   `normalizeAgentProfiles` 只给播种的核心二内置应用 overrides（本 spec 钉住
   不改该函数），bundled 成员的 override 改为在 `loadACodeAgentProfiles` 装配期
   烘焙——判据 `source === "built-in"` 且带 path（与禁用判定同款），命中
   `isBuiltInSubagentName` 名单后以不可变替换写入 `profile.modelSelection`，
   与 plugin override 烘焙同模式；user/project 同名整体替换后 override 不迁移
   （用户 markdown 走自己的模型选择语义）。烘焙结果由既有
   `resolveSubagentSelection`（override > profile > 父继承）消费，派发链零改动。
   shared 新增 `isBuiltInSubagentName` 谓词为成员判定单一事实源（bootstrap 烘焙、
   UI settings 判定共用）；UI 侧 `supportsEnabledToggle` 增加 `bundled:` 前缀
   分支（R7 启停开关的 UI 落点，场景 5 由此可操作）。core `runtime/types.ts` 与
   `runner.ts` 的内联二键 Record 同步收敛为 shared 类型（纯类型面，零行为变化）。
   遗留（后续批次候选）：`"bundled:"` 前缀字面量在 services 与 UI 各有一份
   （spec R7 明文契约，单点化可导出常量）；`resolveSubagentSelection` 无
   派发级 runtime harness 直测（本批钉住的是归一化交接面）。
6. **R4 plan 地板实测结论：维持 permissionMode plan，不降级**（2026-10-06
   集成验证批次）。证据链：Bash 的权限 capability 按**命令级**解析
   （`tool/handlers/bash.ts` 的 `resolvePermissionCapability` 接线
   `resolveBashPermissionCapability`）——只读命令（`isRuntimeReadOnlyBashCommand`
   判定，含 grep/find/git log/git diff/ls/cat 形态）标 `readOnly: true,
   destructive: false`，plan 模式经 `mode.plan.readOnly` 分支放行
   （`permission/service.ts` `checkPlanMode`）；非只读命令回落默认 capability
   （readOnly false）被 `mode.plan.nonReadOnly` 拒绝。功能级实测 10/10
   （6 条只读命令全放行、rm/git commit/pnpm install/sed -i 全判非只读）。
   Plan / Review 的 plan 地板与只读 Bash 调研兼容，白名单降级分支不触发。
7. **架构 ratchet 触发的辅助函数迁移**（2026-10-06 集成验证批次）：
   `bootstrap/src/subagents.ts` 因 R5/R9 追加超过 400 行 legacy ratchet 上限，
   把 `CORE_RESERVED_AGENT_NAMES` / `createReservedAgentNames` /
   `resolveBundledProfileModelSelection` 迁入 `app/bundled-agents.ts`（目录
   相关判据与包内容单一事实源同住），消费方（create-app、catalog 测试）改
   import 路径；文件 409 → 380 行，`architecture:check --changed` 回到
   new: 0 且 ratchet 计数净减 1（493 → 492）。
8. **同源化 TODO 定案：services 自持解析，不复用 bootstrap loader**（收口
   第 4 条遗留）：R7 本就规定 GUI 用 `subagentMarkdown.ts` 宽松解析（与 CLI
   严格解析对齐是既有产品语义），且 desktop/services 不依赖 `@acode/bootstrap`
   （依赖方向不允许）；`resolveBundledAgentsRoot()` 复用 services 既有
   `findACodeAgentRuntimeNodeBundle()` 定位链即为定案形态，第 4 条 TODO 关闭。
9. **场景 8 等价覆盖登记**：skills 门关闭时 Review/Verify 的降级无直接用例，
   以两项等价证据覆盖——①profile 加载不经技能门（`bundled-agent-content`
   测试断言 skills 字段照常解析、装配在场）；②派发期技能注入降级是既有
   runtime 行为，本批 git diff 未触及任何技能 runtime 文件（26 文件清单核实）。
10. **分发形态验证边界（如实登记）**：dev 形态端到端绿（loader 测试用真实包）；
    SEA 形态经 dry-run 实证（manifest 含 `agents/{Plan,Review,Verify}.md` +
    一致性测试 5/5 钉住三处清单同集合）；远端 stage 形态为静态核对
    （`topLevelPaths`/`requiredPaths` 已含 agents，未端到端实跑完整远端打包）；
    desktop staged bundle 待下次 `prepare:agent-bundle` 自然刷新，刷新前 GUI
    按候选链回退仓库源目录（第 4 条已记）。
11. **真实派发 E2E 实测（2026-10-06 集成批次，dev 形态 + 真实模型）**：
    - 前置事实：dev 形态下 workspace 依赖解析到各包 **dist**（tsx 只转译 cli
      src），本批之前的 dist 为陈旧构建，首次 Plan 派发报 UNKNOWN_AGENT_TYPE
      （意外成为旧目录二成员的负对照）；`tsc -b packages/core packages/bootstrap`
      重建后三成员派发全部命中。dev 联调与发布流程中 dist 重建是目录生效前置。
    - **Plan** ✅：派发命中、调研范围约束遵守、`### Critical Files for
      Implementation` 尾部契约逐字保留（报告主体为中文时标题仍保持英文原样）、
      方案引用的文件/行号/ratchet 约束全部真实。
    - **Verify** ✅：profile `background: true` 生效（自动转后台）；子代理真实
      执行测试套件（18/18，exit 0，复跑两次）与 git status（26 路径，与集成者
      独立统计一致）；零仓库文件修改且主动披露 /tmp 临时输出；`### Check
      Results` 尾部契约、SKIPPED 带原因、未验证面如实声明的诚实纪律全部生效。
    - **Review** ✅：plan 地板下只读 Bash（git diff）真实运行时放行（R4 实测
      闭环，与第 6 条代码级证据互证）；findings 带 file:line 与规则依据、
      `### Verdict` 尾部契约生效；**首跑即产出两个真实 P2**——迁移键集加宽
      无回归测试、静态名单与包目录间无耦合断言且 subagents-types 注释派生
      范围失实——均已同批修复（`packages/shared/test/subagent-state-migration.test.ts`
      两用例 + catalog 测试同集合断言 + 注释订正），Review 的目录价值即刻自证。
    - **存量语义缺口登记（不在本项修复）**：`runner.ts:147-148` 的 background
      判定为 `runInBackground === true || profile.background === true`，调用级
      显式 false **压不过** profile 默认；且 `-p` 一次性模式父进程在最终消息后
      退出，后台子代理随进程消亡、结果丢失（metadata 滞留 running、无 output）。
      交互式会话（TUI/desktop）不受影响（完成通知正常送达，Verify 实测经通知
      与输出文件双通道一致）。一次性模式 × background 默认开的组合属派发运行时
      语义，归 runner/dispatch spec 领域，登记为后续批次候选；集成期测试可用
      「派发后驻留轮询 outputFile」规避（本批实测采用）。
      **（2026-10-06 更新：已修复）**——见 `specs/subagent-background-tristate.md`
      与同日实施批次：`run_in_background` 三态语义（显式 false 强制前台，deny
      死循环解除）+ `-p` 装配期声明 foreground 策略（port 层单点重写，含
      autoBackgroundMs 压制）；场景 6 真实模型 E2E 复测通过（Verify 前台同步
      完成、metadata 终态、报告完整转述）。

## 修订记录

（首版，2026-10-06。）

1. **2026-10-06，oh-my-pi 对照批次**：新增「对照分析记录」节；R2 判据 1 补领域
   评审 agent 拒绝理由；R3 第 5 条改为 findings 方法学归 code-review 技能、prompt
   只约束产出形态；R4 新增 `(read-only)` 描述标注（判据 = permissionMode 地板，
   非工具面推断），接口与验收场景 2 同步；「不在本项范围」新增模型角色别名、
   Agent Hub roster、advisor/watchdog、prewalk/speculative launch、领域评审 agent
   五项。无第三方原文进入本 spec（R3 第 1 条合规不变）。
2. **2026-10-06，zoode 还原件对照批次**：新增「对照分析记录（zoode 还原件）」节；
   R3 description 规则改为三要素（定位 / 触发 / 负边界句），上限 300 → 350 字符；
   R3 新增第 6 条强制尾部输出契约（Plan 关键文件 / Verify 检查结果 / Review 判决）
   与第 7 条 Plan perspective 输入契约（零新调度机制）；「不在本项范围」的模型档位
   bullet 扩为别名 + inherit+cap 两形态，新增存量 description 合规处置 bullet
   （血缘实锤登记，处置归独立批次与产品决策）；验收场景 9 同步。
   无第三方原文进入本 spec（R3 第 1 条合规不变）。
3. **2026-10-06，存量 description 处置方向拍板**：产品决策定为**自撰重写**
   （不维持原文兼容），新增 R9（兼容面 = 名字与行为而非 prose；补负边界句、
   不补第三档广度；core + services 两处同步替换；合规断言走快照 + 人工审查，
   禁止第三方原文进测试代码）。zoode 对照记录「血缘确认」bullet 收口指向 R9，
   「不在本项范围」的存量处置 bullet 移除（已进范围），R6 补文本替换例外，
   接口节与验收场景（新增第 10 项、验证命令重编号为 11）同步。
