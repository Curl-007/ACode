# 上帝组件拆分 · 批次 6 实施报告（packages/ui 拆分波：弹窗族两件 + app-shell 一件 + ai-elements 一件 + 状态面板第一阶段）

日期：2026-10-29（Asia/Shanghai）。基线：`fix/project-review-2026-10-26` worktree（HEAD 66bf8dec，批次 5 之后）。
方法：照批次 5 的纪律执行——模式 A（纯决策逻辑外迁 + 决策表单测）为主，弹窗/面板按批次 4 的「闭包 → 受控组件」样板外迁；每个新叶子配接缝内测试。**本批不含 v4 两件**（ConversationRowView 2158 / ConversationTimeline 1923），按批次 4 纪律留给后续批次单独做风险评估。

输入：
- 拆分计划：[../../../packages/ui/specs/god-component-split-plan.md](../../../packages/ui/specs/god-component-split-plan.md)（本批新增 4 节 + ConversationStatusPanel 第一阶段小节，全部标已实施）
- ratchet 守护：[../../../packages/ui/tests/godComponentLineRatchet.guard.test.mjs](../../../packages/ui/tests/godComponentLineRatchet.guard.test.mjs)（上限表 +4 条，−1 条下调）
- 前序报告：[../2026-10-28/god-component-batch-5.md](../2026-10-28/god-component-batch-5.md) / [batch-4.md](../2026-10-28/god-component-batch-4.md) / [batch-1.md](../2026-10-28/god-component-batch-1.md)

选件理由（任务书口径「从批次 1 清单剩余未拆件里取行数最大者，排除 v4 两件」）：取非 v4 剩余候选中
行数最大的 4 件，第 5 件按要求取 ConversationStatusPanel 的**第一阶段**（批次 4 已定三阶段路径）。

---

## 1. 结果总览（行数均为物理行实测，口径同 ratchet 守护 `countPhysicalLines`）

| 主文件 | 拆前 | 拆后 | 减量 | 新叶子数 | 新测试用例 |
|---|---:|---:|---:|---:|---:|
| `GitActionMenu.tsx` | 1398 | **628** | −770 | 4 | 9 |
| `BotsDialog.tsx` | 1434 | **1177** | −257 | 4 | 26 |
| `app-shell/AnimatedSidePanePanel.tsx` | 1422 | **1306** | −116 | 1 | 7 |
| `components/ai-elements/markdown-table.tsx` | 1420 | **1093** | −327 | 2 | 43 |
| `v4/ConversationStatusPanel.tsx`（第一阶段） | 2102 | **1486** | −616 | 4 | 21 |
| **合计** | 7776 | **5690** | **−2086** | **15** | **106** |

15 个新叶子全部 <400 物理行（固定验收第 5 条），最大 308 行（markdownTableGeometryModel.ts）。
5 个主文件仍 >400——本批按 split-plan 口径属内部修剪，不计入「跌破 400」拆分进度；超 400 tsx 计数
不变（`find packages/ui/src -name '*.tsx' | xargs wc -l | awk '$1>400'` 实测 HEAD 与工作树双侧均为 **117**）。

## 2. 各组件明细

### 2.1 `GitActionMenu.tsx`：1398 → 628（−770，本批减量最大）

主文件顶部 helper 带与两个弹窗整组外迁，主组件只保留 trigger 状态机与 mutation 编排。

- `git-action-menu/gitActionMenuDialogsModel.ts`（82 行）：`GitCommitPreviewFile` 类型 + 9 个 TID 常量 +
  `CommitDialogActionId` 守卫 + `gitCommitActionItemTestId` / `isCommitDialogActionId` /
  `isCommitMessageTextAreaTarget` + `getCommitDialogFiles` / `getCommitDialogStagePaths` +
  `GitCommitDialogState` / `GitCommitDialogProps`，逐字迁入。
- `git-action-menu/GitCommitDialog.tsx`（287 行）：弹窗 shell + 派生状态 + 三套键盘导航（动作 Command
  上下切换 / 输入框 Arrow 穿透 / Enter 触发选中动作）。props 契约零改动。
- `git-action-menu/GitCommitDialogBody.tsx`（283 行）：**首版 GitCommitDialog 492 行超 400 的第二刀**——
  分支头 / 提交信息 / 暂存开关 / 动作 Command 四段 JSX 改受控渲染。`CommitCommandActionItem` 消重为
  内联 `CommandItem`（同 testid、同 disabled 语义、同 loading 图标位）。
- `git-action-menu/GitPushDialog.tsx`（260 行）：推送弹窗逐字迁入，`errorCopied` 局部态随组件走。
- 导出面不变：`GitActionMenu` 仍从 `@/GitActionMenu.js` 导出，消费方（ConversationStatusPanel 等）零改动。
- 测试：`test/gitActionMenuDialogsModel.test.ts` 9 例（action id 守卫矩阵 / testid / 文件集合两态 /
  stagePath 去重保序 / textarea 事件目标判定，后者用一次性最小构造器钉 instanceof 链）。

### 2.2 `BotsDialog.tsx`：1434 → 1177（−257）

- `BotsDialog/botsDialogModels.ts`（171 行）：`createEmptyConfig` / `createDraftBot` 逐字迁入 +
  **`resolveBotAutoConnectAction`**——把原 effect 里 120 行的「自动扫码 / 自动续绑定码」渠道 if 链
  收成判别联合（`none` / `start-feishu-qr` / `start-weixin-qr` / `create-bind-code`）。
  副作用（ref 去重集合的增删、异步动作）仍留在组件 effect；决策函数只回答「该做什么」。
- `BotsDialog/BotsDialogSidebar.tsx`（102 行）：左栏 Bot 列表受控组件（显示名兜底 / 渠道名 / 运行态圆点 /
  空态与「新建中」两条文案分支）。
- `BotsDialog/BotsDialogCreatePanel.tsx`（85 行）：新建渠道网格受控组件（排除 webhook / 未实现渠道
  disabled / 当前创建项 `aria-busy` + spinner）。
- `BotsDialog/BotsDialogDetailPanel.tsx`（237 行）：选中 Bot 的详情编排（BotSummaryCard /
  ProviderSettingsCard / SettingsGroupCard 四卡 / BotDangerCard）+ `BotsDialogEmptyState`。
- 偏离登记：`renderChannelName`（渠道名 + 地区徽标）仍由宿主实现并作 render prop 注入两个面板，
  避免把 `botsUi` 的 i18n key 拼装复制到叶子（单一实现原则）。
- 测试：`test/botsDialogModels.test.ts` 19 例 + `test/botsDialogPanels.test.ts` 7 例。
  后者环境适配如实登记：渠道图标是静态 `.png` 导入，用 `module.registerHooks` 重定向到 data: 空模块
  （口径同 pluginListRows.test.ts，`node --test` 每文件独立进程）。

### 2.3 `app-shell/AnimatedSidePanePanel.tsx`：1422 → 1306（−116）

- `app-shell/useSidePaneViewportMetrics.ts`（129 行）：`readViewportInlineIntersectionSize`（导出以便单测）
  + `useViewportInlineIntersectionSize` + `useWindowResizeSettling` 逐字迁入。
- 偏离登记：`useWindowResizeSettling` 的 settle 延时由闭包常量改为显式 `settleDelayMs` 入参，
  调用点传原 `PREVIEW_PANE_RESIZE_SETTLE_DELAY_MS`——**行为逐字等价**，只是把隐式闭包依赖显式化。
- 留主文件：`SuspendedBrowserSidePaneContent`（residency ack 日志 + platform 调用）、tab 条全部
  state/effect（溢出判定 / mask / active tab 滚入视区）、20 类 pane 分发 JSX、布局分支。
- 测试：`test/sidePaneViewportMetrics.test.ts` 7 例（无 window / 视口宽 0 / 左裁右裁 / 全在视口外 /
  四舍五入）。两个 hook 依赖 window + ResizeObserver，无 jsdom 不测，按固定验收第 4 条登记。

### 2.4 `components/ai-elements/markdown-table.tsx`：1420 → 1093（−327）

- `markdown-table/markdownTableTextModel.ts`（67 行）：`MarkdownTableRows` 类型单一来源 +
  `buildMarkdownTableText` / `buildCsvTableText`（CSV 注入防护与 UTF-8 BOM 注释原样保留）/
  `readRowsFromTable`。
- `markdown-table/markdownTableGeometryModel.ts`（308 行）：11 个选择器/常量 +
  `getMarkdownTableRootInlineInsets` / `readMarkdownTableObservedRect` /
  `isMarkdownTableObservedRectEqual` / `readCssPixelValue` / `readMarkdownTableDockHeight` /
  `readMarkdownTableBackToBottomClearance` / `resolveMarkdownTableVerticalViewport` /
  `resolveMarkdownTableStickyScrollbarMode` / `resolveMarkdownTableStickyScrollbarOffset` /
  `shouldUseMarkdownTableStickyScrollbar` / `resolveMarkdownTableFrameDistances` /
  `resolveMarkdownTableVirtualScrollbarMetrics` / `resolveMarkdownTableVirtualScrollMax`。
- 导出面保持：主文件 re-export 全部 8 个既有公开符号（`MarkdownTableRows` / 两个文本构建器 /
  四个几何解析器 / sticky mode），消费方 import 路径零改动。
- 测试：`test/markdownTableTextModel.test.ts` 14 例 + `test/markdownTableGeometryModel.test.ts` 29 例。
- **连带登记**：markdown-table.tsx 是 third-party 台账 inputs 追踪件，本批改动导致哈希漂移，
  按批次 5 的「单条定点回补」处理（见 §5）。

### 2.5 `v4/ConversationStatusPanel.tsx`：2102 → 1486（−616，第一阶段）

照批次 4 §2.5 的三阶段路径，**第一步先补 section 渲染契约测试，再外迁无实时语义的 section**。

**前置：`test/conversationStatusPanelSections.test.ts`（21 例）**，先钉结构再动代码：

- `StatusSectionShell`：`data-status-section` / `-trigger` / `-scroll` 三处锚点；展开-收起两态
  （含受控 `open` 覆盖 `defaultOpen`）；`separated` 分隔线有无；`trailing` 回调收到当前展开态；
  **八种 `StatusSectionKind` 的 scroll policy 穷举守卫**（漏配新类型会直接红）。
- `PlanStatusSection`：无 plan 整段缺席；计数 `completedCount/totalCount`；`data-plan-status` 三态；
  完成项 `line-through`。
- `SessionPlansStatusSection`：无 sessionPlans 整段缺席；`data-plan-directory-tool-call-id` 锚点；
  缺 `parentSessionId` 时按钮 disabled、补齐后可用。
- `TeamStatusSection`：`data-status-section="agent-teams"`；完成比；团队摘要文案。
- `EndedDirectoryRow` / `EndedSubagentDirectoryRow`：`count <= 0 || !onOpen` 双缺席条件；testid 透传。

**外迁（四个叶子，全部 <400 行）**：

- `v4/conversation-status-panel/StatusSectionShell.tsx`（148 行）：`StatusSectionKind` +
  `STATUS_SECTION_SCROLL_POLICY` + `StatusSectionHeader` + `StatusSection`（类型单一来源迁至叶子）。
- `v4/conversation-status-panel/GitStatusSection.tsx`（114 行）：environment 分区。
- `v4/conversation-status-panel/PlanStatusSections.tsx`（302 行）：计划/Todo 七件（含 HoverCard 折叠预览）。
- `v4/conversation-status-panel/TeamAndEndedSections.tsx`（124 行）：团队分区 + 两个「已结束目录」页脚行。

**未动（下一批，最高风险）**：`ConversationStatusPanelImpl` 的 memo / `miniWidth` ResizeObserver /
variant 门控 / `StatusSummaryRow` 胶囊兜底链；**四个带秒级 tick 的分区**（GoalStatusSection 的
`useNowTicker`、BackgroundWorkStatusSection 与 WorkflowStatusSection 与 SubagentStatusSection 的
`useState(now) + setInterval`）全部留主文件——它们与 desktop-continuous 时序假设强耦，按批次 4
的三阶段路径留到最后一阶段。

测试债登记：`GitStatusSection` 静态渲染需完整 ServiceProvider 桩（GitBranchSwitcher →
useGitBranchSwitcher → useServices；GitActionMenu 同），无 jsdom 且 services 面很大，按固定验收第 4 条
登记为无单测覆盖；其缺席分支由 `ConversationTeamStatusPanel.test.ts` 的整面板渲染间接覆盖。

## 3. 门禁实测

| 门禁 | 结果 | 基线对比 |
|---|---|---|
| `pnpm --filter @acode/ui test` | **1231 pass / 0 fail**（12.5s） | 基线 1125 + 本批新增 106 = 1231 ✓ |
| `npx tsc -p packages/ui/tsconfig.json --noEmit` | **exit 0** | 0 错 ✓ |
| `pnpm typecheck`（仓库级 typecheck-gate） | **通过**（packages / desktop-renderer / cli 三段全 done） | 0 错 ✓ |
| `pnpm lint` | **163 warnings / 0 errors** | 基线 164w/0e，**净减 1**：GitActionMenu 原本未用的 `useRef` import 随弹窗外迁一并清除；触碰文件仅剩 2 条 warning，均为既有项的行号位移：`BotsDialog/shared.tsx` 的未用 `BotWorkspaceRef` 类型（本批未改该文件）、`ConversationStatusPanel.tsx` 的未用参数 `isMobileViewport`（HEAD 即存在，原行 1641 → 现 1025）✓ |
| `pnpm architecture:check --changed` | **new 0 / regrown 0**（violations 34 = baseline 34；legacy over-limit 413，较批次 5 的 413 持平） | ✓ |
| `godComponentLineRatchet.guard.test.mjs` | 绿（含在上条 1231 内） | 上限表 +4 条（628 / 1177 / 1306 / 1093）、−1 条下调（ConversationStatusPanel 2102 → 1486），split-plan 登记表解析互查通过 ✓ |
| L01 台账（`scripts/licenses.mjs reproducibility --inputs-only`） | **2902 项全部相符 ✓** | markdown-table.tsx 单条定点回补（见 §5） |

## 4. 改动文件清单（本批文件集）

主文件（5，均在 packages/ui/src 下）：`GitActionMenu.tsx`、`BotsDialog.tsx`、
`app-shell/AnimatedSidePanePanel.tsx`、`components/ai-elements/markdown-table.tsx`、
`v4/ConversationStatusPanel.tsx`。

新叶子（15）：
- `git-action-menu/`（4）：gitActionMenuDialogsModel.ts / GitCommitDialog.tsx / GitCommitDialogBody.tsx / GitPushDialog.tsx
- `BotsDialog/`（4）：botsDialogModels.ts / BotsDialogSidebar.tsx / BotsDialogCreatePanel.tsx / BotsDialogDetailPanel.tsx
- `app-shell/`（1）：useSidePaneViewportMetrics.ts
- `markdown-table/`（2）：markdownTableTextModel.ts / markdownTableGeometryModel.ts
- `v4/conversation-status-panel/`（4）：StatusSectionShell.tsx / GitStatusSection.tsx / PlanStatusSections.tsx / TeamAndEndedSections.tsx

新测试（7 文件 106 例）：`markdownTableTextModel.test.ts`(14) / `markdownTableGeometryModel.test.ts`(29) /
`gitActionMenuDialogsModel.test.ts`(9) / `botsDialogModels.test.ts`(19) / `botsDialogPanels.test.ts`(7) /
`sidePaneViewportMetrics.test.ts`(7) / `conversationStatusPanelSections.test.ts`(21)。

治理文件：`packages/ui/specs/god-component-split-plan.md`（状态行 + 4 新节 + ConversationStatusPanel 第一阶段小节）、
`packages/ui/tests/godComponentLineRatchet.guard.test.mjs`（上限表 +4 / −1 下调）。

台账文件：`third-party/inventory.json`（**单条定点**：markdown-table.tsx inputs 哈希，diff 1 行）。

## 5. 台账（L01）处理

- 拆分完成后 `node scripts/licenses.mjs reproducibility --inputs-only` 报 **1 项漂移**：
  `packages/ui/src/components/ai-elements/markdown-table.tsx`（既有登记文件的内容哈希不符）——
  属任务书列的「既有登记文件内容哈希不符」情形。
- 按批次 5 验证过的单条定点回补处理：先用 `scripts/third-party-reproducibility.mjs` 的
  `hashSourceText` 同款算法（UTF-8 读出 → `replaceAll("\r\n", "\n")` → sha256）实测
  `48309e23…1745`（本文件为 LF，字节级与归一口径一致），再用 Edit 定点改写 inventory.json 第 1490 行。
  **未整文件重写**，`git diff third-party/inventory.json` 确认为 1 insertion / 1 deletion。
- 复跑 `--inputs-only` → **2902 项全部相符 ✓**。
- **未发现结构性漂移**（无条目缺失、无新增文件需登记）：本批 15 个新叶子都在已有登记根
  `packages/ui/src/components/ai-elements` 之外，不在 `third-party/copied-components.json` 的
  `modifiedFiles`/`roots` 追踪面内；`copied[]` 里的 `markdown-table.tsx` 快照 `sha256` 是**字节级历史
  快照**（`adfaad8d…`），与 inputs 的归一口径不同、且本批未改 `copied-components.json`，故不连带修改。
- 附带观察（非本批产生、不扩面）：批次 5 的 `message.tsx` 回补后，`copied[]` 中该文件的快照仍是
  批次 5 之前的 `262abf74…`——同一口径差异，属台账重生成范畴，交由编排方的 CI Linux 全量重生成统一处理。

## 6. 风险评估与遗留

1. **v4 两件仍未动**（ConversationRowView 2158 / ConversationTimeline 1923）：按任务书纪律留后续批次，
   先做批次 4 式风险评估（Impl/memo/tick/scroll policy 不动，只拆纯函数接缝）。
2. **ConversationStatusPanel 第二阶段候选**：带 tick 的四个分区（Goal / BackgroundWork / Workflow /
   Subagent）现在已有渲染契约测试托底，但它们的 `setInterval` 节律与外层 Impl 的 `miniWidth`
   ResizeObserver 共用同一帧预算——建议先做「tick 策略统一到 useNowTicker」的单独批次，再迁分区；
   `StatusSummaryRow` 胶囊兜底链（10 分支优先级）是第三阶段，需先补一条「分支优先级」契约测试。
3. **GitActionMenu 遗留**：trigger 本体（状态行点击容器 + 三态图标切换）与 5 个 mutation 回调仍在
   主文件 628 行里；下一刀是把这些编排收进 `useGitActionMenuController` hook（模式 B），可再减 ~350 行。
4. **BotsDialog 遗留**：四组轮询 effect（绑定码 / 飞书 / 微信 / 运行态）与 `saveBot` / `refresh`
   编排仍在主文件 1177 行里；它们是同一个「配置写入 + 轮询」闭环，建议整组收进
   `useBotsDialogController` hook，收口时需同时补「轮询取消后不回写」的时序测试。
5. **AnimatedSidePanePanel 遗留**：tab 条 state/effect 簇（溢出判定 + mask + active 滚入视区）与
   20 类 pane 分发是下一批的两个候选；后者外迁需先定 pane props 边界（批次 4 ConversationStatusPanel 同纪律）。
6. **无 jsdom 留白**（固定验收第 4 条口径）：`useViewportInlineIntersectionSize` /
   `useWindowResizeSettling` / `GitStatusSection` / `BotsDialogDetailPanel`（依赖 ProviderSettingsCard
   链路）无单测，依赖 typecheck + 邻接决策表覆盖 + 人工验证。
7. **headless 组件探针结论**（供后续批次复用）：Radix `Collapsible` 在 `renderToStaticMarkup` 下
   **可静态展开**（`open` 状态决定内容是否输出），因此分区渲染契约测试不需要 jsdom；但
   `Dialog` / `HoverCard` 的 Portal 内容在 SSR 下不可见，且 `Dialog` 在最小 DOM shim 下会因
   `react-remove-scroll-bar` 读布局而抛错——弹窗类组件仍只能钉 trigger 侧。

**报告完。**
