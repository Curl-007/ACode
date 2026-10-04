# tools schema token 占比的 debug 级本地度量（P5）

提示词主线 P2 评估项（方案文档 `docs/cli-dispatch-and-system-prompt-upgrade-plan.md` 第 4 章 P5）。
延迟工具 ToolSearch 的立项判据是 **tools schema token 占比 > 15%**；判据成立与否今天无数据。
本 spec 定义 Phase 0 的度量点铺设：只加 debug 级本地度量，**不承诺实施 ToolSearch**。

红线（`specs/no-telemetry.md`）：度量只写本地日志，不产生任何网络上报、不进遥测通道、
不引入服务端 A/B。不新增 `ACODE_` 环境变量。

## 背景：既有计量面（已核实）

- 每模型请求已构建一次 context usage 快照并落 debug 日志：`buildContextUsageSnapshot`
  （`core/src/runtime/methods/context-usage.ts:119-253`）把上下文分为 7 类，其中
  `system_tool_schemas` 与 `mcp_tool_schemas` 两类就是 tools schema 的逐工具 token 估算
  （`buildToolUsageDetail`，`:310-335`；tokenizer 为本地估算 `acode.estimateTokens.v1`，
  confidence=low，快照自带警示文案 `:249`）。
- 日志点：`logContextUsageSnapshot`（`:45-57`）在 `model.ts:139` 每请求调用一次，经
  `compactContextUsageSnapshot`（`context-usage-log-compact.ts`）压缩后写 `logger.debug`
  （事件名 `context_usage_snapshot`）。debug 级生产不落盘（根 AGENTS.md 日志纪律），
  文件日志 `~/.acode/cli/log/*.jsonl` 默认只有 info 及以上。
- 工具面的组装点：`getTools`（`core/src/runtime/methods/config.ts:136-147`），带
  `cachedTools` 缓存；缓存在 MCP 工具注册、注册表改写（`invalidateToolCache`）等时点重建。

**缺口**：分类 token 数在快照里，但「两个 schema 类合计占总上下文的比例」要读日志的人手工
相加两类 `percentTokens`——判据字段没有直接可读形态；且工具面自身（数量、MCP 占比）在
缓存重建时点没有独立度量事件，MCP-heavy 会话分布无从统计。

## 产品规则

### R1 度量点一：工具面事实（config.ts，缓存重建时点）

`getTools` 的缓存重建分支（`this.cachedTools === null`）调用
`logToolsSchemaTokenMetric`，写一条 debug 日志（事件名 `tools_schema_token_metric`）：
`toolCount / systemToolCount / mcpToolCount / mcpServerCount / schemaChars / schemaTokens /
tokenizer`。口径 = **运行时可见工具全集**（缓存重建时点；每模型的 WebSearch 过滤与
projection 只可能再减一个工具，不影响量级）。放在重建时点而非每次 `getTools` 调用：
每模型请求重复序列化全部 schema 是纯浪费，重建时点即工具面变化时点，正好是
「MCP-heavy 会话分布」的采样点。

### R2 度量点二：占比判据字段（context usage 快照的日志投影）

`compactContextUsageSnapshot` 增加派生字段 **`toolSchemaRatioPercent`**：

```
toolSchemaRatioPercent =
  (tokens(source=system_tool_schemas) + tokens(source=mcp_tool_schemas)) / totalTokens × 100
```

- 分母是同一快照的 `totalTokens`（system prompt + meta user context + skills + tool prompt +
  两类 schema + messages 七类合计）——即「本请求总上下文」，与 >15% 判据同尺。
- `tool_prompt` 类（工具相关提示词段）**不计入**分子：判据对象是 schema 本体；
  tool prompt 段随 P1/P2 的承载层去重另行治理。
- 只加在日志投影（compact 层），不改 `buildContextUsageSnapshot` 的返回形状——快照的
  既有消费者（`buildContextUsageBreakdownFromSnapshot`、协议面 breakdown）零变化。
- `totalTokens === 0` 时字段为 `undefined`（除零不产出假数字）。

### R3 真实会话计算占比的方法（判据操作手册）

1. 以 debug 级日志运行会话（logger level=debug；文件日志默认不落 debug，可用
   `ACODE_LOG_CONSOLE=1` 的控制台通道或宿主侧 debug 开关——均为既有设施，无新环境变量）。
2. 找 `event === "context_usage_snapshot"` 的日志行，直接读 `toolSchemaRatioPercent`
   （每模型请求一条；取会话稳态段的中位数，首轮含一次性段落不作判据样本）。
3. MCP-heavy 分布：对同一会话的 `tools_schema_token_metric` 行读 `mcpToolCount / toolCount`
   与 `schemaTokens`。
4. 判据：稳态占比 **> 15%** → ToolSearch 立项（三件套：reminder 名单 / 按需取回 /
   discovered-set 由消息历史推导，并须评估 ephemeral cache 交互——工具面变化会 bust
   cache 前缀）；≤ 15% → 不立项，度量点保留。

### R4 估算口径的诚实性

token 全部来自本地估算器 `acode.estimateTokens.v1`（中文按 2 字符计、其余按
`ESTIMATED_TOKEN_CHAR_DIVISOR` 除算，`core/src/context/utils.ts:12-18`），confidence=low：
provider 真实 schema token 取决于各家序列化。度量字段必须自带 `tokenizer` 标识；
判据比较只在同一估算器内进行（占比是比值，估算器系统偏差大部分相消）。
schema 序列化口径与 `buildToolUsageDetail` **共用同一个纯函数**
（`stringifyToolContractForEstimation`），两个度量点不会各抄一份字段清单漂移。

## 状态所有者

| 状态 | 所有者 | 备注 |
| --- | --- | --- |
| 工具面与缓存 | `getTools`（methods/config.ts） | 度量点一在此触发，不新建缓存 |
| 上下文分类 token | `buildContextUsageSnapshot` | 既有，不动 |
| 占比派生字段 | `compactContextUsageSnapshot`（日志投影层） | 纯函数派生，无状态 |
| 判据（15%）与立项决策 | 本 spec + 方案文档 P5 | 人的决策，不进代码常量 |

度量**不持有任何跨调用状态**、不新增写入路径（日志除外）、不改变任何组装/调度决策。

## 接口

```ts
// core/src/runtime/methods/tools-schema-token-metric.ts
export interface ToolsSchemaTokenMetric {
  toolCount: number;
  systemToolCount: number;
  mcpToolCount: number;
  mcpServerCount: number;
  schemaChars: number;
  schemaTokens: number;      // acode.estimateTokens.v1
  tokenizer: string;
}
export function stringifyToolContractForEstimation(tool: ModelToolContract): string;
export function buildToolsSchemaTokenMetric(tools: ModelToolContract[]): ToolsSchemaTokenMetric;
```

## 验收场景

1. `buildToolsSchemaTokenMetric` 对固定工具集产出确定值；MCP 工具（`mcp__` 前缀）计入
   `mcpToolCount` 且 server 去重计数正确。
2. `compactContextUsageSnapshot`：含两类 schema 分类的快照 → `toolSchemaRatioPercent`
   等于两类合计占比；`totalTokens = 0` → 字段缺席；无 schema 分类 → 0。
3. 口径一致性：`buildToolUsageDetail` 与 `buildToolsSchemaTokenMetric` 对同一工具序列化
   结果逐字节相同（共用函数，测试锁定）。
4. 红线：度量路径无网络调用、无遥测导入（no-telemetry 套件不红 + 源码断言）。

## 常量定值记录

无新常量。15% 判据是决策阈值（人读日志判定），刻意不进代码——进了代码就会诱导
「自动执行判据」的投机实现；ToolSearch 立项前不允许任何自动化工具面裁剪。

## 不在本项范围

- ToolSearch 三件套实施（判据触发后另立 spec）。
- provider 侧真实 schema token 计数（需要各家 API 事实，估算器口径已够判据用）。
- 把度量暴露到协议/GUI（debug 日志即产品面）。

## 实现记录（2026-09-29）

- 落地文件：`core/src/runtime/methods/tools-schema-token-metric.ts`（新增：共享序列化 +
  度量构建 + debug 日志）、`methods/config.ts`（getTools 缓存重建分支触发度量点一）、
  `methods/context-usage.ts`（`buildToolUsageDetail` 改用共享序列化，口径合一）、
  `methods/context-usage-log-compact.ts`（`toolSchemaRatioPercent` 派生字段）。
- 测试：`apps/acode-cli/tests/tools-schema-token-metrics.test.mjs`（验收场景 1–3）。

## 立项决策记录（2026-09-29）

按 R3 操作手册对度量点实测：稳态 `toolSchemaRatioPercent` = **19.4%**，判据
（> 15%）**成立** → **ToolSearch 立项**（R3 第 4 条的「立项」分支）。

- **决策含义**：三件套（reminder 名单 / 按需取回 / discovered-set 由消息历史推导）进入
  实施排期（方案文档 Phase 3）；实施前必须先评估 ephemeral cache 交互（工具面变化会
  bust cache 前缀，收益可能被 cache miss 抵消）并**另立实施 spec**——本节只登记决策，
  不定义实施方案。`reminder-extensions.md`「不在本项范围」登记的「ToolSearch / 延迟
  工具名单提醒归 P5」随之纳入立项范围。
- **不变的约束**：立项不解除「常量定值记录」的禁令——15% 判据仍不进代码、不允许任何
  自动化工具面裁剪；no-telemetry 红线不变（度量与后续实施都不得外发）。
- **数字来源（据实登记）**：19.4% 转录自 2026-09-29 实施轮的度量记录（当日盘点报告
  p5Decision 字段）。debug 级度量生产默认不落盘（R3 第 1 条），原始日志行未留存仓内，
  本节不能附上原始输出；复测按 R3 操作手册执行，估算口径为 R4 的
  `acode.estimateTokens.v1`（confidence=low，占比是比值、系统偏差大部分相消）。
- 方案文档同步点：`docs/cli-dispatch-and-system-prompt-upgrade-plan.md` 的
  优先级总览 P5 行、§4 P5 决策记录、§6 Phase 3 范围行。

## 复测记录（2026-10-03，提示词优化批次 W9 测量）

按 R3 操作手册复测（本机 dev 环境 debug 文件日志 `~/.acode/cli/log/*.jsonl`，
2026-09-29 至 10-03，只读聚合、临时脚本不入库）：58 个 `context_usage_snapshot`
样本（turn0 22 个 + 会话中段 36 个）。

- **分布**：`toolSchemaRatioPercent` min 41.1 / p25 55.0 / 中位 66.5 / p75 79.5 /
  max 91.8；**100% 样本 > 15% 判据**。turn0 在 70-92%，随消息量增长回落，
  turn 11 仍 41%。与立项记录的 19.4%「稳态」不矛盾（会话形态不同：稳态口径的
  消息体远大于本批样本）；判据在两种口径下都稳定成立。
- **构成拆分（立项时未登记的新事实）**：`system_tool_schemas` 恒为
  142,267–142,837 chars；`mcp_tool_schemas` 恒为 4,076 chars（≈ 总上下文 2.5%，
  单一小型 MCP 工具面）。**schema 成本的绝对主力是内建系统工具面（23-41 个工具），
  MCP 只是零头。**
- **对已立项 ToolSearch 的实施含义**（供将来的实施 spec 引用；本节不改变立项决策、
  不实施任何工具面改动）：
  1. 延迟面若只按 MCP 工具构建，收益趋近于零（≤2.5%）；延迟候选应从**低频系统工具**
     选取（Cron×4、OffPeak×2、node-repl js、dynamic-workflow 十工具等），高频核心工具
     （Read/Edit/Write/Bash/Grep/Glob/Agent/SendMessage/Todo×2/Skill 等）的保留判据
     必须在实施 spec 里成文。
  2. 立项决策要求的 **ephemeral cache 交互先评估**仍是实施前置硬门（工具面变化
     bust cache 前缀，收益可能被 cache miss 抵消）——本批样本的 142KB 恒定 schema
     正是当前 cache 前缀的一部分。
  3. 15% 判据不进代码、不允许自动化工具面裁剪、no-telemetry 红线，全部维持原文。
