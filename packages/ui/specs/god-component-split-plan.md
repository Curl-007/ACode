# v4 上帝组件拆分计划（SessionPane / ConversationComposer / settings 上帝组件）

状态：第一批已实施（2026-10-05，附件预览接缝）；第二批已实施（2026-10-22，SessionPane 命令编排纯决策逻辑抽出 + 接缝内测试）。其余接缝为登记在案的后续批次。
背景：`v4/SessionPane.tsx`（本轮起点 3,762 行，带 max-lines 豁免）与 `v4/ConversationComposer.tsx`
（2,168 行）各自混合多种职责。拆分按「耦合最浅的接缝先行」推进，每批独立验证。

## 已完成（第一批）

- **附件预览接缝**：composer 的 4 个预览 state（图片 gallery index/open、PDF target/open）
  与两个预览弹窗收口进 `v4/composerAttachmentPreview.tsx` 的 `useComposerAttachmentPreview`。
  composer 只持有 `openImagePreviewForSrc` / `openPdfPreview` 两个 controller 并渲染返回的
  dialogs JSX；topContentNode useMemo deps 同步更新（openImagePreviewForSrc 依赖
  composerMediaPreviewItems，items 变化时 controller 换引用，gallery 索引不落在过期列表上）。
  验证：`tsc -b packages/ui` 0 错、ui 测试 79/79、oxlint 触碰文件 0 警告。

## 已完成（第二批：SessionPane 命令编排纯决策接缝，2026-10-22）

- **前置条件已满足**：本批先补命令编排的接缝内测试（下方「登记的后续接缝」表中命令组一行的硬前置），
  再抽接缝。命令编排的**闭包族**（`dispatchCommand`/`snapshotRef`/`lease`/`pendingCommandRegistry`
  与 20+ 个 handler）**保持整体不拆**——豁免头注自辩的「拆散命令组会打散 dispatchCommand/snapshotRef
  的闭包纪律」仍然成立，强行把闭包搬到别的模块需要引入一个巨大的 context 对象或 state 副本，
  违反 AGENTS.md「避免重复状态和多条写入路径」。因此本批只抽**可纯化的决策逻辑**（不触碰闭包/state）：
  - 新建 `v4/session-pane/commandOrchestration.ts`（<400 行，纯函数、无 React、无闭包依赖）：
    - `submissionConfigFromCommand`（逐字迁移，原 SessionPane :367-386）；
    - `resolveQueuedComposerRestore` + `QueuedComposerRestoreTarget`（逐字迁移，原 :397-427）；
    - `shouldRestoreQueuedComposerFromAck`（逐字迁移，原 :429-431）；
    - `resolveEditUserQueryPayload`（新抽：edit 的空内容守卫 + payload 构造，原 handleEdit :2500-2513）；
    - `resolveSlashCommandDispatch`（新抽：slash 的 command.kind→type/payload/withBaseRevision 决策 switch，
      原 dispatchSlashCommand :1884-1937；返回判别联合 `dispatch`/`consumedNoDispatch`/`notConsumed`，
      日志与 dispatch 副作用仍留在 SessionPane 闭包内，行为逐字不变）。
  - 接缝内测试 `test/sessionPaneCommandOrchestration.test.ts`：对以上 5 个纯函数建决策表单测
    （slash 全 kind 分支、edit 空守卫/附件语义、queue restore、ack 恢复判定、submission 提取）。
  - SessionPane 侧：删除 3 个本地纯函数定义 + 把 switch/edit-payload 替换为对纯函数的调用，
    闭包与 state 结构零改动。
- **验收口径（本批）**：SessionPane 行数**单调下降**（3,762 → 见报告实测）；新模块 <400 行；
  命令组 max-lines 豁免**保留**（闭包族仍超限）但更新头注里的行数与「已抽纯决策逻辑」说明，
  不删豁免以免门禁变红；`tsc -p packages/ui/tsconfig.json --noEmit` 触碰文件 0 错；ui 测试全绿。

## 登记的后续接缝（按耦合度从浅到深）

| 接缝 | 位置 | 前置条件 | 状态 |
| --- | --- | --- | --- |
| 提示词历史导航 | composer :1034-1039（state+effect）与 PromptHistoryPlugin | **不能只抽 state**：发送流程（:1129-1179）对 history 有 before/after 快照 + 失败回滚写入，回滚语义必须与发送编排一起迁移；先给发送失败回滚补交互测试再动 | 未动 |
| 模型配置选择器 | composer configPickerState 簇 | 与草稿持久化交互面需先理清 | 未动 |
| 排队确认（heldQueueConfirmation） | composer :559 一带 | 与发送控制簇共用状态，随发送编排批次处理 | 未动 |
| SessionPane 命令组（纯决策逻辑） | dispatchSlashCommand / handleEdit / queue restore | 命令编排接缝内测试 | **第二批已抽**（见上）；闭包族整体保留 |
| SessionPane 命令组（闭包族） | dispatchCommand/snapshotRef/lease + 20 handler | 需要先把 lease/pendingCommandRegistry 生命周期收进一个显式 controller（含交互测试），才能整体搬；风险高，单独批次 | 未动（本批刻意不碰） |

> 下一批建议顺序：① 提示词历史（先补发送失败回滚交互测试）→ ② 模型配置选择器 → ③ 排队确认
> → ④ SessionPane 命令闭包族（需先做 lease controller 抽象，风险最高，最后）。

## settings 上帝组件拆分计划（2026-10-22 登记，仅计划不改码）

> 这 3 个文件本轮**只登记计划**（另一代理正在改 settings 目录的按钮/字号，避免冲突）。
> 三者都已把大量**纯函数**堆在文件顶部（helper 与组件同文件），拆分第一刀都是「helper 外迁 + 单测」，
> 与 SessionPane 第二批同构，风险低。

### `settings/AutomationEditView.tsx`（2,942 行；27 state / 12 effect / 16 memo / 11 callback）

- 职责分析：单文件混合「cron/自定义重复排程编辑器 + 时间/星期/月日选择器 + 表单 schema + 操作按钮簇 +
  运行历史分页」。顶部已有 ~15 个纯 helper（`buildRunsPageItems`/`workspaceLabelFromPath`/`daysInMonth`/
  `toDateInputValue`/`localDateEndTimestamp`/`parseDateInputValue`/`resolveRunStatus`/
  `normalizeAutomationScheduleRule`/`defaultBuilder`/`initialBuilder`）与多个纯展示子组件
  （`TimeUnitColumn`/`TimeOfDayPicker`/`ScrollNumberColumn`/`MonthDayPicker`/`WeekdayPicker`/
  `EndDatePicker`/`CustomRepeatDialog`）。
- 建议接缝（从浅到深）：
  1. **纯 helper 外迁** → `settings/automation/scheduleModel.ts`（排程规则/日期解析/分页），补决策表单测；
  2. **日期/时间选择器族** → `settings/automation/pickers/`（TimeOfDayPicker/MonthDayPicker/WeekdayPicker/
     EndDatePicker/CustomRepeatDialog 各自成文件，纯展示 + 受控 props）；
  3. **cron builder state 机** → `settings/automation/cronBuilder.ts`（defaultBuilder/initialBuilder +
     规约 reducer），把 27 state 里属于 builder 的收敛成单一 reducer；
  4. **操作按钮簇** → 复用 `components/ui/button.tsx`（与 P2 的按钮/焦点环修复合并做）。
- 前置测试：scheduleModel 与 cronBuilder 的纯函数单测（第一刀前建）；选择器族用 renderToStaticMarkup 钉受控渲染。
- 预估批次：3 批（helper 外迁 → 选择器族拆分 → cron builder reducer 收敛）。

### `settings/SubagentsSection.tsx`（2,671 行；34 state / 6 effect / 22 callback / 17 memo）

- 职责分析：列表 + 编辑表单 + 详情混合；顶部已有 ~20 个纯 helper（`projectSettingsSubagents`/
  `isEditableUserAgent`/`isBundledPresetAgent`/`supportsEnabledToggle`/`isBuiltInAgent`/
  `supportsModelOverride`/`getBuiltInSubagentName`/`mergeTools`/`allowsAllTools`/`toPersistedModel`/
  `toSubagentModelValue`/`toSubagentModelSelection`/`resolveSubagentThoughtOptionState`/
  `isSubagentThoughtLevelAvailable`/`resolvedSubagentThoughtLevel`/`isSubagentModelAvailable`/
  `createSubagentFormInitialState`/`createSubagentFormInitialStateKey`/`resolveSubagentModelLabel`）。
- 建议接缝：
  1. **纯 helper 外迁** → `settings/subagents/agentModel.ts`（能力判定 + 工具合并 + 模型/思考档位解析 +
     表单初值），补决策表单测；
  2. **列表** → `settings/subagents/SubagentList.tsx`；**编辑表单** → `settings/subagents/SubagentForm.tsx`
     （34 state 按列表选择态 / 表单草稿态拆到两个组件，避免单文件持有全部）；
  3. **详情面板** → `settings/subagents/SubagentDetail.tsx`。
- 前置测试：agentModel 纯函数单测（能力矩阵、工具合并去重、模型档位可用性、表单初值 key 稳定性）。
- 预估批次：3 批（helper 外迁 → 列表/表单拆分 → 详情拆分）。

### `settings/AutomationsSection.tsx`（1,979 行；8 state / 11 effect / 22 callback / 2 memo）

- 职责分析：列表容器 + tab 可见性/导航决策 + 操作菜单 + 本地 `toast` 包装；顶部已有 ~15 个纯 helper
  （`resolveVisibleAutomationTabs`/`resolveAutomationTabAfterOffPeakChange`/`resolveAutomationTabNavigation`/
  `resolveAutomationTemplateVisibility`/`automationPromptSummary`/`canRestartAutomation`/`canToggleAutomation`/
  `getAutomationRunNowToastId`/`getAutomationActionErrorToastId`/`getAutomationCreateErrorToastId`/
  `resolveAutomationDetailTarget`/`resolveAutomationDetailNavigation`/`isOffPeakDetailNavigationId`/
  `resolveOffPeakDetailNavigation`）与子组件（`OffPeakCreateButton`/`AutomationActionsMenu`/
  `AutomationStatusFilterEmpty`）。
- 建议接缝：
  1. **纯 helper 外迁** → `settings/automations/navigationModel.ts`（tab 可见性/导航/详情路由/toast id），
     补决策表单测；与 AutomationEditView 共用抽象（两者都有排程/导航概念）；
  2. **操作菜单** → `settings/automations/AutomationActionsMenu.tsx`；
  3. **列表 + 空态** → `settings/automations/AutomationList.tsx`。
- 前置测试：navigationModel 纯函数单测（tab 可见性矩阵、off-peak 变更后 tab 落点、详情导航 id 判定）。
- 预估批次：2 批（helper 外迁 → 菜单/列表拆分）。

## 测试债清单（结构守护测试，非行为验证）

ui 测试无 jsdom 套件（node:test + `renderToStaticMarkup` 纯 .ts）。以下测试用 `readFileSync` 钉源码结构，
**无法在无 DOM 环境下升级为真实行为验证**，保留但加中文注释标注「结构守护测试，非行为验证」：

- `test/splitPaneErrorIsolation.test.ts`：**已部分升级**——错误边界的**捕获行为**（子组件抛错 →
  getDerivedStateFromError 归一化 → fallback 渲染出 role=alert，无错时 children 透传，resetKeys 变化清错）
  改为对 `ScopedErrorBoundary` 实例的真实断言；但「边界在 WorkbenchPane 树中的**放置层次**」仍需读源码钉
  （观察 React 树嵌套需 jsdom），这部分保留为结构守护并加注释。
- 其余 11 个 `readFileSync` 测试（chatRowFactsSurface / workflowRunDialectGate / scriptWorkflowSurface /
  genUiVisualizeCard / usageBarLayoutR5 / subagentBatchWiring / runWorkflowRenderer / toolSearchSurface /
  modelProviderDiscovery / providerApiKeyReveal / queueGuideFellbackNotice）：逐个核实——能改为
  renderToStaticMarkup/纯函数断言的升级；确实只能钉 DOM 结构或 import 接线的保留 + 注释。见报告实测计数。

## 每批拆分的固定验收

1. 逐字迁移优先：state/回调搬进新模块，composer 侧只留 controller 与 JSX 插槽；
2. 消费方 useMemo/useCallback deps 同步更新（React hooks 完整性由 typecheck + lint 保障，deps 遗漏靠本清单第 3 条兜底）；
3. `tsc -p packages/ui/tsconfig.json --noEmit` 触碰文件 0 错 + `pnpm --filter @acode/ui test` 全绿 + 触碰文件 oxlint 0 新增警告；
4. 涉及交互语义的批次（发送、排队、命令编排）必须先补交互测试或附人工验证记录（AGENTS.md E2E 要求）；
   无 jsdom 时以「提取纯函数 + 决策表单测」为接缝内测试的可行替代，并如实登记；
5. 拆分不得改变 max-lines 豁免的现状语义：新模块自身必须 <400 行（架构 ratchet），豁免只允许随拆分收窄，不允许复制到新文件。
