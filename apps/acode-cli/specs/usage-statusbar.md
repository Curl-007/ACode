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

## 2026-10-19 重设计波还原记录（用户裁决）

重设计波（统一明细面板 + 微标签 + inFlight 实时事实面，曾合 dev @a28a0cbb）经用户
实机查看否决并**整波还原**（`revert -m 1` → 3eba326d，合 dev @ca2c6778）：统一面板
过长遮满聊天区、恢复会话上大片零值/缺请求数分组并列，观感不合格。inFlight 数据链
与统一面板形态**不得再推**；如复活须先过小屏实机观感门。状态栏形态回到 v1.0.1
发布版（六胶囊 + 独立 tooltip + 事件驱动值）；流式 hover 闪断缺陷按「Tooltip
稳定性」节最小修复。分析、裁决记录与根因录证留存记忆与
`~/.acode/cli/scratch/e2e-usage-statusbar-redesign/`。

## 数据口径（唯一事实定义，producer 单点计算）

1. **总用量** = input + output。cache_read 已含于 input（AI SDK v6 Anthropic 口径，
   见 `contracts/src/model/index.ts` getModelUsageContextTokens 注释），不重复相加。
2. **缓存命中率** = cacheReadTokens ÷ inputTokens（input 为 0 时不显示）。
3. **生成耗时 generationMs**（每请求）：含思考的请求（reasoningTokens > 0）或无首字
   时间戳的请求 = completedAt − startedAt（思考 token 在首字前流出）；否则 =
   completedAt − firstTokenAt。段间工具等待天然不计（每模型步一条事实）。
   **producer = core `runtime/methods/usage-observability.ts`**（事实已采集：
   durationMs/timeToFirstTokenMs/firstTokenAt 均持久化），随 ModelComplete 事件带出。
4. **生成速度 tok/s** = 该请求 outputTokens（含思考）÷ generationMs。事件驱动：
   每完成一次模型请求更新一次，非流式实时值。
5. **上下文占比** = 最近 completed 请求的 usedTokens ÷ maxTokens（压缩后自然回落，
   非峰值）——既有 `snapshot.usage.contextWindow` 语义，不改。
6. **轮数** = count(distinct turn)；**请求数** = 模型请求计数累计。
7. **TTFT** = timeToFirstTokenMs（已持久化于 model_usage/turn_usage）。
8. **"当前会话"两种口径严格区分**：状态栏 = 本窗口焦点会话（见下），/usage `current`
   = 最近 30 分钟内有请求的会话；帮助文案明示两者不保证等同。

## 状态栏（packages/ui，挂 v4 ConversationComposer 工具栏下方）

新目录 `packages/ui/src/v4/usage-statusbar/`（每文件 ≤400 行），条状胶囊布局，
逐项可显隐。八项在 ACode 的形态裁决：

| 项 | 形态 | 数据源 |
| --- | --- | --- |
| 生成速度 | 最近一次模型请求 tok/s；颜色表快慢档；悬停展示口径 | `snapshot.usage.lastRequest`（新增，见协议面） |
| 上下文容量 | **不重复建**——由既有 composer 上下文环（ChatContextUsage）承载并增强：接近 auto-compact 阈值分档变色 + 上下文被拒时悬停给处置建议（compact/新会话）；状态栏不设独立上下文项 | `snapshot.usage.contextWindow`（autoCompactThresholdTokens 补真值，见协议面） |
| 本轮用量 | 最近完成 turn 的 tokens + 缓存命中率 + TTFT；悬停输入/输出/缓存读/缓存写/思考明细 | `turnHeader.stats`（新增） |
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

### Tooltip 稳定性（2026-10-19 最小修复重写：自管 hover 生命周期 + 布局稳定）

**症状**：对话流式输出/思考进行中，悬停胶囊的明细 tooltip 只闪一下即消失，指针
不动不再回来，流式结束才恢复常驻。

**真根因（运行时录证确证，取代原 grace area 推断）**：流式期间胶囊几何突变——
值 tick 变宽、脉冲点插拔、hide-on-absent presence 翻转整胶囊插入（首个请求完成
时一次推移约 70px）、composer 高度变化把整条 bar 纵向推移——把 trigger 从
**静止指针**底下推走，浏览器布局后重算命中补发 `pointerleave` → Radix 关闭；而
`@radix-ui/react-tooltip@1.2.8` 重开只认 trigger `pointermove`
（`hasPointerMoveOpenedRef` 门），静止指针永不重开。原 `disableHoverableContent`
局部 Provider 消除的是 grace area 路径，与本机制无关，故无效。证据：
scratch/e2e-usage-statusbar-redesign/ proof-run2.jsonl（左邻加宽 +60px → 关闭、
1px 微动重开）与 repro-streaming-run2.jsonl（真实流式 +18.6s 静止关闭、多次位移
34s 不重开）。

**修复 1：自管 hover 生命周期（胶囊明细改受控 Popover，弃 Radix Tooltip）**：

- 明细浮层 = `Popover`（PopoverAnchor = 胶囊 body，PopoverContent 镜像
  TooltipContent 样式并加 `pointer-events-none`，`side="top"`），open 由
  `UsageStatusbar` 父组件单一状态 `hoveredCapsuleId` 驱动（单开天然）。
- **开** = 胶囊 `pointerenter`——布局位移把新胶囊推到静止指针下时浏览器边界事件
  同样触发 pointerenter，位移后自然接续。
- **关** 仅两条路径：① 打开期间 window 级 `mousemove` 对整条 bar **当前 rect** 命中
  测试落在外面（真实指针移走；rect 每次现取，几何推移天然免疫）；② Popover
  `onOpenChange(false)`（Escape/外部点击）。**布局位移补发的 pointerleave/
  pointerenter 边界事件一律不作关闭依据**（胶囊不挂 onPointerLeave）——二轮录证
  （post-hoverfix-run1.jsonl +5.9s）实证首版「pointerleave + relatedTarget 在 bar
  外」判定仍会被 composer 高度变化把整条 bar 纵向推离静止指针误杀一次。**指针
  静止 = 无 mousemove = 不触发任何关闭路径 = 明细常驻**（核心不变量；浮层随胶囊
  新位置同帧重定位）。
- 位移落到邻居胶囊：邻居 pointerenter 切换 `hoveredCapsuleId`，旧明细同帧关闭。
- 子代理胶囊的 hover Tooltip 退役：其口径说明移入点击面板头部（i18n key
  `chat.usageStatusbar.subagents.tooltip` 不变）；点击 Popover 面板不变。
- 原局部 `TooltipProvider disableHoverableContent` 随 Radix Tooltip 一并移除。

**修复 2：布局稳定三规则（降低位移频率，独立收益）**：

1. 每胶囊稳定 `key` = 项 id（条件渲染不依赖数组位置）。
2. 每胶囊固定 `min-w` 槽位按**典型值紧档**预留（2026-10-19 二轮调紧：首档过宽
   造成条内大片留白；`tabular-nums` 既有，常见 tick 槽内不推挤邻居）。瞬态超槽
   变宽（工具「N · M 运行中」后缀、秒表档）允许一次性变宽——hover 生命周期已
   位置化，位移不再杀悬停，只余轻微视觉抖动。
3. 脉冲点改**图标右上角标绝对定位**（固定尺寸 span 恒渲染、`opacity` 切换显隐、
   零布局占用、不插拔；二轮调紧自「流内常驻槽」改为角标，消除 icon 与值之间的
   隐形间隙）。「Tooltip 增强」节相位指示语义不变，仅载体改角标。

**不接受的对症方案**（沿用原节纪律）：流式期间禁用浮层、pointer 事件防抖、
setTimeout 重开等掩盖性补丁。

**验收**：修复前证据 = 上述录证（代码同态）；修复后同脚本同场景复跑
（`hover-repro.mjs --panel-selector '[data-testid="usage-statusbar-tooltip"]'`）
全程 0 关闭；契约测试钉住两条关闭路径与静止不变量。

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
（数据缺席 = 不渲染，容器窄 = 渲染但 CSS 隐藏）。

### Tooltip 增强与实时动态显示口径（2026-10-18 增补）

- 会话累计 tooltip 补缓存读/缓存写明细行（`cumulative.cacheReadTokens/cacheWriteTokens`
  已在权威面，此前未消费）。
- 今日合计 tooltip 补「主要模型」行（`AppUsageSnapshot.summary.favoriteModel.modelId`，
  null → 占位；`useTodayUsageTotals` 顺带暴露，不新增取数）。
- 工具调用 tooltip：各工具行超 8 个补「+N 更多」行（不在 tooltip 内无限铺开）；
  聚合面新增全会话 `lastErrorMessage`（行序最后一条错误消息，destructive 弱化行）。
- **值变更过渡**：胶囊值包 keyed span（key = 值字符串），真实事实变更触发重挂载
  → 160ms 淡入（styles.css 新动画，双闸齐全：`prefers-reduced-motion` 基线 +
  `[data-acode-reduce-motion="reduce"]` 应用内覆盖；值未变不重挂载、不重放动画）。
- **相位指示**：`snapshot.control.phase === "running"` 时生成速度胶囊值前显示脉冲
  状态点（`animate-pulse` 先例同子代理面板，`motion-reduce:animate-none`）。
  **2026-10-19 最小修复**：脉冲点载体改**图标右上角标**（固定尺寸 span 绝对定位
  恒渲染、opacity 切换、零布局占用），消除插拔与流内占位造成的宽度突变/隐形间隙
  （「Tooltip 稳定性」节修复 2.3）。
  **口径红线不变**：状态点只表达「有请求在跑」这一请求边界事实，不伪造实时速率；
  速度值与 tooltip 仍是「每完成一次模型请求更新」的事件驱动事实——**严禁**流式
  中途自算 tok/s，**严禁**高频轮询（无 per-chunk token 事实，spec 口径 4）。

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
| lastRequest/cumulative.reasoning/threshold/turnHeader.stats/subagent tokens 写入 | bootstrap `product-projection.ts`（唯一写入方） |
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
   不跨 workspace 混算、窄屏容器查询分级隐藏优先级、值过渡动画双闸。
6. E2E（真实模型 dev 会话）：状态栏数字与 SQLite 账本一致（today/会话累计/tok/s
   手工核算）；/usage today 与设置页 App Usage 同日数字一致；子代理派发后展开面板
   显示 agentId 关联用量。

## 边界与登记项（不随本轮）

- 跨服务器「今日合计」聚合（远端历史会话本客户端未观测过的部分）——随
  acode-server-cli 演进评估；本轮远端 = 当前 workspace 的远端同源查询。
- 模型侧 token_usage 工具（见上裁决）。
- 上下文容量手动窗口覆盖（ACode 窗口来自模型配置权威面，无自动识别失败场景）。
