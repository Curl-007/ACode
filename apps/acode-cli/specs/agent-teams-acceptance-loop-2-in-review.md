# AgentTeams 验收闭环（第 2/2 册：批次 1 · `in_review` 态与合并↔任务耦合）

覆盖 `docs/upgrades/orchestration-acceptance-2026-11.md` §5 的 **批次 1（G1）**：新增汇报态
`in_review`、把合并工具与任务状态耦合、打回语义、归档/暂停语义、存量兼容裁决、agent-facing
文档同步与面板投影。**批次 M0 与批次 0（度量基线 + 验收工具面）见第 1 册
`agent-teams-acceptance-loop.md`**；本册依赖其中的 `review_member_diff` / `run_checks`（R1）。

分册边界 = 批次边界；第 1 册的「实施约束」「状态所有者与事件顺序」两节对本册同样生效，
本册只写差异与增量，不重复（EI-2）。

## 背景与已核实事实（本册相关）

基线同第 1 册。全部路径相对 `apps/acode-cli/packages/agent-teams-plugin/`。

| 断言 | 核实结果 |
| --- | --- |
| `state/machine.ts:15-35` TRANSITIONS 是唯一事实源；`in_progress --update_done--> done`，`done: {}` 无出边 | 属实 → 批次 1 改表 |
| `attemptSeq` 是**认领计数器**（claim / 队长接管时 `+1`：`tasks-captain.ts:94-104,237-242`）；`reassign` **从不**递增它（`:234-243`） | 属实 → 与方案字面「打回递增 attemptSeq」不符（R2.3 / OQ-3） |
| `revisions` 台账目前只由 `amend_task` 写入（`tasks-captain.ts:172`），**无任何读取方** | 属实 → 打回追加 revision 安全（R2.3） |
| `reassignCountOf = attempts.length - 1`；判定在 reassign handler 内、`assertTransition` 之前（`tasks-captain.ts:212-233`） | 属实 → 打回共享同一上限闸门 |
| `assertTransition` 直取 `TRANSITIONS[from][action]`（`machine.ts:45-54`） | 未知 `from` → `TypeError`（非结构化错误）→ R2.1 补保护 |
| `dag.dependencySatisfied` 只认 `done`（`dag.ts:36-41`） | 属实 → `in_review` 依赖天然不解锁，测试钉死 |
| `remove_member` 只回收 `in_progress` / `todo`（`members.ts:180-204`） | 属实 → `in_review` 任务会被漏掉，R2.7 补 |
| `memberHasActiveTask` 只看 `in_progress`（`worktree/lifecycle.ts:23-31`） | 属实 → 待验收 worktree 会被误清，R2.4/R2.7 补 |
| counts 有三处各自实现（`panel-state.ts:128-135`、`panel.ts:146-155`、`team-status.ts:169-176`） | 属实 → 抽单一实现（EI-2），R2.7 |

**与方案假设不符（本册相关，第 2、3 处）**：① 方案要求打回「递增 attemptSeq」，实测它是认领
计数器（见上表与 OQ-3）；② 方案未列的两个 `in_review` 消费者（`remove_member`、
`memberHasActiveTask`），不补会静默丢任务或误删待验收 worktree。

## R2.1 目标态迁移表（`src/state/machine.ts` TRANSITIONS，唯一事实源）

`TaskStatus` 增 `in_review`；`TaskAction` 增 `accept`。`TERMINAL_TASK_STATUSES` 与
`isTaskTerminal` **不含** `in_review`。

```text
todo --claim--> in_progress        todo --reassign--> todo        todo --cancel--> cancelled
in_progress --update_done--> in_review      （汇报 ≠ 验收）
in_progress --update_failed--> failed       in_progress --update_blocked--> blocked
in_progress --reassign--> todo
in_review --accept--> done                  （唯一触发者：合并工具成功）
in_review --reassign--> todo                in_review --update_failed--> failed
failed --reassign--> todo          blocked --reassign--> todo
done: {}    cancelled: {}                   （真终态，无出边）
```

- `in_review` **不接受** `claim` / `cancel` / `update_done` / `update_blocked`（穷举钉死）。
- 工具层不得旁路改状态：全部经 `assertTransition`。`assertTransition` 追加保护——
  `TRANSITIONS[from]` 不存在（未知/外来 status 值）时抛结构化 `invalid_input`，而不是
  `TypeError`（fail loudly，见 R2.5）。
- `dag.dependencySatisfied` 只认 `done` → `in_review` 依赖**不解锁**下游（验收通过才放行），
  由测试钉死。

## R2.2 合并触发验收（`src/tools/worktree.ts`）

`agent_teams_merge_member_worktree` 成功后，在**同一 `store.withLock` 段内**（`worktree.ts:61`
的既有写回块）：成员名下 `status === "in_review"` 且 `(assignee === member || 最后 attempt.owner
=== member)` 的任务全部 `accept` → `done`（该成员分支的全部提交一次性验收）。

- 返回追加 `accepted_tasks: string[]`；无待验收任务时 `accepted_tasks: []` +
  `notes: ["Merged, but the member had no task awaiting acceptance."]`（EI-1 禁止静默）。
- 冲突 / 脏主工作区 / 非基线分支 → 原样拒绝，**任务留在 `in_review`**，主工作区不变
  （既有 `merge.ts:108-179` 语义不动）。
- `alreadyMerged === true`（幂等 / 崩溃窗口）**同样执行验收耦合**——沿用 `worktree.ts:60`
  「alreadyMerged 也补写记录」的先例。
- 合并成功后 `baseCommit..lastMergedCommit` 固化在 `member.worktree`，与 `accepted_tasks`
  一起回答「这活验收了吗」，**不拿主仓库当前 HEAD 代替成员提交**（对齐方案附录 B 的 Fynvra 修坑）。
- **OQ-1（阻塞，本册实现前必裁）**：`worktree_disabled` 团队（未开隔离）没有合并入口，
  `accept` 无触发者 → 任务将永久停在 `in_review`。本 spec 不擅自增设第二个触发者（冻结面：
  accept 仅由合并工具触发）；**批次 1 实现前必须裁决 OQ-1**。

## R2.3 打回（`in_review --reassign--> todo`）

`agent_teams_reassign_task` 接受 `from: in_review`：终态封闭判据（`done`/`cancelled`）不变，
名册校验不变，`maxReassignRounds` 判定不变（越界 `reassign_limit_exceeded`，`data` 带
`reassignCount` / `maxReassignRounds` / `attempts`）。写操作在**单一 reassign 写点**统一：

- 旧 attempt 收尾（`endedAt`，不写 `outcome`，与现状一致）、`activeAttemptId` 清空、`status = todo`、
  `assignee = 新 owner`；
- **追加一条 `TaskRevision { at, by: "captain", fields: ["status", "assignee"] }`**（打回审计；
  与 amend 共用同一 `revisions` 台账，不新增结构；0.4.0 只有 amend 写 revisions，此为**行为增量**，
  必须在**所有** reassign 来源上统一生效，EI-2）；
- **`worktree` 保留**（成员在同一棵树里改，对齐方案「reject_work」）；`worktree.status` 不变。
- `attemptSeq` **不在此递增**：它是认领计数器，下一次 claim 分配 `attemptSeq + 1` 并生成新
  attempt（旧 attempt 已失效 → `review_member_diff` 锚定失败报 `stale_attempt`，满足「旧尝试
  不能审新重试」）。重派轮次（`Σ attempts.length - 1`）因此在**紧接的重新认领时** +1。
  这与方案「当场递增 attemptSeq / 轮次 +1」的字面表述不同，理由与取舍见 OQ-3。
- 打回与「追加指令」的分工不变（`docs/protocol.md` §驳回语义）：改代码走 reassign（新权威尝试），
  补要求走 `agent_teams_send_message`（保上下文）。

## R2.4 归档 / 暂停语义

- `in_review` 视为**未完成**：`agent_teams_delete` 返回追加
  `pending_tasks: Array<{ taskId, status, summary? }>`，显式列出 `in_review` / `in_progress` /
  `todo` / `blocked` 任务（EI-1/EI-36：默认只删记录不删数据；归档前不静默丢弃待验收件）。
- `cleanupTeamWorktrees` 的 `memberHasActiveTask`（`worktree/lifecycle.ts:23-31`）扩为
  `in_progress` **或** `in_review` → `keptReason: "member_active"`，**待验收 worktree 不被清理**
  （EI-52：删除/清理前材料优先）。
- `agent_teams_resume` 不重建任务；paused 团队保持 `in_review` 原状（不自动 accept、不自动 cancel）。

## R2.5 存量兼容裁决

- **向前读**：旧状态 JSON 的 `TaskStatus` 值域是新值域子集 → 新版**直接可读，无需迁移**。
- **不支持向下混跑**：一旦磁盘出现 `in_review`，**旧版插件（≤0.4.0）不得再指向该 workspace**；
  `docs/usage.md` 显式声明。插件版本 `0.4.0 → 0.5.0`（`.acode-plugin/plugin.json` +
  `src/server.ts:73` + `docs/usage.md` 头部，三处）。
- **新版自身的 fail loudly**：读到未知 `status` 值（含未来值）→ 结构化错误，不静默当 `todo`
  （R2.1 的 `assertTransition` 保护 + 状态读取处的显式校验），由测试钉死。
- 面板冷恢复按 `team.seq` 差量（`TeamState.seq`），不受新增状态影响（EI-59 世代号语义不变）；
  `TERMINAL_TASK_STATUSES` 唯一消费者是 `helpers.ts` 的再导出，无需改动但其值必须保持正确。

## R2.6 幂等与崩溃窗口

- 合并已落地但状态未写盘（`alreadyMerged`）→ 重跑合并仍补写 worktree 记录**并执行验收耦合**
  （R2.2）；`store.withLock` 内读-改-写，磁盘是唯一真相（EI-40 原子写、EI-12 at-most-once）。
- `accept` 幂等：任务已在 `done` → 跳过（不重复写 revision，不重复推进）。
- `update_task` 的幂等分支（同 attempt 重复 done，`tasks-progress.ts:170-181`）继续有效，
  且 `done` 现在落到 `in_review`（幂等判定用 `attempt.outcome`，不受目标状态影响）。

## R2.7 受影响消费者清单（逐一）

| 消费者 | 现状 | 改动 |
| --- | --- | --- |
| `src/state/machine.ts` | TRANSITIONS / `isTaskTerminal` | +`in_review`、+`accept`、未知 `from` 保护 |
| `src/state/types.ts` | `TaskStatus`、`TERMINAL_TASK_STATUSES` | +`in_review`（不进终态集） |
| `src/state/dag.ts` | `dependencySatisfied` 只认 `done` | 不变（`in_review` 不放行），测试钉死 |
| `src/tools/tasks-progress.ts` | `update_done → done` | 落到 `in_review`；description 同步；`holdings` 判据保持不变（`in_review` 成员视为空闲） |
| `src/tools/tasks-captain.ts` | reassign 闭集 `done/cancelled` | 接受 `in_review`；+TaskRevision；description 同步 |
| `src/tools/worktree.ts` | 只写 worktree 状态 | +`in_review → done` 耦合 + `accepted_tasks` + 无待验收 note |
| `src/tools/team.ts` | delete 无未完成清单 | +`pending_tasks` |
| `src/tools/members.ts:180-204` | 只回收 `in_progress`/`todo` | 扩 `in_review` → 回收为 `todo` + 清 `activeAttemptId`（worktree 句柄随 `memberHasActiveTask` 新判据处理） |
| `src/worktree/lifecycle.ts:23-31` | `memberHasActiveTask` 只看 `in_progress` | 扩 `in_review`（R2.4） |
| `src/panel-state.ts` / `src/panel.ts` / `src/tools/team-status.ts` | counts 五桶，**三处各算一遍** | 抽单一 `countTasksByStatus(tasks)`（EI-2）并 +`inReview` |
| `src/scheduler.ts` / `src/tools/member-wait.ts` | busy / 当前任务只看 `in_progress` | **保持不变**（`in_review` 成员视为空闲，可接新活），测试钉死 |
| `src/tools/team-adopt.ts`、`store*.ts`、`state/store-archives.ts` | 不解释任务状态 | 不变（归档只搬文件） |

## R2.8 agent-facing 文档同步清单（同批必须完成，否则模型行为与新状态机分裂）

1. `docs/usage.md`：§2 节奏第 6 步（「全部任务 done」→ 先验收再 done）；§6 规则速查
   （`done` → `in_review`；验收由合并触发；`verify` 用 `$ ` 声明行）；§8 工作树隔离
   （合并 = 验收）；§9 故障排查（新增 `verify_required` / 停在 `in_review` / `stale_attempt`）；
   §10 已知边界；工具计数 **17 → 19**；头部版本。
2. `docs/protocol.md`：「任务状态机」块（含 `in_review` 与 `accept`）、队长工具表 +2 行、
   成员工具表（update 语义：done → 待验收）、「驳回语义」节（打回 = reassign from `in_review`
   vs 追加指令的分工）、「验收纪律」节、工作树隔离节（合并触发验收）。
3. `agents/member.md`：工作循环第 3 条（`update_task(done)` 进 `in_review`，**不是终态**）、
   `verify` 的 `$ ` 声明语法、续跑 / 被打回后在**同一 worktree** 继续。
4. `commands/team.md`：第 9 步（打回语义 + 合并即验收 + `accepted_tasks` 为空时的显式告知）、
   第 11 步（「全部任务 done」改为「全部任务验收完成」）、纪律节（`verify_required` 与
   `$ ` 声明）；**现在教模型「done 是终态」的文案全部改掉**。
5. `skills/agent-teams/SKILL.md`：镜像第 4 项的关键句（`SKILL.md:55,57` 附近）。
6. 工具 `description`（模型运行时读的是它）：`agent_teams_update_task`
   （`tasks-progress.ts:134`）、`agent_teams_reassign_task`（`tasks-captain.ts:186`）、
   `agent_teams_merge_member_worktree`（`worktree.ts:25`）、`agent_teams_amend_task`
   （`acceptance_frozen` 范围，见 OQ-6）、`agent_teams_delete`、`agent_teams_status`，
   以及第 1 册两个新工具的 description。
7. `tests/prompt-contract.test.ts`：新增关键句断言（「汇报 != 验收」「`in_review`」
   「合并即验收」「`$ ` 声明」等；只断言短语，不断言段落结构，与既有纪律一致）。

## R2.9 面板与 UI 投影

- `TeamPanelState.counts` 追加 `inReview`（additive；旧宿主缺席即 0，不构成形状不符，
  与 `readyTaskIds` 同一手法）；`totalCount` 语义随之覆盖全部任务。
- `packages/ui/src/v4/teamPanelModel.ts`（374 行，已近上限）：`counts` 收窄 + `inReview`
  （`:242-248`）、`totalCount`（`:358-363`）；`isTeamEnded`（`:172-179`）保持「非
  `done/cancelled` 即未结束」→ `in_review` **不算已结束**，由测试钉死。若本文件触上限，
  按既有拆分纪律抽叶子模块，不压缩注释（godComponentLineRatchet 只减不增）。
- `packages/ui/src/components/{TeamStatusSummary,TeamWorkflowCard,TeamTaskGraph}.tsx` +
  `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`：新增待验收分组与文案，**中英同批**（EI-107）；
  长列表分组折叠（EI-111）与空态给出路（EI-98~101）沿用既有模式。
- 投影纪律不变：宿主不解释插件状态（受检投影，形状不符返回 `null`），UI 只读，权威仍是团队 JSON
  （EI-48）；`in_review` 分组是唯一事实源上的新分区，不是第二份台账。

## 验收场景 · 批次 1（①-⑧）

测试落 `tests/machine.test.ts`（①/②）、`tests/tools.test.ts`（③-⑦）、
`tests/worktree.test.ts`（③/④）、`tests/panel-state.test.ts`（新增：counts/`isTeamEnded`）。

1. **汇报落 `in_review`**：`in_progress` 任务 `update_task(done)` → `status === "in_review"`
   **而非** `"done"`；`isTaskTerminal("in_review") === false`；依赖该任务的 `todo` 仍不可认领
   （未验收不放行）。
2. **(from, action) 穷举 + 「未合并就 done」不存在**：`machine.test.ts` 的 7 状态 × 7 动作
   （含 `accept`）全表断言；显式断言「`in_progress`/`in_review` 经 `update_done`/`accept` 之外的
   任何 (from, action) 都到不了 `done`」；未知 `from` → `invalid_input`（不是 `TypeError`）；
   `in_review` 出边只有 `accept` / `reassign` / `update_failed`（其余全 false，负向断言）。
3. **合并 → done + 提交对可查**：合并成功 → 该成员 `in_review` 任务变 `done`、`accepted_tasks`
   含其 `taskId`；`member.worktree.status === "merged"` 且 `baseCommit..lastMergedCommit` 能
   `git log` 出来（真实 git）；变体：成员**无** `in_review` 任务 → `accepted_tasks: []` +
   显式 note（EI-1），任务状态不变；变体：`alreadyMerged` 重跑 → 仍完成验收（幂等）。
4. **冲突保持 `in_review`**：制造冲突 → `worktree_conflict`、任务仍 `in_review`、
   主工作区已回滚（HEAD 与合并前一致、无 `MERGE_HEAD`），worktree 记录未写 `mergedAt`。
5. **打回**：`in_review` → `reassign` → `todo`；旧 `activeAttemptId` 清空且旧 attempt 已 `endedAt`；
   `worktree` 句柄保留（`status` 不变）；`revisions` 追加一条 captain 记录（fields 含
   `status`/`assignee`）；成员重新 claim 后 `attempts.length` +1、新 attempt id ≠ 旧 id，
   且用旧 attempt 审新交付 → `stale_attempt`。
6. **超轮次**：连续「打回 → 重新认领」至 `reassignCount >= maxReassignRounds` →
   `reassign_limit_exceeded`（`data` 含 `reassignCount` / `maxReassignRounds`）；
   `send_message` 通道不受限（回归）。
7. **归档显式列出**：`agent_teams_delete(archive:true)` 时存在 `in_review` 任务 →
   `pending_tasks` 显式列出该 `taskId`；`keepFiles` 归档目录里任务 / 邮箱 / 分支材料俱在；
   `cleanupTeamWorktrees` 对该成员报 `keptReason: "member_active"`（树未被删）；
   变体：`remove_member` 对 `in_review` 任务 → 回收为 `todo` 且不静默丢弃（EI-1）。
8. **旧状态直接可读（兼容回归）**：读入 0.4.0 生成的团队 JSON（无 `in_review`）→ 新版正常读取、
   合并 / 打回 / 归档 / 面板 / metrics 全部正常工作；反向：构造含**未知 status** 的任务文件 →
   新版抛结构化错误（fail loudly），不静默当 `todo`。

## 跨批负向断言与穷举（EI-21 / EI-120 / EI-121）

- (from, action) 全表 + 终态封闭 + `in_review` 出边穷举（场景 ②）。
- 未声明命令**确实未执行**；超限输出**确实未返回部分内容**；陈旧 attempt **确实零 diff /
  零执行**（第 1 册场景 3/4/5）。
- `tests/metrics.test.ts`（纯函数，固定时钟）：`firstPassRate` / `avgAttempts` / `rejections` /
  `acceptLatencyMs` 的分母与 `null` 语义（无数据 → `null`，不是 `0`）；样本全部来自 `attempts` /
  `revisions` / `mergedAt`；断言 metrics 计算前后磁盘文件集合不变（**不落第二份台账**，EI-48）。
- 所有测试用内存 / 临时目录 + 固定时钟，不触网、不上报（EI-121）。

## 实施约束（本册增量）

- 继承第 1 册「实施约束」：新文件 ≤400 行零容忍；测试放插件 `tests/*.test.ts`；每批门禁
  `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` /
  `pnpm --filter @acode/agent-teams-plugin test`；spec 先行独立提交（EI-137）。
- `in_review` 的专属落点：`machine.ts`（62 行）、`types.ts`（281 行）本身有余量；
  耦合逻辑进既有 `tools/worktree.ts`（99 行）与 `tools/tasks-captain.ts`（282 行）；
  若任一超必须拆新文件（`tools/acceptance-coupling.ts`），不挤注释。
- 批次 1 必须与批次 0 同分支串行落地（依赖 `review_member_diff` / `run_checks` 的锚定函数）。

## 开放问题（需主 agent 裁决，本册部分）

- **OQ-1（阻塞，本册实现前必裁）**：`worktree_disabled` 团队无合并入口 → `accept` 无触发者，
  任务永久停在 `in_review`。可选：① 增设队长显式 accept 工具（同一 `accept` 迁移，冻结面外扩）；
  ② 未开隔离时 `update_task(done)` 直落 `done` 并返回显式 note（EI-1 可见降级）。
  推荐 ①（保持「done 必须验收」单一语义）。
- **OQ-3**：打回是否「当场」推进重派轮次（方案字面 `attemptSeq++` / 轮次 +1）。本 spec 取
  **单一来源**（`Σ attempts.length - 1`，随下一次认领 +1），避免第二计数器（EI-2/EI-48）。
  若需当场生效，须裁决是否破坏既有 `reassignCountOf` 语义与「认领计数」定义。
- **OQ-6**：`in_review` 期间是否冻结 `acceptance` 修订。方案未言明；推荐扩 `acceptance_frozen`
  （修订契约会让已交付成员的工作失去依据，改为 reassign 更诚实），并同步该工具 description。
- **OQ-7**：`accept` 是否需要一次独立 revision（`fields: ["status", "acceptedBy"]`）以记录
  「谁验收的」。当前只有合并动作可追溯；推荐记一条（审计价值 vs `revisions` 语义扩张）。
- **OQ-9**：成员在持有 `in_review` 任务时是否允许同时认领新任务（现状允许：`holdings` 只看
  `in_progress`）。允许 = 流水线（但同一 worktree 会把新提交叠到待验收分支上，需靠 `headRef`
  钉住）；禁止 = 简单但降低吞吐。推荐允许 + 依赖 R1.1 的钉住语义。

## 非目标 / 登记项（本册）

- 不做验收可视化 UI（挂 diff 面板 / 验收按钮）、不新增 v4 协议命令（批次 4）；
  不搬 Fynvra 的进程模型 / 工具名 / 裸文本注入；不新增第四套 worktree 域；不改 legacy 协议面。
- 登记（另立批次）：批次 2 协调者只读预设（G4）、批次 3 宿主自动唤醒 + 队长侧
  `wait_for_members`（G5+G6，含「队长已停止时成员汇报」）、批次 4 验收可视化（G7）、
  批次 5 角色能力包（G8）；`repair` 任务自动环（现仍由队长手动创建）；度量按 dispatch
  维度归组的桌面展示（M0 已在第 1 册落地只读投影）。