# 子代理声明式 frontmatter 键全集（第二批：代理侧）

价值提取第二轮 T1-c4② 的代理侧落地：把子代理 markdown frontmatter 的声明面补齐到
「派发运行时可消费或显式登记」的状态——新增 `isolation: worktree`（声明式每代理临时
worktree）、observer 三键（声明式背景观察者）、`initialPrompt`、代理级 `hooks` 声明；
既有键（model/inherit、tools/disallowedTools、permissionMode、skills、memory、
background、mcpServers）核对现状并钉住语义；`maxTurns` 按既有产品裁决**拒绝再引入**。
技能侧键（allowed-tools 实参级、paths 触发、双向门）归 SKILL-A 批次，不在本 spec。

机制思想来自对第三方产品还原件的**结构性分析**（仅本地、只读；证据位置见「对照分析
记录」）；全部文本自撰英文（`prompt-language-policy.md` R1/R7），任何第三方原文、
厂商代号不进仓库。

## 背景

### 已核实的现状（基线：当前检出，行号实施前需复核）

| 事实 | 位置 |
| --- | --- |
| frontmatter 宽松解析（标量/列表/内联 JSON；块状 mapping 仅 mcpServers 有专门拒绝面） | `core/src/subagent/profile-frontmatter.ts`（`parseAgentFrontmatter` / `parseLooseFrontmatter`） |
| 已支持键：name/description/model(+thoughtLevel)/color/permissionMode/memory/tools/disallowedTools/skills/background/injectAgentsMd/mcpServers | `core/src/subagent/profile.ts`（`parseAgentProfileFromMarkdown`） |
| `model: inherit`（及 main/sonnet/opus/haiku 别名）→ `modelSelection` 缺席 → 继承父模型（override > profile > 父继承） | `packages/shared/src/subagent-markdown-selection.ts:8,16`（INHERIT_NAMES）、`resolveSubagentSelection`（runtime 侧） |
| tools 缺席 = child 继承父工具面；tools 在场 = **替换式**白名单；disallowedTools 在 tools 在场时**仍然生效**（强制剔除集之后叠加） | `core/src/subagent/runner.ts`（`resolveAllowedTools`）、`core/src/subagent/tool-policy.ts` |
| Verify 预置依赖 tools 白名单 + disallowedTools **双写**防白名单解析回退（刻意防御，不是冗余） | `specs/builtin-subagent-catalog.md` R2 表 + 实现决定回写第 1 条 |
| permissionMode 仅 `auto\|plan`；project 源 markdown 的 permissionMode 被剥离（仓库输入不得提权）；child 侧「只能更严不能更松」 | `profile.ts:207-210`、`runtime/methods/subagent.ts:475-487`、`specs/subagent-policy-floor-inheritance.md` |
| maxTurns 已全链删除且**禁止裸加回**（再引入必须先修订其 spec，到顶终态必须可区分截断态） | `specs/subagent-maxturns-policy.md` R1/R2/R5 |
| skills 预载已消费：child Skill 工具面按 profile.skills 解析（含官方技能唯一匹配回退） | `runtime/methods/subagent.ts:277,1059-1069` |
| memory user/project/local 已消费：三作用域根路径 + 持久记忆提示注入 + Write/Edit 工具补面 | `core/src/subagent/persistent-memory.ts`（`resolvePersistentAgentMemoryRoot`） |
| background 三态（undefined=跟随 profile / true=强制后台 / false=强制前台）+ `-p` 前台策略 port 层单点 | `specs/subagent-background-tristate.md` R1/R3、`core/src/subagent/foreground-policy.ts` |
| mcpServers 已消费：child **借用**父连接并按名单收窄（连接期作用域；child 不拥有 MCP 生命周期） | `core/src/subagent/borrowed-mcp-port.ts`、`runtime/methods/subagent.ts:779-835` |
| 会话 worktree 机制齐备：enter（闭集拒绝面）/ ledger（bind/touch/tombstone，tombstone reason 闭集 reaped/worktree-missing/released）/ fence（进程内注册表按路径键控）/ reap（保护序：在绑→最近使用→dirty 材料优先） | `core/src/worktree/session-worktree-{enter,ledger,fence,reap,manager,git,paths}.ts`、`specs/session-worktree-lifecycle.md` R2/R3/R4/R6 |
| worktree enter 以 sessionId 为绑定键；child 会话 id 由 runner 铸造（`subagent_<agentId>`），resume 复用同一 childSessionId | `runner.ts`（`createSubagentLifecycle` / `createSubagentLifecycleFromTask`） |
| 背景代理机制 = registry + runBackgroundAgent + 完成通知 + SendMessage 恢复；消息投递单一实现（有 sink 即 steer，否则 queued 待 turn 起点 drain） | `runner.ts`、`core/src/subagent/message-delivery.ts`、`specs/subagent-pending-message-drain.md` R1 |
| 嵌套派发结构性关闭（child 工具面剔除派发工具；有效 maxDepth fail-closed 硬封 1）——「观察者可继承给子代理」当前无消费面 | `core/src/subagent/tool-policy.ts:14-26`、`specs/subagent-nesting-budget.md` R3 |
| 子代理环境段（cwd/git/platform/scratch）由 registry 调 `buildSubagentEnvironmentContext` 渲染；主会话对应段在 `context/sections/env-info.ts`（另有所有权） | `core/src/subagent/system-prompt.ts`、`core/src/context/registry-subagent.ts:78-100` |
| runner.ts 在架构基线 legacy ratchet 内（超限文件）；profile.ts 365 行接近 400 上限 | `.architecture-baseline.json`、`wc -l` |

### 对照分析记录（zoode 还原件 / 第三方产品，2026-10-16 复核）

对照来源是 zoode 工作区第三方产品还原件的 agent frontmatter zod schema（本地只读
静态分析；证据位置：还原件 beautified chunk `chunk-9h4eq2mz.js:21920-21975`，键集与
describe 语义已逐键复核）。**任何第三方原文不进仓库、不进本 spec**；键语义 = 接口
设计事实，文案一律自撰。逐项吸收/拒绝结论：

- **吸收**：`isolation: worktree` 声明式隔离（复用既有会话 worktree 机制，R2）；
  observer 三键（声明式背景观察者，R3——孵化最小闭环 + settle digest，中间态周期
  digest 登记为接线项）；`initialPrompt`（作主会话时自动首发——ACode 当前无
  `--agent` 类主会话代理入口，落声明 + 解析接口，R4）；代理级 `hooks` 声明
  （运行期注册的作用域事实先落声明面，消费面在 hooks 模块所有权内，R5）。
- **确认已在（不重复造）**：model inherit 别名语义（shared INHERIT_NAMES 已含
  inherit/main/…，行为同构）；tools 替换式；skills 预载；memory 三作用域；
  background 默认；mcpServers（ACode 为借用收窄模型，见「刻意差异」）。
- **刻意差异（记录理由，不跟进）**：
  1. `disallowedTools` 在 tools 在场时**不忽略**——对方语义是「ignored if tools is
     set」；ACode 的双写是 Verify 只读保证的防御面（catalog spec R2），叠加过滤
     方向更严、fail-safe，维持现状。
  2. mcpServers 是**连接期借用父连接 + 名单收窄**，不是「代理运行时新建连接」——
     child 不拥有 MCP 生命周期是既有裁决（borrowed-mcp-port 头注释），不跟进
     per-agent 连接。
  3. `omitClaudeMd` 的 ACode 等价物是既有 `injectAgentsMd`（正向布尔），不新增
     第二键。
- **拒绝**：`maxTurns`——本仓已有相反的产品裁决（`subagent-maxturns-policy.md`
  R1「主/子代理循环不设轮数硬停止」、R5「再引入必须先修订该 spec 且到顶终态必须
  可区分」）。本 spec 不触发该修订路径；残留键与未知键同等待遇（该 spec R3）。
  `effort` / `experimental.cacheTtl`——模型档位别名与缓存 TTL 属模型选择/供应商面
  （catalog spec「不在本项范围」同款裁决），不进本批。

## 产品规则

### R1 声明面键集与解析纪律

- `AgentProfile` 新增四个声明位（全部可选，缺省 = 现状行为零变化）：
  - `isolation?: "worktree"`（闭集单值；R2）；
  - `observer?: SubagentObserverDeclaration`（三键归并为一个内聚声明对象：
    `{ agentType, message?, observeSubagents? }`；R3）；
  - `initialPrompt?: string`（R4）；
  - `hooks?: AgentHooksDeclaration`（原始声明记录，R5）。
- 解析在新模块 `core/src/subagent/profile-declarative.ts`（profile.ts 已近 400 行
  ratchet 上限，新键解析不进去）；`parseAgentProfileFromMarkdown` 只加一次调用与
  字段展开，单文件诊断槽的优先级：致命拒绝（isolation 非法）> memory > hooks >
  observer 孤儿键。
- **非法 isolation 值 = 拒绝整个 profile**（diagnostic `agent_invalid_isolation`）：
  声明了隔离却静默跑在共享 cwd 是「假装隔离比不隔离更糟」（session-worktree spec
  R8 同款裁决），与 mcpServers 非法即拒的既有先例一致。
- **project 源剥离 hooks**（与 permissionMode 同款判据）：项目级 markdown 属于
  仓库输入，不得经 frontmatter 注册运行期 hooks（命令执行面）。isolation/observer/
  initialPrompt 对 project 源不剥离（isolation 只会更隔离；observer 派发的类型仍
  受注册 profile 集约束；initialPrompt 在子代理派发中本就不读）。
- observer 孤儿键（observerMessage/observeSubagents 在场而 observer 缺席或空白）：
  键丢弃 + diagnostic `agent_observer_declaration_incomplete`（profile 照常加载——
  孤儿键无副作用，诊断只为提示拼写错误）。
- hooks 只接受**内联 JSON 对象**形态（宽松解析器的 `{...}` → JSON.parse 既有通道）；
  非对象/数组/解析失败 → 键丢弃 + diagnostic `agent_invalid_hooks`（fail-closed：
  畸形声明绝不注册）。块状 YAML mapping 不在宽松解析器能力内，不假装支持。

### R2 isolation: worktree —— 声明式每代理临时 worktree

复用会话 worktree 机制（`core/src/worktree/`，session-worktree-lifecycle spec 的
唯一所有者；本 spec 只**消费**其导出面，零改动其文件）：

- **enter 时机与键**：`runAgentToCompletion`（前台 run / 后台 start / resume 三路
  的单一执行原语）在**树预算准入与寻址登记之前**、child 启动之前调
  `enterSessionWorktree({ repoDir: request.workingDirectory, sessionId: childSessionId,
  branchName: "subagent-<agentType>-<agentId>" })`。顺序裁决：enter 拒绝时尚无
  预算认领/寻址登记——`emitSubagentEvent` 的 settle 单点保持唯一释放面
  （`subagent-tree-budget` 测试钉住的接线不变量不被早失败补偿破坏）；enter 成功
  而预算溢出时，隔离回收走 child 调用的 `finally` 同点。绑定键 = childSessionId：
  resume 复用同一 id → ledger 命中既有绑定，走 reuse/reattach（分支 tip 材料不丢）。
- **child cwd = worktree 路径**：`runExploreAgent` 请求的 `workingDirectory` 换成
  worktree 路径；`workspaceRoot` 保持父的不可变根（身份锚不动，
  `subagent-parent-inheritance.md` R1）。围栏（fence）按 childSessionId 绑定、按
  路径命中——child 的工具写入自动收敛进 worktree（R4 围栏语义零改动继承）。
- **fail-loud**：enter 的闭集拒绝面（not_git_repo / unborn_head /
  inside_linked_worktree / already_in_session_worktree / branch_in_use）→ 派发以
  CoreError 拒绝（recoverable: true），child **绝不**静默降级回共享 cwd。错误
  context：`code: SUBAGENT_UNAVAILABLE`、`reason: subagent_unavailable`（既有全局
  token；专用 token 属 contracts reasons.ts 所有权，登记为接线项）+
  `isolationReason`（enter 拒绝面的局部闭集，tree-budget 的 budgetReason 同款
  「全局 token + 局部维度键」先例）。
  **已知边界**：父会话自己已在受管 worktree 内时，child 的 enter 命中
  inside_linked_worktree 拒绝——嵌套隔离不支持（会话域 enter 的既有裁决「隔离只从
  主 checkout 开始」），登记不放宽。
- **metadata 诚实**：enter 成功后 best-effort 重写 metadata.json（cwd 换成 worktree
  路径 + `worktreePath`/`worktreeBranch` 字段）；重写失败只 warn（child 尚未产生
  事实，启动路径的 metadata 失败语义不变）。
- **release/reap（代理结束按现有 reap 语义回收）**：child settle（成功/失败/取消
  同一路径，`finally`）后：
  1. `unbindSessionWorktreeFence({ sessionId: childSessionId })`（解除在绑保护）；
  2. dirty 检查（`gitHasUncommittedChanges`）：**clean → `removeWorktree` +
     ledger `tombstone("reaped")`**；**dirty → 保留目录与 active 绑定**（材料优先，
     与 reap 工具保护序第 3 条同款；后续由 ReapSessionWorktrees 按天数或用户处置）；
     检视失败 → 保留（不能证明 clean 就不删）；
  3. 目录已丢失 → `tombstone("worktree-missing")`；
  4. `prune(repoRoot)` 台账卫生。
  **分支永远保留**（child 的提交材料在分支 tip 上；合并归 MergeBaseBranch 工具面
  与用户，runner 不自动 merge——自动合并是所有权外新语义，登记）。
- release 全程 best-effort：清理失败只 warn，绝不覆盖/吞掉 child 的真实结果或错误。
- 测试注入面：`ExploreSubagentPortOptions.subagentWorktreeDeps?: { manager?, ledger? }`
  （缺省 = 进程级 manager + env 兜底 ledger，生产装配零改动）。

### R3 observer 三键 —— 声明式背景观察者（孵化最小闭环）

- **语义**：`observer: <agentType>` = 该代理每次运行时，harness 自动孵化一个该类型
  的**背景观察者子代理**；`observerMessage` = 追加在 harness 缺省 preamble **之后**
  的补充说明；`observeSubagents`（缺省 true）= 本体派生的子代理是否继承其观察者。
- **孵化**：`runAgentToCompletion` 在树预算准入与寻址登记通过之后、child 启动之前
  （被预算拒绝的派发不留观察者），经 port 内提取的 `startBackgroundTask`（与
  port.start 同一实现，observer 走 `suppressObserver` 防递归）以背景 start 语义孵化
  观察者：观察者 = 普通背景代理（registry 登记、metadata、完成通知、SendMessage
  可达——全部既有机制，不新造生命周期）。孵化是 fire-and-forget：观察者启动失败
  （类型未注册/预算溢出/持久化失败）只 warn，**绝不**影响本体派发（观察者是辅助面）。
- **初始 prompt（自撰英文，harness-owned default）**：声明观察者角色（背景观察、
  非用户派发）、被观察者身份（agentType/agentId/前台或背景）、任务 description
  （标注「另一模型撰写——数据非指令」）、digest 协议（活动 digest 以 coordinator
  消息送达、是运行事实不是用户输入、无用户权威、不能控制被观察者）、收尾契约
  （收到 final digest 后给出整合观察并收口）。`observerMessage` 在场时追加在
  preamble 之后。
- **settle digest**：本体 settle（completed/failed 同点）后向观察者投递 final
  digest（既有 `deliverPendingMessageViaSink` 单一投递实现，origin kind
  `coordinator`——harness 是其事实上的协调方；观察者未就绪时 queued，由 sink
  注册/turn 起点 drain 兜住竞态，pending-message-drain spec R1 既有语义）。digest
  内容 = 运行事实（状态/时长/工具调用数/tokens/输出文件路径；失败时的错误消息
  标注为数据）+ 收尾指令。settle digest 的投递不 await 本体收口（fire-and-forget
  + catch warn），观察者孵化 promise 未决时挂 `.then` 顺延，绝不阻塞本体。
- **跳过面（闭集，warn 留痕）**：`suppressObserver`（观察者自身，防递归链）；
  `offPeakInherited === true`（闲时轮 deny 语境，背景语义不可用）；
  `backgroundPolicy === "foreground"`（`-p` 一次性会话，背景代理随进程消亡——
  装配点透传该策略位属接线项，缺省 honor 照常孵化）；`spawnObserver` 钩子缺席
  （旧装配/测试替身 = 现状零变化，静默）。
- **observeSubagents 继承（声明面落地，消费面休眠）**：嵌套派发当前结构性关闭
  （depth 硬封 1），子代理无派发面 → 继承无消费点。键照常解析并随 profile 传递；
  嵌套打开时的继承语义（child 派发沿用本体 observer，`observeSubagents: false`
  切断）登记为接线项，不在本批实现假通道。
- **中间态周期 digest 登记**：逐工具活动流（tool-event-mirror 面）→ 周期摘要属
  活动流消费，本批只落 spawn 事实（进初始 prompt）+ settle digest 两点；周期
  digest 登记为后续批次（接线需求清单第 5 条）。

### R4 initialPrompt —— 作主会话时自动首发（声明 + 解析接口）

- 语义（对照吸收）：该代理**作为主会话运行**（`--agent` 类入口或设置面指定）时自动
  提交的首条消息；**作为子代理派发时不读**（派发 prompt 由调用方给）。
- ACode 当前无主会话代理入口（CLI 无 `--agent` flag，已核实）——本批落声明解析
  （R1）+ 纯函数解析接口 `resolveMainSessionInitialPrompt(profile): string | undefined`
  （trim 后非空才返回；子代理派发链路**零消费**），入口落地时由装配层调用。
  接线需求清单第 2 条。

### R5 代理级 hooks —— 声明面落地，注册面归 hooks 所有权

- `hooks: <内联 JSON 对象>`（形状同 settings.json hooks 声明）解析为原始记录挂
  `AgentProfile.hooks`；profile 已整体随 `ExploreSubagentRuntimeRequest.profile`
  过 child 边界（既有通道，零新增请求字段），运行期注册（连接期/运行期作用域、
  注销时机）在 `core/src/hooks` 所有权内——本批**不接注册面**，接线需求清单第 1 条。
- 安全纪律：project 源剥离（R1）；畸形声明丢弃 + 诊断（R1）；未接注册面前该键
  是惰性数据（与 maxTurns 删除裁决的「悬空配置」区别：本键有明确的消费方所有权
  与接线计划，且不经用户设置面往返——GUI 往返键集属 services 所有权，接线需求
  清单第 3 条）。

### R6 filesystem 语义映射（子代理环境段增量）

对照对方系统提示的 filesystem 语义段（Self-Modification / Memory / outputs /
uploads / connected folders 的「真实路径语义」变体，证据行号见需求源 T2-p7②；
结构性对照，文本自撰），ACode 子代理侧的现状与增量：

- **已在（不重复造）**：working directory / git / platform / scratch 目录事实行
  （`buildSubagentEnvironmentContext` 的 `<env>` 块）；持久记忆根路径与写纪律
  （persistent-memory-prompt 的 `<MEMORY_ROOT>` 段，memory 声明在场时渲染）；
  「禁写报告 .md、最终回复即报告」（common notes）。
- **增量（本批，子代理变体）**：`buildSubagentEnvironmentContext` 在 `</env>` 之后
  追加自撰 filesystem 语义段——①working directory 是用户电脑上的真实文件夹：
  读写直达磁盘、无备份副本、删除不可撤销；②outputs 语义：最终回复就是报告，
  harness 负责把它记进任务输出文件，代理不自建报告文件（与 common notes 的禁令
  同向，不新设规则）；③Self-Modification 语义：产品配置（用户 ACode 目录与
  workspace `.acode` 下的 agents/skills/memory/settings）都是真实文件，改写它们
  即改写未来会话的行为——仅在任务明确要求时触碰。
- **无对应物（登记不造）**：uploads / connected folders——ACode CLI 无独立上传区
  或多文件夹连接面，不虚构路径语义。
- **主会话变体（接线项）**：`context/sections/env-info.ts`（另有所有权）的同款
  增量登记为接线需求清单第 7 条；本批只落子代理变体。
- 渲染纪律：段是静态语义文本（对子代理恒真），不依赖新事实入参——registry 调用
  点（registry-subagent.ts）零改动；`subagent_environment` 段 persistable false，
  不进 prompt-manifest hash 面（已核实 manifest 仅收 subagent_notes）。

### R7 三层信任词表的发送方分级（与 error-taxonomy spec 联动）

本批同波细化 hand-back / teams 两处包装声明的发送方分级措辞（tier 2 同会话
subagent-or-teammate、tier 1 verified project teammate）；规则与共同底线归
`specs/error-taxonomy-injection-defense.md` R9（单一事实源），本 spec 不重复文案，
只登记：observer digest（R3）与初始 prompt 中的 description 标注遵循同一分层
（harness 事实行 vs 模型产出数据标注）。

### R8 既有键语义钉住（防漂移，不改行为)

- model：`inherit`（及 main/sonnet/opus/haiku 别名）→ modelSelection 缺席 →
  父模型继承；显式 provider/model → profile 选择；GUI/装配 override 优先级不变
  （override > profile > 父继承）。
- tools：缺席 = 继承父工具面；在场 = 替换式白名单（经强制剔除集与
  disallowedTools 叠加过滤，R1 刻意差异 1）。
- permissionMode / memory / background / skills / mcpServers：现状语义不动，
  测试钉住（验收场景 1）。

## 状态所有者

```
agent markdown frontmatter（user/project/bundled/plugin）
   │
   ├─► core/src/subagent/profile-frontmatter.ts   宽松解析（不改）
   │      └─► core/src/subagent/profile-declarative.ts（新）
   │             新键解析/校验/诊断闭集 + resolveMainSessionInitialPrompt
   │             └─► core/src/subagent/profile.ts  AgentProfile 四新声明位（字段展开）
   │
   ├─► core/src/subagent/subagent-worktree.ts（新）  isolation enter/release 编排
   │      └─ 消费 core/src/worktree/*（enter/fence/ledger/manager/git 导出面，零改动）
   │
   ├─► core/src/subagent/observer.ts（新）  观察者声明解析/prompt 与 digest 构造/孵化计划
   │
   └─► core/src/subagent/runner.ts   单一执行原语接线（runAgentToCompletion）：
          isolation enter → 观察者孵化 → child（cwd=worktree）→ settle digest → release
          startBackgroundTask 提取（port.start 与观察者孵化同一实现）

specs/session-worktree-lifecycle.md  worktree 域规则唯一所有权（本 spec 只消费）
specs/subagent-maxturns-policy.md    maxTurns 拒绝裁决唯一所有权（本 spec 引用不推翻）
specs/error-taxonomy-injection-defense.md R9  三级信任词表唯一文案规则源
```

- ledger/fence 台账与注册表的所有权、事件闭集、保护序：session-worktree spec 不变；
  子代理隔离只是它的又一个 (sessionId, repoFingerprint) 绑定方。
- 观察者生命周期所有权 = 既有背景代理机制（registry/notification/SendMessage），
  observer.ts 只做声明解析与文本构造，不新造任务形态。

## 接口

- `core/src/subagent/profile.ts`：`AgentProfile` 新增 `isolation?` / `observer?` /
  `initialPrompt?` / `hooks?`；`AgentIsolationMode`、`SubagentObserverDeclaration`、
  `AgentHooksDeclaration` 类型自 profile-declarative.ts 再导出（消费方 import 面
  不变）。`parseAgentProfileFromMarkdown` 签名与返回形状不变（新增 diagnostic code
  走既有 `AgentProfileParseDiagnostic` 通道）。
- `core/src/subagent/profile-declarative.ts`（新）：
  `parseDeclarativeAgentKeys(values, input: { path?, source }): { keys, denial?, warning? }`、
  `resolveMainSessionInitialPrompt(profile): string | undefined`。
- `core/src/subagent/subagent-worktree.ts`（新）：
  `enterSubagentWorktreeIsolation(input: { agentId, agentType, childSessionId, repoDir, deps? }):
  Promise<SubagentWorktreeIsolation>`（拒绝抛 CoreError，context 携带 isolationReason
  局部闭集）、`releaseSubagentWorktreeIsolation(isolation, input: { agentId, agentType,
  logger? }): Promise<SubagentWorktreeReleaseOutcome>`（outcome 闭集：reaped /
  dirty_kept / tombstoned_missing / remove_failed_kept / release_failed_kept，
  日志 detail 键避开保留闭集键 status）、`buildSubagentWorktreeIsolationNote(branch,
  worktreePath)`（隔离 child 的 system prompt 追加段，自撰英文）。
- `core/src/subagent/observer.ts`（新）：`resolveObserverSpawnPlan(profile, facts):
  { declaration } | { skip: reason }`（skip 闭集：undeclared / suppressed /
  off_peak_inherited / foreground_policy / no_spawn_hook）、`shouldWarnObserverSkip(plan)`、
  `createObserverRunAttachment(input): { planned, start(), settle(outcome) }`（runner
  单一执行原语的接线点：plan 创建期解析、start 孵化、settle 投 digest，全程
  fire-and-forget）、`createObserverSpawnHook(deps): SpawnObserverAgent`、
  `buildObserverStartRequest(input)`、`buildObserverInitialPrompt(input)`、
  `buildObserverSettleDigest(input)`、`deliverObserverSettleDigest(registry,
  observerAgentId, input, logger?)`。
- `core/src/subagent/runner.ts`：`ExploreSubagentPortOptions` 新增可选
  `subagentWorktreeDeps?` 与 `backgroundPolicy?: "honor" | "foreground"`（缺省
  honor，装配点透传属接线项）；`SubagentExecutionOptions`（内部）新增
  `spawnObserver?` / `suppressObserver?`；`startBackgroundTask` 闭包函数提取
  （port.start 行为逐字节不变）。`ExploreSubagentRuntimeRequest` 零新增字段
  （profile 整体已过边界，R5）。
- `core/src/subagent/handback-trust.ts` / `agent-teams-plugin/src/trust-wrapper.ts`：
  声明文案细化（导出常量与函数签名不变；包装/解包不变量与空文本语义不变）。
- `core/src/subagent/system-prompt.ts`：`buildSubagentEnvironmentContext` 输出追加
  filesystem 语义段（签名不变）。

## 验收场景（测试映射 tests/subagent-declarative-keys / subagent-worktree-isolation /
## subagent-observer / trust-tier-vocabulary 四文件 + 插件 trust-wrapper.test.ts）

1. **既有键钉住（R8）**：`model: inherit` → modelSelection 缺席；显式 model →
   selection 在场；tools 在场为替换式且 disallowedTools 叠加生效（双写防御保持）；
   `maxTurns: 5` 残留键 → 不产 diagnostic、不上 profile（maxturns spec R3 同款）。
2. **新键解析（R1）**：isolation worktree 合法值上 profile；非法值（如
   `isolation: container`）→ 整 profile 拒绝 + `agent_invalid_isolation`；observer
   三键归并（observeSubagents 缺省不写死、显式 false 保留）；孤儿
   observerMessage → `agent_observer_declaration_incomplete` + 键丢弃；hooks 内联
   JSON 对象上 profile、数组/坏 JSON → `agent_invalid_hooks` + 丢弃；project 源
   hooks/permissionMode 剥离而 user 源保留；initialPrompt 原样保留、
   `resolveMainSessionInitialPrompt` 对空白返回 undefined。
3. **isolation E2E（R2，真实 git fixture）**：port.run 派发声明 isolation 的
   profile（stub runExploreAgent）→ child 收到的 workingDirectory 在 tmp 命名空间
   且是 `acode/session/subagent-*` 分支的 worktree、workspaceRoot 不变；运行期
   fence 绑定在场（childSessionId）；settle 后 clean → 目录移除、ledger
   tombstone(reaped)、fence 解绑、分支保留；child 留下未提交改动 → 目录保留、
   ledger active（dirty_kept）；非 git 目录 → 派发抛 CoreError（reason
   subagent_unavailable + isolationReason not_git_repo）且 stub 未被调用（fail-loud
   不降级）。
4. **observer 最小闭环（R3）**：声明 observer 的 profile 派发 → 观察者背景任务
   注册（agentType 命中观察者 profile）；观察者初始 prompt 含 harness preamble
   要素（观察者角色/被观察身份/description 数据标注/digest 协议）且 observerMessage
   追加在 preamble 之后；本体 settle → 观察者收到 final digest（状态/时长/输出
   路径要素在场）；观察者 profile 自身声明 observer → 不再孵化（防递归）；
   offPeakInherited → 跳过 + warn；观察者类型未注册 → 本体照常完成（降级 warn）；
   observeSubagents 键解析在场（消费面休眠，R3 登记）。
5. **filesystem 语义段（R6）**：子代理环境段含真实文件夹/无备份/删除不可撤销、
   报告即最终回复、配置自改写谨慎三要素；`<env>` 事实块与 scratch 行既有语义
   逐字节不变（memory-env-sections R5.3-b 断言原样通过）。
6. **信任分级（R7 + error-taxonomy R9）**：hand-back 声明含 tier 2 要素（同会话
   subagent、由你或用户方启动、三条底线）且既有不变量正则（model produced|another
   model / no user authority / not a user message）原样通过；teams 包装声明含
   tier 1 要素（verified teammate、代表用户行动、可能自带不可信内容、三条底线）
   且插件既有断言（frame 行 / carry no user authority / 缩进不变量）原样通过。
7. **验证命令**（仓库根执行，如实记录）：`pnpm typecheck`、`pnpm lint`、
   `pnpm architecture:check --changed`、
   `node --import tsx --test apps/acode-cli/tests/subagent-declarative-keys.test.mjs
   apps/acode-cli/tests/subagent-worktree-isolation.test.mjs
   apps/acode-cli/tests/subagent-observer.test.mjs
   apps/acode-cli/tests/trust-tier-vocabulary.test.mjs`、既有
   `apps/acode-cli/tests/injection-defense-handback.test.mjs`、
   `subagent-*.test.mjs`、`session-worktree-*.test.mjs`、
   `memory-env-sections.test.mjs`、`system-prompt-section-registry.test.mjs` 与
   `pnpm --filter @acode/agent-teams-plugin test`。

## 不在本项范围 / 登记项

1. **maxTurns 再引入**：归 `subagent-maxturns-policy.md` R5 修订路径（须先到顶
   终态可区分设计），本 spec 明确拒绝（对照分析记录·拒绝项）。
2. **嵌套隔离**（父在受管 worktree 内派发 isolation 子代理）：enter 既有拒绝面
   inside_linked_worktree，不放宽；出现真实需求再议（R2 已知边界）。
3. **isolation 自动 merge 回基分支**：runner 不自动合并（MergeBaseBranch 工具面 +
   用户裁决）；「代理结束自动 merge」是新产品语义，另立 spec。
4. **观察者周期 digest（中间态活动流）**：tool-event-mirror 面的活动摘要投递，
   后续批次（接线需求第 5 条）。
5. **observeSubagents 继承消费面**：嵌套派发打开后生效（接线需求第 6 条）。
6. **effort / experimental.cacheTtl / 模型角色别名**：模型选择面，catalog spec
   「不在本项范围」同款裁决。
7. **技能侧声明键**（allowed-tools 实参级 / paths / 双向门 / context / agent 绑定）：
   SKILL-A 批次所有权（adapters/src/skills）。

## 接线需求（随实现报告移交，本批零触碰对应文件）

1. `runtime/methods/subagent.ts`（child runtime 构造，hooks 所有权联动）：消费
   `request.profile.hooks`——child 运行期注册/注销（作用域 = 该 child 生命周期），
   事件形状按 settings.json hooks 同款；注册面在 `core/src/hooks`（MODS 批次）。
2. 主会话代理入口（cli/bootstrap）：`--agent` 类入口或设置面「以某代理为主会话」
   落地时调 `resolveMainSessionInitialPrompt(profile)` 自动首发。
3. `packages/shared/src/subagents-types.ts` + `packages/services/src/subagents/
   subagentMarkdown.ts`：GUI 表单与 markdown 往返键集补新四键（当前 GUI 保存会丢
   未知键）；isolation/observer 的 GUI 呈现另议。
4. `runtime/methods/subagent.ts` 的 `createDefaultSubagentPort` 构造点：透传
   `backgroundPolicy`（已有局部变量 foregroundPolicy，一行），使 `-p` 一次性会话
   跳过观察者孵化（缺省 honor 不影响交互式会话）。
5. 观察者周期 digest：tool-event-mirror 活动流 → 摘要投递（另立批次）。
6. observeSubagents：嵌套派发深度打开时，child 派发沿用本体 observer 声明
   （`observeSubagents: false` 切断继承）。
7. `context/sections/env-info.ts`（主会话变体）：R6 同款 filesystem 语义段增量
   （另有所有权；子代理变体本批已落）。
8. `contracts/src/errors/reasons.ts`：为 isolation 拒绝增设专用全局 token
   （如 `worktree_isolation_unavailable`）后，替换 R2 的 subagent_unavailable 复用
   （当前 context.isolationReason 已可聚合区分）。

## 修订记录

（首版，2026-10-16。）
