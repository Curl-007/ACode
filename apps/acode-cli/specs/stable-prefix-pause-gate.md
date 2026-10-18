# Spec：StablePrefix 字节稳定前缀 + PauseGate 进程级冻结闸门 + 提示词文件路由（WI-10）

> 状态：实施批次（2026-10-18，omp 价值提取波 2）。
> 移植来源（MIT，文件头逐一标注）：
> - `oh-my-pi/packages/agent/src/append-only-context.ts`（504 行）→ StablePrefix / AppendOnlyLog 思想；
> - `oh-my-pi/packages/agent/src/pause.ts`（107 行）→ AgentPauseGate 近逐字移植；
> - `oh-my-pi/packages/coding-agent/src/system-prompt.ts` + `main.ts`（APPEND_SYSTEM/SYSTEM/
>   TITLE_SYSTEM 文件路由）→ 发现位置与优先级语义。
> 硬约束：`no-telemetry.md`（诊断只进本地 debug 面）；`prompt-language-policy.md`
> （送模型文本恒英文）；异步文件 IO；新文件 ≤400 行。

## 背景（已核实的事实）

1. **每 turn 重组前缀**：`runtime/methods/turn.ts:257` 每个 turn 调
   `rebuildContextPrefix`（`context-refresh.ts`），后者**新建** ContextBuilder、
   重跑全部 section 注册表、`messageHistory.replaceMessages([...contextEntries,
   ...conversationEntries])` 全量深拷贝。系统前缀字节是否稳定完全取决于各 section
   是否恰好是 config 的纯函数——没有任何机制**保证**冻结，也没有失效观测点。
   `prompt-cache-diagnostics.md` 已把 `context_refresh` 登记为 miss-cause。
2. **消息日志已是追加式但有重拷贝税**：`MessageHistoryImpl` 的 add* 全为 push；
   但 `replaceMessages` 对**全部**条目 `cloneEntryInput` 深拷贝——每 turn 的
   context-refresh 会把整个会话历史重克隆一遍（旧 turn 被无谓重序列化）。
3. **无进程级暂停面**：turn 循环（`turn-loop.ts` while(true)）与工具批执行
   （`turn-tools.ts` executeTools）没有 pause 安全点；子代理走同款
   `executeTurn → runRegularTurnLoop`（child runtime），也没有统一冻结闸门。
4. **无提示词文件路由**：全仓 grep 无 APPEND_SYSTEM/SYSTEM.md 支持；
   `AgentRuntimeConfig.systemPrompt`（整段替换通道 → `identity.custom` 段）存在但
   只有 host 显式传值一条路。会话标题生成器存在：
   `runtime/methods/title-generation-sidecar.ts` 的 `SESSION_TITLE_SYSTEM_PROMPT`
   硬编码常量（TITLE_SYSTEM.md 的对应面**存在**）。
5. **omp `MAX_PAUSED_TURN_CONTINUATIONS` 的真实语义**（agent-loop.ts:125）：限制
   provider 返回非终结 stop（`stopDetails.type === "pause_turn"`，如 Codex
   `end_turn: false`）时的连续重采样次数，**与 pause 闸门无关**。ACode 全仓
   （core + contracts）无 `pause_turn`/`stopDetails` 面；最接近的既有护栏是
   `MAX_OUTPUT_TOKEN_CONTINUATIONS = 3`（turn-output-token-continuation.ts:18，已存在）。

## R1 StablePrefix：builder 输出层字节冻结

**所有者**：`context/stable-prefix.ts` 的 `StablePrefixCache`（每缓存键一个实例）。
模块级注册表按 `ContextBuilderConfig.sessionId` 分键（LRU 上限 32 键，防长寿进程
无界增长）；`sessionId` 缺席（子代理 builder / 测试 / preview 路径）退化为
**builder 实例私有缓存**，绝不跨会话共享。

**为什么按 sessionId 分键**：`rebuildContextPrefix` 每 turn 新建 builder 实例，
缓存必须跨实例存活才能冻结字节；同会话的所有 builder 实例共享一个键。不同会话
（主会话 vs 子代理 child runtime vs 舰队）键不同，互不可见。

**事件顺序（每 turn）**：

```
build()/buildAsync()
  → resolveSectionEntries(Sync)（现状不变，段管线仍是唯一文本所有者）
  → assembleBuildResult（现状不变：≤3 system block + meta_user attachments）
  → serializeContextBuildResult（显式投影，字段序固定，见下）
  → cache.reuse(serialized)
      命中（逐字节相等）→ 返回**冻结的旧 result 对象**（同一引用 ⇒ 同一字节）
      未命中            → cache.store(serialized, result)，version++，返回新 result
```

- 序列化投影 = `sections[name,source,injectionTarget,cacheHint,chars,tokens,content]`
  + `systemMessages[role,content,cacheControl]` + `metaUserAttachments[source,content]`
  + totals。`preview` 是 content 派生量，不参与。显式投影而非裸 JSON.stringify(result)：
  不同 section builder 的对象字面量键序不保证一致，裸 stringify 会产生假 miss。
- **命中判定是字节相等，不是 hash 相等**：32-bit hash（omp 同款 djb2→base36，
  `stablePrefixFingerprint`）只作诊断指纹，不作命中依据——碰撞后果是发错系统提示词，
  不可接受；全量字符串比较每 turn 一次（~40KB），成本与组装同量级。
- **失效**：`StablePrefixCache.invalidate()` / `invalidateStablePrefixCache(sessionId)`
  显式丢弃冻结快照，下一次 build 必然重拍（version++）。语义对齐 omp：MCP 重连、
  工具集/技能变更等**若已反映在 config → 段输出**上，指纹自然变化、无需显式失效；
  invalidate 面向「输入没变但必须重拍」的外部事件与测试。
- **幂等边界**：cache.store 只增 version、不改写旧 result 对象；仍持旧 result 的
  调用方看到的字节永不原地变化。
- **观测**：`version` / `fingerprint` / `built` 只读暴露；本 spec 不新增日志面
  （builder 已有 manifest trace debug 通道，prefix 漂移可由 version 递增推断）。

**与既有 cache 设计的关系**：三 block 布局（cli_prefix / stable body / dynamic）与
ephemeral cacheControl 全部保持不变（R4/R5 硬约束归 system-prompt-section-registry
spec 所有）。StablePrefix 只保证「同输入 ⇒ 同对象 ⇒ 同字节」，不改任何文本。
动态易变内容（cwd/日期/模型行）已经由注册表分层集中在 dynamic block 与 meta_user
尾块（`env.info`、`date.current` 均 system-dynamic / meta_user-dynamic），命中
provider 缓存断点的布局前提**现状已满足**，本项不搬动段序。

**范围外**：子代理组装路径（`subagent/context-builder.ts` 的
`assembleSubagentResult`）不接冻结层——该文件归 subagent 所有者；子代理生命周期短、
每 turn 重建税小，波 3 再评估。

## R2 AppendOnly：旧 turn 永不重序列化

**所有者**：`agent/message-history.ts` `MessageHistoryImpl.replaceMessages`。

omp `AppendOnlyLog.syncMessages` 的核心事实是「已上 wire 的前缀保持字节稳定，
只有分叉点之后重新入列」。ACode 对应面：

- add*（user/assistant/tool/attachment/entries）已是纯 push，不动旧条目（现状保持）。
- `replaceMessages` 改为**身份复用**：入参数组中与当前 `entries[i]` **引用相等**的
  项直接保留原对象，不再 clone；仅新增/替换位置做 `cloneEntryInput`。
  每 turn 的 context-refresh 传入
  `[...新 contextEntries, ...borrowReadOnlyRuntimeEntries().slice(n)]`——会话尾部
  引用相等 ⇒ 整个会话历史零重拷贝；前缀条目（≤6 条）照常克隆。
- 前缀计数变化（section 结构变化）时引用不再对位 ⇒ 自动退化为全量克隆，
  **正确性不依赖对齐假设**，身份复用只是快路径。
- 不变式：`MessageHistoryImpl` 之外没有人持有可写别名——replaceMessages 复用对象
  不引入新别名（被复用的对象本来就是 history 自己的 entries）。

**验收映射**：「追加不重序列化单测」= replaceMessages 后旧会话条目 `===` 原对象、
分叉点之后为新克隆、内容逐字节不变。

**与既有不变量的协调**：`compact-invariants.test.mjs` I4-3 是「replaceMessages =
无守卫覆盖」的前提登记（源形态 pin）。身份复用**不是** stale 守卫（无版本判定、
无拒绝路径，并发防线仍靠上游单活跃 turn 互斥），前提语义不变；I4-3 的源形态
断言已按其登记说明同步为身份复用形态。

## R3 层次：冻结前缀 vs 动态块 vs reminder 消息流（与波 1 memory 注入协调）

三层**互不越界**（自上而下字节稳定性递减）：

| 层 | 载体 | 稳定性 | 所有者 |
|---|---|---|---|
| 冻结前缀 | `ContextBuildResult.systemMessages`（cli_prefix + stable body）+ meta_user attachments → context prefix entries | 同输入同字节（R1 保证），跨 turn 冻结 | context/builder + stable-prefix.ts |
| 动态 system 块 | dynamic block（env.info/日期行/git 快照等） | 每 turn 可重算；位于 stable 块之后，破坏面只到自身 | 注册表 system-dynamic 组 |
| reminder 消息流 | per-request entries（`systemReminderAttachmentEntry`：memory_recall、**memory_semantic_recall（波 1）**、todo、runtime_mode、ultracode 等） | 每 turn 动态注入，属**消息流**（turnRequestState.entries），永不进冻结前缀 | runtime turn-loop |

波 1 的 memory 每 turn 动态注入走第三层（`turn-loop.ts:192-218` per-request 档），
与 R1 冻结层无交集：reminder 不进 `ContextBuildResult`，因此不参与前缀指纹，
也不会因冻结而变陈旧。反过来，R1 不改变 reminder 的任何语义。

## R4 PauseGate：进程级冻结闸门 + 双安全点

**所有者**：`agent/pause-gate.ts` 的单例 `agentPauseGate`（omp pause.ts 近逐字移植，
`Promise.withResolvers` 为 Node 22+ 原生，mise 钉 Node 24，无需降解；文件头标注
MIT 来源）。**host 驱动、库只读**：本波只落闸门与轮询点；`/pause` 类 host 控制面
（slash 命令注册 / v4 协议命令）归命令面所有者，见「共享桶申请」。

**状态机**：

```
running ──pause()──▶ paused(#gate=deferred, pausedAt=now, listeners(true))
paused  ──resume()─▶ running(#gate=undefined, deferred.resolve(), listeners(false),
                             返回冻结时长 ms)
paused  ──pause()──▶ 无操作，返回 false（幂等）
running ──resume()─▶ 无操作，返回 undefined
```

- **park 语义**（waitUntilResumed）：while(#gate) 循环——resume 后、awaiter 续体
  执行前又被 pause 的，必须**重新 park**，不得漏过（omp 同款循环，测试覆盖）。
- **abort 解 park**：单 run 的 AbortSignal 只释放**本 waiter**（闸门保持关闭，
  其他 loop 继续冻结）——取消一个 run 不需要解冻全进程。
- **listener containment**：listener 抛错吞掉，绝不破坏闸门。

**安全点位置图**（唯一轮询点集合；两处均为「先 poll 后动作」）：

```
runRegularTurnLoop (runtime/methods/turn-loop.ts, while(true) 顶部)
  ├─ throwIfTurnAborted
  ├─ ★SP① parkAtPauseSafePoint(turnAbortSignal) + throwIfTurnAborted   ← 模型调用前
  │      （位于 microcompact/autoCompact/MCP init/reminder 注入/模型 step 之前：
  │        冻结期间不产生压缩、不发起 provider 请求）
  └─ runModelBackedTurnStep
       └─ executeToolCallsForModelStep (runtime/methods/turn-tools.ts)
            ├─ scheduleTools / persistPendingToolPart / 排程事件（照常：纯本地状态）
            └─ ★SP② parkAtPauseSafePoint(turnAbortSignal)               ← 工具调用前
                 └─ this.executeTools(...)（批级；进 handler 之前冻结）
```

- **覆盖范围**：主会话 + 同进程子代理（child runtime 走同款
  `executeTurn → runRegularTurnLoop`）+ 舰队会话——单例闸门天然进程级。
- **在飞语义**（omp 对齐）：pause 不 abort 任何在飞操作——已发起的 provider 流、
  已进入 handler 的工具跑完，各 loop 在**下一个**安全点 park。排队中的
  steer/follow-up 消息保持排队，resume 后照常投递。
- **不进安全点的面（显式豁免，防止误期待）**：
  1. **stream 期间启动的流式工具**（streaming-tool-coordinator）：属「在飞流」的
     一部分；在 stream 中途 park 会把 provider 流挂到超时上，违背「在飞流跑完」。
  2. 标题生成 sidecar、compact summary、hooks、auto-resume 等辅助模型请求：
     非 agent turn loop，omp 同样只在 agentLoop 轮询。
  3. TurnMachine 状态机**不新增 paused phase**：park 发生在 phase 边界之外
     （AwaitingModelResponse 之前 / ExecutingTools 进入之前），状态机与持久化
     对 pause 无感知——冷恢复语义零变化。
- **无限续轮上限（omp MAX_PAUSED_TURN_CONTINUATIONS）**：调查结论 = **N/A 不移植**。
  该常量限制的是 provider `pause_turn` 非终结 stop 的连续重采样（背景 §5），
  不是 pause 闸门的配套；ACode 无 pause_turn stop-detail 面，无对应失控路径。
  既有 analog `MAX_OUTPUT_TOKEN_CONTINUATIONS=3` 已在。闸门自身无续轮语义：
  park 不产生模型请求，resume 后 loop 从中断点继续，天然无「pause 期续轮」。
  若未来 ACode 接入 pause_turn 类 provider 语义，在其重采样点移植该上限。

## R5 提示词文件路由（APPEND_SYSTEM.md / SYSTEM.md / TITLE_SYSTEM.md）

**所有者**：`context/prompt-files.ts`（发现 + 读取，异步 IO，readFileText 可注入）；
渲染段 `identity.append`（registry-main.ts 登记）。

**文件与语义**：

| 文件 | 语义 | ACode 对应面 | 本波状态 |
|---|---|---|---|
| `APPEND_SYSTEM.md` | 保留默认提示词，只追加 | 新段 `identity.append`（system-stable 组、stable body 末尾；default+custom 通道，workflow_actor 通道排除——actor 身份自足） | **机制 + 渲染段落地**；runtime 接线延迟（见下） |
| `SYSTEM.md` | 替换指令块 | 既有 `customSystemPrompt` 通道（`identity.custom`，与 workflowActor 互斥硬失败既有） | 发现/读取机制落地（`systemOverride`）；映射 = host 在无显式 CLI systemPrompt 时把内容装入 `config.systemPrompt`，接线延迟同上 |
| `TITLE_SYSTEM.md` | 会话标题生成提示词覆盖 | **对应面存在**：title-generation-sidecar.ts `SESSION_TITLE_SYSTEM_PROMPT` | 发现/读取机制落地（`titleSystem`）；消费点在 runtime/methods（WI-10 所有权外），接线延迟同上 |
| `SYSTEM_TEMPLATE.md`（Handlebars）/ `PERSONALITY.md` | omp 活数据模板 / 人格 | 无对应面（ACode 无模板引擎、无人格面） | **N/A 登记**：不为 omp 引入 Handlebars 依赖；persona 已由 workflowActor 通道承载 |

**发现位置与优先级**（每文件名独立解析，首个命中即停）：

```
1. project：workingDirectory 起向上 walk-up（≤ 项目根探测上限 8 层）：
   <dir>/APPEND_SYSTEM.md          ← 裸文件优先
   <dir>/.acode/APPEND_SYSTEM.md   ← 同层 .acode 子目录次之
   （越近 cwd 越权威，对齐 ACode AGENTS.md walk-up 与 omp「project beats user」）
2. user：<userConfigDir | ~/.acode>/APPEND_SYSTEM.md
```

- 全空白文件 = 缺席（不渲染空段，不覆盖）；读取抛错（EACCES 等）= 跳过该候选
  继续下一优先级（可选 logger.warn，绝不 fail 会话）。
- **不做 include 展开 / 模板渲染**：内容逐字注入（用户数据，`persistable: false`
  不进 prompt manifest，R6 同款待遇与 `identity.custom` 一致）。

**接线边界（本波延迟，精确补丁登记）**：文件 IO 必须发生在 async 面；builder 的
同步 `build()` 通道不能读盘。生产接线点在 runtime 所有者文件（WI-10 所有权清单
只含 context/**、agent/**、runtime 安全点最小文件，故本波不改）：

```ts
// runtime/methods/context.ts ensureContextInitialized（memoryIndexContent 加载旁）：
//   const promptRouting = await loadPromptFileRouting({ workingDirectory: this.workingDirectory });
//   this.promptFileRouting = promptRouting;               // internal.ts 新字段
// createContextBuilderFromSnapshot 的 contextConfig：
//   appendSystemPrompt: this.promptFileRouting?.appendSystem?.content,
//   customSystemPrompt: this.config.systemPrompt
//     ?? this.promptFileRouting?.systemOverride?.content,  // 显式 CLI 值优先
// title-generation-sidecar.ts：
//   const titlePrompt = this.promptFileRouting?.titleSystem?.content
//     ?? SESSION_TITLE_SYSTEM_PROMPT;
```

接线前 `identity.append` 段恒缺席（enabled 谓词吃 config.appendSystemPrompt），
零行为变化；单测经 config 注入验证渲染，loader 经注入 fs + 真实 tmpdir 双路验证。

## 验收场景

1. 同输入两次构建（两个 builder 实例、同 sessionId）→ 返回**同一对象**，
   systemMessages/metaUserAttachments 逐字节相等；`invalidate` 后重建 → 新对象、
   version 递增、字节仍相等（等价重建）。
2. 输入变化（currentDate 变）→ 指纹变化、新快照、version 递增；旧 result 持有者
   字节不变（无原地改写）。
3. replaceMessages 身份复用：稳定尾部 `===` 原对象；分叉点/前缀为新克隆；内容不变。
4. PauseGate：pause→双安全点 park（假 loop 计数停走）→resume 解 park；abort 只解
   本 waiter、闸门保持；resume-后再-pause 的 waiter 重新 park；listener containment；
   pause/resume 幂等返回值。
5. APPEND_SYSTEM.md：loader 优先级（project 裸文件 > project .acode > user；
   walk-up 近者胜）；builder 注入后 stable body 末尾含追加文本；custom 通道叠加、
   workflow_actor 通道缺席。
6. 零回归：system-prompt-section-registry / prompt-manifest-parity / prompt-cache
   相关既有测试全绿（ALL_SECTION_IDS 快照按新增 `identity.append` 更新）。

## 不在本项范围

- `/pause` host 控制面（slash 命令 / v4 协议命令 / TUI 状态显示）——共享桶申请登记。
- runtime 接线补丁（R5）——归 runtime 所有者 / 编排者派发。
- 子代理组装路径的冻结层、`sent-tool-definitions` 式已发送工具集跟踪（ACode 工具
  规格走 request tools 字段而非 system prompt，工具列表抖动不破坏 system 前缀；
  provider 侧 tools 缓存断点归 model 层，波 3 评估）。
- omp `AppendOnlyContextManager` 的 per-message digest 分叉探测：ACode 的
  replaceMessages 身份复用已覆盖其热路径收益，digest 深比较留给出现真实
  「同引用但内容被改写」的所有者时再引入。
