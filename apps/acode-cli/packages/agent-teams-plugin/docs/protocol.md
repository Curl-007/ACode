# AgentTeams 协议参考（工具语义）

面向人类读者与 skill 引用的完整工具语义。模型运行时直接读工具 description；
本文是权威快照。

## 总则

- 所有工具返回 `{ ok, …业务字段, next_actions? }`；失败返回
  `{ ok: false, error: { code, message, data? } }`（MCP isError=true）。
- 调用者身份由 ACode 注入的 `_meta["com.acode/request-context"]` 推导
  （宿主侧实现：`adapters/src/mcp/index.ts` 的 `mcpRequestMeta`，扁平键与命名空间键双发）：
  `runtime_scope: "main"` → 队长（须 team.captainSessionId 匹配）；
  `"subagent"` → 成员（须名册绑定）。手动 JSON-RPC 冒烟可传 `caller: {name, role}`
  降级，返回值带 `identity_degraded` 警告。
- 团队状态根：`<workspace>/.agent-teams/`（userConfig `stateDir` 可覆盖）。
- 每个 workspace 同时只有一个活跃团队（draft/active/paused）。

## 队长工具（10）

| 工具 | 语义 |
| --- | --- |
| `agent_teams_create` | 建团队（默认 draft 审批制；`approval: "automatic"` 直接 active）。返回 protocol 首步指令与 panel_url。 |
| `agent_teams_approve_plan` | draft→active；要求名册与任务非空；`confirmation` 记录用户批准原话。返回首批派工指令。 |
| `agent_teams_status` | 队长/成员双视角全量状态 + next_actions。被唤醒后第一件事。 |
| `agent_teams_add_member` | 登记成员（不 spawn）；返回 spawn_instruction（Agent 工具参数包）。超 maxMembers 拒绝。 |
| `agent_teams_bind_member` | 把 Agent 工具返回的 agentId 回填名册。agentId 跨成员重复拒绝。未 bind 不派工。 |
| `agent_teams_remove_member` | 安全移除：未完成任务回收 unassigned，名册标记 removed，历史保留。 |
| `agent_teams_create_task` | 建 DAG 节点。依赖必须存在、不成环；paused 团队拒绝。 |
| `agent_teams_amend_task` | 修订 objective/acceptance/notes；写 revisions 台账；质量任务开跑后 acceptance 冻结。 |
| `agent_teams_reassign_task` | 原子重派/队长接管（`assignee: "captain"`）：旧 attempt 失效，任务回 todo。**只用于换人与队长接管**——驳回返工走 `agent_teams_send_message`。重派次数达 `maxReassignRounds`（默认 3）后返回 `reassign_limit_exceeded`。 |
| `agent_teams_delete` | 结束团队。默认归档（任务/DAG/邮箱全部保留到 archives/）。 |

## 成员工具（4，队长亦可用）

| 工具 | 语义 |
| --- | --- |
| `agent_teams_claim_task` | 依赖校验后原子认领；每成员同时最多 1 个 in_progress；返回 attempt_id。 |
| `agent_teams_update_task` | 携 attempt_id 更新（陈旧 attempt 拒绝）；done 需 verify（有验收标准时）；failed/blocked 需对应理由；同 attempt 幂等。 |
| `agent_teams_send_message` | from 由身份推导不可伪造；消息 ≤16KB 落收件人邮箱。 |
| `agent_teams_status` | 成员视角：当前任务 + 可认领 + 未读消息全文（读即置已读）。 |

## next_actions 结构

```jsonc
{
  "wake": [ { "to": "agent_xxx", "member": "dev-1", "taskId": "t-2",
              "message": "任务 t-2 已就绪…（含验收标准全文）" } ],
  "notes": ["诊断与提示"],
  "report_to_captain": true|false
}
```

- `wake` 由状态机纯派生，无副作用；漏执行只延迟不破坏一致性。
- **纯派生、无副作用、不记得上一批**：每次工具调用都重新计算；漏执行只延迟不破坏一致性，
  但**不要**把它当进度条反复调（每次调用都是一次完整推理）。
- 队长协议要求对 wake 逐条原样 SendMessage（消息不得转述/省略）。

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

## 恢复

- 冷恢复：磁盘即真相；队长会话恢复后 status 自动引导（lock 残留按 5s stale 接管）。
- 悬空 attempt（in_progress 长期无更新）：status 标注，队长 reassign 或接管。
- server 崩溃：宿主重建 MCP 连接，状态无损。
