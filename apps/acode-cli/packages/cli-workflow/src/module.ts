/** ACode CLI workflow 引擎 bounded context 的架构清单（W1-R3）。 */
export const cliWorkflowModule = {
  id: "acode-cli-workflow",
  requires: [
    "shared",
    "acode-cli",
    "acode-cli-contracts",
    "acode-cli-workflow-run-read",
    "acode-cli-workflow-run-command",
  ],
  provides: ["cli-workflow-engine"],
  publicEntrypoints: ["contract.ts"],
} as const;
