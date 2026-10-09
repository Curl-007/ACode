/** Dynamic Workflow run 读模型 bounded context 的架构清单。 */
export const workflowRunReadModule = {
  id: "acode-cli-workflow-run-read",
  requires: ["acode-cli", "acode-cli-contracts"],
  provides: ["workflow-run-read-model"],
  publicEntrypoints: ["contract.ts"],
} as const;
