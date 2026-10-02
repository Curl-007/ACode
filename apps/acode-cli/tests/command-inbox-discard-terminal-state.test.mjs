import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * D3 审计问题 2 的证据测试：admission 丢弃路径的终态可观察性。
 *
 * 覆盖规格 apps/acode-cli/specs/command-terminal-state-audit.md 的 R1 问题 2（2a/2b/2c）
 * 与 R2 的 E1/E2/E3。驱动的是**真实** CommandInbox（不是复制品），宿主用桩件。
 *
 * 审计结论（本文件钉住的部分）：
 *   - 每条丢弃路径都有**同步 ack** 回到调用方（status + reasonCode），不是静默丢弃；
 *   - `remember: false` 的丢弃**不进** settled LRU，也不落盘 → 晚到 duplicate 的
 *     `query()` 得到 `"unknown"`；
 *   - 但重试是**幂等**的：丢弃路径不分配 admissionSeq、不产出 execute、不建 session_input，
 *     同一信封重放得到同一裁决；
 *   - `remember: false` 对 CAS 丢弃是**必需**的，不是遗漏：若把 stale 记进 LRU，
 *     客户端修正 baseRevision 后用同一 commandId 重试会被 `lookupExact` 短路成 duplicate，
 *     永远无法被 admit（见 (7)）；
 *   - `lookupDiscardedCommand` 在生产宿主里**已装配**（v4-bridge → persistentCommands.lookup
 *     ("discarded", …)），但它的事实来源只有 session_input 行，即只覆盖「已 admit 后被
 *     cancel/discard」的命令，覆盖不到 admission 前的 CAS/guard 丢弃。
 */

const { CommandInbox, queueItemIdForCommand } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/command-inbox.ts"
);
const { parseCommandEnvelope } = await import(
  "../../../packages/shared/src/acode-protocol-v4/command.ts"
);

const SESSION = "sess_d3_audit";
const LOG_EPOCH = "epoch-1";

function envelope(overrides) {
  return {
    clientId: "client-d3",
    commandId: "cmd_d3_1",
    issuedAt: 1_700_000_000_000,
    payload: {},
    sessionId: SESSION,
    type: "stop",
    ...overrides,
  };
}

/** 默认宿主：会话存在、revision=7、epoch=epoch-1、无 row-target/业务 guard。 */
function makeHost(overrides = {}) {
  const calls = { guard: 0, rowTarget: 0, lookups: [] };
  const host = {
    calls,
    getLogEpoch: (sessionId) => (sessionId === SESSION ? LOG_EPOCH : null),
    getRevision: (sessionId) => (sessionId === SESSION ? 7 : null),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return host;
}

function makeInbox(hostOverrides = {}) {
  const host = makeHost(hostOverrides);
  return { host, inbox: new CommandInbox(host) };
}

async function ackOf(inbox, raw) {
  const outcome = await inbox.handle(raw);
  assert.equal(outcome.kind, "ack", `期望丢弃路径返回 ack，实际 ${outcome.kind}`);
  return outcome.ack;
}

async function queryOne(inbox, commandId, sessionId = SESSION) {
  const [row] = await inbox.query([{ commandId, sessionId }]);
  return row.result;
}

// ── 2a：逐条丢弃路径 ────────────────────────────────────────────────

test("(1) proto.invalidPayload：解析失败走 ackOnly，同步 ack 到达且不进 LRU", async () => {
  const { inbox } = makeInbox();
  const ack = await ackOf(inbox, { commandId: "cmd_bad", type: "stop" });
  assert.equal(ack.status, "rejected");
  assert.equal(ack.reasonCode, "proto.invalidPayload");
  assert.equal(ack.commandId, "cmd_bad");
  assert.equal(await queryOne(inbox, "cmd_bad"), "unknown");
  // 重放同一坏信封：同样裁决，无副作用。
  const again = await ackOf(inbox, { commandId: "cmd_bad", type: "stop" });
  assert.equal(again.reasonCode, "proto.invalidPayload");
  assert.equal(again.status, "rejected", "坏信封重放不得被折叠成 duplicate");
});

test("(1b) 无 commandId 的坏信封仍回 ack，但 commandId 为空串（不可被 query 指名）", async () => {
  const { inbox } = makeInbox();
  const ack = await ackOf(inbox, { type: "stop" });
  assert.equal(ack.status, "rejected");
  assert.equal(ack.reasonCode, "proto.invalidPayload");
  assert.equal(ack.commandId, "");
});

test("(2) proto.sessionNotFound：未知会话被拒，同步 ack 到达且不进 LRU", async () => {
  const { inbox } = makeInbox();
  const ack = await ackOf(inbox, envelope({ commandId: "cmd_nosess", sessionId: "sess_ghost" }));
  assert.equal(ack.status, "rejected");
  assert.equal(ack.reasonCode, "proto.sessionNotFound");
  assert.equal(ack.revisionAtDecision, 0);
  assert.equal(await queryOne(inbox, "cmd_nosess", "sess_ghost"), "unknown");
});

test("(3) proto.missingBaseRevision 经 handle() 不可达：parse 先拒成 invalidPayload", async () => {
  // setAutoDrain ∈ COMMANDS_REQUIRING_BASE_REVISION；缺 baseRevision 时
  // parseCommandEnvelope 直接失败（command.ts 的 CAS 收口），decide() 的那条分支永不执行。
  const parsed = parseCommandEnvelope(
    envelope({ commandId: "cmd_nobr", payload: { autoDrain: true }, type: "setAutoDrain" }),
  );
  assert.equal(parsed.ok, false);

  const { inbox } = makeInbox();
  const ack = await ackOf(
    inbox,
    envelope({ commandId: "cmd_nobr", payload: { autoDrain: true }, type: "setAutoDrain" }),
  );
  assert.equal(ack.reasonCode, "proto.invalidPayload");
  assert.notEqual(ack.reasonCode, "proto.missingBaseRevision");
});

test("(4) proto.staleLogEpoch：row-targeting 命令 epoch 不匹配 → stale，同步 ack 到达", async () => {
  const { inbox } = makeInbox();
  const ack = await ackOf(
    inbox,
    envelope({
      baseLogEpoch: "epoch-STALE",
      baseRevision: 7,
      commandId: "cmd_epoch",
      payload: { feedback: "like", target: { entityId: "row-1", rowId: 1 } },
      type: "setAssistantFeedback",
    }),
  );
  assert.equal(ack.status, "stale");
  assert.equal(ack.reasonCode, "proto.staleLogEpoch");
  assert.equal(ack.revisionAtDecision, 7);
  assert.equal(await queryOne(inbox, "cmd_epoch"), "unknown");
});

test("(5) proto.staleRevision：CAS revision 不匹配 → stale，同步 ack 到达", async () => {
  const { inbox } = makeInbox();
  const raw = envelope({
    baseRevision: 6,
    commandId: "cmd_rev",
    payload: { autoDrain: true },
    type: "setAutoDrain",
  });
  const ack = await ackOf(inbox, raw);
  assert.equal(ack.status, "stale");
  assert.equal(ack.reasonCode, "proto.staleRevision");
  assert.equal(ack.revisionAtDecision, 7);
  assert.equal(await queryOne(inbox, "cmd_rev"), "unknown");

  // 2b 重试幂等：同一信封重放得到同一裁决，且从未产出 execute（= 从未执行、无第二次副作用）。
  for (let round = 0; round < 3; round += 1) {
    const again = await inbox.handle(raw);
    assert.equal(again.kind, "ack");
    assert.equal(again.ack.status, "stale");
    assert.equal(again.ack.reasonCode, "proto.staleRevision");
  }
});

test("(6) row-target guard 的 stale / reject：同步 ack 到达且不进 LRU", async () => {
  const staleInbox = makeInbox({
    validateRowTarget: (env) => {
      assert.equal(env.type, "setAssistantFeedback");
      return { message: "row gone", reasonCode: "proto.staleTarget", verdict: "stale" };
    },
  }).inbox;
  const staleAck = await ackOf(
    staleInbox,
    envelope({
      baseLogEpoch: LOG_EPOCH,
      baseRevision: 7,
      commandId: "cmd_row_stale",
      payload: { feedback: "like", target: { entityId: "row-1", rowId: 1 } },
      type: "setAssistantFeedback",
    }),
  );
  assert.equal(staleAck.status, "stale");
  assert.equal(staleAck.reasonCode, "proto.staleTarget");
  assert.equal(staleAck.message, "row gone");
  assert.equal(await queryOne(staleInbox, "cmd_row_stale"), "unknown");

  const rejectInbox = makeInbox({
    validateRowTarget: () => ({ reasonCode: "guard.rowNotFeedbackable", verdict: "reject" }),
  }).inbox;
  const rejectAck = await ackOf(
    rejectInbox,
    envelope({
      baseLogEpoch: LOG_EPOCH,
      baseRevision: 7,
      commandId: "cmd_row_reject",
      payload: { feedback: "like", target: { entityId: "row-1", rowId: 1 } },
      type: "setAssistantFeedback",
    }),
  );
  assert.equal(rejectAck.status, "rejected");
  assert.equal(rejectAck.reasonCode, "guard.rowNotFeedbackable");
  assert.equal(await queryOne(rejectInbox, "cmd_row_reject"), "unknown");
});

test("(6b) 业务 guard 的 stale / reject / noop：生产宿主未装配 guard，三条分支当前不可达", async () => {
  // 证据：全仓只有一处 `new CommandInbox(`（v4-gateway.ts），它不提供 guard；
  // 于是 decide() 的 `this.host.guard?.(envelope) ?? { verdict: "allow" }` 恒为 allow。
  const { inbox } = makeInbox();
  const outcome = await inbox.handle(envelope({ commandId: "cmd_allow", payload: { autoDrain: true }, baseRevision: 7, type: "setAutoDrain" }));
  assert.equal(outcome.kind, "execute", "无 guard 时 CAS 通过的命令必须被 admit");
  outcome.settle({ status: "accepted" });

  // 装上 guard 后三条分支各自可达（说明代码本身正确，只是生产未接线）。
  for (const [verdict, expectedStatus] of [
    [{ reasonCode: "guard.x", verdict: "stale" }, "stale"],
    [{ reasonCode: "guard.y", verdict: "reject" }, "rejected"],
  ]) {
    const guarded = makeInbox({ guard: () => verdict }).inbox;
    const ack = await ackOf(guarded, envelope({ commandId: `cmd_g_${expectedStatus}` }));
    assert.equal(ack.status, expectedStatus);
    assert.equal(ack.reasonCode, verdict.reasonCode);
    assert.equal(await queryOne(guarded, `cmd_g_${expectedStatus}`), "unknown");
  }
});

test("(6c) 业务 guard noop 是唯一 remember:true 的丢弃：进 LRU，晚到 query 查得到", async () => {
  const { inbox } = makeInbox({
    guard: () => ({ reasonCode: "proto.alreadyResolved", result: undefined, verdict: "noop" }),
  });
  const ack = await ackOf(inbox, envelope({ commandId: "cmd_noop" }));
  assert.equal(ack.status, "noop");
  assert.equal(ack.reasonCode, "proto.alreadyResolved");

  // 2c 的差别在这里可观察：noop 被记住 → query 非 unknown；重放被折叠成 duplicate。
  const queried = await queryOne(inbox, "cmd_noop");
  assert.notEqual(queried, "unknown");
  assert.equal(queried.status, "noop");

  const replay = await ackOf(inbox, envelope({ commandId: "cmd_noop" }));
  assert.equal(replay.status, "duplicate", "已记住的 noop 重放必须折叠成 duplicate");
  assert.equal(replay.reasonCode, "proto.alreadyResolved");
});

// ── 2c：remember 差别的必要性 ───────────────────────────────────────

test("(7) remember:false 对 CAS 丢弃是必需的：修正 baseRevision 后同 commandId 重试必须被 admit", async () => {
  const { inbox } = makeInbox();
  const commandId = "cmd_corrected";
  const staleRaw = envelope({
    baseRevision: 6,
    commandId,
    payload: { autoDrain: true },
    type: "setAutoDrain",
  });
  const first = await ackOf(inbox, staleRaw);
  assert.equal(first.status, "stale");

  // 客户端读到 revisionAtDecision=7，修正后用**同一 commandId** 重发。
  const corrected = envelope({
    baseRevision: 7,
    commandId,
    payload: { autoDrain: true },
    type: "setAutoDrain",
  });
  const outcome = await inbox.handle(corrected);
  assert.equal(
    outcome.kind,
    "execute",
    "若 stale 被记进 settled LRU，lookupExact 会先短路成 duplicate，修正重试永远无法执行",
  );
  assert.equal(outcome.ack.status, "accepted");
  assert.equal(outcome.queueItemId, queueItemIdForCommand(commandId));
  outcome.settle({ status: "accepted" });
  // settle 后才进 LRU：晚到 duplicate 拿得到终态。
  const settled = await queryOne(inbox, commandId);
  assert.equal(settled.status, "accepted");
});

// ── 晚到 duplicate 的回源路径 ───────────────────────────────────────

test("(8) lookupDiscardedCommand 被 lookupExact 消费，且排在四个回源的最后", async () => {
  const order = [];
  const { inbox } = makeInbox({
    lookupChildCommand: (key) => {
      order.push(`child:${key.commandId}`);
      return null;
    },
    lookupDiscardedCommand: (key) => {
      order.push(`discarded:${key.commandId}`);
      return {
        commandId: key.commandId,
        reasonCode: "fault.command.inputCancelled",
        revisionAtDecision: 0,
        status: "failed",
      };
    },
    lookupTimelineCommand: (key) => {
      order.push(`timeline:${key.commandId}`);
      return null;
    },
    lookupTranscriptCommand: (key) => {
      order.push(`transcript:${key.commandId}`);
      return null;
    },
  });

  const result = await queryOne(inbox, "cmd_cancelled_input");
  assert.equal(result.status, "failed");
  assert.equal(result.reasonCode, "fault.command.inputCancelled");
  assert.deepEqual(order, [
    "transcript:cmd_cancelled_input",
    "timeline:cmd_cancelled_input",
    "child:cmd_cancelled_input",
    "discarded:cmd_cancelled_input",
  ]);
});

test("(8b) 丢弃事实不落盘时，晚到 duplicate 只能得到 unknown（这是 (7) 幂等性的前提）", async () => {
  // 生产宿主的 discarded 事实只来自 session_input 行（persistent-command-facts.ts 读
  // listSessionInputs({status:"discarded"|"cancelled"})），而 admission 前的 CAS/guard 丢弃
  // 从不创建 session_input（savePersistentCommandFact 的类型只接受 "timeline"|"child"）。
  const { inbox } = makeInbox({
    lookupChildCommand: () => null,
    lookupDiscardedCommand: () => null,
    lookupTimelineCommand: () => null,
    lookupTranscriptCommand: () => null,
  });
  const raw = envelope({ baseRevision: 6, commandId: "cmd_late", payload: { autoDrain: true }, type: "setAutoDrain" });
  assert.equal((await ackOf(inbox, raw)).status, "stale");
  assert.equal(await queryOne(inbox, "cmd_late"), "unknown");
});

test("(9) retryAck：failed 是终态事实不被折叠，其余一律折叠成 duplicate", async () => {
  const facts = new Map();
  const { inbox } = makeInbox({
    lookupTranscriptCommand: (key) => facts.get(key.commandId) ?? null,
  });
  facts.set("cmd_failed", {
    commandId: "cmd_failed",
    reasonCode: "fault.command.executionFailed",
    revisionAtDecision: 7,
    status: "failed",
  });
  facts.set("cmd_accepted", { commandId: "cmd_accepted", revisionAtDecision: 7, status: "accepted" });

  const failedReplay = await ackOf(inbox, envelope({ commandId: "cmd_failed" }));
  assert.equal(failedReplay.status, "failed", "failed 不得被 duplicate 覆盖");
  assert.equal(failedReplay.reasonCode, "fault.command.executionFailed");

  const acceptedReplay = await ackOf(inbox, envelope({ commandId: "cmd_accepted" }));
  assert.equal(acceptedReplay.status, "duplicate");
});

test("(10) duplicate collapse：在飞 duplicate 共享同一个 final promise，拿终态而非 admission ACK", async () => {
  const { inbox } = makeInbox();
  const raw = envelope({ commandId: "cmd_inflight" });
  const first = await inbox.handle(raw);
  assert.equal(first.kind, "execute");
  assert.equal(first.ack.status, "accepted");
  assert.equal(first.admissionSeq, 1);

  // 第二条同 key 请求在 settle 前到达：必须挂在 final 上，不能提前拿 admission ACK 返回。
  const secondPromise = inbox.handle(raw);
  let secondSettled = false;
  void secondPromise.then(() => {
    secondSettled = true;
  });
  await Promise.resolve();
  assert.equal(secondSettled, false, "在飞 duplicate 不得在 settle 前返回");

  first.settle({ result: { inputId: "in_1", type: "inputAccepted" }, status: "accepted" });
  const second = await secondPromise;
  assert.equal(second.kind, "ack");
  assert.equal(second.ack.status, "duplicate");
  assert.deepEqual(second.ack.result, { inputId: "in_1", type: "inputAccepted" });

  // settle 幂等：第二次 settle 不改变已记录的终态。
  first.settle({ reasonCode: "fault.late", status: "failed" });
  const settled = await queryOne(inbox, "cmd_inflight");
  assert.equal(settled.status, "accepted");
  assert.equal(settled.reasonCode, undefined);
});

test("(11) admissionSeq 只为被 admit 的命令递增：丢弃路径不消耗权威顺序", async () => {
  const { inbox } = makeInbox();
  await ackOf(inbox, envelope({ baseRevision: 6, commandId: "cmd_drop_1", payload: { autoDrain: true }, type: "setAutoDrain" }));
  await ackOf(inbox, envelope({ commandId: "cmd_drop_2", sessionId: "sess_ghost" }));

  const first = await inbox.handle(envelope({ commandId: "cmd_keep_1" }));
  assert.equal(first.kind, "execute");
  assert.equal(first.admissionSeq, 1, "两条丢弃不得占用 admissionSeq");
  first.settle({ status: "accepted" });

  const second = await inbox.handle(envelope({ commandId: "cmd_keep_2" }));
  assert.equal(second.kind, "execute");
  assert.equal(second.admissionSeq, 2);
  second.settle({ status: "accepted" });
});
