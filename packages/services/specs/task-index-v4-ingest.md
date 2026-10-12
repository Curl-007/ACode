# task index syncer 的 sessions-index 迁移表

状态：已实施（2026-10-11，「任务对话被吞」0.0.7 自动更新后事故修复）。
守护测试：`packages/services/tests/task-index-syncer-v4-ingest.test.mjs`。

## 规则

`acodeTaskIndexSyncer.processSummary` 按「基线 previous phase → delta next phase」的迁移
决定是否回源/写库/广播。完整迁移表：

| previous          | next               | 动作                                                                                                                                                                          |
| ----------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| undefined / draft | 非终态可见         | `resyncTaskIndexRowFromAgent`（session.became-visible，moveGroupedTaskToTop）                                                                                                 |
| 任意非终态        | 终态               | `applyTerminalTransition`（正文回源 + 未读信号）                                                                                                                              |
| 非终态            | 非终态（同题不变） | 无写库（列表活性由 phase 终态/标题承载）                                                                                                                                      |
| **终态**          | **非终态**         | `resyncTaskIndexRowFromAgent`（session.reactivated，moveGroupedTaskToTop）——**重启后基线以终态入册、用户恢复对话时必须刷新 status/updatedAt，否则任务行永久冻结在重启前水位** |
| **终态(kind)**    | **不同 kind 终态** | `applyTerminalTransition`——**断档降级 conflated snapshot 会把 error→running→completedSuccess（或反向）折叠成一次 error↔completedSuccess 迁移；此时任务行 status/lastError/updatedAt 必须收敛，否则侧栏永久显示旧终态颜色、排序水位冻结、lastError 漂移** |
| 终态(kind)        | 同 kind 终态       | 无写库（online 路径不可达——两终态间必先经非终态 delta 收口；仅 conflated snapshot 可产生同 kind no-op，保持幂等不写库） |
| 任意              | title 变化         | `applyTitleChange`                                                                                                                                                            |

draft phase 永不写库（既有规则不变）。

「终态(kind)」指 `taskStatusFromSummaryPhase` 映射出的 task status：`completed`
（completedSuccess / completedInterrupted）或 `error`。kind 变化 = 两个终态映射到不同
task status；同 kind（如 completedSuccess↔completedInterrupted）不重复写库。

## 事故链（2026-10-11，实证）

0.0.7 自动更新重启后，已有会话（zoode）在重启基线 snapshot 里以 `completedSuccess` 入册；
用户继续对话产生 terminal→running 的 delta，旧迁移表无此分支 → syncer 全程零写入，
`tasks.updated_at` 冻结在重启前水位（04:19:17），侧栏状态与权威会话状态漂移。

## 验收

1. runtime available 后 syncer 必须发出 sessions-index 订阅（existing-only）。
2. 初始 snapshot 基线经 `seedTaskMetaIfMissing` 静默补缺失行，不广播。
3. 新会话首次出现的 delta 回源写任务行。
4. 终态→非终态 delta 回源刷新任务行（status=running、updatedAt=最新 lastActivityAt）。
5. 断档降级 conflated snapshot 产生的终态(kind)→不同 kind 终态 diff 必须经
   `applyTerminalTransition` 收敛 status/lastError/updatedAt 并发出未读信号
   （error→completedSuccess 清空 lastError、completedSuccess→error 保留 error 态）。

## 事故链补记（终态→不同终态，conflated snapshot 缺口）

`task-index-v4-ingest.md` 的「完整迁移表」原本只覆盖非终态↔终态与终态→非终态，遗漏了
**终态→不同 kind 终态**。该缺口只在断档降级 snapshot 路径可达：`sessions-index` 的
conflated 投影（`SessionsIndexProjection.summaries` 按 sessionId 收敛）只保留每个会话的
**最新** phase，CLI 侧 deltaLog 溢出（`sessions-index-publisher.ts` maxDeltaLog=512）或
物理帧丢失时 publisher 退化为 snapshotFrame。若 syncer 落后期间用户重试了一个 error 会话
（error→running→completedSuccess），恢复 snapshot 与基线 diff 后就是 error→completedSuccess
一次迁移——中间的 running 被 conflate 掉，四个旧分支全部为 false，任务行 status 冻结在
error、updatedAt 不推进、lastError 不清空、完成未读信号丢失。这是 d14d1ca（终态→非终态）
同类的「冻结任务行」数据完整性缺陷，只是迁移方向不同。online delta 路径安全（每次 phase
变化各自 fan-out 一条 delta，`fanOutToIndex` 只节流 ModelStreaming/DynamicWorkflowRunProgress，
两个终态间必先观察到非终态），故缺口仅限 conflated snapshot 重放。
