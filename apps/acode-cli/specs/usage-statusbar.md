# usage-statusbar：原生用量状态栏、数据口径与 /usage 命令族

> 来源与许可：机制设计移植自 https://github.com/ByteRax/zcode-token-usage-statusbar
> （MIT, Copyright (c) 2026 xhwx）。只搬功能面与数据语义，不复制代码与文案；
> 原项目载体（asar 注入 overlay、Python 常驻刮 SQLite、心跳泵、安装器/更新链）全部作废，
> 本 spec 一律原生实现。

## 目标

把「用量状态栏 + 全套数据口径 + 回答末尾速率行 + /usage 查询命令族」原生落进 ACode：
desktop/ui 状态栏消费 v4 投影既有事实，CLI/TUI/desktop 共用零 token 的 /usage 本地命令。
调查结论（2026-10-17 摸底）：采集（SQLite 三表账本 + TTFT 持久化）、协议
（`snapshot.usage` 实时下发、`v4/usage/stats`、`v4/conversation/usage`）、UI 先例
（设置页 App Usage、composer 上下文环、TUI 徽标）均已存在；本 spec 只补
「消费与呈现」层和最小 additive 协议字段，不新建数据面。

## 2026-10-19 重设计裁决（用户确认，本节统辖后续各节修订）

三个实机缺陷（流式中 hover 即消失 / 布局看不懂 / 数据不实时）根因分析后的四项裁决：

1. **形态**：六胶囊全保留，胶囊增加文字微标签（icon + 微标签 + 值）；六个独立
   tooltip 合并为一个「用量明细」统一面板，hover 触发器 = 整条状态栏（见
   「Tooltip 稳定性与统一明细面板」节重写）。
2. **实时口径**：原红线「严禁流式中途自算 tok/s」改写为「producer 节流下发真实
   in-flight usage 事实，UI 端永不无事实依据估算」（见「In-flight 真实用量事实面」
   节）；无中途 usage 事实的 provider（OpenAI 系 `include_usage` 仅末包）如实降级为
   已耗时秒表 + 脉冲点，**严禁按字符数估算 token**。
3. **运行中「本轮」语义**：本轮用量胶囊在 running 期间显示本轮 live 累计值（标
   「进行中」），TurnComplete 被权威 stats 定格；不再显示上一轮的值。
4. **阻塞场景维持现状**：权限/提问卡片阻塞时整个 composer（含状态栏）
   `display:none`，不做独立常驻。

**hover 真根因更正（2026-10-19）**：上一轮 `disableHoverableContent` 修复未命中。
真机制 = 流式期间胶囊几何突变（工具计数值 tick 变宽、脉冲点插拔、hide-on-absent
presence 翻转整胶囊插入）把 trigger 从**静止指针**底下推移，浏览器布局后补发
`pointerleave` → Radix 关闭；而 Radix 重开只认 trigger `pointermove`
（`@radix-ui/react-tooltip@1.2.8` dist `hasPointerMoveOpenedRef` 门），指针不动
永不重开。局部 Provider 修的是 grace area 误判路径，与本机制无关，故无效。
**教训制度化**：本波实施必须先运行时复现（真实流式 + CDP 自动化）录到修复前
消失、修复后常驻，推断级根因不得再上线。

## 数据口径（唯一事实定义，producer 单点计算）

1. **总用量** = input + output。cache_read 已含于 input（AI SDK v6 Anthropic 口径，
   见 `contracts/src/model/index.ts` getModelUsageContextTokens 注释），不重复相加。
2. **缓存命中率** = cacheReadTokens ÷ inputTokens（input 为 0 时不显示）。
3. **生成耗时 generationMs**（每请求）：含思考的请求（reasoningTokens > 0）或无首字
   时间戳的请求 = completedAt − startedAt（思考 token 在首字前流出）；否则 =
   completedAt − firstTokenAt。段间工具等待天然不计（每模型步一条事实）。
   **producer = core `runtime/methods/usage-observability.ts`**（事实已采集：
   durationMs/timeToFirstTokenMs/firstTokenAt 均持久化），随 ModelComplete 事件带出。
4. **生成速度 tok/s 两档（2026-10-19 改写）**：
   - **权威值** = 该请求 outputTokens（含思考）÷ generationMs，每完成一次模型请求
     更新一次；ModelComplete 到达即替换进行中值并定格。
   - **进行中值** = `inFlight.partialOutputTokens ÷ (observedAtMs − startedAtMs)`
     （分母从请求起算，与含思考请求的权威口径一致；非思考模型进行中值略偏保守，
     完成后被权威值替换，面板脚注如实说明）。**只在 producer 下发真实 in-flight
     事实时事件驱动更新，UI 端严禁定时器重算速率、严禁字符数估算、严禁任何无
     事实依据的数字**。provider 无中途 usage 事实 → 速度位降级为「生成中 + 已耗时
     秒表」（秒表 = 起始时间戳与当前时刻之差的 UI 本地真实时间，1Hz 刷新，不是
     用量数字，不受估算禁令约束）。见「In-flight 真实用量事实面」节。
5. **上下文占比** = 最近 completed 请求的 usedTokens ÷ maxTokens（压缩后自然回落，
   非峰值）——既有 `snapshot.usage.contextWindow` 语义，不改。
6. **轮数** = count(distinct turn)；**请求数** = 模型请求计数累计。
7. **TTFT** = timeToFirstTokenMs（已持久化于 model_usage/turn_usage）。
8. **"当前会话"两种口径严格区分**：状态栏 = 本窗口焦点会话（见下），/usage `current`
   = 最近 30 分钟内有请求的会话；帮助文案明示两者不保证等同。

## 状态栏（packages/ui，挂 v4 ConversationComposer 工具栏下方）

新目录 `packages/ui/src/v4/usage-statusbar/`（每文件 ≤400 行），条状胶囊布局，
逐项可显隐。

**微标签形态（2026-10-19 裁决）**：每个胶囊 = icon + 文字微标签（`text-ui-xs`
弱化色，取既有 `*.label` i18n 文案的短形式，新 key `*.shortLabel` 双语）+ 值
（`tabular-nums`，值携带单位语境：tok/s 后缀既有、token 数走 compact 格式）。
六个独立 tooltip 全部退役，明细与口径说明统一进整条 bar 悬停的「用量明细」面板
（见「Tooltip 稳定性与统一明细面板」节）；下表「悬停展示 XX」一律读作「统一面板
对应分组中展示」。八项在 ACode 的形态裁决：

| 项 | 形态 | 数据源 |
| --- | --- | --- |
| 生成速度 | 空闲 = 最近一次模型请求 tok/s（权威值）；running = inFlight 进行中 tok/s，无事实则秒表降级（口径 4 两档）；颜色表快慢档；口径进统一面板 | `snapshot.usage.lastRequest` + `usage.inFlight`（2026-10-19） |
| 上下文容量 | **不重复建**——由既有 composer 上下文环（ChatContextUsage）承载并增强：接近 auto-compact 阈值分档变色 + 上下文被拒时悬停给处置建议（compact/新会话）；状态栏不设独立上下文项 | `snapshot.usage.contextWindow`（autoCompactThresholdTokens 补真值，见协议面） |
| 本轮用量 | running = 本轮 live 累计（`inFlight.turnToDate*`，标「进行中」，TurnComplete 被权威 stats 定格）；空闲 = 最近完成 turn 的 tokens + 缓存命中率 + TTFT；输入/输出/缓存读/缓存写/思考明细进统一面板本轮分组 | `turnHeader.stats` + `usage.inFlight.turnToDate*`（2026-10-19） |
| 会话累计 | 用量 + 轮数 + 请求数 + 代码增删；**每窗口绑定焦点会话，绝不回退**（无活动 v4 会话快照 → 胶囊隐藏，只留齿轮，见「hide-on-absent 空态规则」节；组件只读本窗口 conversationProjectionStore 的活动会话 snapshot，禁止跨会话/跨窗口兜底启发式） | `snapshot.usage.cumulative`（+reasoningTokens）+ turnHeader 行求和（轮数/请求数/additions+deletions，字段已在 rows.ts） |
| 工具调用 | 次数 + 出错标记；悬停各工具耗时与错误 | 投影 toolCall 行本地聚合（rows 已有 durationMs/状态，零协议改动） |
| 今日合计 | 当天跨会话累计；挂载拉取 + turn 完成刷新 + 窗口聚焦刷新（无高频轮询）；remote workspace 会话走 remoteWorkspaceServiceCollection 的同名 usageStats 服务，绝不把另一 workspace/服务器的今日量混入 | `IUsageStatsService.getAppUsageSnapshot`（AppUsageRange 实际闭集 all\|7d\|30d——取 7d 档按请求 timeZone 的当天日期键从 heatmap 提取，单点在 `useTodayUsageTotals`；若日后增补 today 档只改该处；远端同源） |
| 子智能体 | 值 = 仅子代理累计（见「子代理胶囊值语义」节；主/子对比在展开面板）；点击展开每派发任务（标题 + 累计 tokens + 状态）；运行指示用权威 running 状态（不做 30s 心跳启发式）；归因走原生 registry 的 agentId 硬关联（天然满足「宁无名不错名」，禁止时间/前缀启发式） | `RunningSubagentSummary`（+cumulativeTokens，新增）；深钻按 childSessionId 走 `queryTaskUsage` |
| 设置齿轮 | 逐项显隐 + 速率行开关；localStorage slice（照 `store/appearancePreferencesState.ts` 波 2 落法：姊妹模块收 slice、store/index.ts 单行接线、BROADCAST_FIELDS 跨窗广播 + applyBroadcast 防回环）；窗口大小手动覆盖**不做**（模型配置权威）；语言随 app i18n **不设独立项** | ui store 新 slice `usageStatusbarPreferencesState.ts` |

### 回答末尾速率行（可关，默认开）

当前问题最后一个已完成 turn 的 turnHeader.stats 存在时，在该轮末尾渲染一行：
加权速度（Σoutput ÷ ΣgenerationMs）+ TTFT + 输出量 + 耗时；悬停解释与状态栏口径差异
（状态栏看最近一段请求，速率行看本问已入库多段；收尾正文不在采样内）。
纯问答/无 stats/开关关闭 → 不渲染，绝不显示上一问的统计。

### Tooltip 稳定性与统一明细面板（2026-10-19 重写，替代原「Tooltip 稳定性」节）

**症状**：对话流式输出/思考进行中，悬停胶囊的明细浮层只闪一下即消失，指针不动
不再回来，流式结束才恢复常驻。

**真根因（2026-10-19 代码级确证，取代原 grace area 推断）**：流式期间胶囊条几何
持续突变——工具计数值 tick 改变胶囊宽度、相位脉冲点插拔、hide-on-absent presence
翻转使整胶囊插入/移除（首个请求完成时速度胶囊插入一次推移约 70px）——胶囊在
**静止指针**底下被推移，浏览器布局后重算命中目标补发 `pointerleave`，Radix 关闭
tooltip；而 `@radix-ui/react-tooltip@1.2.8` 的重开门槛是 trigger `pointermove`
（`hasPointerMoveOpenedRef` 门，dist L182-189），静止指针永不重开。原修复的
局部 `TooltipProvider disableHoverableContent` 消除的是 grace area 误判路径
（dist L257-289），与本机制无关，故无效（该 Provider 保留：它仍消除一条真实的
抖动路径，且统一面板方案不依赖它）。

**结构性修复：hover 触发器 = 整条状态栏，明细 = 单一统一面板**：

- 六个胶囊级 Tooltip 全部退役。整条 bar（几何稳定：composer 全宽、`h-7` 定高、
  底边 anchored）作为唯一 hover 触发器，打开一个「用量明细」统一面板。
  内部胶囊再怎么跳动，指针都不会离开 bar 容器 → 不存在 pointerleave 误杀。
- 面板用**受控 Popover**（`bg-popover rounded-xl shadow-md`，锚定整条 bar，
  `side="top"`）：open 状态由 bar 容器自管 `mouseenter`/`mouseleave`（关闭宽限
  ~150ms）+ 点击钉住（pinned 切换）驱动，不走 Radix Tooltip 的任何隐性关闭路径
  （scroll capture、TOOLTIP_OPEN 广播、grace area 均不适用）。Esc 与点击外部
  解除钉住/关闭为常规 Popover 语义。
- 面板内容 = 带标签的分组行式清单（复用 `UsageStatusbarDetailRow`）：**本次请求
  （进行中 ●，running 时；live 值 + 口径脚注）/ 本轮 / 会话 / 今日 / 工具 / 子代理**，
  每组一行口径脚注（缓存读已计入输入、进行中值分母口径、今日刷新时机等，文案
  沿用既有 `*.tooltip` i18n key）。既有明细行全量保留（会话缓存读/写、今日主要
  模型、工具 8 行封顶 +N 更多、lastError 弱化行）。面板分组**不受**胶囊显隐偏好
  影响（偏好只治 bar，面板恒全量；无数据的组按 hide-on-absent 缺席不渲染）。
  宽度 `max-w-96` 级别，行式清单不无限铺开。
- 子代理胶囊的点击 Popover 面板维持现状（独立 Radix Popover，不受影响）；与统一
  面板互斥打开（点击子代理胶囊时关闭统一面板）。

**布局稳定规则（视觉 calm 独立收益，无论面板方案均需）**：

1. 每胶囊稳定 `key`（按项 id），条件渲染不依赖数组位置。
2. 每胶囊固定 `min-w` 槽位（按典型值宽度钉住，`tabular-nums` 既有），值 tick
   不推挤邻居；微标签为恒定文案不随值变化。
3. 脉冲点改**常驻槽位**：固定尺寸 span 恒渲染，`opacity` 切换显隐，不插拔。
4. 值变更 160ms 淡入（keyed span）保留——重挂载在固定槽位内，不影响条几何。
5. hide-on-absent 的整胶囊插入/移除保留（缺席 ≠ 零值语义不变）；一次性位移在
   统一面板方案下不再致命，可接受。

**验收（教训制度化）**：实施前先以真实流式 + CDP 浏览器自动化复现修复前消失
（录证），修复后同场景验证：指针悬停 bar 不动 + 模型持续流式（含工具 tick、
presence 翻转）→ 面板全程常驻不闪断。推断级根因不得作为交付依据。

**不接受的对症方案**（沿用原节纪律）：流式期间禁用浮层、pointer 事件防抖、
setTimeout 重开等掩盖性补丁。

### 排版一致性（2026-10-18 增补）

- **tooltip 标题字号 = `text-ui-sm`**（DESIGN.md「Tooltip：titles … use text-ui-sm」）：
  `UsageStatusbarCapsule` 的 tooltip 标题与 `TurnRateLine` 的 tooltip 标题统一
  `text-ui-base` → `text-ui-sm`。
- **tok/s 单位后缀进文案表**：`formatTokensPerSecond` 不硬编码英文单位，后缀走
  i18n key `chat.usageStatusbar.unit.tokensPerSecond`（双语同值 `tok/s`；键在表，
  文案可改，代码零硬编码单位）。`USAGE_NO_DATA_PLACEHOLDER` 早返回语义不变
  （tooltipStability 契约）。
- **zh compact 数字单点**：`packages/ui/src/lib/tokenNumberFormat.ts` 是 token 数值
  compact 格式化的**唯一所有者**，zh 系 locale 统一输出 万/亿 量级并在数字与量级字符间
  补一个空格（`1.2 万`、`1.2 亿`；低于万原样 `1200`）；en 系维持 K/M/B 不变。
  `formatModelContextWindowLabel` 是技术规格徽标，**保持**强制 en-US，不在统一范围。
- **代码增删符号**：`+N −N` 的减号固定 U+2212（MINUS SIGN）与 `+` 对齐排版，测试钉住。

### hide-on-absent 空态规则（2026-10-18 增补）

状态栏胶囊按「数据源在场与否」显隐，**缺席 ≠ 零值**：

- 判定收进 `usageStatusbarModel.ts` 纯函数 `resolveUsageStatusbarPresence`（单一所有者，
  组件不做内联启发式）：生成速度 = `lastRequest` 在场；本轮用量 = 最近完成轮 `stats`
  在场；会话累计 = `snapshot.usage` 在场；工具调用 = 投影行存在 toolCall 行；
  今日合计 = 当天 heatmap 单元格命中；子智能体 = 子代理投影在场且（有 running 或
  endedTotal > 0）。
- **零值 ≠ 缺席**：数据源在场而数值为 0（如会话累计 0 tokens、今日 0 轮）照常显示；
  数据源 null/缺席 → 胶囊整体不渲染。`snapshot=null`（无活动会话）→ 只剩设置齿轮，
  绝不回退其他会话/窗口（绑定纪律不变）。
- 设置 Popover 底部注明「无数据的胶囊自动隐藏」，用户显式开关仍优先生效
  （显式关 = 永不显示；显式开 = 有数据即显示，无数据隐藏）。

### 子代理胶囊值语义（2026-10-18 增补）

胶囊值 = **仅子代理累计**（Σ 在场子代理 cumulativeTokens，缺席整体 "—"），
不再显示「主/子」分列——主代理值与会话累计胶囊数字重复（同一事实两处呈现）。
主/子对比下沉到点击展开的 Popover 面板（面板本就分列主/子）。aria-label 与
tooltip 口径说明随值语义同步更新。

### 窄屏分级隐藏优先级（2026-10-18 增补）

composer 工具栏在窄容器下按**信息优先级**逐级隐藏（CSS 容器查询，组件不卸载、
数据照常挂载）：先藏今日合计 → 子智能体 → 生成速度 → 工具调用 → 会话累计；
**本轮用量与设置齿轮保留到最后**。初定两级：`@max-[520px]`（composer 命名容器）藏
今日合计、子智能体；`@max-[420px]` 再藏生成速度、工具调用、会话累计。
容器查询挂既有 `@container/composer`（ConversationComposer 根），Tailwind v4
任意值命名容器语法 `@max-[520px]/composer:hidden`；与 hide-on-absent 正交
（数据缺席 = 不渲染，容器窄 = 渲染但 CSS 隐藏）。**2026-10-19 微标签形态后两级
阈值按实测宽度重调（优先级次序不变），组件测试钉住新阈值。**

### 面板明细与实时动态显示口径（2026-10-18 增补，2026-10-19 修订）

明细行原属各胶囊 tooltip，2026-10-19 起全部迁入统一面板对应分组（行内容与
i18n key 不变）：

- 会话分组补缓存读/缓存写明细行（`cumulative.cacheReadTokens/cacheWriteTokens`
  已在权威面）。
- 今日分组补「主要模型」行（`AppUsageSnapshot.summary.favoriteModel.modelId`，
  null → 占位；`useTodayUsageTotals` 顺带暴露，不新增取数）。今日合计刷新时机
  维持：挂载 + phase running→非 running 转换 + 窗口聚焦，无高频轮询。
- 工具分组：各工具行超 8 个补「+N 更多」行；聚合面全会话 `lastErrorMessage`
  （行序最后一条错误消息，destructive 弱化行）。
- **值变更过渡**：胶囊值包 keyed span（key = 值字符串），真实事实变更触发重挂载
  → 160ms 淡入（styles.css 动画，双闸齐全：`prefers-reduced-motion` 基线 +
  `[data-acode-reduce-motion="reduce"]` 应用内覆盖；值未变不重挂载、不重放动画；
  重挂载发生在固定 min-w 槽位内，不改变条几何——见「布局稳定规则」）。
- **进行中显示（2026-10-19 改写，替代原相位指示红线）**：
  `snapshot.control.phase === "running"` 时——
  - 速度胶囊：有 `usage.inFlight.partialOutputTokens` 事实 → 显示进行中 tok/s
    （口径 4 进行中值）+ 脉冲点；无 inFlight 事实（provider 无中途 usage）→
    显示「生成中 + 已耗时秒表」+ 脉冲点，绝不显示假速率。
  - 本轮胶囊：显示 `inFlight.turnToDate*` live 累计（胶囊值加「进行中」微标或
    脉冲点标记，面板行文案明示），TurnComplete 被权威 stats 定格替换。
  - 上下文环：`inFlight.announcedInputTokens`（Anthropic `message_start` 真值）
    到达即更新水位，请求开始就跳到实际输入量，不再等请求结束（权威
    `contextWindow.usedTokens` 仍由 ModelComplete 写，两者同口径事实）。
  - 脉冲点 = 「有请求在跑」的请求边界事实（语义不变）；live 数字 = producer
    真实 in-flight 事实（新）；**UI 端仍然严禁无事实依据的估算与高频轮询**。

## In-flight 真实用量事实面（2026-10-19 新增）

原口径 4 红线的前提「无 per-chunk token 事实」**已不成立**：adapters 的 raw 通道
今天就在接收 provider 原始 SSE 事件（`runner-stream.ts` 已显式处理 Anthropic
`message_start`/`content_block_delta`/`message_delta`，现仅用于 compact 重试边界，
注释明写「raw chunk 不会上送 Core/UI」——usage 事实被看见但丢弃）。本节把这条
事实面接通，全链 additive、事件驱动、单点节流：

**链路（所有权不变：producer 单点计算 → 投影唯一写入 → UI 只消费）**：

```
Provider SSE（Anthropic）
  message_start{usage.input_tokens}        ← 请求开始即有输入真值
  message_delta{usage.output_tokens 累计}   ← 流中输出真值（频率按 provider，见能力矩阵）
        │
        ▼ adapters runner-stream raw 通道【新增】usage 事实提取
          单点节流 ≥500ms/请求（首事实立即发；请求结束不发尾包——权威值走 finish）
        ▼ ModelStreamEvent 新变体 usage_progress（contracts）
          { announcedInputTokens?, partialOutputTokens?, requestStartedAtMs, observedAtMs }
        ▼ core turn-model-step：仅 main_turn 转 ModelStreamingPayload.usageProgress
          （additive optional；sidecar/compact/title 旁路不带——与 servedModel 同纪律）
          经既有 streaming 事件队列持久化/下发，零新增事件通道
        ▼ bootstrap product-projection（inFlight 唯一写入方）
          onModelStreaming.usageProgress → state.updated { usage: {…既有键带回, inFlight} }
          inFlight = { startedAtMs, observedAtMs, announcedInputTokens?, partialOutputTokens?,
                       firstTokenAtMs?, turnToDateInputTokens?, turnToDateOutputTokens? }
          turnToDate* = 既有 TurnUsageAccumulator 当前值 + partial（投影自持累加器，
          天然单点）；firstTokenAtMs = 投影观测本请求首个流式 delta 时刻
        ▼ v4-gateway 30ms coalesce flush（既有，零改动）→ UI store → bar/面板
```

**清除点（inFlight 是瞬时 conflated 状态，绝不过夜）**：ModelComplete（写权威
lastRequest/cumulative 同时 `inFlight: null`）、TurnComplete（stats 定格同时清）、
TurnError、apiRetry/相位复位路径。usage 补丁是整键替换语义，写 inFlight 时必须
显式带回 contextWindow/cumulative/lastRequest 既有值（同 lastRequest 旁路带回
先例，`product-projection.ts:4768` 注释纪律）。

**能力矩阵（如实降级，绝不造数）**：

| Provider | 流中事实 | 降级形态 |
| --- | --- | --- |
| Anthropic（@ai-sdk/anthropic raw） | message_start 输入真值；message_delta 累计输出（中途频率以 E2E 探针实测为准，记入本节附表） | 若实测仅末尾一次 message_delta：输出 live 值退化为请求末跳变，输入跳变与秒表仍实时 |
| OpenAI 系（include_usage 仅末 chunk） | 无 | 秒表 + 脉冲点，速度位不显示数字 |
| Gateway/openai-compatible | 随上游 | 同上按有无事实自动降级 |

**红线改写**：原「严禁流式中途自算 tok/s、严禁高频轮询」改写为——严禁 UI 端
无事实依据的估算（字符数折算、定时器外推速率）；严禁轮询；producer 以 ≥500ms
节流下发**真实** provider 事实。in-flight 事实**不进** SQLite usage 账本
（30 天权威账本仍以 finish chunk 为准，避免瞬时值污染对账）；随既有
ModelStreaming 事件的持久化/保留策略走，不新增保留类别。

**重连/重放语义**：inFlight 为 conflated 状态，snapshot 重发携带最后值；phase
非 running 时投影保证已清 null，恢复端不会看到幽灵「进行中」。desktop
continuous 与 web replayable 两链路语义一致（同一投影写入方）。

## 协议与事件面（全部 additive optional，遵守 snapshot.ts 冻结规则）

1. `packages/shared/src/acode-protocol-v4/snapshot.ts`：
   - `sessionUsageStateSchema.cumulative` += `reasoningTokens`（optional）；
   - `sessionUsageStateSchema` += `lastRequest: { outputTokens, generationMs, timeToFirstTokenMs?, completedAtMs } | null`（optional；conflated 状态语义 = 最近一次模型请求，值未变不重复下发）。
2. `packages/shared/src/acode-protocol-v4/rows.ts`：`turnHeaderRowSchema` +=
   `stats: { inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, timeToFirstTokenMs?, generationMs?, modelRequestCount } | null`（optional，TurnComplete 时由投影写入；null=纯问答无模型事实）。
3. `RunningSubagentSummary`（snapshot.ts）+= `cumulativeTokens`（optional）。
4. `apps/acode-cli/packages/contracts/src/events/session.events.ts`：`ModelCompletePayload` +=
   `generationMs?` / `timeToFirstTokenMs?`（optional；发射点 `core/src/runtime/methods/turn-model-step.ts` 从 usage-observability 既有事实顺带写入）。
5. `autoCompactThresholdTokens` 补真值：字段已在 schema（snapshot.ts:185）但投影恒
   null——`bootstrap/src/acode-protocol-v4/product-projection.ts` 的 seedUsage/onModelSelected
   从 `core/src/compact/policy.ts` 的阈值事实填入。**单一所有者 = bootstrap 投影**；
   core 只暴露纯函数阈值计算，不写协议。

### 多模型轮标记与每轮缓存未命中（2026-10-18 增补，UX 波 D5）

omp served-model marker / cache-invalidation marker 的对应物，全部 additive
optional，链路 = 发射点 → 累加器 → turnHeader.stats → 速率行：

6. `contracts/src/events/session.events.ts`：`ModelCompletePayload` +=
   `servedModel?: { providerId, modelId }`——**只 main_turn 发射点写入**
   （turn-model-step.ts 的 `executionModelSelection`），sidecar/compact/title
   旁路与旧事件缺席不造假值（与 generationMs 同纪律）。
7. `bootstrap/src/acode-protocol-v4/product-projection-usage.ts`：
   `TurnUsageAccumulator` += `servedModels`（"provider/model" 去重、请求序、
   上限 4）与缓存未命中快照对（`cacheMissBaseline`/`cacheMissLast`）——
   **missCauses 是进程内累计快照，求和会跨请求重复计数**（评分自审抓出），
   每轮值 = 轮末快照 − 轮起基线（投影会话级 `lastTurnCacheMissTotal` 种子，
   flush 时前推；无快照轮基线不动）；`buildTurnHeaderStats` flush 为
   `servedModels?` / `promptCacheMisses?`（0/空 = 缺席不投影）。
8. `packages/shared/src/acode-protocol-v4/rows.ts`：`turnHeaderStatsSchema` +=
   `servedModels: string[](≤4×256)` 与 `promptCacheMisses: int≥0`（optional）。
9. UI（packages/ui）：`deriveTurnRateLine` 透出两事实；速率行在
   `servedModels.length ≥ 2` 时追加「多模型轮」chip（title=模型链），tooltip
   恒列服务模型链（≥1 时）与缓存未命中行（>0 时）。单模型轮不加 chip——
   正常轮零噪音，晋升轮（overflow→model promotion track 的用户可见面）才标记。
   i18n：`chat.usageStatusbar.rateLine.{multiModel,servedModels,cacheMisses}`。

10. `packages/shared/src/acode-protocol-v4/snapshot.ts`（2026-10-19）：
    `sessionUsageStateSchema` += `inFlight: sessionUsageInFlightSchema.nullable().optional()`；
    `sessionUsageInFlightSchema = z.object({ startedAtMs, observedAtMs,
    announcedInputTokens?, partialOutputTokens?, firstTokenAtMs?,
    turnToDateInputTokens?, turnToDateOutputTokens? })`（int ≥0；conflated 状态
    语义，值未变不重复下发；null = 无进行中请求）。
11. `apps/acode-cli/packages/contracts`（2026-10-19）：`ModelStreamEvent` union +=
    `usage_progress` 变体 `{ announcedInputTokens?, partialOutputTokens?,
    requestStartedAtMs, observedAtMs }`（adapters 发射，≥500ms 节流）；
    `ModelStreamingPayload` += `usageProgress?`（同形 additive optional；core 仅
    main_turn 中转）。类型落点与命名以 contracts 现有惯例为准（session.events.ts
    已有 max-file-lines waiver 至 2026-12-31，新 payload 可入该文件或按拆分纪律
    新叶子文件，实施时二选一并保持 index 重导出完整）。
12. UI live 消费（2026-10-19）：速度/本轮/上下文环的 running 态读 `usage.inFlight`
    （见「面板明细与实时动态显示口径」节）；`useTodayUsageTotals` 取数不变。

补注（D5）：cacheMiss 归因明细（missCauses 分维度）继续留在 DeveloperToolsPane
调试面；聊天阅读面只投影每轮总数。

不改动：`usage.delta` 遥测事实（保持最小面）、legacy task 流（旧 UI 广播兼容不动）、
`v4/usage/stats` 与 `v4/conversation/usage`（现成，直接消费）。

## /usage 命令族（零 token 本地执行）

- 参数面（合并原 /usage 与 token_usage 工具 scope）：
  `/usage`（默认 today）、`today`、`week`、`days:N`、`sessions[:N]`、`models[:N]`（按天模型细分）、
  `workspace:关键词`、`session:ID前缀`、`current`。
- **工具面裁决**：不新增模型侧 token_usage 工具——tools schema 是每请求常驻 token 成本
  （tools_schema_token_metric 纪律），查询本质是用户面；全部 scope 由命令参数覆盖。
  模型侧工具登记为后续候选。
- 单一实现：core 侧新模块 `apps/acode-cli/packages/core/src/usage-query/`（参数解析 +
  纯文本报表渲染，随 locale；数据源 `UsageStorePort` 的 `queryAppUsage`/`queryTaskUsage`
  注入）。cli command-center 与 bootstrap `v4/command` handler 均为薄宿主接线复用同一
  模块（依赖方向 cli/bootstrap→core；bootstrap 不得 import cli）。
- 宿主接线两处（编排者独占）：TUI/CLI = `acode-slash-command-help.ts` entry +
  `parseSlashCommand` 分支 + `command-center/create.ts` 拦截执行；desktop =
  `v4/command` handler（bootstrap `acode-protocol-v4/commands/handlers/` 新 leaf）
  调同一 usage-query 模块。桌面命令面板经 `v4/commands/query` 自动收录。
- `current` 操作口径（实现裁决）：port 面无按请求时间戳的枚举查询，用既有查询组合
  近似——会话 `time.updated ≥ now−30min` 且 `queryTaskUsage.modelRequestCount > 0`；
  报表脚注如实标注近似性。`sessions[:N]` = 最近更新的 N 个根会话（子会话并入不占
  名额）；`models[:N]` 的 N = 天数（默认 7）。
- `workspace:` 查询按父子关系合并子代理消耗避免重复计算（匹配 directory/path/
  workspaceID 身份字段，父命中承载整棵子树）；会话迁移 workspace 后
  历史归属随之变化（如实呈现，不做二次归属修正）。

## TUI 面

TUI 不建状态栏（无对应 UI 面）；/usage 命令天然可用；既有
`responseReceivedWithTokens` 状态文案不动。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| generationMs/TTFT 口径计算 | core `usage-observability.ts`（producer 单点） |
| ModelComplete timing 字段发射 | core `turn-model-step.ts` |
| raw SSE usage 事实提取 + ≥500ms 节流 | adapters `runner-stream.ts` raw 通道（producer 单点，2026-10-19） |
| usageProgress 中转（仅 main_turn） | core `turn-model-step.ts`（2026-10-19） |
| lastRequest/cumulative.reasoning/threshold/turnHeader.stats/subagent tokens/inFlight 写入与清除 | bootstrap `product-projection.ts`（唯一写入方） |
| 状态栏显隐/速率行开关 | ui localStorage slice（跨窗广播防回环） |
| 今日合计 | usageStatsService（local/remote 各 workspace 独立实例） |
| /usage 解析与报表 | core `usage-query/`（cli command-center 与 bootstrap v4 handler 薄宿主复用） |
| 命令注册表/help 文案/locales/store index/Composer 挂载点 | 编排者独占接线 |

## 验收场景

1. shared：新 additive 字段 schema 单测——旧快照（无新字段）解析兼容、新字段 strict 校验。
2. core：generationMs 口径单测——含思考（reasoning>0）从请求起算、非思考从首字起算、
   无首字时间戳回退请求起算、工具等待不计。
3. bootstrap：投影单测——onModelComplete 写 lastRequest/cumulative.reasoning；
   TurnComplete 写 turnHeader.stats（纯问答轮 = null）；threshold 真值；subagent tokens。
4. cli：usage-query 参数解析全 scope 单测 + 报表渲染快照 + 命令零 token 拦截
   （不进模型提交路径）。
5. ui：状态栏组件测试——逐项显隐持久化、hide-on-absent（无会话快照胶囊隐藏只留
   齿轮、零值照常显示、绝不回退）、速率行开关与「不显示上一问统计」、今日合计
   不跨 workspace 混算、窄屏容器查询分级隐藏优先级、值过渡动画双闸、微标签渲染、
   布局稳定（固定 key/min-w 槽位/脉冲点常驻槽位的源码契约）、统一面板分组与
   受控 open 语义（替换原 tooltipStability 契约测试）。
6. E2E（真实模型 dev 会话）：状态栏数字与 SQLite 账本一致（today/会话累计/tok/s
   手工核算）；/usage today 与设置页 App Usage 同日数字一致；子代理派发后展开面板
   显示 agentId 关联用量。
7. 运行时复现（2026-10-19，hover 修复验收门）：真实流式 + CDP 自动化——修复前
   录到「悬停胶囊明细闪断消失」；修复后同场景（指针悬停 bar 不动 + 持续流式含
   工具 tick 与 presence 翻转）统一面板全程常驻。推断级根因不得作为交付依据。
8. inFlight 链路测试：adapters 节流单测（首事实立即发、间隔 ≥500ms、finish 不发
   尾包）；core 中转纪律（仅 main_turn 带 usageProgress）；投影单测（usageProgress
   写 inFlight 且带回既有 usage 键、ModelComplete/TurnComplete/TurnError 清除、
   turnToDate = 累加器 + partial）；shared schema 兼容单测（旧快照无 inFlight
   解析正常、新字段 strict 校验）。
9. 能力降级测试：无 inFlight 事实 → 速度位显示秒表 + 脉冲点、组件断言零假数字
   （无 tok/s 渲染路径）；本轮胶囊无 live 事实时维持上一轮权威值 + 不标「进行中」。
10. live-权威对账（E2E）：真实 Anthropic 流式结束后 inFlight 清空、权威
    lastRequest/turnHeader.stats 替换进行中值；message_delta 中途频率探针实测
    结果记入「In-flight 真实用量事实面」能力矩阵附表。

## 边界与登记项（不随本轮）

- 跨服务器「今日合计」聚合（远端历史会话本客户端未观测过的部分）——随
  acode-server-cli 演进评估；本轮远端 = 当前 workspace 的远端同源查询。
- 模型侧 token_usage 工具（见上裁决）。
- 上下文容量手动窗口覆盖（ACode 窗口来自模型配置权威面，无自动识别失败场景）。
