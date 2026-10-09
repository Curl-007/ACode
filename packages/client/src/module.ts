/**
 * client 模块清单：Renderer/Web 侧的远程服务访问桥（RemoteServiceAccess 代理
 * 门面 + WebSocket/MessagePort 两种连接方式）。
 *
 * 连接与代理实现（remoteServiceAccess/websocket/messageport/rendererLoggingEnv）
 * 都是模块内部实现；消费者只能经 contract.ts（或包根入口 index.ts）使用公开 API。
 * 依赖声明与 architecture-policy.yaml 保持一致：传输来自 rpc，服务接口类型来自
 * services，协议投影来自 shared。
 */
export const clientModule = {
  id: "client",
  requires: ["rpc", "services", "shared"],
  provides: ["remote-client-bridge"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
