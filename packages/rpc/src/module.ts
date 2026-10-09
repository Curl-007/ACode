/**
 * rpc 模块清单：VS Code 风格的 IPC/RPC 传输框架（Event/Emitter、VSBuffer、
 * 序列化、协议、Channel RPC、连接管理、服务代理、远程连接）。
 *
 * 全部实现细节（foundation/serialization/protocol/channels/ipc/proxy-channel/
 * remote 及各中间件）都在模块内部；消费者只能经 contract.ts（或包根入口
 * index.ts）使用公开 API。零 workspace 依赖：本模块是传输基座，不依赖任何
 * 业务模块（依赖声明与 architecture-policy.yaml 保持一致：requires: []）。
 */
export const rpcModule = {
  id: "rpc",
  requires: [],
  provides: ["rpc-transport"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
