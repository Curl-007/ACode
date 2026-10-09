# session

session 是会话/任务域服务模块（owner：`conversation`），嵌套在 services 包内
（`packages/services/src/session`，无独立 package.json）：任务索引与列表
（`IACodeTaskService`/`TaskIndexRepo`）、automation 调度（`AutomationRepo`/
`AutomationService`/cron 纯函数）、off-peak 闲时任务（`IOffPeakTaskService`/
`OffPeakTaskRepo`/server client/mock gateway）与跨会话 mailbox 类型。

`contract.ts` 是迁移目标入口（精选公开面），**已落地但尚未注册为
publicEntrypoints**：策略里的入口列表有意为空，deep-import 校验对本模块保持
惰性（checker 只在列表非空时校验）。这是登记的迁移状态——services→session 的
31 条内部边（经 services 的 index.ts/node.ts barrel 出面）仍直引实现文件；
收敛时先注册 contract.ts，再把内部边逐条迁到契约面。

状态所有权：`AutomationRepo`/`OffPeakTaskRepo` 是各自表的唯一写入所有者；
service 层只做编排，不另存第二份任务状态。`TaskIndexRepo` 有意不入契约——
task-index-writers 守护测试（specs/task-index-write-ownership.md）把任何引用
它的文件都视为待评审写入面，契约面只暴露 `IACodeTaskService` 与纯投影。
调度纯函数（computeRetryAt/computeNextRunAt/isValidCronExpr）无状态、无 IO。

依赖方向：requires `[provider, rpc, services, shared]`。session→services 共
7 条边（5 条 type-only：ServiceLogger ×4、IAccountRequestAuthService；2 条值
导入：descriptors.js、accountProviderRequestAuthService.js），与
services→session 的 31 条边构成**已登记的双向模块耦合**（registered debt，
详见 packages/services/specs/session-module-boundary.md）；解除耦合的方向是
descriptors/logger 下沉中立叶子，而不是加兜底 re-export。
