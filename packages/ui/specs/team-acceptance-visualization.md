# 验收面可视化（in_review 分组与按需 diff 查看）

来源：[`docs/upgrades/orchestration-acceptance-2026-11.md`](../../../docs/upgrades/orchestration-acceptance-2026-11.md)
§3 G7 / §5 批次 4 / §7 Track C。跨包契约（通道归属、字段形状、git 读取接口）冻结在
[`packages/shared/specs/team-acceptance-review-contract.md`](../../shared/specs/team-acceptance-review-contract.md)；
本 spec 只定义 UI 侧的投影、组件、交互、治理与验收，不重定义契约。

**冻结契约（不得更改，并行 spec 依赖）**：任务增 `in_review`（插件状态机权威，UI 只投影）；
UI **不做验收直写**——用户侧动作限于查看 diff / 检查结果 + 发送「提醒队长验收 / 打回」消息；
回看 diff 读 `baseCommit..lastMergedCommit`，不拿主仓库 HEAD 代替；worktree 已清理且无历史范围时
明确报不可用（EI-9）；diff 呈现 MVP 零新依赖（结构化文件列表 + 截断 unified-diff 文本）。

**与并行 spec 的关系（单一真源，不重复定义）**：
- 插件 `in_review` 状态机、合并↔任务耦合、`counts.inReview` 与 `isTeamEnded` 判据 =
  `apps/acode-cli/specs/agent-teams-acceptance-loop-2-in-review.md` R2.1–R2.9 **单一拥有**；
  本 spec R1 只补**展示细节**（分组序、取色、折叠、徽章、依赖图取色），不改其投影契约。
- 验收工具面（`review_member_diff` / `run_checks`）与 `metrics?: TeamAcceptanceMetrics` 形状 =
  `apps/acode-cli/specs/agent-teams-acceptance-loop.md` R0.2/R1 **单一拥有**；本 spec R12 只定义消费。
- 通道归属、`reviews[]` 字段、git ref-range 读取接口 =
  `packages/shared/specs/team-acceptance-review-contract.md` **单一拥有**；本 spec 不重定义。

## 背景（起草时逐条核实，行号以当前检出为准）

1. **数据链**：`pluginStates` 快照（v4 通用通道，宿主不解释）→
   `packages/ui/src/v4/teamPanelModel.ts` 受检收窄（头注 :1-16 声明「宿主不解释插件状态」的投影模式，
   `:232-374` 逐字段校验，形状不符整卡丢弃）→ 团队卡模型 `ConversationStatusPanelTeam`。
   多团队 / 已结束桶在同一处收窄（`:123-215`），**所有消费方必须共用这一处结论**。
2. **侧栏接线模板**：`packages/ui/src/app-shell/TeamSidePane.tsx:38-45`
   `V4PaneConversationProvider(scope)` → `layer.acquire(parentSessionId)` 租约 →
   `useConversationProjection(lease)` 读 `snapshot.pluginStates`；`:43-45` 已有「载入中」第三态
   （lease 未就绪 / 投影未到达）。
3. **卡片入口**：`v4/ConversationTeamCards.tsx` → `components/TeamWorkflowCard.tsx`（279 行）；
   打开团队面板走 `TeamPanelLanding{teamId?, focusPhaseId?, focusTaskId?}`
   （`lib/workspaceSidePane.ts:552-566`），`createTeamSidePaneTab` 同 id 复用聚焦（`:821-840`）。
4. **任务分组存在两处**：`app-shell/teamPaneParts.tsx:112-126` `groupTasks`（面板任务板）与
   `v4/teamWorkflowPresentation.ts:218-239` `groupInlineTasks`（卡片内联）；状态色点表
   `teamPaneParts.tsx:46-53`，卡片内联色表 `components/TeamInlineTaskList.tsx:25-31`。
   两处各算一遍但**分组语义必须一致**（现有 spec 已如此要求）。
5. **状态色语义**：`teamPaneParts.tsx:16-44` 「灰 = 无需你动作、彩色 = 有你的事」；
   `TEAM_STATUS_DOT.draft` 用品牌色空心环表示「等你批准」。DESIGN.md「Blocking interaction colors」
   规定 waiting 徽章统一用 **confirmation-interaction** 家族（`styles.css:272-273,421-426,570-571,715-716`），
   **不得用 `--color-success` 冒充等待态**；`packages/ui/specs/orchestration-side-pane.md` R5 已按此落地。
6. **消息动作的唯一通道已存在**：`packages/ui/src/store/acodeSessionStoreTypes.ts:235-241`
   `requestComposerTextInsert(workspacePath, text, workspaceIdentity?, mention?, mode?)`；
   先例 `packages/ui/src/hooks/useTeamApprovalDraft.ts`（`TeamApprovalActions` 的「填入批准语」）：
   **只写 composer、不自动发送**，注释逐字写明「写入**只**经 `requestComposerTextInsert`
   （AGENTS.md 禁止第二条写输入框的路径）」。
7. **行数治理**：`architecture-policy.yaml` 的 `packages/ui` 为 `managed: false` →
   `maxFileLines` 以「跨越 400 才触发」的 legacy ratchet 生效；已登记上帝组件另受
   `packages/ui/tests/godComponentLineRatchet.guard.test.mjs` 上限表约束（本批不动该表）。
   **`v4/teamPanelModel.ts` 已 374 行**，新增投影必须外迁叶子，不得把它推过 400。
8. **i18n**：扁平词典 `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`；守护
   `tests/i18nLocaleParity.test.mjs`（键集必须一致）+ `test/teamLocaleKeys.test.ts`（团队关键键清单 + 数量下限）。
   既有团队键族 `teamPanel.*` / `chat.statusPanel.agentTeams.*` / `sidePane.team`。
9. **diff 文本渲染面已存在（零新依赖）**：`components/ui/lightweight-diff-preview.tsx`
   （`font-mono` + `codePreviewSettings.fontSizePx`，符合 DESIGN.md「Diff 消费独立数值字号」例外）
   与 `lib/patchDiffPreview.ts:9-26,150-161` 的截断标记行内部 token + i18n `diff.preview.truncatedLines`。
10. **测试约定**：`packages/ui/package.json` 的 `test` 跑 `test/**/*.test.ts` + `tests/**/*.test.mjs`
    （node:test + tsx）；先例：`test/teamPanelModel.test.ts`（纯逻辑）、
    `test/teamWorkflowCard.test.ts`（SSR `renderToStaticMarkup`）。

## 产品规则

**R0 只读投影，零第二真源。** 验收面是插件状态的纯投影消费者：权威 = 插件状态 JSON
（`teamPanelModel` 收窄结果）；UI 不缓存提交事实、不写任何编排状态、不自行推导 diff。
`teamWorkflowPresentation.ts` 既有纪律「UI 绝不自行按 status 推导」在本批继续适用于 `in_review`：
分组只按 `tasks[].status === "in_review"` 的事实分支，不改判据。

**R1 `in_review` 分组（三处同源收窄，一处显示）。**
- 新分组键 `review`，标签 `teamPanel.group.review`（zh「待验收」/ en「Awaiting review」），
  在任务板 `GROUP_ORDER` 与卡片内联分组序里**排在最前**（它是有待处理动作的一组，与
  「彩色 = 有你的事」的取色语义一致），组头沿用 `GroupHeader` 的计数摘要。
- 分组实现单点：`groupTasks`（面板）与 `groupInlineTasks`（卡片）各加一支
  `task.status === "in_review" → review`；两侧分组语义必须一致（背景 #4）。
- `in_review` **不算结束**：`isTeamEnded` 既有实现只认 `done | cancelled`，本批不得放宽
  （`in_review` 团队保持活跃、不进「已结束」桶）。
- 状态点/徽章：`in_review` 走 **confirmation-interaction 家族**（等待态），
  **不得复用 `--color-success`**（DESIGN.md 明令）；且「不用颜色单独表意」——
  组头与任务行必须同时带可读文字（`teamPanel.group.review` / 徽章文字），不只有色点。
- 计数行：`TeamStatusSummary.tsx` 增 `counts.inReview` 一行（仅 `> 0` 时显示），
  文案键 `chat.statusPanel.agentTeams.inReviewCount`（仿既有 `inProgressCount`）。
- **依赖图**（`components/TeamTaskGraph.tsx:20-26` 的 `STATUS_COLOR`）增 `in_review` 取色
  （confirmation 家族，非 `--color-success`）。**边色不改**：`in_review` 是「未放行」（
  `dag.dependencySatisfied` 只认 `done`），归既有 `pending` 灰是字面正确的；但为避免「颜色单独表意」
  的既有缺口扩大，`in_review` 节点必须在任务板/卡片内联列表里同时有可读分组标签
  （本批不扩展示意图例，登记为既有观测局限）。

**R2 新增「待验收」页签 + 分区叶子组件。**
- `TeamSidePaneView.tsx` 的 `PanelTab` 联合追加 `"review"`；该页签**仅当团队存在 `reviews[]`
  非空时出现**（仿 `mailbox` 页签在 `!team.mailboxes.length` 时隐藏的既有手法）。
- 页签内容 = 新叶子 `app-shell/TeamSidePaneReview.tsx`，组合：
  `TeamReviewList`（分组/折叠的任务清单）、`TeamReviewDetail`（文件列表 + diff）、
  `TeamReviewActions`（提醒/打回）。三者都是新叶子，**不塞进 `TeamWorkflowCard.tsx`**，
  各自 ≤ 400 行（R10）。
- 入口链路复用既有 `TeamPanelLanding`：additive 扩 `focusTab?: "overview" | "tasks" | "members" | "mailbox" | "review"`
  （缺席 = `overview`，与 `TeamSidePaneView` 的 `selectionCurrent ? selection.panelTab : "overview"`
  同一点改为 `tab.focusTab ?? "overview"`）与 `focusReviewTaskId?: string`（缺席 = 定位第一条）。
  `TeamWorkflowCard` 只在状态行区域增一个薄入口（「待验收 N」→ `onOpen({ focusTab: "review" })`），
  实现放新叶子 `components/TeamReviewEntry.tsx`；卡片本身与 R12 度量行合计增量 ≤ 15 行。

**R3 diff 查看交互（MVP）。**
- **入口**：`TeamReviewList` 行的「查看 diff」按钮（`aria-expanded` + 可读 label），
  展开所在 `TeamReviewDetail`。
- **读取**：`hooks/useTeamReviewDiff.ts`（新）经 `useServices().gitService` 调契约 B 的
  `getRefRangeDiff`；参数 `workspacePath` 取 **pane scope 的 workspacePath**，
  `baseRef = review.baseCommit`、`headRef = review.headCommit`（**钉住的 SHA，绝不改读 HEAD**）。
  远程解析（`useResolvedRemoteWorkspaceSessionId`）与 `shouldEnableWorkspaceRpc` 门控与
  `hooks/useGitRepository.ts:392-402` 逐字同款：断连时不发起 RPC。
- **加载分级（EI-98）**：100ms 内不出任何反馈；>100ms 显示禁用态；>1s 在「查看 diff」按钮内
  **固定宽度**的 spinner；>3s 换成阶段文字（`teamPanel.review.loadingFiles` → `loadingDiff`），
  不许无标签转圈。
- **呈现**：文件列表（`files[]`：状态色点 + 路径 + `+n/-n`，走 `--color-diff-added/removed` 与
  monospace）+ 选中文件的 unified-diff 文本。文本渲染**复用** `LightweightDiffPreview`
  （`codePreviewSettings.fontSizePx`，非 `text-ui-*`）；**行级展示截断**在 UI 完成：
  超过 `TEAM_REVIEW_DIFF_MAX_LINES`（建议 800，与 `patchDiffPreview` 的
  `MAX_PLAIN_TEXT_FALLBACK_RENDER_LINES` 同族）时按**整行**截断，并在末尾追加既有截断标记行
  （经 `lib/patchDiffPreview.ts` 导出的小 builder，复用 `diff.preview.truncatedLines` 文案）。
  **不做**语法高亮、不做左右 merge view（Track C）。
- **不可用态文案（EI-9 + EI-101，必须给出路）**：
  | 条件 | 文案键（zh/en 同批） | 出路 |
  | --- | --- | --- |
  | 无 `baseCommit`/`headCommit` | `teamPanel.review.diffUnavailable.pinnedMissing` | 「让队长用 `agent_teams_review_member_diff` 查看」（复制命令/文本） |
  | 插件 `diffAvailable:false` | `teamPanel.review.diffUnavailable.<reason>`（4 个 reason 各一词） | 明示原因，不尝试读取 |
  | workspace 未连接 | `teamPanel.review.diffUnavailable.disconnected` | 「重连工作区后重试」按钮 |
  | `reason:"no_changes"` | `teamPanel.review.noChanges`（中性文案，不是错误） | 无按钮，静态说明 |
  | `reason:"ref_unresolved"` | `teamPanel.review.diffUnavailable.refUnresolved`（含「工作树已清理且提交不可达」） | 「重试」按钮 |
  | `reason:"git_unavailable"` / `"not_a_repository"` / `"timeout"` / `"unknown"` | `teamPanel.review.diffUnavailable.<reason>` 各一词 + 透传 `summary`（去噪截断） | 「重试」按钮 |
  | `reason:"output_too_large"` | `teamPanel.review.diffUnavailable.tooLarge` | 「让队长缩小范围 / 用 review 工具」 |
  | `filesTruncated` | `teamPanel.review.filesTruncated`（失步提示，EI-97） | 「重试」按钮 |

  **一律按 `reason` 选文案，不匹配 `summary` 字符串**（字符串匹配文案是最易碎的耦合；
  冻结契约 B 因此把 `reason` 定为机器可判字段）。
- **不缓存跨会话**：读取结果只活在当前展开的 `TeamReviewDetail` 内；面板不可见/切换页签即丢弃
  （与 `packages/ui/specs/hidden-pane-subscription-release.md` 同一条内存纪律；本批不新增持久化）。
- **检查结果**：`reviews[].check` 存在时，在详情顶部显示一行：通过/失败徽章（等待态用
  confirmation 家族、失败用 `--color-destructive`）、命令（monospace）、退出码、`summary`
  折叠为 3 行可展开；`check.truncated` 如实标注「输出已截断」。

**R4 提醒队长 / 请求打回（唯一写入通道）。**
- 两个动作各一个按钮，**不经面板发送**：调既有
  `requestComposerTextInsert(scopePath, text, scopeIdentity, undefined, "append")`
  ——与 `useTeamApprovalDraft` 同一条 composer 通道，**不自动发送**，用户看一眼自己按回车
  （AGENTS.md 禁止第二条写输入框的路径；本批不引入自动发送，见「未做」#3）。
- 实现：把 `useTeamApprovalDraft` 泛化为 `hooks/useTeamComposerInsert.ts`（导出 `insertTeamText(text)`，
  接受显式 `workspacePath/workspaceIdentity`，缺席回退 `useOptionalTabStore` 的活跃工作区），
  `useTeamApprovalDraft` 改为它的薄包装（单一实现，不复制通道逻辑）。
- 预置文案（**i18n，新键，zh/en 同批**）：`teamPanel.review.remindText`
  （「请验收团队的待验收任务 {taskIds}：查看 diff 与检查结果后决定合并或打回。」）与
  `teamPanel.review.rejectText`（「请打回团队的待验收任务 {taskIds}：我判断未达验收标准。」）。
  两者都只填不发送，`mode: "append"` 不覆盖用户草稿。
- 面板内**不提供**「接受 / 合并」按钮（那会让 UI 从只读投影变成调度入口）。

**R5 反馈分级与通道（EI-98~101）。**
- 读取失败分两级：可重试的读取失败 → 详情内**就地内联**错误行 + 「重试」按钮（不弹 toast，
  因为结果位置上已经可见）；写入 composer 失败（无活跃工作区）→ `logger.warn` + 按钮内提示
  （沿用 `useTeamApprovalDraft` 既有处置，不弹「出错了」）。
- 复制面板 URL / 复制命令沿用既有 toast（`TeamSidePaneView.tsx:92-101` 先例）。
- 空态给出路（EI-101）：**不做**裸文本「暂无待验收」——按 R2，`reviews[]` 为空时**页签本身不渲染**；
  任务板 `review` 组为空时不渲染该组（与既有分组同一手法）。

**R6 长列表分组折叠（EI-111）。** 两个列表都守该纪律：
（a）任务板的 `review` 组，与其余组同款（沿用 `TeamSidePaneTasks` 既有折叠集合）；
（b）`review` 页签的清单按状态分组（待验收 / 已验收 / 已打回），单组超过
`REVIEW_GROUP_INLINE_LIMIT`（建议 5，与 `TeamInlineTaskList` 的 `GROUP_LIMIT` 同族）时默认折叠
+ 组头计数摘要。折叠状态是组件内呈现状态（`useState<ReadonlySet<string>>`，与
`TeamSidePaneTasks.tsx:33` 同款），**不覆盖用户已手动切换的选择**；快照更新不重置该状态。

**R7 DESIGN.md token 与布局。** 稠密操作面板（非营销卡）：行标题 `text-ui-base`、元数据
`text-ui-sm`/`text-ui-xs`；**diff 文本是非 `text-ui-*` 的例外**，走
`codePreviewSettings.fontSizePx` + `font-mono`（与 `LightweightDiffPreview` / GitPane 同源）；
radius 走容器层级（`rounded-xl` 起）；段间 16px、行内 8-12px 家族；`min-w-0` 截断纪律；
icon-only 控件必须带 `aria-label`/`title`；diff 区域用既有横向滚动面（`overflow-auto` +
不换行时内层 `w-max`），**不新增断点、不新增移动端专用组件**（DESIGN.md「Mobile remote control
retains its single-column and drawer presentation」；主操作在所有断点保留）。

**R8 键盘与可访问性。** `TeamSidePaneView` 既有 `tablist` 键盘导航（`:61-80`）自动覆盖新页签；
「查看 diff」用 `aria-expanded` + 可读 label；组头用既有 `GroupHeader`（已含 `aria` 结构）；
焦点环走仓库既有 `focus-visible:ring-*` 模式。

**R9 i18n 双词典同批（EI-107）。** 新增键族 `teamPanel.review.*` 与
`chat.statusPanel.agentTeams.inReviewCount`、`teamPanel.group.review`、`teamPanel.tab.review`、
`sidePane.team` 不变；zh-CN 与 en-US 同批成对；同批更新
`test/teamLocaleKeys.test.ts` 的关键键清单与数量下限。**不 overclaim**：读取中一律用中性过程语
（「正在读取 diff」），拿到结果才用结果词（「N 个文件」「通过 / 失败」）。

**R10 行数 / ratchet 治理。**
- 新文件 ≤ 400 物理行（新超限文件零容忍）；`v4/teamPanelModel.ts`（374）**不得越 400**——
  投影实现外迁到新叶子 `v4/teamReviewModel.ts`，`teamPanelModel` 只调用并按契约 A 存放结果。
- `TeamWorkflowCard.tsx`（279）本批增量 ≤ 15 行；`godComponentLineRatchet` 上限表本批**不改**
  （不新增登记、不上调）。
- 所有新叶子命名与归属见「接口」。

**R11 远程 / 断连降级（EI-9）。** 契约 B 的降级矩阵在 UI 侧的落点即 R3 的不可用态表；
额外纪律：**绝不**在远程 workspace 下回落到本机仓库读取（`workspacePath` 始终取 pane scope 值，
不取桌面本机路径）。

**R12 验收度量展示（批次 0 委派到本批）。**
批次 0 的 `metrics?: TeamAcceptanceMetrics`（`TeamPanelState` additive，形状与口径由
`apps/acode-cli/specs/agent-teams-acceptance-loop.md` R0.2 **单一拥有**，本批不复制形状）
在 M0 声明「桌面团队卡展示度量归批次 4」，故本批消费：
- 团队卡状态行与状态面板摘要各增一行紧凑度量：**一次验收通过率 / 平均尝试数 / 打回次数**
  （实现放新叶子 `components/TeamAcceptanceMetricsRow.tsx`，卡片与摘要各调一次，不各写一遍）；
- `metrics` 缺席（旧插件）→ 整行缺席（不显示 0 冒充）；各比率为 `null` → 显示
  `chat.statusPanel.agentTeams.metricsInsufficient`（「样本不足」），**不得用 0 冒充无数据**（EI-9）；
  `latency.sampleSize === 0` 时耗时一律不显示；
- MVP **不展示 `byTask`**（长列表易膨胀；`byTask` 归后续批次，若做必须走 R6 的折叠纪律）；
- 度量是只读派生投影，不缓存、不落盘、不进任何写入路径（EI-48）。

## 状态所有权

| 状态 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 任务状态（含 `in_review`）与验收结果 | 插件状态 JSON（磁盘唯一真相） | UI 只投影（契约 A） |
| 面板验收投影（`reviews[]` / `counts.inReview`） | 插件 `panel-state.ts` | 收窄在 `teamPanelModel` 单点 |
| diff 字节与提交可达性 | git（`IGitService` ref-range 读取） | 结果只活在展开详情内，不缓存 |
| 页签 / 展开 / 折叠 | `useAppPanels` sidePaneState + 组件内 `useState` | 零新增持久化 |
| composer 草稿写入 | `acodeSessionStore.requestComposerTextInsert`（唯一通道） | 不自动发送 |
| 文案 | i18n 双词典（懒加载） | R9 |

## 接口（组件拆分清单与行数预算）

新增叶子（全部 ≤ 400 行）：

| 文件 | 职责 | 预算 |
| --- | --- | --- |
| `packages/ui/src/v4/teamReviewModel.ts` | `reviews[]` 受检收窄（逐字段、坏条丢弃）+ `metrics` 受检收窄（R12）+ `in_review` 判据 + `TEAM_REVIEW_DIFF_MAX_LINES` / 显示上限常量 + 截断标记 builder 转出 | ≤ 220 |
| `packages/ui/src/hooks/useTeamReviewDiff.ts` | 按需 ref-range 读取（`useServices().gitService`）+ 远程解析 + `shouldEnableWorkspaceRpc` 门控 + 加载分级状态机 + `reload()` / `selectFile()` | ≤ 200 |
| `packages/ui/src/hooks/useTeamComposerInsert.ts` | `insertTeamText(text)`：唯一 composer 通道；`useTeamApprovalDraft` 改为其薄包装 | ≤ 80 |
| `packages/ui/src/app-shell/TeamSidePaneReview.tsx` | 页签容器：`TeamReviewList` + 选中项的 `TeamReviewDetail` + `TeamReviewActions` | ≤ 250 |
| `packages/ui/src/components/TeamReviewList.tsx` | 待验收/已验收/已打回 列表，分组 + 折叠（EI-111）+ 空态 | ≤ 250 |
| `packages/ui/src/components/TeamReviewDetail.tsx` | 文件列表 + diff 文本 + 状态机（加载/不可用/无改动/溢出）+ 检查结果行 | ≤ 350 |
| `packages/ui/src/components/TeamReviewActions.tsx` | 提醒队长 / 请求打回（R4） | ≤ 120 |
| `packages/ui/src/components/TeamReviewEntry.tsx` | 团队卡上的薄入口（R2） | ≤ 80 |
| `packages/ui/src/components/TeamAcceptanceMetricsRow.tsx` | 度量行（R12），卡片与状态摘要共用 | ≤ 120 |

既有文件的最小编辑（**不新增超限**）：

- `v4/teamPanelModel.ts`：调用 `projectTeamReviews` / `projectTeamMetrics`，模型增
  `reviews` / `reviewsTruncated` / `counts.inReview` / `metrics`（+≤ 12 行，保持 < 400）；
- `app-shell/teamPaneParts.tsx`：`TEAM_TASK_STATUS_DOT.in_review` + `TaskGroups.review` 分支（+≤ 15）；
- `lib/workspaceSidePane.ts`：`TeamPanelLanding` 增 `focusTab?` / `focusReviewTaskId?` 两个 additive
  字段 + `createTeamSidePaneTab` 透传（+≤ 8；既有 opener 与同 id 复用语义不变）；
- `app-shell/TeamSidePaneTasks.tsx`：`GROUP_ORDER` 增 `review` 首项（+≤ 8）；
- `app-shell/TeamSidePaneView.tsx`：`PanelTab` 增 `review` + 页签显隐 + 传递 pane scope 与回调（+≤ 25）；
- `v4/teamWorkflowPresentation.ts`：`teamTaskStatus(in_review)` + `TeamInlineTaskGroupKey.review` +
  `groupInlineTasks` 分支（+≤ 18）；
- `components/TeamInlineTaskList.tsx`：`review` 的 label/dot/默认折叠（+≤ 8）；
- `components/TeamTaskGraph.tsx`：`STATUS_COLOR.in_review` 一项（+≤ 3）；
- `components/TeamWorkflowCard.tsx`：渲染 `TeamReviewEntry`（R2）与 `TeamAcceptanceMetricsRow`（R12），
  **两者合计 ≤ 15 行**（279 → ≤ 294，仍在 400 内）；
- `components/TeamStatusSummary.tsx`：`counts.inReview` 一行 + `TeamAcceptanceMetricsRow`（合计 +≤ 12）；
- `lib/patchDiffPreview.ts`：导出截断标记 builder（+≤ 3）；
- i18n 双词典：新增键族（R9）。

测试（`packages/ui/test` / `packages/ui/tests`，node:test + tsx）：

- `test/teamReviewModel.test.ts`：收窄（坏条丢弃、additive 缺席、`reviewsTruncated`）+ 分组一致性；
- `test/teamReviewDiffInteraction.test.ts`：源文本/接线断言（不驱动 React 树）——钉住 SHA 参数、
  截断上限、不可用态分支、`shouldEnableWorkspaceRpc` 门控、`requestComposerTextInsert` 唯一通道；
- `test/teamAcceptanceMetrics.test.ts`：`metrics` 受检收窄（缺席 / 坏值 / `null` 比率）+
  `TeamAcceptanceMetricsRow` SSR 断言（`null` → 「样本不足」而非 0、缺席 → 整行不渲染）；
- 扩充 `test/teamPanelModel.test.ts`（`in_review` 收窄 + `counts.inReview` 默认 0 + `v:2 → null` 保持）；
- 扩充 `test/teamLocaleKeys.test.ts`（新键清单 + 数量下限）。

## 验收场景

1. **分组**：`tasks[].status = "in_review"` → 任务板 `review` 组排最前、组头计数正确；
   卡片内联 `review` 组同序；`counts.inReview` 默认 0（旧插件）；两处分组对同一快照结论一致。
2. **不算结束**：全 `in_review`（含部分 `done`）的团队 → `isTeamEnded` 为 false，不进「已结束」桶。
3. **回看与清理后回看**：`reviews[].status:"merged"` 且 `headCommit = lastMergedCommit` →
   UI 以 `baseCommit..headCommit` 读 diff（**源文本钉住两个 SHA 参数，不出现 `HEAD`**）；
   模拟 worktree 已清理但提交可达 → 仍可读；提交不可达 → 显式「工作树已清理且提交不可达」
   （不编造、不显示空 diff 冒充无改动）。
4. **钉住不漂移**：`reviews[].headCommit` 与成员分支后续 HEAD 不同时，UI 读的是快照里的 SHA
   （参数断言），不是分支 HEAD。
5. **远程降级明示**：`shouldEnableWorkspaceRpc` 为假 → 不发起 RPC 且显示「工作区未连接」；
   远程 workspace 下 `workspacePath` 取 pane scope 值（不回落地本机路径）。
6. **截断**：`filesTruncated` → 显示失步提示 + 重试；patch 行数超 `TEAM_REVIEW_DIFF_MAX_LINES`
   → 末尾出现「省略 N 行」标记行（复用 `diff.preview.truncatedLines`）；
   `reason:"output_too_large"` → 「内容过大」态，不渲染半截 patch 冒充全文；
   各 `reason` 命中各自文案键（断言按 `reason` 分支，不做 summary 字符串匹配）。
7. **检查结果**：`check.passed` 与退出码如实呈现；`check.truncated` 标注「输出已截断」；
   无 `check` → 该行缺席（不显示空框，不编造「通过」）。
8. **提示动作**：点「提醒队长验收」→ composer 得到预置文案（`mode:"append"`，不覆盖已有草稿）、
   **不自动发送**（发送仍由用户触发，与 `useTeamApprovalDraft` 同语义）；无活跃工作区 →
   warn + 提示，不静默。
9. **ratchet 不回归**：`packages/ui` 全文件 ≤ 400；
   `tests/godComponentLineRatchet.guard.test.mjs` 上限表未改且全绿；
   `tests/i18nLocaleParity.test.mjs` 与 `test/teamLocaleKeys.test.ts` 全绿。
10. **旧插件回归**：无 `reviews[]` / `counts.inReview` 的快照 → 无「待验收」页签、无验收入口、
    团队卡照常渲染。
11. **移动端与键盘**：新页签在既有 `tablist` 键盘导航内可达；diff 区横向滚动不撑破布局；
    文案切换 en-US 后不溢出、布局不破。
12. **度量诚实性（R12）**：`metrics` 缺席 → 度量行整行不渲染；`firstPassRate` / `avgAttempts`
    为 `null` → 显示「样本不足」，**不显示 0**；`latency.sampleSize === 0` → 不显示耗时；
    `metrics.tasks.inReview` 与 `counts.inReview` 同时在场时团队卡的待验收计数仍以
    `counts.inReview` 为显示源（单一口径，避免两处数字打架）。

## 未做与取舍

1. **面板内不做「接受 / 合并 / 打回执行」**：验收写入仍由队长经 `agent_teams_*` 工具完成，
   因为面板不是调度器；UI 只给「提醒」消息与只读查看（冻结契约）。面板内提供执行按钮 = 第二写入路径。
2. **不做 diff 全文入快照 / 文件列表入快照**：见契约裁决 2（快照体积 + 单一 diff 源）。
3. **不做自动发送的提醒按钮**：自动发送需要新的 admission 路径（composer 之外的写入面），
   违反 AGENTS.md「禁止第二条写输入框的路径」；先填草稿、由用户发送。若产品要求一键发送，
   需另立 spec 明确它复用哪一条 admission 与 optimistic overlay 语义。
4. **不做 CodeMirror merge view / 语法高亮 / 行内评论**：Track C 单独立项，涉及 DESIGN.md、
   i18n、手机布局与 bundle 体积；MVP 先用零依赖的纯文本 diff 验证验收闭环价值。
5. **不做 end-to-end 验收动作的 UI E2E 自动化**：本批新增的是投影与按需读，UI 侧以纯逻辑测试 +
   SSR/接线断言覆盖；真实点击链路的 E2E 需 web-gui-tester 场景，登记后续（AGENTS.md「交互改动需要
   E2E 场景」的缺口在本 spec 显式登记，不冒充已覆盖）。
6. **不动 `isTeamEnded` / 既有分组判据语义**：只追加 `in_review` 支路。