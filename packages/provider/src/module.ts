/**
 * provider 模块清单：模型 Provider 配置域（双层配置合并、Registry 视图、
 * 账号 Provider 状态、API Key 凭据接口与设置/选择 Facade）。
 *
 * 域实现（config-service/registry/resolver/facades/config/* 等）都在模块内部；
 * 消费者只能经 contract.ts（或包根入口 index.ts）使用公开 API。本模块无
 * node:/DOM IO（文件与网络物化在 provider-node），依赖声明与
 * architecture-policy.yaml 保持一致：协议与配置投影唯一来自 shared
 * （requires: ["shared"]）。
 */
export const providerModule = {
  id: "provider",
  requires: ["shared"],
  provides: ["provider-config-registry"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
