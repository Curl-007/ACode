import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * CommandInbox 不变量测试套件（D3 审计修正项 #7 的落地）。
 *
 * 规格 apps/acode-cli/specs/command-terminal-state-audit.md 的 R3「不得改动的不变量」与
 * 验收场景 5；方案 docs/cli-dispatch-and-system-prompt-upgrade-plan.md §6 Phase 2 验收
 * 要求「任何触碰队列的改动必跑」本套件。逐条覆盖 R3 点名的五条不变量：
 *
 *   1. 固定锁序：key gate → per-session admission gate（command-inbox.ts:139-141），
 *      session gate 持有到 settle。可观察后果：同 session 第二条命令在 settle 前不放行；
 *      query 只取 key gate（execute 路径 pin 后已提前释放），与被持有的 session gate 不死锁。
 *   2. settle 前不放行 + 在飞 duplicate 共享同一个 final promise（:183-208），settle 幂等。
 *   3. baseRevision + baseLogEpoch CAS 拒 stale（:343-390）：丢弃不产出 execute。
 *   4. admissionSeq 权威顺序（:168-170）：只为被 admit 的命令 +1、桶内严格递增、按 session 分桶。
 *   5. 三态分离（:1-2、:107-113）：in-flight / live input 永远 pinned，只有 settled 进
 *      512/session LRU——>512 churn 时在飞命令与 live pin 不被淘汰（:178-180 注释记录的历史坑：
 *      旧单表 LRU 淘汰在飞命令 → query unknown → 重试再次执行）。
 *
 * 驱动的是**真实** CommandInbox，宿主用桩件——与 command-inbox-discard-terminal-state.test.mjs
 * 同一约定。分工：那个文件覆盖丢弃路径的终态可观察性（审计问题 2），本文件覆盖 admission
 * 不变量本身；两个文件各自独立成立、互为补充。
 *
 * churn 用例（(5)）经 pinLiveInput/releaseLiveInput 的公开 API 制造 settled 条目——这正是
 * gateway 对 queue/guide 输入的生命周期用法（admission 后 pin、进 transcript/取消/失败时
 * release 并转入 settled LRU）；不需要经过 handle()，因为 LRU 与 pin 的分离正是本用例的对象。
 */

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const CLI = "apps/acode-cli/packages";

const { CommandInbox, queueItemIdForCommand } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/command-inbox.ts"
);
const { PROTOCOL_V4_LIMITS } = await import(
  "../../../packages/shared/src/acode-protocol-v4/core.ts"
);

const SESSION = "sess_inv_a";
const OTHER_SESSION = "sess_inv_b";
const LOG_EPOCH = "epoch-1";

function envelope(overrides) {
  return {
    clientId: "client-inv",
    commandId: "cmd_inv_1",
    issuedAt: 1_700_000_000_000,
    payload: {},
    sessionId: SESSION,
    type: "stop",
    ...overrides,
  };
}

/** 默认宿主：两个已知会话 revision=7、epoch=epoch-1；无 row-target/业务 guard。 */
function makeHost(overrides = {}) {
  return {
    getLogEpoch: (sessionId) =>
      sessionId === SESSION || sessionId === OTHER_SESSION ? LOG_EPOCH : null,
    getRevision: (sessionId) => (sessionId === SESSION || sessionId === OTHER_SESSION ? 7 : null),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

function makeInbox(hostOverrides = {}) {
  const host = makeHost(hostOverrides);
  return { host, inbox: new CommandInbox(host) };
}

/** queue 车道输入的最小 intent 形状（pinLiveInput 只读 sourceCommandId，其余字段按 schema 补齐）。 */
function liveIntent(commandId) {
  return {
    admittedAt: 1_700_000_000_000,
    attachments: [],
    clientId: "client-inv",
    delivery: { admitted: "queue", requested: "queue" },
    dispatch: { state: "queued" },
    kind: "sendText",
    order: { admissionSeq: 1 },
    queueItemId: queueItemIdForCommand(commandId),
    sourceCommandId: commandId,
    steer: { state: "notRequested" },
    text: "queued input",
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function queryOne(inbox, commandId, sessionId = SESSION) {
  const [row] = await inbox.query([{ commandId, sessionId }]);
  return row.result;
}

// ── 不变量 1：固定锁序 + 持有到 settle ────────────────────────────────

test("(1) 锁序：同 session 第二条命令在 settle 前不放行；query 只取 key gate、不死锁", async () => {
  const { inbox } = makeInbox();
  const first = await inbox.handle(envelope({ commandId: "cmd_a" }));
  assert.equal(first.kind, "execute");
  assert.equal(first.admissionSeq, 1);

  // 同 session 不同 commandId：session gate 被第一条持有到 settle，第二条必须等待。
  const secondPromise = inbox.handle(envelope({ commandId: "cmd_b" }));
  // 同 key 的 query：只取 key gate（execute 路径 pin 后已在 :180 提前释放），
  // 不得因 session gate 被持有而死锁；结果挂在 in-flight 的 final 上，settle 后可得。
  const queryPromise = inbox.query([{ commandId: "cmd_a", sessionId: SESSION }]);

  let secondSettled = false;
  void secondPromise.then(() => {
    secondSettled = true;
  });
  await tick();
  assert.equal(secondSettled, false, "settle 前放行了同 session 的第二条命令：锁序/持有约定被破坏");

  first.settle({ status: "accepted" });
  const second = await secondPromise;
  assert.equal(second.kind, "execute");
  assert.equal(second.admissionSeq, 2, "权威顺序没有按 admission 实际发生顺序分配");
  second.settle({ status: "accepted" });

  const [queried] = await queryPromise;
  assert.equal(queried.result.status, "accepted", "query 没有拿到 in-flight 命令的最终终态");
});

test("(2) 锁序是 per-session 的：A 会话 gate 被持有时，B 会话照常准入", async () => {
  const { inbox } = makeInbox();
  const a = await inbox.handle(envelope({ commandId: "cmd_a2", sessionId: SESSION }));
  assert.equal(a.kind, "execute");

  // A 未 settle（session gate 持有中）；B 桶的 gate 独立，不得被全局化。
  const b = await inbox.handle(envelope({ commandId: "cmd_b2", sessionId: OTHER_SESSION }));
  assert.equal(b.kind, "execute", "跨会话被同一 session gate 挡住：per-session gate 退化成了全局锁");
  assert.equal(b.admissionSeq, 1, "admissionSeq 没有按 session 分桶：B 桶第一条必须是 1");

  a.settle({ status: "accepted" });
  b.settle({ status: "accepted" });
});

// ── 不变量 2：settle 前不放行 + 共享 final + settle 幂等 ──────────────

test("(3) 在飞 duplicate 共享同一个 final promise：拿终态而非 admission ACK，settle 幂等", async () => {
  const { inbox } = makeInbox();
  const raw = envelope({ commandId: "cmd_collapse" });
  const first = await inbox.handle(raw);
  assert.equal(first.kind, "execute");
  assert.equal(first.ack.status, "accepted");

  // 同 key 并发第二条：key gate 串行后命中 inFlight pin，挂在 final 上，settle 前不得返回。
  const concurrent = inbox.handle(raw);
  let concurrentSettled = false;
  void concurrent.then(() => {
    concurrentSettled = true;
  });
  await tick();
  assert.equal(concurrentSettled, false, "在飞 duplicate 提前拿到了 admission ACK（历史坑回退）");

  first.settle({ result: { inputId: "in_x", type: "inputAccepted" }, status: "accepted" });
  const dup = await concurrent;
  assert.equal(dup.kind, "ack");
  assert.equal(dup.ack.status, "duplicate");
  assert.deepEqual(dup.ack.result, { inputId: "in_x", type: "inputAccepted" });

  // settle 幂等：第二次 settle 不得改写已记录的终态。
  first.settle({ reasonCode: "fault.late", status: "failed" });
  const settled = await queryOne(inbox, "cmd_collapse");
  assert.equal(settled.status, "accepted");
  assert.equal(settled.reasonCode, undefined);
});

// ── 不变量 3：CAS 拒 stale ────────────────────────────────────────────

test("(4) CAS：revision/logEpoch 不符一律 stale 且不产出 execute、不消耗 admissionSeq", async () => {
  const { inbox } = makeInbox();

  const staleRev = await inbox.handle(
    envelope({
      baseRevision: 6,
      commandId: "cmd_cas_rev",
      payload: { autoDrain: true },
      type: "setAutoDrain",
    }),
  );
  assert.equal(staleRev.kind, "ack", "CAS 不符却产出了 execute");
  assert.equal(staleRev.ack.status, "stale");
  assert.equal(staleRev.ack.reasonCode, "proto.staleRevision");
  assert.equal(staleRev.ack.revisionAtDecision, 7);

  // row-targeting 命令先校验 epoch，再校验 revision。
  const staleEpoch = await inbox.handle(
    envelope({
      baseLogEpoch: "epoch-STALE",
      baseRevision: 7,
      commandId: "cmd_cas_epoch",
      payload: { feedback: "like", target: { entityId: "row-1", rowId: 1 } },
      type: "setAssistantFeedback",
    }),
  );
  assert.equal(staleEpoch.kind, "ack");
  assert.equal(staleEpoch.ack.status, "stale");
  assert.equal(staleEpoch.ack.reasonCode, "proto.staleLogEpoch");

  // 两者都对 → admit，且它是第一条消耗 admissionSeq 的命令（上面两条丢弃不得占位）。
  const ok = await inbox.handle(
    envelope({
      baseLogEpoch: LOG_EPOCH,
      baseRevision: 7,
      commandId: "cmd_cas_ok",
      payload: { feedback: "like", target: { entityId: "row-1", rowId: 1 } },
      type: "setAssistantFeedback",
    }),
  );
  assert.equal(ok.kind, "execute");
  assert.equal(ok.admissionSeq, 1);
  ok.settle({ status: "accepted" });
});

// ── 不变量 4：admissionSeq 权威顺序 ──────────────────────────────────

test("(5) admissionSeq：桶内按 admission 顺序严格递增，queueItemId 与 commandId 一一对应", async () => {
  const { inbox } = makeInbox();
  const seqs = [];
  for (const commandId of ["cmd_s1", "cmd_s2", "cmd_s3"]) {
    const outcome = await inbox.handle(envelope({ commandId }));
    assert.equal(outcome.kind, "execute");
    seqs.push(outcome.admissionSeq);
    assert.equal(outcome.queueItemId, queueItemIdForCommand(commandId));
    outcome.settle({ status: "accepted" });
  }
  assert.deepEqual(seqs, [1, 2, 3], "admissionSeq 不是桶内严格递增的权威顺序");
});

// ── 不变量 5：三态分离（>512 churn 不淘汰 pin）───────────────────────

test("(6) 三态分离：>512 settled churn 不淘汰 in-flight 与 live pin；LRU 按容量淘汰最旧", async () => {
  const { inbox } = makeInbox();
  const limit = PROTOCOL_V4_LIMITS.idempotencyTablePerSession;
  assert.equal(limit, 512, "LRU 容量常量变了：本用例的 churn 规模需随之复核");

  // 一条 in-flight 命令（session gate 持有到用例末尾才 settle）+ 一条 live input pin。
  const pinned = await inbox.handle(envelope({ commandId: "cmd_pinned" }));
  assert.equal(pinned.kind, "execute");
  inbox.pinLiveInput(SESSION, liveIntent("cmd_live"), {
    commandId: "cmd_live",
    revisionAtDecision: 7,
    status: "accepted",
  });

  // churn：limit+88 次 pin+release（gateway 对 queue/guide 输入的生命周期用法），
  // 足以把 settled LRU 整体冲一遍。旧单表设计此时已把 in-flight 的 cmd_pinned 淘汰。
  const churnTotal = limit + 88;
  for (let index = 0; index < churnTotal; index += 1) {
    const commandId = `cmd_churn_${index}`;
    inbox.pinLiveInput(SESSION, liveIntent(commandId));
    inbox.releaseLiveInput(
      { commandId, sessionId: SESSION },
      { commandId, revisionAtDecision: 7, status: "accepted" },
    );
  }

  // in-flight pin 仍在：duplicate 挂在同一个 final 上（settle 前不返回），settle 后折叠成
  // duplicate 而不是被重新 admit（= 双重执行，正是历史坑的形状）。
  const dupPromise = inbox.handle(envelope({ commandId: "cmd_pinned" }));
  let dupSettled = false;
  void dupPromise.then(() => {
    dupSettled = true;
  });
  await tick();
  assert.equal(dupSettled, false, "in-flight 命令被 churn 淘汰：duplicate 提前放行");
  pinned.settle({ status: "accepted" });
  const dup = await dupPromise;
  assert.equal(dup.kind, "ack");
  assert.equal(dup.ack.status, "duplicate", "churn 后 in-flight 命令被重新 admit（双重执行）");

  // live pin 不受 settled churn 触及（command-inbox.ts:229-230「settled churn 不得触及它」）。
  const live = await queryOne(inbox, "cmd_live");
  assert.equal(live.status, "accepted", "live pin 被 settled churn 淘汰了");

  // settled LRU 确实按容量淘汰了最旧条目（否则本用例对 pin 的断言是空转）。
  assert.equal(await queryOne(inbox, "cmd_churn_0"), "unknown", "最旧 settled 条目未被淘汰：LRU 容量语义变了");
  const newest = await queryOne(inbox, `cmd_churn_${churnTotal - 1}`);
  assert.equal(newest.status, "accepted");

  // 回收保护：live pin 在场时 clearSession 必须拒绝（in-flight/live 事实不能被清）。
  assert.equal(inbox.hasPinnedSessionState(SESSION), true);
  assert.equal(inbox.clearSession(SESSION), false, "clearSession 清掉了 pinned 事实：三态分离的回收保护失效");
  inbox.releaseLiveInput({ commandId: "cmd_live", sessionId: SESSION });
  assert.equal(inbox.hasPinnedSessionState(SESSION), false);
  assert.equal(inbox.clearSession(SESSION), true);
});

// ── 不变量文字在案（防注释被静默删除）────────────────────────────────

test("(7) 五条不变量的约定文字与 §B/§C 的 spec 互引在案", async () => {
  const source = await read(`${CLI}/bootstrap/src/acode-protocol-v4/command-inbox.ts`);
  // 三态分离是模块头的第一句声明（:1-2）。
  assert.match(source, /三类事实严格分离/u, "模块头的三态分离声明缺失");
  assert.match(source, /只有 settled 进入 512\/session LRU/u);
  // 锁序与持有到 settle（:139-141）。
  assert.match(source, /固定锁序：key gate → per-session admission gate/u, "锁序约定文字缺失");
  assert.match(source, /session gate 持有到 settle/u);
  // 先 pin 再释放 key gate 的历史坑记录（:178-180）。
  assert.match(source, /新命令先 pin，再释放 key gate/u, "pin-before-release 的约定文字缺失");
  // 共享 final 的理由（:203-205）与 retryAck 的终态事实（:476）。
  assert.match(source, /所有同 key 请求必须共享这一个/u, "共享 final 的约定文字缺失");
  assert.match(source, /failed 是终态事实/u, "retryAck 的终态约定文字缺失");
  // §B（修正项 #4/#6）：remember 非对称的文档化理由 + 死分支取舍的 spec 互引。
  assert.match(source, /CAS \/ guard 的丢弃一律 `remember: false`/u, "remember 非对称约定文字缺失");
  assert.match(source, /noop` 必须 `remember: true`/u);
  assert.match(source, /specs\/command-terminal-state-audit\.md §B/u, "§B 的 spec 互引消失了");
});
