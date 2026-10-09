# Workflow run session owner lease

状态：2026-10-09 修复规范。Dynamic Workflow 与 Script Workflow 共用同一份会话 owner。

## 目标

同一个 `parentSessionId` 可能被两个进程打开。构造期 orphan reconcile 只能收敛已经失去 owner 的 run，不能把仍由另一个进程执行的 live run 改成 stopped/interrupted。

## Durable 事实

- `workflow_session_owner` 以 `parentSessionId` 为主键，保存 `ownerToken`、单调 `generation`、`leaseExpiresAt` 和更新时间。
- 每个 workflow run 保存创建它的 `ownerToken` 与 `ownerGeneration`；历史行允许为空，并按 legacy 规则跳过跨进程收敛。
- owner claim 使用 SQLite `BEGIN IMMEDIATE`。没有 owner、lease 已过期，或 token 已相同才可取得/续租；活跃的其他 token 必须拒绝。
- lease 失效后，新 owner generation 替换旧 owner。旧进程的终态写入必须用 token + generation CAS，影响行数为 0 时拒绝 stale write，不能覆盖新 owner 的状态。

## Reconcile 规则

1. 构造先 claim 当前会话 owner；claim 失败时跳过 reconcile，不修改任何 run。
2. claim 成功后只查询本 `parentSessionId`、非终态、有上界的行。
3. 只收敛 owner facts 与当前 owner 不同且旧 lease 已失效的行；owner facts 缺失的 legacy 行不在跨进程路径中收敛。
4. 单行 CAS 失败只记 warn，不影响其他行；查询/构造失败不阻断 app 启动。
5. Dynamic 与 Script 都使用相同的 owner 表、token、generation 和 lease 判定。

## 验收

- 两个独立 store 实例：A claim 并创建 live run，B 构造 reconcile 不得修改 A 的 run。
- lease 过期后 B 可 claim 新 generation 并收敛 A 的 orphan。
- A 使用旧 token 完成终态写入时 CAS 失败，run 保持 B 写入的终态。
- owner 表和 run owner 列在真实 SQLite migration 后存在；存量行的 nullable owner facts 保持兼容。
