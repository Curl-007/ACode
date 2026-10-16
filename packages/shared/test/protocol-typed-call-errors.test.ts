import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SUPERSEDE_ON_REDELIVERY_COMMANDS,
  SUPERSEDED_BY_REDELIVERY_REASON_CODE,
  buildSupersededCloseOutAck,
  isSupersededCloseOutAck,
  resolveCommandRedelivery,
} from "../src/acode-protocol-v4/command-redelivery.js";
import {
  attemptedCallResultSchema,
  isNotAttemptedReasonCode,
  parseKnownTypedCallErrorCode,
  typedCallErrorSchema,
} from "../src/acode-protocol-v4/typed-call-error.js";
import { commandAckSchema, commandTypeSchema } from "../src/acode-protocol-v4/command.js";

/**
 * typed error 分层 + exactly-one commandId 取代语义的叶子验收
 * （apps/acode-cli/specs/protocol-attachment-typed-errors.md R1/R2 验收场景 1、2）。
 */

// ── R1 typed error 分层 ──

test("R1: proto.* = 根本没尝试；fault.* = 业务道，不得混层", () => {
  assert.equal(isNotAttemptedReasonCode("proto.invalidPayload"), true);
  assert.equal(isNotAttemptedReasonCode("proto.sessionNotFound"), true);
  assert.equal(
    isNotAttemptedReasonCode("fault.command.workflowRunResumeRejected.not_found"),
    false,
  );
  assert.equal(isNotAttemptedReasonCode(undefined), false);
  assert.equal(isNotAttemptedReasonCode(""), false);
});

test("R1: 未知 errorCode 收敛为缺席（additive 演进，旧消费方不崩）", () => {
  const known = ["input_missing", "output_conflict", "expired"] as const;
  assert.equal(parseKnownTypedCallErrorCode("expired", known), "expired");
  assert.equal(parseKnownTypedCallErrorCode("brand_new_code", known), undefined);
  assert.equal(parseKnownTypedCallErrorCode(42, known), undefined);
  assert.equal(parseKnownTypedCallErrorCode(undefined, known), undefined);
});

test("R1: 业务道 typed error 形状 strict——多键拒绝、errorCode 必带", () => {
  const ok = typedCallErrorSchema.safeParse({
    errorCode: "output_conflict",
    errorMessage: "etag moved",
    retryable: false,
  });
  assert.equal(ok.success, true);
  assert.equal(typedCallErrorSchema.safeParse({ errorCode: "" }).success, false);
  assert.equal(typedCallErrorSchema.safeParse({}).success, false);
  assert.equal(
    typedCallErrorSchema.safeParse({ errorCode: "x", staging: {} }).success,
    false,
    "strict：未知键必须拒绝",
  );
});

test("R1: attemptedCallResult 包络——attempted 恒真，error 缺席 = 尝试且成功", () => {
  const success = attemptedCallResultSchema.safeParse({ attempted: true });
  assert.equal(success.success, true);
  const failed = attemptedCallResultSchema.safeParse({
    attempted: true,
    error: { errorCode: "tool_error" },
  });
  assert.equal(failed.success, true);
  assert.equal(attemptedCallResultSchema.safeParse({ attempted: false }).success, false);
  assert.equal(attemptedCallResultSchema.safeParse({}).success, false);
});

// ── R2 exactly-one commandId 取代语义 ──

test("R2: 默认闭集为空——全部现役 CommandType 都是 share-final（零行为变化）", () => {
  assert.equal(SUPERSEDE_ON_REDELIVERY_COMMANDS.size, 0);
  for (const type of commandTypeSchema.options) {
    assert.deepEqual(
      resolveCommandRedelivery(type),
      { action: "share-final" },
      `现役命令 ${type} 不得默认走取代（dedupe 不变量，command-terminal-state-audit.md R3）`,
    );
  }
});

test("R2: 注入集合后返回 supersede——裁决只由闭集成员资格决定", () => {
  const injected = new Set([commandTypeSchema.options[0]]);
  assert.deepEqual(resolveCommandRedelivery(commandTypeSchema.options[0], injected), {
    action: "supersede",
  });
  for (const type of commandTypeSchema.options.slice(1)) {
    assert.deepEqual(resolveCommandRedelivery(type, injected), { action: "share-final" });
  }
});

test("R2: close-out ack 过 commandAckSchema、可判别、且不是业务终态语义", () => {
  const ack = buildSupersededCloseOutAck("cmd_1", 7);
  assert.equal(commandAckSchema.safeParse(ack).success, true);
  assert.equal(ack.status, "stale");
  assert.equal(ack.reasonCode, SUPERSEDED_BY_REDELIVERY_REASON_CODE);
  assert.equal(isSupersededCloseOutAck(ack), true);
  // 判别不得误伤其它 stale / 其它 reasonCode 的 ack。
  assert.equal(isSupersededCloseOutAck({ ...ack, reasonCode: "proto.staleRevision" }), false);
  assert.equal(isSupersededCloseOutAck({ ...ack, status: "failed" }), false);
  // close-out 在协议道命名空间（proto.*）：根本不是尝试层的事实。
  assert.equal(isNotAttemptedReasonCode(ack.reasonCode), true);
});
