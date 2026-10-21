---
name: agent-teams
description: AgentTeams 多智能体协作协议——把当前会话升级为队长，组建可续跑成员团队，用任务 DAG、成员邮箱与指令式调度完成大型目标。当用户要求"组建团队/多 agent 协作/AgentTeams/拆解并行推进"时使用。
---

# AgentTeams：多智能体团队协作

把当前会话变成队长（captain），围绕用户目标组建团队：成员是可续跑的
`agent-teams:member` 子代理，任务带依赖（DAG），成员间经邮箱直连，调度按
`next_actions` 指令推进。适用于：一个大目标可拆成多个可并行/有依赖的任务、需要
不同角色（实现/评审/测试）协作、或需要跨多轮持续跟踪的批量工作。

## 何时用

- 用户明确要求（"用 AgentTeams"、"组个团队"）或目标规模明显超过单次 fan-out。
- 目标小（单文件修复、单问题排查）不要用团队——直接做。

## 队长协议（完整版）

调用 `/agent-teams:team <goal>` 获得同样的协议正文；要点：

1. `agent_teams_status` → 返回你名下所有团队的总览（没有团队则
   `agent_teams_create`，默认 draft 审批制）。
2. 用户目标是推进既有团队 → 带 `teamId` 继续；是开新团队 → `agent_teams_create`
   （**创建第二个团队前向用户确认并行意图**；多个团队并行时，后续所有团队级调用
   显式带 `teamId`，避免 `team_ambiguous` 歧义错误）。
3. `agent_teams_add_member` 登记 → 按返回的 `spawn_instruction` 用原生 `Agent` 工具
   spawn（`subagent_type: "agent-teams:member"`，后台运行）→ `agent_teams_bind_member`
   回填 agentId。**未 bind 的成员不会被派工。**
4. `agent_teams_create_task` 建 DAG：依赖显式；review/test 是质量门，做成下游依赖。
5. draft 完成后向用户呈现名册+DAG，批准后 `agent_teams_approve_plan`。
6. 之后**机械执行**每次工具返回的 `next_actions.wake[]`：逐条
   `SendMessage(to, message=原文)`。这是队长唯一的派工动作。成员交付后常驻在
   `agent_teams_wait_for_work` 等活，新任务/邮件会让它自己醒来，不出现在 `wake[]` 里；
   `wake[]` 只针对已不在等待的成员。给常驻成员追加指令用 `agent_teams_send_message`。
7. 被唤醒（成员回报/后台通知）→ `agent_teams_status` → 按 next_actions 行动。
8. 全部完成 → 汇总交付 → `agent_teams_delete(archive: true)` → **按返回的 `disband[]`
   逐个 `TaskStop(task_id = agentId)` 遣散成员的后台 Agent**。成员不会自己结束，结束
   它们是队长的责任（已结束的成员返回「已结束，无需停止」，无害）；中途不再需要的
   单个成员用 `agent_teams_remove_member` 移出，它的等待随即收工。
9. **不许轮询**：`agent_teams_status` 只在被唤醒时调一次；不要拿它写进度循环。
   派完活就停下——等待不消耗 token，轮询消耗。
10. **`next_actions` 每次都是纯派生**，不记得上一批派工；`wake` 为空 = 此刻无事可派。
11. **驳回返工走 `agent_teams_send_message` 追加指令**（原成员上下文保留），
    `agent_teams_reassign_task` 只用于换人与队长接管；重派达上限（默认 3）会返回
    `reassign_limit_exceeded`，这时停下向用户汇报，不要重试。
12. **孤儿团队接管**：status 总览里 `stale: true` 的团队（原队长已不在）用
    `agent_teams_adopt_team(teamId, reason)` 接管后继续推进或归档；原队长 10 分钟内
    活跃时需带 `force`。建议并行团队 ≤2（成员 spawn 会排队）。

## 成员与工具速查

- 成员可见 5 个团队工具：`status` / `claim_task` / `update_task` / `send_message` /
  `wait_for_work`（阻塞等活）；队长专属工具成员调用会收到 `forbidden_for_caller`。
- 验收读原文：成员回报的 `summary` 与通知里的 `result` 都是自述，不是验收结论；
  判定完成前读 `output-file` 的原文与产出物（通知里的 `<verification-reminder>`）。
- 成员完成必须 `update_task`（attempt_id 凭据，done 需 verify 自验结果），
  然后按指令用 `RespondToCoordinator` 回报。
- 成员间消息：`agent_teams_send_message(to, message)` 直达邮箱；收件人正在等活时
  立即醒来，否则下一次唤醒时由 status 读到。消息与任务都属于某个团队：你被绑进多个团队时，团队级调用
  带 `teamId`（status 不带 teamId 会返回多团队总览）。
- 质量门失败：不重派失败 review；建 repair 任务（依赖被检任务）。
- 状态落盘 `<workspace>/.agent-teams/teams/<teamId>/`；恢复 = status 续跑。

## 面板

工具返回的 `panel_url` 是只读看板（进度/名册/DAG/邮箱）；归档后历史仍可读。

## 边界与回退

- 队长是唯一派工执行者（唤醒成员的 SendMessage 由队长发出）——next_actions 缺席
  就意味着当前无事可派，不要自创派工。
- 团队适合 3-8 个成员（默认上限 8）；更大规模先与用户确认拆分。
- 用户中途要求停止：停止执行派工指令即可（状态保持），需要彻底清理用
  `agent_teams_delete`。
