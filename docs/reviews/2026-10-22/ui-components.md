# ACode 1.0.3 深度 Review · UI 组件与渲染层

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`。方法：只读源码审查，未改动代码。总入口见 [../../project-review-2026-10-22.md](../../project-review-2026-10-22.md)。

范围：`packages/ui/src/` 组件层（不含 store/hooks，另见 [ui-state.md](ui-state.md)）、渲染性能、`DESIGN.md` 遵从度、i18n、桌面与手机 Web 响应式、主题、可访问性。

---

## 1. 层面整体评估

组件层整体**健康度中上，但存在系统性的巨型组件债**。设计 token 遵从度高（硬编码颜色全仓仅 ~36 处）、i18n 优秀（react-intl `formatMessage` 覆盖 441/694 个 tsx，几乎无硬编码文案）、渲染性能已做实质治理（时间线与任务列表用 `@tanstack/react-virtual` 真虚拟化、81 处 memo、内存泄漏有专项 spec 且 `subscriptionActive` 门控已落地）。可访问性基础扎实（aria 属性 1457 处、role 170、onKeyDown 130）。**最大风险是架构 400 行闸被大面积突破——115 个 tsx 超限，历史点名的 `SessionPane.tsx` 从 3629 行不降反增到 3762 行**，拆分计划登记了却只推进第一批一处接缝。次要风险是 `settings/AutomationEditView.tsx` 等文件成簇绕过设计系统（裸 button + `bg-white`/`text-black` + 移除焦点环）。

## 2. 问题清单

**[P1] 巨型组件系统性超限，拆分计划停滞** — `packages/ui/src/v4/SessionPane.tsx:1`（3762 行）
- 描述：架构闸 `maxFileLines: 400`（`architecture-policy.yaml:304`），但 115 个 tsx 超限，top 10 全部 >1300 行。SessionPane 带 `oxlint-disable max-lines` 头注豁免。
- 证据：`god-component-split-plan.md` 记 SessionPane 原 3629 行，现 3762（净增 133）；拆分「第一批已实施」仅抽出附件预览一处，后续 4 条接缝（命令组、提示词历史、模型选择器、排队确认）全部登记未动；`settings/AutomationEditView.tsx`（2942）、`SubagentsSection.tsx`（2671）无对应拆分计划。
- 建议：按 plan 的「耦合最浅接缝先行」继续，但先补 SessionPane 命令编排的接缝内测试（plan 第 23 行明确这是前置）；对 settings 下 3 个 >2600 行的新上帝组件补登记拆分计划。豁免只允许随拆分收窄。
- 验收：每批新模块 <400 行、`tsc -b packages/ui` 0 错、ui 测试全绿；SessionPane 行数单调下降。

**[P2] AutomationEditView 成簇绕过设计系统 + 移除焦点环** — `packages/ui/src/settings/AutomationEditView.tsx:1979,1991,2006,2835`
- 描述：主操作按钮用裸 `<button>` + `bg-white text-black`（应为 `Button` 组件 + `bg-primary text-primary-foreground`），次级按钮用 `bg-white/[0.06]` alpha 填充，且全部 `focus-visible:ring-0` 显式移除焦点环。违反 DESIGN.md「Color Usage Rules: Never replace semantic tokens with ad hoc values like text-white/60」「Accessibility: Preserve visible focus behavior」。
- 证据：`:1979` 保存按钮 `bg-white px-3 text-black ... focus-visible:ring-0`；同模式复制进 `OffPeakEditView.tsx:445`、`OffPeakEditActionsMenu.tsx:39`、`OffPeakHistoryTab.tsx:121`、`PluginStoreDetailView.tsx:277`（`text-white/70`）。全仓 `bg-white`/`text-black` 26 处、`focus-visible:ring-0`/`outline-none` 合计 180 处。
- 建议：这批 settings 按钮统一替换为 `components/ui/button.tsx` 的 primary/outline/ghost variant；确需移除默认 ring 的地方补自定义可见焦点态，不能裸 `ring-0`。
- 验收：上述文件 `rg "bg-white|text-black|ring-0"` 归零或每处 `ring-0` 都有替代焦点样式；亮/暗/Zai 三主题下按钮对比度达标。

**[P2] 零散硬编码字号绕过 `text-ui-*` 强制标尺** — `packages/ui/src/settings/saved-workflows/AutomationsPageTitleSwitch.tsx:29,84`
- 描述：DESIGN.md 开篇「Highest-priority UI constraint」明令禁止 `text-[Npx]`。发现 13 处 `text-[Npx]`，其中页面标题 `text-[30px]` 属业务 UI（非 code/diff/terminal 豁免）。
- 证据：`:29`/`:84` `text-[30px] leading-[34px] tracking-[0.114px]`；`ConversationComposer.tsx:1710` `text-[7px]`；`WorkspaceSidebarFooter.tsx:155` `text-[11px]`；`OccupationOnboardingVisual.tsx:69` `text-[16px]`。另有内联 `fontSize`：`ArtifactChartView.tsx:226`、`TeamTaskGraph.tsx:116-117`（图表轴家具，`text-ui-2xs` 灰区可豁免）。
- 建议：业务 UI 的 `text-[Npx]` 迁到最近的 `text-ui-*` token；确需的图表/终端字号保留但加注释说明豁免依据。
- 验收：`rg "text-\[[0-9]+px\]"` 剩余项全部落在 code/diff/terminal/graph-axis 豁免类且带注释。

**[P3] 裸 `<button>` 未走 Button 组件的可访问性一致性风险** — 全仓 220 处裸 `<button>` vs 231 文件导入 `Button`
- 描述：裸 button 需各自维护 aria-label、焦点态、禁用态；抽样多数已带 `sr-only`/`aria-label`（全仓 597 处），但一致性靠人工。
- 建议：图标按钮优先复用 `Button` 的 `icon-*` variant；新增裸 button 时 lint 层面提示。
- 验收：新增图标按钮默认走 Button 组件或强制 `aria-label`。

## 3. 巨型组件 Top 10（职责过载评估）

| 文件 | 行数 | 职责过载评估 | 拆分建议 |
|---|---|---|---|
| `v4/SessionPane.tsx` | 3762 | **严重**。98 import、12 state、17 ref、21 useEffect、90 memo/callback，命令编排（订阅/发送/停止/fork/edit/retry/queue/slash）全收口 | 按 plan 分接缝抽，先补命令组测试 |
| `settings/AutomationEditView.tsx` | 2942 | **严重**。表单+tab+多操作按钮簇，无拆分计划 | 抽表单 schema、操作栏、tab 面板 |
| `settings/SubagentsSection.tsx` | 2671 | **严重**。列表+编辑+详情混合 | 抽列表/编辑弹窗 |
| `v4/ConversationStatusPanel.tsx` | 2246 | 高。状态浮层 collapsed/expanded 双态 | 抽展开态子视图 |
| `v4/ConversationComposer.tsx` | 2238 | 高。已有 plan，附件预览已抽 | 续抽提示词历史/模型选择器 |
| `v4/ConversationRowView.tsx` | 2158 | 高。单行渲染分支多 | 抽 turn 类型 renderer |
| `app-shell/WorkspaceShellLayout.tsx` | 1980 | 中高。布局+resize+frame 管理 | 抽 resize 逻辑 hook |
| `settings/AutomationsSection.tsx` | 1979 | 中高 | 与 AutomationEditView 共用抽象 |
| `v4/ConversationTimeline.tsx` | 1935 | 中。已虚拟化，滚动锚点逻辑重 | 抽 scroll-memory hook |
| `settings/RemotePluginSyncDialog.tsx` | 1898 | 中 | 抽同步步骤子组件 |

## 4. DESIGN.md / i18n / 响应式 / 可访问性 遵从度

**DESIGN.md**：整体遵从度高。语义色 token 是主流，硬编码颜色仅 `bg-white/text-black` 26 处、`text-white/` 17 处，集中在 settings 的 Automation/OffPeak 簇（见 P2）。字号标尺有 13 处 `text-[Npx]` + 6 处内联 `fontSize` 违规，多数可归入图表/终端豁免，业务 UI 违规约 5 处。圆角/间距/尺寸未发现系统性绕过。**超限组件 115 个**是最主要的规范偏离（架构 ratchet 而非视觉规范）。

**i18n**：优秀。react-intl `formatMessage`/`useIntl` 覆盖 441 文件，`useTranslation`/i18n import 428 文件。硬编码中文 JSX 文案 `rg` 命中仅 3 处且全是 JSX 分隔符误报。文案外化到位，翻译膨胀容忍度依赖各组件的 `min-w-0`/truncate。

**响应式**：达标。112 文件用 `sm:/md:/lg:/xl:` 断点；移动 Web 适配集中在 8 个核心交互文件（`SessionPane`、`ConversationComposer`、`V4ComposerToolbar`、`ConversationStatusPanel`、`TaskList(Item)`、`task-row`），符合「移动端单栏+drawer」的布局约定。DESIGN.md 的 `text-mobile-input-safe`（iOS 16px 防缩放）在 composer 输入链有落点。

**可访问性**：基础扎实但有隐患。aria 属性 1457、role 170、tabIndex 65、onKeyDown 130、sr-only/aria-label 597、img alt 覆盖（42 img）。隐患是 `focus-visible:ring-0`/`outline-none` 合计 180 处，其中 P2 那批裸 button 明确移除焦点环且无替代态，键盘用户在这些 settings 操作上会丢失可见焦点——违反 DESIGN.md「Preserve visible focus behavior」。需逐处核实 ring-0 是否配了自定义焦点样式。

## 5. 历史问题回归核对

- **SessionPane.tsx（历史点名 3629 行）**：**未回归，反而恶化到 3762 行**（+133）。`god-component-split-plan.md` 第一批（附件预览接缝）已实施并验证，但占主体的命令组等 4 条接缝仍登记未动，头注豁免自辩「拆散命令组会打散闭包纪律」。属已知债、有计划、推进慢。
- **内存泄漏（`renderer-memory-soak-2026-10-01.md`：87MB→2088MB OOM）**：**已实质治理**。`hidden-pane-subscription-release.md` 的 `subscriptionActive` 门控在 SessionPane 落地（`:1812` 释放 lease → 30s keep-warm → 关投影 store），mount effect 的 acquire/release 清理完整（`:1821-1830`），定时器 Map 统一 clear（`:525-530`），keydown 监听 `:3053-3054` 正确移除。投影窗口限 ≤1200 行/≤32MB。
- **虚拟化**：历史「大列表无虚拟化」风险**已消除**，时间线（`@tanstack/react-virtual` `:686`）与 workspace 任务列表（`virtualized-top-level-list.tsx`）均已窗口化。

## 6. 修复入口建议

P1 的 SessionPane 命令组测试是唯一有登记前置条件的接缝，先补测试再拆；P2 的 AutomationEditView 按钮簇可独立快速修（替换 Button 组件，约 30 分钟）。
