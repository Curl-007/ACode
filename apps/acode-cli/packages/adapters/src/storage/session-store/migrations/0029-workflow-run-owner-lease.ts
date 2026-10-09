// Shared durable owner lease for Dynamic/Script Workflow (specs/workflow-run-owner-lease.md).
export const WORKFLOW_RUN_OWNER_LEASE_MIGRATION_SQL = `
      create table if not exists workflow_session_owner (
        parent_session_id text primary key references session(id) on delete cascade,
        owner_token text not null,
        owner_generation integer not null,
        lease_expires_at integer not null,
        time_updated integer not null
      );
      alter table workflow_run add column owner_token text;
      alter table workflow_run add column owner_generation integer;
      alter table workflow_run add column result_json text;
      alter table dwf_run add column owner_token text;
      alter table dwf_run add column owner_generation integer;
`;
