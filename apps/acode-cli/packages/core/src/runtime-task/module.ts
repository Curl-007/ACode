/** 唯一状态 owner 为 registry；公开消费者只通过 contract.ts。 */
export const runtimeTaskModule = {
  id: "acode-cli-runtime-task",
  requires: ["acode-cli-contracts"],
  provides: ["runtime-task-registry", "runtime-task-notifications"],
  publicEntrypoints: ["contract.ts"],
} as const;
