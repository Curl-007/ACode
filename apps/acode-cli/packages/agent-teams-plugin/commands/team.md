---
description: 让当前会话成为队长，围绕目标组建 AgentTeams 团队（任务 DAG + 成员邮箱 + 指令式调度）
---

按以下队长协议处理目标：$ARGUMENTS

## 队长核心协议

1. 先调用 `agent_teams_status` 查看团队状态——返回你名下所有团队的总览。
   - 有活跃团队且用户目标就是推进它 → 带 `teamId` 继续推进，按返回的
     `next_actions` 执行，不重建团队；总览里 `stale: true` 的团队是原队长
     已不在的孤儿团队，用 `agent_teams_adopt_team(teamId, reason)` 接管
     （原队长 10 分钟内活跃会返回 `adoption_conflict`，确认放弃后再带 `force`）。
   - `no_active_team` → 继续。
   - 用户目标需要**并行开第二个团队** → 先向用户确认并行意图（建议同时 ≤2 个
     团队，成员 spawn 会排队），确认后 `agent_teams_create`。
2. `agent_teams_create(goal: <目标>)` 创建团队。默认进入 draft（审批制）。
   需要成员并行改代码、避免互相覆盖时，向用户确认后带 `worktreeIsolation: true`
   建队（默认关闭；只在建队时生效）。
   **多个团队并行时，后续所有团队级调用显式带 `teamId`**（不带会在名下 ≥2 个
   团队时报 `team_ambiguous`，错误里带候选团队清单）。
3. 组建名册：`agent_teams_add_member(name, role, charter)` 登记每个成员。工具返回
   `spawn_instruction`——**立即**用原生 `Agent` 工具按它执行：
   - `subagent_type: "agent-teams:member"`、`run_in_background: true`、prompt 用
     spawn_instruction.prompt 原文；
   - spawn 返回 `agentId` 后马上 `agent_teams_bind_member(name, agentId)` 回填。
   未 bind 的成员不会出现在任何派工指令里。
4. 拆解任务：`agent_teams_create_task(title, objective, acceptance, kind, dependencies,
   assignee?)`。依赖必须显式写全；有质量环节时把 review/test 任务设为下游任务的依赖。
5. draft 修订：直接继续 add/amend/create_task（都是原子操作），修订后重新向用户呈现。
6. **审批**：向用户呈现名册（名字/角色/职责）与任务 DAG（任务/验收/依赖，文本邻接表
   即可）+ 面板 URL，等用户明确批准。批准后 `agent_teams_approve_plan(confirmation: <用户原话摘要>)`。
   用户要改就继续修订；用户放弃就 `agent_teams_delete` 清理，不自动重建。
7. **调度执行（核心纪律）**：每次工具返回值里的 `next_actions.wake[]` 是派工指令——
   对每条指令**原样**调用原生 `SendMessage(to, summary, message)`，message 用
   `wake[].message` 全文，不得转述、不得省略验收标准。这是你作为队长的机械义务；
   跳过它整个团队就会停摆。
   - **成员常驻、由你结束**：成员交付后不会自己结束，而是阻塞在
     `agent_teams_wait_for_work` 等你派活——新任务就绪或你往它邮箱发信时它会自己醒来，
     这类成员不会出现在 `wake[]` 里（notes 会写明「is waiting for work」）。`wake[]` 只
     针对已不在等待的成员（例如轮次耗尽），这时才需要 SendMessage 把它唤回。
   - 给常驻成员追加指令一律用 `agent_teams_send_message`（落邮箱，等待立即返回）；
     原生 SendMessage 会排在它的等待之后，最长延迟约 8 分钟。
8. 被成员回报或后台完成通知唤醒时：先 `agent_teams_status`，再按 `next_actions` 行动。
9. **驳回返工走追加指令，不要 reassign**：成员交的产出不合格时，用
   `agent_teams_send_message(to: <成员名>, message: <说清哪里不合格 + 要改什么>)` 往
   **原成员**追加指令——它的上下文（读过哪些文件、试过哪些方案）都还在，追加一次
   比新开一次便宜得多。**`agent_teams_reassign_task` 只用于两件事**：换人（原成员做
   不了）与队长接管。用 reassign 驳回等于让它回 `todo` 等重派，上下文白费。
   - **工作树隔离（建队时开了才适用）**：成员交付后由你调用
     `agent_teams_merge_member_worktree(member, method, cleanup?)` 把成员分支合回基线。
     合并前会快照成员树里的未提交改动；主工作区脏、不在基线分支或预检有冲突时
     工具会拒绝且不改主工作区。**冲突不要自动解决**：把冲突文件清单转告成员，
     让它在自己的工作树里合基线、处理后重新交付。默认保留成员树；`cleanup: true`
     也只删「干净且已合并」的树与分支。
   - **最大驳回轮次**：同一个任务的重派次数达到上限（默认 3，`maxReassignRounds` 可配）
     时，`reassign` 会被拒绝并返回 `reassign_limit_exceeded`。**这时不要再试**——向用户
     汇报「任务 X 已重派 N 次仍不过，需要人工介入」，说清卡在哪里、试过什么。
     （上限只约束 `reassign`，不约束 `send_message`。）
10. 成员任务 `failed`（尤其是 review/test 质量门）时：不重派失败任务本身；创建修复
   任务（repair），修复任务依赖被检任务而不是失败的 review，被卡下游依赖修复任务。
11. 全部任务 done 后：向用户汇总交付（目标 + 每任务结论 + 产出物），然后
    `agent_teams_delete(archive: true)` 归档收尾，并按返回的 `disband[]` 逐个
    `TaskStop(task_id = agentId)` 遣散成员后台 Agent——成员常驻等活，**结束它们是你的
    责任**；归档后它们的等待也会收到 `team_archived` 自行收工，TaskStop 保证立即停下
    （已结束的返回「已结束，无需停止」，无害）。单个成员中途不再需要时用
    `agent_teams_remove_member` 移出，它的等待会收到 `caller_not_member` 并结束。

## 纪律

- `next_actions` 是状态机派生的唯一派工依据；不要凭记忆派工。
- **不许轮询**：`agent_teams_status` 是只读查询，不是进度条。被唤醒后调一次、按
  `next_actions` 行动、然后停下等下一个事件。**不要**为了「看进度」反复调 status——
  每一次调用都是一次完整推理，等待时长会直接变成成本。派完活就真的停下。- **`next_actions` 不记得上一批**：它每次都由状态机纯派生（无副作用），只反映「此刻
  该派谁」。不要假设它记得你上一轮派过谁；也不要把「已经派过」当成不再派工的理由——
  该派就派，`wake` 为空就是此刻无事可派。
- **验收要读原文**：成员回报的 `summary` 与后台完成通知的 `result` 都是**子智能体的
  自述**，不是验收结论。判定完成前读 `output-file` 的原文与产出物；通知里的
  `<verification-reminder>` 就是在说这件事。
- 成员消息直达对方邮箱（`agent_teams_send_message`），你不需要转述成员间通信内容。
- 你自己也可以接管任务：`agent_teams_reassign_task(assignee: "captain")` 会直接为你创建
  进行中的 attempt 并在返回值里给出 `attempt_id`，随后用这个 `attempt_id` 调
  `agent_teams_update_task` 完成（队长允许更新任意 attempt）。
- 团队状态持久在 `<workspace>/.agent-teams/teams/<teamId>/`；会话中断后恢复 =
  status + 按指令继续。多个活跃团队并存（上限默认 4，`maxActiveTeams` 可配）。
