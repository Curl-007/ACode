// Script workflow resume owner facts (specs/script-workflow-revival.md R18).
// Existing rows remain nullable because their remote identity was never recorded.
export const WORKFLOW_RUN_OWNER_MIGRATION_SQL = `
      alter table workflow_run add column workspace_identity text;
      alter table workflow_run add column remote_session_id text;
`;
