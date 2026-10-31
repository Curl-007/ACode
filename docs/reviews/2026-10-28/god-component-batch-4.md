# 上帝组件拆分 · 批次 4 实施报告（settings 二件 + src 根二件 + v4 保守一刀）

日期：2026-10-28（Asia/Shanghai）。基线：`fix/project-review-2026-10-26` worktree。
方法：按 [god-component-batch-1.md](god-component-batch-1.md) §4 模式 A（纯决策逻辑外迁 + 决策表单测）与批次 1-3 落地样板（c4698491 / ddab7873 / 65f95ca0），5 个组件并发 5 个子代理实施，集成者统一收口 spec / ratchet / 门禁。

输入：
- 拆分计划：[../../../packages/ui/specs/god-component-split-plan.md](../../../packages/ui/specs/god-component-split-plan.md)（批次 4 五节已登记并标实施）
- ratchet 守护：[../../../packages/ui/tests/godComponentLineRatchet.guard.test.mjs](../../../packages/ui/tests/godComponentLineRatchet.guard.test.mjs)（上限表 +5 条）

---

## 1. 结果总览（行数均为 wc -l 物理行实测）

| 主文件 | 拆前 | 拆后 | 减量 | 新叶子数 | 新测试用例 |
|---|---:|---:|---:|---:|---:|
| `settings/ExternalAgentImportDialog.tsx` | 1442 | **1050** | −392 | 2 | 13 |
| `settings/PluginsSection.tsx` | 1400 | **498** | −902 | 9 | 12 |
| `WorkspaceGroupedTasksSection.tsx` | 1747 | **1320** | −427 | 3 | 30 |
| `SettingsPage.tsx` | 1725 | **1347** | −378 | 3 | 9 |
| `v4/ConversationStatusPanel.tsx` | 2246 | **2102** | −144 | 1 | 11 |
| **合计** | 8760 | **6317** | **−2243** | **18** | **75** |

18 个新叶子全部 <400 物理行（固定验收第 5 条）。5 个主文件仍 >400——本批按 split-plan 口径属内部修剪，不计入「跌破 400」拆分进度；超 400 tsx 计数不变（117，批次 1 报告 §0 口径，本批未新增 >400 文件）。

## 2. 各组件明细

### 2.1 `settings/ExternalAgentImportDialog.tsx`：1442 → 1050

新叶子（`settings/external-agent-import/`）：
- `importModel.ts`（279 行）：15 个纯函数（selection key 编解码 / import selection 归组 / 结果提取 / source root scope 推断排序 / agent 分组 / 名称与 scope 格式化）+ 4 类型 + 2 常量，逐字迁移；`ImportResourceCategory` 类型单一来源迁入本叶子，主文件 re-export 保持对外签名。
- `useExternalAgentImportCategoryState.ts`（175 行）：扫描-选择-导入目标状态机 hook + 接口逐字迁入；主文件 re-export，消费方（OnboardingDialog / OnboardingFlowParts / SkillsSection / CommandsSection / McpSettingsSection）零改动。

测试：`test/externalAgentImportModel.test.ts` 13 例（key round-trip / 畸形 key 矩阵 / selection 归组 / 各类别结果提取 / 路径 scope 推断 / intl 桩格式化）。

偏离登记：两个格式化函数的 intl 形参标注由 `ReturnType<typeof useACodeIntl>["intl"]` 改具名类型 `IntlInstance`（类型恒等，遵守 ts-no-return-type 内建规则）；函数体逐字未动。

留待下批：12 个纯展示子组件（ImportSelectionList / ImportResultList 等，~600 行）仍在主文件。

### 2.2 `settings/PluginsSection.tsx`：1400 → 498

本批减量最大的组件。PluginList（原 ~800 行）整组外迁为「controller hook + 受控渲染叶子」：

- `settings/plugins/pluginTabs.ts`（19 行）：tab 归一化与计数 class；本地 `workspaceKey` 经实现比对确认为 `PluginScopeMenu.getPluginWorkspaceKey` 的纯委托别名，**删除别名**、9 个调用点改直调（去重，非迁移）。
- `settings/plugins/usePluginListController.ts`（378 行）：PluginList 的 store 绑定 / 派生 memo / 操作回调逐字收口（hook 顺序与 deps 逐字，git diff 机器核对）。
- `settings/plugins/usePluginOptionDrafts.ts`（103 行）：配置草稿三件套——controller 首版 434 行超 400，按固定验收第 5 条再切一刀，调用点占据原 useState 槽位、hook 序列不变。
- `settings/plugins/PluginList.tsx`（305 行）：组件本体（controller 调用 + 列表分支 + 弹窗接线）。
- `settings/plugins/PluginListDetail.tsx`（165 行）：详情分支——PluginList 首版 414 行超 400 的第三刀，入参解构改名保持 JSX 标识符逐字。
- `settings/plugins/PluginListRows.tsx`（219 行）：原 `renderPluginRows` 闭包改受控组件。
- `settings/plugins/PluginListUninstallDialog.tsx`（41 行）：详情/列表两分支逐字重复的卸载确认弹窗消重。
- `settings/plugins/PluginUnavailableComputerUseRow.tsx`（44 行）、`settings/plugins/PluginEmptyState.tsx`（13 行，PluginList 与主组件共用，独立成叶避免循环 import）。

测试：`test/pluginTabs.test.ts` 3 例 + `test/pluginListRows.test.ts` 9 例（渲染契约：row 锚点 / switch 三态 / missing 无菜单 trigger / canUpdate 四态 / scope 徽标三态 / CUA 文案分支）。两处环境适配如实登记：① Radix DropdownMenu Content 走 Portal 且仅打开时挂载，SSR 静态不可见——「update 菜单项出现/隐藏」改由同谓词的行内 `PluginStoreUpdateButton` 钉住（测试头注已说明）；② PluginIcon 链路静态 import `.png`，tsx 无法加载——测试内 `module.registerHooks` 重定向到 data: 空模块（node --test 每文件独立进程，不影响其他测试）。

集合外最小改动（均已文件内注释，行为零改动）：`settings/computerUseAvailability.ts`、`settings/usePluginUninstall.ts`、`hooks/useWorkspaceServices.tsx` 各补 `export` 一个既有类型（ts-no-return-type / TS4058 要求具名类型在属主模块导出）。

controller hook 无 jsdom 无法单测，按固定验收第 4 条如实登记。

### 2.3 `WorkspaceGroupedTasksSection.tsx`：1747 → 1320

沿用既有 `workspace-grouped-tasks/` 叶子目录：
- `groupedTaskDragData.ts`（120 行）：8 个 drag/drop data 读取器 + 2 个等价判定 + `groupedTaskCollisionDetection`。
- `groupedTaskPreviewViews.ts`（164 行）：7 个 preview view 构建器 + `getGroupedTaskViewSignature`。
- `groupedTaskLayout.ts`（204 行）：布局测量 / FLIP 动画 / sticky 解析 + 2 常量；`findNearestScrollableAncestor` 被布局族与组件本体共用，归置本叶（内聚性优于放 dragData 叶子两边 import），主文件从本叶 import。

组件本体零改动（逐字）；失效 import 已清。测试：`test/groupedTaskDragData.test.ts` 15 例（读取器畸形矩阵 / 碰撞检测分支 / 等价边界）+ `test/groupedTaskPreviewViews.test.ts` 15 例（preview 决策表 / 签名稳定性）。布局/DOM 函数无 jsdom 不测，如实登记。

### 2.4 `SettingsPage.tsx`：1725 → 1347

沿用既有 `settingsPageHelpers.tsx` 的 src 根叶子约定（不新建子目录）：
- `settingsUsageCodingPlanTabs.ts`（56 行）：5 个 tab 纯函数逐字迁入。
- `useSettingsUsageCodingPlanSources.ts`（288 行）：usage coding-plan 派生簇（provider settings 读取 / 2 entitlement / 2 企业商品 / sources 派生 / `usageActiveTab` state / 两个 tab 纠偏 effect）收口为 custom hook，hook 顺序与 deps 逐字；返回集按主文件实际引用裁剪为 9 值，其余中间值保持 hook 私有。
- `settingsPageChrome.tsx`（107 行）：`SettingsUsageProviderTabs` + `SettingsSidebarButton` 两小组件；依赖均同向，无循环 import。

测试：`test/settingsUsageCodingPlanTabs.test.ts` 9 例（team 判定 4 分支 / tab id round-trip 含自带冒号与边界 / 标签解析 / 快照激活矩阵）。hook 无 jsdom 不测，如实登记。附带观察：`CodingPlanUsageRemainingPanel.tsx` 存在同名独立 `hasActiveCodingPlanSnapshot`（既有重复，非本批产生），留待后续收敛。

### 2.5 `v4/ConversationStatusPanel.tsx`：2246 → 2102（风险评估 + 保守一刀）

**风险评估（实施前）**：desktop-continuous 实时语义集中在 `ConversationStatusPanelImpl`（memo / tick 重渲染节律 / scroll policy）与 20+ 个 section 组件的 props 透传契约；组件级外迁需先定义公共 props 类型边界并补渲染契约测试，风险高于收益。顶部纯格式化/决策函数与实时语义零耦合，逐字外迁等价于批次 1-3 已验证的模式 A。**结论：本批只拆纯函数接缝，组件与 Impl 一律不动。**

实施：新建 `v4/conversationStatusPanelFormat.ts`（181 行）——`EMPTY_*` 常量 / `formatDurationUnits` / elapsed 计算 / running count 文案 / todo focus 窗口 / 两个 open-request 构建器 / plan 当前与最近完成项选取，逐字迁入（既有 `conversationStatusPanelModel.ts` 已 399 行，不追加以免破 400 上限）；`STATUS_SECTION_SCROLL_POLICY`/`StatusSectionKind` 因组件共享留主文件。偏离登记：`formatMessage` 形参类型改具名 `IntlInstance["formatMessage"]`（类型恒等，ts-no-return-type）。

测试：`test/conversationStatusPanelFormat.test.ts` 11 例全绿；既有渲染契约 `test/ConversationTeamStatusPanel.test.ts`（动态 import 本组件渲染）复测仍绿。

**遗留风险与建议批次**：section 组件群（GitStatusSection / PlanStatusSection / WorkflowStatusSection 等）与主文件共享 `StatusSection`/`STATUS_SECTION_SCROLL_POLICY` 局部契约；`StatusSummaryRow` 迷你胶囊语义与 model 派生字段强耦且被稳定引用边界测试钉住 props；Impl 的 tick 节律与 endedWorkflowRunCount 降级涉 desktop-continuous 时序假设。建议后续批次：① 先补 section 渲染契约测试（renderToStaticMarkup 钉结构）→ ② 按「叶子 props 类型 → 单 section 外迁」逐批切 → ③ 最后处理 Impl 投影与 tick 策略（最高风险，单独批次）。

## 3. 门禁实测

| 门禁 | 结果 | 基线对比 |
|---|---|---|
| `pnpm --filter @acode/ui test` | **1049 pass / 0 fail**（14.5s） | 基线 974 + 本批新增 75 = 1049 ✓ |
| `npx tsc -p packages/ui/tsconfig.json --noEmit` | **exit 0** | 0 错 ✓ |
| `pnpm lint` | **164 warnings / 0 errors** | 与基线 164w/0e 持平；触碰文件内 4 条 warning（SettingsPage 未用参数 ×2 / spread fallback、ConversationStatusPanel 未用参数）经 `git show HEAD` 核对全部为既有 warning 的行号位移，零新增 ✓ |
| `pnpm architecture:check --changed` | **new 0 / regrown 0**（violations 298 = baseline 298；legacy over-limit 414 只减不增） | ✓ |
| `godComponentLineRatchet.guard.test.mjs` | 绿（含在上条 1049 内） | 上限表 +5 条，split-plan 登记表解析互查通过 ✓ |
| `pnpm typecheck`（仓库级） | packages / desktop-renderer 通过；**cli 段 failed** | 失败全部位于 `apps/acode-cli/packages/core/src/runtime/**`（TS2540 readonly 赋值等 18 处）——同 worktree 并行代理（R1-01 批次 B2/B3）的在途产物，非本批文件集；本批 ui 域 tsc 单独 0 错。仓库级 exit 0 需待 CLI 代理收口后由集成者复跑 |

## 4. 改动文件清单（本批文件集）

主文件（5）：`settings/ExternalAgentImportDialog.tsx`、`settings/PluginsSection.tsx`、`WorkspaceGroupedTasksSection.tsx`、`SettingsPage.tsx`、`v4/ConversationStatusPanel.tsx`（均在 packages/ui/src 下）。

新叶子（18）：`settings/external-agent-import/importModel.ts`、`settings/external-agent-import/useExternalAgentImportCategoryState.ts`、`settings/plugins/`（pluginTabs.ts / usePluginListController.ts / usePluginOptionDrafts.ts / PluginList.tsx / PluginListDetail.tsx / PluginListRows.tsx / PluginListUninstallDialog.tsx / PluginUnavailableComputerUseRow.tsx / PluginEmptyState.tsx）、`workspace-grouped-tasks/`（groupedTaskDragData.ts / groupedTaskPreviewViews.ts / groupedTaskLayout.ts）、`settingsUsageCodingPlanTabs.ts`、`useSettingsUsageCodingPlanSources.ts`、`settingsPageChrome.tsx`、`v4/conversationStatusPanelFormat.ts`。

新测试（7 文件 75 例）：`test/externalAgentImportModel.test.ts`（13）、`test/pluginTabs.test.ts`（3）、`test/pluginListRows.test.ts`（9）、`test/groupedTaskDragData.test.ts`（15）、`test/groupedTaskPreviewViews.test.ts`（15）、`test/settingsUsageCodingPlanTabs.test.ts`（9）、`test/conversationStatusPanelFormat.test.ts`（11）。

治理文件：`packages/ui/specs/god-component-split-plan.md`（+5 节并标批次 4 已实施、状态行更新）、`packages/ui/tests/godComponentLineRatchet.guard.test.mjs`（上限表 +5 条：1050 / 498 / 1320 / 1347 / 2102）。

集合外最小改动（packages/ui 内，行为零改动）：`settings/computerUseAvailability.ts`、`settings/usePluginUninstall.ts`、`hooks/useWorkspaceServices.tsx` 各补一个既有类型的 `export`。

## 5. 遗留风险与下批建议

1. **5 个主文件仍 >400**，按 split-plan 口径不计入跌破进度；ratchet 上限已钉在当前水位，继续增长会红。
2. **下批候选**：ExternalAgentImportDialog 展示子组件群（~600 行）；SettingsPage 主组件内剩余 section 渲染（~1300 行）；PluginsSection 已收敛到 498，最后一程是 tabs/Scope 聚合段的进一步切分。
3. **ConversationStatusPanel** 按 §2.5 的三步建议推进，勿跳过渲染契约测试直接拆 section。
4. **无 jsdom 留白**（固定验收第 4 条口径）：3 个 custom hook（useExternalAgentImportCategoryState / usePluginListController(+usePluginOptionDrafts) / useSettingsUsageCodingPlanSources）与 groupedTask DOM 布局族无单测，依赖 typecheck + 决策表邻接覆盖 + 人工验证；若后续引入 jsdom 套件应优先补这三处。
5. `hasActiveCodingPlanSnapshot` 在 `CodingPlanUsageRemainingPanel.tsx` 的同名重复实现待收敛（非本批产生）。

**报告完。**
