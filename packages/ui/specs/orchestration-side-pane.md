# 统一编排 Side Pane（三键合流，编排方案 Phase 2 / P2b）

来源：[`docs/codex-orchestration-integration-plan.md`](../../../docs/codex-orchestration-integration-plan.md)
§4 Phase 2 与 [`apps/acode-cli/specs/swarm-observability-projection.md`](../../../apps/acode-cli/specs/swarm-observability-projection.md)
的分批注记（P2a 投影链已实施，`5eed9f3`）。本批 = GUI 消费面：把 v4 snapshot 的
`subagents` / `workflowRuns` / `swarmPlan` 三键合成右侧 Side Pane 的一个统一编排
tab。DESIGN.md 合规与移动端约束见 R5。

## 背景（起草时逐条核实，行号以当前检出为准）

1. **三键协议面已齐、swarmPlan 零消费**：`packages/shared/src/acode-protocol-v4/snapshot.ts:485-492`
   依次定义三键（swarmPlan `.nullable().optional()`，null=显式清除）；`delta.ts:52-58`
   `state.updated` 键级整体替换（`apply.ts:119-121` 泛型 spread）——**swarmPlan 今天已
   流进每个 SessionPane 投影，packages/ui 无任何读取方**（grep swarm 零命中）。接入
   零协议改动。
2. **Side Pane 三件套模板**：tab 类型联合 `lib/workspaceSidePane.ts:516-535`（先例
   `WorkflowRunDirectorySidePaneTab` :271）+ 纯函数 opener（`openSubagentDirectorySidePane`
   :1635 / `openWorkflowRunDirectorySidePane` :1820，同 id 复用聚焦）+
   `app-shell/AnimatedSidePanePanel.tsx:1101-1170` type 分支渲染（`visible`/`focused`
   门控）。
3. **数据接线模板（两份逐字同构）**：`app-shell/SubagentDirectorySidePane.tsx:104-155`
   ——`V4PaneConversationProvider(scope)` → `useV4Conversation().layer.acquire(sessionId)`
   租约 → `useConversationProjection(lease)` 读 snapshot；`WorkflowRunDirectorySidePane.tsx:29-43`
   注释明说接线逐字相同。
4. **模型层纪律**：`v4/conversationStatusPanelModel.ts` / `v4/workflowRunDirectoryModel.ts`
   ——纯函数、单一信源、构造即过滤；workflow run 的 `status` 是投影端派生事实
   （`workflow-runs.ts:396`「reducer 只搬运——UI 绝不自行按 status + failureCode 推导」）。
5. **开合状态**：`hooks/useAppPanels.ts:195-204` React useState + `lib/taskSidePaneMemory.ts`
   模块级 LRU（无 localStorage/Zustand，新面板不加持久化）。
6. **入口触发链先例**：`ConversationStatusPanel` props `onOpenSubagentDirectory` /
   `onOpenWorkflowRunDirectory`（:148-150）→ SessionPane → WorkspaceShellLayout
   （:1875-1881）→ App.tsx（:1244-1249）→ useAppPanels handler（:862/:959）。
7. **订阅生命周期纪律**：`packages/ui/specs/hidden-pane-subscription-release.md`——
   不可见侧栏面板必须释放 lease/投影窗口；`renderer-memory-budget.md`——投影窗口
   双上限、词典懒加载。
8. **i18n**：`i18n/locales/zh-CN.ts` + `en-US.ts` 扁平词典（懒加载）；命名先例
   `sidePane.subagentDirectory`（:706-713）+ `subagentDirectory.*`（:714-725）；状态词
   复用 `chat.toolCall.workflow.run.status.*` 与 `subagentDirectory.status.*`。
9. **测试约定**：`packages/ui/package.json:18` node:test + tsx 纯逻辑测试（无 React
   组件测试）；最佳模板 `test/workflowRunActivity.test.ts:1-30`——用 shared 真 reducer
   铸 fixture 再断言 UI 侧纯函数。

## 产品规则

**R0 只读观察面，零第二状态。** pane 是三键的纯投影消费者：权威 = CLI v4 投影
（`SessionPane.tsx:3034`「CLI V4 projection 是唯一权威」注释同款纪律）；视图经纯函数
逐次派生（构造即过滤），不缓存 run/agent/swarm 事实、不写任何编排状态、不自行推导
status（消费投影端的派生事实，背景 #4）。

**R1 新 tab 类型 `orchestration` + 纯函数 opener。** `OrchestrationSidePaneTab` 入
`WorkspaceSidePaneTab` 联合；`openOrchestrationSidePane` 与两个 directory opener 同款
（同 id 复用聚焦，不重复开 tab）；开合/折叠自动落进既有 sidePaneState +
taskSidePaneMemory（零新增持久化）。

**R2 三段式布局，每段独立空隐。** 段序固定：Agents → Workflows → Swarm plan。
- 键缺席（旧 CLI 投影/未产生事实）或空值 → 该段不渲染（不占位、不显示空框）；
  `swarmPlan: null`（显式清除）与缺席同待遇；
- 三段全空 → pane 级空态（一条文案，不分段渲染）;
- **Agents 段**：`subagents.running` 行（title、subagentType、status 徽章
  running/waiting/blocked、startedAt 相对时间）+ `endedTotal` 计数行；
- **Workflows 段**：`workflowRuns.runs` 行——status 透传投影派生事实（绝不自行按
  status+failureCode 推导，`workflow-runs.ts:396` 既有纪律）；步数计数走 shared 的
  `workflowRunStepCounts`（唯一实现，run 卡/时间线/状态坞同源）；题名经
  `workId≡runId` 联接 `backgroundWorks`（与 conversationStatusPanelModel 同一联接
  规则）。ended 历史的 journal 分页查询面（workflowRunDirectoryModel）不复制进本
  pane（R3 跳转）；
- **Swarm 段**：goal（两行截断）+ mode / terminalState 徽章 + counts 计数行
  （queued/running/done/failed）+ 节点行（状态灯、id、gate 标记、content preview
  单行截断）+ `truncated` 如实标注。节点**渲染**上限
  `ORCHESTRATION_SWARM_NODE_DISPLAY_LIMIT = 200`（超限显示「前 N 条」提示；wire 上限
  512 仍在 snapshot 事实里，pane 不背全量渲染——renderer-memory-budget 纪律）。

**R3 跳转而非复制（合流面最小化）。** ended 历史分页、深度浏览不进本 pane——段头
action 打开既有 `subagent-directory` / `workflow-directory` tab（复用其 opener 与分页
RPC，避免第二份查询面）；本 pane 只背「一眼看到三键 live 状态 + 一跳直达目录」。
行级下钻（点行开 subagent-session / workflow-run tab）登记为后续批次（取舍 #1）。

**R4 订阅生命周期 = hidden-pane-subscription-release 纪律。** 渲染分支透传
`visible`；pane 的 lease acquire 以可见性为门（不可见 → release → 30s keep-warm →
共享投影窗口的 refCount 释放）。数据接线（provider → acquire → projection）与
SubagentDirectorySidePane 同款；目录面板对父会话共享 lease 未加门（历史现状），
本面板按 hidden-pane spec 的纪律直接做门控，不回改目录面板（登记为后续统一项）。

**R5 DESIGN.md 合规。** 稠密操作面板（非营销卡）：`text-ui-*` 强制（行标题
`text-ui-base`、元数据 `text-ui-sm`/`text-ui-xs`）；状态色只用语义 token（swarm 节点
状态灯与 workflow timeline station lamp 同语义映射：done=`--color-success`、
running=`--color-warning`、failed=`--color-destructive`、queued=中性弱色；waiting 徽章
用 confirmation-interaction 家族——「waiting badges use one green confirmation
treatment」）；icon-only 控件带可读标签（aria-label/title，「avoid icon-only meaning」）；
radius 走容器层级（pane 内首个圆角容器 `rounded-xl` 起）；段间 16px、行内 8-12px 家族
间距；`min-w-0` 截断纪律。**移动端不新增断点/专用组件**：side pane 的移动形态
（单列 + drawer）由既有 shell 承担（DESIGN.md「Mobile remote control retains its
single-column and drawer presentation」）；编排入口在全部断点保留（:495-499「主操作
不藏进桌面专属 affordance」）。

**R6 i18n 双词典同步。** 新增 `sidePane.orchestration`（tab 标题）+ `orchestration.*`
（段标题、空态、截断提示、跳转 action 标签）；zh-CN 与 en-US 同批成对出现（守护测试
断言两侧 key 集合一致）；状态词一律复用既有 key（背景 #8），不造第二套词汇。同批
收口 origin-lineage spec R5 登记的徽章展示：`InteractionRequestOriginBadge` 的
tooltip 在 `origin.ancestors` 在场时显示谱系链（根侧在前，`chat.interactionOrigin.
subagent.nestedTitle`），交互请求的归属链在 GUI 端完整可读。

**R7 TUI 镜像不在本批。** 「TUI 与 GUI 共用同一 reducer」的纪律已由 packages/shared
单一归约实现保证（`swarm-plan.ts:93-94` 注释即预告此结构；GUI model 直接消费其
输出）；TUI 的 swarm/统一编排展示面是独立产品面（apps/acode-cli/packages/tui），
登记后续（取舍 #2）。

## 状态所有权

| 状态 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 三键事实 | CLI v4 投影（snapshot 键，键级整体替换） | pane 只读（R0） |
| tab 开合/聚焦/折叠 | useAppPanels sidePaneState + taskSidePaneMemory | 既有机制，零新增 |
| 视图派生 | orchestrationPanelModel 纯函数 | 构造即过滤，无缓存 |
| lease/投影窗口 | SessionDataLayer（既有） | R4 可见性门控 |
| 文案 | i18n 双词典（懒加载） | R6 |

## 接口

- `lib/workspaceSidePane.ts`：`OrchestrationSidePaneTab` + 联合 + `openOrchestrationSidePane`（R1）；
- `app-shell/orchestrationPanelModel.ts`（新，纯函数）：三键 → 段视图模型（R2 常量与
  状态灯映射在此单点）；
- `app-shell/OrchestrationSidePane.tsx`（新组件）：lease 投影接线（R4）+ 三段渲染（R2/R5）；
- `AnimatedSidePanePanel` / `sidePaneTabPresentation` / `SidePaneTabTrigger` /
  `SidePaneTabOverview`：各加一个 case；
- `useAppPanels` handler + `app-shell/types.ts` prop + `App.tsx` + `WorkspaceShellLayout`
  透传 + `ConversationStatusPanel` 入口按钮 + `SessionPane` prop 透传（背景 #6 链路同款）；
- i18n：`sidePane.orchestration` + `orchestration.*`（R6）。

## 验收场景

见 `packages/ui/test/orchestrationPanelModel.test.ts`（node:test，fixture 用 shared 真
reducer 铸，照 workflowRunActivity.test.ts 模板）：

1. 三键齐备 → 三段视图（段序、行字段、徽章词汇、counts）；
2. 键缺席 / swarmPlan=null / 全空 → 对应段缺席、pane 级 empty 标志；
3. swarm 节点行 200 上限 + 「前 N 条」提示字段；wire truncated 标志如实透传；
4. 状态灯映射单点（done/running/failed/queued → 语义类名）；gate 节点标记；
5. workflow 行与 workflowRunDirectoryModel 同源（同一 run 事实两处派生的
   status/label 一致——真 reducer fixture 钉住适配器与面板两端）；
6. agents 行 waiting/blocked 状态透传（pane 不重推导 waiting 语义，消费投影事实）；
7. 源文本守护：AnimatedSidePanePanel 的 orchestration 分支透传 visible/focused；
   zh-CN 与 en-US 的 `orchestration.` key 集合一致（双词典同步）。

## 未做与取舍

1. **行级下钻与 pane 内 ended 历史分页**：R3 跳转先行——既有两个 directory pane 已
   背分页 RPC 与下钻入口，复制进统一 pane 就是第二份查询面（swarm-observability-
   projection 取舍 #3 同款方向）；下钻登记后续批次。
2. **TUI 镜像**（R7）：shared reducer 单源已保证「共用同一份归约」；TUI 展示面独立立项。
3. **swarmPlan 节点 DAG 图形化**：稠密列表 + dependsOn 事实已满足观察需求；图形化
   归可视化专项（workflow timeline 已有自己的 token 家族，不蹭）。
4. **不新增断点/移动端专用组件**（R5）：移动形态由既有 shell 承担。
5. **不做 pane 内动作面**（stop/retry/gate 裁决等）：本 pane 是观察面；动作留在
   既有权威入口（对话流工具卡、PlanCompleteGate 流程），避免第二写入路径。
