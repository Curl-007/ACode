// Workflow session owner lease 生命周期测试（specs/workflow-owner-lease.md 验收场景 1-5）。
// 真 sqlite store + 小时间参数：心跳延寿、惰性回收、被接管停写、无能力面直通、接线断言。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { createSqliteSessionStore } = await import(
  "../packages/adapters/src/storage/session-store/sqlite-session-store.ts"
);
const { createWorkflowOwnerLeaseManager } = await import(
  "../packages/cli-workflow/src/workflow-owner-lease.ts"
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 原语有 Math.max(1_000, leaseMs) 下限（workflow-run-owner.ts），测试时间参数必须
// 整体在 1s 之上排布：租约 1.2s、心跳 300ms、等待窗口 ≥1.4s。
const LEASE_MS = 1_200;
const RENEW_MS = 300;

async function withStore(t, sessionId) {
  const directory = await mkdtemp(join(tmpdir(), "acode-owner-lease-mgr-"));
  const dbPath = join(directory, "sessions.db");
  const store = createSqliteSessionStore({ dbPath });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.createSession({
    directory,
    id: sessionId,
    projectID: "proj_owner_lease_mgr",
    slug: sessionId,
    title: "owner lease manager",
    version: "v4",
  });
  return { directory, store };
}

test("heartbeat keeps the lease alive past nominal expiry; dispose lets it lapse", async (t) => {
  const { store } = await withStore(t, "sess_mgr_heartbeat");
  const manager = createWorkflowOwnerLeaseManager({
    claim: (input) => store.claimWorkflowSessionOwner(input),
    leaseMs: LEASE_MS,
    ownerToken: "mgr-a",
    parentSessionId: "sess_mgr_heartbeat",
    renewIntervalMs: RENEW_MS,
  });
  t.after(() => manager.dispose());
  const facts = await manager.ownerReady;
  assert.equal(facts?.ownerToken, "mgr-a");
  assert.equal(facts?.ownerGeneration, 1);

  // 名义过期点（1.2s）之后，外部 claim 仍被活跃租约拒绝——心跳在续。
  await sleep(1_700);
  const blocked = await store.claimWorkflowSessionOwner({
    leaseMs: LEASE_MS,
    ownerToken: "mgr-b",
    parentSessionId: "sess_mgr_heartbeat",
  });
  assert.equal(blocked, null);

  // dispose 停表 → 租约按 R2 自然过期 → 外部 claim 成功且 generation 递增。
  manager.dispose();
  await sleep(1_400);
  const taken = await store.claimWorkflowSessionOwner({
    leaseMs: LEASE_MS,
    ownerToken: "mgr-b",
    parentSessionId: "sess_mgr_heartbeat",
  });
  assert.equal(taken?.ownerGeneration, 2);
  assert.equal(taken?.ownerToken, "mgr-b");
});

test("lazy reclaim recovers ownership after the blocking foreign lease expires", async (t) => {
  const { store } = await withStore(t, "sess_mgr_reclaim");
  // 外部先持有（1.2s 租约，不续）。
  const foreign = await store.claimWorkflowSessionOwner({
    leaseMs: LEASE_MS,
    ownerToken: "foreign",
    parentSessionId: "sess_mgr_reclaim",
  });
  assert.equal(foreign?.ownerGeneration, 1);

  const manager = createWorkflowOwnerLeaseManager({
    claim: (input) => store.claimWorkflowSessionOwner(input),
    leaseMs: LEASE_MS,
    ownerToken: "mgr-c",
    parentSessionId: "sess_mgr_reclaim",
    renewIntervalMs: RENEW_MS,
  });
  t.after(() => manager.dispose());
  // 启动窗口内 claim 失败：ready 为 null（旧接线会把它缓存成进程级判决）。
  assert.equal(await manager.ownerReady, null);

  // 并发 reclaim 去重：两个调用拿到同一份 facts。
  await sleep(1_400);
  const [first, second] = await Promise.all([manager.reclaim(), manager.reclaim()]);
  assert.equal(first?.ownerToken, "mgr-c");
  assert.equal(first?.ownerGeneration, 2);
  assert.deepEqual(second, first);

  // reclaim 成功即武装心跳：外部立刻再 claim 被拒。
  const blocked = await store.claimWorkflowSessionOwner({
    leaseMs: LEASE_MS,
    ownerToken: "foreign-2",
    parentSessionId: "sess_mgr_reclaim",
  });
  assert.equal(blocked, null);
});

test("takeover stops the heartbeat and reclaim never returns stale facts", async (t) => {
  const { store } = await withStore(t, "sess_mgr_takeover");
  const manager = createWorkflowOwnerLeaseManager({
    claim: (input) => store.claimWorkflowSessionOwner(input),
    // 心跳间隔 > 租约：故意制造续租断档，让外部有机可乘。
    leaseMs: LEASE_MS,
    ownerToken: "mgr-d",
    parentSessionId: "sess_mgr_takeover",
    renewIntervalMs: 2_000,
  });
  t.after(() => manager.dispose());
  assert.equal((await manager.ownerReady)?.ownerToken, "mgr-d");

  await sleep(1_400);
  const usurper = await store.claimWorkflowSessionOwner({
    leaseMs: 8_000,
    ownerToken: "usurper",
    parentSessionId: "sess_mgr_takeover",
  });
  assert.equal(usurper?.ownerGeneration, 2);

  // 等原 manager 的下一次续租（t≈2s）撞上活跃 usurper → 停表 + 自置非 owner。
  await sleep(900);
  const stale = await manager.reclaim();
  assert.equal(stale, null);

  // 再等两个原心跳周期后由 usurper 同 token 续租：generation 不变、token 不变，
  // 证明 mgr-d 全程没有插写过（僵尸心跳若还在跑且 usurper 租约断档，这里会被夺回）。
  await sleep(500);
  const row = await store.claimWorkflowSessionOwner({
    leaseMs: 5_000,
    ownerToken: "usurper",
    parentSessionId: "sess_mgr_takeover",
  });
  // 同 token 重入 = usurper 自己的续租：generation 不变即证明 mgr-d 没有插写过。
  assert.equal(row?.ownerGeneration, 2);
  assert.equal(row?.ownerToken, "usurper");
});

test("absent claim port resolves undefined without arming a heartbeat", async () => {
  const manager = createWorkflowOwnerLeaseManager({
    ownerToken: "mgr-e",
    parentSessionId: "sess_mgr_legacy",
  });
  assert.equal(await manager.ownerReady, undefined);
  assert.equal(await manager.reclaim(), undefined);
  manager.dispose();
});

test("wiring: consumers retry through reclaim and run deferred reconcile once", async () => {
  const read = (p) => readFile(join(import.meta.dirname, "..", p), "utf8");
  const wiring = await read("packages/bootstrap/src/app/workflow-wiring.ts");
  assert.match(wiring, /createWorkflowOwnerLeaseManager\(/);
  assert.match(wiring, /workflowOwnerReclaim: workflowOwnerLease\.reclaim/);
  assert.match(wiring, /ownerReclaim: workflowOwnerLease\.reclaim/);

  const bridge = await read("packages/bootstrap/src/app/script-workflow-methods.ts");
  assert.match(bridge, /createWorkflowOwnerLeaseManager\(/);
  assert.match(bridge, /deferredScriptReconcile = true/);
  assert.match(bridge, /baseReclaim/);

  const runtime = await read("packages/cli-workflow/src/script-workflow-runtime.ts");
  assert.match(runtime, /owner === null && this\.deps\.ownerReclaim !== undefined/);

  const service = await read("packages/cli-workflow/src/dynamic-workflow-run-service.ts");
  assert.match(service, /owner === null && deps\.workflowOwnerReclaim !== undefined/);
  assert.match(service, /deferredOwnerReconcile\.pending = false/);
  assert.match(service, /ensureWorkflowOwner\(deps, deferredOwnerReconcile\)/);
  // 四个 ensure 调用点全部换到新签名（submit/amend/resume/fillHole）。
  assert.equal(service.match(/ensureWorkflowOwner\(deps, deferredOwnerReconcile\)/g).length, 4);
  assert.equal(service.includes("ensureWorkflowOwner(deps);"), false);
});
