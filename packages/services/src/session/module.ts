/**
 * session 模块清单：会话/任务域服务（任务索引与列表、automation 调度、
 * off-peak 闲时任务、跨会话 mailbox）。
 *
 * 嵌套在 services 包内（packages/services/src/session），无独立 package.json；
 * 对外经 services 的 index.ts / node.ts barrel re-export 出面。依赖声明与
 * architecture-policy.yaml 保持一致：模块内存在 7 条 session→services 边
 * （5 条 type-only：ServiceLogger ×4、IAccountRequestAuthService；2 条值导入：
 * descriptors.js 的 createServiceDescriptor、accountProviderRequestAuthService.js
 * 的错误类），与 services→session 的存量内部边构成已登记的双向耦合，
 * 详见 packages/services/specs/session-module-boundary.md。
 */
export const sessionModule = {
  id: "session",
  requires: ["provider", "rpc", "services", "shared"],
  provides: ["session-task-services"],
  // contract.ts 已注册为公开入口（2026-10-27 迁移完成）：消费方一律经契约面导入，
  // deep-import 对本模块强校验；剩余 15 条写入/装配边由 internalEdgeAllowlist 逐条登记
  // （任务索引 repo 构造边、会话导入机器件、tasksDatabase 启动、mcpWorkspaceScope）。
  // 注意：本文件刻意不以类名书写那个 repo 符号——task-index-writers 守护把源码中对该符号的
  // 任何文本引用（注释也算）都当待评审写入面，写类名会让本文件被判红。
  // 权威声明在 architecture-policy.yaml（checker 只读策略，本清单仅供 context 阅读包展示）。
  publicEntrypoints: ["packages/services/src/session/contract.ts"],
} as const;
