/**
 * provider-node 模块清单：Provider 配置域的 Node.js 运行时物化层。
 *
 * ACode Built-in 配置的下载/缓存/远程同步/落盘、Personal 配置文件仓库（锁内
 * CAS + 轮询恢复）、Config/Registry 运行时组装与模型选择 Facade 都在模块内部
 * 实现；消费者只能经 contract.ts（或包根入口 index.ts）使用公开 API。
 * 依赖声明与 architecture-policy.yaml 保持一致：配置域模型来自 provider，
 * 协议投影来自 shared（requires: ["provider", "shared"]）。
 */
export const providerNodeModule = {
  id: "provider-node",
  requires: ["provider", "shared"],
  provides: ["provider-node-runtime"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
