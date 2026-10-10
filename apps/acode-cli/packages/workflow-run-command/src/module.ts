/** Application ordering context; run/journal/owner state remains in bootstrap/core. */
export const workflowRunCommandModule = {
  id: "acode-cli-workflow-run-command",
  requires: ["acode-cli-contracts"],
  provides: ["workflow-run-command-context"],
  publicEntrypoints: ["contract.ts"],
} as const;
