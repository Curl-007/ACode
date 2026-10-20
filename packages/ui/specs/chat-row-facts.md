# 对话行事实面三件小改（chat-row-facts）

对照上游 ZCodium PR #40（动作行常驻、用户消息时间戳、回复速度展示、session-debug 共享轮询），
按 ACode 现有事实面适配。本 spec 是行为改动的先行契约（AGENTS.md「spec 先行」）。

## 1. 动作行常驻

**产品规则**：用户行与 assistant 完成态动作行（复制/编辑/反馈/fork/hook/时间）常驻可见，
不再依赖 hover 揭示。动机：hover 透明门控在远控、触屏、大屏场景下入口不可发现。

**实现红线**：现有实现是 opacity 门控（元素始终渲染、始终占位），本次只删透明度/过渡类，
不改任何占位几何、不新增/删除 DOM 节点——静止指针下零布局位移（「布局稳定三规则」教训：
几何位移会引发 hover 闪断类问题）。

**门控移除点**（4 处，全部是纯 opacity 类）：

- `ConversationRowView.tsx` 用户行 `MessageActions`（`group-hover/user-row` 门控）；
- `ConversationRowView.tsx` `AssistantTextRowView` 完成态内联动作行（`group-hover/assistant-row`）；
- `ConversationTurnGroup.tsx` 轮尾 `ConversationAssistantTextActions`（`group-hover/assistant-turn`）；
- `ConversationTurnGroup.tsx` hook 兜底 `MessageActions`（`group-hover/assistant-turn`）。

**视觉层次**：动作按钮沿用既有 ghost 图标钮与 `text-foreground-subtlest` 时间标签色，
不新增组件库依赖（DESIGN.md 复用纪律）。

## 2. 用户消息时间戳

**产品规则**：用户行动作行末尾显示消息创建时间，形态与 assistant 动作行时间标签一致
（`select-none text-ui-sm text-foreground-subtlest`）。

**数据源**：`row.createdAt`（v4 `userInputRow` 基字段，epoch ms）经
`formatMessageTimeLabel(createdAt, locale, intl)` 只读派生——同日只显示时分、跨日带日期，
与 assistant 行共用同一纯函数与缓存。不新增 renderer 状态。

**降级**：`createdAt` 非法（非有限数 / ≤0）时函数返回 null，整段不渲染。

**i18n**：无新键（时间格式全部来自 `Intl.DateTimeFormat`）。

## 3. 消息级回复速度展示（↑prefill / ↓decode）

**数据源判定（与上游不同，关键决策）**：上游 ZCodium 走 session-debug 轮询 + 协议加
optional `prefillDurationMs/prefillTokensPerSecond`。ACode 已有**原生持久化轮次事实面**
`turnHeader.stats`（`packages/shared/src/acode-protocol-v4/rows.ts` `turnHeaderStatsSchema`，
core producer 单点计算、TurnComplete 时由投影写入）：

- `inputTokens` / `outputTokens`（在场必填；output 含思考）；
- `timeToFirstTokenMs` / `generationMs`（**optional**；缺席 = 旧投影/旧 server 快照）。

回答末尾速率行 `TurnRateLine` 已消费同一事实面（decode = Σoutput ÷ ΣgenerationMs）。
消息动作行**复用同一面，零协议扩展、零轮询**，速率随转录快照/replay 天然持久。

**口径**（轮级聚合，与 TurnRateLine 一致；上游是单请求级，差异登记于此）：

- prefill（思考/首字前的提示词处理吞吐）= `inputTokens × 1000 ÷ timeToFirstTokenMs`；
- decode = `outputTokens × 1000 ÷ generationMs`。

**降级规则（缺席 ≠ 0）**：`stats` 为 null/缺席、TTFT 缺席或为 0（全缓存直出）、
`generationMs` 缺席或为 0、tokens 为 0——对应标签为 null，**整段隐藏**；
不报错、不显示 0、不伪造速度。只显示 ↓ 不显示 ↑ 是预期行为。

**label 计算抽纯函数**：`packages/ui/src/v4/speedLabels.ts` `formatSpeedLabels(stats, numberFormat)`
返回 `{ prefillLabel, decodeLabel }`（string | null），配 node:test 单测（必测）。

**渲染位置**：assistant 完成态动作行 `ConversationAssistantTextActions`，时间标签之后，
`↑{prefill} tok/s`、`↓{decode} tok/s` 两段独立 span（任一缺席独立隐藏）。
数据接线：轮尾调用点（`ConversationTurnGroup`）传 `unit.header?.stats`；
内联兜底路径（`AssistantTextRowView`）拿不到 turnHeader，stats 缺席 → 速率段隐藏（可接受：
生产完成态动作行由轮尾裁决，`deferAssistantActions` 恒真）。

**i18n 键清单**：无新键。单位复用既有 `chat.usageStatusbar.unit.tokensPerSecond`
（en-US / zh-CN 同值 "tok/s"）；↑/↓ 为语言中性符号。

## 4. session-debug 会话级共享轮询

**现状判定**：ACode `useSessionDebug` 是逐订阅者独立轮询循环（每实例一个 1s setTimeout 链）；
当前唯一消费者是 `DeveloperToolsPane`（单实例）。速率展示改走 `turnHeader.stats` 后
**没有多订阅者压力**，与上游动机（每条动作行一个轮询器）不同。

**决策**：改动小（上游实现近乎 1:1 适配）→ 按决策树收敛为会话级共享循环：
同一 `(workspaceIdentity || workspacePath, sessionId)` 的多个订阅者复用一条循环，
末位退订即停；服务实例被替换（重连）时旧循环停摆、订阅者由 React 重挂新循环；
轮询失败保留最近一次成功快照仅置 `error` 标记（历史面不因瞬时错误闪烁）。
消费端通过 `useSyncExternalStore` 订阅模块级 Map。

**验收**：DeveloperToolsPane 行为不变（数据、error 态、1s 节拍）；两订阅者共享一条循环、
末位退订后不再发请求（临时验证登记于 PR 描述，不留常驻 DOM 测试）。

## 缓做项登记

- 上游的 session-debug 协议字段扩展（`prefillDurationMs/prefillTokensPerSecond`）**不做**：
  ACode 原生 `turnHeader.stats` 已覆盖消息级速率需求；如未来需要**单请求级**速率
  （轮内多请求分别显示），再评估在 v4 协议加 optional 字段。
- 内联兜底路径的动作行速率：等该路径有真实生产流量再议。
