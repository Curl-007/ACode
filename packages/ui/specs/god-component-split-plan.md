# v4 上帝组件拆分计划（SessionPane / ConversationComposer / settings 上帝组件）

状态：第一批已实施（2026-10-05，附件预览接缝）；第二批已实施（2026-10-22，SessionPane 命令编排纯决策逻辑抽出 + 接缝内测试）；批次 4 已实施（2026-10-28，ExternalAgentImportDialog / PluginsSection / WorkspaceGroupedTasksSection / SettingsPage helper 外迁 + ConversationStatusPanel 保守纯函数外迁，见下文各节）；批次 5 已实施（2026-10-28，WorkspaceShellLayout / PreviewPane / WorkspaceSidebar / message / LexicalChatInput 五件 helper+受控组件外迁，见下文各节）。其余接缝为登记在案的后续批次。
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

### 拆分动能备注（2026-10-26 review 登记，仅登记不改门禁）

1.0.4 全项目 review（[../../../docs/reviews/2026-10-26/ui-components.md](../../../docs/reviews/2026-10-26/ui-components.md) §2/§3）
观察到一条**拆分动能**事实，登记在此供后续批次参考：

- **超 400 行 tsx 计数 115 → 115（精确持平，零 churn）**。本轮虽有多文件被修剪
  （SessionPane −90、WorkspaceHeaderSections −47、WorkspacePinnedTasksSection −48、
  WorkspaceSidebarItem −37、WorkspaceTimelineTasksSection −54、useTheme −36），
  但**修剪都发生在上帝文件内部**，没有把任何文件推到 400 行以下，因此超阈值计数不变。
  动能结论：拆分现大致追平增长，但**尚未反超**。
- **`legacy-over-limit` ratchet 只在「跨越」400 时触发**（HEAD≤400 → tree>400），
  对「已 >400 时继续增长」**失明**。故已登记的上帝组件可隐形继续增长——
  例：`AutomationEditView.tsx` 本轮 2942→**2950**（+8，全是 Button a11y 迁移的良性修复成本），
  门禁恒绿。即：只要一个文件已经超限，它再长多少都不会让门禁变红。

**因此，本计划各已登记批次的完成判据补充**（见「每批拆分的固定验收」第 6 条）：
适用时（拆分目标就是要把文件推到 400 以下的批次，如 settings 三件套的第一刀「helper 外迁」）
必须显式验收「**目标文件行数跌破 400**」，而不是只看「行数下降」。内部修剪若未跨阈值，
不计入拆分进度，避免「修剪很多、上帝文件计数纹丝不动」的动能假象。

**后续治理项 —— ✅ 已落地（2026-10-27）**：为**已登记进本 split-plan 的文件**引入了一条
**行数 ratchet**，实现为守护测试 `packages/ui/tests/godComponentLineRatchet.guard.test.mjs`
（三条断言）：

1. **上限表**：每个登记文件钉一个物理行上限，超过即红。基线取**实测当前行数**
   （AutomationEditView 2,950 / SubagentsSection 2,671 / AutomationsSection 1,979），
   不是表头的登记时行数——AutomationEditView 表头写 2,942，差的 8 行是本节自己记载的
   Button a11y 迁移合法成本，ratchet 的职责是冻结债务在**当前**水位，不追溯已合入工作。
2. **登记表防腐**：文件消失、或已跌破 400（拆分批次完成）时红，提示从上限表移除条目。
3. **防漏登记**（关键：防盲区重开）：解析本文件所有 `### \`<path>.tsx\`（` 登记标记，
   断言每个登记文件都在上限表内、且上限表不含本文件已不登记的条目。**新登记的批次若忘了加
   上限，守护立即红**——这是「靠纪律」变「靠门禁」。

选择守护测试而非改 `scripts/architecture`（本计划原文建议的方向）的理由：
- `scripts/architecture/index.mjs` 已 447 行 / oxlint 有效行 398，只剩 **2 行**余量，加规则
  必须先拆 checker，风险与本项收益不成比例；
- 架构棘轮的 `newViolations` 是**基线过滤**后的集合，指纹类规则可被 `baseline:update` 吸收，
  而守护测试不可被吸收——ratchet 必须不可绕过才有意义；
- 仓库已有同构先例：`browser-open-pattern-repo-guard`、`legacy-protocol-barrel-freeze`、
  `i18nLocaleParity`、`themeWriteOwnership.guard` 都是「机械不变量用守护测试兜」。

**处置口径**（写进守护的失败消息）：超限只能二选一——按批次拆到上限以下（首选，最终目标
跌破 400），或经评审显式上调上限并在提交信息写明理由；不得静默改数字让门禁变绿。

**已验证非空转**：给 AutomationEditView 追加 1 行 → 守护红并报出 `2951 行 > 上限 2950（+1）`；
还原后绿。

### `settings/AutomationEditView.tsx`（2,942 行；27 state / 12 effect / 16 memo / 11 callback）

> 动能备注（2026-10-26 review）：本轮该文件 2942→**2950**（+8），增量全部是 Button a11y 迁移
> （裸 `<button className=...>` → `<Button variant size>` 行数变多）的良性修复成本，
> 但因 `legacy-over-limit` ratchet 只在跨越 400 时触发，此增长门禁恒绿、不可见。
> 属「已超限文件继续增长」的典型样本，见上「拆分动能备注」与固定验收第 7 条。
>
> **批次 1 已实施（2026-10-28，helper 外迁）**：2950→**2799**（−151）。
> - 新建 `settings/automation/scheduleModel.ts`（154 行）：`buildRunsPageItems`/`workspaceLabelFromPath`/
>   `pad2`/`daysInMonth`/`toDateInputValue`/`localDateEndTimestamp`/`parseDateInputValue`/`resolveRunStatus`/
>   `normalizeAutomationScheduleRule` + `FREQUENCIES`/`isCronFrequency`/`RUNS_PAGE_SIZE`/`CUSTOM_REPEAT_*`/
>   `RUN_STATUS_*`/`AUTOMATION_STATUS_*` + `RunStatusKind` 类型（与 `resolveRunStatus` 同源共迁）。
> - 新建 `settings/automation/cronBuilder.ts`（58 行）：`defaultBuilder`/`initialBuilder` + re-export
>   `CronBuilderState`（类型单一来源仍在 `automationFormat.ts`，避免批次 3 落地时出现双份声明）。
> - 前置测试：`test/automationScheduleModel.test.ts`（分页 / 日期解析 / 状态决策矩阵 22 用例）+
>   `test/cronBuilder.test.ts`（defaultBuilder 初值稳定性 / initialBuilder 三路分支 7 用例）。
> - 选择器族 7 个组件（批次 2，下文接续实施）与 27 state（批次 3 处理）**未动**。
> - 验证：`tsc -p packages/ui/tsconfig.json --noEmit` 0 错、`pnpm --filter @acode/ui test` 915/915、
>   触碰文件 oxlint 0 警告、`godComponentLineRatchet.guard.test.mjs` 上限 2950→2799 已同步。
> - 实减量 −151 < 计划 −320 的原因：`parseCronToBuilder`/`CronBuilderState` 等本就在
>   `automationFormat.ts` 而非主文件，拆前估算的 grep 行段把它们算进去了；不影响批次实质。
>
> **批次 2 已实施（2026-10-28，选择器族外迁）**：2799→**1944**（−855）。
> - 新建 `settings/automation/pickers/` 子目录，7 个 picker 各自成文件 + 1 个共享 section 文件：
>   - `TimeUnitColumn.tsx`（49 行）/ `TimeOfDayPicker.tsx`（53 行）/
>     `ScrollNumberColumn.tsx`（53 行）/ `MonthDayPicker.tsx`（78 行）/
>     `WeekdayPicker.tsx`（70 行）/ `EndDatePicker.tsx`（150 行）/
>     `CustomRepeatDialog.tsx`（391 行）；
>   - `CustomRepeatUnitSections.tsx`（178 行）：`CustomRepeatWeeklyGrid`（weekly 7 日勾选网格）+
>     `CustomRepeatMonthlySection`（monthly 的 monthlyMode select + byDate/byWeekday 二选一网格），
>     抽出是为让 `CustomRepeatDialog` 自身落到 max-lines 400 以下（拆前 472 有效行），
>     语义与样式逐字从 Dialog 迁入，**不改行为**。
> - 受控 props 模式保留：TimeOfDay/MonthDay/Weekday/EndDate 四个 picker 仍是「受控组件」
>   （`value`+`onChange`），open 弹层态为内部视觉态不属于受控值。CustomRepeatDialog 例外
>   保留原「编辑型弹窗」语义——打开时把 builder/endAt 拷进内部 state 作草稿，确认时一次性
>   `onConfirm` 提交；这是「草稿」语义而非受控值语义，与原实现逐字一致。
> - 共享 helper 收敛：`CustomRepeatSelectIndicator` / `CustomRepeatCalendarIcon` /
>   `CUSTOM_REPEAT_SELECT_CONTENT_CLASS` / `CUSTOM_REPEAT_SELECT_ITEM_CLASS` 只服务
>   CustomRepeatDialog / EndDatePicker，分别就近迁入 `CustomRepeatDialog.tsx` /
>   `EndDatePicker.tsx` / `CustomRepeatUnitSections.tsx`（不是新模块共享 export，避免循环）。
> - 主文件清理：删掉 7 个 picker 函数定义 + 4 个共享 helper + dead JSDoc；同步清理
>   已无消费的 import（lucide 的 CalendarDays/Check/Chevron*/X、shared 的 TID_AUTOMATION_CUSTOM_*/
>   TID_AUTOMATION_YEAR_*、组件库的 Popover/Dialog/ScrollArea、scheduleModel 的
>   CUSTOM_REPEAT_INTERVAL_*/daysInMonth/localDateEndTimestamp/parseDateInputValue/toDateInputValue、
>   automationFormat 的 WEEKDAY_ORDER 与 CustomRepeatUnit）。
> - 前置测试：`test/automationPickers.test.ts`（**14 测**全绿）：
>   - TimeUnitColumn（2 测）：count=24 渲染 0..23 + 受控 selected 高亮；count=60 与 count=0 边界。
>   - ScrollNumberColumn（2 测）：values 数组渲染 + buttonTestIdPrefix 透传 e2e testid；与
>     TimeUnitColumn 的选中样式差（bg-primary vs bg-menu-hover）。
>   - TimeOfDayPicker（2 测）：触发器 HH:MM 受控值（pad2 补零）；hour=0/minute=59 与 hour=23/minute=0 边界。
>   - MonthDayPicker（2 测）：触发器「M 月 D 日」受控值；data-testid=TID_AUTOMATION_YEAR_MONTHDAY
>     e2e 稳定选择器。
>   - WeekdayPicker（2 测）：受控 weekdays prop 决定 trigger label；空数组与全 7 天边界不抛错。
>   - EndDatePicker（2 测）：受控 value（YYYY/M/D）+ disabled attribute 精确断言（规避
>     Tailwind `disabled:` 变体类的误匹配）；无效 value 回退渲染原始字符串。
>   - CustomRepeatDialog（2 测）：open=false Portal 空串；open=true 接受全部
>     customUnit × endAt 组合不抛错（Radix Portal 在 renderToStaticMarkup 下无 DOM 输出，
>     DOM 内容断言属 e2e 范畴）。
> - 验证：`tsc -p packages/ui/tsconfig.json --noEmit` 0 错、`pnpm --filter @acode/ui test` 959/959、
>   触碰文件 oxlint 0 警告、`godComponentLineRatchet.guard.test.mjs` 上限 2799→1944 已同步。
> - 27 state 仍留在主文件，属批次 3（cron builder state 机收敛）范围。
>
> **批次 3 已实施（2026-10-28，cron builder reducer 收敛）**：1944→**1925**（−19）。
> - 新建 `settings/automation/cronBuilderReducer.ts`（94 行）：`cronBuilderReducer` 纯函数 +
>   `CronBuilderAction` 严格 discriminated union（8 种 action：`setFrequency` / `setDayOfMonth` /
>   `setWeekdays` / `setTimeOfDay` / `setMinute` / `setYearlyMonthDay` / `applyCustomRepeat` / `reset`）。
>   spec：packages/ui/specs/automation-edit-batch-3-cron-builder-reducer.md。
> - 主文件 8 个 `setBuilder((prev) => ({...prev, ...}))` 调用点全部改为 `dispatchBuilder({...})`；
>   `useState<CronBuilderState>` 改为 `useReducer(cronBuilderReducer, { editing, initialDraft },
>   ({ editing, initialDraft }) => initialBuilder(editing, initialDraft))`（lazy init 保留
>   「首帧即用真实 cron」语义，不引入 effect 回填）。
> - weekdays 频率切换规则收敛：reducer 内 `resolveWeekdaysForFrequency` 统一处理
>   「weekdays → [1..5] 强制，其它频率保留 weekdays」；原两个调用点逐字迁移同一规则。
> - CustomRepeatDialog onConfirm 一次性提交语义保留：dispatch `applyCustomRepeat` 强制
>   `frequency: "custom"`，5 个 custom* 字段同步更新；`endAt` 仍由独立 state 管理（不属于 builder）。
> - 表单其它 state（title / prompt / model / mode / thoughtLevel / workspaceKey / endAt /
>   scheduleRemoved / validationErrors / touchedFields / customRepeatOpen / runsPage / tab /
>   saveAndRunPending）**未动**，不属于 builder 簇。
> - 前置测试：`test/cronBuilderReducer.test.ts`（**15 测**全绿）覆盖 setFrequency 三个分支 /
>   纯函数性（不改原 state）/ 单字段更新 / applyCustomRepeat 一次性提交语义 / reset 整体替换 /
>   discriminated union 遍历 / 幂等性。
> - 验证：`pnpm --filter @acode/ui test` 974/974、`npx tsc -p packages/ui/tsconfig.json --noEmit` 0 错、
>   `pnpm architecture:check --changed` exit 0（new violations 0）、触碰 3 文件 oxlint 0 警告、
>   `godComponentLineRatchet.guard.test.mjs` 上限 1944→1925 已同步。
> - 注意：根 `pnpm typecheck` 当前**因 cli/core 的 baseline syntax error 失败**
>   （`apps/acode-cli/packages/core/src/runtime/runtime-cache-diagnostics.ts:184` 缺 `=>`），
>   与本批无关；ui 包 `tsc --noEmit` 单跑 exit 0。

- 职责分析：单文件混合「cron/自定义重复排程编辑器 + 时间/星期/月日选择器 + 表单 schema + 操作按钮簇 +
  运行历史分页」。顶部已有 ~15 个纯 helper（`buildRunsPageItems`/`workspaceLabelFromPath`/`daysInMonth`/
  `toDateInputValue`/`localDateEndTimestamp`/`parseDateInputValue`/`resolveRunStatus`/
  `normalizeAutomationScheduleRule`/`defaultBuilder`/`initialBuilder`）与多个纯展示子组件
  （`TimeUnitColumn`/`TimeOfDayPicker`/`ScrollNumberColumn`/`MonthDayPicker`/`WeekdayPicker`/
  `EndDatePicker`/`CustomRepeatDialog`）。
- 建议接缝（从浅到深）：
  1. **纯 helper 外迁** → `settings/automation/scheduleModel.ts`（排程规则/日期解析/分页），补决策表单测——**已实施（2026-10-28）**；
  2. **日期/时间选择器族** → `settings/automation/pickers/`（TimeOfDayPicker/MonthDayPicker/WeekdayPicker/
     EndDatePicker/CustomRepeatDialog 各自成文件，纯展示 + 受控 props）——**已实施（2026-10-28）**；
  3. **cron builder state 机** → `settings/automation/cronBuilderReducer.ts`（cronBuilderReducer +
     CronBuilderAction discriminated union），把 builder 簇的 useState 收敛为单一 useReducer——**已实施（2026-10-28）**；
  4. **操作按钮簇** → 复用 `components/ui/button.tsx`（与 P2 的按钮/焦点环修复合并做）。
- 前置测试：scheduleModel 与 cronBuilder 的纯函数单测（第一刀前建）；选择器族用 renderToStaticMarkup 钉受控渲染。
- 预估批次：3 批（~~helper 外迁~~ → 选择器族拆分 → cron builder reducer 收敛）。

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
  2. **列表 + 行内摘要/覆盖控件** → `settings/subagents/SubagentList.tsx`（含 `AgentListRow` 行组件与
     `SubagentModelOverrideControl` 行内 model 覆盖控件——它们就是 split-plan 原稿里
     「详情展示态」的实际对应物，本文件**没有独立的「选中 agent 只读完整详情视图」**，
     `isFormView` 分支渲染的是可编辑 `SubagentForm`，非只读详情）；
     **编辑表单** → `settings/subagents/SubagentForm.tsx`（34 state 按列表选择态 / 表单草稿态
     拆到两个组件，避免单文件持有全部）。
- 前置测试：agentModel 纯函数单测（能力矩阵、工具合并去重、模型档位可用性、表单初值 key 稳定性）。
- 预估批次：2 批（helper 外迁 → 列表/表单拆分）。原稿的「详情拆分」经 2026-10-28 批次 2 实施前
  实测不存在（无独立只读详情视图），已并入 SubagentList 的行内摘要/覆盖控件，不再单列。
- 状态：**batch-1 helper 外迁已实施**（2026-10-28）。抽出 `settings/subagents/agentModel.ts`
  （**318 行**，21 个纯函数 + 6 常量集中 export `TOOL_OPTIONS`/`TOOL_OPTION_SET`/`RISKY_TOOLS` 避免循环），
  主文件 2671 → **2416**（−255；调研报告预估 2271，差 +145 因为 `groupAgentsByScope`/`groupPluginAgentsById`
  按 21 函数严格边界未外迁，归下一批）；前置测试 `test/subagentModel.test.ts`（**31 测**全绿）覆盖
  能力矩阵 × 工具合并去重 × 模型档位可用性 × 表单初值 key 稳定性；ratchet 上限同步调至 2416。
- 状态：**batch-2 列表/表单拆分已实施**（2026-10-28）。新建 7 个模块（architecture max-file-lines
  物理行口径 400 上限，初版 SubagentForm.tsx 421 / SubagentFormFields.tsx 409 超上限于 2026-10-28 二次拆分）：
  - `settings/subagents/SubagentList.tsx`（**370 行**）：`SubagentGroupBatchMenu` /
    `SubagentGroupSelectAll` / `AgentListRow` 三个受控组件，列表选择态的批量菜单 / 分组
    三态全选 / 行内只读摘要徽标与批量复选框；
  - `settings/subagents/SubagentModelOverrideControl.tsx`（**292 行**）：行内 model/effort
    覆盖控件（即改即存 + persistConfig 回滚语义）；独立成文件是为满足「新模块 <400 行」，
    从 SubagentList.tsx 再拆出；
  - `settings/subagents/SubagentForm.tsx`（**379 行**）：编辑表单 + 12 个草稿 state +
    `previousInitialFormStateKeyRef` 回灌守卫；validate 函数（60 行）抽为纯函数
    `subagentFormValidate.ts`；
  - `settings/subagents/SubagentFormIdentityFields.tsx`（**168 行**）：身份组字段子组件
    （Scope/Name/Color/Description），从 SubagentFormFields.tsx（409）按职责拆出；
  - `settings/subagents/SubagentFormCapabilityFields.tsx`（**263 行**）：能力组字段子组件
    （Model/Tools/SystemPrompt/InjectAgentsMd），同源拆出；
  - `settings/subagents/subagentFormValidate.ts`（**120 行**）：`validateSubagentFormFields`
    纯函数（名称 3–50 + 字符集 / description/systemPrompt 必填 / 失效模型阻止保存），
    接收 intl 适配器与 4 个 setError 回调，主文件经它做提交前校验；
  - `settings/subagents/primitives.tsx`（**145 行**）：`FormFieldLabel` / `AgentColorDot` /
    `AgentBadge` / `ToolCheckbox` / `BatchRowCheckbox` 5 个纯展示子组件。
  主文件 2416 → **1181**（−1235）。前置测试 `test/subagentSections.test.ts`（**13 测**全绿）：
  5 个纯展示子组件的 `renderToStaticMarkup` DOM 契约 + SubagentList/SubagentForm 的
  结构守护（无 jsdom 时的接缝内测试替代，split-plan 「每批拆分的固定验收」第 4 条登记口径）。
  `test/subagentBatchWiring.test.ts` 同步更新断言锚点（行交互/分组组件已迁至 SubagentList.tsx，
  TID 字面量按所有权分布到三个文件）；ratchet 上限同步调至 1181。
  `SubagentDetail` 经 2026-10-28 批次 2 实施前实测不存在（无独立只读详情视图），其职责
  实际由 `AgentListRow` 的行内摘要 + `SubagentModelOverrideControl` 行内覆盖控件承担，
  已并入 SubagentList 不再单列。
  门禁实跑：`pnpm architecture:check --changed` exit 0（new violations 0）、
  `pnpm --filter @acode/ui test` 959/959、`tsc -p packages/ui/tsconfig.json --noEmit` exit 0、
  触碰 12 个文件 oxlint 0 警告 0 错。
- 状态：**所有已登记批次完成**。`SubagentsSection.tsx` 当前 1181 行，仍 >400；下一刀是
  主组件内 22 个 state 的 reducer 收敛（批次 3，独立登记）。

### `settings/RemotePluginSyncDialog.tsx`（1,898 行；max-lines 豁免）

> 登记来源：review 2026-10-28 batch-1 调研报告 §3.④（docs/reviews/2026-10-28/god-component-batch-1.md）。

- 职责分析：行 57–1058 是 ~1000 行纯 helper（行构建/选择解析/进度计算/stopped 错误形态）+ 选择/进度/结果三段 UI 子组件 + 主组件（行 1515，~380 行）。
- 建议接缝：
  1. **纯 helper 外迁** → `settings/remote-plugin-sync/remotePluginSyncModel.ts`（~500 行，27 个纯函数整组搬，内部互相引用密集不拆散），补决策表单测；副作用函数 `emitRemotePluginSyncProgress`/`throwIfRemotePluginSyncStopped` 留在主文件；
  2. （下一批）`SelectionList`/`ProgressList`/`ResultList` 三个子组件外迁。
- 前置测试：`test/remotePluginSyncModel.test.ts`（行构建矩阵 × 选择解析 × portable option 值 × stopped 错误形态）。
- 预估批次：2 批（helper 外迁 → 子组件外迁）。仅 helper 外迁后主文件 ~1398 行，**不跌破 400**（固定验收第 6 条不适用本批）。
- 状态：**batch-1 helper 外迁已实施**（2026-10-28）。27 个纯函数拆入 `remote-plugin-sync/remotePluginSyncModel.ts`（394 行），类型/Error 类/constants 拆入 `remotePluginSyncTypes.ts`（126 行，为满足「新模块 <400 行」验收而分）；副作用函数与三个 UI 子组件留主文件。主文件 1898 → **1460**（−438）；ratchet 上限同步下调。前置测试 `test/remotePluginSyncModel.test.ts`（30 例）。
- 状态：**batch-2 三组件外迁已实施**（2026-10-28）。`SelectionList.tsx`（121 行，含 `RemotePluginSyncSelectionList`）、`ProgressList.tsx`（191 行，含 `RemotePluginSyncProgressList` + 复用给 ResultList 的 `RemotePluginSyncStatusBadge`/`RemotePluginSyncLogHoverCard`）、`ResultList.tsx`（46 行，含 `RemotePluginSyncResultList`）三个新模块各自 <400 行；副作用函数 `emitRemotePluginSyncProgress`/`throwIfRemotePluginSyncStopped`/`awaitRemotePluginSyncStep` 按登记口径留在主文件。主文件 1460 → **1132**（−328）；ratchet 上限同步下调至 1132。前置测试 `test/remotePluginSyncSections.test.ts`（**16 例**全绿）覆盖三组件渲染契约：SelectionList 空态/已存在行禁用/徽章汇总/optionsSummary/marketplace vs inline 徽章；ProgressList 空态/stop 按钮可点性/queued 回退/error 优先于 path/无 meta 段；ResultList null/空/三态徽章/error 优先/三元组 key。

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
- 状态：**batch-1 helper 外迁已实施**（2026-10-28）：14 个纯函数 + 4 常量逐字迁入
  `settings/automations/navigationModel.ts`（174 行），`AutomationActionsMenu`（145 行）与
  `AutomationStatusFilterEmpty`（15 行）各自成文件；`AUTOMATIONS_TOAST_ANCHOR_ID` 由 navigationModel
  持有、主文件 re-export 保持 WorkspaceShellLayout 的既有 import 路径不变；`toast` 包装函数按调研
  结论留在主文件（DOM anchor 语义）。主文件 1979 → **1695**（仍 >400，本批按调研 §3.① 预期不跌破；
  固定验收第 6 条不适用本批）。前置测试 `test/automationsNavigationModel.test.ts` 13 例全绿；
  ratchet 上限同步下调至 1695。

### `settings/McpSettingsSection.tsx`（1,595 行；max-lines 豁免）

> 登记来源：review 2026-10-28 batch-1 调研报告 §3.⑤（docs/reviews/2026-10-28/god-component-batch-1.md）。

- 职责分析：行 76–552 是 ~477 行纯 helper 密集带（refresh queue 决策 / status 决策 / OAuth
  authorization build / server list key 计算）+ `PluginMcpServerList` 子组件 + 主组件（行 553 起，~1042 行）。
- 建议接缝：
  1. **纯 helper 外迁** → `settings/mcp/mcpSettingsModel.ts`（~290 行）：refresh queue 决策
     （`resolveMcpStatusListRefreshSkipReason` / `transitionMcpAutoStatusListRefreshKey` /
     `createMcpStatusListRefreshQueue`）、OAuth authorization build
     （`buildMcpOAuthAuthorizationStatusRefreshServers` / `buildMcpOAuthAuthorizationStatusRefreshOptions` /
     `buildPendingMcpOAuthAuthorizationRefreshKey` / `createMcpOAuthAuthorizationStatusRefreshDeadline` /
     `isMcpOAuthAuthorizationStatusRefreshExpired` / `transitionMcpOAuthAuthorizationPendingRefresh`）、
     status list key 计算（`buildMcpServerStatusListKey` / `buildPluginMcpServerStatusListKey` /
     `shouldShowPluginMcpServersInMcpSettings`）+ 常量 `MCP_OAUTH_*`。
     `createMcpStatusListRefreshQueue` 是**有状态工厂**（返回带闭包状态的 queue 对象），调用方不应假设纯函数。
  2. （下一批）`PluginMcpServerList` 子组件外迁为受控组件。
- 留在主文件：`refreshMcpServerStatusList`（async 副作用函数，调 `mcpSyncService.listWorkspaceMcpServerStatuses`，
  不属于纯函数）、`DEFAULT_MCP_SOURCE`（表单默认值语义，不属于 refresh 决策）、
  `McpServerStatusListRefreshOutcome`（refreshMcpServerStatusList 私用）。
- 前置测试：`test/mcpSettingsModel.test.ts`（refresh deadline 边界 × queue transition × skip reason
  决策矩阵 × OAuth build 矩阵 × key 构建矩阵）。
- 预估批次：2 批（helper 外迁 → PluginMcpServerList 外迁）。仅 helper 外迁后 ~1295 行，**不跌破 400**
  （固定验收第 6 条不适用本批）。
- 状态：**batch-1 helper 外迁已实施**（2026-10-28）：12 个纯函数 + 3 个常量 + 4 个类型逐字迁入
  `settings/mcp/mcpSettingsModel.ts`（289 行）。主文件 1595 → **1346**（仍 >400，符合调研预期）。
  前置测试 `test/mcpSettingsModel.test.ts` 36 例全绿；ratchet 上限同步下调至 1346。

### `settings/ExternalAgentImportDialog.tsx`（1,442 行；max-lines 豁免）

> 登记来源：review 2026-10-28 batch-1 调研报告全清单 Top 18；批次 4 实施（helper/hook 外迁）。

- 职责分析：行 93-323 是纯 helper 带（selection key 编解码 / import selection 归组 / source root scope 推断与排序 / agent 分组 / 结果提取与格式化），行 358-490 是 `useExternalAgentImportCategoryState`（扫描-选择-导入目标状态机 hook），其余为弹窗主组件 + 12 个纯展示子组件。
- 状态：**批次 4 已实施（2026-10-28，helper + hook 外迁）**：1442→**1050**（−392）。
  - 新建 `settings/external-agent-import/importModel.ts`（279 行）：15 个纯函数 + 4 类型 + 2 常量逐字迁入；`ImportResourceCategory` 类型单一来源迁至本叶子，主文件 re-export 保持对外签名。
  - 新建 `settings/external-agent-import/useExternalAgentImportCategoryState.ts`（175 行）：hook 与 `ExternalAgentImportCategoryState` 接口逐字迁入；主文件 re-export，消费方（OnboardingDialog / OnboardingFlowParts / SkillsSection / CommandsSection / McpSettingsSection）零改动。
  - 偏离登记：`formatAgentName`/`formatSourceRootScope` 的 intl 形参标注由 `ReturnType<typeof useACodeIntl>["intl"]` 改具名类型 `IntlInstance`（类型恒等，遵守 ts-no-return-type）；函数体逐字未动。
  - 前置测试 `test/externalAgentImportModel.test.ts` 13 例全绿（key round-trip / 畸形 key 矩阵 / selection 归组 / 结果提取 / 路径 scope 推断 / intl 桩格式化）。
  - 12 个纯展示子组件留主文件（下一批候选）；ratchet 上限登记 1050。

### `settings/PluginsSection.tsx`（1,400 行；max-lines 豁免）

> 登记来源：review 2026-10-28 batch-1 调研报告全清单（1,000–2,000 梯队）；批次 4 实施（controller hook + 受控 UI 外迁）。

- 职责分析：`PluginList`（原行 135-940，~800 行）承载 store 绑定 / 派生 memo / 操作回调 / 行渲染 / 详情分支 / 空态，主组件 `PluginsSection` 承载 tabs 与 Scope 聚合。
- 状态：**批次 4 已实施（2026-10-28）**：1400→**498**（−902），9 个新叶子全部 <400 行：
  - `settings/plugins/pluginTabs.ts`（19 行）：`normalizePluginTab`/`getPluginTabCountClass` + tab 类型；本地 `workspaceKey` 经实现比对确认为 `getPluginWorkspaceKey` 的纯委托别名，删除别名、9 个调用点改直调（去重，非迁移）。
  - `settings/plugins/usePluginListController.ts`（378 行）：PluginList 的 store 绑定/派生 memo/回调逐字收口为 custom hook（hook 顺序与 deps 逐字）。
  - `settings/plugins/usePluginOptionDrafts.ts`（103 行）：配置草稿三件套（controller 超 400 后的第二刀，hook 序列不变）。
  - `settings/plugins/PluginList.tsx`（305 行）/ `PluginListDetail.tsx`（165 行，PluginList 超 400 后的第三刀）/ `PluginListRows.tsx`（219 行，原 `renderPluginRows` 受控化）/ `PluginListUninstallDialog.tsx`（41 行，两分支重复卸载弹窗消重）/ `PluginUnavailableComputerUseRow.tsx`（44 行）/ `PluginEmptyState.tsx`（13 行，PluginList 与主组件共用故独立成叶避免循环）。
  - 集合外最小改动登记：`settings/computerUseAvailability.ts` / `settings/usePluginUninstall.ts` / `hooks/useWorkspaceServices.tsx` 各补 `export` 一个既有类型（ts-no-return-type / TS4058 契约要求，行为零改动）。
  - 前置测试：`test/pluginTabs.test.ts` 3 例 + `test/pluginListRows.test.ts` 9 例全绿（渲染契约：row 锚点 / switch 三态 / missing 无菜单 / canUpdate 四态 / scope 徽标 / CUA 文案分支；Radix Portal 菜单 SSR 不可见，改由同谓词的行内 UpdateButton 钉住，测试头注已说明）。controller hook 无 jsdom 不测，按固定验收第 4 条登记。
  - ratchet 上限登记 498。

### `WorkspaceGroupedTasksSection.tsx`（1,747 行）

> 登记来源：review 2026-10-28 batch-1 调研报告全清单 Top 12；批次 4 实施（drag/drop helper 外迁）。

- 职责分析：行 74-520 是 drag/drop 纯 helper 密集带（8 个 drag data 读取器 / 碰撞检测 / 7 个 preview view 构建器 / view 签名 / 布局测量与 FLIP 动画），组件本体（DnD 编排）占 521-1747。
- 状态：**批次 4 已实施（2026-10-28，helper 外迁）**：1747→**1320**（−427）。
  - 新建 `workspace-grouped-tasks/groupedTaskDragData.ts`（120 行）/ `groupedTaskPreviewViews.ts`（164 行）/ `groupedTaskLayout.ts`（204 行）——沿用既有 `workspace-grouped-tasks/` 叶子目录；`findNearestScrollableAncestor` 因被布局族与组件本体共用而归置 layout 叶子（内聚性），主文件从该叶子 import。
  - 组件本体零改动；失效 import 已清理。
  - 前置测试：`test/groupedTaskDragData.test.ts` 15 例 + `test/groupedTaskPreviewViews.test.ts` 15 例全绿（读取器畸形矩阵 / 碰撞检测分支 / preview 决策表 / 签名稳定性）。布局/DOM 函数无 jsdom 不测，按固定验收第 4 条登记。
  - ratchet 上限登记 1320。

### `SettingsPage.tsx`（1,725 行）

> 登记来源：review 2026-10-28 batch-1 调研报告全清单 Top 13；批次 4 实施（usage 派生簇 hook 收口 + 纯函数/小组件外迁）。

- 职责分析：主组件内行 334-575 是 usage coding-plan 派生簇（provider settings 读取 / entitlement / 企业商品 / sources 派生 / tab 纠偏 effect），文件顶部另有 5 个 tab 纯函数与 2 个小组件。
- 状态：**批次 4 已实施（2026-10-28）**：1725→**1347**（−378）。
  - 新建 `settingsUsageCodingPlanTabs.ts`（56 行，5 纯函数）/ `useSettingsUsageCodingPlanSources.ts`（288 行，usage 簇 custom hook，hook 顺序与 deps 逐字，返回集按主文件实际引用裁剪为 9 值）/ `settingsPageChrome.tsx`（107 行，`SettingsUsageProviderTabs` + `SettingsSidebarButton`）——沿用既有 `settingsPageHelpers.tsx` 的同目录（src 根）叶子约定。
  - 前置测试 `test/settingsUsageCodingPlanTabs.test.ts` 9 例全绿（team 判定 / tab id round-trip / 标签解析 / 快照矩阵）。hook 无 jsdom 不测，按固定验收第 4 条登记。
  - ratchet 上限登记 1347。

### `v4/ConversationStatusPanel.tsx`（2,246 行；max-lines 豁免）

> 登记来源：review 2026-10-28 batch-1 调研报告全清单 Top 4；批次 4 实施（**仅保守纯函数外迁**，v4 实时链路投影组件的风险评估结论见下）。

- 风险评估（批次 4 前置）：desktop-continuous 实时语义集中在 `ConversationStatusPanelImpl`（memo / tick 重渲染节律 / scroll policy）与 20+ 个 section 组件的 props 透传契约，组件级外迁需先定义公共 props 类型边界并补渲染契约测试，风险高于收益；顶部纯格式化/决策函数与实时语义零耦合，逐字外迁等价于批次 1-3 已验证的模式 A。**结论：本批只拆纯函数接缝，组件与 Impl 一律不动。**
- 状态：**批次 4 已实施（2026-10-28，保守纯函数外迁）**：2246→**2102**（−144）。
  - 新建 `v4/conversationStatusPanelFormat.ts`（181 行）：`EMPTY_*` 常量 / `formatDurationUnits` / elapsed 计算 / running count 文案 / todo focus 窗口（`COMPACT_TODO_THRESHOLD` 等）/ 两个 open-request 构建器 / plan 当前与最近完成项选取，逐字迁入；`STATUS_SECTION_SCROLL_POLICY`/`StatusSectionKind` 因组件共享留主文件。
  - 偏离登记：`formatMessage` 形参类型改宿主具名类型 `IntlInstance["formatMessage"]`（类型恒等，ts-no-return-type）。
  - 前置测试 `test/conversationStatusPanelFormat.test.ts` 11 例全绿；既有渲染契约 `test/ConversationTeamStatusPanel.test.ts` 复测仍绿。
  - 后续批次建议：先补 section 渲染契约测试（renderToStaticMarkup 钉结构），再按「叶子 props 类型 → 单 section 外迁」逐批切，最后处理 Impl 投影与 tick 策略。
  - ratchet 上限登记 2102。

### `app-shell/WorkspaceShellLayout.tsx`（1,980 行；max-lines 豁免）

> 登记来源：批次 5 目标清单（2026-10-28 review top 候选，非 v4-session 域）。

- 职责分析：单一 memo 组件编排 sidebar/chat/terminal/browser pane 布局联动；文件顶部是侧栏宽度
  纯 helper 带（clamp/localStorage 读写/legacy RRP 百分比迁移），组件体内 537-723 是侧栏 resize
  状态机簇（state + refs + 拖拽 CSS 直写 + 键盘步进 + 卸载清理）。
- 状态：**批次 5 已实施（2026-10-28，helper 外迁 + resize controller 收口）**：1980→**1725**（−255）。
  - 新建 `app-shell/workspaceSidebarWidth.ts`（82 行）：8 个常量 + `WorkspaceSidebarResizeSession` 类型 +
    `clampWorkspaceSidebarWidth`/`readStoredWorkspaceSidebarWidthPx`/`readLegacyWorkspaceSidebarWidthRatio`/
    `persistWorkspaceSidebarWidthPx` 逐字迁入（window/localStorage 访问守卫原样保留）。
  - 新建 `app-shell/useWorkspaceSidebarResize.ts`（255 行）：resize 状态机收口为 controller hook，
    hook 内部顺序与 useCallback/useEffect deps 逐字（ref 对象按 exhaustive-deps 惯例不入 deps，
    与原文一致）；主文件在 auto-collapse effect 之后单点调用，消费方（JSX style memo 与
    resize handle 四个事件槽）零改动。`aria-valuemin` 的 `WORKSPACE_SIDEBAR_MIN_WIDTH_PX`
    由主文件从叶子 import。
  - 前置测试 `test/workspaceSidebarWidth.test.ts` 5 例（clamp 矩阵 / storage 读取钳制与异常吞咽 /
    legacy ratio 解析 / persist 取整）。hook 无 jsdom 不测，按固定验收第 4 条登记。
  - ratchet 上限登记 1725。
- 遗留：conversation auto-collapse 簇（`conversationAutoCollapseStateRef` + 两个 effect）与
  主 JSX 的 pane 编排段为下一批候选；pane 子树外迁需先定义 props 边界（批次 4 ConversationStatusPanel 同纪律）。

### `PreviewPane.tsx`（1,806 行；max-lines 豁免）

> 登记来源：批次 5 目标清单（2026-10-28 review top 候选，非 v4-session 域）。

- 职责分析：行 83-478 是纯 helper 密集带（source 类型判别与解析 / 错误分类与路径脱敏 /
  面包屑构建 / 延迟占位组件），组件本体（文件读取编排 + 渲染）自 480 起。
- 状态：**批次 5 已实施（2026-10-28，helper 外迁）**：1806→**1447**（−359）。
  - 新建 `previewPane/previewPaneSources.ts`（227 行）：markdown/svg 判别、text 读取结果决策、
    image/media/pdf/pptx source 解析族、header divider 与 display options 派生、PDF/PPTX 常量。
  - 新建 `previewPane/previewPaneErrors.ts`（80 行）：ENOENT/过大/pptx 不完整错误分类 +
    绝对路径脱敏（`getPreviewPaneSafeErrorMessage`）+ pptx 读取错误文案决策。
  - 新建 `previewPane/previewPaneBreadcrumb.ts`（82 行）：`CodeViewerBreadcrumbData` /
    `BreadcrumbMaskState` / 遮罩 class 映射 / `normalizeBreadcrumbPathSegments` /
    `buildCodeViewerBreadcrumb`（workspace 相对段与 posix/windows 绝对路径双分支）。
  - 新建 `previewPane/PreviewPaneDeferredHeavyContent.tsx`（35 行）：延迟占位纯展示组件 + 行宽常量。
  - `readPreviewPaneScrollMetrics`（DOM metrics 读取）与 `EMPTY_CODE_COMMENT_PREVIEWS` 留主文件。
  - 前置测试：`test/previewPaneSources.test.ts` 11 例 + `test/previewPaneErrors.test.ts` 6 例 +
    `test/previewPaneBreadcrumb.test.ts` 6 例（source 解析矩阵 / 错误分类与脱敏 / 面包屑四分支）。
  - ratchet 上限登记 1447。
- 遗留：组件本体的文件读取编排（PDF range 拉取 / pptx watch）与 header 菜单段为下一批候选。

### `WorkspaceSidebar.tsx`（1,701 行；max-lines 豁免）

> 登记来源：批次 5 目标清单（2026-10-28 review top 候选，非 v4-session 域）。

- 职责分析：顶部小件（NewTaskTooltip/DragOverlay/viewMode 决策）+ 主组件内
  `workspaceTaskToolbar` 闭包（~215 行 JSX：一级视图 Tabs / 全组折叠 / 新建分组 / 筛选菜单 /
  归档切换）。
- 状态：**批次 5 已实施（2026-10-28，受控组件 + 纯函数外迁）**：1701→**1458**（−243）。
  - 新建 `WorkspaceSidebar/WorkspaceSidebarTaskToolbar.tsx`（300 行）：toolbar 闭包 JSX 逐字外迁为
    受控组件。性能契约不变——主文件仍以 useCallback 按原 deps 列表稳定 render prop（性能修复注释保留），
    组件本体不带 memo；sort 守卫与 archived 切换的内联箭头移入组件内（经 props 回调，行为逐字等价）。
  - 偏离登记：适配闭包 deps 增加 `workspaceReadOnly`/`workspaceReadOnlyReason`（原闭包引用但未声明，
    属既有 stale-closure 隐患，受控化必须显式声明）；`intl` 移出 deps（不再被闭包引用，
    locale 切换由 deps 内的 `archivedTasksActionLabel` 覆盖）。
  - 新建 `WorkspaceSidebar/sidebarTaskViewMode.ts`（22 行）：`resolveSidebarTaskViewMode` +
    `SidebarTaskViewMode` 类型（单一来源迁至叶子，主文件删本地别名）。
  - 新建 `WorkspaceSidebar/sidebarChrome.tsx`（51 行）：`WorkspaceNewTaskTooltip` + `WorkspaceDragOverlay`。
  - 前置测试：`test/sidebarTaskViewMode.test.ts` 2 例（四态矩阵）+
    `test/workspaceSidebarChrome.test.ts` 4 例（tooltip 透传/包装、overlay 本地/远程分支）+
    `test/workspaceSidebarTaskToolbar.test.ts` 5 例（渲染契约：Tabs 双触发器 / 新建分组按钮分支 /
    筛选菜单触发器有无 / 归档容器与 data-state / 折叠按钮分支；Radix Portal 内容 SSR 不可见，
    口径同 pluginListRows.test.ts）。
  - ratchet 上限登记 1458。
- 遗留：主组件内 grouped/timeline/workspace 三态编排与文件树滑出段为下一批候选。

### `components/ai-elements/message.tsx`（1,691 行；oxlint ignorePatterns 覆盖的 vercel 衍生件）

> 登记来源：批次 5 目标清单（2026-10-28 review top 候选，非 v4-session 域）。

- 职责分析：行 454-705 是单美元行内公式归一化族（围栏跟踪 / 转义判定 / 货币区间保护），
  行 756-1003 是 markdown 文件链接目标族（harden 前 href 规整 / rehype 插件 / link target 构建 /
  stat 确认打开）。
- 状态：**批次 5 已实施（2026-10-28，helper 外迁 + 死代码删除）**：1691→**1337**（−354）。
  - 新建 `messageMarkdownMath.ts`（198 行，零依赖纯字符串函数）：6 个模式常量 + 9 个归一化函数
    逐字迁入；主文件只消费 `normalizeMessageSingleDollarMath`。
  - 新建 `messageFileLinkTargets.ts`（182 行）：`MessageFileLinkTarget` 类型单一来源迁入 +
    `formatMarkdownFileLinkTargetHref`/`shouldRewriteMarkdownFileLinkHref`/
    `rewriteLocalFileMarkdownTargetsRehypePlugin`/`hasFileExtension`/`isExplicitDirectoryMarkdownLink`/
    `buildMessageFileLinkTarget`/`openMessageFileLinkInEditor`/`isExternalWebHref` + `HastElementNode`。
    主文件 re-export `MessageFileLinkTarget`/`buildMessageFileLinkTarget`/`openMessageFileLinkInEditor`
    保持对外契约（workspacePathNavigation 与 side-pane 族 import 路径不变、包导出面不变）。
  - 删除死代码 `knownExtensionlessFileNames`（全仓零引用，定义于 457 行从未被消费）。
  - `hashMarkdownCacheKey`/`normalizeMarkdownRenderError`（错误边界私有）与 `resolveMessageStreamdownMode`/
    `buildMessageStreamdownRenderKey`/`getAttachmentReaderEpoch`/`resolveMessageCodeTheme` 留主文件。
  - 前置测试：`test/messageMarkdownMath.test.ts` 11 例（围栏/转义/货币区间/行内代码跳过决策表）+
    `test/messageFileLinkTargets.test.ts` 10 例（href 规整矩阵 / shouldRewrite 决策 / rehype 树改写 /
    link target 派生 / stat 打开编排）。
  - **连带登记**：message.tsx 是 third-party 台账（inventory.json）inputs 追踪件，本批改动导致
    L01 干净树审计哈希漂移——按 orchestrator 纪律由 licenses-notices.yml CI Linux 统一重生成落位
    （2ddaf691 先例），本代理不动台账。
  - ratchet 上限登记 1337。
- 遗留：MessageFileLink/MessageExternalLink 交互组件与 MessageResponse 主组件的 renderer memo 簇
  为下一批候选（oxlint 豁免域，仅受 ratchet 与架构门禁约束）。

### `LexicalChatInput.tsx`（1,517 行；max-lines 豁免）

> 登记来源：批次 5 目标清单（2026-10-28 review top 候选，非 v4-session 域）。

- 职责分析：行 93-178 是提交/重置/中文顿号别名纯决策；行 179-507 是编辑器动作族
  （文本/mention 替换、追加、state JSON 恢复、选区归位——全部以 LexicalEditor 实例为参数的
  命令式操作）；其余为 8 个 Lexical 插件组件 + 主组件。
- 状态：**批次 5 已实施（2026-10-28，helper 外迁）**：1517→**1105**（−412）。
  - 新建 `lexical-chat-input/lexicalChatInputDecisions.ts`（87 行）：4 个选项接口 +
    `LexicalSubmitResult` + `CHINESE_SLASH_ALIAS`/`STANDARD_SLASH_TRIGGER` + 4 个决策函数。
  - 新建 `lexical-chat-input/lexicalEditorActions.ts`（374 行）：`getEditorMarkdown`/
    `replaceEditorText`/`INLINE_PLUGIN_MENTION_PATTERN`/`replaceEditorTextWithPluginMentions`/
    `replaceEditorWithMention`/`prependEditorMentionIfMissing`/`replaceEditorStateJson`/`resetEditor`/
    `replaceEditorWithSkillMention`/`replaceEditorWithSlashCommandMention`/`appendEditorFileMention`/
    `appendEditorPlainText`/`selectAfterPromptMentionById`/`isCollapsedSelectionAtEditorStart`/
    `insertEditorMention` 逐字迁入。
  - DOM-selection 助手（`getPromptMentionIdAfterDomSelection`/`getPromptMentionIdFromBoundaryNode`，
    window.getSelection/HTMLElement.matches）留主文件，无 jsdom 不测，按固定验收第 4 条登记。
  - 前置测试：`test/lexicalChatInputDecisions.test.ts` 6 例（决策矩阵）+
    `test/lexicalEditorActions.test.ts` 10 例（**headless Lexical**：createEditor + PromptMentionNode
    无 DOM 跑真实 update/read；.png 资源链路用 module.registerHooks 重定向，对照 pluginListRows 先例；
    update 提交用 registerUpdateListener 等真实事件，无 wall-clock 定时器）。
  - ratchet 上限登记 1105。
- 遗留：KeyboardPlugin 的改绑分发与 PromptHistoryPlugin 的发送回滚耦合为下一批候选
  （需先补交互测试，见 v4 区登记表「提示词历史导航」前置条件）。

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
6. **目标文件跌破 400 行**（仅适用于「登记目的就是要把某个已超限文件推到 400 以下」的批次，
   如 settings 三件套的第一刀 helper 外迁）：验收时除「行数下降」外，必须实测目标文件 `wc -l < 400`，
   并把超 400 计数（`find packages/ui/src -name '*.tsx' | wc -l` 口径）的变化记进报告。
   内部修剪但未跨 400 阈值的，不计入拆分进度——见「拆分动能备注」，
   现有 `legacy-over-limit` ratchet 只在跨越 400 时触发，对已超限文件的继续增长失明。
7. 若某文件被登记进本计划后仍在增长（如 `AutomationEditView` 2942→2950 的 Button a11y 迁移成本），
   在该批次的登记行里注明增量原因与当前行数，供 lead 判断是否需要「split-plan 登记文件行数 ratchet」
   （后续治理项，门禁实现属 `scripts/architecture`，不在本计划内实现）。
