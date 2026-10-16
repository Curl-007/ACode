# 会话舰队（Session Fleet）——agent 可管理的并行会话工具族

波次 3（价值提取 T1-1a 机制移植）：给 CLI 补上「用户可见的并行会话舰队」层——
agent 用一组封闭工具启动、跟进、移交、调权、归档、删除**后台会话**，每个会话是
一等对象（title / status / started_at / last_activity / archived），所有权按
transcript 封闭，权限切换不对称（升权必过用户）。只搬机制，不搬厂商面：所有名字
ACode 化，无上游产品代号进入代码与本 spec。

## 背景（盘点结论，决定适配形态）

- **进程面现状**：CLI 的后台会话机制只有一套——`SubagentPort`
  （`core/src/subagent/runner.ts` + `core/src/runtime/methods/subagent.ts`）：
  后台 child 是**同进程 child AgentRuntime**，会话 JSONL 经 sessionStore 持久化
  （taskType `subagent_child`，id 恒等式 `sess_subagent_<agentId>`），生命周期投影进
  runtime-task registry（`local_agent` 条目），完成通知经
  `enqueueParentTaskNotification` 回父会话，跟进经 `sendMessage`
  （queued / steered / resumed_background）。舰队**复用这套进程面**，不另起进程。
- **权限序现状**：`CollaborationMode = plan|build|edit|yolo|auto`；严苛度单一事实源
  `core/src/subagent/nesting-policy.ts` 的 `MODE_SEVERITY`（auto 0 < plan 1 < edit 2 <
  build 3 < yolo 4）与 `moreRestrictiveMode`。子代理模式天花板 = 发起者当前有效模式
  （`resolveSubagentPermissionMode`，launch 与每次 resume 重锚）——「只紧不松」对
  child 是**结构性**事实，舰队工具不重复实现，只消费并叠加记录面。
- **ask 面现状**：`requiresUserInteraction` 能力位在 `PermissionService.checkPermissionByMode`
  里先于 yolo 直通（`tool.userInteraction` → ask），是既有的「bypass 免疫 ask」通道
  （ExitPlanMode / AskUserQuestion 同款）；`ToolEntry.resolvePermissionCapability`
  支持按输入动态改能力位（同步、可闭包读进程内状态）。
- **归档面现状**：sessionStore 的 `SessionInfo.time.archived` 与
  `UpdateSessionInput.timeArchived` 是既有一等字段；`listSessions(includeArchived)`
  既有。**没有** deleteSession 原语（删除数据面缺席，见 R8 与非目标）。
- **worktree 面现状**（波次 2，只消费）：`core/src/worktree/` 的
  `enterSessionWorktree`（enter 编排唯一汇合点）、`SessionWorktreeLedger`
  （bind/touch/tombstone 追加式台账）、`bindSessionWorktreeFence`（按路径键的进程内
  写围栏）。enter 拒绝闭集含 `inside_linked_worktree`（隔离只从主 checkout 开始）。
- **相邻面分工**（不留重叠歧义）：
  - `Agent` 工具（run_in_background）＝**一次性委托**：一个 prompt、一份结果通知，
    无用户可见生命周期对象。舰队会话＝**长活会话**：可跟进路由、可列、可移交、
    可调权记录、可归档/删除。两者共用进程面（child runtime），分工在生命周期层。
  - agent-teams 插件＝**队内任务图路由**（claim/reassign/roster）。舰队工具绝不触碰
    team state；agent-teams 工具绝不触碰舰队 registry。舰队会话的 vessel 可以是任何
    已派生 profile（含 agent-teams 成员），但舰队面只管会话生命周期。
  - swarm（PlanSeed 引擎）＝**单对话内的计划任务图**（`swarm_plan` runtime-task
    投影、PlanControl 停止面）。舰队＝**跨会话并行**。图节点 ≠ 舰队会话，互不寻址。
  - dynamic-workflow / RunWorkflow＝脚本编排，另一个域，不在本 spec 范围。

## 状态所有者

| 状态 | 唯一所有者 | 说明 |
| --- | --- | --- |
| 舰队记录（title/status 投影/recorded mode/archived/所有权/notes） | `core/src/fleet/registry.ts` 的进程级 `FleetRegistry`（单例，先例 `getSessionWorktreeManager`） | 内存态、进程作用域；child 与父同进程，进程亡故 = 舰队亡故，与后台代理生命周期一致 |
| 所有权事实（launchedBy） | 同上，**只在 launch 成功返回后写入** | 报错/被拒的调用不确立所有权（结构性保证：登记在 await 之后） |
| child 进程/运行事实 | runtime-task registry（既有，`local_agent` 条目） | 舰队只读投影 + archive/delete 时 `remove`（既有 API） |
| 会话标题 / 归档时刻 / 权限模式持久化 | sessionStore（既有端口：`updateSession`、`saveSessionEntry`） | 舰队写入，冷恢复面读回 |
| worktree 绑定 | `core/src/worktree/` 台账（既有，波次 2） | 舰队经公开 API 消费：enter 编排 + tombstone/bind 重键 |
| 回合报告回传 note（400 字符） | 舰队 registry 的 note 记录 | 推送面复用既有完成通知链（全量报告）；note 是舰队自有定量截断面 |

## 产品规则

### R1 工具面与命名

七个工具，全部 ACode 自撰名（无厂商代号）：`StartSession` / `SendToSession` /
`ListSessions` / `HandOffToSession` / `SetSessionPermissionMode` / `ArchiveSession` /
`DeleteSessions`。注册无门（worktree 三工具先例）：对任何会话自洽，端口缺席由
handler fail-closed（接线故障 throw `ConfigurationError`；业务边界回**拒绝结果**，
闭集 reason——escalate/worktree 的「拒绝不是错误」裁决）。`ListSessions` 只读；
其余变更面中 StartSession / SendToSession / HandOffToSession / ArchiveSession /
DeleteSessions 五个**automation / off-peak 派发轮一律拒绝**（闭集
`unattended_turn`；纵深防御：turn-loop-state 的隐藏名单归 WSJ，另行接线）；
SetSessionPermissionMode 走自己的不对称规则（R4：无人值守升权拒绝
`escalation_unattended`，降权/平调直通）。
子代理 child 继承工具面，但缺省 maxDepth=1 时 child 无 subagentPort → 变更面
fail-closed（`subagent_unavailable`），舰队嵌套由既有深度闸结构性封顶。

### R2 StartSession：用户可见的后台会话

- 参数：`title`（必填 1..120）、`prompt`（必填）、`permission_mode?`（plan|build|edit|yolo）、
  `use_worktree?`（缺省 false）、`branch_name?`。
- **模式只紧不松**：发起者有效模式 = `sessionModePort`（planEnabled ? plan : mode，
  缺席按 build）。请求模式严苛度**高于**发起者 → 拒绝 `mode_above_launcher`。
  等于/缺席 → child 继承天花板（结构性 clamp）。`plan` → vessel 换 bundled `Plan`
  preset（frontmatter `permissionMode: plan` → childMode=plan → planEnabled 地板，
  结构性强制只读）；Plan profile 缺席 → 拒绝 `plan_profile_unavailable`。
  低于发起者的非 plan 收紧（如 yolo 下请求 build）→ 拒绝 `mode_tightening_unsupported`
  （launch 面无 per-request 模式缝，见非目标 #2；绝不假装生效）。
- **use_worktree**：launch **之前**经 `enterSessionWorktree` 从当前 HEAD  provision
  隔离 worktree（不携带未提交改动——波次 2 语义原样），child 以 worktree 为
  workingDirectory 启动。enter 需要 sessionId 作台账键而 agentId 在 launch 内部才
  生成，因此用**临时舰队键 provision → launch 成功 → tombstone 临时键 + bind/tombstone
  重键到 childSessionId + 围栏重绑**（全部经 worktree 模块公开 API；毫秒级窗口，
  launch 失败则 tombstone 临时键回收）。enter 拒绝面（not_git_repo / unborn_head /
  inside_linked_worktree / branch_in_use）原样透传为 StartSession 拒绝。
  发起者已在受管 worktree 内时 `use_worktree:false` = child 开进**同一 worktree**
  （共享分支与材料），舰队记录登记同一 worktreePath——归档级联（R7）据此收口。
- 成功返回 `session_id`（= childSessionId，**所有权凭据**）与 `task_id`（= agentId，
  既有 TaskOutput / TaskStop 可观测与停止面照常可用）。标题经
  `updateSession(title, titleSource:"custom")` 落库（best-effort：失败只 warn，
  内存记录仍是舰队事实源）。一次性前台策略宿主（backgroundPolicy=foreground 的
  wrapper 重写）下 launch 同步完成 → 照实登记终态并返回，消息注明同步完成。
- launch 被拒（BACKGROUND_UNAVAILABLE 等既有闭集）→ 透传为拒绝结果；**任何失败路径
  都不产生舰队记录**。

### R3 所有权封闭（舰队安全的核心）

- 舰队工具只操作「**本 transcript 里自己 StartSession / HandOffToSession（新建）
  成功返回的 session_id**」。判据 = registry 记录的 `launchedBySessionId` 精确等于
  调用方 `context.sessionId`；**只按 id 查**，绝不从标题、task_id 或叙述推断
  （title 寻址 → `unknown_session`）。
- 违规闭集：id 无记录 → `unknown_session`；记录在但发起者是别的会话 →
  `not_owned_by_caller`。报错/被拒的 launch 不确立所有权（登记在成功返回之后，
  R2 结构性保证）。
- `ListSessions` 只列**本会话自身行 + 本会话所有的舰队会话**；`permissionMode`
  只出现在这两类行上（权限信息最小化＝列表作用域本身最小化，结构上不存在第三类行）。

### R4 SetSessionPermissionMode：权限不对称

- 比较基准 = 舰队记录的 recorded mode；序 = `MODE_SEVERITY`（单一事实源，消费
  nesting-policy 导出的 `moreRestrictiveMode` 同序）。
- **降权/平调直通**：更新 recorded mode + 经 `saveSessionEntry` 持久化
  execution-state 条目（`buildExecutionStateEntry` 同款形状；plan 记录为
  `{mode: 基模式, planEnabled:true}`）。
- **升权永不静默执行**：entry 工厂闭包 registry，`resolvePermissionCapability`
  同步判「请求 > recorded」→ 动态置 `requiresUserInteraction:true` → 权限服务在
  **yolo 直通之前**强制 ask（既有 `tool.userInteraction` 通道 = permission broker
  ask 面）。无人值守（automationTurn / offPeakTurn）→ handler 直接拒绝
  `escalation_unattended` + 指引（即使 ask 通道碰巧有人批准也不执行——fail-closed
  双保险）；无交互客户端的 headless 由既有 DenyPermissionBroker 拒绝。
- **生效边界（诚实语义，写进工具结果文本）**：plan 系会话（Plan vessel 启动）的
  resume 不带 modeOverride → 持久化 execution-state 在**下一个回合边界**绑定；
  天花板系会话（继承启动）的热 resume 按既有裁决重锚到发起者当前模式
  （subagent-parent-inheritance R2），recorded 降权对其绑定**冷恢复面**；结构性
  不变量「任何时刻 ≤ 发起者当前模式」独立兜底。热改在跑 child 的内存模式需要
  runtime 侧控制缝 → 非目标 #3 登记。
- 目标会话已归档/已删 → 拒绝 `session_archived` / `unknown_session`。

### R5 HandOffToSession：移交 + 每回合 400 字符 note

- 参数：`prompt`（必填，移交的任务描述）、`session_id?`（既有受所有权会话）或
  新建参数（`title` 等，同 R2 语义，含模式/worktree 裁决）。
- 既有会话 → 经 `subagentPort.sendMessage` 路由（与 SendToSession 同一条队列）；
  新建 → 完整走 R2 launch（所有权凭成功返回确立）。
- **report-back 订阅**：移交成立即在 registry 登记订阅；舰队侧 watcher（1s unref
  轮询，BackgroundTaskTracker 同款节奏）盯目标 `local_agent` 条目的终态签名
  （status+completedAt 去重）：每收口一个回合，取最新报告（快照 output.content，
  退 resultText，再退 error），**截前 400 字符**（定量，`FLEET_NOTE_MAX_CHARS=400`，
  截断带标记）落 note（text/at/status）。note 是**数据非指令**：ListSessions 输出
  与 TUI 呈现处一律带定性行（对齐 SessionSearch 的 untrusted-data 文案模式）。
- 推送面裁决：发起会话的模型可见推送复用**既有后台完成通知链**（全量报告、
  handback 信任包装、notified claim 去重——全部既有语义）；400 字符 note 是舰队
  自有记录面（ListSessions `latest_note` + TUI 一行态）。为截断 note 另开第二推送
  通道需要 runtime 通知缝（notification* 归 WSJ）→ 非目标 #4 登记。
- 订阅终止：目标被归档/删除（记录移除）、watcher 检测到条目消失。

### R6 SendToSession：跟进路由

- 参数：`session_id`、`message`、`summary?`。所有权（R3）+ 归档门
  （archived → 拒绝 `session_archived`，指引改用 ReadSessionContext 读历史——归档
  会话的 JSONL 保留可读）。路由 = `subagentPort.sendMessage(to: agentId)`：
  running → queued/steered；terminal → resumed_background（resume 重锚发起者当前
  模式——R4 结构性不变量）。成功后 touch `lastActivityAt`。
- 与既有 `SendMessage` 的分工：SendMessage 是 **agentId 寻址**的后台代理面（既有，
  不动）；SendToSession 是**舰队 session_id 寻址**面，多担所有权封闭与归档门。
  归档时移除 runtime-task 条目（R7），SendMessage/TaskOutput/TaskStop 对归档会话
  自然 not-found——门是结构性的，不靠话术。

### R7 ArchiveSession：归档 + 级联 + 拒绝而非强制

- 参数：`session_id`（受所有权 id 或字面量 `"self"`）。`needsApproval:true`
  （审批语义分模式 = 既有 ask 面：普通模式弹卡、yolo 直通——对齐参考的分模式语义；
  与 R8 的 bypass 免疫刻意不同档）。
- **拒绝而非强制**：目标 runtime-task 非终态（在跑）→ 拒绝 `session_running`
  （指引：等收口或先 TaskStop）；级联对象在跑 → 拒绝 `cascade_session_running`
  （整单不落，原子性）。pinned / 「在用户屏幕上」在 CLI 无对应事实 → 非目标 #5。
- **级联**（与目标一并归档）：a) 共享同一 worktreePath 的其它舰队会话（须终态）；
  b) 目标自己启动（launchedBy = 目标）且已终态的会话（「已完成的 side 会话」）。
  级联只收终态对象；在跑的嵌套会话不动、也不阻塞本单（参考语义：级联对象是
  「共享 worktree 或**已完成**的」）。
- 动作顺序：校验全通过 → store `timeArchived`（best-effort）→ runtime-task 条目
  `remove`（结构性关闭 SendMessage/TaskOutput/TaskStop 与 resume 面）→ 舰队记录
  `archived=true` → 撤销该目标的 handoff 订阅。**worktree 不动**（材料保留，
  不活跃清理由波次 2 的 ReapSessionWorktrees 负责）。对话 JSONL 保留可重开
  （ReadSessionContext / SessionSearch 照常可读；CLI 侧重开 = 用户 resume 面，
  非本工具族职责）。
- `self`：调用方是舰队会话（child 归档自己）→ 记录即刻 archived（当前回合自然
  收口，不再接受跟进路由）；**自己的在飞 runtime-task 条目不 remove**（finalize
  漏斗还在写它，移除会让结算撞 task_missing——舰队门由记录 archived 即刻关闭，
  条目在回合收口后自然终态）；调用方是主交互会话 → 仅落 store `timeArchived`
  （用户当前对话标记归档，回合照常结束），无舰队记录可动。

### R8 DeleteSessions：批量删除，全模式过审批

- 参数：`session_ids`（1..25，schema 硬界 + handler 复核）。**所有权限模式（含
  yolo/auto）都必须过用户审批**：entry 静态 `requiresUserInteraction:true` ——
  权限服务在 yolo 直通**之前**命中 `tool.userInteraction` ask（bypass 免疫走既有
  ask 面，与熔断器同哲学、不同通道）。
- **绝不删本会话**：列表含调用方 sessionId（或任何 `"self"`）→ 拒绝
  `includes_self`。
- `resolveInput` 在**确认窗之前**收口校验（dwf 先例：坏输入不配打断用户）：批量
  上限、所有权逐条（R3）、self 检查——任一违规回业务失败，不弹卡。弹卡时列表
  必然全部合法（卡面列全部会话 = 输入本身含全部 id；富展示卡需要新 display kind →
  非目标 #6）。
- 动作：在跑的先 `stopTask`（destructive:true，已获用户批准）→ runtime-task 条目
  remove → 舰队记录移除（所有权消灭）→ store `timeArchived` 标记（**数据保留**：
  端口无 deleteSession 原语，结果文本如实说明「已从舰队移除并停止，转录保留在
  磁盘」）→ 撤销 handoff 订阅。真删数据面 = 端口新方法 → 非目标 #7 + 报告接线项。

### R9 TUI 最小呈现

`tui/src/app-tool-transcript.ts` 的 `buildToolTranscriptProjection` 增加舰队工具
一行态（turnwrapup 最小呈现先例）：StartSession → `fleet: <title> [<mode>]`；
ListSessions → `fleet: <n> sessions`；Send/HandOff → `fleet: → <short-id>`；
Archive/Delete/SetMode → 对应一行。不做富渲染、不新开面板；desktop 舰队面板
登记后续批次（非目标 #8）。舰队 child 的运行中/终态呈现复用既有面：runner 自发
SubagentSpawned / BackgroundTaskCompleted 事件 → TUI 子代理目录照常收录。

### R10 hooks 面

TaskCreated / TaskCompleted 由既有 BackgroundTaskTracker 在**派发工具名**上触发；
舰队工具名不在 `SUBAGENT_DISPATCH_TOOL_NAMES`（单一事实源 compat.ts，非本波次
所有权）→ 舰队会话暂不触发这两个 hook。接入方式（compat 收录 vs fleet 侧
hookRunner 缝）需要跨面裁决 → 非目标 #9 + 报告接线项。舰队不新增 hook 事件。

## 事件顺序（所有者与关键时序）

```
StartSession（父 runtime 进程内）
  handler guard(unattended/port) ─拒绝→ [无记录]
    │
  mode-policy: launcherEffective vs requested ─拒绝→ [无记录]
    │
  use_worktree? ── enterSessionWorktree(临时舰队键) ─拒绝→ [无记录，无台账残留]
    │                        └成功→ provision{path,branch}
  subagentPort.launch(run_in_background:true, workingDirectory)
    │   └ runner: agentId 生成 → child runtime 建会话 JSONL → ready gate →
    │     registry.register(local_agent, running) → 返回 async_launched{agentId,childSessionId}
    │ [launch 失败/被拒 → tombstone 临时键 → 拒绝结果，无记录]
  FleetRegistry.register{sessionId=childSessionId, agentId, launchedBy=父sessionId,
                         toolCallId, title, mode, worktree?}      ← 所有权在此确立
    │
  worktree 重键: tombstone(临时键) + bind(childSessionId) + fence 重绑
  sessionStore.updateSession(title, custom)          （best-effort）
    └→ 返回 {outcome:"started", session_id, task_id, mode, ...}

HandOff note 回传（每回合）
  watcher(1s, unref) ── registry.get(agentId) 终态签名变化?
    └是→ note = report.slice(0,400)(+截断标记) → record.latestNote{at,status}
        └ 既有链并行：runner finalize → enqueueParentTaskNotification(全量报告)
  记录移除（archive/delete）→ watcher 退出

ArchiveSession（级联）
  校验{所有权, 目标终态, 级联集终态} ─任一拒→ [整单不落]
    └→ store.timeArchived(目标+级联) → registry.remove(agentId)(目标+级联)
       → record.archived=true → handoff 订阅撤销
```

## 验收场景

1. **StartSession 成功**：返回 session_id（`sess_subagent_` 前缀恒等式）+ task_id；
   registry 有 local_agent 条目；舰队记录 launchedBy=调用方；标题落库。
2. **只紧不松**：发起者 build，请求 yolo → 拒绝 `mode_above_launcher`；请求 plan →
   vessel=Plan、recorded mode=plan；请求 edit（<build）→ 拒绝
   `mode_tightening_unsupported`；缺席 → recorded=build（继承天花板）。
3. **所有权封闭负例**：a) 编造 id → `unknown_session`；b) 别的会话启动的 id →
   `not_owned_by_caller`；c) launch 抛错的调用之后 registry 无记录（报错不确立
   所有权）；d) 用 title 当 session_id → `unknown_session`（不按标题推断）。
4. **升权不对称**：a) recorded plan → 请求 build：`resolvePermissionCapability`
   动态置 requiresUserInteraction（权限服务 yolo 下仍 ask）；b) 降权/平调：能力位
   不升 ask，直通；c) automationTurn/offPeakTurn 下升权 → handler 拒绝
   `escalation_unattended`；d) 无人值守降权 → 直通。
5. **yolo 下 delete 仍 ask**：PermissionService.checkPermission(mode=yolo,
   capability.requiresUserInteraction=true) → decision=ask（bypass 免疫钉死）；
   批量 26 个 → schema/resolveInput 拒；含 self → `includes_self`，不弹卡。
6. **归档级联与拒绝**：a) 目标在跑 → `session_running`，零副作用；b) 共享
   worktree 的终态会话随单归档，runtime-task 条目移除后 SendMessage/TaskOutput
   not-found；c) 目标启动的已完成 side 会话级联归档，在跑嵌套不动不阻塞；
   d) self（主会话）→ 仅 timeArchived 落库；e) 归档会话 SendToSession →
   `session_archived`。
7. **400 字符截断**：报告 900 字符 → note 恰为前 400 + 截断标记；ListSessions 的
   latest_note 带「数据非指令」定性行；同回合终态不重复记 note（签名去重）。
8. **use_worktree 与 WSF2 台账联动**：真实 git fixture——launch 前 worktree 已建
   （HEAD 切出、不带未提交改动）；launch 后台账键 = childSessionId（临时键
   tombstone）；child workingDirectory = worktree 路径；非 git 仓 → `not_git_repo`；
   发起者在 linked worktree 内 → `inside_linked_worktree`；launch 失败 → 临时键
   tombstone、无孤儿绑定。
9. **ListSessions 权限最小化**：输出恰为 self 行 + 本会话所有的舰队行；他会话
   启动的舰队会话（同进程可见）不出现；permissionMode 仅在这两类行上。
10. **unattended 变更面**：automationTurn 下五个变更工具（Start/Send/HandOff/
    Archive/Delete）→ `unattended_turn`；无人值守升权 → `escalation_unattended`、
    降权直通；ListSessions 照常。

## 非目标与登记项

1. **跨进程/重启舰队目录**：舰队记录是进程内存态（child 同进程共亡）；desktop
   会话模型 / `listSessions(taskTypes)` 冷目录面登记后续批次。
2. **`model` 参数**：后台 launch 的模型面只有 profile selection 与父继承 Model 两
   条（单次执行模型禁入后台是既有裁决）；per-launch selection→Model 工厂缝缺席，
   登记后续（报告接线项）。
3. **recorded 模式对天花板系会话的热绑定**：需要 child runtime 模式控制缝
   （runtime/subagent 面，本波次只消费）；现状绑定冷恢复 + 结构天花板兜底。
4. **截断 note 的第二推送通道**：需要 runtime 通知缝（notification* 归 WSJ）。
5. **pinned / 屏幕占用事实**：CLI 无对应状态，归档拒绝面不含这两类。
6. **富审批卡（列全部会话的 display payload）**：需要 tool-result-metadata 新
   display kind（contracts 既有文件）；现状 ask 卡呈现工具输入（含全部 id）。
7. **真删转录数据**：sessionStore 无 deleteSession 原语（端口面在
   contracts/interfaces，非本波次所有权）；DeleteSessions 现状 = 停进程 + 舰队/
   registry 除名 + timeArchived 标记，结果文本如实陈述。
8. **desktop 舰队面板 / packages/ui**：后续批次。
9. **TaskCreated/TaskCompleted hook 覆盖舰队会话**：见 R10，需 compat.ts 或
   hookRunner 缝的跨面裁决。
10. **workflow actor 分域禁用**（ACTOR_DISALLOWED_TOOLS 收录舰队变更工具）：
    cli-workflow 面，报告接线项；actor 无 subagentPort 时变更面已 fail-closed。
11. **turn-wrap-up 的舰队后续建议卡**（suggested task → StartSession 一键启动）：
    与 T1-2 面合并登记。

## 接口（新增公开面）

- `contracts/src/tools/session-fleet.ts`：七工具名常量、zod 输入/输出 schema、
  `FLEET_NOTE_MAX_CHARS=400`、`FLEET_DELETE_BATCH_MAX=25`、拒绝 reason 闭集
  （`FleetRejectReason`：`unknown_session` / `not_owned_by_caller` /
  `mode_above_launcher` / `mode_tightening_unsupported` / `plan_profile_unavailable` /
  `escalation_unattended` / `unattended_turn` / `subagent_unavailable` /
  `background_unavailable` / `session_running` / `cascade_session_running` /
  `session_archived` / `includes_self` / `batch_too_large` / `worktree_rejected` /
  `delivery_failed` / `new_session_needs_title`）。
  barrel `contracts/src/tools/index.ts` 追加一行。
- `core/src/fleet/`：`registry.ts`（FleetRegistry + 进程单例 + 所有权解析）、
  `mode-policy.ts`（launch 模式裁决 / 升降权分类，消费 MODE_SEVERITY 同序）、
  `notes.ts`（400 截断 + watcher）、`worktree-provision.ts`（临时键 provision +
  重键）、`session-launch.ts`（StartSession/HandOff 共用 launch 编排）、
  `archive.ts`(级联)、`index.ts`（barrel，经 core/src/index.ts 导出）。
- `core/src/tool/handlers/`：七个新 handler 文件 + `handlers/index.ts` 静态注册。
- `tui/src/app-tool-transcript.ts`：舰队工具一行态投影。

## 依赖方向

`fleet → worktree / subagent(profile 常量) / runtime-task(只读+remove) /
sessionStore(端口)`；`handlers → fleet`；`tui → contracts`。舰队不 import
runtime 内部（execution-state 的 entry 构造在 fleet 内按契约形状自建，不 import
runtime/），不 import notification*（WSJ），不改 permission / hooks / subagent /
worktree 实现。
