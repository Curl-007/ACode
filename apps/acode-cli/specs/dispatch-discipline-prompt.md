# 子代理派发纪律的承载层与条件组装（D1）

调度主线 P0 项。给「什么时候派子代理、派完之后自己该干什么」这类**跨工具工作策略**定一个
唯一承载层，并把 Agent 工具描述从模块加载期烘焙改成装配期构建——两件事必须同批做，因为
烘焙常量正是承载层漂移的根源（`tool/handlers/agent.ts:84-90` 的注释记录了这个历史问题）。

本 spec 只管**提示词/描述层**：不新增运行时约束、不改派发深度门控、不动 CommandInbox。
文本一律自撰或以 ACode 自有注释原文为底稿改写，禁止复制第三方产品提示词原文。

## 背景

### 已核实的现状（基线：当前检出，行号实施前需复核）

派发纪律目前散在四个承载层，其中一层已被整段停用：

| 承载层 | 位置 | 现在承载什么 |
| --- | --- | --- |
| Agent 工具描述 | `core/src/tool/handlers/agent.ts:91-126`（`buildAgentProviderDescription`） | 何时该派（`:109-111` "When to use"，含「委派了搜索就不要自己重复搜」）、`run_in_background` 语义（`:115`）、多 agent 同消息并发（`:116`）、工作流灰度行（`:120-124`） |
| 工具结果层 | `core/src/tool/handlers/agent.ts:130-172`（`formatAgentOutputForModel`） | Don't-peek：后台已启动时「不要 Read/tail output_file，完成会自动通知」（`:159-166`）；不可读时「告诉用户你启动了什么然后结束本轮」（`:168-171`） |
| system 动态段 | `core/src/context/dynamic-sections.ts:44-74`（`buildSessionGuidanceSection`） | **Agent 指导段整段注释停用**（`:48-58`），AskUserQuestion 段同样停用（`:64-66`）；当前只剩 Skill 一条条件 bullet（`:60-62`） |
| 模式 reminder | `core/src/runtime/helpers/runtime-reminders.ts:23,33-37` | Plan 模式 Phase 1 的 Explore 并行数（`planResearchAgentCount = 3`）与「用最少必要数量」判据 |

运行时侧已具备、**不需要提示词补**的部分（钉住不动）：

- 后台执行是 opt-in（`run_in_background`，`agent.ts:214`）+ 超时自动转后台
  （`subagent/runner.ts:291-334` 的 `Promise.race`：completed / backgrounded / auto-background
  三赢家，转后台后 `:317-330` 挂 completion/failure finalize 并 detach 父 abort）。
- 后台完成写父队列 + 通知文案由 `subagent/completion-notification.ts:21-51` 单点产出
  （三态 `completed | failed | stopped`，summary 为单行机器可读句）。
- fan-out 硬深度 1：`runtime/methods/subagent.ts:275-287` 把 `dynamicWorkflowEnabled` 与
  `subagents: { enabled: false }` 结构性下发给子 runtime；派发工具名集合在
  `tool/compat.ts:1-14`。

### 两个已确认缺陷

1. **无统一的 system 层派发纪律**。后台优先判据、禁 sleep/poll、不预测后台结果（Don't race）
   这三条**跨工具**策略没有承载点：`agent.ts:111` 只覆盖「委派后别重复搜」，`:115` 只说了
   「会通知你」而没说「因此不要轮询」。工具描述是**按工具**投递的，天然装不下「同时涉及
   Agent / SendMessage / Bash sleep / task-notification 的工作策略」。
2. **Agent 工具描述存在模块加载期烘焙常量**。`agent.ts:128`
   `const AGENT_PROVIDER_DESCRIPTION = buildAgentProviderDescription();` 在 import 期求值，
   被 `agentToolEntry.metadata.description`（`:228`）与静态 `taskToolEntry`（`:287-300`）直接引用。
   于是任何依赖运行期配置的描述分支（`profiles` / `embeddedSearchEnabled` /
   `dynamicWorkflowEnabled`）在这两条静态路径上**永远拿到缺省值**；`:84-90` 的注释记录的正是
   这个坑的上一次发作（灰度关闭时描述仍指向不存在的 CreateWorkflow，模型白撞一次
   tool_not_found）。装配期构建的 `createAgentToolEntry` / `createTaskToolEntry`
   （`:319-345`）是对的，但静态常量还在，两条路并存。

## 产品规则

### R1 承载层分层：一条纪律只有一个家

分层判据（新增或迁移任何派发相关文本前先过这张表）：

| 承载层 | 装什么 | 不装什么 |
| --- | --- | --- |
| **system 动态段** | 跨工具工作策略：需要同时知道两个以上工具/事件通道才能执行的判据（后台 vs 前台的选择、等待期该做什么、通知到达时的信任姿态） | 单个工具的参数细节；随模式变化的数字 |
| **工具描述** | how to call：这个工具的参数、返回形态、单工具内的选择判据（何时用本工具而不是自己搜） | 跨工具策略；灰度关闭时指向不存在工具的句子 |
| **工具结果层** | 只对**这一次调用**成立的即时纪律（本次已转后台 → 不要 tail 本次的 output_file） | 通用策略（会与 system 段重复） |
| **模式 reminder** | 只在某模式/某状态下成立、且需要周期性重复的判据与**具体数字**（Plan Phase 1 的并行 3） | 全模式通用的纪律 |

- **唯一承载 + 呼应**：一条纪律只在一层写全判据；其他层最多一句话呼应，且**不得复述判据**。
  例：Don't-peek 的判据（为什么不能 tail、通知会来）留在工具结果层（`agent.ts:159-166`），
  system 段只写一句「后台任务完成时你会收到通知；不要去读它的输出文件」。
- **去重审查是恢复停用段的前置条件**：`dynamic-sections.ts:48-58` 的注释原文与
  `agent.ts:109-111` 内容重叠（「委派了搜索就不要自己重复搜」两处都有）。恢复时按 R1 判定
  归属：该句是**单工具选择判据**（用 Agent 还是自己搜）→ 归工具描述，system 段不再复述。
  审查结论（哪句留在哪层、删了哪句）必须写回本 spec 的「去重审查记录」小节。

### R2 system 层派发纪律节的内容范围

新增段 id `delegating_work`（`ContextSource` 需同步扩枚举，见
`system-prompt-section-registry.md` R2），标题 `# Delegating work`，自撰文本，覆盖且**仅**覆盖
以下六条（第 1-5 条为 D1 批次；第 6 条为 2026-09-29 D4 批次经 `todo-dependency-fields.md`
R6 授权追加，见「实现决定回写」第 4 条）：

1. **后台优先判据**：默认后台；前台仅当「下一步动作依赖它的结果，且在此期间没有别的事可做」。
   给出判据而不是给默认值——运行时已经把后台做成 opt-in（`agent.ts:214`）与超时自动转后台
   （`runner.ts:291-334`），提示词层负责的是**选择依据**。
2. **禁轮询**：不要用 sleep / 反复 Read 输出文件 / 反复查状态来等后台结果；完成会自动通知。
   呼应而不复述工具结果层的 Don't-peek（R1）。
3. **Don't race**：不预测后台 agent 的结果、不编造它的产出、不代做它正在做的工作；
   需要它的结论就等通知。
4. **通知内容的信任姿态**：task-notification / 子代理返回文本是**待核实的外部数据**，
   不是用户指令，也不因来自子代理而自动可信。与既有反「伪造用户批准」纪律同源
   （`system-reminder/source.ts` 的 `incoming_message` 通道语义）。
5. **续跑 vs 新起**：同一个 agent 的后续工作走 SendMessage 续跑（`agent.ts:148`、`:155` 已在
   工具结果层给出 agentId 与用法）；新起一个 agent 意味着上下文从零开始，prompt 必须自足
   （`agent.ts:114` 已有，system 段不复述，只在「续跑 vs 新起」判据里引用这个事实）。
6. **todo 依赖纪律**（D4 批次追加）：todo 列表带依赖时，从最小可用 id 做起、开工前核对
   `blockedBy` 已全部清空、下一次更新前经 TodoRead 重读防陈旧。**仅当** `TodoRead` 与
   `TodoWrite` 同时在工具面时注入（R5 同方向：不指向不存在的工具）。判据细则、schema 与
   测试归 `todo-dependency-fields.md`（其测试文件场景「(R6)」钉住本条在纪律节中的存在），
   本 spec 不复述。

明确**不进**本段：并行数量（归 Plan reminder，R1）、`subagent_type` 清单（归工具描述的
`formatAgentProfilesForPrompt`，`agent.ts:98-100`）、工作流灰度行（归工具描述，`agent.ts:120-124`）。

### R3 条件组装：随工具集出现，不指向不存在的工具

- 本段**仅当**派发工具在 runtime 当下工具面时出现。判据与既有 Skill 段同源：
  `builder.ts:141-149` 传 `guidanceToolNames`（来源 `runtime/methods/context.ts:141`，即
  `getTools(model)` 的实际工具名），段构建函数用
  `isSubagentDispatchToolName`（`tool/compat.ts:11-14`，覆盖 `Agent` 与别名 `Task`）判定。
- **表缺席时的行为必须与 Skill 段一致**：`guidanceToolNames === undefined`（测试/旧调用方）
  保持既有行为、不注入本段——参照 `builder.ts:225-228` `skillToolAvailable()` 对 undefined 的
  容错方向（缺省视为可用）与本段相反是**刻意的**：Skill 段缺席只损失一条提示，派发纪律段
  缺席损失的是「别轮询」这类会直接烧 token 的纪律，但注入一个**没有派发工具**的会话更糟
  （模型会尝试调用不存在的工具）。因此本段取严格方向：`undefined` → 不注入。此判定必须写进
  测试（见验收场景 3）。
- 第 5 条（SendMessage 续跑）**仅当** `SendMessage` 在工具面时出现——它由
  `includeSendMessage` 单独门控（`tool/handlers/index.ts:223`），不与 Agent 同生命周期。
- 工作流子代理路径（`builder.ts:92-97,118-119,141-146`）**不注入**本段：workflow actor 没有
  派发工具，其纪律由 `sections/workflow-actor.ts:33-46` 的契约段承载。

### R4 Agent 工具描述去烘焙

- 删除 `agent.ts:128` 的模块加载期常量，以及直接引用它的静态 `agentToolEntry.metadata.description`
  （`:228`）与静态 `taskToolEntry`（`:287-300`）。描述只在**装配期**构建：
  `createAgentToolEntry` / `createTaskToolEntry`（`:319-345`）是唯一产出点，装配点是
  `tool/handlers/index.ts:291,298`（`includeDynamicWorkflow !== false` → `dynamicWorkflowEnabled`）。
- 若为兼容既有 import 必须保留一个模块级名字，则**降级为显式命名的 fallback**
  （名字必须自带「未配置」语义，例如 `UNCONFIGURED_AGENT_DESCRIPTION_FALLBACK`），并且：
  - 不得被 `agentToolEntry` / `taskToolEntry` 的 `metadata.description` 直接引用；
  - 必须有防漂移测试断言「装配期描述 ≠ fallback」在传入非缺省配置时成立（验收场景 4）。
- `Task` 别名描述必须由**同一次** `buildAgentProviderDescription(options)` 产出
  （`createTaskToolEntryFromAgent`，`:302-317` 已是这个形状），不得各自构建——否则灰度门
  在两个工具上分叉。
- `tool/registry.ts:104-129` `toContracts()` 是描述进入 provider 的唯一出口，
  `:131-139` `toolDescriptionForProvider` 会把 `metadata.modelInstructions` 追加成 `Usage:` 段。
  **纪律文本不得走 `modelInstructions`**：那是 per-tool 的调用细则通道（R1 的「工具描述」层），
  把跨工具策略塞进去等于换个地方重复承载。

### R5 防漂移：灰度门与描述同源

- 任何影响**工具是否注册**的门，必须同时影响**描述里提到该工具的句子**。当前唯一的实例是
  `dynamicWorkflowEnabled`（注册侧 `runtime/helpers/tool-allowlist.ts:75`；描述侧
  `agent.ts:120-124`）。新增此类门时，两侧必须读同一个配置字段，不得一侧读 config 一侧读 env。
- 三变量组合矩阵（`profiles` × `embeddedSearchEnabled` × `dynamicWorkflowEnabled`）的描述快照
  是本规则的执法手段（验收场景 5）。

### R6 与 Plan reminder 的边界

- 具体并行数字（`planResearchAgentCount = 3`，`runtime-reminders.ts:23`）留在 Plan reminder，
  system 段**不写数字**。理由：数字随模式与阶段变化，写进全模式段就成了错的默认值。
- reminder 侧新增任何派发相关注入点，必须归入 `system-reminder/source.ts:20-51` 的三来源分类
  （PREFIX / PERSISTED / PER_REQUEST）并在 descriptor 表（`:88-164`）登记；本 spec 不新增
  reminder source。

## 状态所有者

```
runtime/methods/context.ts:141  getTools(model) → guidanceToolNames（工具面的唯一事实源）
   │
   ├─► context/builder.ts:141-149   buildSessionGuidanceSection(toolNames, hasSkills)
   │      └─ dynamic-sections.ts     段文本 + 条件（R2/R3）→ cacheHint "dynamic"（:110-125）
   │
   └─► tool/handlers/index.ts:291,298  createAgentToolEntry / createTaskToolEntry（装配期）
          └─ tool/handlers/agent.ts:91-126  buildAgentProviderDescription（R4，唯一产出点）
                 └─ tool/registry.ts:104-139  toContracts → provider tools（唯一出口）

runtime/helpers/runtime-reminders.ts:23,33-37  Plan 模式并行数（R6，独立所有者，不与上两者共享文本）
subagent/completion-notification.ts:21-51      通知文案（运行时事实，提示词层只呼应不重写）
```

- 段文本的所有者是 `context/dynamic-sections.ts`；工具描述文本的所有者是
  `tool/handlers/agent.ts`。**两者不得互相 import 文本常量**——共享的只有
  `tool/compat.ts` 的工具名判据（`isSubagentDispatchToolName`）。
- 工具面事实（哪些工具在）的所有者是 runtime 的 `getTools(model)`，经
  `guidanceToolNames` 单向下发；提示词层不得自行推断工具是否存在。

## 接口

- `core/src/context/dynamic-sections.ts`：
  `buildSessionGuidanceSection(toolNames: readonly string[] | undefined, hasSkills?: boolean): ContextSection | null`
  ——签名不变（`builder.ts:141-149` 现有调用点传 `?? []`，本 spec 要求改为传原值以区分
  「表缺席」与「空表」，见 R3）；新增内部构建函数
  `buildDelegatingWorkLines(toolNames: readonly string[] | undefined): string[]`（纯函数，
  返回 bullet 行，供段拼装；空数组即整节不出现）。
- `core/src/context/types.ts`：`ContextSource` 联合新增 `"delegating_work"`（`:31-50`）。
  若实现选择复用既有 `session_guidance` source（本段作为它的一条 bullet 组），则**不新增**
  枚举值，但 manifest 里的段 id 仍须可区分（见 `system-prompt-section-registry.md` R2）。
  二选一在实现 PR 里定，并回写本 spec。
- `core/src/tool/handlers/agent.ts`：`createAgentToolEntry(options)` / `createTaskToolEntry(options)`
  为描述的唯一构建入口（`:319-345`，签名不变）；`buildAgentProviderDescription` 保持
  模块内可见或导出供测试，**不再**有模块加载期求值的常量。
- `core/src/tool/compat.ts`：`isSubagentDispatchToolName(name: string | undefined): boolean`
  （`:11-14`，现有导出，本 spec 新增一个消费方）。
- 不新增 `ACODE_` 环境变量：本项的条件全部来自工具面与既有配置字段
  （`dynamicWorkflowEnabled` / `includeSendMessage`），无需新开关。

## 验收场景

1. **纪律节出现**：工具面含 `Agent`（或别名 `Task`）时，组装结果的 system 动态段含
   `# Delegating work`，且 R2 判据逐条可在快照里定位（第 5 条随 SendMessage 门控、
   第 6 条随 todo 双工具面门控——快照工具面不含对应工具时该条不出现，属预期）；
   工具面不含派发工具时整节不出现。
2. **不指向不存在的工具**：`dynamicWorkflowEnabled === false` 时，Agent/Task 描述里不出现
   `CreateWorkflow`（回归 `agent.ts:84-90` 记录的历史问题）；同时该配置下纪律节仍出现
   （派发工具与灰度是两道门，R5）。
3. **表缺席严格化**：`guidanceToolNames === undefined` 时不注入纪律节（R3），且 Skill 段行为
   与改动前一致（`builder.ts:225-228` 的 undefined 容错方向不变）。
4. **去烘焙防漂移**：以非缺省配置（如 `dynamicWorkflowEnabled: false` 或非空 `profiles`）
   装配得到的描述 ≠ 缺省配置的描述；`Task` 别名描述包含与 `Agent` 逐字相同的主体
   （同一次构建产出，R4）。
5. **三变量矩阵快照**：`profiles`（空 / 含自定义 profile）× `embeddedSearchEnabled`
   （true / false）× `dynamicWorkflowEnabled`（true / false / undefined）共 12 组合的描述快照
   全绿；快照文件不含任何第三方产品原文。
6. **去重成立**：纪律节与 `agent.ts:102-125` 描述之间无重复句子（人工审查 + 一条断言两者
   不含同一「委派后别重复搜」句子的测试）；审查结论已写回本 spec「去重审查记录」。
7. **双语义链路不回归**：
   - `desktop-continuous`：后台完成 → 父队列直写路径不变（`runner.ts:317-330` 的
     finalize 链未被提示词改动触及）；
   - `web-remote-replayable`：task-notification 的回放分类不变——通知仍归
     `system-reminder/source.ts` 的既有 source，**不得**被当作真实用户输入
     （`real_user` 通道，`:129`）。
   - **等价覆盖登记（2026-09-29 评审补强）**：本场景在
     `dispatch-discipline-prompt.test.mjs` 内无直接用例，以下列等价证据覆盖——
     ① D1 批次 diff 未触及 `runner.ts` finalize 链（git diff 核实；该链行为另由
     `subagent-terminal-first-wins.test.mjs` 的 (9) 组 runner 级用例钉住）；
     ② `reminder-extensions.test.mjs` 的 (7a)(7b)(7c) 断言双链路回放分类不变
     （通知归既有 source、不入 `real_user` 通道）。
8. **cache 分组不回退**：纪律节落 `cacheHint: "dynamic"`（`dynamic-sections.ts:110-125`），
   system block 数量仍 ≤ 3（`builder.ts:230-277`），stable 前缀未因本段变化。

## 实现决定回写（2026-09-29，D1+P1 实施批次）

按「接口」节的二选一授权与 R3 的写回要求，记录实现决定（第 1-3 条为 D1+P1 批次，
第 4 条为 D4 批次补记）：

1. **ContextSource 不扩枚举，复用 `session_guidance`**（「接口」节二选一的第二分支）。
   理由：`context/types.ts` 不在本批次所有权范围；`system-prompt-section-registry.md` R2
   允许一个 source 承载多个 id（`guidance.delegating_work` 留给 P2 注册表登记）；段内组标题
   `# Delegating work` 已使该节在文本与诊断里可单独区分。
2. **纪律节与恢复的指导 bullet 同住一个 ContextSection**：`builder.ts:141-149` 是本函数唯一
   调用点且 builder.ts 为他人所有（冻结），函数只能返回单段；段内按空行分两个标题组，
   `# Session-specific guidance` 标题仅在有指导 bullet 时出现（避免空标题）。
   cacheHint 仍为 `dynamic`，system block 数量不变（验收场景 8 已测）。
3. **R3「调用点改传原值」以函数内严格化等价落地**：builder.ts 调用点保持 `?? []` 不动，
   `buildSessionGuidanceSection` 签名放宽为 `readonly string[] | undefined`，`undefined`
   在函数内视同无任何派发工具 → 不注入纪律节。对纪律节而言「表缺席」与「空表」的结果
   相同（都不注入），故行为与「传原值」等价；验收场景 3 由直接调用函数的测试覆盖。
4. **（2026-09-29，D4 批次补记）纪律节追加第 6 条 todo 依赖纪律**：经
   `todo-dependency-fields.md` R6 与其实施记录第 7 条授权，按本 spec R1 分层规则挂入
   （同时涉及 TodoRead/TodoWrite 两侧的跨工具策略归 system 段）；门控为 todo 双工具面
   （`buildDelegatingWorkLines` 第 6 条分支）。本 spec R2 已同步修订为六条——原「仅五条」
   表述与 D4 授权构成 spec 间不同步，由独立评审发现（low）后回写本条闭合。

## 去重审查记录

> 恢复 `dynamic-sections.ts:48-66` 停用段时填写。每行记：原句（或其中文概括）、
> 判定归属层、处置（保留 / 删除 / 改写）、理由。**未填写即视为审查未做，实现 PR 不得合入。**

| 原句位置 | 归属层 | 处置 | 理由 |
| --- | --- | --- | --- |
| `dynamic-sections.ts:50` 前半（Use the Agent tool when task matches / parallelizing / protecting context window / not excessively） | 工具描述 | 删除（不恢复） | 全部是单工具选择判据，`agent.ts:109-111`「When to use」已逐点承载（task matches an available agent type / independent work in parallel / reading across several files / single-fact lookup 直接搜）；恢复到 system 段即 R1 禁止的复述 |
| `dynamic-sections.ts:50` 后半（avoid duplicating work — 委派了搜索就不要自己重复搜） | 工具描述 | 删除（不恢复） | R1 明示判例：该句归工具描述（`agent.ts:111` "Once you've delegated a search, don't also run it yourself" 承载）；纪律节第 3 条 Don't race 是「不代做**后台** agent 的工作」的判据，不复述该句（验收场景 6 有测试钉住） |
| `dynamic-sections.ts:52-57`（Explore 广度探索 >3 查询判据 + fallbackSearch 半句） | system 段 | 保留并改写 | 跨工具选择判据（Agent/Explore vs Grep/Glob/Bash 直搜）+ 数字门槛，方案 §4 P1 明确归 system 段；门槛不是并行数量，不触 R6。改写点：补上 `getDirectSearchGuidance` 实现（原只存在于注释、从未落地），fallback 随工具面收敛（embedded search 分支 → `Bash (find/grep)`；无任何直搜工具 → 省略半句），与 R5「不指向不存在的工具」同方向 |
| `dynamic-sections.ts:64-66`（AskUserQuestion：bounded clarification before proceeding） | system 段 | 保留并改写 | 「何时该用这个工具」的判据在工具描述（`ask-user-question.ts` 首句 genuinely the user's to make）；system 段只承载**跨通道**要点——结构化提问 vs 埋在回复末尾的 prose 提问——以注释原文的 "bounded clarification before proceeding" 为底稿改写，不复述工具描述的判据 |

## 不在本项范围

- **运行时硬约束**：不新增「后台强制」「轮询检测」「派发数量上限」。判据类语义只能在提示词层
  表达；运行时侧的总量保护归 `workflow-budget-fuses.md`（D2）。
- **fan-out 深度**：硬深度 1 现状不动（`runtime/methods/subagent.ts:275-287`）。
- **fork / team / coordinator / ScheduleWakeup**：方案 D7 判为长期可选，不进本项。
- **AskUserQuestion 指导段的恢复**：与派发纪律不同承载层，归方案 P1 与
  `system-prompt-section-registry.md`；本 spec 只确立分层判据供其引用。
- **`workflow-actor.ts` 的 escalate 段**：方案 P1 列为缺口，但当前检出**已存在**
  （`sections/workflow-actor.ts:40`）——该项已在基线之后落地，本 spec 不重复立项。
  （2026-09-29 注：方案 §4 P1 的实施批次已把该段按 driver 四时序扩写——新增
  submit accept/reject/nudge 三条时序 bullet，escalate 行补「答案落地后 turn 就地继续、
  ask 仍需照常收尾」的通道语义；机制细节仍归各工具描述，契约段不复述判据。）
