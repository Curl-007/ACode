// 回合收尾协议投影验收（apps/acode-cli/specs/turn-wrap-up.md 场景 4/5）。
//
// 场景 4：TurnWrapUp 的 tool_call_scheduled → tool_call_result 经真 ProductProjection
// 产出 toolCall row，载荷在 row.input 上逐字节存活（live 与 hydration 共用同一条事件路径，
// hydration = 持久化事件重放，因此本测试同时覆盖两条路径的投影语义）。
// 场景 5：旧客户端安全忽略——全部 delta 与快照过既有 wire schema（不含任何 wrap-up 知识），
// 并负向断言 conversationRowSchema 的 kind 闭集没有出现 wrap-up 成员：承载通道必须是
// input（z.unknown 透传），任何人把它改成新 row kind 都会让旧客户端整帧拒收（spec §2.2）。
import assert from "node:assert/strict";
import test from "node:test";

const { ProductProjection } =
  await import("../packages/bootstrap/src/acode-protocol-v4/product-projection.ts");
const { conversationDeltaSchema, conversationRowSchema, conversationSnapshotSchema } =
  await import("../../../packages/shared/src/acode-protocol-v4/index.ts");

const SID = "sess-turn-wrapup-projection";
const PAYLOAD = {
  recap: "Landed the retry budget and refreshed the affected tests.",
  nextStep: "Review the diff, then run the package test suite.",
  followUpSuggestion: {
    title: "Backfill retry telemetry",
    tldr: "Add counters for retry outcomes so regressions show up in dashboards.",
    prompt:
      "Add telemetry counters for retry outcomes (exhausted, recovered, cancelled) and wire them into the existing dashboard export. Start from the retry budget module; no other context is required.",
  },
};

let seq = 0;
const ev = (type, payload) => ({
  id: `ev-${++seq}`,
  sessionId: SID,
  type,
  timestamp: new Date(),
  traceId: "trace-turn-wrapup",
  sequenceNumber: seq,
  payload,
});

function drive() {
  const projection = new ProductProjection(SID, "epoch-turn-wrapup");
  const deltas = [];
  deltas.push(
    ...projection.applyEvent(
      ev("turn_started", {
        turnId: "turn-1",
        turnNumber: 1,
        transcriptMessageId: "user-1",
        messageId: "msg-user-1",
        input: "Land the retry budget",
      }),
    ),
  );
  const scheduled = projection.applyEvent(
    ev("tool_call_scheduled", {
      assistantMessageId: "msg-a1",
      input: PAYLOAD,
      toolCallId: "tc-wrap-1",
      toolName: "TurnWrapUp",
    }),
  );
  deltas.push(...scheduled);
  const result = projection.applyEvent(
    ev("tool_call_result", {
      toolCallId: "tc-wrap-1",
      toolName: "TurnWrapUp",
      result: {
        success: true,
        content: JSON.stringify({ status: "recorded", message: "Wrap-up recorded." }),
      },
    }),
  );
  deltas.push(...result);
  return { deltas, projection, scheduled, result };
}

test("scenario 4: payload rides the toolCall row input verbatim through the projection", () => {
  const { scheduled, result } = drive();

  const appended = scheduled.find((d) => d.op === "row.appended" && d.row.kind === "toolCall");
  assert.ok(appended, "scheduled event must append a toolCall row");
  assert.equal(appended.row.toolName, "TurnWrapUp");
  assert.deepEqual(appended.row.input, PAYLOAD);

  const upserted = result.find((d) => d.op === "row.upserted" && d.row.kind === "toolCall");
  assert.ok(upserted, "result event must upsert the toolCall row to a terminal state");
  assert.equal(upserted.row.status, "success");
  assert.deepEqual(upserted.row.input, PAYLOAD, "input must survive the terminal upsert");
});

test("scenario 4: every emitted delta and the snapshot parse with the existing wire schemas", () => {
  const { deltas, projection } = drive();
  assert.ok(deltas.length > 0);
  for (const delta of deltas) {
    const parsed = conversationDeltaSchema.safeParse(delta);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues ?? parsed.error ?? null));
  }
  const snapshot = projection.getSnapshot();
  const parsedSnapshot = conversationSnapshotSchema.safeParse(snapshot);
  assert.ok(
    parsedSnapshot.success,
    JSON.stringify(parsedSnapshot.error?.issues ?? parsedSnapshot.error ?? null),
  );
  const wrapRows = snapshot.rows.window.filter(
    (row) => row.kind === "toolCall" && row.toolName === "TurnWrapUp",
  );
  assert.equal(wrapRows.length, 1);
  assert.deepEqual(wrapRows[0].input, PAYLOAD);
});

test("scenario 5: the wrap-up payload never becomes a row kind (old-client frame safety)", () => {
  // 旧客户端安全忽略的结构性保证：conversationRowSchema 的 kind 闭集不含任何 wrap-up 成员。
  // 未知 kind 会让旧客户端整帧校验失败（wire-fault 确定性内容故障 → 订阅 contentRejected），
  // 而 input 通道（z.unknown）对每个客户端版本都是无 schema 透传——把载荷改成新 row kind
  // 会静默破坏这条保证，这里钉死。
  const kinds = conversationRowSchema.options.map((option) => option.shape.kind.value);
  assert.deepEqual([...new Set(kinds)].sort(), [
    "artifact",
    "assistantText",
    "hookInvocation",
    "reasoning",
    "subagent",
    "timelineMarker",
    "toolCall",
    "turnHeader",
    "userInput",
  ]);
  assert.ok(!kinds.some((kind) => /wrap/iu.test(String(kind))));
});
