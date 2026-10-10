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
| 任意              | title 变化         | `applyTitleChange`                                                                                                                                                            |

draft phase 永不写库（既有规则不变）。

## 事故链（2026-10-11，实证）

0.0.7 自动更新重启后，已有会话（zoode）在重启基线 snapshot 里以 `completedSuccess` 入册；
用户继续对话产生 terminal→running 的 delta，旧迁移表无此分支 → syncer 全程零写入，
`tasks.updated_at` 冻结在重启前水位（04:19:17），侧栏状态与权威会话状态漂移。

## 验收

1. runtime available 后 syncer 必须发出 sessions-index 订阅（existing-only）。
2. 初始 snapshot 基线经 `seedTaskMetaIfMissing` 静默补缺失行，不广播。
3. 新会话首次出现的 delta 回源写任务行。
4. 终态→非终态 delta 回源刷新任务行（status=running、updatedAt=最新 lastActivityAt）。
