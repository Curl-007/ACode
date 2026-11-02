# 宿主团队唤醒与队长侧等待（host-team-wake，编排方案批次 3 / G5+G6）

来源：[`docs/upgrades/orchestration-acceptance-2026-11.md`](../../../docs/upgrades/orchestration-acceptance-2026-11.md)
§3 G5/G6、§4.2 裁决点 2、§5 批次 3、§8 不做清单。本文是批次 3 的模块 spec，承接方案
提案；方案里的「新增/拟议」接口以本文的契约为准，其余仍为提案。

**定位与为什么不扩既有 spec（EI-2 单一真源）**：本批主体是「插件团队邮箱事件 → 宿主
注入队长会话」＋「队长侧阻塞等待」＋「已停止队长的显式人工介入」，其所有者是一个新的
宿主模块与一个新的插件工具面。既有四份 spec 各自承载不同语义，扩写会把一个新的语义
摊进四个文件，任一处读到的都是半份规则：

- [`agent-peer-messaging.md`](agent-peer-messaging.md) / [`agent-peer-messaging-cross-process.md`](agent-peer-messaging-cross-process.md)：**agent↔agent 的传输**（P0 进程内同父兄弟 / P1 mailbox 写入方），不含宿主唤醒与队长侧等待；
- [`subagent-pending-message-drain.md`](subagent-pending-message-drain.md)：**queued 投递的悬挂修复**（turn 起点 drain），本文复用其「turn 边界是唯一确定性投递点」结论，不修改；
- [`turn-auto-resume.md`](turn-auto-resume.md)：**跨回合临时性故障自动恢复**，本批**反向依赖**它：裁决点 2 选项 ①（auto-resume 复活队长）已被否决，本文只借其「注入路径 / 计数落点」形状。

因此新立本 spec，并对上述不变量以指针引用（不复制规则）。方案 §9/EI-137 要求 spec 先行
独立提交，实现另批。

## 裁决点 2 结论（**已冻结，不可更改**）

方案 §4.2 的两个选项里，本批取 **选项 ②（修正版）**，语义写死如下：

- 唤醒只针对**运行中且空闲**的队长会话（runtime 常驻 ∧ `isSessionInjectable()`）。
- 队长**已停止**（runtime 非常驻）时：**不** auto-resume、**不**注入；消息留在插件邮箱
  （durable），面板投影新增显式字段 `wakeHint`，供 UI 提示「队长已停止，需人工介入」
  ——EI-1 禁止静默降级。
- 队长**忙碌**时：消息留在邮箱，唤醒命令在 runtime 命令队列里排队，**回合结束后**投递
  一次（不打断在飞回合；对齐 AGENTS.md「已接受的 busy/running 输入由 CLI/runtime
  `CommandInbox` 串行 admission」——注意唤醒本身不经 `CommandInbox`，见 R5）。
- **退出条件**：唤醒/留箱计数落盘后，凭数据再评估选项 ①。计数不需要新台账——见 R9
  （唤醒计数 = 带 `team_wake` presentation 的 synthetic notice 条数，已在会话日志；
  留箱计数 = 插件 mailbox 未读/读档）。EI-48：真实源与派生索引分离，不造第二份台账。

## 背景（已核实的现状；行号基线 `feature/cli-agent-teams-acceptance-loop`，实施前需复核）

**注入链路（真实调用点，非方案假设的 `incoming-message.ts`）**：

- `core/src/system-reminder/incoming-message.ts:13` 是**文案与信任声明层**
  （`TASK_NOTIFICATION_PREFIX`，含「否定性声明 + 正向识别判据」，T1-p3 通道绑定）；
  `formatIncomingMessage`（同文件 `:16`）按 `RuntimeInputPresentation` 分发文案。
- 真实请求投影点是 `core/src/runtime/helpers/provider-entry-origins.ts:52`
  `projectIncomingMessageEntries`：按持久 user entry 的 `metadata.inputPresentation`
  在请求边界重新格式化（`task_notification` 额外补 `wrapSystemReminderForSource`
  外层标签）。**这印证方案附录 A 漂移修正第 2 条**：`incoming-message.ts` 不是注入通道。
- **回合内注入 vs 回合结束后投递**两条都已存在，且都走 runtime 命令队列：
  - 回合内：`core/src/runtime/methods/runtime-command-active-loop.ts` 的
    `drainPendingRuntimeCommandsForActiveLoop` 只吸收 `task-notification` 与
    `subagent-message`，以 `*_steer` presentation 追加进当前 turn；
  - 回合后：`core/src/runtime/methods/runtime-command-queue.ts:41`
    `drainRuntimeCommandQueue` 在 enqueue 时与 turn 收尾后各 drain 一次；
    `subagent-message` 分支（`:264`）`persistSubagentMessageCommand` → `executeTurnCommand`
    ——**这就是既有的「宿主自动开轮」机制**：成员经 `RespondToCoordinator` 回报时，
    空闲的父（队长）会话已被自动唤醒并开新 turn。
- 同类先例：`core/src/runtime/methods/background-notifications.ts:13`
  `enqueueBackgroundTaskNotification`（空闲自动开轮 / 在飞作为 run 中情报追加），
  `workflow-hole-wake.md` 的 hole 中途唤醒即复用该管线。

**队长三态的判定 API（宿主侧）**：

| 态 | 判据（既有） |
| --- | --- |
| 运行中且空闲 | `core/src/runtime/auto-resume/runtime-api.ts:47` `isSessionInjectable()` = `!runtime.shuttingDown && !runtime.hasActiveOrQueuedTurnWork()` |
| 运行中且忙碌 | `core/src/runtime/methods/runtime-command-queue.ts:103` `hasActiveOrQueuedTurnWork()`（含 `prompt-admission.ts:41` 的 busy 边界） |
| 已停止 | bootstrap 侧非常驻：`bootstrap/src/acode-protocol-v4/server-types.ts` 的 `context.sessions` 无该 `sessionId` 记录（`requireSession` 抛 `sessionUnavailable`）；投影侧 `packages/shared/src/acode-protocol-v4/snapshot.ts:123-131` `sessionControl.phase/stopState` |

**插件事件 → 宿主的既有通道（候选 b 的实锤）**：

- 插件 MCP server 以 `notifications/message`（logging）推送面板快照，logger 前缀
  `acode-plugin-state:`（`agent-teams-plugin/src/server.ts:322` `PLUGIN_STATE_LOGGER`，
  发射点 `:223` `emitPanelStateNotification`；每次工具调用收尾按 `team.seq` 差量去重发射，
  `manageOwnLock` 工具在返回后补发一次）。快照形状 `TeamPanelState` 见
  `agent-teams-plugin/src/panel-state.ts`（含 `seq`、`captainSessionId?`、`mailboxes[]`、
  `unreadMessages[]`（正文截断 400 字符、上限 20 条）、`teams[]`）。
- 宿主 adapter 消费：`adapters/src/mcp/index.ts:137` 前缀识别 + `:1721`
  `setNotificationHandler("notifications/message")` → `onPluginStateNotification`
  （声明 `:218`）；bootstrap 装配 `bootstrap/src/app/create-app.ts:719-756` 落成
  `SessionEventType.PluginStateUpdated` 会话事件 → `pluginStates` 状态键 →
  v4 snapshot/delta（`packages/shared/src/acode-protocol-v4/snapshot.ts:555`、
  `delta.ts:62`）。
- **插件零 core 依赖**成立（`agent-teams-plugin/package.json` 仅
  `@modelcontextprotocol/server`；`.mcp.json` 声明 stdio server；env
  `AGENT_TEAMS_STATE_DIR` 由 `adapters/src/plugins/mcp.ts` 的 resolver 用
  `user_config.stateDir` 模板展开，缺省 = `<workspace>/.agent-teams`，
  见 `agent-teams-plugin/src/state/store.ts:350` `resolveStateRoot`）。

**邮箱与「已停止成员」现状**：

- 队长收件箱只在队长调 `agent_teams_status` 时被读取并置 read
  （`agent-teams-plugin/src/tools/team-status.ts:112-115`，正文经
  `wrapTeamMessageBodies` 套 trust-wrapper）；`TeamMessage` **没有 kind 字段**。
- `core/src/subagent/peer-send-paths.ts:285`：peer 消息不得复活已停 agent，文案是
  「ask your coordinator … to re-dispatch it」——本批**不改该语义**，把它升级为宿主可执行
  的重派动作（R8）。
- 队长 SendMessage（coordinator 路径）可后台复活已终态成员
  （`core/src/subagent/runner.ts` `resumeTerminalAgentInBackground`，见
  `agent-teams-plugin/docs/protocol.md`「驳回语义」）——peer 路径与 coordinator 路径
  的这条差异是 R8 的依据。

## 产品规则

**R0 通道裁决：宿主经既有 `acode-plugin-state:` 通道感知事件（选项 b 为唯一主选）。**
三候选的裁决与失效模式：

| 候选 | 裁决 | 依据 / 失效模式 |
| --- | --- | --- |
| a) 观察 `AGENT_TEAMS_STATE_DIR` 文件 | **否决为主选** | 宿主能拿到该目录（resolver 展开，缺省 `<workspace>/.agent-teams`），但需新建 file watcher（`turn-auto-resume.md` 明确「不新建文件 watcher」），且原子写 rename 的事件时序、丢失/重复、跨进程竞态全要自造；且读到的是插件**私有存储**，等于让宿主读第二真源。仅当通道 b 长期不可用时作降级候选登记。 |
| b) MCP `notifications/message` | **采纳** | 通道已存在且已接线（见背景）；插件零 core 依赖不变（只发射通知）；宿主只消费插件**已发布投影**，不读插件私有存储。失效模式见 R1/R9。 |
| c) 工具返回流捎带（`scheduler.ts` `next_actions`） | **否决** | 现役 `next_actions.wake` 只在**调用方自己的**工具返回里可见（`agent-teams-plugin/src/scheduler.ts:5-9` 注释自认），成员汇报发生在成员会话、队长看不到；队长只有下次自发调工具时才看到——正是 G5 要消除的「依赖队长模型自觉」。 |

**R1 插件发布唤醒投影 `wakePending`（additive optional）。** 插件在面板快照上加一个
插件自算、有界的待唤醒投影（插件拥有邮箱与任务状态机，宿主不解释其内部语义）：

```
TeamPanelState.wakePending?: {
  generation: number;              // = TeamState.wakeSeq（单调，见 R3）；宿主据此防旧世代覆盖（EI-59）
  captainSessionId: string;        // = team.captainSessionId，路由目标
  messages: Array<{                // 队长邮箱未读，按投递序升序，≤ MAX_WAKE_EVENTS(8)
    messageId: string; from: string;
    kind: "report" | "question" | "escalation" | "note";
    deliveredAt: string;
  }>;
  settledTasks: Array<{            // 成员名下、已进终态、且晚于 lastCaptainSeenAt 的任务
    taskId: string; owner: string;
    status: "done" | "failed" | "blocked";
    at: string;                    // = 最新 attempt.endedAt
  }>;
  triggers: Array<"message" | "settled_task" | "question" | "escalation">;  // 去重后的原因集
  truncated?: true;                // messages/settledTasks 被 MAX_WAKE_EVENTS 截断时置位（EI-9 诚实：计数另给）
  counts: { unreadMessages: number; unsettledMemberTasks: number };
}
```

- `wakePending` **只承载结构事实 + 有界摘要，不携带成员原文**（原文仍在磁盘 mailbox，
  经 `agent_teams_status` 的读边界包装后才进模型上下文）。这样唤醒注入天然满足
  「不降级插件 trust-wrapper 协议」（§8 不做清单第 8 条）：宿主从不搬运未包装的原文。
- 旧宿主忽略该字段（additive optional，`v` 仍为 1），形状不符时按既有
  `teamPanelModel` 纪律返回 null 不渲染半张卡。

**R2 插件邮箱消息新增 `kind`（additive optional，默认 `note`）。** `TeamMessage` /
`TeamPanelMessage` 增 `kind?`；`agent_teams_send_message` 增可选 `kind`（枚举
`report|question|escalation|note`，`.strict()` 对象，运行时校验面同步）。语义：成员**阻塞提问**
用 `question`、上报需要用户决策/权限的风险用 `escalation`、常规完成汇报用 `report`。
队长/成员提示词与 `docs/protocol.md` 同批同步（EI-107 文案纪律）。

**R3 `TeamState.wakeSeq` 单调计数（additive）。** 插件在**成员来源**的唤醒级写入上递增
（邮箱投递 `deliverMessage`；成员 `update_task` 进入 `done|failed|blocked`）；队长自身的读/写
不递增。它是「新事件世代号」的唯一来源（EI-59），也让 `wakePending.generation` 单调。

**R4 宿主唤醒器归属：新 core 模块 `core/src/runtime/team-wake/`。** 结构与
`core/src/runtime/auto-resume/` 同构，最小集：

- `owner.ts`——决策与计数私有 owner（module-private `WeakMap<AgentRuntimeInternal, …>`，
  不进 `internal.ts` 状态簇，照 auto-resume `runtime-api.ts` 纪律）；
- `injector.ts`——合成注入文本（R6）并入队 runtime 命令；
- `runtime-api.ts`——公开命令面 `applyTeamWakeIntent(intent)`，经 `methods/index.ts`
  一行装配到 `AgentRuntime.prototype`（照 `installAutoResumeRuntimeMethods`）；
- `types.ts`——`resolveTeamWakeConfig`（R7）+ 常量。

宿主接线点：`bootstrap` 的 `onPluginStateNotification` / `subscribePluginStateNotifications`
（既有，`create-app.ts:719-756`）在落 `PluginStateUpdated` 事件之后，额外读
`wakePending`，解析 `captainSessionId` → `context.sessions.get(...)`，命中则调
`record.app.runtime.applyTeamWakeIntent(...)`；未命中则按 R8 写投影 hint。**core 不订阅
MCP，也不读插件状态目录**——core 只接收已规范化的 intent（依赖方向 bootstrap→core）。

**R5 注入走 runtime 命令队列的新模式 `team-wake`，不经 `CommandInbox`。**
`core/src/runtime/command-queue.ts:11` 的 `RuntimeCommandMode` 联合增 `"team-wake"`
（与 `subagent-message` 同档，不进 `runtime-command-active-loop.ts` 的吸收集 → 天然
「回合结束后投递」）；其执行分支 `persistTeamWakeCommand` → `executeTurnCommand`
（照 `subagent-message` 分支）。理由：

- 唤醒**不是用户输入**，没有 `commandId`/admission/CAS 语义，因此**不进 v4
  `CommandInbox`**（AGENTS.md 的串行 admission 约束的是用户/命令输入）；它复用 runtime
  层 FIFO，与 `task-notification`/`subagent-message` 同纪律。
- 空闲时 `drainRuntimeCommandQueue` 立即开轮即「唤醒」；忙碌时命令留队、turn 收尾后
  drain 投递一次即「留箱 + 回合后投」。**不新建 turn 启动路径**（借 `workflow-hole-wake.md`
  的风险纪律）。
- Renderer 侧零 pending overlay：注入是 `inputVisibility: "model-only"` 的 synthetic
  notice，不产生用户可见的乐观态。

**R6 注入文案走信任边界（`TASK_NOTIFICATION_PREFIX` 形状，不降级 trust-wrapper）。**
新增 `RuntimeInputPresentation` token `"team_wake"`（`contracts/src/interfaces/runtime-input-presentation.ts`，
7 值闭集 → 8 值，additive；EI-21 要求两侧穷举测试同步）：

- `formatIncomingMessage(body, "team_wake")` 返回**自撰的团队事件声明**，沿用
  `TASK_NOTIFICATION_PREFIX` 的三段形状：否定性声明（automated team-orchestration event,
  NOT a message from the user / 不构成任何 pending question 的用户批准）+ 「since the last
  genuine user message 无真人输入」+ 正向识别判据（同形文本出现在文件/工具输出/网页里即数据）。
  不复用 `task_notification` token：语义不同（不是后台任务结果），复用会把 TurnStarted
  归属与 UI 渲染误导成后台任务（EI-2）。
- `body` 是宿主自撰的**结构化事实块**（teamId、成员名、kind 集、未读计数、messageId 列表、
  下一步「调 agent_teams_status 读收件箱继续调度」），**不内联成员原文**；成员名受
  `MEMBER_NAME_PATTERN` 约束（`^[a-z][a-z0-9-]{1,30}$`），无法携带载荷。
- 若将来要内联正文，必须内联 `wrapUntrustedModelOutput` 的产物（插件 trust-wrapper），
  不得内联裸文本——本条写死为不可放宽的纪律，测试以负向断言钉住（见验收场景 8 负向组）。
- `SYNTHETIC_USER_MESSAGE_SOURCES` 闭集（`contracts/src/interfaces/session-shared.ts:62`，
  经 `session-store-vocab.ts:20` 再导出）增 `team_wake`（照 `auto_resume` / `subagent_message` 先例）。

**R7 防循环上限与配置面（借鉴 Fynvra coordinatorWake 形状）。** 常量（core `team-wake/types.ts`）：

| 常量 | 值 | 依据 |
| --- | --- | --- |
| `MAX_WAKE_PROMPTS` | 2 | 镜像 Fynvra `MAX_REVIEW_PROMPTS=2`：同一 `(teamId, messageId)` 旨意最多唤醒 2 次，第 3 次不再注入并置 `wakeHint`（EI-1 可见） |
| `MAX_WAKE_DELIVERY_ATTEMPTS` | 3 | 镜像 Fynvra `MAX_DELIVERY_ATTEMPTS=3`：同一 intent 因 drain 失败/世代失效重排最多 3 次 |
| `MAX_WAKE_EVENTS` | 8 | `wakePending` 的 `messages`/`settledTasks` 数组上限；与 `MAX_PANEL_UNREAD_MESSAGES=20` 是不同层（前者是唤醒触发集，后者是 UI 样本） |
| `WAKE_INTENT_TTL_MS` | 10 * 60 * 1000 | intent 超过 10 分钟仍未能注入（队长持续忙碌）→ 丢弃并置 `wakeHint`，避免醒来后处理化石事件（EI-11：不自动重放状态未知的旧旨意） |

**计数存储位置裁决：宿主侧 per-runtime 内存**（不进团队状态 JSON）。理由：唤醒是**宿主
行为**，落团队 JSON 会把宿主写进插件真源（第二写入者，EI-2）；且
`turn-auto-resume.md` 已立同款纪律「进程内 per-session 内存，不跨进程持久化——进程亡即
重试链亡，杜绝重启后幽灵续跑」。键 = `(teamId, messageId)`（消息级）/ `(teamId, generation)`
（世代级），重置条件 = 队长成功读收件箱（ack）/ 用户输入被 admission / 成功 turn（镜像
auto-resume 的重置档）。

配置面 `agentTeams: { hostWake: { enabled?, maxWakePrompts?, maxDeliveryAttempts?, intentTtlMs?,
  waitDefaultMs?, waitMaxMs? } }`：声明照 `autoResumeSchema`
（`adapters/src/config/schema.ts:235`）→ parse 回填（`:443` 附近）→ config-merger（照
`:198-205` 的「assign 前快照」纪律）→ core `runtime/types.ts`（照 `:211`
`autoResume?: Partial<…>`）→ `resolveTeamWakeConfig`。**默认值三级**（EI-152）：用户显式
配置 > 偏好设置 > 硬编码回落；`enabled` 缺省 `true`（唤醒是既有语义的补全、非新算力面，
且惊讶成本由上限 + 配置覆盖封顶，同 `turn-auto-resume.md` 的默认值分档裁决）。**逃生阀
只能是用户显式配置**（EI-149），不自动回退。

**R8 「已停止」两态与重派动作。**

- 队长已停止（非常驻）：不注入；投影 `wakeHint.kind = "captain_stopped"`（R10），
  并给 UI 一个可执行动作入口（形状见「接口」`teamWakeAction`）；消息留箱不丢。
- 已停止**成员**：保留 `peer-send-paths.ts:285` 语义不改（peer 不得复活）；把文案里的
  「ask your coordinator to re-dispatch」升级为**宿主可执行的重派动作**：bootstrap 提供
  `redispatchStoppedMember({ teamId, member, taskId? })`——(1) 以宿主侧 subagent/registry
  事实核实该成员确已终态（否走 ordinary 路径，不误伤）；(2) 取 `captainSessionId` 的常驻
  runtime；(3) 经队长身份走 coordinator SendMessage（后台复活，`resumeTerminalAgentInBackground`）
  或 `agent_teams_reassign_task`（换人/队长接管）；(4) 返回结构化结果。UI 侧显式提示
  「成员已停止，需重派」，不静默丢弃（EI-1）。
- 队长与成员两态都**不为手机另起 Agent/Host/会话**（§8 第 6 条）。

**R9 事件丢失 / 重复 / 跨进程时序的失效模式与兜底（EI-4 fail-open + EI-1 不静默）。**

- **观察丢失**：插件的 `emitPanelStateNotification` 捕获异常后保留游标、靠**下一次工具
  调用**重发（`server.ts:257-259`）。若此后无工具调用，通道不再重发。兜底：**权威路径是
  pull**——队长（或成员）任何一次工具调用都会重新发射；且队长冷恢复时 `pluginStates`
  会话事件日志里保有上一帧，宿主据此**重新派生**待唤醒（世代号约束下至多再注入一次）。
  丢失期间属「延迟」不属「丢失一致性」（同 `workflow-hole-wake.md` 的语义）。
- **重复触发**：同一事件可能因多次工具调用被多次发射。去重三层（EI-22 落存储层）：
  1. **存储层唯一约束**（插件）：mailbox 消息以 `randomUUID()` 为文件名，未读→读是
     原子 rename 平移，同一消息不会有两个未读文件；`lastCaptainSeenAt` + `markMessagesRead`
     构成**队长已读取的 durable ack**；
  2. **世代号**（宿主）：`generation = wakeSeq`（R3）单调，intent 世代 < 已处理世代即丢弃
     （EI-59）；
  3. **消息级 ack**（宿主内存）：`deliveredMessageIds`（进程内），consume-on-inject。
- **跨进程时序**：成员工具调用在共享的插件 server 进程内写邮箱 → 发射通知 → 宿主 adapter
  异步收到；队长可能正在在飞 turn。竞态「通知晚于队长的 status 读信」→ 唤醒注入时邮箱
  已空 → 注入的 body 只含空触发集 → **不注入**（emptiness guard）。反向竞态（队长读信后
  通知才到）同样被 emptiness guard 吃掉。两者都幂等。

**R10 `wakeHint` 投影字段形状（宿主侧派生，插件不生产）。**

- 输入：(1) 插件的 `wakePending`（`counts.unreadMessages` / `settledTasks` / `truncated`）；
  (2) 队长会话运行态——UI 侧直接用既有 `packages/shared/src/acode-protocol-v4/snapshot.ts:123-131`
  `sessionControl`（`phase` / `stopState`），零协议新增。
- 输出（UI 模型 additive）：`ConversationStatusPanelTeam.wakeHint?: {
    kind: "captain_stopped" | "captain_busy" | "member_stopped";
    unreadMessages: number; unsettledMemberTasks: number;
    kinds: Array<"report"|"question"|"escalation"|"note">;   // 来自 wakePending.messages
    sampledTruncated?: true;                                  // wakePending.truncated 透传（EI-9）
  }`，计算点 `packages/ui/src/v4/teamPanelModel.ts`（既有「宿主不解释插件状态」的受检投影
  文件，`teamPanelModel.ts:1-13` 头注纪律不变：宿主只按形状收窄 + 只叠加宿主自有事实）。
- 判定：`unreadMessages + unsettledMemberTasks > 0` 且队长非常驻/非空闲 → 置 hint；
  `member_stopped` 由宿主侧 subagent 终态事实（R8）触发。文案中英文同批（EI-107），
  走 EI-101 空态/状态徽章通道，不用会消失的 toast（EI-100）。

## 状态所有权

| 事实 | 唯一所有者 | 变更 |
| --- | --- | --- |
| 团队邮箱（消息、未读/读档、`kind`） | 插件 `TeamStore`（磁盘唯一真相，`store.withLock` 读改写、原子 JSON） | + `kind` 字段 |
| `wakeSeq` / `lastCaptainSeenAt`（世代与 ack） | 插件 `TeamState`（既有字段 + 1 additive） | + `wakeSeq` |
| `wakePending` 投影 | 插件 `panel-state.ts`（派生读，可从邮箱 + 任务重建，EI-48） | 新增派生字段 |
| 唤醒决策与计数（`MAX_WAKE_PROMPTS` 等） | core `runtime/team-wake/owner.ts`（进程内 `WeakMap`，不持久化） | 新模块 |
| 注入文本与 `team_wake` presentation | core `team-wake/injector.ts` + `incoming-message.ts` case | 新增 |
| 队长运行态（空闲/忙碌/已停止） | core runtime（`hasActiveOrQueuedTurnWork`）+ bootstrap 常驻表（既有，只读） | 不变 |
| `wakeHint` | UI `teamPanelModel.ts`（宿主派生投影，非插件事实） | 新增 |
| 唤醒/留箱计数 | 会话日志里 `team_wake` synthetic notice 条数（派生统计，不落第二份台账） | 既有通道 |

## 接口

- **插件（MCP）**：
  - 新工具 `agent_teams_wait_for_members`，`memberAllowed: false`，`manageOwnLock: true`；
  - `agent_teams_send_message` schema 增可选 `kind`（R2）；`TeamMessage` / `TeamPanelMessage` 增 `kind?`；
  - `TeamState` 增 `wakeSeq: number`；`TeamPanelState` 增 `wakePending?`（R1）。
- **contracts**：
  - `RuntimeInputPresentationSchema` += `"team_wake"`；
  - `SYNTHETIC_USER_MESSAGE_SOURCES`（`session-shared.ts:62`）+= `"team_wake"`；
  - `incoming-message.ts` 的 `formatIncomingMessage` += `"team_wake"` case（穷举 switch）。
- **core（不进 contracts；窄面是 runtime↔注入器的进程内接缝）**：
  - `command-queue.ts`：`RuntimeCommandMode` += `"team-wake"`；`TeamWakeRuntimeCommand`
    `{ branchGeneration; mode; source: "team_wake"; teamId; wakeGeneration; messageIds: string[];
    triggers: readonly ("message"|"settled_task"|"question"|"escalation")[]; captainSessionId; text }`；
  - `runtime/team-wake/types.ts`：`TeamWakeIntent`、`TeamWakeConfig`、常量；
  - 公开命令面：`AgentRuntime.applyTeamWakeIntent(intent: TeamWakeIntent): void`（optional 成员）。
- **bootstrap**：
  - 接线 `onPluginStateNotification` → `applyTeamWakeIntent` / `wakeHint`（R4）；
  - `redispatchStoppedMember(input)`（R8，宿主动作）；对外以 v4 命令暴露（形状
    `teamWakeAction { teamId; member; taskId?; action: "redispatch_member" }`，UI 接线归批次 4）。

- **`agent_teams_wait_for_members` 完整契约**：

```
schema: z.object({
  teamId?: string(regex TEAM_ID_PATTERN),
  until: z.enum(["any","all"]).default("any"),
  timeoutMs?: number,                       // clamp，见下
}).strict()
memberAllowed: false                         // 队长专属；成员调用 → forbidden_for_caller
manageOwnLock: true                          // 锁内探测一次、锁外 sleep 2s（照 member-wait.ts:16-17）
```

  返回（成功；**超时不是错误**）：
```
{ ok: true, teamId, until, timedOut: boolean,
  reasons: Array<"captain_unread_message"|"question"|"escalation"|"settled_member_task"|"member_waiting"|"none">,
  unread_messages: wrappedTeamMessageBodies,   // 读边界包装（trust-wrapper；同 status 先例）
  settled_tasks: Array<{ taskId, owner, status, at }>,
  waiting_members: string[],                   // 正阻塞在 wait_for_work 的成员（插件已知）
  counts: { unreadMessages, unsettledMemberTasks, inProgressMemberTasks },
  next_actions: computeNextActions({ perspective: "captain" }),
  trust_note: TEAM_TRUST_NOTE,
  identity_degraded?: string }                 // 降级身份警告（既有）
```
  - **立即返回语义**：`reasons` 含 `question`/`escalation`（成员提问/上报）→ **无论
    `until` 取值立即返回**（防「提问的成员 ↔ 等待的队长」互等死锁）。
  - `until:"any"`：任一唤醒级事实（队长未读消息 / 成员名下任务进终态 / 提问 / 上报）即返回。
  - `until:"all"`：成员名下**无 `in_progress` 任务**且**无队长未读消息**时返回；
    **定义写死为「无进行中任务」而非「所有成员已汇报」**——没有任务的成员永远不汇报，
    后者会与阻塞在 `wait_for_work` 的空闲成员互等死锁。
  - 超时：`{ ok: true, timedOut: true, reasons: ["none"], … }`，**退回中队长的下一次调用**
    （同 `agent_teams_wait_for_work` 的「再调继续等」纪律）。
  - 读信即置 read（`markMessagesRead`，队长 ack）；等待期间在 `TeamState` 记
    `captainWaitingUntil`（additive optional，镜像 `member.waitingUntil`），供宿主判断
    「队长正在有意的阻塞等待」。

- **`timeoutMs` clamp 区间（EI-6）**：`WAIT_FOR_MEMBERS_DEFAULT_MS = 300_000`（5 min），
  clamp `[1_000, 480_000]`（1s .. 8 min），`WAIT_FOR_MEMBERS_POLL_INTERVAL_MS = 2_000`；
  不可解析 → 回落默认（「没配过」），越界 → 夹到边界（「配错帮收」），照
  `normalizeMaxReassignRounds` 的双分支纪律（`state/types.ts`）。
  **区间依据**：`.mcp.json` 的 server `timeoutMs = 600_000`（10 min），工具必须在宿主
  MCP 截止前返回；8 min 与成员侧 `WAIT_MAX_MS = 8 * 60 * 1000`（`member-wait.ts:16`）
  同惯例并留 2 min 余量；下界 1s 防「0 即立即超时」的退化调用。

## 事件顺序与幂等

```
[成员侧] 成员调 agent_teams_update_task(done) / agent_teams_send_message(to:captain, kind:question)
  → 插件 store.withLock 内写盘（mailbox 原子 JSON / 任务状态）+ team.wakeSeq++
  → emitPanelStateNotification（team.seq 差量去重）→ notifications/message(logger:acode-plugin-state:agent-teams, data:TeamPanelState 含 wakePending)

[宿主侧] adapters/mcp setNotificationHandler → onPluginStateNotification
  ├─ 落 SessionEventType.PluginStateUpdated（既有）→ pluginStates（desktop-continuous 实时链路）
  └─ 读 wakePending?（无 或 triggers 空 → 结束，emptiness guard）
      ├─ 世代过滤：generation < 已处理世代 → 丢弃（EI-59）
      ├─ 消息级去重：messageIds ⊆ deliveredMessageIds → 丢弃（ack）
      ├─ 路由：context.sessions.get(captainSessionId)
      │   ├─ miss（队长已停止）→ 置 wakeHint= captain_stopped + 留箱；结束（EI-1，不静默）
      │   └─ hit → record.app.runtime.applyTeamWakeIntent(intent)
      │        ├─ runtime.applyTeamWakeIntent：计数 +1；> MAX_WAKE_PROMPTS → 置 hint、不再注入
      │        └─ enqueueRuntimeCommand(mode:"team-wake") → drainRuntimeCommandQueue
      │             ├─ 队长空闲：persistTeamWakeCommand（synthetic notice, inputPresentation:"team_wake",
      │             │           metadata.teamWake={teamId,generation,messageIds,triggers}）
      │             │           → executeTurnCommand（自动开轮 = 唤醒）
      │             └─ 队长忙碌：命令留队（team-wake 不在 active-loop 吸收集）→ 当前 turn 收尾后 drain 投递一次
      │                  → 本次消费成功 → 计入 deliveredMessageIds（ack）
      └─ 投影：wakePending + sessionControl → teamPanelModel 派生 wakeHint → 团队卡/Side Pane

[请求投影] 持久 entry(metadata.inputPresentation="team_wake") → provider-entry-origins.projectIncomingMessageEntries
  → formatIncomingMessage("team_wake") 声明 + 结构化事实块 → 模型上下文
幂等：邮箱文件 id 唯一（存储层 ack）+ wakeSeq 世代 + 内存 deliveredMessageIds；
      emptiness guard 吃跨进程时序竞态；队长读信即 durable ack（重放不产生第二次派工）
```

## 双链路验证清单（AGENTS.md 硬要求；两条语义必须分别验证）

| 链路 | 必须验证 |
| --- | --- |
| **desktop-continuous**（实时流） | ① 通知到达即注入，空闲队长 ≤5s 内开轮；② 在飞 turn 内不注入、turn 收尾后投递一次；③ 同一事件多次通知不产生第二次 turn；④ 注入的 turn 行带 `inputPresentation:"team_wake"` 归属（不渲染成后台任务）；⑤ `wakePending` → `pluginStates` → 团队卡 `wakeHint` 实时一致 |
| **web-remote-replayable**（手机，快照重放） | ① 手机重连后拿到 snapshot（`pluginStates` 含 `wakePending`）→ `wakeHint` 与桌面同结论（`teamPanelModel` 单点收窄，不各算一遍）；② **断线/重连/快照恢复后唤醒不得重放成重复派工**：重放时 mailbox 已读 → `wakePending.triggers` 空 → 无注入；若未读仍在，重放至多再注入一次且不重复派工（世代号 + 邮箱 ack 证据）；③ 恢复链路**不另起** Agent/Host/会话（§8 第 6 条），只重放同一投影面 |

## 验收场景（方案 §5 批次 3 ①–⑦ 细化；⑦ 按选项 ② 语义）

实现落地测试：插件侧 `apps/acode-cli/packages/agent-teams-plugin/tests/host-team-wake.test.ts`
（含 wait_for_members 穷举），宿主/core 侧 `apps/acode-cli/tests/host-team-wake.test.mjs`
（含注入/去重/双链路负向断言）。

1. **① 空闲队长被自动唤醒**：成员 `update_task` 落 done（或 `send_message(kind=question)`）→
   空闲队长在 ≤5s 内自动开一个新 turn；注入文本含 `TASK_NOTIFICATION_PREFIX` 形状的三段
   （否定声明 / 无真人输入 / 正向识别判据），**不含成员原文**；队长调 `agent_teams_status`
   读到 `wrapTeamMessageBodies` 包装后的正文（trust-wrapper 帧行在场）。
2. **② 忙碌队长留箱、回合后投、不重复**：队长在飞 turn 中到达同一事件 → 不注入、无 steer；
   turn 收尾后投递**恰好一次**；同一 `(teamId,messageId)` 的多次通知不产生第二次 turn
   （世代号 + 内存 ack 断言）。
3. **③ 队长侧等待：成员提问立即返回，防互等死锁**：队长调
   `agent_teams_wait_for_members(until:'all')`，成员投 `kind=question` → 工具**立即**返回
   （`reasons` 含 `question`），不等到 timeout；`until:'all'` 在「成员名下无 in_progress
   任务」时返回，与阻塞在 `wait_for_work` 的空闲成员**不互等**（穷举：有任务的成员 / 无任务
   的空闲成员 / 提问成员 / 上报成员 × until 两值）。
4. **④ 重连不重放成重复派工**：构造 `wakePending` 已发、mailbox 已读的快照重放 → 无第二次
   注入、无第二个 turn（世代号 + 邮箱 ack 证据）；未读仍在的重放 → 至多一次注入。
5. **⑤ 手机远控同一语义**：`web-remote-replayable` 快照恢复后 `wakeHint` 与桌面
   `teamPanelModel` 同结论；远控下队长空闲被唤醒的行为一致（同一 core 路径，不另起会话）。
6. **⑥ 已停成员显式「需重派」**：成员子会话终态 → 投影给 `member_stopped` 提示 +
   `redispatchStoppedMember` 动作（宿主可执行）；`peer-send-paths.ts:285` 语义不变
   （peer 消息仍拒绝、无 resume 副作用——负向断言）。
7. **⑦ 队长已停止（选项 ②）**：队长非常驻时成员汇报 → **不** auto-resume、**不**注入；
   消息留箱不丢（mailbox 未读仍在）；投影 `wakeHint.kind = "captain_stopped"` +
   中英文案；唤醒/留箱计数可从会话日志与邮箱档读出（退出条件数据齐备）。
8. **负向组（EI-21 + EI-120 钉死）**：core `team-wake` 无 `CommandInbox` / MCP / 插件状态
   目录引用；注入路径无成员原文；`MAX_WAKE_PROMPTS` 越限后不再注入且置 hint；
   `timeoutMs` clamp 边界（0 / 负 / 超大 / 非数字）；`RuntimeCommandMode` 与
   `RuntimeInputPresentation` 两侧穷举（发送端每分支 + 接收端每 dispatch 分支）；
   `wakePending` 形状不符时 `teamPanelModel` 返回 null 不渲染半张卡。

## 实施约束与不做清单

- 新文件 ≤400 物理行（`architecture-policy.yaml` `maxFileLines`，新文件零容忍）；
  `state/store.ts`、`tools/tasks.ts` 已贴上限 → wait_for_members 放新文件
  `src/tools/member-wait-captain.ts`。core 侧 `team-wake/` 按 owner/injector/runtime-api/types 分文件。
- **不动** owner/lease 与 stale run 防护（AGENTS.md「不能仅根据单一路径删除边界判断」）；
  仅**复用**既有通知→turn 管线与 `branchGeneration` 陈旧写防护，不新建 turn 启动路径。
- **不为手机另起** Agent / Local Host / 远程会话；粗粒度唤醒仅落桌面已有 Host。
- 唤醒注入**不降级**插件 trust-wrapper（§8 第 8 条）：不内联裸原文。
- 不改 `peer-send-paths.ts:285` 语义；不把 Fynvra 的 10 个编排工具名照搬（§8 第 7 条，沿用
  `agent_teams_*` 前缀域，新增仅 1 个工具，EI-146 克制）。
- 有行为改动先补测试；负向与跨边界穷举（EI-21）、固定时钟 + 内存态隔离（EI-121）；
  gate 见根 `AGENTS.md`（`pnpm typecheck` / `lint` / `architecture:check --changed` /
  `--filter @acode/agent-teams-plugin test`）。
- 门禁诚实报告（EI-9/EI-8）：不把已有失败写成通过；不为通过削弱断言。

## 未做与取舍

1. **不做裁决点 2 选项 ①（auto-resume 复活队长）**：本批的显式否决；退出条件见 R0/裁决点
   2，数据落盘后再评估。
2. **不做 mid-turn steer 唤醒**：本批按冻结契约「回合后投」（`team-wake` 不进 active-loop
   吸收集）。留意：`task-notification`/`subagent-message` 走的 in-flight intel 路径更强，
   若实机证明「留箱到回合结束」代价过高，另批复议（不夹带）。
3. **不做 `wakePending` 的逐事件 durable 台账**：ack 复用插件既有邮箱读档 +
   `lastCaptainSeenAt`（EI-48 派生索引，不造第二份台账）。
4. **不做候选 (a) 文件 watcher**：仅登记为降级候选。
5. **不做 UI 动作的完整落地**：`teamWakeAction` 只是接口形状，按钮/交互归批次 4（验收面
   可视化）。

## 开放问题（需主 agent 裁决）

1. `RuntimeInputPresentation` 新增 `team_wake`（8 值）vs 复用 `task_notification`：本文取前者
   （语义隔离），代价是 contracts 闭集 + `formatIncomingMessage` 穷举各 +1。若主 agent 要求
   零 contracts 变更，可退回复用 `task_notification` + metadata 归属，但会污染后台任务归属。
2. 配置面节名与键名（`agentTeams.hostWake.*`）与 `enabled` 默认值（本文取 `true`）。
3. `wakeHint` 计算点：本文取 UI `teamPanelModel`（零协议新增，用既有 `sessionControl`）。
   若要求「宿主不解释插件状态」更严格，可改由 bootstrap 算好后经 additive v4 快照字段下发。
4. 成员汇报是否**同时**落 mailbox（`kind=report`）：本文取「由 `wakePending.settledTasks`
   覆盖任务终态，不新增 update_task 的 mailbox 写入」，以免成员既 RespondToCoordinator 又
   落 mail 造成双通知。

## 与方案假设不符的事实（实施核对用）

1. 方案 §3 G5「唤醒靠队长模型执行 SendMessage」只对**插件 mailbox 路径**成立；
   **core 侧已存在宿主自动唤醒**：成员 `RespondToCoordinator` → `subagent-message` 命令 →
   `drainRuntimeCommandQueue` → 空闲父会话 `executeTurnCommand` 开新 turn
   （`runtime-command-queue.ts:41/:264`、`subagent-messages.ts:27/79`）。因此 G5 的真实缺口是
   (a) 插件 mailbox 事件无宿主唤醒，(b) 队长已停止时既无唤醒也无提示（本 spec 的 R0/R8）。
2. 方案 §2/§5「复用 system-reminder 注入面」的真实落点是
   `provider-entry-origins.ts:52` 的请求投影（`incoming-message.ts` 只是文案层）——与方案
   附录 A 漂移修正第 2 条一致，本文已按真实落点写契约。
3. 方案未写明的通道在检出中**已存在**：`acode-plugin-state:` MCP logging 通知 +
   `onPluginStateNotification` + `PluginStateUpdated` → `pluginStates`。本批不需新建通道。
4. 插件 `TeamMessage` **无 kind 字段**，队长收件箱只在 `agent_teams_status` 被读；面板
   `unreadMessages` 截断 400 字符 + 上限 20 条——不足以承载唤醒内容，故 R1 另立窄投影。
5. `subagent-pending-message-drain.md` 引用的行号（`runner.ts` 的 flush 点）与
   `peer-send-paths.ts:285` 行号实施前仍需复核（方案 §7 已声明基线漂移纪律）。