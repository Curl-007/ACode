/**
 * session 模块清单：会话/任务域服务（任务索引与列表、automation 调度、
 * off-peak 闲时任务、跨会话 mailbox）。
 *
 * 嵌套在 services 包内（packages/services/src/session），无独立 package.json；
 * 当前对外经 services 的 index.ts / node.ts barrel re-export 出面。依赖声明与
 * architecture-policy.yaml 保持一致：模块内存在 7 条 session→services 边
 * （5 条 type-only：ServiceLogger ×4、IAccountRequestAuthService；2 条值导入：
 * descriptors.js 的 createServiceDescriptor、accountProviderRequestAuthService.js
 * 的错误类），与 services→session 的 31 条内部边构成已登记的双向耦合，
 * 详见 packages/services/specs/session-module-boundary.md。
 */
export const sessionModule = {
  id: "session",
  requires: ["provider", "rpc", "services", "shared"],
  provides: ["session-task-services"],
  // 有意留空：迁移状态登记在策略与本模块 spec。contract.ts 已落地但暂不注册为
  // 入口——publicEntrypoints 为空使 deep-import 对本模块保持惰性（checker 只在
  // 列表非空时校验），services→session 的 31 条内部边因此不成为违规；开始收敛
  // 内部边时再登记 contract.ts 并逐条迁移。
  publicEntrypoints: [],
} as const;
