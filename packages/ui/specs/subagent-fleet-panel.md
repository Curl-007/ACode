# 子代理舰队面板 Phase 1 增量（subagent-fleet-panel）

状态：实施中（UX 波 D6，2026-10-18）
来源：oh-my-pi (MIT) collab-web components/agents/AgentsPanel.tsx + AgentDrawer.tsx
（状态点/kind chip/活动行/tokens·cost/相对时间/1s tick/点击钻取）。机制参照，
代码自撰。

## 现状盘点（Phase 1 之前已存在）

- `app-shell/SubagentDirectorySidePane.tsx`：运行中（v4 snapshot
  `subagents.running` = RunningSubagentSummary）+ 已结束（legacy
  session/subagents 分页）两段目录；状态图标七态（running/waiting/blocked/
  success/failed/cancelled/lost）；点击 → `SubagentSessionSidePane` 钻取
  （childSessionId 订阅，omp AgentDrawer 对应物）。
- `usage-statusbar/UsageSubagentPanel.tsx`：状态栏 popover 的 tokens 归因面。

## Phase 1 增量（本批，纯 UI——数据全部已在 wire 上）

### R1 行内事实补齐（对齐 AgentsPanel 的 meta 面）

- **类型 chip**：`subagentType` 显示为 title 旁 chip（omp kind chip 对应物）。
- **tokens 列**：running 项的 `cumulativeTokens`（RunningSubagentSummary 既有
  additive 字段）以 `formatUsageTokenCount` 渲染；**缺席不假零**（旧投影/ended
  项无该字段 → 整列不显示，纪律同 UsageSubagentPanel 注释）。
- **运行时长实时化**：running 项右列显示「已运行 {duration}」
  （`formatUsageDurationMs(now − startedAt)`），1s tick（omp useNow 同款）；
  **tick 只在存在 running 项时挂载**，且 `now` prop 只传给 running 行——
  memo 化的 ended 行不因 tick 重渲。ended 行保持相对时间戳不变。

### R2 i18n

`subagentDirectory.elapsed`（zh：已运行 {duration}；en：running {duration}）。

## Phase 2（登记不实施——需 CLI 投影面新事实）

- **活动行**（omp `currentTool · 耗时` → `lastIntent` → lifecycle status 兜底）：
  wire 上无 per-subagent currentTool 事实；D3 intent 字段开启后子代理工具调用
  携带意图，但缺「子代理当前工具/最后意图」的投影通道（RunningSubagentSummary
  additive 扩 `currentTool?`/`lastIntent?` + CLI 子代理运行时上报）。随 B1
  Agent Hub 批次实施。
- **cost 列**：模型价目数据面（builtin.json cost 字段）随 B2 用量仪表盘。
- 跨机舰队（多 attachment 汇总视图）：手机远控 roadmap 对齐后另批。

## 验收场景

1. running 项：类型 chip + tokens（有字段时）+ 已运行时长每秒刷新。
2. ended 项：无 tokens 列（缺席不假零）、相对时间戳静态、不随 tick 重渲。
3. 无 running 项时不挂 interval（tick 卸载）。
4. cumulativeTokens=0 合法显示为 0（有字段 ≠ 缺席）。
5. 钻取行为不变（点击 → SubagentSessionSidePane）。
