# AgentTeams 协议参考（工具语义）

面向人类读者与 skill 引用的完整工具语义。模型运行时直接读工具 description；
本文是权威快照。

## 总则

- 所有工具返回 `{ ok, …业务字段, next_actions? }`；失败返回
  `{ ok: false, error: { code, message, data? } }`（MCP isError=true）。
- 调用者身份由 AnkerCode 注入的 `_meta["com.acode/request-context"]` 推导
  （宿主侧实现：`adapters/src/mcp/index.ts` 的 `mcpRequestMeta`，扁平键与命名空间键双发）：
  `runtime_scope: "main"` → 队长（须 team.captainSessionId 匹配）；
  `"subagent"` → 成员（须名册绑定）。手动 JSON-RPC 冒烟可传 `caller: {name, role}`
  降级，返回值带 `identity_degraded` 警告。
- 团队状态根：`<workspace>/.agent-teams/`（userConfig `stateDir` 可覆盖），
  布局为 `teams/<teamId>/{team.json, tasks/, mailbox/}` + 根级 `lock`/`panel.json`/`archives/`。
- 每个 workspace 允许**多个**同时活跃的团队（draft/active/paused），
  上限 `maxActiveTeams`（默认 4，1~8）。配 1 即复刻旧单团队行为。

### 队长协议（协调者只读预设）

宿主（ACode 会话）按团队协议把**队长会话**的文件写工具（`Write`/`Edit`/`ApplyPatch`）
置为只读：任一被判定为活跃团队 `captainSessionId` 的会话，写工具一律被拒
（ruleId `rule.coordinator.readonly`），拒绝文案中性并指引「把变更派给成员」。只读工具、
Bash、Agent/团队工具不受影响。据此的协议约定：

- 队长不接管任务改代码：`agent_teams_reassign_task(assignee: "captain")` 被拒绝；
  变更一律派给成员，追加指令走 `agent_teams_send_message`。
- **残余面（如实登记）**：Bash 的写向（重定向 / `node -e`）未封锁——本预设防失误，
  不防注入；只读审查命令面（`git diff`/`log` 等）刻意保留。
- 逃生阀：插件 userConfig `captainReadOnly`（默认 `true`）；显式设为 `false` 时不施加
  预设，队长按常规权限判定。这**不**放松策略地板 / 项目 deny / 熔断器。

### 角色能力包引用（`roleRef`，0.6.0 additive）

- `agent_teams_add_member` 可选 `roleRef` = 成员 spawn 用的宿主 AgentProfile 名（即原生
  `Agent` 工具的 `subagent_type` 取值）——角色能力（提示词 / Skills / MCP / 模型 / 思考档 /
  工具策略 / 审批档）由该 profile 提供。缺省 = 插件默认成员 profile `agent-teams:member`。
- **插件只存不透明标识**：不解释 profile 内容、不校验是否存在（零 core 依赖）。解析责任在
  宿主派发边界；**未命中由宿主 `Agent` 工具 fail loudly**（`UNKNOWN_AGENT_TYPE`，列出可用
  类型）。插件**没有**「解析不到就改用默认成员类型」的分支——不要静默回退，向用户报告。
- **形状约束**：1–64 字符，`[A-Za-z0-9]` 起头，其余限 `[A-Za-z0-9._:-]`（拒空白/换行/
  控制字符）；不合形状 → `invalid_input`，**不登记成员、不建工作树**（明确未执行）。
- **成员 profile 必须自带 `plugin:agent-teams:team` MCP**，否则被 spawn 的成员调不到团队
  工具（无法 status/claim/回报）。插件不校验这一点（做不到），由队长/用户选定 `roleRef` 前负责。
- **live-refresh 沿派生配置链**（`agent-teams-derived-config.md` R5/R7）：引用的 profile 由
  宿主在**每次新派生**时重读，下一次 spawn 即生效；**已运行的成员不换 profile**——换角色走
  `remove_member` → `add_member` → 重新 spawn。插件不缓存 profile 内容、不做文件 watcher。
- 引用用**稳定 id**（profile 名）作键；`role`/`charter` 是显示的文本标签，改名不影响引用
  （EI-144）。`agent_teams_status` 原样回成员对象（含 `roleRef`）；面板快照 `members[].roleRef`
  为 additive（缺席 = 未指定）。

### 团队寻址（0.2）

所有团队级工具新增可选参数 `teamId`。解析顺序：

1. 显式 `teamId` → 必须是活跃团队（否则 `team_not_found`）。
2. 未传：
   - 调用方参与的活跃团队恰好 1 个 → 隐式选中（单团队旧流程 100% 兼容）；
   - 0 个 → `no_active_team`（subagent 未绑定名册时为 `caller_not_member`）；
   - ≥2 个 → `team_ambiguous`，`data.candidates` 列出团队
     （`agent_teams_status` 例外：返回多团队总览）。

「调用方参与的团队」：main 会话 = `captainSessionId` 匹配的团队（含 adopt 后的）；
subagent 会话 = 名册中存在按 `sess_subagent_<agentId>` 派生会话绑定的成员的团队。

## 队长工具（16）

| 工具 | 语义 |
| --- | --- |
| `agent_teams_create` | 建团队（默认 draft 审批制；`approval: "automatic"` 直接 active）。活跃团队数达 `maxActiveTeams` 时返回 `team_limit_exceeded`。`worktreeIsolation: true` 开启成员工作树隔离（默认关闭）。返回 protocol 首步指令与 panel_url。 |
| `agent_teams_approve_plan` | draft→active；要求名册与任务非空；`confirmation` 记录用户批准原话。返回首批派工指令。 |
| `agent_teams_status` | 队长/成员双视角全量状态 + next_actions。被唤醒后第一件事。多团队且不带 teamId 时返回总览（各团 counts/myRole/stale/next_actions）。 |
| `agent_teams_adopt_team` | 接管孤儿团队：main scope 把 draft/active/paused 团队的 `captainSessionId` 改为调用会话，记 `captainHistory` 台账。原队长 10 分钟内活跃（`lastCaptainSeenAt`）且未传 `force` 时返回 `adoption_conflict`。 |
| `agent_teams_add_member` | 登记成员（不 spawn）；可选 `roleRef` 指定成员 spawn 用的宿主 AgentProfile（缺省 = 插件默认成员 profile `agent-teams:member`，见「角色能力包引用」）；返回 spawn_instruction（Agent 工具参数包）。超 maxMembers 拒绝。 |
| `agent_teams_bind_member` | 把 Agent 工具返回的 agentId 回填名册。agentId 跨成员重复拒绝。未 bind 不派工。 |
| `agent_teams_remove_member` | 安全移除：未完成任务回收 unassigned，名册标记 removed，历史保留。 |
| `agent_teams_create_task` | 建 DAG 节点。依赖必须存在、不成环；paused 团队拒绝。任务编号 t-N 团队内自增。 |
| `agent_teams_amend_task` | 修订 objective/acceptance/notes；写 revisions 台账；质量任务开跑后 acceptance 冻结。 |
| `agent_teams_reassign_task` | 原子重派 / **打回**（`assignee: <成员名>`）：旧 attempt 失效，任务回 todo，并追加一条 `TaskRevision`（fields `["status","assignee"]`）；可从 `in_progress` / `in_review` / `failed` / `blocked` 发起（`in_review` 即「验收不通过 → 打回」，worktree 保留）。`assignee: "captain"` 被拒绝（撤销队长自助接管，见「队长协议」）；重派次数达 `maxReassignRounds`（默认 3）后返回 `reassign_limit_exceeded`。**只用于换人或打回**——补要求不返工走 `agent_teams_send_message`。 |
| `agent_teams_delete` | 结束团队。默认归档（任务/DAG/邮箱全部保留到 archives/）。未完成任务（todo/in_progress/in_review/blocked）随 `pending_tasks` 显式列出（`in_review` 视为未完成）。开启工作树隔离时先按保守判据清理成员树，结果随 `worktrees` 返回。 |
| `agent_teams_merge_member_worktree` | 队长专属。把成员工作树分支合回基线（`merge`/`squash`）；先快照成员树未提交改动；脏主工作区、非基线分支、冲突一律拒绝且不改主工作区；无独有提交返回 `already_merged`；`cleanup: true` 只清干净且已合并的树。**合并即验收**：成功后该成员名下 `in_review` 任务一次性 `done`，随 `accepted_tasks` 列出（空则附显式 note）；`already_merged` 同样执行验收耦合。 |
| `agent_teams_review_member_diff` | 队长专属。审成员交付：钉住 `baseCommit`（默认建树提交，**不是**主仓库当前 HEAD）与 `headCommit`（默认成员分支 tip，可显式传旧 `headRef` 复核已固定交付）；返回有界文件清单 / `--stat` / 补丁文本（`statOnly: true` 省略补丁）。任一段超限**整段丢弃** + `truncated`/`desync`。锚定成员的 `in_review` 任务；无则 `stale_attempt`。 |
| `agent_teams_run_checks` | 队长专属。执行成员在 `verify` 中用 `$ ` 逐字声明过的命令（cwd 钉成员工作树；无 shell；8 分钟超时；单流输出 ≤256KiB 超限整段丢弃）。未声明 / 不精确匹配 → `verify_required` 且**不执行**；token 含 shell 元字符 / 通配 → `invalid_input`。超时返回 `ok:true + timedOut:true`。调用计数与最近结果落团队 JSON。 |
| `agent_teams_accept_task` | 队长专属。**显式验收**：把 `in_review` 任务落 `done` 并记一条「谁验收」revision。**仅非隔离团队**（无合并入口）使用；隔离团队的验收与合并耦合，本工具拒绝（避免第二条验收语义）。验收标准在 `in_review` 期间冻结。 |
| `agent_teams_wait_for_members` | 队长专属。阻塞等成员事件，替代空转轮询。事件集与宿主唤醒投影同源：队长邮箱未读 / 成员名下任务进终态（done/failed/blocked）/ 成员 `in_review` 汇报。`until:"any"`（默认）首个事件即返回；`until:"all"` 仅当「无成员任务 in_progress 且无队长未读」时返回（写死为「无进行中任务」而非「所有成员已汇报」——没有任务的成员永不汇报，后者会与阻塞在 `wait_for_work` 的空闲成员互等死锁）。成员 `kind:question`/`escalation` **无论 until 取值立即返回**（防提问者 ↔ 等待队长互等）。`timeoutMs` clamp 到 [1s, 8min]（默认 5min），约 8 分钟无新事件返回 `timedOut:true`——**不是错误**，再调继续等。返回 `unread_messages`（读边界包装）、`settled_tasks`、`waiting_members`、`counts`（含 `inProgressMemberTasks`）；**读信即置已读**。等待期间在团队 JSON 记 `captainWaitingUntil`（additive）。 |

### 宿主唤醒投影（wakePending，additive）

插件在面板快照上带一个有界、自算的待唤醒窄投影 `TeamPanelState.wakePending`（宿主
core `runtime/team-wake` 按形状收窄；teamId 取 `TeamPanelState.teamId`，投影本身不含
teamId）：`generation`（= 团队 `wakeSeq`，**仅成员来源**的邮箱投递与任务终态/汇报递增，
队长读信不递增）、`captainSessionId`、`messages`（队长邮箱未读 + 成员 `in_review` 汇报，
按投递序升序，≤8，正文永不内联）、`settledTasks`（成员名下 done/failed/blocked 且晚于
`lastCaptainSeenAt`）、`triggers`（⊆ `message`/`settled_task`/`question`/`escalation`）、
`counts`。缺席或触发集空 = 宿主零行为。**`in_review` 不算已结算**：成员汇报经 `messages`
（`kind=report`）与 `message` trigger 呈现，宿主据此唤醒队长处理「待验收」。

## 工作树隔离（SPEC-015，默认关闭）

- `agent_teams_create(worktreeIsolation: true)` 才开启；建队时解析仓库并记录
  `repoRoot` / `baseBranch`，非 git、无提交、detached HEAD 直接返回
  `worktree_unavailable`（不建团队、不回落共享工作区）。
- 开启后 `agent_teams_add_member` 为每个成员建
  `<repoRoot>/.acode/worktrees/team-<id>-<member>-<8hex>`，分支
  `acode/wt/team-<id>-<member>-<8hex>`；建树失败不登记成员。
- 派工消息、成员 `status` 的 `worktree` 字段都带路径/分支/基线。插件不能设置子代理
  cwd，成员须按提示使用工作树绝对路径（强隔离待宿主支持，见 spec §8 P-1）。
- 队长合并：`agent_teams_merge_member_worktree(member, method, cleanup?)`
  - **合并即验收**：成功后该成员 `in_review` 任务一次性 `done`（`accepted_tasks` 列出）；
  - 先把成员树未提交改动快照提交到成员分支；
  - 主工作区脏 / 不在基线分支 / 有冲突 → 结构化错误，主工作区不变；冲突时任务**留在 `in_review`**；
  - 冲突不自动解决；`method: "merge"`（默认，`--no-ff`）或 `"squash"`；
  - 分支无独有提交 → `already_merged`（幂等，且同样执行验收耦合）；
  - `cleanup: true` 只删「干净且已合并」的树与分支（`branch -d`，绝不用 `-D`）。
- 团队结束 / 成员移除时自动尝试清理；未合并提交、未提交改动、非 `acode/wt/` 归属、
  成员仍有未完成任务（`in_progress` **或** `in_review`）的一律保留并在 `keptReason` 说明。

## 成员工具（5，前 4 个队长亦可用）

| 工具 | 语义 |
| --- | --- |
| `agent_teams_claim_task` | 依赖校验后原子认领；每成员每团队同时最多 1 个 in_progress（`in_review` 不算占用，可接着认领）；返回 attempt_id。 |
| `agent_teams_update_task` | 携 attempt_id 更新（陈旧 attempt 拒绝）；`done` 是**汇报**，落 `in_review`（待验收，非终态），需带 verify（有验收标准时）；`verify` 里用 `$ ` 行写可执行命令；failed/blocked 需对应理由；同 attempt 幂等。 |
| `agent_teams_send_message` | from 由身份推导不可伪造；消息 ≤16KB 落收件人邮箱。可选 `kind`（`report`/`question`/`escalation`/`note`，缺省 `note`）标注语义：被阻塞要答复用 `question`、需用户决策/权限的风险用 `escalation`、常规完成汇报用 `report`；宿主据它收窄唤醒触发集。 |
| `agent_teams_status` | 成员视角：当前任务 + 可认领 + 未读消息全文（读即置已读）。 |
| `agent_teams_wait_for_work` | 仅成员。阻塞等活：有进行中任务 / 可认领任务 / 未读邮件时返回 `ready:true`；约 8 分钟无事返回 `ready:false`（再调继续等）。团队归档报 `team_archived`、被移出名册报 `caller_not_member`——成员据此收工。等待期间在名册上记 `waitingUntil`。 |

### 成员生命周期：常驻，由队长结束

- 成员交付（update_task + RespondToCoordinator 回报）后**不结束自己的后台 Agent**，
  而是调 `agent_teams_wait_for_work` 等下一件活；团队进行中不自行结束本轮。
- 结束成员是队长的事：归档团队（等待随即收到 `team_archived`）+ 按 `disband[]` TaskStop；
  或 `agent_teams_remove_member` 单独移出（等待收到 `caller_not_member`）。
- 调度器对 `waitingUntil` 未过期的成员不出 wake（notes 注明 is waiting for work），避免
  SendMessage 排在等待之后造成重复派工；过期（成员已结束、轮次耗尽）才回到 SendMessage 唤醒。
- 等待不持有 server 互斥锁（`manageOwnLock`）：锁内探测一次、锁外睡 2s 循环，上限小于
  `.mcp.json` 的 600s 工具超时。

## next_actions 结构

```jsonc
{
  "wake": [ { "to": "agent_xxx", "member": "dev-1", "teamId": "team-a1", "taskId": "t-2",
              "message": "团队 team-a1：任务 t-2 已就绪…（含验收标准全文）" } ],
  "notes": ["诊断与提示"],
  "report_to_captain": true|false
}
```

- `wake` 由状态机纯派生，无副作用；漏执行只延迟不破坏一致性。
- **纯派生、无副作用、不记得上一批**：每次工具调用都重新计算；漏执行只延迟不破坏一致性，
  但**不要**把它当进度条反复调（每次调用都是一次完整推理）。
- 队长协议要求对 wake 逐条原样 SendMessage（消息不得转述/省略）。多团队总览的 wake
  平铺后每条自带 teamId。

## 任务状态机

```text
todo --claim--> in_progress --update_done--> in_review --accept--> done
                    |                             |
                    |update_failed/update_blocked  |reassign（验收不通过：打回）
                    v                             v
              failed | blocked                   todo
todo --cancel--> cancelled
（简表便于阅读；实现以 state/machine.ts 为唯一事实源，测试穷举全部 (from, action)）
```

- **汇报 ≠ 验收**：`in_progress --update_done--> in_review` 是成员汇报；`in_review` 是非终态。
- **`in_review --accept--> done` 只有两个触发者**：隔离团队的合并工具（合并即验收），
  或非隔离团队的 `agent_teams_accept_task`。不存在「未经验收的 done」。
- `in_review` 出边只有 `accept` / `reassign` / `update_failed`（穷举钉死）；`in_review`
  期间验收标准冻结（`acceptance_frozen`）。
- `in_review` **不解锁下游依赖**（`dag.dependencySatisfied` 只认 `done`），也不让成员
  被视为忙碌（可继续认领新活）。
- 读到未知任务状态（外来 / 未来版本写入）→ 结构化 `invalid_input`（fail loudly），
  不静默当成 `todo`。
- 质量门（review/test）failed/blocked **不解锁**下游；下游调度 notes 会提示建
  repair 任务（依赖被检任务而非失败的 review）。
- attempt 链：认领时生成（seq+uuid）；reassign/移除成员使旧 attempt 失效；
  update 必须持当前 activeAttemptId。
- 任务编号 `t-N` 团队内唯一：两个团队各有 `t-1` 是合法状态，寻址由 teamId 消歧。

### 驳回语义（重要）

两条通道分工（批次 1 起）：

- **补要求、不返工 → `agent_teams_send_message` 往原成员追加指令**（保留上下文）：
  - 成员在跑 → 消息以 `guide` 投递进它当前的 turn（`message-steering.ts`）；
  - 成员已结束 → 恢复它的子会话后台续跑（`resumeTerminalAgentInBackground`），上下文保留。
- **验收不通过 → 打回 → `agent_teams_reassign_task(assignee: <原成员>)`**（从 `in_review`
  发起）：旧 attempt 失效、回 `todo`、写一条打回 revision，**worktree 保留**（成员在同一棵树
  里返工，可先 `send_message` 说明原因）。这条会开一次新的权威尝试（`Σ attempts.length - 1`
  计入重派轮次），上下文不白费但仍是一次新交付。

`agent_teams_reassign_task` 也用于**换人**（原成员做不了）。它**不再用于队长接管**：
队长会话的写工具被宿主按团队协议禁用，接管了也改不了代码；`assignee: "captain"` 会被拒绝。

**最大重派轮次**：`attempts.length - 1 >= maxReassignRounds`（默认 3）时，
`reassign_task` 返回 `reassign_limit_exceeded`（`data` 带 `reassignCount` /
`maxReassignRounds` / `attempts` 明细）；队长必须停下并向用户汇报。**上限只约束
`reassign`，不约束 `send_message`**——追加指令是保留上下文的正确通道，不设上限。
打回**不当场**推进轮次（`attemptSeq` 是认领计数器）：下一次 claim 才 +1 并生成新 attempt。

### 验收纪律

1. 成员 `update_task(status: "done", verify: ...)` 汇报 → 任务落 **`in_review`**。
2. 队长先取证：`agent_teams_review_member_diff`（钉住 base/head 的提交对）+
   `agent_teams_run_checks`（只跑 `verify` 里 `$ ` 声明过的命令）。
3. 通过 → 验收：隔离团队 `agent_teams_merge_member_worktree`（合并即验收）；
   非隔离团队 `agent_teams_accept_task`。任务落 `done`，下游依赖随之放行。
4. 不通过 → `agent_teams_reassign_task` 打回（可先用 `send_message` 说明原因），
   worktree 保留供返工；同一任务重派次数受 `maxReassignRounds` 约束。

验收纪律：成员回报的 `summary` 与后台完成通知的 `result` 都是**子智能体的自述**，不是
验收结论；判定完成前读 `output-file` 的原文与产出物（通知里的 `<verification-reminder>`）。

## 多团队语义（0.2）

- 成员可被绑进多个团队：各团队独立 attempt 与邮箱；「每成员最多 1 个 in_progress」
  降为团队内约束，跨团队串行由队长调度纪律承担（建议并行团队 ≤2）。
- 多团队总览在名册成员总数超 12 时给 warn 提示。
- `updatedAt` 超过 48h 的活跃团队在总览中标注 `stale: true`（只标注，不自动归档）；
  接管用 `agent_teams_adopt_team`，放弃用 `agent_teams_delete`。

## 恢复

- 冷恢复：磁盘即真相；队长会话恢复后 status 自动引导（lock 残留按 5s stale 接管）。
- 旧平铺布局（根直接放 team.json/tasks/mailbox）在 server 启动时一次性迁移到
  `teams/<teamId>/`；迁移失败（句柄被占）启动即报结构化错误退出，不静默丢弃。
- 悬空 attempt（in_progress 长期无更新）：status 标注，队长 `reassign` 给成员（不接管）。
- 孤儿团队（队长会话已死）：新会话 status 总览可见（stale 标注）→
  `agent_teams_adopt_team` 接管 → 继续推进或归档。
- server 崩溃：宿主重建 MCP 连接，状态无损。
