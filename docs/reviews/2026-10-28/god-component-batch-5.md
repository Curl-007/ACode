# 上帝组件拆分 · 批次 5 实施报告（src 根两件 + app-shell 一件 + ai-elements 一件 + 侧栏一件）

日期：2026-10-28（Asia/Shanghai）。基线：`fix/project-review-2026-10-26` worktree。
方法：按批次 1-4 已验证的模式 A（纯决策逻辑外迁 + 决策表单测）与批次 4 的「闭包 → 受控组件」/「controller hook 收口」样板，5 个组件由本批实施，集成者统一收口 spec / ratchet / 门禁。

输入：
- 拆分计划：[../../../packages/ui/specs/god-component-split-plan.md](../../../packages/ui/specs/god-component-split-plan.md)（批次 5 五节已登记并标实施）
- ratchet 守护：[../../../packages/ui/tests/godComponentLineRatchet.guard.test.mjs](../../../packages/ui/tests/godComponentLineRatchet.guard.test.mjs)（上限表 +5 条）

选件理由（任务书口径「优先非 v4-session 域；行数大的优先」）：取候选清单中非 v4 的前 5 名。
v4 两件（ConversationRowView 2158 / ConversationTimeline 1923）按批次 4 纪律留给后续批次做风险评估后单独处理，本批不碰。

---

## 1. 结果总览（行数均为 wc -l 物理行实测）

| 主文件 | 拆前 | 拆后 | 减量 | 新叶子数 | 新测试用例 |
|---|---:|---:|---:|---:|---:|
| `app-shell/WorkspaceShellLayout.tsx` | 1980 | **1725** | −255 | 2 | 5 |
| `PreviewPane.tsx` | 1806 | **1447** | −359 | 4 | 23 |
| `WorkspaceSidebar.tsx` | 1701 | **1458** | −243 | 3 | 11 |
| `components/ai-elements/message.tsx` | 1691 | **1337** | −354 | 2 | 21 |
| `LexicalChatInput.tsx` | 1517 | **1105** | −412 | 2 | 16 |
| **合计** | 8695 | **7072** | **−1623** | **13** | **76** |

13 个新叶子全部 <400 物理行（固定验收第 5 条）。5 个主文件仍 >400——本批按 split-plan 口径属内部修剪，不计入「跌破 400」拆分进度；超 400 tsx 计数不变（HEAD 实测 115 → 115，本批未新增 >400 文件；批次 4 报告的 117 与本次 115 的口径差异源于批次 4 计数含其他目录，本次以 `find packages/ui/src -name '*.tsx'` 实测 HEAD/工作树双侧一致为准）。

## 2. 各组件明细

### 2.1 `app-shell/WorkspaceShellLayout.tsx`：1980 → 1725

- `app-shell/workspaceSidebarWidth.ts`（82 行）：8 个常量 + `WorkspaceSidebarResizeSession` 类型 + 侧栏宽度 clamp / localStorage 读写 / legacy RRP 百分比迁移读取，逐字迁入（`typeof window` 守卫与 try/catch 原样）。
- `app-shell/useWorkspaceSidebarResize.ts`（255 行）：resize 状态机（state + 2 ref + 3 effect + 5 callback）收口为 controller hook，hook 内部顺序与全部 deps 逐字；主文件在 auto-collapse effect 之后单点调用，JSX 消费（style memo / 四个事件槽 / aria-valuenow）零改动。
- 偏离登记：主文件 `aria-valuemin` 仍用 `WORKSPACE_SIDEBAR_MIN_WIDTH_PX`，从叶子 import（常量单一来源在叶子）。
- 测试：`test/workspaceSidebarWidth.test.ts` 5 例（clamp 矩阵 / storage 读取钳制与异常吞咽 / legacy ratio 解析 / persist 取整），window/localStorage 用最小桩（Object.assign globalThis + 还原）。hook 无 jsdom 不测，按固定验收第 4 条登记。

### 2.2 `PreviewPane.tsx`：1806 → 1447

- `previewPane/previewPaneSources.ts`（227 行）：markdown/svg 判别、text 读取结果决策、image/media/pdf/pptx source 解析族、header divider 与 display options 派生、PDF/PPTX 常量。
- `previewPane/previewPaneErrors.ts`（80 行）：ENOENT/过大/pptx 不完整错误分类 + 绝对路径脱敏 + pptx 读取错误文案决策。
- `previewPane/previewPaneBreadcrumb.ts`（82 行）：面包屑数据类型 / 遮罩 class 映射 / 段归一化 / `buildCodeViewerBreadcrumb`（workspace 相对与 posix/windows 绝对双分支）。
- `previewPane/PreviewPaneDeferredHeavyContent.tsx`（35 行）：延迟占位纯展示组件 + 行宽常量。
- `readPreviewPaneScrollMetrics`（DOM metrics）与 `EMPTY_CODE_COMMENT_PREVIEWS` 留主文件。
- 测试：`test/previewPaneSources.test.ts` 11 例 + `test/previewPaneErrors.test.ts` 6 例 + `test/previewPaneBreadcrumb.test.ts` 6 例。

### 2.3 `WorkspaceSidebar.tsx`：1701 → 1458

- `WorkspaceSidebar/WorkspaceSidebarTaskToolbar.tsx`（300 行）：`workspaceTaskToolbar` 闭包 JSX（~215 行）逐字外迁为受控组件；主文件保留 useCallback 适配闭包，deps 列表按原样稳定 render prop（性能修复语义不变，组件本体不带 memo）。
- 偏离登记：适配闭包 deps 增加 `workspaceReadOnly`/`workspaceReadOnlyReason`（原闭包引用但未声明 deps，属既有 stale-closure 隐患，受控化后必须显式声明——行为向正确方向修复）；`intl` 移出 deps（闭包不再直接引用，locale 切换由 deps 内 `archivedTasksActionLabel` 覆盖）。sort 守卫与 archived 切换的内联箭头移入组件（经 props 回调，逐点等价）。
- `WorkspaceSidebar/sidebarTaskViewMode.ts`（22 行）：`resolveSidebarTaskViewMode` + `SidebarTaskViewMode` 单一来源迁入（主文件删本地别名）。
- `WorkspaceSidebar/sidebarChrome.tsx`（51 行）：`WorkspaceNewTaskTooltip` + `WorkspaceDragOverlay`。
- 测试：`test/sidebarTaskViewMode.test.ts` 2 例 + `test/workspaceSidebarChrome.test.ts` 4 例 + `test/workspaceSidebarTaskToolbar.test.ts` 5 例（renderToStaticMarkup 渲染契约；Radix DropdownMenu/Tooltip 走 Portal 仅钉 Trigger 侧，TooltipProvider 包装，口径同 pluginListRows 先例）。

### 2.4 `components/ai-elements/message.tsx`：1691 → 1337

- `messageMarkdownMath.ts`（198 行，零依赖纯字符串函数）：单美元行内公式归一化族——6 模式 + 围栏跟踪 / 转义判定 / 货币区间保护 / 行内代码跳过，逐字迁入。
- `messageFileLinkTargets.ts`（182 行）：`MessageFileLinkTarget` 类型单一来源迁入 + href 规整 / shouldRewrite 决策 / rehype 改写插件 / link target 构建 / stat 确认打开 / `isExternalWebHref` + `HastElementNode`。
- 对外契约保持：主文件 re-export `MessageFileLinkTarget`（7 个既有消费方：workspacePathNavigation / side-pane 族 / AssistantPreviewCards）与 `buildMessageFileLinkTarget`/`openMessageFileLinkInEditor`（包导出面不变）。
- 删除死代码 `knownExtensionlessFileNames`（全仓 grep 零引用，定义后从未被消费）。
- 边界私有件留主文件：`hashMarkdownCacheKey`/`normalizeMarkdownRenderError`/`resolveMessageStreamdownMode`/`buildMessageStreamdownRenderKey`/`getAttachmentReaderEpoch`/`resolveMessageCodeTheme`。
- 测试：`test/messageMarkdownMath.test.ts` 11 例 + `test/messageFileLinkTargets.test.ts` 10 例。测试期望全部按迁移后函数实测行为校准（如：只转义成对非公式 `$` 的开启符、孤立 `$` 原文保留；dotfile 整体命中扩展名正则）。
- **连带登记**：message.tsx 是 third-party 台账（`third-party/inventory.json`）inputs 追踪件，本批改动导致 L01 干净树审计哈希漂移——**预期内合法连带**，按 orchestrator 纪律由 licenses-notices.yml CI Linux 统一重生成落位（2ddaf691 先例）；本代理曾误改台账一行，已逐字还原并经 `git diff` 确认 third-party/ 与 THIRD-PARTY-NOTICES.md 零改动。
- 注意：该文件属 oxlint `ignorePatterns`（vendored 衍生件），行数约束仅由 ratchet 守护与架构门禁承载。

### 2.5 `LexicalChatInput.tsx`：1517 → 1105

- `lexical-chat-input/lexicalChatInputDecisions.ts`（87 行）：提交/重置/中文顿号别名 4 个决策函数 + 4 个选项接口 + `LexicalSubmitResult` + 2 常量。
- `lexical-chat-input/lexicalEditorActions.ts`（374 行）：15 个编辑器动作函数（文本/mention 替换、追加、state JSON 恢复、选区归位、insertMention）逐字迁入；全部以 `LexicalEditor` 实例为参数，无 React。
- DOM-selection 助手（`getPromptMentionIdAfterDomSelection`/`getPromptMentionIdFromBoundaryNode`，window.getSelection / HTMLElement.matches）留主文件，无 jsdom 不测，按固定验收第 4 条登记。
- 测试：`test/lexicalChatInputDecisions.test.ts` 6 例（决策矩阵）+ `test/lexicalEditorActions.test.ts` 10 例——**headless Lexical**（`createEditor` + `PromptMentionNode` 无 DOM 跑真实 update/read，实施前探针验证可行）；`.png` 资源链路用 `module.registerHooks` 重定向到 data: 空模块（对照 pluginListRows 先例，测试头注已说明）；update 提交等待用 `registerUpdateListener` 真实事件 + `Promise.withResolvers`，无 wall-clock 定时器。

## 3. 门禁实测

| 门禁 | 结果 | 基线对比 |
|---|---|---|
| `pnpm --filter @acode/ui test` | **1125 pass / 0 fail**（13s） | 基线 1049 + 本批新增 76 = 1125 ✓ |
| `npx tsc -p packages/ui/tsconfig.json --noEmit` | **exit 0** | 0 错 ✓ |
| `pnpm lint` | **164 warnings / 0 errors** | 与基线 164w/0e 持平；WorkspaceShellLayout 触碰文件 6 条 warning 经 HEAD 版 lint 核对为既有 warning 行号位移（PanelImperativeHandle/V4ChatPane/Button 未用 import + 3 个未用参数，HEAD 同为 6 条）；WorkspaceSidebar 的 `bumpTaskListVersion` 未用变量同样为既有位移 ✓ |
| `pnpm architecture:check --changed` | **new 0 / regrown 0**（violations 297 = baseline 297；legacy over-limit 413，较批次 4 报告的 414 只减不增） | ✓ |
| `godComponentLineRatchet.guard.test.mjs` | 绿（含在上条 1125 内） | 上限表 +5 条（1725 / 1447 / 1458 / 1337 / 1105），split-plan 登记表解析互查通过 ✓ |
| L01 台账（`scripts/licenses.mjs reproducibility --inputs-only`） | 本批改动 message.tsx 后**预期漂移**，台账未动 | orchestrator 整合阶段走 CI Linux 重生成（见 §2.4 连带登记） |

## 4. 改动文件清单（本批文件集）

主文件（5）：`app-shell/WorkspaceShellLayout.tsx`、`PreviewPane.tsx`、`WorkspaceSidebar.tsx`、`components/ai-elements/message.tsx`、`LexicalChatInput.tsx`（均在 packages/ui/src 下）。

新叶子（13）：
- `previewPane/`（4）：previewPaneSources.ts / previewPaneErrors.ts / previewPaneBreadcrumb.ts / PreviewPaneDeferredHeavyContent.tsx
- `WorkspaceSidebar/`（3）：WorkspaceSidebarTaskToolbar.tsx / sidebarTaskViewMode.ts / sidebarChrome.tsx
- `components/ai-elements/`（2）：messageMarkdownMath.ts / messageFileLinkTargets.ts
- `lexical-chat-input/`（2）：lexicalChatInputDecisions.ts / lexicalEditorActions.ts
- `app-shell/`（2）：workspaceSidebarWidth.ts / useWorkspaceSidebarResize.ts

新测试（9 文件 76 例）：previewPaneSources(11) / previewPaneErrors(6) / previewPaneBreadcrumb(6) / sidebarTaskViewMode(2) / workspaceSidebarChrome(4) / workspaceSidebarTaskToolbar(5) / messageMarkdownMath(11) / messageFileLinkTargets(10) / lexicalChatInputDecisions(6) / lexicalEditorActions(10)。

治理文件：`packages/ui/specs/god-component-split-plan.md`（+5 节并标批次 5 已实施、状态行更新）、`packages/ui/tests/godComponentLineRatchet.guard.test.mjs`（上限表 +5 条）。

集合外改动：**零**（third-party/ 台账曾误改一行已逐字还原，git diff 确认零改动）。

## 5. 风险评估与遗留

1. **v4 两件未动**（ConversationRowView 2158 / ConversationTimeline 1923）：按任务书纪律留给后续批次，先做批次 4 式风险评估（Impl/memo/tick/scroll policy 不动，只拆纯函数接缝）。
2. **WorkspaceShellLayout** 剩余高风险簇：conversation auto-collapse（resize idle + 双 rAF 降级）与 pane 编排 JSX；建议下一批先拆 auto-collapse 为独立 hook（输入面已明确），pane 子树外迁需先定义 props 边界。
3. **WorkspaceSidebar** toolbar 偏离项（deps 补 `workspaceReadOnly`/`workspaceReadOnlyReason`）为向正确方向的修复，已登记；主组件三态任务区编排为下一批候选。
4. **无 jsdom 留白**（固定验收第 4 条口径）：`useWorkspaceSidebarResize` hook、DOM-selection 两函数无单测，依赖 typecheck + 邻接决策表覆盖 + 人工验证。
5. **headless Lexical 测试模式**已验证可行（registerHooks + 动态 import + update 事件等待），可供批次 6 复用。
6. **L01 台账漂移**为预期连带，orchestrator 统一走 CI 重生成；后续批次若再动 ai-elements 追踪件（markdown-table.tsx 等）同样照此办理。

**报告完。**
