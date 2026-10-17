import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * commandId 重投递裁决 × CommandInbox admission 的非回退验收
 * （apps/acode-cli/specs/protocol-attachment-typed-errors.md R2 验收场景 2）。
 *
 * 分工：shared/test/protocol-typed-call-errors.test.ts 覆盖叶子本身；本文件驱动**真实**
 * CommandInbox（宿主桩件，与 command-inbox-invariants.test.mjs 同一约定）证明：默认空集下
 * 在飞重投递仍是 dedupe（共享 final、duplicate 收口），新叶子落地没有扰动既有 admission
 * 不变量（command-terminal-state-audit.md R3）。取代路径的 inbox 接线是 spec W1（跨所有权，
 * 本批不实现），入集评审时以本文件的裁决矩阵为激活面。
 */

const { CommandInbox } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/command-inbox.ts"
);
const {
  SUPERSEDE_ON_REDELIVERY_COMMANDS,
  buildSupersededCloseOutAck,
  isSupersededCloseOutAck,
  resolveCommandRedelivery,
} = await import("../../../packages/shared/src/acode-protocol-v4/command-redelivery.ts");
const { commandTypeSchema } = await import(
  "../../../packages/shared/src/acode-protocol-v4/command.ts"
);

const SESSION = "sess_redeliv";
const LOG_EPOCH = "epoch-1";

function envelope(overrides) {
  return {
    clientId: "client_redeliv",
    commandId: "cmd_redeliv_1",
    issuedAt: 1_700_000_000_000,
    payload: {},
    sessionId: SESSION,
    type: "stop",
    ...overrides,
  };
}

function makeInbox() {
  const host = {
    getLogEpoch: (sessionId) => (sessionId === SESSION ? LOG_EPOCH : null),
    getRevision: (sessionId) => (sessionId === SESSION ? 7 : null),
    now: () => 1_700_000_000_000,
  };
  return new CommandInbox(host);
}

test("R2: 裁决矩阵——全部现役 CommandType 默认 share-final，闭集为空", async () => {
  assert.equal(SUPERSEDE_ON_REDELIVERY_COMMANDS.size, 0);
  for (const type of commandTypeSchema.options) {
    assert.deepEqual(resolveCommandRedelivery(type), { action: "share-final" });
  }
  // 注入集合才产生 supersede——裁决是闭集成员资格的纯函数，与 host/连接无关。
  assert.deepEqual(resolveCommandRedelivery("stop", new Set(["stop"])), { action: "supersede" });
});

test("R2 非回退: 在飞重投递仍 dedupe——共享 final、duplicate 收口、恰好一个业务终态", async () => {
  const inbox = makeInbox();
  const first = await inbox.handle(envelope());
  assert.equal(first.kind, "execute");

  // 同 commandId 重投递：挂在同一个 final 上，settle 前不得提前返回（历史坑：提前拿 admission ACK）。
  let duplicateSettled = false;
  const duplicatePromise = inbox.handle(envelope()).then((outcome) => {
    duplicateSettled = true;
    return outcome;
  });
  await Promise.resolve();
  assert.equal(duplicateSettled, false, "在飞 duplicate 提前放行（dedupe 不变量回退）");

  first.settle({ status: "accepted" });
  const duplicate = await duplicatePromise;
  assert.equal(duplicate.kind, "ack");
  assert.equal(duplicate.ack.status, "duplicate", "重投递必须折叠成 duplicate 而非二次 execute");
  assert.equal(duplicate.ack.commandId, "cmd_redeliv_1");

  // 第二次重投递（settled 后）同样折叠——每 commandId 恰好一个业务终态。
  const afterSettle = await inbox.handle(envelope());
  assert.equal(afterSettle.kind, "ack");
  assert.equal(afterSettle.ack.status, "duplicate");
});

test("R2: close-out ack 形状可被 inbox 词表消费（stale + proto.* 协议道），且不与业务终态混淆", () => {
  const closeOut = buildSupersededCloseOutAck("cmd_redeliv_1", 7);
  assert.equal(closeOut.status, "stale");
  assert.equal(isSupersededCloseOutAck(closeOut), true);
  // CommandInbox.retryAck 的既有约定：failed 终态不被折叠成 duplicate；stale close-out
  // 走协议道命名空间（proto.*），与业务 fault.* 词表分层（typed-call-error.ts R1）。
  assert.equal(closeOut.reasonCode.startsWith("proto."), true);
});
