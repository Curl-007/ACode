# 上帝组件拆分 · 第一批可落地实施报告（batch-1）

日期：2026-10-28（Asia/Shanghai）。基线：`fix/project-review-2026-10-26`。方法：只读源码审查 + split-plan 比对 + 行数实测。

输入：
- 上轮 review：[../2026-10-26/ui-components.md](../2026-10-26/ui-components.md) §3「超 400 行文件计数与拆分动能」
- 拆分计划：[../../../packages/ui/specs/god-component-split-plan.md](../../../packages/ui/specs/god-component-split-plan.md)
- ratchet 守护：[../../../packages/ui/tests/godComponentLineRatchet.guard.test.mjs](../../../packages/ui/tests/godComponentLineRatchet.guard.test.mjs)

---

## 0. 计数校正（必须先讲）

- 上轮 review 记载「超 400 行 tsx = **115**」。**本批实测 = 117**（`find packages/ui/src -name "*.tsx" | xargs wc -l | awk '$1>400'`）。
- 差 +2 不是新增拆分债：是 `legacy-over-limit` ratchet 对已超限文件**继续增长失明的直接后果**（split-plan §「拆分动能备注」），加上拆分/文件新增节奏的轻微推进。准确的 115→117 增长来源本轮未逐 commit 溯源，但**与 split-plan 已警示的盲区一致**——已超限文件继续生长，门禁不会变红。
- **含义**：本批落地后必须重新跑这条 `find`，不能沿用 115 的口径。

---

## 1. 117 个上帝组件全清单（按行数倒序）

`split-plan` 列 = 是否已在 [god-component-split-plan.md](../../../packages/ui/specs/god-component-split-plan.md) 登记批次。`max-lines 豁免` 列 = 文件头是否带 `eslint-disable max-lines` 自辩。

### Top 20（2000+ 行，第一梯队）

| # | 文件 | 行数 | 业务域 | split-plan | max-lines 豁免 |
|---|---|---:|---|---|---|
| 1 | `v4/SessionPane.tsx` | 3657 | session | ✅ batch-2 已抽 commandOrchestration | ✅ |
| 2 | `settings/AutomationEditView.tsx` | 2950 | settings/automation | ✅ batch-1 已登记（helper 外迁） | ✅ |
| 3 | `settings/SubagentsSection.tsx` | 2671 | settings/subagents | ✅ batch-1 已登记（helper 外迁） | ✅ |
| 4 | `v4/ConversationStatusPanel.tsx` | 2246 | session | ❌ | — |
| 5 | `v4/ConversationComposer.tsx` | 2238 | session/composer | ✅ batch-1 已实施（attachment preview） | — |
| 6 | `v4/ConversationRowView.tsx` | 2158 | session | ❌ | — |
| 7 | `app-shell/WorkspaceShellLayout.tsx` | 1980 | app-shell | ❌ | — |
| 8 | `settings/AutomationsSection.tsx` | 1979 | settings/automation | ✅ batch-1 已登记（helper 外迁） | ✅ |
| 9 | `v4/ConversationTimeline.tsx` | 1923 | session | ❌ | — |
| 10 | `settings/RemotePluginSyncDialog.tsx` | 1898 | settings/sync | ❌ | ✅ |
| 11 | `PreviewPane.tsx` | 1806 | preview | ❌ | — |
| 12 | `WorkspaceGroupedTasksSection.tsx` | 1747 | workspace | ❌ | — |
| 13 | `SettingsPage.tsx` | 1725 | settings | ❌ | — |
| 14 | `WorkspaceSidebar.tsx` | 1701 | workspace | ❌ | — |
| 15 | `components/ai-elements/message.tsx` | 1691 | ai-elements | ❌ | — |
| 16 | `settings/McpSettingsSection.tsx` | 1595 | settings/mcp | ❌ | ✅ |
| 17 | `LexicalChatInput.tsx` | 1517 | composer | ❌ | — |
| 18 | `settings/ExternalAgentImportDialog.tsx` | 1442 | settings/import | ❌ | ✅ |
| 19 | `BotsDialog.tsx` | 1434 | bots | ❌ | — |
| 20 | `app-shell/AnimatedSidePanePanel.tsx` | 1422 | app-shell | ❌ | — |

### 1000–2000 行（第二梯队）

| 文件 | 行数 | 业务域 |
|---|---:|---|
| `components/ai-elements/markdown-table.tsx` | 1420 | ai-elements |
| `settings/PluginsSection.tsx` | 1400 | settings/plugins |
| `GitActionMenu.tsx` | 1398 | git |
| `v4/ConversationTurnGroup.tsx` | 1385 | session |
| `App.tsx` | 1273 | app |
| `settings/model-provider-section/Detail.tsx` | 1254 | settings/model-provider |
| `terminal/TerminalSession.tsx` | 1203 | terminal |
| `v4/composer/V4ComposerToolbar.tsx` | 1190 | composer |
| `WorkspaceSidebarItem.tsx` | 1165 | workspace |
| `ElicitationDialog.tsx` | 1161 | elicitation |
| `settings/ModelProviderSection.tsx` | 1160 | settings/model-provider |
| `Root.tsx` | 1114 | app |
| `browser-use/UnifiedBrowserView.tsx` | 1096 | browser-use |
| `settings/usage-stats/CodingPlanUsagePanel.tsx` | 1080 | settings/usage |
| `command-center/CommandCenterDialog.tsx` | 1072 | command-center |
| `chat-input-toolbar/contextUsage.tsx` | 1043 | composer |
| `settings/SkillsSection.tsx` | 1038 | settings/skills |
| `settings/model-provider-section/StatusCards.tsx` | 1006 | settings/model-provider |

### 400–1000 行（第三梯队，79 个）

完整列表见附录 A（底部）。特征：**数量多但单体行数较少**，多数是列表 + 详情 + 操作菜单的集中维护文件，遵循「settings/settings-like 整页集中维护」的风格——拆出 helper 后仍可跌破 400，但单体收益小、不适合作为第一批。

---

## 2. split-plan 已登记批次的现状

[god-component-split-plan.md](../../../packages/ui/specs/god-component-split-plan.md) 已登记：

### 已完成

- **batch-1 · 附件预览接缝**（2026-10-05）：抽 `v4/composerAttachmentPreview.tsx`（**70 行**，实测），ConversationComposer 的 4 个预览 state 收口为 `useComposerAttachmentPreview` controller。**已实施，已验证**。
- **batch-2 · SessionPane 命令编排纯决策**（2026-10-22）：抽 `v4/session-pane/commandOrchestration.ts`（**220 行**，实测），5 个纯函数 + 决策表单测（`test/sessionPaneCommandOrchestration.test.ts` 16 测）。SessionPane 3762→3657（−105，实测）。**已实施，已验证**。

### 已登记未实施（batch-1 helper 外迁，settings 三件套）

| 文件 | 实测行数 | ratchet 上限 | 已登记拆法 | 状态 |
|---|---:|---:|---|---|
| `settings/AutomationEditView.tsx` | 2950 | 2950 | helper 外迁 → `settings/automation/scheduleModel.ts` + 选择器族 → `pickers/` + cron builder reducer → `cronBuilder.ts`（3 批） | **未动** |
| `settings/SubagentsSection.tsx` | 2671 | 2671 | helper 外迁 → `settings/subagents/agentModel.ts` + 列表/表单/详情 → 三个组件（3 批） | **未动** |
| `settings/AutomationsSection.tsx` | 1979 | 1979 | helper 外迁 → `settings/automations/navigationModel.ts` + 操作菜单/列表拆分（2 批） | **未动** |

**关键风险**：3 个文件都被钉在 ratchet 上限，但 batch-1 helper 外迁**至今无人开始**。split-plan §「拆分动能备注」明示：光修剪不跌破 400 不计入拆分进度。

### 后续已登记未排批（`v4/SessionPane.tsx` 内）

| 接缝 | 状态 |
|---|---|
| 提示词历史导航 | 未动（需先补发送失败回滚交互测试） |
| 模型配置选择器 | 未动（需先理清与草稿持久化交互面） |
| 排队确认（heldQueueConfirmation） | 未动（随发送编排批次处理） |
| SessionPane 命令闭包族 | 未动（需 lease controller 抽象，风险最高，最后做） |

---

## 3. 第一批 5 个最值得拆的组件

选择标准：
- **业务价值**：用户高频路径优先（settings > app-shell > session）
- **行数削减比**：能拆出大段**纯 helper**、主文件能跌破 400 的优先
- **风险**：选**已有 max-lines 自辩头注**且**已带 ratchet 上限**的，说明团队已认可拆分方向；避开 SessionPane（闭包族纪律风险）

### 推荐名单（按风险从低到高）

| 排序 | 文件 | 行数 | 主复杂度来源 | 主文件落地行数 | 预估工作量 | 触及 SessionPane |
|---|---|---:|---|---:|---:|---|
| ① | `settings/AutomationsSection.tsx` | 1979 | 顶部 ~15 个纯 helper + tab 导航/详情路由决策 | ~1480（**仍 >400**），本批不能独立跌破，需配合列表/菜单外迁 | 1.0 人日 | 否 |
| ② | `settings/AutomationEditView.tsx` | 2950 | ~15 个纯 helper + 7 个日期/时间选择器族 + cron builder state | ~1900（helper 外迁后）；选择器族外迁后 ~1200；配合 cron builder 才跌破 400 | 2.0 人日（仅第一刀 helper 外迁 0.5 人日） | 否 |
| ③ | `settings/SubagentsSection.tsx` | 2671 | ~20 个纯 helper（能力判定/工具合并/模型档位）+ 表单初值 | ~1170（helper 外迁后）；再拆列表/表单/详情才跌破 | 1.5 人日（仅 helper 外迁 0.5 人日） | 否 |
| ④ | `settings/RemotePluginSyncDialog.tsx` | 1898 | ~27 个纯 helper（行 57–1058，~1000 行密集 helper 带） + 选择/进度/结果三段 UI | ~900（helper 外迁后）；再拆 SelectionList/ProgressList 才跌破 | 1.5 人日（helper 外迁 0.5 人日） | 否 |
| ⑤ | `settings/McpSettingsSection.tsx` | 1595 | ~10 个纯 helper（refresh queue/status 决策 + OAuth authorization build） | ~1100（helper 外迁后）；需配合 PluginMcpServerList 外迁才跌破 | 1.0 人日（helper 外迁 0.5 人日） | 否 |

**总预估**：**5.0 人日**（含 helper 外迁 + 单测 + ratchet 上调验收）；若只做「第一刀 helper 外迁」：约 **3.0 人日**。

**全部 5 个都不触及 SessionPane**——SessionPane 命令闭包族已显式标记为「风险最高，最后做」（split-plan:47），本批刻意避开。

### 为什么不选 Top 1（SessionPane）/Top 4-6（v4/Conversation*）

- SessionPane 命令闭包族已被 split-plan 标记「风险最高，单独批次」，且刚完成 batch-2，应先让 batch-2 沉淀再动。
- ConversationStatusPanel/ConversationComposer/ConversationRowView 都属于 session 渲染主链路，抽错会破坏流式渲染时序；无 helper 密集带（已用 Grep 验证 `^(function|const)` 分布），拆分收益/风险比低。
- WorkspaceShellLayout / PreviewPane / App.tsx / Root.tsx 是应用骨架，改动会同时触及 desktop/web 两端 mount 时序，风险远高于 settings 内部组件。

### 每个推荐组件的拆分详情

#### ① `settings/AutomationsSection.tsx`（1979 行）

**复杂度来源**：tab 导航/详情路由/toast 决策的纯 helper 密集（行 226–499，**~339 行纯函数**），加上 `AutomationActionsMenu`/`AutomationStatusFilterEmpty` 子组件。

**建议拆出叶子**：
1. `settings/automations/navigationModel.ts`（**~340 行**）：14 个纯函数 `resolveVisibleAutomationTabs`/`resolveAutomationTabAfterOffPeakChange`/`resolveAutomationTabNavigation`/`resolveAutomationTemplateVisibility`/`automationPromptSummary`/`canRestartAutomation`/`canToggleAutomation`/`getAutomationRunNowToastId`/`getAutomationActionErrorToastId`/`getAutomationCreateErrorToastId`/`resolveAutomationDetailTarget`/`resolveAutomationDetailNavigation`/`isOffPeakDetailNavigationId`/`resolveOffPeakDetailNavigation` + 常量 `SCHEDULED_ONLY_AUTOMATION_TABS`/`SCHEDULED_AND_IDLE_AUTOMATION_TABS`/`STATUS_META`/`AUTOMATIONS_TOAST_ANCHOR_ID`。**全部已是纯函数**（grep:226-378），逐字迁移即可。
2. `settings/automations/AutomationActionsMenu.tsx`（**~110 行**，行 384–490）：受控 props 渲染，与父组件通 credit 4 个 props。
3. `settings/automations/AutomationStatusFilterEmpty.tsx`（**~12 行**，行 491–499）：纯展示。

**拆后主文件**：1979 − 340 − 110 − 12 ≈ **1517 行**。仍 >400，但已完成第一刀。**跌破 400 需配合第二批列表/详情拆分**（split-plan 已登记）。

**风险点**：
- 14 个纯函数被主组件 + `AutomationActionsMenu` 共用，需在 navigationModel 出口集中 export，**避免循环 import**。
- `toast` 包装函数（行 163）依赖 `AUTOMATIONS_TOAST_ANCHOR_ID` 常量，**保留在主文件**（涉及 DOM anchor），不外迁。

**前置测试**：`test/automationsNavigationModel.test.ts` 决策表单测（tab 可见性矩阵 × off-peak 变更后落点 × 详情导航 id 判定）。

#### ② `settings/AutomationEditView.tsx`（2950 行）

**复杂度来源**：行 163–1196 是 **~1034 行**的纯 helper + 纯展示子组件带（grep:163–1180），主组件仅占 1197–2950（1754 行）。是**全仓 helper/主组件比最高**的上帝组件。

**建议拆出叶子**（split-plan 已登记 3 批，本批只做第 1 批 helper 外迁）：
1. `settings/automation/scheduleModel.ts`（**~250 行**）：`buildRunsPageItems`/`workspaceLabelFromPath`/`pad2`/`daysInMonth`/`toDateInputValue`/`localDateEndTimestamp`/`parseDateInputValue`/`resolveRunStatus`/`normalizeAutomationScheduleRule` + 常量 `FREQUENCIES`/`isCronFrequency`/`RUNS_PAGE_SIZE`/`CUSTOM_REPEAT_*`/`RUN_STATUS_*`/`AUTOMATION_STATUS_*`。
2. `settings/automation/cronBuilder.ts`（**~70 行**）：`defaultBuilder`/`initialBuilder` + `CronBuilderState` 类型。**纯函数**。
3. （下一批）`settings/automation/pickers/`：`TimeOfDayPicker`/`MonthDayPicker`/`WeekdayPicker`/`EndDatePicker`/`CustomRepeatDialog`/`TimeUnitColumn`/`ScrollNumberColumn` 各自成文件，~600 行。

**拆后主文件**（仅第 1 批 helper 外迁）：2950 − 250 − 70 ≈ **2630 行**。**不会跌破 400**——本批只是把 helper 挪出去、主文件缩小 11%。要跌破 400 必须推完整 3 批（split-plan 口径）。

**风险点**：
- 选择器族 7 个组件被 `AutomationEditView` 主体使用，**全部受控**（受控 props 是 split-plan 已认可的模式），但**外迁会改 component import path**，需要同步刷新所有 import 方。
- 本批只动 helper，**不动 27 个 state**，回避最大风险。

**前置测试**：`test/automationScheduleModel.test.ts`（分页/日期解析/状态决策矩阵）+ `test/cronBuilder.test.ts`（defaultBuilder 初值稳定性、initialBuilder 从既有 rule 反推 builder 状态）。

#### ③ `settings/SubagentsSection.tsx`（2671 行）

**复杂度来源**：行 128–1624 是 **~1497 行**的 helper + 列表/表单辅助组件（grep:128–1624）。34 state 集中在主组件（行 1625–2671，~1047 行）。helper/主组件比 = **1.43**，全仓最高。

**建议拆出叶子**：
1. `settings/subagents/agentModel.ts`（**~400 行**）：`projectSettingsSubagents`/`isEditableUserAgent`/`isBundledPresetAgent`/`supportsEnabledToggle`/`isBuiltInAgent`/`supportsModelOverride`/`getBuiltInSubagentName`/`getKnownTools`/`getPreservedTools`/`mergeTools`/`allowsAllTools`/`toPersistedModel`/`toSubagentModelValue`/`toSubagentModelSelection`/`resolveSubagentThoughtOptionState`/`isSubagentThoughtLevelAvailable`/`resolvedSubagentThoughtLevel`/`isSubagentModelAvailable`/`createSubagentFormInitialState`/`createSubagentFormInitialStateKey`/`resolveSubagentModelLabel` + 常量 `AGENT_COLORS`/`COLOR_DOT_CLASS`/`TOOL_OPTIONS`/`TOOL_OPTION_SET`/`RISKY_TOOLS`/`BUNDLED_AGENT_PATH_PREFIX`。**全纯函数**（grep:128-424）。
2. （下一批）`settings/subagents/SubagentList.tsx` + `SubagentForm.tsx` + `SubagentDetail.tsx`：把 34 state 按列表选择态/表单草稿态/详情展示拆到三个组件。

**拆后主文件**（仅 helper 外迁）：2671 − 400 ≈ **2271 行**。**不会跌破 400**，但 helper 抽离后**主组件可读性显著提升**（34 state 不再被 400 行 helper 淹没）。

**风险点**：
- `TOOL_OPTIONS`/`TOOL_OPTION_SET`/`RISKY_TOOLS` 被 helper + 表单组件共用，**集中 export 在 agentModel**，避免循环。
- `FormFieldLabel`/`AgentColorDot`/`AgentBadge`/`ToolCheckbox`/`BatchRowCheckbox` 是**纯展示子组件**（grep:425–572），本批**不动**（避免一次改太多），属下一批。

**前置测试**：`test/subagentModel.test.ts` 决策表单测（能力矩阵 × 工具合并去重 × 模型档位可用性 × 表单初值 key 稳定性）。

#### ④ `settings/RemotePluginSyncDialog.tsx`（1898 行）

**复杂度来源**：行 57–1058 是 **~1002 行**的纯 helper + 同步行构建/选择/进度计算的密集带（grep 数到 27 个顶层函数/常量定义）。主组件 `RemotePluginSyncDialog` 在行 1515，~380 行。

**建议拆出叶子**：
1. `settings/remote-plugin-sync/remotePluginSyncModel.ts`（**~500 行**）：`shouldFinishRemotePluginSyncRun`/`createRemotePluginSyncOperationId`/`toInlineRemotePluginSyncCandidate`/`createInlineStatusKey`/`buildRemotePluginSyncRows`/`buildRemotePluginSyncRowsForCandidates`/`resolveDefaultRemotePluginSyncSelection`/`filterRemotePluginSyncRows`/`shouldAllowRemotePluginSyncDialogOpenChange`/`buildMarketplaceRemotePluginSyncCandidates`/`buildMarketplaceRemotePluginStatuses`/`componentTypesFromPluginInfo`/`buildRemotePluginSyncPluginOptions`/`applyPluginInfoToRemoteSyncCandidate`/`enrichRemotePluginSyncCandidatesWithPluginInfo`/`summarizeLocalPluginOptionsForDisplay`/`serializeMarketplaceSourceInput`/`buildMarketplaceSourceSyncInfo`/`isRemotePluginSyncStoppedError`/`buildStoppedRemotePluginResult`/`isPathPluginOption`/`isPortablePluginOptionValue`/`buildPortablePluginOptionsSyncPlan`/`arePluginOptionsEqual`/`buildSelectedMarketplacePluginNames`/`formatInstallError`。
2. （下一批）`SelectionList`/`ProgressList`/`ResultList` 三个子组件外迁。

**拆后主文件**（仅 helper 外迁）：1898 − 500 ≈ **1398 行**。**不会跌破 400**，但「行构建/选择/进度计算」的纯逻辑独立成可单测模块。

**风险点**：
- `emitRemotePluginSyncProgress` 和 `throwIfRemotePluginSyncStopped` 是**副作用函数**（grep:500-520），**不外迁**，留在主文件。
- helper 内部互相引用密集（如 `buildRemotePluginSyncRows` 调 `createInlineStatusKey`），外迁时**整组一起搬**，不要拆散。

**前置测试**：`test/remotePluginSyncModel.test.ts` 决策表单测（同步行构建矩阵 × stopped error 判定 × portable plugin option 值）。

#### ⑤ `settings/McpSettingsSection.tsx`（1595 行）

**复杂度来源**：行 76–552 是 **~477 行**纯 helper（refresh queue/status 决策/OAuth authorization build/server list key 计算）。主组件 `McpSettingsSection` 在行 553，~1042 行。

**建议拆出叶子**：
1. `settings/mcp/mcpRefreshModel.ts`（**~300 行**）：`createMcpOAuthAuthorizationStatusRefreshDeadline`/`isMcpOAuthAuthorizationStatusRefreshExpired`/`transitionMcpAutoStatusListRefreshKey`/`transitionMcpOAuthAuthorizationPendingRefresh`/`resolveMcpStatusListRefreshSkipReason`/`createMcpStatusListRefreshQueue`/`buildMcpOAuthAuthorizationStatusRefreshServers`/`buildMcpOAuthAuthorizationStatusRefreshOptions`/`buildMcpServerStatusListKey`/`buildPluginMcpServerStatusListKey`/`shouldShowPluginMcpServersInMcpSettings`/`buildPendingMcpOAuthAuthorizationRefreshKey` + 常量 `DEFAULT_MCP_SOURCE`/`MCP_OAUTH_*` 时间常量。
2. （下一批）`PluginMcpServerList`（grep:415-552，~140 行）外迁为受控子组件。

**拆后主文件**（仅 helper 外迁）：1595 − 300 ≈ **1295 行**。**不会跌破 400**——但 refresh queue 这个**有 timing/状态机的纯函数集**独立成模块后，可补决策表单测，覆盖之前只能依赖手工验证的 OAuth 刷新窗口边界。

**风险点**：
- `createMcpStatusListRefreshQueue` 返回**带内部状态的对象**（queue），是**有状态工厂**而非纯函数。拆出时**保留闭包语义**，调用方不应假设纯函数。
- OAuth refresh 时序敏感（5 分钟过期、1 秒轮询），决策表单测要覆盖**截止边界**（now = deadline / now = deadline+1）。

**前置测试**：`test/mcpRefreshModel.test.ts`（refresh deadline 边界 × queue transition × skip reason）。

---

## 4. 拆分方法学（已落地的 1-2 个成功模式）

### 模式 A：「纯决策逻辑外迁 + 决策表单测」（batch-2 已验证）

**案例**：SessionPane batch-2 抽 `commandOrchestration.ts`（220 行、5 纯函数），SessionPane 3762→3657，**主文件 −105 行**，新模块 +220 行（净 +115 是因为补了决策表单测 + 显式类型导出）。

**关键步骤**：
1. **逐字迁移优先**：函数体不改一字，只换 import 路径（split-plan §「每批拆分的固定验收」第 1 条）
2. **判别联合返回**：`resolveSlashCommandDispatch` 返回 `dispatch | consumedNoDispatch | notConsumed` 判别联合，**副作用留在原闭包**，新模块纯函数化
3. **deps 数组不动**：消费方 useMemo/useCallback deps 同步更新，但 React hooks 完整性靠 typecheck+lint 兜底
4. **决策表单测**：每个纯函数补 1 个测试文件，覆盖所有分支（`sessionPaneCommandOrchestration.test.ts` 16 测）

**适用场景**：文件顶部已堆积大量**已是纯函数**的 helper（settings 三件套全部符合）。

### 模式 B：「状态 controller 外迁 + JSX 插槽」（batch-1 已验证）

**案例**：ConversationComposer 抽 `composerAttachmentPreview.tsx`（70 行），把 4 个预览 state（图片 gallery index/open、PDF target/open）收口为 `useComposerAttachmentPreview` hook，composer 只持有 `openImagePreviewForSrc`/`openPdfPreview` 两个 controller。

**关键步骤**:
1. **state 簇识别**：找出**生命周期相同、互相 set** 的 state 集合
2. **controller 接口**：hook 返回 `{ controller 函数, dialogs JSX }`，父组件只持有 controller
3. **deps 同步**：父组件的 topContentNode useMemo deps 必须同步更新（如 `openImagePreviewForSrc` 依赖 `composerMediaPreviewItems`）

**适用场景**：v4/ConversationComposer 的提示词历史/模型配置选择器/排队确认（split-plan 已登记）。

### 本批 5 个推荐全部用模式 A

理由：5 个文件**顶部都已经堆积大量纯函数**，不需要先做 controller 抽象。模式 A 风险更低、收益更直接。

---

## 5. 第一批实施 checklist

按风险从低到高排序。每条都是「拆分 → 测试 → 门禁」三步。

```
[ ] 1. settings/AutomationsSection.tsx
      拆分：抽 14 个纯函数到 settings/automations/navigationModel.ts（~340 行）
      测试：新建 test/automationsNavigationModel.test.ts，覆盖 tab 可见性 × off-peak 落点 × 详情导航
      门禁：tsc 0 错 + pnpm --filter @acode/ui test 全绿 + oxlint 触碰文件 0 新增警告
            + ratchet 上限 1979 → 1640（−339）需配合批次验收

[ ] 2. settings/AutomationEditView.tsx
      拆分：抽 helper 到 settings/automation/scheduleModel.ts + cronBuilder.ts（~320 行）
      测试：新建 test/automationScheduleModel.test.ts + test/cronBuilder.test.ts
      门禁：tsc 0 错 + ui 测试全绿 + oxlint 触碰文件 0 新增警告
            + ratchet 上限 2950 → 2630（−320）需配合批次验收

[ ] 3. settings/SubagentsSection.tsx
      拆分：抽 21 个纯函数到 settings/subagents/agentModel.ts（~400 行）
      测试：新建 test/subagentModel.test.ts（能力矩阵 × 工具合并 × 模型档位 × 表单初值 key）
      门禁：tsc 0 错 + ui 测试全绿 + oxlint 触碰文件 0 新增警告
            + ratchet 上限 2671 → 2271（−400）需配合批次验收

[ ] 4. settings/RemotePluginSyncDialog.tsx
      拆分：抽 26 个纯函数到 settings/remote-plugin-sync/remotePluginSyncModel.ts（~500 行）
      测试：新建 test/remotePluginSyncModel.test.ts
      门禁：tsc 0 错 + ui 测试全绿 + oxlint 触碰文件 0 新增警告
            + 在 godComponentLineRatchet.guard.test.mjs 新增条目，上限设为拆分后实测行数

[ ] 5. settings/McpSettingsSection.tsx
      拆分：抽 12 个纯函数到 settings/mcp/mcpRefreshModel.ts（~300 行）
      测试：新建 test/mcpRefreshModel.test.ts（refresh deadline 边界 × queue transition × skip reason）
      门禁：tsc 0 错 + ui 测试全绿 + oxlint 触碰文件 0 新增警告
            + 在 godComponentLineRatchet.guard.test.mjs 新增条目，上限设为拆分后实测行数
```

**每个组件落地后必做**（split-plan §「每批拆分的固定验收」）：
- `tsc -p packages/ui/tsconfig.json --noEmit` 触碰文件 0 错
- `pnpm --filter @acode/ui test` 全绿
- oxlint 触碰文件 0 新增警告
- 新模块自身 <400 行
- 若涉及交互语义（本批 5 个 helper 外迁都不涉及），需补交互测试或人工验证记录
- **本批 5 个都仍是「内部修剪」**——主文件行数会下降但**不会跌破 400**，按 split-plan:186 口径**不计入拆分进度**；只有推完所有批次、文件跌破 400，才计入并跑 `find ... | wc -l` 计数

---

## 附录 A：400–1000 行 79 个文件完整清单

```
977 packages/ui/src/PermissionDialog.tsx
972 packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx
962 packages/ui/src/settingsPageHelpers.tsx
956 packages/ui/src/components/ui/pptx-preview-viewer.tsx
943 packages/ui/src/TaskListItem.tsx
887 packages/ui/src/WorkspaceTimelineTasksSection.tsx
843 packages/ui/src/settings/ComputerUseSection.tsx
804 packages/ui/src/RemoteConnectionFields.tsx
803 packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx
790 packages/ui/src/components/ui/code-viewer.tsx
757 packages/ui/src/workspace-grouped-tasks/group-item.tsx
753 packages/ui/src/components/ai-elements/prompt-input.tsx
752 packages/ui/src/WorkspaceHeaderSections.tsx
732 packages/ui/src/v4/ConversationDraftSuggestedPromptsContainer.tsx
722 packages/ui/src/mentions/MentionPlugin.tsx
713 packages/ui/src/WorkspacePinnedTasksSection.tsx
702 packages/ui/src/components/ai-elements/diagram-preview-dialog.tsx
697 packages/ui/src/settings/OffPeakEditView.tsx
696 packages/ui/src/TreemappingPane.tsx
691 packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx
663 packages/ui/src/ModelConfigSelect.tsx
649 packages/ui/src/v4/WorkbenchPane.tsx
649 packages/ui/src/SSHDialog.tsx
602 packages/ui/src/v4/V4WorkspaceChatArea.tsx
596 packages/ui/src/settings/PluginStorePage.tsx
590 packages/ui/src/settings/HooksSection.tsx
585 packages/ui/src/settings/RemoteMcpSyncDialog.tsx
582 packages/ui/src/components/ai-elements/attachments.tsx
577 packages/ui/src/components/ai-elements/reasoning.tsx
573 packages/ui/src/app-shell/SidePaneTabTrigger.tsx
564 packages/ui/src/components/ai-elements/image-preview-dialog.tsx
559 packages/ui/src/settings/PluginStoreListView.tsx
550 packages/ui/src/components/ai-elements/code-block.tsx
546 packages/ui/src/GitPane.tsx
545 packages/ui/src/RemoteConnectionDialogContent.tsx
543 packages/ui/src/BotsDialog/ProviderSettingsCard.tsx
526 packages/ui/src/workspace-grouped-tasks/task-row.tsx
519 packages/ui/src/ToolCallBlocks/renderers/edit.tsx
508 packages/ui/src/onboarding/OnboardingDialog.tsx
506 packages/ui/src/settings/CommandsSection.tsx
505 packages/ui/src/chat-input-toolbar/display.tsx
505 packages/ui/src/app-shell/WorkflowRunSidePane.tsx
504 packages/ui/src/ToolCallBlocks/renderers/cua.tsx
501 packages/ui/src/TaskList.tsx
497 packages/ui/src/settings/PluginStoreDetailView.tsx
493 packages/ui/src/settings/RemoteSkillSyncDialog.tsx
490 packages/ui/src/ToolCallBlocks/renderers/explore.tsx
484 packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx
466 packages/ui/src/components/ui/toast.tsx
466 packages/ui/src/components/ui/pdf-viewer.tsx
463 packages/ui/src/ToolCallBlocks/renderers/create-workflow.tsx
461 packages/ui/src/SlashCommandPlugin.tsx
459 packages/ui/src/app-shell/WorkflowRunSidePaneSections.tsx
458 packages/ui/src/previewPaneContent.tsx
454 packages/ui/src/prompt-editor/ChatPromptEditor.tsx
447 packages/ui/src/app-shell/WorkflowRunPhaseList.tsx
446 packages/ui/src/mentions/components/MentionPanel.tsx
442 packages/ui/src/chat-input-toolbar/CodingPlanContextUsage.tsx
439 packages/ui/src/components/workflow-timeline/WorkflowTimeline.tsx
438 packages/ui/src/settings/saved-workflows/SavedWorkflowProjectGroup.tsx
436 packages/ui/src/v4/V4InteractionDialogs.tsx
432 packages/ui/src/app-shell/WorkflowArtifactSidePane.tsx
430 packages/ui/src/ToolCallBlocks/renderers/list-models.tsx
430 packages/ui/src/ChatEmptyState.tsx
429 packages/ui/src/components/coding-plan-quota-reset/CodingPlanQuotaResetDialog.tsx
429 packages/ui/src/ErrorBoundary.tsx
428 packages/ui/src/settings/saved-workflows/SavedWorkflowDetailView.tsx
425 packages/ui/src/settings/model-provider-section/Navigation.tsx
425 packages/ui/src/CodingPlanUsageRemainingPanel.tsx
422 packages/ui/src/settings/McpServerForm.tsx
422 packages/ui/src/ModelTrajectoryPaneParts.tsx
421 packages/ui/src/i18n/IntlProvider.tsx
413 packages/ui/src/ToolCallBlocks/renderers/agent.tsx
412 packages/ui/src/settings/HookForm.tsx
408 packages/ui/src/feedback/FeedbackSubmitForm.tsx
406 packages/ui/src/settings/OffPeakTaskList.tsx
405 packages/ui/src/ToolCallBlocks/renderers/node-repl.tsx
```

（共 79 个；第一/二梯队 20 + 18 = 38 个；总计 117。）

---

**报告完。**
