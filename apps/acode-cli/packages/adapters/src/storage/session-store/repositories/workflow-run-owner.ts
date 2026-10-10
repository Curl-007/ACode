import type { DatabaseSync } from "node:sqlite";

export interface WorkflowSessionOwnerLease {
  leaseExpiresAt: number;
  ownerGeneration: number;
  ownerToken: string;
}

export interface WorkflowSessionOwnerClaimInput {
  leaseMs?: number;
  now?: number;
  ownerToken: string;
  parentSessionId: string;
}

/**
 * Claim/renew is one SQLite transaction. A second process cannot observe a
 * half-updated generation and lease, and an active foreign token is rejected.
 */
export function claimWorkflowSessionOwner(
  db: DatabaseSync,
  input: WorkflowSessionOwnerClaimInput,
): WorkflowSessionOwnerLease | null {
  const now = input.now ?? Date.now();
  const leaseMs = Math.max(1_000, input.leaseMs ?? 30_000);
  db.exec("begin immediate");
  try {
    const existing = db
      .prepare(
        `select owner_token, owner_generation, lease_expires_at
           from workflow_session_owner where parent_session_id = ?`,
      )
      .get(input.parentSessionId) as
      | { owner_token: string; owner_generation: number; lease_expires_at: number }
      | undefined;
    if (
      existing &&
      existing.owner_token !== input.ownerToken &&
      existing.lease_expires_at > now
    ) {
      db.exec("rollback");
      return null;
    }
    const generation =
      existing && existing.owner_token === input.ownerToken
        ? existing.owner_generation
        : (existing?.owner_generation ?? 0) + 1;
    const leaseExpiresAt = now + leaseMs;
    db.prepare(
      `insert into workflow_session_owner
         (parent_session_id, owner_token, owner_generation, lease_expires_at, time_updated)
       values (?, ?, ?, ?, ?)
       on conflict(parent_session_id) do update set
         owner_token = excluded.owner_token,
         owner_generation = excluded.owner_generation,
         lease_expires_at = excluded.lease_expires_at,
         time_updated = excluded.time_updated`,
    ).run(input.parentSessionId, input.ownerToken, generation, leaseExpiresAt, now);
    db.exec("commit");
    return { leaseExpiresAt, ownerGeneration: generation, ownerToken: input.ownerToken };
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    throw error;
  }
}

export function readWorkflowSessionOwner(
  db: DatabaseSync,
  parentSessionId: string,
): WorkflowSessionOwnerLease | null {
  const row = db
    .prepare(
      `select owner_token, owner_generation, lease_expires_at
         from workflow_session_owner where parent_session_id = ?`,
    )
    .get(parentSessionId) as
    | { owner_token: string; owner_generation: number; lease_expires_at: number }
    | undefined;
  return row
    ? {
        leaseExpiresAt: row.lease_expires_at,
        ownerGeneration: row.owner_generation,
        ownerToken: row.owner_token,
      }
    : null;
}

export function isWorkflowSessionOwner(
  db: DatabaseSync,
  input: { now?: number; ownerGeneration: number; ownerToken: string; parentSessionId: string },
): boolean {
  const current = readWorkflowSessionOwner(db, input.parentSessionId);
  return (
    current !== null &&
    current.ownerToken === input.ownerToken &&
    current.ownerGeneration === input.ownerGeneration &&
    current.leaseExpiresAt > (input.now ?? Date.now())
  );
}
