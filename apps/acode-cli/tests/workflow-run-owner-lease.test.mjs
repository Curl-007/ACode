import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const { createSqliteSessionStore } = await import(
  "../packages/adapters/src/storage/session-store/sqlite-session-store.ts"
);

test("workflow owner lease rejects an active foreign owner and advances generation after expiry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "acode-workflow-owner-"));
  const dbPath = join(directory, "sessions.db");
  const store = createSqliteSessionStore({ dbPath });
  const raw = new DatabaseSync(dbPath);
  t.after(async () => {
    raw.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const parentSessionId = "sess_owner_parent";
  await store.createSession({
    directory,
    id: parentSessionId,
    projectID: "proj_owner",
    slug: parentSessionId,
    title: "owner lease",
    version: "v4",
  });

  const columns = raw
    .prepare("pragma table_info(workflow_run)")
    .all()
    .map((row) => row.name);
  assert.ok(columns.includes("owner_token"));
  assert.ok(columns.includes("owner_generation"));
  assert.ok(columns.includes("result_json"));
  assert.ok(
    raw
      .prepare("select name from sqlite_master where type = 'table' and name = 'workflow_session_owner'")
      .get(),
  );

  const ownerA = await store.claimWorkflowSessionOwner({
    leaseMs: 1_000,
    now: 10_000,
    ownerToken: "owner-a",
    parentSessionId,
  });
  assert.equal(ownerA?.ownerGeneration, 1);

  const blockedB = await store.claimWorkflowSessionOwner({
    leaseMs: 1_000,
    now: 10_500,
    ownerToken: "owner-b",
    parentSessionId,
  });
  assert.equal(blockedB, null);

  const ownerB = await store.claimWorkflowSessionOwner({
    leaseMs: 1_000,
    now: 11_001,
    ownerToken: "owner-b",
    parentSessionId,
  });
  assert.equal(ownerB?.ownerGeneration, 2);
  assert.equal(ownerB?.ownerToken, "owner-b");
});

test("independent SQLite store instances serialize owner claims", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "acode-workflow-owner-race-"));
  const dbPath = join(directory, "sessions.db");
  const storeA = createSqliteSessionStore({ dbPath });
  const storeB = createSqliteSessionStore({ dbPath });
  t.after(async () => {
    storeA.close();
    storeB.close();
    await rm(directory, { recursive: true, force: true });
  });

  const parentSessionId = "sess_owner_race_parent";
  await storeA.createSession({
    directory,
    id: parentSessionId,
    projectID: "proj_owner_race",
    slug: parentSessionId,
    title: "owner race",
    version: "v4",
  });

  const claims = await Promise.all([
    storeA.claimWorkflowSessionOwner({
      leaseMs: 5_000,
      now: 30_000,
      ownerToken: "race-a",
      parentSessionId,
    }),
    storeB.claimWorkflowSessionOwner({
      leaseMs: 5_000,
      now: 30_000,
      ownerToken: "race-b",
      parentSessionId,
    }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.filter((claim) => claim === null).length, 1);
  const winner = claims.find((claim) => claim !== null);
  assert.equal(winner?.ownerGeneration, 1);
});

test("a stale workflow owner cannot settle a run after takeover", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "acode-workflow-owner-write-"));
  const store = createSqliteSessionStore({ dbPath: join(directory, "sessions.db") });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const parentSessionId = "sess_owner_write_parent";
  await store.createSession({
    directory,
    id: parentSessionId,
    projectID: "proj_owner_write",
    slug: parentSessionId,
    title: "owner write",
    version: "v4",
  });
  const leaseNow = Date.now();
  const ownerA = await store.claimWorkflowSessionOwner({
    leaseMs: 1_000,
    now: leaseNow,
    ownerToken: "owner-a",
    parentSessionId,
  });
  assert.ok(ownerA);
  const run = await store.createScriptWorkflowRun({
    cwd: directory,
    id: "run_owner_write",
    name: "owner write",
    ownerGeneration: ownerA.ownerGeneration,
    ownerToken: ownerA.ownerToken,
    parentSessionId,
    scriptHash: "hash",
    status: "running",
  });
  assert.equal(run.status, "running");

  const ownerB = await store.claimWorkflowSessionOwner({
    leaseMs: 1_000,
    now: leaseNow + 1_001,
    ownerToken: "owner-b",
    parentSessionId,
  });
  assert.ok(ownerB);
  const settled = await store.updateScriptWorkflowRun({
    id: run.id,
    ownerGeneration: ownerB.ownerGeneration,
    ownerToken: ownerB.ownerToken,
    ownerTakeover: true,
    result: { ok: true },
    status: "completed",
  });
  assert.equal(settled.status, "completed");
  assert.deepEqual(settled.result, { ok: true });
  await assert.rejects(
    store.updateScriptWorkflowRun({
      id: run.id,
      ownerGeneration: ownerA.ownerGeneration,
      ownerToken: ownerA.ownerToken,
      status: "failed",
      result: { stale: true },
    }),
    /Stale workflow owner write rejected/,
  );
});
