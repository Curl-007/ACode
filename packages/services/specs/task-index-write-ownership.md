# Task index 派生库：写入方登记与所有权

状态：已实施（2026-10-05，深度审查 P1「task index 派生库双写路径收口」落地件）。
守护测试：`packages/services/tests/task-index-writers.test.mjs`（写入方白名单，新增写入方即红）。

## 事实与权威源

- **权威源**：CLI 侧会话库（`apps/acode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts`）。
- **派生索引**：desktop 侧 task index sqlite（`src/session/taskIndexRepo.ts` + `src/session/tasksDatabase/`），服务侧边栏列表、分组、归档、未读等 UI 事实。派生索引允许重建，不允许反向写权威源。

## 写入方登记（2026-10-05 git grep 实证，白名单与守护测试一致）

| 写入方 | 角色 | 约束 |
| --- | --- | --- |
| `acode-agent/acodeTaskIndexSyncer.ts` | **运行时状态唯一漏斗**：v4 sessions-index/workspace-config 帧摄入、snapshot upsert、workspace 广播；`syncSnapshotAndBroadcast` 承接 create/resume/setModel 后的即时 UI 刷新 | 旧 shadow 写路径已删（send/steer/fork/compact/rewind 统一走 v4 命令+事件，见 syncer 接口注释） |
| `acode-agent/acodeTaskServiceAdapter.ts` | 用户状态操作（pin/archive/delete/rename/unread）、按需 seed（task index 缺行时从 agent snapshot 补种）、legacy stream `session_info_update` 投影 | `session_info_update` 属 legacy 流事件面，随 `docs/legacy-protocol-convergence-plan.md` M2/M3 一并删除；subagent_child 快照不得写入主索引 |
| `acode-agent/acodeAgentService.ts` | automation（cron/off-peak）任务行的 seed/syncTaskMeta | 仅 automation 生命周期，不碰运行中会话的运行时字段 |
| `acode-agent/repairSubagentTaskIndex.ts` | 历史迁移修复：旧版本曾把冷恢复 child 写入主列表 | 一次性修复器；它的存在即历史漂移的证据，新代码不得再引入同类写入 |
| `session/claude-native/claudeNativeSessionImportService.ts`、`session/claude-native/persistImportedClaudeTask.ts`、`session/external-import/importService.ts` | 外部会话导入的一次性 persist | 导入完成即退出，不订阅运行时事件 |
| `session/taskIndexRepo.ts`、`session/tasksDatabase/startup.ts`、`node.ts` | 存储本体 / schema 启动 / 组合根装配 | — |

## 不变量

1. `sessionKind === "subagent_child"` 的会话永不写入主任务索引（`syncTaskIndexSnapshot` 守卫 + repair 教训）。
2. 侧边栏全量列表只读 sqlite，不触发启动 workspace agent（按需 seed 只发生在点开具体 task 的操作路径）。
3. 任何组件不得持有派生索引的第二份内存投影；运行时状态收敛只经 syncer。
4. 新增写入方必须：更新本 spec 登记表 + 守护测试白名单，并说明为什么不能走既有漏斗。

## 审查记录修正

2026-10-05 深度审查曾表述「acodeSessionService 在同步器之外另有主动 upsert，派生库有两条写入路径」。核实结果：`acodeSessionService.ts` 不直接引用 TaskIndexRepo，其「主动同步」全部经 `taskIndexSyncer.ensureSessionSubscription / syncSnapshotAndBroadcast` 漏斗，该具体双写不成立。真实的结构性风险是上表多写入方并存（尤其 adapter 的 legacy stream 路径），以白名单门禁 + 协议收敛里程碑管理。
