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

## 队长工具（12）

| 工具 | 语义 |
| --- | --- |
| `agent_teams_create` | 建团队（默认 draft 审批制；`approval: "automatic"` 直接 active）。活跃团队数达 `maxActiveTeams` 时返回 `team_limit_exceeded`。`worktreeIsolation: true` 开启成员工作树隔离（默认关闭）。返回 protocol 首步指令与 panel_url。 |
| `agent_teams_approve_plan` | draft→active；要求名册与任务非空；`confirmation` 记录用户批准原话。返回首批派工指令。 |
| `agent_teams_status` | 队长/成员双视角全量状态 + next_actions。被唤醒后第一件事。多团队且不带 teamId 时返回总览（各团 counts/myRole/stale/next_actions）。 |
| `agent_teams_adopt_team` | 接管孤儿团队：main scope 把 draft/active/paused 团队的 `captainSessionId` 改为调用会话，记 `captainHistory` 台账。原队长 10 分钟内活跃（`lastCaptainSeenAt`）且未传 `force` 时返回 `adoption_conflict`。 |
| `agent_teams_add_member` | 登记成员（不 spawn）；返回 spawn_instruction（Agent 工具参数包）。超 maxMembers 拒绝。 |
| `agent_teams_bind_member` | 把 Agent 工具返回的 agentId 回填名册。agentId 跨成员重复拒绝。未 bind 不派工。 |
| `agent_teams_remove_member` | 安全移除：未完成任务回收 unassigned，名册标记 removed，历史保留。 |
| `agent_teams_create_task` | 建 DAG 节点。依赖必须存在、不成环；paused 团队拒绝。任务编号 t-N 团队内自增。 |
| `agent_teams_amend_task` | 修订 objective/acceptance/notes；写 revisions 台账；质量任务开跑后 acceptance 冻结。 |
| `agent_teams_reassign_task` | 原子重派/队长接管（`assignee: "captain"`）：旧 attempt 失效，任务回 todo。**只用于换人与队长接管**——驳回返工走 `agent_teams_send_message`。重派次数达 `maxReassignRounds`（默认 3）后返回 `reassign_limit_exceeded`。 |
| `agent_teams_delete` | 结束团队。默认归档（任务/DAG/邮箱全部保留到 archives/）。开启工作树隔离时先按保守判据清理成员树，结果随 `worktrees` 返回。 |
| `agent_teams_merge_member_worktree` | 队长专属。把成员工作树分支合回基线（`merge`/`squash`）；先快照成员树未提交改动；脏主工作区、非基线分支、冲突一律拒绝且不改主工作区；无独有提交返回 `already_merged`；`cleanup: true` 只清干净且已合并的树。 |

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
  - 先把成员树未提交改动快照提交到成员分支；
  - 主工作区脏 / 不在基线分支 / 有冲突 → 结构化错误，主工作区不变；
  - 冲突不自动解决；`method: "merge"`（默认，`--no-ff`）或 `"squash"`；
  - 分支无独有提交 → `already_merged`（幂等）；
  - `cleanup: true` 只删「干净且已合并」的树与分支（`branch -d`，绝不用 `-D`）。
- 团队结束 / 成员移除时自动尝试清理；未合并提交、未提交改动、非 `acode/wt/` 归属、
  成员仍有进行中任务的一律保留并在 `keptReason` 说明。

## 成员工具（5，前 4 个队长亦可用）

| 工具 | 语义 |
| --- | --- |
| `agent_teams_claim_task` | 依赖校验后原子认领；每成员每团队同时最多 1 个 in_progress；返回 attempt_id。 |
| `agent_teams_update_task` | 携 attempt_id 更新（陈旧 attempt 拒绝）；done 需 verify（有验收标准时）；failed/blocked 需对应理由；同 attempt 幂等。 |
| `agent_teams_send_message` | from 由身份推导不可伪造；消息 ≤16KB 落收件人邮箱。 |
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
todo --claim--> in_progress --update--> done|failed|blocked
 ^                    |reassign
 +---- reassign <-----+（todo/failed/blocked 均可重派；done/cancelled 终态封闭）
todo --cancel--> cancelled
```

- 质量门（review/test）failed/blocked **不解锁**下游；下游调度 notes 会提示建
  repair 任务（依赖被检任务而非失败的 review）。
- attempt 链：认领时生成（seq+uuid）；reassign/移除成员使旧 attempt 失效；
  update 必须持当前 activeAttemptId。
- 任务编号 `t-N` 团队内唯一：两个团队各有 `t-1` 是合法状态，寻址由 teamId 消歧。

### 驳回语义（重要）

驳回返工**走 `agent_teams_send_message` 往原成员追加指令**，不走 `reassign`：

- 成员在跑 → 消息以 `guide` 投递进它当前的 turn（`message-steering.ts`）；
- 成员已结束 → 恢复它的子会话后台续跑（`resumeTerminalAgentInBackground`），上下文保留。

`agent_teams_reassign_task` 只用于**换人**与**队长接管**。它的语义是「失效当前 attempt →
回 `todo` → 重新派工」，会让原成员的上下文白费。

**最大重派轮次**：`attempts.length - 1 >= maxReassignRounds`（默认 3）时，
`reassign_task` 返回 `reassign_limit_exceeded`（`data` 带 `reassignCount` /
`maxReassignRounds` / `attempts` 明细）；队长必须停下并向用户汇报。**上限只约束
`reassign`，不约束 `send_message`**——追加指令是保留上下文的正确通道，不设上限。

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
- 悬空 attempt（in_progress 长期无更新）：status 标注，队长 reassign 或接管。
- 孤儿团队（队长会话已死）：新会话 status 总览可见（stale 标注）→
  `agent_teams_adopt_team` 接管 → 继续推进或归档。
- server 崩溃：宿主重建 MCP 连接，状态无损。
