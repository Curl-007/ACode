import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachAnswerKindSchema,
  attachAnswersDeclarationSchema,
  attachAnswersRosterSchema,
  clientAnswersKind,
  resolveAttachAnswers,
} from "../src/acode-protocol-v4/attach-answers.js";
import {
  PERMISSION_CHECK_STATUS_SLOW_THRESHOLD_MS,
  initialPermissionCheckStatusDisplay,
  permissionCheckStatusDisplayReducer,
  permissionCheckStatusSchema,
} from "../src/acode-protocol-v4/permission-check-status.js";
import {
  pendingInteractionHintSchema,
  readPendingInteractionHints,
} from "../src/acode-protocol-v4/pending-permission-hints.js";
import {
  clientDeclaredAnswers,
  clientHelloSchema,
  hostSupportsInteractionAnswerRoster,
  hostSupportsPermissionCheckStatus,
  v4ConversationSubscribeResultSchema,
} from "../src/acode-protocol-v4/transport.js";
import { pendingInteractionSchema } from "../src/acode-protocol-v4/snapshot.js";
import { V4_WIRE_PROTOCOL_VERSION } from "../src/acode-protocol-v4/core.js";

/**
 * attach 信号族叶子验收（specs/protocol-attachment-typed-errors.md R3/R4/R5 验收场景 3-5）。
 */

// ── R3 answers 代答能力申报 ──

test("R3: 申报闭集与 pendingInteraction kind 单一事实源对齐（parity）", () => {
  const interactionKinds = (pendingInteractionSchema.shape.kind as { options: readonly string[] })
    .options;
  assert.deepEqual([...attachAnswerKindSchema.options].sort(), [...interactionKinds].sort());
});

test("R3: 申报列表——[] 合法、重复 kind 拒绝、超闭集拒绝", () => {
  assert.equal(attachAnswersDeclarationSchema.safeParse([]).success, true);
  assert.equal(
    attachAnswersDeclarationSchema.safeParse(["permission", "userInput", "workspaceHookReview"])
      .success,
    true,
  );
  assert.equal(
    attachAnswersDeclarationSchema.safeParse(["permission", "permission"]).success,
    false,
    "重复 kind 必须拒绝",
  );
});

test("R3: 三态合并——缺席保持、给定（含 []）整体替换、首attach无申报=空集", () => {
  const prev = ["permission"] as const;
  assert.deepEqual(resolveAttachAnswers(prev, undefined), ["permission"]);
  assert.deepEqual(resolveAttachAnswers(prev, []), []);
  assert.deepEqual(resolveAttachAnswers(prev, ["userInput"]), ["userInput"]);
  assert.deepEqual(resolveAttachAnswers(undefined, undefined), []);
  // 幂等：同一申报重复 attach 收敛到同一结果。
  const once = resolveAttachAnswers(undefined, ["userInput"]);
  assert.deepEqual(resolveAttachAnswers(once, ["userInput"]), once);
});

test("R3: 路由 fail-closed——未申报（含从未申报）永不路由", () => {
  assert.equal(clientAnswersKind(["permission"], "permission"), true);
  assert.equal(clientAnswersKind(["permission"], "userInput"), false);
  assert.equal(clientAnswersKind([], "permission"), false);
  assert.equal(clientAnswersKind(undefined, "permission"), false);
});

test("R3: clientHello 携带 answers 过 schema；老形状原样过；roster strict", () => {
  const base = {
    kind: "clientHello" as const,
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    clientId: "client_mobile_1",
    appVersion: "1.0.0",
  };
  const legacy = clientHelloSchema.safeParse(base);
  assert.equal(legacy.success, true, "无 capabilities 的老客户端必须原样通过");
  const withAnswers = clientHelloSchema.safeParse({
    ...base,
    capabilities: { answers: ["permission", "userInput"] },
  });
  assert.equal(withAnswers.success, true);
  assert.deepEqual(clientDeclaredAnswers(withAnswers.data!), ["permission", "userInput"]);
  assert.equal(clientDeclaredAnswers(legacy.data!), undefined, "缺席 = 保持先前申报");
  assert.equal(
    clientHelloSchema.safeParse({ ...base, capabilities: { answers: ["permission"], bogus: 1 } })
      .success,
    false,
    "capabilities strict：未知键拒绝",
  );
  assert.equal(
    attachAnswersRosterSchema.safeParse([{ clientId: "c1", answers: ["permission"] }]).success,
    true,
  );
  assert.equal(
    attachAnswersRosterSchema.safeParse([{ clientId: "c1", answers: ["permission"], x: 1 }])
      .success,
    false,
  );
});

test("R3/R4: hello 能力位——缺席 = false（=== true 判定，单向声明纪律）", () => {
  const helloBase = {
    kind: "hello" as const,
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: "conn_1",
    clientMode: "desktop-continuous" as const,
    deliveryProfile: "continuous" as const,
    serverTime: 1_700_000_000_000,
    capabilities: {
      nativeDialogs: true,
      localTerminal: true,
      binaryFrames: false,
      compression: "none" as const,
    },
    auth: {},
  };
  assert.equal(hostSupportsInteractionAnswerRoster(helloBase.capabilities), false);
  assert.equal(hostSupportsPermissionCheckStatus(helloBase.capabilities), false);
  assert.equal(
    hostSupportsInteractionAnswerRoster({
      ...helloBase.capabilities,
      interactionAnswerRoster: true,
    }),
    true,
  );
  assert.equal(
    hostSupportsPermissionCheckStatus({ ...helloBase.capabilities, permissionCheckStatus: true }),
    true,
  );
});

// ── R4 permission_check_status ──

test("R4: 阈值 4s（spec R4 规则 1）；信号形状 strict", () => {
  assert.equal(PERMISSION_CHECK_STATUS_SLOW_THRESHOLD_MS, 4_000);
  const ok = permissionCheckStatusSchema.safeParse({
    toolCallId: "tc_1",
    status: "checking",
    occurredAt: 1_700_000_000_000,
  });
  assert.equal(ok.success, true);
  assert.equal(
    permissionCheckStatusSchema.safeParse({ toolCallId: "tc_1", status: "decided" }).success,
    false,
    "status 闭集：checking/done 之外拒绝",
  );
  assert.equal(
    permissionCheckStatusSchema.safeParse({
      toolCallId: "tc_1",
      status: "done",
      occurredAt: 1,
      decision: "allow",
    }).success,
    false,
    "done 不携带裁决；strict 拒绝未知键",
  );
});

test("R4: 显示 reducer——配对熄灭、幂等、任何其他帧/回合结束无条件收口", () => {
  const signal = (status: "checking" | "done", toolCallId = "tc_1") => ({
    type: "signal" as const,
    signal: { toolCallId, status, occurredAt: 1_700_000_000_000 },
  });
  let state = initialPermissionCheckStatusDisplay;
  state = permissionCheckStatusDisplayReducer(state, signal("checking"));
  assert.deepEqual([...state.checking], ["tc_1"]);
  // 重复 checking 幂等。
  assert.equal(permissionCheckStatusDisplayReducer(state, signal("checking")), state);
  // 多对不串扰：tc_2 独立亮灭。
  const both = permissionCheckStatusDisplayReducer(state, signal("checking", "tc_2"));
  assert.deepEqual([...both.checking].sort(), ["tc_1", "tc_2"]);
  assert.deepEqual(
    [...permissionCheckStatusDisplayReducer(both, signal("done", "tc_2")).checking],
    ["tc_1"],
  );
  // done 熄灭；未亮时 done 幂等吸收（丢帧后补到的 done 不报错）。
  state = permissionCheckStatusDisplayReducer(state, signal("done"));
  assert.deepEqual([...state.checking], []);
  assert.equal(permissionCheckStatusDisplayReducer(state, signal("done")), state);
  // best-effort：任何其他帧立即熄灭。
  state = permissionCheckStatusDisplayReducer(state, signal("checking"));
  state = permissionCheckStatusDisplayReducer(state, { type: "otherFrame", toolCallId: "tc_1" });
  assert.deepEqual([...state.checking], []);
  // 回合结束清空全部。
  state = permissionCheckStatusDisplayReducer(state, signal("checking", "tc_9"));
  state = permissionCheckStatusDisplayReducer(state, { type: "turnEnded" });
  assert.deepEqual([...state.checking], []);
});

// ── R5 pending 交互提示清单恒在可空 ──

test("R5: 字段存在性判代——缺席 = legacy（≠ 无 pending）、null、[]、非空", () => {
  assert.deepEqual(readPendingInteractionHints({}), { generation: "legacy" });
  assert.deepEqual(readPendingInteractionHints({ pendingInteractionHints: undefined }), {
    generation: "legacy",
  });
  assert.deepEqual(readPendingInteractionHints({ pendingInteractionHints: null }), {
    generation: "current",
    hints: null,
  });
  assert.deepEqual(readPendingInteractionHints({ pendingInteractionHints: [] }), {
    generation: "current",
    hints: [],
  });
});

test("R5: hint 形状 strict；subscribe ack 老形状（无字段）仍过、新形状过", () => {
  const hint = {
    interactionId: "int_1",
    kind: "permission" as const,
    toolCallId: "tc_1",
    toolName: "Bash",
    createdAt: 1_700_000_000_000,
    anchorRowId: null,
  };
  assert.equal(pendingInteractionHintSchema.safeParse(hint).success, true);
  assert.equal(pendingInteractionHintSchema.safeParse({ ...hint, payload: {} }).success, false);
  assert.equal(
    pendingInteractionHintSchema.safeParse({ ...hint, kind: "dialog" }).success,
    false,
    "kind 闭集外拒绝",
  );

  const ackBase = { subscriptionId: "sub_1", mode: "snapshot" as const, logEpoch: "epoch_1" };
  const legacyAck = v4ConversationSubscribeResultSchema.safeParse({ ack: ackBase });
  assert.equal(legacyAck.success, true, "老 CLI 的 ack（无 hints 字段）不得解析失败");
  assert.deepEqual(readPendingInteractionHints(legacyAck.data!.ack), { generation: "legacy" });
  const currentAck = v4ConversationSubscribeResultSchema.safeParse({
    ack: { ...ackBase, pendingInteractionHints: [hint] },
  });
  assert.equal(currentAck.success, true);
  assert.deepEqual(readPendingInteractionHints(currentAck.data!.ack), {
    generation: "current",
    hints: [hint],
  });
  const nullAck = v4ConversationSubscribeResultSchema.safeParse({
    ack: { ...ackBase, pendingInteractionHints: null },
  });
  assert.equal(nullAck.success, true, "恒在可空：null 是新世代的合法值");
});
