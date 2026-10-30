# 上帝组件拆分 · 批次 7 实施报告（packages/ui 拆分波：GitActionMenu / BotsDialog / AnimatedSidePanePanel tab 条 / ConversationStatusPanel 第二阶段）

日期：2026-10-30（Asia/Shanghai）。基线：`fix/project-review-2026-10-26` worktree（HEAD `03acb2ae`，批次 6 之后，CI 全绿）。
方法：照批次 5/6 的纪律执行——模式 A（纯决策逻辑外迁 + 决策表/时序单测）+ 模式 B（controller hook 收口）；
弹窗与面板按批次 4 的「闭包 → 受控组件」样板外迁；tick 统一属**行为保持的重构**，契约测试先行钉住渲染与节奏语义。
**本批仍不含 v4 两件**（ConversationRowView 2158 / ConversationTimeline 1923），按批次 4 纪律留给后续批次单独风险评估。

输入：
- 拆分计划：[../../../packages/ui/specs/god-component-split-plan.md](../../../packages/ui/specs/god-component-split-plan.md)（本批四节标已实施，GitActionMenu 跌破 400 后撤销 ratchet 登记）
- ratchet 守护：[../../../packages/ui/tests/godComponentLineRatchet.guard.test.mjs](../../../packages/ui/tests/godComponentLineRatchet.guard.test.mjs)（−1 条移除、3 条下调、1 条新增口径）
- 前序报告：[../2026-10-29/god-component-batch-6.md](../2026-10-29/god-component-batch-6.md) / [../2026-10-28/god-component-batch-5.md](../2026-10-28/god-component-batch-5.md) / [batch-4.md](../2026-10-28/god-component-batch-4.md)

选题理由：全部取自批次 6 报告 §6「风险与遗留」登记的批次 7 线索（任务书口径），取可行 4 件：
GitActionMenu 编排收口（线索 3）、BotsDialog 轮询闭环收口（线索 4，**含点名的取消时序测试**）、
AnimatedSidePanePanel tab 条簇（线索 5，pane 分发按口径留批次 8）、ConversationStatusPanel 第二阶段
（线索 2 + 批次 4/6 点名的胶囊分支契约）。

---

## 1. 结果总览（行数均为物理行实测，口径同 ratchet 守护 `countPhysicalLines`）

| 主文件 | 拆前 | 拆后 | 减量 | 新叶子数 | 新测试用例 |
|---|---:|---:|---:|---:|---:|
| `GitActionMenu.tsx` | 628 | **188** | −440 | 3 | 18 |
| `BotsDialog.tsx` | 1177 | **469** | −708 | 6 | 18 |
| `app-shell/AnimatedSidePanePanel.tsx` | 1306 | **1083** | −223 | 1 | 13 |
| `v4/ConversationStatusPanel.tsx`（第二阶段） | 1486 | **612** | −874 | 8 | 54 |
| **合计** | 4597 | **2352** | **−2245** | **18** | **103** |

18 个新叶子全部 <400 物理行（固定验收第 5 条），最大 397 行（`useGitActionMenuController.ts`，controller 首版 563 行的第二刀）。

**超 400 tsx 计数：115 → 114（−1，本批首次反超拆分动能）**。口径：`find packages/ui/src -name '*.tsx'` 逐文件
`countPhysicalLines`（同 ratchet 定义），HEAD 实测 115、工作树实测 114——`GitActionMenu.tsx` 188 行**跌破 400**，
按固定验收第 6 条计入拆分进度（批次 1-6 均为内部修剪，从未跨阈值）。其余三个主文件仍 >400。

## 2. 各组件明细

### 2.1 `GitActionMenu.tsx`：628 → 188（−440，**跌破 400**）

主文件从「state + 编排 + JSX」三合一收敛为「props 契约 + trigger JSX + 两弹窗接线」。

- `git-action-menu/gitActionMenuCommitFlow.ts`（99 行，纯函数）：从 async 编排里抽出**判定部分**——
  `resolveCommitStagePlan`（includeUnstaged 的 stagePaths/pathsToStage 投影，去重口径沿用
  `getCommitDialogStagePaths`）/ `resolveCommitPreflight`（identity → no-changes → ready 三态，**顺序不可交换**）/
  `shouldGenerateCommitMessage`（trim 为空才自动生成）/ `resolveCommitSuccessToastId` /
  `resolveCommitFailureErrorId`（已提交但 push 失败用专用 key，不误导重试提交）/ `resolveTriggerIconKind` /
  `resolveTriggerDisabled`。副作用（RPC / setState / logger / toast）一律不进本叶。
- `git-action-menu/useGitActionMenuCommitDialog.ts`（267 行）：提交弹窗 7 个 state +
  `closeCommitDialog` / `loadCommitDialogState` / `openCommitDialog` / `refreshCommitDialogAfterBranchChange` /
  `generateCommitMessage` / `handleGenerateCommitMessage`；hook 顺序与 useCallback deps 逐字。
- `git-action-menu/useGitActionMenuController.ts`（397 行）：controller 首版 563 行超 400 的**第二刀**——
  只留 trigger 派生（`actionAvailable` / `primaryActionId` / `triggerPending` / `primaryActionDisabled`）+
  可用性日志 effect + push 弹窗 + `handleCommitAction` 编排 + `handlePrimaryAction`。
- 主文件保留：`GitActionMenuProps`、trigger 容器与按钮（三态图标抽成受控小组件
  `GitActionMenuTriggerIcon`）、两个弹窗的 props 接线。**导出面不变**（`GitActionMenu` 仍从
  `@/GitActionMenu.js` 导出，ConversationStatusPanel 等消费方零改动）。
- 偏离登记：`handlePrimaryAction` 原为一个 IIFE 包着两个分支，改为等价直写（无行为变化）；
  `primaryActionDisabled` 由内联表达式改为 `resolveTriggerDisabled` 调用（同谓词）；判定顺序在
  `handleCommitAction` 内显式化为「先算 stagePaths → 再 identity → 再 no-changes」，与迁移前逐字一致
  （原实现 identity 判定在 stagePaths 之前但两者互不依赖，本批按可读性合并到同一份 stagePaths）。
- 测试：`test/gitActionMenuCommitFlow.test.ts` **18 例**（暂存计划两态与去重 / 前置门四种组合 /
  自动生成条件 / 成功与失败 key 全组合 / 三态图标 / 禁用三条件）。

### 2.2 `BotsDialog.tsx`：1177 → 469（−708）

四组轮询 + 配置写入闭环整组收 controller hook，**并把「轮询取消后不回写」收成可测原语**（批次 6 点名）。

- `BotsDialog/botsDialogPolling.ts`（212 行）：`createCancellablePollLoop`（`interval` 固定节拍 /
  `serial` 串行自调度）+ 六条守卫（`shouldTickBindCountdown` / `shouldPollBindResult` /
  `shouldCollapseBindCode` / `shouldPollWeixinActivation` / `shouldPollFeishuRegistration` /
  `shouldPollWeixinRegistration`）+ `resolveBindCountdown`。原实现四处手写的
  `let cancelled = false` + timer 清理 + `if (cancelled) return;` 收成原语的一部分：
  `stop()` 后不再触发新 run，**在途 run 通过 `isCancelled()` 放弃写回**。计时器可注入，因此无 DOM 也能测时序。
- `BotsDialog/useBotsDialogData.ts`（112 行）：config / status / workspaceRefs / botStates /
  selectedBotId / creatingBot / configLoaded 七 state + `refresh`（deps 含 `creatingBot`：新建流程中不能被
  首条配置抢走选中项）+ `currentWorkspace` / `selectedBot` 派生。
- `BotsDialog/useBotsDialogActions.ts`（357 行）：`saveBot`（配置写入**唯一入口**）+ 字段补丁 / 重命名草稿
  （IME Enter 不提交、Esc 只取消编辑的语义逐字）/ 凭据与企业微信保存 / 解绑 / 删除 / 工作区访问范围
  （乐观更新 + 失败回滚）/ 新建 Bot。
- `BotsDialog/useBotsDialogRegistrations.ts`（172 行）：`bindCode` / `feishuRegistration` /
  `weixinRegistration` 三个临时状态与发起入口（二维码 data URL 生成失败只记日志、保留 qrUrl 兜底）。
- `BotsDialog/useBotsDialogBindCodePolling.ts`（104 行）+ `useBotsDialogStatusPolling.ts`（343 行）：
  首版单文件 `useBotsDialogPolling.ts`（414 行）超 400 的**第二刀**——按「只碰 bindCode/nowMs」与
  「只碰 status/botStates/扫码注册」两组**互不写入**的状态切开，各自独立启停。
- **依赖纪律**：两个轮询 hook 只接受原始值 / 稳定回调作入参，**绝不以聚合对象作 effect 依赖**——
  否则每次 render 新对象都会重启轮询（原注释警告的「毫秒级 RPC 风暴」）。宿主侧的凭据重置 effect 与
  入口渠道 effect 同样改为直接引用稳定 setter，而不是穿过聚合对象 `actions`（见 §6 的回归记录）。
- 主文件保留：四 hook 接线、自动连接 effect（决策表仍来自批次 6 的 `resolveBotAutoConnectAction`）、
  入口渠道 effect、`renderChannelName`、三段 UI 编排。
- 偏离登记：`useBotsDialogStatusPolling` 不再自己 `refresh()`——打开弹窗的配置加载留在宿主 effect
  （与 `configLoaded` 复位同一处），避免出现第二条配置写入路径。
- 测试：`test/botsDialogPolling.test.ts` **18 例**，其中 **5 例是时序测试**（假计时器驱动）：
  ① interval 立即先跑一次；② 到点触发；③ **stop() 清理定时器不再触发 run**；
  ④ **在途 run 在 stop 后放弃写回（取消后不回写）**；⑤ 对照组（未取消时正常写回，防测试恒真）；
  ⑥ serial 首轮未落定不排下一次；⑦ **serial 并发上限恒为 1（不堆叠 RPC）**；⑧ **serial stop 后不排下一次**。
  另 10 例为守卫决策表与倒计时读数边界（含 30 秒有效期与时钟回拨的 100% 上限）。

### 2.3 `app-shell/AnimatedSidePanePanel.tsx`：1306 → 1083（−223）

- `app-shell/useSidePaneTabStrip.ts`（365 行）：tab 条的全部 state / ref / effect 收口——
  溢出判定（RAF 合并 + ResizeObserver 反馈环规避，原注释逐字保留）、两侧渐变 mask、
  active tab 滚入视区（按真实 DOM 宽度而非固定估算）、收起/展开内容锁宽（200ms 后解除）、tab 拖拽态。
  effect 体内抽出的两个纯函数导出以便单测：`resolveTabsScrollMaskEdges`（mask 与 scrollLeft 绑定 + 1px 容差）
  与 `resolveLockedContentWidthPx`（收起锁当前宽 / 首次展开按分组宽 × 默认比例，宽度读不到时不锁成 0）。
- **pane 分发未动**：20 类 pane 的 props 边界尚未定义，按任务书口径只做 tab 簇，pane 分发登记为**批次 8**。
  本 hook 与 pane 渲染零耦合（只依赖 `visibleTabs` / `visibleActiveTabId` / `isVisible` 三个外部输入）。
- 主文件保留：`SuspendedBrowserSidePaneContent`（residency ack）、add-tab 菜单与 open-tab launcher JSX、
  pane 类型分发、`resolveAnimatedSidePanePanelLayout` 布局分支。
- 偏离登记：`readInitialExpandedContentWidthPx` 收进 `resolveLockedContentWidthPx` 的 expand 分支
  （同公式、同守卫，只是把「上一次锁宽优先」的 `??` 语义显式化）。
- 测试：`test/sidePaneTabStrip.test.ts` **13 例**（mask 六态含端点与亚像素容差 / 锁宽七态含 0 宽度、
  NaN 与取整）。hook 本体依赖 window + ResizeObserver + rAF，无 jsdom 不测，按固定验收第 4 条登记。

### 2.4 `v4/ConversationStatusPanel.tsx`：1486 → 612（−874，第二阶段）

**先补契约测试，再动代码**（批次 4 三阶段路径的第二步）。

**前置契约（25 例，先于实现跑绿）**：
- `test/conversationStatusPanelTicks.test.ts`（**9 例**）：四条「该不该开表」条件（Terminals / Agents 非空即开、
  Workflows 需有 startedAt、Goal 需可暂停三态 + activeRunStartedAtMs）+ 收起态耗时口径（0ms 显示 1 秒、
  向下取整）+ workflow 无 startedAt 不显示时长。这是 tick 统一的**节奏语义基线**。
- `test/conversationStatusPanelTickSections.test.ts`（**16 例**）：四个分区迁移后的 renderToStaticMarkup 结构锚点
  （Goal 三态控制 / Terminals 空态与收起态 / Workflows 偏斜降级行与已结束页脚 / Agents 排序与双交互层）。

**tick 统一（行为保持的重构）**：四个分区原先各自 `useState(now) + setInterval(1000)`（「关」写在 effect early return
里，无法单测），全部改为 `useNowTicker(谓词)` 单点驱动。节律不变（仍 1000ms 自然粒度）；`useNowTicker` 在
`active=false` 时不建定时器、变真时先重取一次 now（与四组原实现共同语义一致）。
**未新建 hook**：`useNowTicker` 已存在于 `components/workflow-graph/use-now-ticker.ts`，已被
WorkflowRunSidePaneSections / eval-workflow-snippet / 本面板 Goal 分区使用；它是**纯本地定时器**，
不写 store、不参与广播，因此不涉及广播/回环纪律。

**外迁（8 个叶子，全部 <400 行）**：
- `conversationStatusPanelTicks.ts`（66 行）：四个 `shouldTick*` 谓词 + 两个收起态耗时口径。
- `StatusActivityRows.tsx`（106 行）：`RunningWorkCancelButton` + `RunningStatusItem`（三处分区共用，
  也是各分区 <400 行的前提；双交互层约定写进文件头）。
- `GoalStatusSection.tsx`（151 行）/ `BackgroundWorkStatusSection.tsx`（99 行）/
  `WorkflowStatusSection.tsx`（230 行）/ `SubagentStatusSection.tsx`（172 行）：四个秒级分区逐字迁入
  （Workflows 的三簇缺席、不排序、已结束页脚注释；Agents 的 startedAt 排序与详情/Stop 双交互层均逐字保留）。
- `statusSummaryCapsuleModel.ts`（170 行）：**第三阶段前置**——把 10 分支三元链收成
  `StatusSummaryCapsuleKind` 判别联合 + `STATUS_SUMMARY_CAPSULE_PRIORITY`（顺序即产品行为）+
  `resolveStatusSummaryCapsuleKind` 单入口 + 图标族/计数文案决策。
- `StatusSummaryRow.tsx`（255 行）：只做「按 kind 渲染」，每分支的图标/文案/数值逐字迁移。

**胶囊分支优先级契约（批次 4/6 点名的第三阶段前置，29 例）**：
- `test/conversationStatusPanelCapsule.test.ts`（**21 例**）：优先级全序（10 个 kind 的数组顺序）+ 每个 kind
  都能被某模型命中（无死分支）+ 相邻分支覆盖关系（team > current-plan > active-goal > git > done-goal >
  completed-plan > plan-count > session-plan > running-count > ended-workflows）+ 空模型整段缺席 +
  active goal 四种合法开放态（含 notSatisfied）+ 实时活动图标族（恰好一类 vs 混合 Activity）与计数文案。
- `test/conversationStatusPanelCapsuleRender.test.ts`（**8 例**）：各分支可见锚点与空模型不输出空壳按钮。

**未动**：`ConversationStatusPanelImpl` 的 memo / `miniWidth` ResizeObserver / variant 门控 / 分区编排 JSX
（含团队卡折叠）/ 面板菜单。导出面不变。

## 3. 门禁实测

| 门禁 | 结果 | 基线对比 |
|---|---|---|
| `pnpm --filter @acode/ui test` | **1334 pass / 0 fail**（15.5s） | 基线 1231 + 本批新增 103 = 1334 ✓ |
| `npx tsc -p packages/ui/tsconfig.json --noEmit` | **exit 0** | 0 错 ✓ |
| `pnpm lint` | **164 warnings / 0 errors** | 基线 163w/0e → **净增 1**，原因见下 ✓（触碰文件零新增） |
| 触碰文件 oxlint | **2 warnings / 0 errors** | 两条均为既有项的行号位移：`BotsDialog/shared.tsx` 未用 `BotWorkspaceRef`（本批未改该文件）、`ConversationStatusPanel.tsx` 未用参数 `isMobileViewport`（HEAD 即存在）✓ |
| `godComponentLineRatchet.guard.test.mjs` | 绿（含在上条 1334 内） | 上限表 −1（GitActionMenu 跌破 400 移除）、3 条下调（469 / 1083 / 612）✓ |
| L01 台账（`scripts/licenses.mjs reproducibility --inputs-only`） | **2904 项全部相符 ✓** | 零漂移（本批候选均不在 ai-elements 追踪面内） |

`pnpm lint` 净增 1 的如实说明：全仓 164w 中与本批文件相关的只有上面两条既有项；另 1 条新增落在
`packages/ui/src/root/useRootPlatformEffects.ts`（6 条警告）——该文件**不在本批改动集内**（`git status` 未列出），
属工作树中已存在的其它改动/基线漂移，按任务书「不要跑全仓门禁核对、只确认触碰文件」的口径如实记录、不改动。

## 4. 改动文件清单（本批文件集）

主文件（4，均在 packages/ui/src 下）：`GitActionMenu.tsx`、`BotsDialog.tsx`、
`app-shell/AnimatedSidePanePanel.tsx`、`v4/ConversationStatusPanel.tsx`。

新叶子（18）：
- `git-action-menu/`（3）：gitActionMenuCommitFlow.ts / useGitActionMenuCommitDialog.ts / useGitActionMenuController.ts
- `BotsDialog/`（6）：botsDialogPolling.ts / useBotsDialogData.ts / useBotsDialogActions.ts /
  useBotsDialogRegistrations.ts / useBotsDialogBindCodePolling.ts / useBotsDialogStatusPolling.ts
- `app-shell/`（1）：useSidePaneTabStrip.ts
- `v4/conversation-status-panel/`（8）：conversationStatusPanelTicks.ts / StatusActivityRows.tsx /
  GoalStatusSection.tsx / BackgroundWorkStatusSection.tsx / WorkflowStatusSection.tsx /
  SubagentStatusSection.tsx / statusSummaryCapsuleModel.ts / StatusSummaryRow.tsx

新测试（7 文件 103 例）：`gitActionMenuCommitFlow.test.ts`(18) / `botsDialogPolling.test.ts`(18) /
`sidePaneTabStrip.test.ts`(13) / `conversationStatusPanelTicks.test.ts`(9) /
`conversationStatusPanelTickSections.test.ts`(16) / `conversationStatusPanelCapsule.test.ts`(21) /
`conversationStatusPanelCapsuleRender.test.ts`(8)。

治理文件：`packages/ui/specs/god-component-split-plan.md`（状态行 + 四节标批次 7 已实施；GitActionMenu 标题
去掉 `### \`<path>.tsx\`（` 登记标记形式以免触发「防漏登记」断言）、
`packages/ui/tests/godComponentLineRatchet.guard.test.mjs`（−1 移除 / 3 条下调）。

台账文件：**零改动**（`third-party/inventory.json` 与 `copied-components.json` 均未触碰；
`git status` 确认 third-party/ 无改动）。

## 5. 台账（L01）处理

- 拆分前后各跑一次 `node scripts/licenses.mjs reproducibility --inputs-only`，均报
  **2904 项源文件哈希全部相符**，无既有登记文件漂移、无结构性漂移。
- 原因：本批候选（GitActionMenu / BotsDialog / AnimatedSidePanePanel / ConversationStatusPanel）及其全部新叶子
  均**不在** `third-party/copied-components.json` 的 `roots`（`packages/ui/src/components/ui` /
  `packages/ui/src/components/ai-elements` / `.agents/skills/ai-elements`）追踪面内，因此未产生 inputs 哈希变化。
- 本批未改动 `third-party/` 任何文件（含 inventory.json），无需定点回补，也无需声明新的追踪面文件。

## 6. 回归记录（实施中自查发现并已修复）

1. **BotsDialog 依赖数组回归（已修复）**：首版宿主把聚合对象 `actions` 放进
   `useEffect` / `useCallback` 的 deps。`actions` 每次 render 都是新对象，会让「切换选中 Bot 时重置凭据输入」
   的 effect **每帧重跑**——用户在凭据框里根本无法输入（每敲一个字符就被清空）。修复：宿主直接解构并使用
   稳定 setter（`setCredentialValue` / `setSecretSaving` / `setWorkspaceAccessSaving` / `setCreatingProvider`），
   从 deps 移除聚合对象。行数因此从 465 回到 469，ratchet 上限已同步为实测值。
2. **SubagentStatusSection 排序 memo 丢失（已修复）**：首版把 `useMemo` 降级为内联 `[...].sort()`。
   投影每帧可能换引用，内联排序会每帧重排。已恢复 `useMemo`（与迁移前一致）。
3. **GitActionMenu 判定顺序显式化**：`handleCommitAction` 首版把 `stagePaths` 算两次（一次给 preflight、
   一次给提交），已合并为单次计算；identity 判定仍先于 no-changes（与原实现一致，测试已钉住该顺序）。

## 7. 换题/留批次 8 的件及原因

1. **AnimatedSidePanePanel 的 20 类 pane 分发**：未拆。原因——20 类 pane 的 props 边界（每类 pane 需要哪些
   宿主回调、哪些是可选 spread、哪些依赖 `visibleActiveTabId`/`isVisible` 组合）尚未定义；按批次 4
   ConversationStatusPanel 同纪律「先定义叶子 props 类型边界再外迁」，登记为**批次 8**候选（本批只做 tab 簇，
   如实按任务书口径换题）。
2. **v4 两件（ConversationRowView 2158 / ConversationTimeline 1923）**：继续排除。按批次 4 纪律
   「单独风险评估后再做」，本批不碰。
3. **ConversationStatusPanel 第三阶段剩余**：`ConversationStatusPanelImpl` 的 memo / `miniWidth` ResizeObserver /
   variant 门控 / 分区编排 JSX 仍在主文件 612 行。胶囊分支链的**契约前置**已在本批完成（29 例），
   下一步可安全动 Impl 投影（建议单独批次）。

## 8. 风险与未尽事项

1. **无 jsdom 留白**（固定验收第 4 条口径）：`useSidePaneTabStrip`（window/ResizeObserver/rAF）、
   `useBotsDialogBindCodePolling` / `useBotsDialogStatusPolling`（React effect 装配，轮询原语本身已用假计时器测）、
   `useBotsDialogData/Actions/Registrations`、`useGitActionMenuController/CommitDialog` 无单测，
   依赖 typecheck + 决策表/时序表覆盖 + 邻接渲染契约 + 人工验证。若后续引入 jsdom 套件应优先补这些。
2. **BotsDialog 时序测试覆盖到原语而非装配**：`botsDialogPolling.test.ts` 验证的是
   `createCancellablePollLoop` 的取消/串行语义（这正是批次 6 点名的「轮询取消后不回写」），
   但「哪个 hook 在什么条件下调用 start/stop」仍需人工核对——两个轮询 hook 的守卫谓词已有决策表，
   装配层由 typecheck 与人工验证兜底。
3. **GitActionMenu 跌破 400 后撤销 ratchet 登记**：该文件此后由架构棘轮的「HEAD≤400 → 工作树>400 跨越」规则兜住。
   若后续再增长到 >400，会触发 `legacy-over-limit` 新违规（不可被 baseline 吸收），因此仍受门禁约束；
   但**在 188–400 区间内增长不再有上限**（这是 ratchet 登记表的既定语义，非本批引入）。
4. **ConversationStatusPanel 612 行仍 >400**：本批按 split-plan 口径属内部修剪，已跨第一阶段与第二阶段；
   剩余 Impl 投影段是第三阶段，需先做 memo/ResizeObserver 的时序评估。
5. **`pnpm lint` 全仓 164w 中的 1 条新增**落在非本批文件（`useRootPlatformEffects.ts`），如实记录未处理
   （并发代理/worktree 既有改动，不在本代理改动面内）。
6. **测试口径**：本批 103 例含 21 例时序/决策表 + 24 例渲染契约（SSR renderToStaticMarkup）+ 58 例纯决策表。
   时序测试用**注入假计时器**（无 wall-clock 依赖），因此稳定、不 flaky。

**报告完。**
