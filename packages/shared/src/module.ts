/**
 * shared 模块清单：跨进程协议 / schema / 类型的唯一事实源（@acode/shared）。
 *
 * Desktop main、renderer(UI)、services、session、server、CLI 与 harness-sdk 共享
 * 同一组 zod schema 与协议类型；本模块只承载「协议事实」，不承载业务状态与 IO
 * 编排。唯一的跨模块依赖是 model-option-map（model-config.ts 调用
 * compileModelOptionMap），与 architecture-policy.yaml 的 requires 保持一致。
 *
 * 权威公开面是 packages/shared/package.json 的 20 个子路径 exports（包根 index.ts
 * 与 acode-protocol-v4、harness-api、node、model-selection 等子路径源文件）；
 * contract.ts 是治理用的精选视图，两者都登记为 publicEntrypoints。
 */
export const sharedModule = {
  id: "shared",
  requires: ["model-option-map"],
  provides: ["shared-protocol", "shared-schemas"],
  publicEntrypoints: [
    "contract.ts",
    "index.ts",
    "runtimeEnv.ts",
    "mcp.ts",
    "runtime-tool-runtime.ts",
    "browser-use/nodeReplBroker.ts",
    "process-diagnostic.ts",
    "model-selection.ts",
    "account-provider-state.ts",
    "model-config.ts",
    "config-schema.ts",
    "node.ts",
    "acodeEndpoint.ts",
    "workspaceFileSearch.ts",
    "workspaceFileEntriesCodec.ts",
    "acode-protocol-v4/index.ts",
    "harness-api/index.ts",
    "workspace-hook-discovery.ts",
    "workspace-hook-mutation.ts",
    "workspace-hook-review-monotonicity.ts",
    "workspace-hook-trust-store-file.ts",
  ],
} as const;
