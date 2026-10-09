/**
 * acode-server-cli 模块清单：远程服务器侧 CLI 与 Supervisor（serve/status/stop/
 * restart/update/uninstall 生命周期、崩溃预算、release 安装与更新、server-core
 * HTTP/WS 承载）。
 *
 * 全部实现（cli/supervisor/runtime/packaging/platform/server-core/ipc）都在
 * 模块内部；消费者只能经 contract.ts、包根入口 index.ts 或 bin 入口 main.ts
 * 使用公开 API。注意 src/contracts.ts（复数）是内部 zod schema 实现文件，
 * 不是治理契约面。依赖声明与 architecture-policy.yaml 保持一致：
 * requires: ["rpc", "services", "shared"]。
 */
export const acodeServerCliModule = {
  id: "acode-server-cli",
  requires: ["rpc", "services", "shared"],
  provides: ["server-cli-supervisor"],
  publicEntrypoints: ["contract.ts", "index.ts", "main.ts"],
} as const;
