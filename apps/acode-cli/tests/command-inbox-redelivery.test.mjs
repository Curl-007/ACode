import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * CommandInbox 重投递取代接线测试（specs/protocol-attachment-typed-errors.md R2 / 接线 W1）。
 *
 * 分工：shared 的 protocol-typed-call-errors.test.ts 覆盖叶子纯函数（resolveCommandRedelivery
 * 注入集、close-out 判别、默认闭集为空）；本文件驱动**真实** CommandInbox 验证接线两半：
 *
 *   A. 空集零行为变化：取代闭集默认空集时，在飞重投递保持既有 dedupe（共享 final），
 *      与 command-inbox-invariants.test.mjs 不变量 2 一致（独立复证，防接线引入回退）。
 *   B. 假想命令入集后的取代语义：对同一模块实例的 SUPERSEDE_ON_REDELIVERY_COMMANDS
 *      做测试专用临时扩展（运行时 Set 可变；叶子未提供正式扩展点，生产消费方必须用
 *      默认闭集），验证「abort 旧运行 + close-out 收口 + 旧 settle no-op + 新投递接管」
 *      的完整链路；finally 恢复空集，防止污染同进程其他用例。
 *
 * 模块实例同一性前提：command-inbox.ts 经 "@acode/shared/acode-protocol-v4"（package
 * exports 直指 src/*.ts）与本文件的相对路径导入解析到同一 realpath——用例 B 开头的
 * 同一性断言钉住该前提，实例分裂时用例会显式失败而非静默空转。
 */

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const CLI = "apps/acode-cli/packages";

const { CommandInbox, queueItemIdForCommand } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/command-inbox.ts"
);
const {
  SUPERSEDE_ON_REDELIVERY_COMMANDS,
  SUPERSEDED_BY_REDELIVERY_REASON_CODE,
  isSupersededCloseOutAck,
  resolveCommandRedelivery,
} = await import("../../../packages/shared/src/acode-protocol-v4/command-redelivery.ts");

const SESSION = "sess_redel_a";
const LOG_EPOCH = "epoch-r1";
const HYPOTHETICAL_COMMAND = "stop";

function envelope(overrides) {
  return {
    clientId: "client-redel",
    commandId: "cmd_redel_1",
    issuedAt: 1_700_000_000_000,
    payload: {},
    sessionId: SESSION,
    type: HYPOTHETICAL_COMMAND,
    ...overrides,
  };
}

function makeInbox(hostOverrides = {}) {
  const abortCalls = [];
  const host = {
    getLogEpoch: () => LOG_EPOCH,
    getRevision: () => 7,
    now: () => 1_700_000_000_000,
    abortInFlightCommand: (aborted) => {
      abortCalls.push(aborted);
    },
    ...hostOverrides,
  };
  return { abortCalls, host, inbox: new CommandInbox(host) };
}

function liveIntent(commandId) {
  return {
    admittedAt: 1_700_000_000_000,
    attachments: [],
    clientId: "client-redel",
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

// ── A. 空集零行为变化 ────────────────────────────────────────────────

test("(A1) 取代闭集默认为空集：全部现役命令类型的重投递裁决是 share-final", () => {
  assert.equal(SUPERSEDE_ON_REDELIVERY_COMMANDS.size, 0, "默认闭集不再是空集：产品决策变了，本套件与 spec R2 规则 3 需同步复核");
  assert.deepEqual(resolveCommandRedelivery(HYPOTHETICAL_COMMAND), { action: "share-final" });
});

test("(A2) 空集下在飞重投递仍是 dedupe：共享 final、拿业务终态、abort 口零调用", async () => {
  const { abortCalls, inbox } = makeInbox();
  const raw = envelope({ commandId: "cmd_dedupe" });
  const first = await inbox.handle(raw);
  assert.equal(first.kind, "execute");

  const concurrent = inbox.handle(raw);
  let concurrentSettled = false;
  void concurrent.then(() => {
    concurrentSettled = true;
  });
  await tick();
  assert.equal(concurrentSettled, false, "空集下重投递提前返回：既有 dedupe 语义被接线破坏");

  assert.equal(first.settle({ result: { inputId: "in_r", type: "inputAccepted" }, status: "accepted" }), undefined, "非取代投递的 settle 不得返回 close-out");
  const dup = await concurrent;
  assert.equal(dup.kind, "ack");
  assert.equal(dup.ack.status, "duplicate");
  assert.deepEqual(dup.ack.result, { inputId: "in_r", type: "inputAccepted" });
  assert.deepEqual(abortCalls, [], "空集下 abortInFlightCommand 不得被调用（惰性路径零行为变化）");
});

// ── B. 假想命令入集后的取代语义（测试专用闭集扩展点） ────────────────

test("(B1) 入集命令的在飞重投递：abort 旧运行 + 新 admission 接管 + 旧 settle 收口为 close-out", async () => {
  // 模块实例同一性前提（见文件头注）：本测试文件与 command-inbox.ts 必须共享同一个
  // 闭集 Set 实例，否则下面的 add 对 inbox 不可见、用例会静默空转。
  SUPERSEDE_ON_REDELIVERY_COMMANDS.add(HYPOTHETICAL_COMMAND);
  assert.deepEqual(
    resolveCommandRedelivery(HYPOTHETICAL_COMMAND),
    { action: "supersede" },
    "闭集扩展对裁决不可见：测试与 inbox 的模块实例分裂",
  );
  try {
    const { abortCalls, inbox } = makeInbox();
    const first = await inbox.handle(envelope({ commandId: "cmd_sup" }));
    assert.equal(first.kind, "execute");
    assert.equal(first.admissionSeq, 1);

    // 重投递：不再是 duplicate——取代旧投递并按新 admission 接管。
    const second = await inbox.handle(envelope({ commandId: "cmd_sup", issuedAt: 1_700_000_009_999 }));
    assert.equal(second.kind, "execute", "入集命令的重投递没有走取代接管");
    assert.equal(second.admissionSeq, 2, "取代后的新投递必须消耗新的权威 admission 位次");

    // abort 指向旧投递的原始信封（旧世代 issuedAt），且只调用一次。
    assert.equal(abortCalls.length, 1);
    assert.equal(abortCalls[0].commandId, "cmd_sup");
    assert.equal(abortCalls[0].issuedAt, 1_700_000_000_000, "abort 没有精确指向旧投递的信封");

    // 旧 settle：返回 close-out（stale + proto.supersededByRedelivery），不产出业务事实。
    const closeOut = first.settle({ message: "aborted", reasonCode: "fault.command.aborted", status: "failed" });
    assert.ok(closeOut, "被取代投递的 settle 必须返回 close-out ack 供旧 wire 投递收口");
    assert.equal(isSupersededCloseOutAck(closeOut), true);
    assert.equal(closeOut.status, "stale");
    assert.equal(closeOut.reasonCode, SUPERSEDED_BY_REDELIVERY_REASON_CODE);

    // exactly-one：旧 failed 终态不得进 settled LRU——query 挂在新投递的 final 上。
    const queried = inbox.query([{ commandId: "cmd_sup", sessionId: SESSION }]);
    let querySettled = false;
    void queried.then(() => {
      querySettled = true;
    });
    await tick();
    assert.equal(querySettled, false, "旧 settle 污染了事实层：query 没有挂在新投递的 final 上");

    assert.equal(second.settle({ status: "accepted" }), undefined);
    const [row] = await queried;
    assert.equal(row.result.status, "accepted", "业务终态必须由新投递唯一持有");
    assert.equal(row.result.reasonCode, undefined);

    // settle 后再重投递：命中 settled 事实折叠成 duplicate（不再二次取代/二次执行）。
    const third = await inbox.handle(envelope({ commandId: "cmd_sup" }));
    assert.equal(third.kind, "ack");
    assert.equal(third.ack.status, "duplicate");
    assert.equal(abortCalls.length, 1, "settled 后的重投递不得再触发 abort");
  } finally {
    SUPERSEDE_ON_REDELIVERY_COMMANDS.delete(HYPOTHETICAL_COMMAND);
  }
  assert.deepEqual(resolveCommandRedelivery(HYPOTHETICAL_COMMAND), { action: "share-final" }, "闭集恢复失败：测试污染了默认空集");
});

test("(B2) 取代接管 session FIFO：旧投递的 gate 提前释放，同 session 后续命令不死锁", async () => {
  SUPERSEDE_ON_REDELIVERY_COMMANDS.add(HYPOTHETICAL_COMMAND);
  try {
    const { inbox } = makeInbox();
    const first = await inbox.handle(envelope({ commandId: "cmd_fifo_old" }));
    assert.equal(first.kind, "execute");

    const second = await inbox.handle(envelope({ commandId: "cmd_fifo_old" }));
    assert.equal(second.kind, "execute");

    // 同 session 另一命令：session gate 已被取代交接给新投递，settle 前不放行（既有锁序）。
    const otherPromise = inbox.handle(envelope({ commandId: "cmd_fifo_other" }));
    let otherSettled = false;
    void otherPromise.then(() => {
      otherSettled = true;
    });
    await tick();
    assert.equal(otherSettled, false, "settle 前放行了同 session 的下一条命令：持有到 settle 的不变量被破坏");

    // 旧 settle（no-op 收口）不得释放新投递持有的 gate。
    first.settle({ status: "failed" });
    await tick();
    assert.equal(otherSettled, false, "旧投递的 suppressed settle 误释放了新一代的 session gate");

    second.settle({ status: "accepted" });
    const other = await otherPromise;
    assert.equal(other.kind, "execute");
    other.settle({ status: "accepted" });
  } finally {
    SUPERSEDE_ON_REDELIVERY_COMMANDS.delete(HYPOTHETICAL_COMMAND);
  }
});

test("(B3) 旧 live pin 被压制：lookupExact 不短路、旧 release 不写 settled LRU", async () => {
  SUPERSEDE_ON_REDELIVERY_COMMANDS.add(HYPOTHETICAL_COMMAND);
  try {
    const { inbox } = makeInbox();
    const first = await inbox.handle(envelope({ commandId: "cmd_live_sup" }));
    assert.equal(first.kind, "execute");
    // gateway 对 durable input 的用法：admission 后 pin 完整 intent。
    inbox.pinLiveInput(SESSION, liveIntent("cmd_live_sup"), {
      commandId: "cmd_live_sup",
      revisionAtDecision: 7,
      status: "accepted",
    });

    // 重投递不得被旧 live pin 的 admission ACK 短路成 duplicate。
    const second = await inbox.handle(envelope({ commandId: "cmd_live_sup" }));
    assert.equal(second.kind, "execute", "旧 live pin 短路了取代接管");

    // 旧投递被 abort 后的失败收口：releaseLiveInput 必须静默（不入 settled LRU）。
    inbox.releaseLiveInput(
      { commandId: "cmd_live_sup", sessionId: SESSION },
      { commandId: "cmd_live_sup", reasonCode: "fault.command.inputCancelled", status: "failed" },
    );

    assert.equal(second.settle({ status: "accepted" }), undefined);
    const settled = await queryOne(inbox, "cmd_live_sup");
    assert.equal(settled.status, "accepted", "旧 live release 的 failed 终态污染了 settled LRU");
    assert.equal(settled.reasonCode, undefined);
  } finally {
    SUPERSEDE_ON_REDELIVERY_COMMANDS.delete(HYPOTHETICAL_COMMAND);
  }
});

// ── C. 接线文字在案（防接线被静默拆除） ──────────────────────────────

test("(C1) inbox/gateway 的取代接线文字与调用点在案", async () => {
  const inboxSource = await read(`${CLI}/bootstrap/src/acode-protocol-v4/command-inbox.ts`);
  // 两处 pinned 分支都必须经 resolveCommandRedelivery 裁决（R2/W1）。
  const redeliveryCalls = inboxSource.match(/resolveCommandRedelivery\(envelope\.type\)/gu) ?? [];
  assert.equal(redeliveryCalls.length, 2, "pinned 分支的 resolveCommandRedelivery 接线少于两处");
  assert.match(inboxSource, /abortInFlightCommand\?\(envelope: CommandEnvelope\)/u, "CommandInboxHost 的可选 abort 口缺失");
  assert.match(inboxSource, /suppressed/u, "InFlightEntry 的 suppressed 位缺失");
  assert.match(inboxSource, /buildSupersededCloseOutAck/u, "close-out 收口接线缺失");

  const gatewaySource = await read(`${CLI}/bootstrap/src/acode-protocol-v4/v4-gateway.ts`);
  assert.match(gatewaySource, /abortInFlightCommand: \(envelope\) => this\.abortInFlightCommand\(envelope\)/u, "gateway 未把 abort 回调接进 CommandInbox host");
  assert.match(gatewaySource, /queueItemIdForCommand\(envelope\.commandId\)/u, "gateway abort 的队列项定位接线缺失");
  assert.match(gatewaySource, /abortRunningTurn\?/u, "V4GatewayHost 的执行中 stop 通道缺失");
  assert.match(gatewaySource, /SUPERSEDED_BY_REDELIVERY_REASON_CODE/u, "gateway abort 的 reasonCode 接线缺失");

  const bridgeSource = await read(`${CLI}/bootstrap/src/acode-protocol-v4/v4-binder.ts`);
  assert.match(bridgeSource, /abortRunningTurn: \(sessionId, reasonCode\)/u, "v4-bridge 的 stop 通道实现缺失");
});
