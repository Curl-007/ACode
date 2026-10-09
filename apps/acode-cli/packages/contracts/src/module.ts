/**
 * acode-cli-contracts 模块的架构清单（specs/architecture-contracts-module.md）。
 *
 * 依赖只声明 shared：本包只导入 @acode/shared（含 workspace-hook-trust-store-file /
 * model-selection / model-config / acode-protocol-v4 子路径）与外部包 zod、
 * zod-to-json-schema；不导入 apps/acode-cli 下任何其他包。方向与 workflow-run-read
 * 相反——那边声明了 acode-cli 与本模块（消费 CLI 包），这边只被消费、不反向依赖。
 *
 * 注意：checker 的 manifestRequires 用正则在**整个文件**里找第一处「requires 冒号 +
 * 方括号数组」字面量（含注释），本文件注释里不得出现同款写法，否则会覆盖真实声明。
 *
 * publicEntrypoints 与 architecture-policy.yaml 保持一致；策略侧额外登记两个
 * package.json 合法子路径入口（依赖方解析目标）：
 * - src/plugins/index.ts   ← `@acode/contracts/plugins`（cli/plugin-host-command.ts）
 * - src/tools/node-repl.ts ← `@acode/contracts/tools/node-repl`（node-repl-host/server.ts）
 *
 * 不声明 domain 层：本包含 node:async_hooks / node:net 的类型与上下文工具面
 * （invocation-context、public-egress-ip、tracer），单一非 domain 层 `app` 避免
 * domain-io 规则误报；层与 layerOrder 以策略文件为准。
 */
export const cliContractsModule = {
  id: "acode-cli-contracts",
  requires: ["shared"],
  provides: ["cli-contracts"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
