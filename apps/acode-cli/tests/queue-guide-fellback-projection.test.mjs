// 引导内联失败回退队列的投影往返守护（packages/ui/specs/queue-guide-fellback-notice.md 场景 1）。
//
// 钉住：Core fallbackPendingGuidesToQueue 发 TurnSteerDeliveryChanged 后，投影把对应
// QueueItem 的 steer.state 从 "steering" 改成 "fellBack"、reasonCode 存活，且 delivery
// 从 guide 改投 queue；全部 delta 与 snapshot 过既有 wire schema（steer/delivery 字段
// 是 QueueItem 契约的一部分，UI 直接读，不做二次判定）。
import assert from "node:assert/strict";
import test from "node:test";

const { ProductProjection } =
  await import("../packages/bootstrap/src/acode-protocol-v4/product-projection.ts");
const { conversationDeltaSchema, conversationSnapshotSchema } = await import(
  "../../../packages/shared/src/acode-protocol-v4/index.ts"
);

const SID = "sess-queue-guide-fellback";

let seq = 0;
const ev = (type, payload, turnId) => ({
  id: `ev-${++seq}`,
  sessionId: SID,
  type,
  timestamp: new Date(),
  traceId: "trace-guide-fellback",
  sequenceNumber: seq,
  ...(turnId ? { turnId } : {}),
  payload,
});

const PENDING_INPUT_ID = "pending_turn-1_1";
const QUEUE_ITEM_ID = "qitem-guide-1";
const SOURCE_COMMAND_ID = "cmd-guide-1";

function guideIntent() {
  return {
    sourceCommandId: SOURCE_COMMAND_ID,
    queueItemId: QUEUE_ITEM_ID,
    clientId: "cli",
    kind: "sendText",
    text: "先别改测试，等我确认",
    admissionSeq: 1,
    admittedAt: Date.now(),
    requestedDelivery: "guide",
    admittedDelivery: "guide",
  };
}

function drive() {
  const projection = new ProductProjection(SID, "epoch-guide-fellback");
  const deltas = [];
  // 运行中 turn（引导在此期间被 admit）。
  deltas.push(
    ...projection.applyEvent(
      ev("turn_started", {
        turnId: "turn-1",
        turnNumber: 1,
        transcriptMessageId: "user-1",
        messageId: "msg-user-1",
        input: "帮我改这个模块",
      }, "turn-1"),
    ),
  );
  // 引导内联排队：steerable 时 steer.state="steering"、delivery.admitted="guide"。
  const queued = projection.applyEvent(
    ev(
      "turn_steer_queued",
      {
        pendingInputId: PENDING_INPUT_ID,
        inputId: SOURCE_COMMAND_ID,
        input: guideIntent().text,
        inputPreview: guideIntent().text,
        inputSize: 30,
        delivery: "guide",
        intent: guideIntent(),
        targetTurnId: "turn-1",
        queueLength: 1,
      },
      "turn-1",
    ),
  );
  deltas.push(...queued);
  // 当前轮无可用工具批次边界 → Core 回退：delivery guide→queue，steer→fellBack。
  const changed = projection.applyEvent(
    ev(
      "turn_steer_delivery_changed",
      {
        pendingInputId: PENDING_INPUT_ID,
        targetTurnId: "turn-1",
        requestedDelivery: "guide",
        admittedDelivery: "queue",
        fallbackReasonCode: "guide.noToolBoundary",
        intent: { ...guideIntent(), admittedDelivery: "queue", fallbackReasonCode: "guide.noToolBoundary" },
      },
      "turn-1",
    ),
  );
  deltas.push(...changed);
  return { deltas, projection, queued, changed };
}

function queueItemOf(projection) {
  const snapshot = projection.getSnapshot();
  return snapshot.queue.items.find((item) => item.queueItemId === QUEUE_ITEM_ID);
}

test("场景1a: 引导排队时 steer.state=steering、delivery.admitted=guide", () => {
  const { projection } = drive();
  // 回退前的中间态用独立投影断言：重放到 queued 即停。
  const mid = new ProductProjection(SID, "epoch-guide-mid");
  mid.applyEvent(
    ev("turn_started", {
      turnId: "turn-1",
      turnNumber: 1,
      transcriptMessageId: "user-1",
      messageId: "msg-user-1",
      input: "帮我改这个模块",
    }, "turn-1"),
  );
  mid.applyEvent(
    ev(
      "turn_steer_queued",
      {
        pendingInputId: PENDING_INPUT_ID,
        inputId: SOURCE_COMMAND_ID,
        input: guideIntent().text,
        inputPreview: guideIntent().text,
        inputSize: 30,
        delivery: "guide",
        intent: guideIntent(),
        targetTurnId: "turn-1",
        queueLength: 1,
      },
      "turn-1",
    ),
  );
  const item = mid.getSnapshot().queue.items.find((i) => i.queueItemId === QUEUE_ITEM_ID);
  assert.ok(item, "queued guide must appear as a queue item");
  assert.equal(item.steer.state, "steering");
  assert.equal(item.delivery.admitted, "guide");
});

test("场景1b: TurnSteerDeliveryChanged 把 steer.state 改成 fellBack、reasonCode 存活、delivery 改投 queue", () => {
  const { projection, changed } = drive();
  // DeliveryChanged 必须产出 state.updated（queue patch），否则 UI 无从感知回退。
  assert.ok(
    changed.some((d) => d.op === "state.updated" && d.patch.queue),
    "delivery-changed must emit a queue state patch",
  );
  const item = queueItemOf(projection);
  assert.ok(item, "fell-back guide must remain a queue item (not swallowed)");
  assert.equal(item.steer.state, "fellBack");
  assert.equal(item.steer.reasonCode, "guide.noToolBoundary");
  assert.equal(item.delivery.admitted, "queue");
  assert.equal(item.delivery.requested, "guide");
  assert.equal(item.delivery.fallbackReasonCode, "guide.noToolBoundary");
  // 文本不因回退丢失。
  assert.equal(item.text, guideIntent().text);
});

test("场景1c: 全部 delta 与 snapshot 过既有 wire schema（steer/delivery 是 QueueItem 契约）", () => {
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
});
