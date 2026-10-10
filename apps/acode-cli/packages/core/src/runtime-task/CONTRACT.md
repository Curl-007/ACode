# runtime-task

唯一公开入口为 `contract.ts`。这是无 IO 的运行时状态模块；Registry 拥有内存任务快照、pending
message 和 waiter，通知格式器只读入参并产出文本。唯一跨模块依赖是 CLI contracts 的公开包入口。

Registry 公开 11 个方法。`register` 登记/重臂并盖 active branch generation；`update` 同步转移，
终态 first-wins，拒绝晚到的另一终态时返回赢家快照。`get` / `all` 是读面，`queueMessage` /
`drainMessages` 复用同一任务记录，`requestBackground` 只改变在跑任务，`remove` 释放对应 waiter。
`waitForTerminal` / `waitForBackgroundRequest` 支持 AbortSignal；已有结果即兑现，取消移除对应监听。
`setActiveBranchGeneration` 只调整随后 register 的 stamp，不改历史任务。

类型来自 `types.ts`，经 contract 再导出。实现与 contract 示例保持结构类型校验，模块内部不会
为公开类型反向 import 格式器。XML 转义与长度截断归 `notification-primitives.ts`；任务通知与
Workflow 文案依赖同一原语，互不导入。现有通知文本与截断规则保持逐字一致。

本模块不是持久化/恢复 owner，不建立 Desktop、手机或远端的第二份 accepted queue；Host/lease、
CLI CommandInbox、workflow journal 与各 coordinator 的 admission 和恢复语义仍归各自现有 owner。
