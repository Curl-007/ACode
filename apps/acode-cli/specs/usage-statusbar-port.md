# 用量状态栏完整移植规格（ACode）

> 状态：定稿待实施（2026-10-20）
> 源参考（只读）：`D:\Leo1\project\demo\anker-code`，`master` @ `2bf8d04d`
> 目标仓库：`D:\AnkerCodes\QYDemo\ACode1`，`dev/1.0.1` @ `38b93920`
> 目标：把源仓库七段式「输入框下方用量状态栏 + 回答末尾速率行」完整移植到目标，补齐
> `composerTurnMetrics` / `sessionToolStats` / 今日分项数据面，下线目标旧十二文件状态栏。
> 本文只写规格，不修改代码。

---

## 0. 结论速览

| 需求 | 裁决 | 章节 |
| --- | --- | --- |
| R1 七段信息与行为 | 生成速度 / 本轮用量 / 上下文容量 / 会话累计 / 工具调用 / 今日合计 / 子智能体；回答末尾速率行独立 | §2 |
| R2 数据面 | 新增 `composerTurnMetrics`、`sessionToolStats`、今日分项、testid；设置沿用目标现有 localStorage 切片并扩键 | §3 |
| R3 字段映射 | 复用 `usage.cumulative`/`contextWindow`/`lastRequest`/`subagents`/`turnHeader.stats`；新增两个快照状态键 | §4 |
| R4 UI 落点 | 新目录 `packages/ui/src/v4/composer/usage-bar/`；目标旧 `v4/usage-statusbar/` 12 文件全部下线 | §5 |
| R5 布局与 hover | 保留目标 320af845/36c28d65 的 hover 生命周期与布局稳定规则；采用源的折叠顺序/断点；禁止复现被回退的重设计 | §6 |
| R6 i18n/设置 | 沿用 `chat.usageStatusbar.*` 命名空间；设置切片加总开关与上下文项；总开关关闭隐藏状态栏与速率行 | §7 |
| R7 测试 | 包级测试 + 直接 node 命令 + 18 个验收场景 | §8 |
| R8 版本/发布 | 纯 UI + additive 协议，不需要版本/发布登记变更 | §9 |

**基线核实**

- 目标现有状态栏是 v1.0.1 六胶囊实现（12 文件，1698 行），读 `snapshot.usage.lastRequest` + `turnHeader.stats` + `rows` 聚合；没有 `composerTurnMetrics` / `sessionToolStats` / 上下文段 / 今日分项 / 错误徽标 / 段峰 / 每工具明细。
- 目标 `usage-stats.ts:199` 的 `appUsageHeatmapCellSchema` 只有 `date/level/totalTokens/turnCount/toolCallCount`；适配器按日 SQL 也只查这三项。
- 目标设置是 localStorage 切片（`packages/ui/src/lib/usageStatusbarPreferences.ts` + `store/usageStatusbarPreferencesState.ts`），不是 `AppSettings.composerUsageBar`；目标不存在 `composerTurnMetricsVisible`。
- 目标无 `useLiveOutputRate` / `liveOutputRateRegistry` / `useChildSessionTokenStats` / `sessionTokenStats` / `useTodayAppUsage` / `contextUsageCost` / `turnMetrics`；这些是本次要补的 helper。
- 目标在 `320af845`（流式 hover 闪断最小修复）与 `36c28d65`（布局调紧）中固化了 hover 生命周期与布局稳定规则；`3eba326d` 已整波回退 `72cec546` 的「微标签 + 统一明细面板 + inFlight 实时事实面」重设计。**本次不得复现该重设计**。

---

## 1. 术语与数据口径

| 术语 | 含义 |
| --- | --- |
| 段（segment） | 状态栏上的一个信息单元；七段固定顺序 |
| 明细（detail） | 悬停/点按某段弹出的键值行浮层 |
| 本轮 | 当前 product turn；`composerTurnMetrics` 随新轮清空 |
| 加权实测速度 | 本轮主回合请求 Σ输出 tokens ÷ Σ解码耗时 |
| 实时估算速度 | Renderer 按可见输出字符 ÷ 3 折算、2.5s 滑窗、1.5s 无新样本作废；不落盘 |
| 今日合计 | 本地用量库 heatmap 当天的单元格；按请求时区取日 |
| 子智能体段 | 只反映正在运行的子代理/workflow actor；已结束只在面板里 |

**口径红线**

1. 总用量 = input + output；cache_read 已含于 input，不重复相加。
2. 缓存命中率 = cacheRead ÷ input；input 为 0 / 未上报 → 不显示该行。
3. 加权实测速度只统计 `querySource = main_turn` 且首内容到请求结束计时完整的请求；标题/压缩/目标校验/子代理请求不进入。
4. `segment/peak` 的「段」= 模型请求次数；「峰」= 单次请求解码窗内速率最大值。工具等待不计入任何一段。
5. 子智能体段值只算正在运行的任务；已结束任务的用量不进入段值。
6. 今日「请求」来自本地 `model_usage` 行数，含旁路请求；会话段/本轮段的「模型请求数」只计主回合。两处口径不同是数据源事实，不在状态栏强行对齐。
7. 缺值隐藏：没有可信数字就整段/整行不渲染；不显示 0、不显示「—」、不给骨架。零值 ≠ 缺席。

---

## 2. R1 七段信息与交互

### 2.1 七段顺序与内容

| # | 段 id | 段值 | 明细行（缺项省略） | 语气/特殊形态 |
| --- | --- | --- | --- | --- |
| 1 | `speed` 生成速度 | 流式中：`≈<实时估算> tok/s`；收口后：加权实测 tok/s | 首 token / 输出 tokens / 已完成请求 / 口径说明 | 流式 `live` 绿；收口后 `success`（≥70）/`warning`（40–70）/`error`（<40） |
| 2 | `turnUsage` 本轮用量 | 输入 + 输出（旧 CLI 缺 `inputTokens` 整段隐藏） | 输入 / 输出 / 思考 / 缓存读 / 缓存写 / 缓存命中率 / 首字耗时 / 模型请求数 / 段·峰 | `default`；无实时估算时隐藏整段 |
| 3 | `context` 上下文容量 | 百分比 + 16×16 环形（stroke 3、pathLength 100、12 点起） | 已用/窗口 / 自动压缩阈值（含百分比）/ 距阈值（还剩/超出）/ 缓存命中率 / 超限处置建议 | `default`；≥阈值 `warning`；≥窗口 `error` + `motion-safe:animate-pulse`；`maxTokens` 缺失整段不渲染 |
| 4 | `session` 会话累计 | 主会话 + 子会话累计；有读不到的子会话时前置 `≥` | 输入 / 输出 / 思考 / 缓存命中率 / 轮数 / 模型请求数 / 工具·重试 / 代码增删（含文件数）/ 子代理 / 预估费用 | `default`；数字保持 0 也显示 |
| 5 | `tools` 工具调用 | 调用次数 + 错误徽标（0 错误不渲染徽标） | 调用数 / 每工具明细（名称·次数·累计耗时·错误徽标，按次数降序、同次数名称升序，最多 12 行）/ 失败数 | 有错误 `error`；被拒绝/取消不计入 errors；子代理内部工具不计入 |
| 6 | `today` 今日合计 | 当天 totalTokens | 轮数 / 工具调用 / 输入 / 输出 / 缓存命中 / 请求（+ 目标既有「主要模型」可选行） | `default`；查询失败/无当天 cell 整段隐藏 |
| 7 | `subagents` 子智能体 | 运行中数量 · 运行中 tokens · 运行中速率（各自缺失省略，中间 `·`）；无运行中但有子代理时只显示累计 tokens；无子代理不渲染 | 主代理合计 / 运行中分组 / 已结束分组 / 当前输出 / 子代理速率 | 有运行中时 `live` + 运行点；面板固定浮层 |

**回答末尾速率行**（独立于七段）：只在该轮已收口时渲染；段顺序 = 速率 → 首 token → 输出 → 段/峰 → 耗时；缺项省略；本轮结束时速率与状态栏逐位相等。保留目标既有 `servedModels` 多模型徽标（≥2 个服务模型时显示），它不属于被回退的重设计。

### 2.2 悬停、点按与明细互斥

- 悬停或点按段打开明细；点按 = 钉住，鼠标移开仍保留；再次点按 / 点浮层外 / Esc 关闭。
- 同一时刻只允许一个明细展开（含钉住的）：打开下一段会关闭上一段并清掉其钉住状态。实现用单一 `hoveredSegmentId` 状态即可，不得出现两个浮层同屏。
- **指针静止 = 明细常驻**：流式期间值 tick、脉冲点、段插入/消失、整条 bar 纵向推移补发的 `pointerleave`/`pointerenter` 不作关闭依据。开 = 段 `pointerenter`；关仅两条真实指针路径：① window `mousemove` 命中测试落在整条 bar 当前 rect 之外；② Popover 主动关闭（Esc/外部点击）。禁止 Radix Tooltip/HoverCard 的 hover 生命周期（见 R5）。
- 浮层锚在段上，不随鼠标移动；明细内容来自纯函数模型，不在组件里重算指标。

### 2.3 设置

- 齿轮弹层：七段子开关 + 「回答末尾速率行」开关；写入目标现有设置切片（见 R6）。齿轮**不放总开关**（总开关关闭后整条状态栏连齿轮一起消失，没有第二入口）。
- 设置页「用量状态栏」分组：分组标题行挂总开关；下面七段子开关 + 速率行开关。
- 总开关 `enabled` 关闭：状态栏整条不渲染、回答末尾速率行不渲染；子开关值保持原样、只记偏好，重新打开恢复。
- 总开关只看自己，不改写子开关；子开关也不改总开关。

### 2.4 窄宽折叠

- 容器查询命名容器 `@container/usagebar`；折叠顺序：
  1. 639px 起收：`context` → `today` → `turnUsage`；
  2. 479px 起收：`subagents` → `tools`；
  3. `speed`、`session`、齿轮永不收起。
- 「+N」浮层按档位只数当前宽度**真的被收起**的段：480–639px 只数列宽档三段，<480px 数列宽档 + 窄档。不得把仍在栏上的段算进 N。
- 旧目标的 520/420 断点是为六胶囊调的值，本次由源 639/479 取代（见 R5）。

### 2.5 子智能体面板

- 点按子智能体段打开**固定浮层**（锚在段上，不随鼠标走）；点按钉住，再点 / 点外部 / Esc 关闭。
- 行结构：状态点 + 任务名 + 状态文案 + 该任务自己的输出速度（有实时样本才显示，绿）+ 该任务累计 tokens；最后单列主会话合计。
- 任务名与「子智能体目录」同源：运行中取 `snapshot.subagents.running[].title`；已结束取 `listSessionSubagents` 同一条游标查询的 `ended.items[].title`。缺名退回 `subagentType`（内置名本地化），**只按 `childSessionId` 对应，禁止按数组下标错配**。
- 每任务速度按 `childSessionId` 从该子会话自己的 `LiveOutputRateRegistry` 采样取；没有样本整条省略（不写 0、不借合计/别的任务的值）。段值上的合计速率 = 这些任务速率之和。
- 已结束分组只在**点按钉住后**查询；悬停不发起查询。查询失败 / 加载中 / 确实为空三种提示分开，失败只收起已结束分组，不影响运行中分组。
- 状态栏只为正在运行的子会话（`subagents.running[]` + 非 queued/settled 的 workflow actor）建立订阅，最多 6 个；已结束子会话不订阅。已结束用量取运行期最后一次读到的缓存值；从未读到的计为未知，会话累计带 `≥`。
- 段值显示门槛按全部子会话数（`childSessionIds` + 已启动 actor）判断；无子代理整段不渲染。

---

## 3. R2 数据面与状态所有者

### 3.1 `composerTurnMetrics`

| 项 | 内容 |
| --- | --- |
| 目标落点 | `packages/shared/src/acode-protocol-v4/rows.ts` 新增 `turnMetricsSchema` / `composerTurnMetricsSchema`；`snapshot.ts` 新增 `composerTurnMetrics: ...nullable().default(null)`；`delta.ts` 新增 nullable optional；`projection-state.ts` 初始 `null` |
| 字段 | `metrics: { firstTokenMs, outputTokens, tokensPerSecond, inputTokens?, requestCount?, reasoningTokens?, cacheReadTokens?, cacheWriteTokens?, peakTokensPerSecond? }` + `streaming: boolean` |
| 写入方 | 目标 `ProductProjection` 唯一写入：`model_request_completed` 且 `querySource === "main_turn"` 时累加；新轮开始归零；轮收口 `streaming=false`（数字保留到下一轮） |
| 读取方 | 新 `usageBarModel` 的速度/本轮段；回答末尾速率行（同累加器） |
| 幂等 | 值未变不下发；`state.updated` 键级整体替换；加入投影候选 clone/adopt 的深拷贝字段 |
| 兼容 | 旧 CLI 不带 → `null`，UI 隐藏速度/本轮段；`usage.lastRequest` 仅作为旧 CLI 的实测速度回退，不作为新主路径 |

实现要点（对应目标文件）：

- `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/product-projection-usage.ts`：新增 `TurnMetricsAccumulator` 或复用 `TurnUsageAccumulator` 增加 `timeToFirstContentMs`/`decodeMs`/`peakTokensPerSecond`；`buildTurnMetrics(accumulator)` 返回源 `turnMetricsSchema` 形状。
- `product-projection.ts`：`onModelNetworkStatus` 的 `model_retry_scheduled` 分支加主回合重试计数；`model_request_completed` 分支调用 `accumulateTurnMetrics`；`onTurnStarted` 调 `resetTurnMetrics`；`onTurnComplete`/`onTurnError` 发布 `streaming=false`；`applyEventInternal` 候选 clone/adopt 增加累加器与已下发副本。
- `streaming` 必须由 CLI 写，不让 UI 从 `control.phase` 反推（UI 只额外用 phase 决定实时估算是否可采）。
- 计时窗：优先用 `durationMs - timeToFirstContentMs` 计算单请求 decodeMs；缺失时退回 `generationMs`；两者都缺失的请求不计入分母/峰值，但可计入输出总量。

### 3.2 `sessionToolStats`

| 项 | 内容 |
| --- | --- |
| 目标落点 | `packages/shared/src/acode-protocol-v4/snapshot.ts` 新增 `sessionToolStatsSchema`；`delta.ts` 新增键；`projection-state.ts` 初始为全零对象（不是 null） |
| 字段 | `calls, errors` + additive `turnCount?, requestCount?, reasoningTokens?, linesAdded?, linesDeleted?, fileCount?, retryCount?, tools?: { name, calls, errors, durationMs? }[]` |
| 写入方 | `ProductProjection` 唯一写入；null 只表示旧 CLI/冷恢复无数据 |
| 累加规则 | 工具行「非终态 → 终态」计一次；`success/error/cancelled` 都是终态；被拒绝/取消计入 calls、不计 errors；子代理内部工具行不在本会话快照，天然不计；每工具按 `toolName` 聚合，耗时取 `ToolCallResultPayload.duration` |
| 会话字段 | `turnCount` 在 product turn 开始 +1；`requestCount`/`reasoningTokens` 只在 main_turn 的 `model_request_completed` 累加；`retryCount` 只在 main_turn 的 `model_retry_scheduled` +1；`linesAdded/linesDeleted/fileCount` 按每轮 `turnHeader.fileChanges` 最新值求和 |
| 幂等 | 值未变不下发；`tools` 顺序固定「次数降序 → 名称升序」，便于等值判定 |
| 读取方 | 工具段、会话段、子代理面板；旧 CLI 无该键 → 工具段整段隐藏，会话段对应行隐藏 |

实现要点：

- 在 `product-projection.ts` 的 `applyEventInternal` 中、`attachRevision` 之后读已产出的 delta 累加（源 `product-projection.ts:1278` 同款），不额外扫 row 表。
- `clone`/`adopt` 增加 `sessionToolStats`、`lastEmittedSessionToolStats`、`toolTerminalCountedIds`、`fileChangesByTurnId` 深拷贝/赋值。
- `flushTurnHeaderStats` 仍是每轮 `turnHeader.stats` 的所有者；`sessionToolStats` 是会话累计，两者不可互相替代。

### 3.3 `turnHeader.stats` 扩展（回答末尾速率行）

目标已有 `turnHeaderStatsSchema`（`rows.ts:65`）与 `flushTurnHeaderStats`。本次只加两个 additive 字段：

- `tokensPerSecond?: number`：本轮加权实测速度（与 `composerTurnMetrics.metrics.tokensPerSecond` 同值）。
- `peakTokensPerSecond?: number`：单请求峰值。
- `modelRequestCount` 已存在，UI 映射为「段」；`timeToFirstTokenMs` 映射为首 token。
- 保留目标既有 `servedModels`/`promptCacheMisses`，不删除。

### 3.4 今日用量 additive 字段

| 层 | 目标落点 | 改动 |
| --- | --- | --- |
| shared schema | `packages/shared/src/usage-stats.ts:199` `appUsageHeatmapCellSchema` | 增加 optional `inputTokens? / outputTokens? / cacheHitRate? / requestCount?` |
| contracts | `apps/acode-cli/packages/contracts/src/interfaces/session-store.port.ts:1023` `AppUsageDayRow` | 增加 optional `inputTokens? / outputTokens? / cacheReadTokens? / modelRequestCount?` |
| adapters SQL | `apps/acode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts:476-530` | 按日查询补 `sum(input_tokens)` / `sum(output_tokens)` / `sum(cache_read_input_tokens)` / `count(*) as modelRequestCount`；合并进 `dayMap` |
| builder | `apps/acode-cli/packages/bootstrap/src/acode-protocol/usage-stats-builder.ts:104-180` | 新增 `dayBreakdownMap`，按 `inputTokens > 0 ? inputTokens : cacheReadTokens` 算命中率；heatmap cell 带出四个字段 |
| UI hook | `packages/ui/src/hooks/useTodayAppUsage.ts`（新） | 读当天 cell；旧 CLI 缺字段时对应明细行隐藏；轮收口后防抖 5s 刷新 + 窗口 focus 刷新，无轮询 |

状态所有者：adapters `queryAppUsage` 产出按日行；bootstrap `buildAppUsageSnapshot` 组装 heatmap；UI 只读 `AppUsageSnapshot`。不得在 UI 侧重算今日分项。

### 3.5 设置 schema 与 testid

- 设置：沿用目标 `packages/ui/src/lib/usageStatusbarPreferences.ts` 的 `UsageStatusbarPreferences` 作为唯一 schema/所有者（见 R6），不新增 `AppSettings.composerUsageBar` 第二所有者。
- testid：新增 `packages/shared/src/test-ids-composer-usage-bar.ts`，导出源 7 个常量（容器/段/齿轮/错误徽标/子代理面板/速率行/设置页开关组），从 `packages/shared/src/index.ts` 导出；组件使用共享常量，不再散落字符串字面量。旧 testid（`usage-statusbar`、`turn-rate-line`）随旧组件删除。

---

## 4. R3 源 snapshot/协议字段 → 目标字段映射

| 源字段/接口 | 目标字段/接口 | 处理 |
| --- | --- | --- |
| `snapshot.composerTurnMetrics`（`metrics + streaming`） | 新增同名 `snapshot.composerTurnMetrics` | **新增**；`turnMetricsSchema` + `composerTurnMetricsSchema`；default null |
| `snapshot.sessionToolStats` | 新增同名 `snapshot.sessionToolStats` | **新增**；default null？否：初始全零对象（新 CLI），null 只留给旧 CLI |
| `turnMetricsSchema.firstTokenMs/outputTokens/tokensPerSecond` | 同上 | **新增**；由 main_turn `model_request_completed` 累加 |
| `turnMetricsSchema.inputTokens/requestCount/reasoning/cacheRead/Write/peak` | 同上 | **新增**（additive） |
| `snapshot.usage.cumulative` | 目标既有 `sessionUsageStateSchema.cumulative` | **复用**；会话段主数据 |
| `snapshot.usage.contextWindow` | 目标既有 | **复用**；上下文段唯一数据源，不新增协议字段 |
| `snapshot.usage.lastRequest` | 目标既有 | **复用但降级**：仅当 `composerTurnMetrics` 缺席时作为实测速度回退；新主路径不读 |
| `snapshot.subagents.running[].title` | 目标既有 `subagentProjectionStateSchema` | **复用**；子代理任务名 |
| `snapshot.subagents.childSessionIds/endedTotal` | 目标既有 | **复用**；订阅集合与显示门槛 |
| `turnHeader.metrics` | 目标既有 `turnHeader.stats` | **复用 + 扩展**：加 `tokensPerSecond?`/`peakTokensPerSecond?`；`modelRequestCount`→段；`timeToFirstTokenMs`→首 token；不新增 `turnHeader.metrics` 第二字段 |
| `AppUsageHeatmapCell` 四个分项 | 目标同名 schema | **新增 additive 字段**（§3.4） |
| `AppSettings.composerUsageBar` | 目标 `UsageStatusbarPreferences` 切片 | **语义映射，不新增 AppSettings 字段**：目标已有唯一 localStorage 所有者；目标不存在 `composerTurnMetricsVisible`，无需旧键迁移 |
| `test-ids-composer-usage-bar.ts` | 目标新同名文件 | **新增** |
| `@zcode/shared` / `@zcode/shared/zcode-protocol-v4` | `@acode/shared` / `@acode/shared/acode-protocol-v4` | 移植时改导入 |
| `usage.inFlight`（源实现使用，目标重设计已回退） | — | **禁止移植**；`sessionTokenStats` 去掉 `readInFlightSessionUsage`/`withInFlightSessionUsage`；`UsageStatusBar` 不接收 inFlight 入参；`turnUsage` 在首个 ModelComplete 前隐藏（源规则 12 允许） |
| `usageStatusbarInFlight.ts`/统一面板/秒表（目标重设计） | — | **禁止**；见 R5 |

**新增/复用结论**

- 必须新增：`composerTurnMetrics`、`sessionToolStats`、`turnHeader.stats` 两个速度字段、今日四个 additive 字段、testid 文件、七个 helper。
- 可直接复用：`usage.cumulative`、`usage.contextWindow`、`subagents.*`、`turnHeader.stats` 的既有 tokens/timing/fileChanges 字段、`AppUsageSnapshot`/heatmap 骨架、`useSessionSubagents`、`SessionDataLayer`。
- `usage.lastRequest` 保留但不再是速度主路径；无新消费者时也不删除（旧快照兼容）。

---

## 5. R4 UI 文件落点与旧栏下线

### 5.1 源 17 文件的目标落点

新目录：`packages/ui/src/v4/composer/usage-bar/`（源目录形态，目标当前无 `v4/composer/` 目录，可新建）。

| 源文件（17） | 目标落点 | 处理 |
| --- | --- | --- |
| `usageBarModel.ts` | `v4/composer/usage-bar/usageBarModel.ts` | 移植；`UsageBarSettings` 改为由目标设置切片解析 |
| `usageBarSegments.ts` | 同目录 | 移植；速度阈值 70/40 |
| `usageBarSessionSegments.ts` | 同目录 | 移植 |
| `usageBarCapacity.ts` | 同目录 | 移植 |
| `usageBarSubagents.ts` | 同目录 | 移植；`builtInSubagentDisplay` 需一并移植 |
| `usageBarFormat.ts` | 同目录 | 移植 |
| `usageBarDetailGroup.ts` | 同目录（可选） | 目标用单一 `hoveredSegmentId` 已保证互斥，可不移植；若移植只保留纯函数测试，不参与渲染 |
| `usageBarSegmentView.tsx` | 同目录 | 移植段行/环形/徽标/明细键值行；替换为目标的受控 Popover |
| `UsageStatusBar.tsx` | 同目录 | 移植七段编排；数据层按目标字段/helper 适配 |
| `UsageBarSettingsPopover.tsx` | 同目录 | 移植；写目标设置切片（`useUsageStatusbarPreferences`/setter） |
| `UsageBarSubagentPanel.tsx` | 同目录 | 移植；接目标 `useSessionSubagents` |
| `UsageBarErrorBadge.tsx` | 同目录 | 移植 |
| `TurnRateFooter.tsx` | 同目录 | 移植；接 `turnHeader.stats`（不是 `metrics`） |
| `UsageBarHoverDetail.tsx` | **不移植** | 其 HoverCard 生命周期与目标 hover 修复冲突；明细容器改用目标受控 Popover/现有 `UsageStatusbarCapsule` 演进 |
| `usageBarModel.test.ts` | `packages/ui/test/usageBarModel.test.ts` | 改写为纯模型测试 |
| `TurnRateFooter.test.ts` | `packages/ui/test/turnRateFooter.test.ts` | 移植 |
| `UsageStatusBar.dom.test.tsx` | **不直接移植** | 目标无 DOM 测试装置（`packages/ui/package.json:18` 只跑 `test/**/*.test.ts` 与 `tests/**/*.test.mjs`）；用纯模型测试 + 源码守卫 + 手测 |

### 5.2 六个 helper 的目标落点

| helper | 目标落点 | 说明 |
| --- | --- | --- |
| `useLiveOutputRate` | `packages/ui/src/v4/composer/useLiveOutputRate.ts` | 新；`useSyncExternalStore` 读 `layer.liveOutputRates` |
| `liveOutputRateRegistry` | `packages/ui/src/v4/composer/liveOutputRateRegistry.ts` | 新；`SessionDataLayer` 持有实例并在 acquire 时 `observeLiveOutputRateStore` |
| `useChildSessionTokenStats` | `packages/ui/src/v4/composer/useChildSessionTokenStats.ts` | 新；按 `childSessionId` 取累计/速率；最多 6 个 live lease |
| `sessionTokenStats` | `packages/ui/src/v4/composer/sessionTokenStats.ts` | 新；**去掉 inFlight 两个函数与 `usage.inFlight` 读取**；保留采样/滑窗/`readSessionTokenTotal` |
| `useTodayAppUsage` | `packages/ui/src/hooks/useTodayAppUsage.ts` | 新；替代目标旧 `useTodayUsageTotals`；防抖 5s + focus，无轮询 |
| `contextUsageCost` | `packages/ui/src/chat-input-toolbar/contextUsageCost.ts` | 新；tokenlens 已在目标 `packages/ui/package.json:68` |
| `turnMetrics` | `packages/ui/src/chat-input-toolbar/turnMetrics.ts` | 新；格式化与 `TurnMetricsMessageFormat` |
| `builtInSubagentDisplay`（面板缺名回退） | `packages/ui/src/lib/builtInSubagentDisplay.ts` | 新；补 `subagent.builtInName.generalPurpose/explore` 双语 |

### 5.3 目标旧 12 文件下线

`packages/ui/src/v4/usage-statusbar/` 整目录删除（不留双条并存）：

| 旧文件 | 下线方式 |
| --- | --- |
| `UsageStatusbar.tsx` | 由 `v4/composer/usage-bar/UsageStatusBar.tsx` 取代 |
| `UsageStatusbarCapsule.tsx` | 由 `usageBarSegmentView.tsx` + `UsageBarErrorBadge.tsx` 取代；Popover 壳保留风格 |
| `UsageStatusbarTooltips.tsx` | 由 `usageBarSegmentView.tsx` 的明细键值行取代 |
| `UsageStatusbarSettingsPopover.tsx` | 由 `UsageBarSettingsPopover.tsx` 取代 |
| `UsageSubagentPanel.tsx` | 由 `UsageBarSubagentPanel.tsx` 取代 |
| `TurnRateLine.tsx` | 由 `TurnRateFooter.tsx` 取代 |
| `usageStatusbarFormat.ts` | 由 `usageBarFormat.ts` 取代 |
| `usageStatusbarModel.ts` | 由 `usageBarModel.ts` + `usageBarSegments.ts` + `usageBarSessionSegments.ts` 取代 |
| `usageStatusbarPresence.ts` | 由新模型的「缺值隐藏」逻辑取代 |
| `usageStatusbarTodayModel.ts` | 由 `useTodayAppUsage.ts` + 今日段构造取代 |
| `useTodayUsageTotals.ts` | 由 `useTodayAppUsage.ts` 取代 |
| `useUsageStatusbarPreferences.ts` | 迁移为 `v4/composer/usage-bar/useUsageBarPreferences.ts`（读同一设置切片） |

**外部引用更新**

- `packages/ui/src/v4/ConversationComposer.tsx:155` 的 `UsageStatusbar` import → 新 `UsageStatusBar`；`:2152` 的挂载改为传 `snapshot`、`costModelId`、`workspacePath`、`workspaceIdentity`、`remoteSessionId`。
- `packages/ui/src/v4/ConversationTurnGroup.tsx:92` 的 `TurnRateLine` import → `TurnRateFooter`；`:1366` 改为传 `unit.header`（stats/activeMs/state）。
- `packages/ui/src/app-shell/SubagentDirectorySidePane.tsx:24` 的 `usageStatusbarFormat` → `usageBarFormat`；`:132` 的 `formatUsageTokenCount` 调用按新格式化函数调整。
- 删除/重写目标旧测试：`packages/ui/test/usageStatusbarModel.test.ts`、`usageStatusbarSurface.test.ts`、`usageStatusbarTooltipStability.test.ts`、`usageStatusbarPreferences.test.ts`；`contextUsageAutoCompact.test.ts` 保留（上下文环不在本次下线范围）。

---

## 6. R5 布局调紧与 hover 稳定性：保留/取代

### 6.1 必须保留（目标 320af845 / 36c28d65 的不变量）

1. **稳定 key**：每个段以段 id 为 key；条件渲染不依赖数组位置。
2. **固定 min-w 槽位**：按典型值紧档预留（`tabular-nums`）；为新七段补 `context` 槽位；瞬态超槽允许一次性变宽，不为稳定而留大片空白。
3. **脉冲点改图标角标**：固定尺寸 span 绝对定位在图标右上角，恒渲染、`opacity` 切换显隐，零布局占用；不插拔、不占流内槽位。
4. **自管 hover 生命周期**（核心不变量）：见 §2.2；禁止用 `pointerleave`/`relatedTarget` 判定关闭；禁止 Radix Tooltip/HoverCard；关闭只认 window `mousemove` 的 bar rect 命中测试与 Popover 主动关闭。
5. **单一展开**：`hoveredSegmentId` 单状态；钉住语义只是「鼠标移开也保留」，别的段打开时仍然收起。
6. 条容器保持目标的紧凑视觉（`h-7`、`gap-0.5`、`px-1`、`overflow-hidden`、`text-ui-sm`），不采用源 `h-[30px] gap-[18px] px-2.5` 的松布局。

### 6.2 采用源（取代目标旧值）

- 七段顺序与折叠顺序：`context → today → turnUsage`（639px），`subagents → tools`（479px）；`speed/session/gear` 永不收起。
- 旧目标 520/420 断点随六胶囊集合一起退役（七段需要源断点；不为保留旧值而压缩上下文/今日段）。
- 速度阈值改源 `≥70 / 40–70 / <40`（旧目标 50/15 退役）。
- 上下文段进状态栏（目标旧版由 composer 上下文环承载）；上下文环本身保留，不删除、不改其数据口径。
- 工具段错误从「· N 错误」文字改为错误徽标。

### 6.3 禁止复现的被回退重设计

以下内容在目标 `3eba326d`/`ca2c6778` 已整波回退，本次**不得**以任何形式复活：

- `usage.inFlight` 协议字段与 `usageStatusbarInFlight.ts`、流式累计 overlay、`readInFlightSessionUsage`/`withInFlightSessionUsage`。
- 胶囊文字微标签 `shortLabel` / 微标签布局。
- 统一明细面板 `UsageStatusbarDetailPanel.tsx`、`UsageStatusbarDetailRequestGroups.tsx`、`useUsageDetailPanelOpen.ts`。
- 秒表降级 `useStopwatchElapsedMs.ts` / 1Hz tick。
- 任何「面板锚整条 bar、七分组全量清单」的形态。

保留目标 `apps/acode-cli/specs/usage-statusbar.md` 的还原记录作为纪律来源；本 spec 只新增七段显示与数据面，不重新设计面板形态。

---

## 7. R6 i18n、设置切片、总开关与子开关

### 7.1 设置切片（唯一所有者）

沿用目标 `packages/ui/src/lib/usageStatusbarPreferences.ts`（localStorage 单键）与 `store/usageStatusbarPreferencesState.ts`（广播载体）。**不新增 `AppSettings.composerUsageBar`**：目标没有跨机器 settings 白名单机制，且现有切片已是唯一写入口；新增 AppSettings 会产生第二所有者。

切片 schema 扩展：

```ts
export const USAGE_STATUSBAR_ITEM_IDS = [
  "generationSpeed",
  "turnUsage",
  "contextCapacity",   // 新增
  "sessionCumulative",
  "toolCalls",
  "todayTotal",
  "subagents",
] as const;

interface UsageStatusbarPreferences {
  enabled: boolean;                    // 总开关，默认 true
  visibleItems: Record<ItemId, boolean>; // 七个子开关，默认全 true
  answerFooter: boolean;               // 原 rateLineEnabled；默认 true
}
```

- 迁移：加载旧 JSON 时 `answerFooter = source.answerFooter ?? source.rateLineEnabled ?? true`；`enabled` 缺省 true；`contextCapacity` 缺省 true。写回新 schema，不再写 `rateLineEnabled`。
- 唯一写入口仍是 `setUsageStatusbarPreferences(patch)`：合并 → 归一 → localStorage → 通知；`store` 切片与 `BroadcastService` 只做回显/跨窗广播，不作事实源。
- 齿轮弹层与设置页写同一份切片；不写 `AppSettings`、不写 localStorage 第二键。
- `composerTurnMetricsVisible` 在目标不存在（已核实），无需迁移；若未来引入，按源规则「显式 false → speed 默认关」。
- 模型层适配（唯一映射点，放 `usageBarModel.ts` 的 `resolveUsageBarSettings`）：

```ts
resolveUsageBarSettings(p) = {
  enabled: p.enabled,
  speed: p.visibleItems.generationSpeed,
  turnUsage: p.visibleItems.turnUsage,
  context: p.visibleItems.contextCapacity,
  session: p.visibleItems.sessionCumulative,
  tools: p.visibleItems.toolCalls,
  today: p.visibleItems.todayTotal,
  subagents: p.visibleItems.subagents,
  answerFooter: p.answerFooter,
}
```

齿轮弹层把 `keyof UsageBarSettings`（除 `enabled`）映射回 `visibleItems`/`answerFooter` 后调用 `setUsageStatusbarPreferences`；设置页总开关调用 `setUsageStatusbarPreferences({ enabled })`。两条入口写同一对象，不出现第二写入路径。

### 7.2 总开关与子开关语义

| 开关 | 位置 | 关闭效果 |
| --- | --- | --- |
| `enabled` 总开关 | 设置页「用量状态栏」分组标题行 | 状态栏整条 + 回答末尾速率行都不渲染；七个子开关与 `answerFooter` 值原样保留；重新打开恢复 |
| `generationSpeed` | 齿轮弹层 + 设置页 | 只隐藏速度段 |
| `turnUsage` | 同上 | 只隐藏本轮段 |
| `contextCapacity` | 同上 | 只隐藏上下文段 |
| `sessionCumulative` | 同上 | 只隐藏会话段 |
| `toolCalls` | 同上 | 只隐藏工具段 |
| `todayTotal` | 同上 | 只隐藏今日段；不停止今日取数 hook 的挂载刷新（开关切换后重新显示时数据可用） |
| `subagents` | 同上 | 只隐藏子智能体段 |
| `answerFooter` | 同上 | 只隐藏回答末尾速率行；总开关关闭时也被总开关压制 |

**设置页落点**：新增 `packages/ui/src/settings/UsageStatusbarSettingsSection.tsx`（自包含组件，直接读切片，避免穿过 `SettingsPage` 巨型 props），在 `packages/ui/src/settingsPageHelpers.tsx:791` 的「显示思考过程」行附近渲染分组；分组标题行挂总开关，下面按七段顺序 + 速率行排列。齿轮弹层不渲染总开关。

### 7.3 i18n

沿用目标既有 `chat.usageStatusbar.*` 命名空间（不新增 `chat.usageBar.*` 第二套），两语言同步：

| 组 | 键（代表） |
| --- | --- |
| 段名 | `chat.usageStatusbar.{speed,turnUsage,context,session,tools,today,subagents}.label` |
| 数值/单位 | `unit.tokensPerSecond`、`more`、`speed.estimated`、`badge.errors` |
| 明细 | `detail.{inputTokens,outputTokens,reasoningTokens,cacheReadTokens,cacheWriteTokens,cacheHitRate,ttft,requests,turns,segmentsPeak,segmentsPeakValue,codeChanges,fileCount}` |
| 本轮 | `turnUsage.{input,output,note,noteEstimated}`、`speed.{requests,note,noteEstimated}` |
| 容量 | `capacity.{usedOfWindow,threshold,distanceToThreshold,remaining,beyond,note,overflowAdvice}` |
| 工具 | `tools.{calls,errors,note}`、`tools.row.{duration,errors}` |
| 今日 | `today.{tools,cacheHit,note}`、`today.favoriteModel`（目标既有，可选） |
| 子智能体 | `subagents.{main,running,ended,rate,note}`、`subagentPanel.{statusRunning,statusWaiting,statusBlocked,statusSuccess,statusFailed,statusCancelled,statusLost,speed,endedHint,loadingEnded,failedEnded,emptyEnded}` |
| 设置 | `settings.title`、`settings.total`、`settings.hint`、`settings.rateLine`（改为 `answerFooter` 文案） |
| 速率行 | `turnRateFooter.{note,segmentsPeak}` |
| 设置页 | `settings.usageStatusbar.{title,description,totalLabel}` |
| 内置子代理名 | `subagent.builtInName.{generalPurpose,explore}`（新） |

要求：zh-CN 与 en-US 键集合一致；缺失键不得回退成 key 字符串；数字与单位之间按目标 `tokenNumberFormat` 的 zh 排版规则处理。

---

## 8. R7 测试与验收

### 8.1 可执行命令

```bash
# 纯模型 / 设置切片（目标 UI test glob 只匹配 test/**/*.test.ts）
pnpm --filter @acode/ui test

# 共享协议字段
pnpm --filter @acode/shared test

# CLI 测试（tests/**/*.test.mjs）
pnpm --dir apps/acode-cli test

# 包内投影/聚合测试（目标这些包没有 test script，直接跑文件）
node --import tsx --test apps/acode-cli/packages/bootstrap/src/acode-protocol/usage-stats-builder.test.ts
node --import tsx --test apps/acode-cli/packages/adapters/src/storage/session-store/repositories/usage.test.ts
node --import tsx --test apps/acode-cli/tests/usage-statusbar-projection.test.mjs

# 门禁
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm architecture:check --changed
pnpm verify:pre-push
```

注意：根 `pnpm lint` 的 `ignorePatterns` 含 `apps/acode-cli`；CLI 包 Lint 用包级命令；报告退出码不得用管道截断。

### 8.2 必测文件

| 目标测试文件 | 覆盖 |
| --- | --- |
| `packages/ui/test/usageBarModel.test.ts` | 七段顺序、开关、缺值隐藏、速度单一口径/不同屏、档位 70/40、容量三档/超限、错误徽标、段峰、每工具 12 行、会话/今日分项、子代理行同源/缺名回退/`≥`、inFlight 不存在 |
| `packages/ui/test/usageBarDetailGroup.test.ts`（若保留纯函数） | 明细互斥状态机 |
| `packages/ui/test/turnRateFooter.test.ts` | 速率行段落、段峰缺字段省略、servedModels 徽标 |
| `packages/ui/test/sessionTokenStats.test.ts` | 2.5s 滑窗、1.5s 作废、可见输出折算、无 inFlight |
| `packages/ui/test/liveOutputRateRegistry.test.ts` | 按 session/turn key 采样、断链 invalidate、有界淘汰 |
| `packages/ui/test/usageStatusbarPreferences.test.ts` | 新 schema 归一、旧 `rateLineEnabled` 迁移、总开关不改写子开关、跨窗广播防回环 |
| `apps/acode-cli/tests/usage-statusbar-projection.test.mjs` | `composerTurnMetrics` 累加/归零/streaming、`sessionToolStats` 工具/重试/轮数/文件数、main_turn 门禁、冷恢复 |
| `apps/acode-cli/tests/usage-stats-builder-today.test.mjs` | 今日四字段进 heatmap、旧数据缺字段、命中率分母 |
| `apps/acode-cli/packages/adapters/src/storage/session-store/repositories/usage.test.ts` | 按日 SQL 的 input/output/cache/request |
| `packages/shared/test/usage-statusbar-protocol-fields.test.ts` | snapshot/delta additive 解析、default null、旧端剥离 |

### 8.3 验收场景（18）

1. 新会话首轮收口：出现速度/本轮/上下文/会话/工具/今日六段；无子代理不出现子智能体段。
2. 生成中速度段显示实时估算（带 `≈`、`data-tone="live"`）并随流刷新；收口后原位替换为加权实测值，与回答末尾速率行逐位相等。
3. 明细中不再出现第二个速度数字；生成中无实时样本时退回实测值，整段不消失。
4. 收口档位：70 → 绿 `success`；69.9 → 黄 `warning`；39.9 → 红 `error`；流式中恒 `live`。
5. 容量：`used < 阈值` 默认；`used ≥ 自动压缩阈值` 黄；`used ≥ maxTokens` 红 + 闪烁（`prefers-reduced-motion` 静止）；`maxTokens` 缺失整段不渲染；超限明细出现处置建议。
6. 错误徽标：114 次调用 2 次失败 → 段值 `114` + 徽标 `2`，无「· 2 错误」文字；0 失败无徽标；每工具行有错带徽标；>99 显示 `99+`。
7. 段/峰：新 CLI 的本轮明细与速率行出现「段 6 · 峰 168 tok/s」；旧 CLI 缺 `peakTokensPerSecond` 整行隐藏，段数与速率仍正常。
8. 每工具明细：按次数降序/名称升序，最多 12 行；耗时缺失省略该列；不建空壳。
9. 子代理面板：运行中任务显示目录同名任务名 + 该任务自己的实时速度（有样本才显示）+ 用量 + 状态点；两条任务速度独立相加等于段值合计；缺名退回 `subagentType`；不按顺序错配。
10. 子代理段值只算运行中：数量/tokens 不含已结束；全部结束后只剩累计 tokens；无子代理整段不渲染。
11. 子代理面板的已结束分组只在点按钉住后查询；查询失败/加载中/空三态提示不同；失败只收起该分组；live 订阅最多 6 个。
12. 明细互斥：钉住子智能体后再悬停今日 → 子智能体收起且钉住清除；同一时刻只有一个浮层；点按再次/外部/Esc 关闭。
13. 今日合计：heatmap 当天 cell 带输入/输出/缓存/请求分项；旧 CLI 缺字段只隐藏对应行；轮收口后防抖 5s 刷新 + focus 刷新，无轮询；查询失败整段隐藏。
14. 会话累计：思考/缓存/轮数/请求/工具·重试/代码增删/文件数/子代理/预估费用逐行按数据存在性显示；子会话读不到时带 `≥`。
15. 总开关：关闭后状态栏整条与速率行都不渲染；子开关不变；重新打开恢复原选择；齿轮不提供总开关。
16. 旧栏下线：代码中不再存在 `v4/usage-statusbar/UsageStatusbar.tsx`/`TurnRateLine.tsx`/旧 12 文件；页面只出现一条状态栏；外部引用（Composer/TurnGroup/SubagentDirectory）指向新目录。
17. 布局/hover：流式期间指针静止时明细不因值 tick/脉冲/段插入/bar 推移而关闭；稳定 key、min-w 槽位、脉冲角标生效；代码中不存在被回退的微标签/统一面板/inFlight/秒表。
18. 兼容/冷恢复：旧快照缺 `composerTurnMetrics`/`sessionToolStats`/今日分项 → 解析为 null/缺省并隐藏对应 UI；新快照经冷恢复/replay 后七段与终值一致；`pluginStates` 等既有字段不受影响。

**未验证声明**：本 spec 只做源码/文件核对，未运行任何构建或测试；实施批次必须实际执行 §8.1 并记录真实退出码。

---

## 9. R8 版本/发布裁决

- 本移植是**纯 UI + additive 协议字段**：`composerTurnMetrics`、`sessionToolStats`、`turnHeader.stats` 两个速度字段、`appUsageHeatmapCell` 四个分项、testid 文件。
- **不需要**版本号/发布登记变更：不涉及 AgentTeams 插件版本（package.json/plugin.json/definition/SEA 清单）、桌面/SEA 暂存清单、远端官方插件资产。
- 不需要新增依赖：`tokenlens` 已在 `packages/ui/package.json:68`；`useSessionSubagents`、`SessionDataLayer`、`Popover`/`Switch` 等组件目标已有。
- 需要更新文档：`apps/acode-cli/specs/usage-statusbar.md` 的状态栏节应标注由本 spec 取代（数据口径/`/usage` 命令族/上下文环仍以旧 spec 为准）；旧 spec 的还原记录保留。
- 发布语义：旧客户端解析新快照时剥离未知键（容器非 strict）；新客户端解析旧快照时字段缺失 → null/隐藏。桌面 `desktop-continuous` 与 Web `web-remote-replayable` 复用同一事件日志与投影，不新增持久化路径。

---

## 10. 改动清单（按批次）

**批次 A：shared/CLI 数据面**

1. `packages/shared/src/acode-protocol-v4/rows.ts`：`turnMetricsSchema`/`composerTurnMetricsSchema`；`turnHeaderStatsSchema` 加 `tokensPerSecond?`/`peakTokensPerSecond?`。
2. `packages/shared/src/acode-protocol-v4/snapshot.ts`：`sessionToolStatsSchema` + `composerTurnMetrics`/`sessionToolStats` 字段。
3. `packages/shared/src/acode-protocol-v4/delta.ts`：两个状态键。
4. `packages/shared/src/usage-stats.ts`：heatmap cell 四个 optional。
5. `packages/shared/src/test-ids-composer-usage-bar.ts` + `index.ts` 导出。
6. `apps/acode-cli/packages/contracts/src/interfaces/session-store.port.ts`：`AppUsageDayRow` 四个 optional。
7. `apps/acode-cli/packages/adapters/.../usage.ts`：按日 SQL + dayMap。
8. `apps/acode-cli/packages/bootstrap/src/acode-protocol/usage-stats-builder.ts`：dayBreakdownMap + heatmap。
9. `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/product-projection-usage.ts`：turn metrics 累加器 + 会话工具统计 helper。
10. `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/product-projection.ts`：接线、clone/adopt、初始态。
11. `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/projection-state.ts`：初始 `composerTurnMetrics: null`、`sessionToolStats` 全零。

**批次 B：UI 与 helpers**

1. 新建 `packages/ui/src/v4/composer/usage-bar/`（14 非测试文件，按 §5.1；不移植 `UsageBarHoverDetail.tsx`/`usageBarDetailGroup.ts`）。
2. 新建 7 个 helper（§5.2）。
3. `SessionDataLayer` 加 `liveOutputRates` + observe/invalidate。
4. 改 `ConversationComposer.tsx`、`ConversationTurnGroup.tsx`、`SubagentDirectorySidePane.tsx` 引用/挂载。
5. 删除 `packages/ui/src/v4/usage-statusbar/` 12 文件。
6. 设置切片扩展 + `UsageStatusbarSettingsSection.tsx` + 齿轮弹层。
7. i18n 双语。

**批次 C：测试与门禁**

1. 新测试（§8.2），删除/重写旧 `usageStatusbar*` 测试。
2. 跑 §8.1 命令与门禁。
3. 手测双链路与布局/hover。

---

## 11. 不在本项范围

- 不移植目标已回退的重设计（微标签/统一明细面板/inFlight/秒表）。
- 不新增 `AppSettings.composerUsageBar` 第二设置所有者（沿用目标 localStorage 切片）。
- 不改 `/usage` 命令族、上下文环、Coding Plan 配额面板。
- 不新增依赖、不做与用量状态栏无关的重构。
- 不移植源 `ReadOnlySessionTokenStats`/DOM 测试（目标无对应宿主/测试装置）。
- 不改 AgentTeams 插件版本、SEA/桌面/预构建清单。

---

## 12. 风险与未决

1. **数据口径迁移**：目标旧速度来源是 `usage.lastRequest`（事件驱动、非实时），新 spec 改为 `composerTurnMetrics` + 实时估算；旧 `lastRequest` 只作回退，须验证旧 CLI 兼容路径。
2. **目标 turnHeader 字段差异**：源 `turnHeader.metrics` vs 目标 `turnHeader.stats`；本 spec 选择扩展现有 `stats`，不新增第二字段。若实施中发现 `stats` 已被其他消费者依赖，需保持字段名并只加 additive 字段。
3. **目标无 inFlight**：首个 ModelComplete 前本轮段隐藏；长请求期间用户只看到实时速度，不看到未落账 token。这是源规则 12 允许的行为，不视为缺陷。
4. **设置切片迁移**：旧用户 localStorage 的 `rateLineEnabled` 必须映射到 `answerFooter`；不得丢弃显式关闭偏好。
5. **hover 修复回归**：新七段若误用源 HoverCard/Radix Tooltip，会重新引入流式闪断；§6.1 的 5 条不变量是硬验收。
6. **400 行 ratchet**：新 UI 文件均须 ≤400（源文件已在阈值内，但适配后不得增长超限）；`product-projection.ts` 已在 baseline 可增长，新逻辑优先放 `product-projection-usage.ts`。
7. **旧测试引用**：删除旧目录后 `packages/ui/test/usageStatusbar*`、`SubagentDirectorySidePane` 等引用会先红；必须同批更新，不能留双目录。
8. **未验证**：本 spec 未运行任何命令；所有数据口径与文件行号在实施前需按当前盘面复核。

---

## 13. 验收对照

- [ ] R1 七段（速度/本轮/上下文/会话/工具/今日/子智能体）+ 悬停/设置/窄宽/子代理面板行为落地。
- [ ] R2 `composerTurnMetrics`/`sessionToolStats`/今日分项/testid/设置切片均有唯一所有者与目标落点。
- [ ] R3 字段映射表逐项落地；`usage.cumulative`/`contextWindow`/`lastRequest`/`subagents` 复用；无 `usage.inFlight`。
- [ ] R4 源 17 文件/6 helpers 落点明确；旧 12 文件删除；外部引用更新；无双条。
- [ ] R5 目标布局调紧与 hover 修复保留；折叠顺序/断点按源；被回退重设计零复现。
- [ ] R6 i18n 双语完整；设置切片总开关/子开关语义正确。
- [ ] R7 §8.1 命令真实执行并记录退出码；18 个场景通过或明确标注未验证。
- [ ] R8 无版本/发布变更；文档回写旧 spec 取代关系。

---

## 14. 修订记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-20 | 初稿：基于源 `master@2bf8d04d` 与目标 `38b93920` 核实七段、数据面、UI 落点、旧栏下线、hover/布局保留与回退重设计禁令 |
