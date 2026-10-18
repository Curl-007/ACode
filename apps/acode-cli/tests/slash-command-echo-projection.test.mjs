// 斜杠命令触发回显投影验收（apps/acode-cli/specs/slash-command-echo.md 验收场景 1/2）。
//
// 场景 1（live）：TurnStarted payload.customCommand 经 ProductProjection 落到
// userInput row.customCommand，载荷逐字段存活，且 snapshot/delta 过 v4 wire schema
// （宽松 meta schema：未知 scope/source 不拒行）；无命令输入的 row 严格不带该字段。
// 场景 2（cold）：用户消息 metadata.customCommand → synthesizeEventsFromMessages 合成
// 同形 TurnStarted → 同一投影路径产出同形 row（hydration = 持久化事件重放，两路共用
// normalizer/projection）；畸形 metadata 按缺席处理、row 照常产出。
// 场景 3：projection-rows.buildUserInputRow 直测——contracts 侧闭集 scope/source 可
// 结构化赋给 shared 宽松 schema。
import assert from "node:assert/strict";
import test from "node:test";

const { ProductProjection } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/product-projection.ts"
);
const { buildUserInputRow } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/projection-rows.ts"
);
const { synthesizeEventsFromMessages } = await import(
  "../packages/bootstrap/src/acode-protocol-v4/transcript-hydration.ts"
);
const { conversationDeltaSchema, conversationSnapshotSchema } = await import(
  "../../../packages/shared/src/acode-protocol-v4/index.ts"
);

const SID = "sess-slash-command-echo";
const T0 = 1_700_000_000_000;

const META = {
  name: "my_prd_speed",
  scope: "user",
  source: "plugin",
  description: "快速修复执行 PRD 文档",
};

let seq = 0;
const ev = (type, payload, { turnId } = {}) => {
  seq += 1;
  return {
    id: `ev-${seq}`,
    sessionId: SID,
    type,
    timestamp: new Date(T0 + seq * 1000),
    traceId: "trace-slash-command-echo",
    sequenceNumber: seq,
    payload,
    ...(turnId ? { turnId } : {}),
  };
};

const startTurn = (projection, turnId, messageId, payloadExtra = {}) =>
  projection.applyEvent(
    ev(
      "turn_started",
      { turnId, turnNumber: 1, messageId, input: "/my_prd_speed 快速修", ...payloadExtra },
      { turnId },
    ),
  );

const userInputRowOf = (projection) => {
  // row.turnId 是 productTurnId（= 持久 user messageId），不是 envelope runtime turnId；
  // 每个用例只开一轮，按 kind 取唯一 userInput 行即可，不耦合 id 推导规则。
  const rows = projection.getSnapshot().rows.window.filter((row) => row.kind === "userInput");
  assert.equal(rows.length, 1, "expected exactly one userInput row");
  return rows[0];
};

const assertWireSafe = (projection, deltas) => {
  assert.ok(conversationSnapshotSchema.safeParse(projection.getSnapshot()).success);
  for (const delta of deltas) {
    const parsed = conversationDeltaSchema.safeParse(delta);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues ?? parsed.error ?? null));
  }
};

test("live TurnStarted customCommand lands on the userInput row verbatim and passes the wire schema", () => {
  const projection = new ProductProjection(SID, "epoch-echo-live");
  const deltas = startTurn(projection, "turn-echo-live", "msg-echo-live", {
    customCommand: META,
  });
  const row = userInputRowOf(projection);
  assert.deepEqual(row.customCommand, META);
  assertWireSafe(projection, deltas);
});

test("unknown scope/source survive verbatim (loose schema, no row rejection)", () => {
  const projection = new ProductProjection(SID, "epoch-echo-unknown");
  const deltas = startTurn(projection, "turn-echo-unknown", "msg-echo-unknown", {
    customCommand: { name: "future_cmd", scope: "future-scope", source: "future-source" },
  });
  const row = userInputRowOf(projection);
  assert.deepEqual(row.customCommand, {
    name: "future_cmd",
    scope: "future-scope",
    source: "future-source",
  });
  assertWireSafe(projection, deltas);
});

test("plain input rows carry no customCommand key (strict absence)", () => {
  const projection = new ProductProjection(SID, "epoch-echo-absent");
  const deltas = startTurn(projection, "turn-echo-absent", "msg-echo-absent");
  const row = userInputRowOf(projection);
  assert.equal("customCommand" in row, false);
  assertWireSafe(projection, deltas);
});

test("buildUserInputRow passes the contracts-typed meta through (builtin scope included)", () => {
  const base = { rowId: 1, turnId: "turn-1", createdAt: T0, createdAtSeq: 1 };
  const row = buildUserInputRow(base, {
    turnNumber: 1,
    input: "/init",
    customCommand: { name: "init", scope: "builtin" },
  });
  assert.deepEqual(row.customCommand, { name: "init", scope: "builtin" });
  assert.equal("customCommand" in buildUserInputRow(base, { turnNumber: 1, input: "hi" }), false);
});

test("cold hydration reads metadata.customCommand back into the synthesized TurnStarted and the row", () => {
  const created = T0;
  const userMessage = (metadata) => ({
    info: {
      id: "msg-cold-1",
      sessionID: SID,
      role: "user",
      time: { created },
      agent: "acode-agent",
      ...(metadata ? { metadata } : {}),
    },
    parts: [
      {
        id: "part-cold-1",
        sessionID: SID,
        messageID: "msg-cold-1",
        type: "text",
        text: "/my_prd_speed 快速修",
        time: { start: created, end: created },
      },
    ],
  });

  // 同形：metadata.customCommand → 合成 TurnStarted → 投影 row。
  const events = synthesizeEventsFromMessages([userMessage({ customCommand: META })], {
    sessionId: SID,
    baseTimestampMs: T0,
  });
  const started = events.filter((event) => event.type === "turn_started");
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].payload.customCommand, META);

  const projection = new ProductProjection(SID, "epoch-echo-cold");
  for (const event of events) projection.applyEvent(event);
  const row = userInputRowOf(projection);
  assert.deepEqual(row.customCommand, META);
});

test("cold hydration treats malformed metadata as absent and keeps the row", () => {
  const created = T0;
  const userMessage = {
    info: {
      id: "msg-cold-bad",
      sessionID: SID,
      role: "user",
      time: { created },
      agent: "acode-agent",
      metadata: { customCommand: { scope: "user" } },
    },
    parts: [
      {
        id: "part-cold-bad",
        sessionID: SID,
        messageID: "msg-cold-bad",
        type: "text",
        text: "/broken",
        time: { start: created, end: created },
      },
    ],
  };
  const events = synthesizeEventsFromMessages([userMessage], {
    sessionId: SID,
    baseTimestampMs: T0,
  });
  const started = events.find((event) => event.type === "turn_started");
  assert.ok(started);
  assert.equal("customCommand" in started.payload, false);

  const projection = new ProductProjection(SID, "epoch-echo-cold-bad");
  for (const event of events) projection.applyEvent(event);
  const row = userInputRowOf(projection);
  assert.equal(row.text, "/broken");
  assert.equal("customCommand" in row, false);
});
