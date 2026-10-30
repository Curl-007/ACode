# ACode 1.0.4 深度 Review · UI 组件/渲染层

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`。方法：只读源码审查 + 上轮（2026-10-22，基线 `ebe9033b`）修复逐条核验 + 24 个变更文件系统扫描。总入口见 [../../project-review-2026-10-26.md](../../project-review-2026-10-26.md)。

范围：`packages/ui/**` 组件/渲染层（不含 store/hooks/lib——见 [ui-state.md](ui-state.md)）。巨型组件、DESIGN.md 遵从、i18n、响应式/手机 Web、可访问性、焦点态。

---

## 1. 上轮修复回归核对

| finding | 声称修复 | 核验结论 | 当前证据（file:line + 计数） |
|---|---|---|---|
| **R1-02 [P1]** SessionPane 巨型组件（3762，增长中） | 切片：抽 `commandOrchestration.ts`（220 行纯逻辑），SessionPane 3762→3672 | **HOLDS** | `SessionPane.tsx` = **3672**（净 −90；git 35 ins/125 del）。自修复提交 `b88c373f` 稳定（`b88c373f`=3672、HEAD=3672，无修复后增长）。**主审亲验 wc -l = 3672** |
| R1-02 新模块 <400、无环 | `commandOrchestration.ts` 220 行纯函数 | **HOLDS** | `session-pane/commandOrchestration.ts` = **220** 行（主审亲验）；5 纯函数；**1 个运行时 import**（叶子 `slashCommands.js:23`），余为 `import type`。无环（`slashCommands.ts` 不反向 import） |
| R1-02 行为等价抽取（deps/闭包保留） | 闭包族逐字保留，仅纯决策外迁 | **HOLDS** | git diff：`submissionConfigFromCommand`/`resolveQueuedComposerRestore`/`shouldRestoreQueuedComposerFromAck` 逐字节迁移；switch→判别联合 `resolveSlashCommandDispatch`，副作用（`logger.warn`、`dispatchCommand`、`Intl...timeZone`）**留在闭包**（`SessionPane.tsx:1838,2411,2524,2539`）。deps 数组未动 |
| R1-02 split-plan 文档与现实一致 | `god-component-split-plan.md` 重写，登记 settings 3 上帝组件 | **HOLDS** | `packages/ui/specs/god-component-split-plan.md`：batch-2 节（`:16-37`）与源码一致；AutomationEditView/SubagentsSection/AutomationsSection 各带批次计划登记（`:58,76,93`） |
| **R2-08 [P2]** Button 基座全局 a11y | `button.tsx` 基座补 `focus-visible:border-input-border-focused`（全部消费方） | **HOLDS** | `components/ui/button.tsx:14` 基座含之；影响 **233** 个 Button 消费文件（上轮 review 记 231；+2 = F 的迁移） |
| R2-08 settings 按钮簇迁移 | 5 文件 → Button variants | **HOLDS** | 5 个全确认：裸 `<button bg-white text-black focus-visible:ring-0>`（`ebe9033b:AutomationEditView:1979,1991,2006` 曾有）现**消失**，替换为 `<Button variant/size>` |
| R2-08 命名文件内计数 | `bg-white\|text-black` 9→0、`ring-0` 5→0、业务 `text-[Npx]` 5→0 | **HOLDS** | 命名 5 文件：`ring-0` = **0**。`bg-white/text-black` = AutomationEditView 2 处（`:986,1005` = F 登记为 NOT-done 的 `bg-[#4099FF]` radio-dot 簇）+ PluginStoreDetailView 2 处（`:269,286` = 内容级照片遮罩例外，有注释）。业务 `text-[Npx]` = 0 |
| R2-08 NOT-done 清单未恶化 | 44 不可见焦点/32 文件、7 bg-white/text-black、212 裸 button、`bg-[#4099FF]` radio | **HOLDS（全部持平或改善）** | `focus-visible:outline-none` 66→**63**；`focus-visible:ring-0` 16→**15**；裸 `<button` 219→**212**；`bg-white/text-black` = **7**；`bg-[#4099FF]` = **3**。无一恶化 |
| 硬编码字号迁移 | 5 处业务 `text-[Npx]` → `text-ui-*` | **HOLDS** | `AutomationsPageTitleSwitch.tsx:29,84` `text-[30px]`→`text-ui-xl`；`ConversationComposer.tsx` `text-[7px]`→`text-ui-xs`；`OccupationOnboardingVisual` `text-[16px]`→`text-ui-lg`；`WorkspaceSidebarFooter:155` `text-[11px]`→`text-ui-xs`。全仓 `text-[Npx]` = **3**，全是注释掉的调试 `<pre>`。图表 `fontSize` 保留 + 豁免注释（`ArtifactChartView.tsx:226`、`TeamTaskGraph.tsx:116`） |
| **错误边界测试** 3→8、真行为 | `splitPaneErrorIsolation.test.ts` 升级 | **HOLDS** | `packages/ui/test/splitPaneErrorIsolation.test.ts` = **8 测**：5（行为 1-5）经 `getDerivedStateFromError`/`render()`/`componentDidUpdate` 驱动真实 `ScopedErrorBoundary` 实例 + 断言 `renderToStaticMarkup`（`role="alert"`、错误文本）与 `boundary.state.error`——真行为非字符串匹配。3（结构守护）用 `readFileSync` 但**显式标注**结构守护（树放置需 jsdom）。API 核验真实：`ErrorBoundary.tsx:367,387,413`。另 `sessionPaneCommandOrchestration.test.ts` = **16 测** |

## 2. 新发现

**1.0.4 变更未在组件/渲染层引入新 P1/P2 缺陷。** 对全部 24 个变更 `packages/ui/src` 文件（`git diff ebe9033b..HEAD`）系统扫描：**零**新设计系统绕过、**零**新硬编码字号（全迁 `text-ui-*`）、**零** i18n 漏（新增 JSX 行无硬编码 CJK——仅注释里有）、**零**新上帝文件增长。

| 级别 | 问题 | 位置 | 证据 | 定性 |
|---|---|---|---|---|
| **P3** | ratchet 对「已超 400 后继续增长」失明 | `.architecture-baseline.json` + `AutomationEditView.tsx`（2942→**2950**，+8） | +8 全是 Button a11y 迁移（`<button className=...>` → `<Button variant size>` = 更多行），即良性修复成本。但它门禁恒绿，因 `legacy-over-limit` regrown 只在**跨越** 400 时触发（HEAD≤400 → tree>400），从不在「已 >400 时继续长」触发（见架构治理专项 fingerprint 分析）。故已登记的上帝组件可隐形继续增长。非 UI 缺陷本身——标记动能含义 | CONFIRMED |
| **P3** | 修剪后拆分计数仍持平 | 见 §3 | SessionPane −90、5 个 Workspace* 组件 −37…−54（E 的 task-meta 收口），却**无文件跌破 400**，故超 400 的 tsx 计数不变 | CONFIRMED |

## 3. 超 400 行文件计数与拆分动能

- **超 400 行 tsx：115 → 115（精确持平，零 churn）。**（主审亲验 `find ... wc -l` = **115**。）集合逐字节相同：0 文件跌破 400、0 文件跨越。（全 ts+tsx 超 400 = 176，匹配 176 条 `module:"ui"` 基线条目。）
- **命名上帝组件方向反转**：SessionPane 上轮 review 时 3629→3762（**增长 +133**）；现 3762→3672（**收缩 −90**）。历史「不降反增」的抱怨被真实修复。
- **本轮真实组件行数削减**：SessionPane −90、WorkspaceHeaderSections −47、WorkspacePinnedTasksSection −48、WorkspaceSidebarItem −37、WorkspaceTimelineTasksSection −54、useTheme −36。新模块 `commandOrchestration.ts` +220（正确 <400）。
- **动能结论：拆分现大致追平增长，但尚未反超。** 1.0.4 的工作止住了出血（SessionPane 不再增长、多文件被修剪、split-plan 有可信的已登记批次）——但因修剪是在上帝文件**内部**削行、未跨越任何文件跌破 400 阈值，**上帝文件计数持平在 115**。要赢需已登记的 batch-1「helper 外迁」拆分（AutomationEditView/SubagentsSection/AutomationsSection）真正落地并把文件推到 400 以下；尚无一开始动。

## 4. 层面健康度

**良**。本层的 1.0.4 修复高质量且诚实：每个声称的修复都经源码核验（SessionPane −90 单调、干净纯函数抽取无环、全局 Button 焦点环修复惠及 233 消费方、5 个 settings 文件全迁离裸 button/`bg-white`/`ring-0`、业务 `text-[Npx]` 全 → `text-ui-*`、错误边界测试升级为 5 真行为 + 3 诚实标注的结构守护），F 登记的 NOT-done 残留全部持平或改善（无一回归）。无新 P1/P2。不到优的唯一原因是**结构停滞**：超 400 上帝文件计数不变（115），ratchet 看不见 400 以上的增长（AutomationEditView +8），故巨型组件债在被**稳定**而非**削减**。
