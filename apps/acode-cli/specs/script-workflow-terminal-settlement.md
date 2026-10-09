# Script Workflow terminal settlement

状态：2026-10-09 修复规范。

## 事实与提交顺序

- 子进程成功返回后，run 的 `completed`、顶层 `result` 和终态事实必须先 durable 提交。
- `workflow_completed` 是观察事件。它应在同一事务中追加，或被视为可重试投影；事件落盘失败不得把已经提交的 `completed` 改写为 `failed`。
- `result` 必须可从 run 冷恢复读取，即使 `workflow_completed` 事件暂时缺失。
- `workflow_failed` 只能由子进程/运行时失败产生，不能由终态观察事件写失败伪造。

## 清理

无论终态更新、终态事件、结果格式化或读取失败，`agentCallCounts`、`statsWrites` 和 progress adapter registration 都必须在 `finally` 清理。

## 验收

- 真实 SQLite trigger 拒绝 `workflow_completed` 时：子进程成功、run 仍是 `completed`、result 可由 `getScriptWorkflowRun` 与冷回放读取、不产生 `workflow_failed`，并完成内存清理。
- 终态更新失败时，`run()` 返回 reject，但所有 per-run map 与 progress registration 已清理。
- `undefined` result 仍保持“结果缺席”语义；显式 `null` 可恢复。
