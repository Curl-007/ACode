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
const { createWorkflowOwnerLeaseManager, resolveWriteBoundaryOwner } = await import(
  "../packages/cli-workflow/src/workflow-owner-lease.ts"
);
const { ScriptWorkflowRuntime } = await import(
  "../packages/cli-workflow/src/script-workflow-runtime.ts"
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

// D3 回归（spec 场景 6）：写消费端在**被接管后**必须读 live 所有权、干净失败，
// 而不是拿冻结的初始 claim facts 继续走写路径。这里直接驱动真实消费端
// ScriptWorkflowRuntime.run()——它的 owner 闸门在任何文件/持久化动作之前触发。
// 病根：闸门此前读冻结的 ownerReady（初始 claim 成功后永久非 null），于是
// `owner === null` 恒假、reclaim 永不触发，接管对写路径结构性不可见。
test("consumer run() after takeover fails closed instead of writing stale-facts row", async (t) => {
  const { store } = await withStore(t, "sess_mgr_consumer_takeover");
  const manager = createWorkflowOwnerLeaseManager({
    claim: (input) => store.claimWorkflowSessionOwner(input),
    // 心跳间隔 > 租约：故意制造续租断档，让外部有机可乘（同场景 3）。
    leaseMs: LEASE_MS,
    ownerToken: "mgr-consumer",
    parentSessionId: "sess_mgr_consumer_takeover",
    renewIntervalMs: 2_000,
  });
  t.after(() => manager.dispose());
  const initial = await manager.ownerReady;
  assert.equal(initial?.ownerToken, "mgr-consumer");
  assert.equal(initial?.ownerGeneration, 1);

  // P1 事件循环被饿死 → 租约过期 → 外部 usurper 夺走（gen 2，长租约保持活跃）。
  await sleep(1_400);
  const usurper = await store.claimWorkflowSessionOwner({
    leaseMs: 8_000,
    ownerToken: "usurper",
    parentSessionId: "sess_mgr_consumer_takeover",
  });
  assert.equal(usurper?.ownerGeneration, 2);

  // 等 P1 的下一次续租（t≈2s）撞上活跃 usurper → 停表 + 自置非 owner（current = null）。
  await sleep(900);

  // 哨兵文件系统端口：若闸门放陈旧 facts 通过，run() 会走到 readWorkflowScriptDocument
  // 命中它——这正是 D3 的「createRun 不带闸门、陈旧行照样落库」在消费端的前一步。
  let sentinelReached = false;
  const SENTINEL = "SENTINEL_WRITE_BOUNDARY_CROSSED";
  const runtime = new ScriptWorkflowRuntime({
    ownerReady: manager.ownerReady, // 冻结在 gen1（buggy 闸门的唯一读源）
    ownerReclaim: manager.reclaim, // live 所有权的唯一读口
    prepareUserExecutionBoundary: async () => {},
    traceContext: { traceId: "trace_consumer_takeover" },
    fileSystemPort: {
      readTextFile: () => {
        sentinelReached = true;
        throw new Error(SENTINEL);
      },
    },
  });

  // 修复后：闸门经 live 所有权看到已被接管、外部仍活跃 → 干净抛「held by another
  // process」，绝不越过写边界。修复前：拿冻结 gen1 越过闸门 → 命中哨兵。
  await assert.rejects(
    runtime.run({ scriptPath: "C:/repo/wf.mjs" }),
    /Workflow session owner lease is held by another process/u,
  );
  assert.equal(sentinelReached, false);
});

// D3 回归的 helper 本体（spec 场景 6）：resolveWriteBoundaryOwner 恒读 live 所有权。
// 三条分支：(a) 接管后外部仍活跃 → null（消费端据此干净失败）；(b) 接管后外部租约
// 过期 → 新 facts（generation 递增，当场自愈）；(c) 对照冻结的 ownerReady 恒回首份
// facts（正是 D3 病根），证明 helper 读的不是它；(d) 无能力面（ownerReady 缺席）→ undefined。
test("resolveWriteBoundaryOwner reads live ownership, self-heals after foreign lease lapses", async (t) => {
  const { store } = await withStore(t, "sess_mgr_helper");
  const manager = createWorkflowOwnerLeaseManager({
    claim: (input) => store.claimWorkflowSessionOwner(input),
    leaseMs: LEASE_MS,
    ownerToken: "mgr-helper",
    parentSessionId: "sess_mgr_helper",
    renewIntervalMs: 2_000, // 心跳间隔 > 租约：制造续租断档让外部夺走。
  });
  t.after(() => manager.dispose());
  const initial = await manager.ownerReady;
  assert.equal(initial?.ownerGeneration, 1);

  // 冻结的初始 claim：helper 绝不能读它——它永远停在 gen1（D3 病根的对照组）。
  const frozenReady = manager.ownerReady;
  assert.equal((await frozenReady)?.ownerGeneration, 1);

  // 接管：外部 usurper 夺走（gen 2），且 manager 的下一次续租撞上它 → current = null。
  await sleep(1_400);
  const usurper = await store.claimWorkflowSessionOwner({
    leaseMs: LEASE_MS, // 短租约：让它随后自然过期，驱动自愈分支。
    ownerToken: "usurper",
    parentSessionId: "sess_mgr_helper",
  });
  assert.equal(usurper?.ownerGeneration, 2);
  await sleep(900); // 等 manager 续租（t≈2s）撞活跃 usurper → 停表 + current = null。

  // (a) 外部仍活跃 → helper 回 null（不返回冻结 gen1，不返回陈旧 facts）。
  assert.equal(
    await resolveWriteBoundaryOwner({ ownerReady: frozenReady, ownerReclaim: manager.reclaim }),
    null,
  );

  // (b) 外部租约过期后 → helper 当场取回所有权，generation 递增（自愈）。
  await sleep(1_400);
  const healed = await resolveWriteBoundaryOwner({
    ownerReady: frozenReady,
    ownerReclaim: manager.reclaim,
  });
  assert.equal(healed?.ownerToken, "mgr-helper");
  assert.equal(healed?.ownerGeneration, 3);
  // (c) 对照：冻结的 ownerReady 仍是 gen1——证明 helper 读的是 live current 而非它。
  assert.equal((await frozenReady)?.ownerGeneration, 1);

  // (d) 无能力面：ownerReady 缺席 → helper 直通 undefined（R6）。
  assert.equal(await resolveWriteBoundaryOwner({}), undefined);
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
  // D3/R4：两个写消费端都经单一 helper resolveWriteBoundaryOwner 读 live 所有权（内部走
  // reclaim），不再各自「读冻结 ownerReady 后才 reclaim」。
  assert.match(runtime, /resolveWriteBoundaryOwner\(\{/);
  assert.match(runtime, /ownerReclaim: this\.deps\.ownerReclaim/);
  // 旧 buggy 闸门形状（读冻结 ownerReady 后才 reclaim）必须消失，否则 D3 复活。
  assert.equal(runtime.includes("owner === null && this.deps.ownerReclaim !== undefined"), false);

  const service = await read("packages/cli-workflow/src/dynamic-workflow-run-service.ts");
  assert.match(service, /resolveWriteBoundaryOwner\(\{/);
  assert.match(service, /ownerReclaim: deps\.workflowOwnerReclaim/);
  assert.equal(service.includes("owner === null && deps.workflowOwnerReclaim !== undefined"), false);
  assert.match(service, /deferredOwnerReconcile\.pending = false/);
  assert.match(service, /ensureWorkflowOwner\(deps, deferredOwnerReconcile\)/);
  // 四个 ensure 调用点全部换到新签名（submit/amend/resume/fillHole）。
  assert.equal(service.match(/ensureWorkflowOwner\(deps, deferredOwnerReconcile\)/g).length, 4);
  assert.equal(service.includes("ensureWorkflowOwner(deps);"), false);

  // helper 本体：恒经 reclaim 读 live 所有权，ownerReady 缺席时直通 undefined（R6）。
  const lease = await read("packages/cli-workflow/src/workflow-owner-lease.ts");
  assert.match(lease, /export async function resolveWriteBoundaryOwner\(/);
  assert.match(lease, /if \(deps\.ownerReady === undefined\) return undefined;/);
  assert.match(lease, /return deps\.ownerReclaim\(\);/);
});
