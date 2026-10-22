import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * review §7 盲区 5：快照/重放对账（snapshot / reconcile）——gap repair 与重放对账的专门覆盖。
 *
 * 三条权威链路（AGENTS.md「desktop-continuous vs web-remote-replayable 必须明确区分」+
 * 「外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存业务状态」）：
 *   A. 序号连续性对账：controller frame 用 (subscriptionId, logEpoch, seq→fromSeq) 判连续性。
 *      isWindowHostControllerFrameGap：任一不符即 gap，消费方必须走权威快照补齐，不得静默 apply
 *      一段有洞的 delta（否则状态永久漂移）。对照 desktop 侧 stream_mirror_gap 降级语义。
 *   B. 重复投递去重：coalesce 幂等（重放同一批 delta 两次结果不变）+ conflateByKey 按 key 只留最后
 *      一次（sessions-index 等最新态 topic 的重复投递去重）。
 *   C. 失配后 snapshot invalidation：stream_mirror_gap 是合法 reason；快照帧强制 fromSeq=0 且
 *      frame.logEpoch === snapshot.logEpoch（跨 epoch 的旧 delta 不得拼进新快照）。
 *   D. mirror batch 序号记账：runId===traceId（贯穿 identity）、ops 携正 seq、fromSeq/toSeq 正整数。
 *
 * 纯 schema/纯函数，无 IO / 子进程 / sleep。每条断言都对照一个「改坏会红」的负向变体。
 */

const {
  isWindowHostControllerFrameGap,
  windowHostControllerTaskFrameSchema,
  CONTROLLER_TASKS_INDEX_TOPIC,
} = await import("../../../packages/shared/src/acode-protocol-v4/controller.ts");
const { taskRealtimeReasonSchema, taskRealtimeEventSchema } = await import(
  "../../../packages/shared/src/task-realtime-core.ts"
);
const { coalesceConversationDeltas, conflateByKey } = await import(
  "../../../packages/shared/src/acode-protocol-v4/coalesce.ts"
);
const { applyConversationDeltas } = await import(
  "../../../packages/shared/src/acode-protocol-v4/apply.ts"
);

function emptySnapshot() {
  return { rows: { firstRowId: null, totalCount: 0, window: [] } };
}

// ── A. 序号连续性对账（gap 检测）─────────────────────────────────────────────

test("gap(1): 连续帧（cursor.seq === frame.fromSeq）不算 gap；空洞/换 epoch/换订阅都是 gap", () => {
  const cursor = { logEpoch: "epoch-1", seq: 5, subscriptionId: "sub-1" };
  // 连续：下一帧从 5 开始，衔接无缝。
  assert.equal(
    isWindowHostControllerFrameGap(cursor, { fromSeq: 5, logEpoch: "epoch-1", subscriptionId: "sub-1" }),
    false,
    "衔接帧不得误判为 gap",
  );
  // 事件序号空洞：下一帧从 7 开始，5→7 之间丢了事件。
  assert.equal(
    isWindowHostControllerFrameGap(cursor, { fromSeq: 7, logEpoch: "epoch-1", subscriptionId: "sub-1" }),
    true,
    "序号空洞必须被判为 gap",
  );
  // 重复/回退投递：下一帧从 3 开始（比 cursor 低），是重叠重投。
  assert.equal(
    isWindowHostControllerFrameGap(cursor, { fromSeq: 3, logEpoch: "epoch-1", subscriptionId: "sub-1" }),
    true,
    "seq 回退（重复投递）必须被判为 gap",
  );
  // logEpoch 变了（CLI 重启/权威换世）：即便 seq 衔接也是 gap，必须重取快照。
  assert.equal(
    isWindowHostControllerFrameGap(cursor, { fromSeq: 5, logEpoch: "epoch-2", subscriptionId: "sub-1" }),
    true,
    "logEpoch 变化必须被判为 gap",
  );
  // 订阅换了：不同 subscriptionId 的帧不可直接拼接。
  assert.equal(
    isWindowHostControllerFrameGap(cursor, { fromSeq: 5, logEpoch: "epoch-1", subscriptionId: "sub-2" }),
    true,
    "subscriptionId 变化必须被判为 gap",
  );
});

// ── B. 重复投递去重（coalesce 幂等 + conflateByKey）───────────────────────────

test("gap(2): coalesce 幂等——重放同一批 delta 两次，合并结果不变、终态不变", () => {
  const deltas = [
    { append: "a", op: "row.delta", path: "text", rowId: 1 },
    { append: "b", op: "row.delta", path: "text", rowId: 1 },
    { append: "c", op: "row.delta", path: "text", rowId: 1 },
  ];
  const once = coalesceConversationDeltas(deltas);
  const twice = coalesceConversationDeltas(once);
  assert.deepEqual(twice, once, "coalesce 必须幂等（重复投递去重的基础）");
  assert.equal(once.length, 1, "相邻同 (rowId,path) 的 delta 应合并为一条");
  assert.equal(once[0].append, "abc");
  // 幂等 ⇒ 重放不改变终态：apply(coalesce(d)) === apply(coalesce(coalesce(d)))。
  const finalOnce = applyConversationDeltas(emptySnapshot(), once);
  const finalTwice = applyConversationDeltas(emptySnapshot(), twice);
  assert.deepEqual(finalTwice, finalOnce);
});

test("gap(3): coalesce 语义保持——合并与逐条投递的终态一致（重放对账裁判）", () => {
  const deltas = [
    { op: "row.appended", row: { createdAt: 0, createdAtSeq: 1, kind: "assistantText", rowId: 1, text: "", turnId: "t" } },
    { append: "he", op: "row.delta", path: "text", rowId: 1 },
    { append: "llo", op: "row.delta", path: "text", rowId: 1 },
  ];
  const coalesced = applyConversationDeltas(emptySnapshot(), coalesceConversationDeltas(deltas));
  const streamed = applyConversationDeltas(emptySnapshot(), deltas);
  assert.deepEqual(coalesced, streamed, "合并后终态必须与逐条投递一致（否则重放对账失败）");
  assert.equal(coalesced.rows.window[0].text, "hello");
});

test("gap(4): conflateByKey——按 key 只保留最后一次更新（最新态 topic 重复投递去重），保序", () => {
  const updates = [
    { key: "task-a", updatedAt: 1 },
    { key: "task-b", updatedAt: 2 },
    { key: "task-a", updatedAt: 3 }, // task-a 的重复投递（更新）
    { key: "task-c", updatedAt: 4 },
    { key: "task-b", updatedAt: 5 }, // task-b 的重复投递（更新）
  ];
  const latest = conflateByKey(updates, (item) => item.key);
  // 每个 key 只剩最后一次的值；顺序按各 key「最后一次出现」的下标相对序。
  // task-a 末次在下标 2、task-c 在 3、task-b 在 4 → [task-a, task-c, task-b]。
  assert.deepEqual(
    latest.map((item) => item.key),
    ["task-a", "task-c", "task-b"],
    "conflateByKey 必须按最后一次出现的下标保序",
  );
  assert.deepEqual(
    latest.map((item) => item.updatedAt),
    [3, 4, 5],
    "每个 key 只保留最后一次的值（重复投递被去重）",
  );
  // 幂等：对已 conflate 的结果再 conflate 不变。
  assert.deepEqual(conflateByKey(latest, (item) => item.key), latest);
});

// ── C. 失配后 snapshot invalidation（权威快照补齐）───────────────────────────

test("gap(5): stream_mirror_gap 是合法 invalidation reason（失配后触发权威快照补齐）", () => {
  assert.equal(taskRealtimeReasonSchema.safeParse("stream_mirror_gap").success, true);
  assert.equal(taskRealtimeReasonSchema.safeParse("stream_mirror_owner_lost").success, true);
  // 闭集：未知 reason 被拒（不得随意扩大降级触发面）。
  assert.equal(taskRealtimeReasonSchema.safeParse("stream_mirror_whatever").success, false);
});

test("gap(6): snapshot invalidation 事件——workspaceKey 与 fallback 一致才通过", () => {
  const base = {
    createdAt: 1_700_000_000_000,
    eventId: "evt-gap-1",
    reason: "stream_mirror_gap",
    taskId: "task-1",
    traceId: "trace-1",
    type: "task_snapshot_invalidated",
    workspacePath: "/repo/acode",
    workspaceKey: "/repo/acode",
  };
  assert.equal(taskRealtimeEventSchema.safeParse(base).success, true);
  // workspaceKey 不符 fallback（脏 key）→ 拒绝，防止 invalidation 路由到错误工作区。
  assert.equal(
    taskRealtimeEventSchema.safeParse({ ...base, workspaceKey: "/wrong/path" }).success,
    false,
    "invalidation 的 workspaceKey 必须与 fallback 规则一致",
  );
});

test("gap(7): 快照帧强制 fromSeq=0（权威快照从零点补齐）且 logEpoch 必须匹配", () => {
  const snapshot = { logEpoch: "epoch-9", protocolVersion: 1, tasks: [] };
  // 正例：快照帧从 seq 0 开始、logEpoch 一致。
  const good = windowHostControllerTaskFrameSchema.safeParse({
    fromSeq: 0,
    logEpoch: "epoch-9",
    payload: { kind: "snapshot", snapshot },
    sentAt: 0,
    subscriptionId: "sub-1",
    toSeq: 0,
    topic: CONTROLLER_TASKS_INDEX_TOPIC,
  });
  assert.equal(good.success, true, good.error?.message);
  // 负例：快照帧却从 fromSeq=5 开始（拿旧 delta 冒充权威快照）。
  const badFrom = windowHostControllerTaskFrameSchema.safeParse({
    fromSeq: 5,
    logEpoch: "epoch-9",
    payload: { kind: "snapshot", snapshot },
    sentAt: 0,
    subscriptionId: "sub-1",
    toSeq: 5,
    topic: CONTROLLER_TASKS_INDEX_TOPIC,
  });
  assert.equal(badFrom.success, false, "快照帧必须从 seq 0 开始");
  assert.match(badFrom.error?.issues?.[0]?.message ?? "", /snapshot frame must start at seq zero/u);
  // 负例：frame.logEpoch 与 snapshot.logEpoch 不符（跨 epoch 拼装）。
  const badEpoch = windowHostControllerTaskFrameSchema.safeParse({
    fromSeq: 0,
    logEpoch: "epoch-OLD",
    payload: { kind: "snapshot", snapshot },
    sentAt: 0,
    subscriptionId: "sub-1",
    toSeq: 0,
    topic: CONTROLLER_TASKS_INDEX_TOPIC,
  });
  assert.equal(badEpoch.success, false, "frame 与 snapshot 的 logEpoch 必须一致");
  assert.match(badEpoch.error?.issues?.[0]?.message ?? "", /logEpoch must match/u);
});

test("gap(8): delta 帧 toSeq < fromSeq 被拒（序号区间非法 = 无法对账）", () => {
  const bad = windowHostControllerTaskFrameSchema.safeParse({
    fromSeq: 10,
    logEpoch: "epoch-1",
    payload: { deltas: [], kind: "deltas" },
    sentAt: 0,
    subscriptionId: "sub-1",
    toSeq: 8,
    topic: CONTROLLER_TASKS_INDEX_TOPIC,
  });
  assert.equal(bad.success, false, "toSeq < fromSeq 的帧无法对账，必须被拒");
  assert.match(bad.error?.issues?.[0]?.message ?? "", /toSeq must not be lower than fromSeq/u);
});

// ── D. mirror batch 序号记账 + runId/traceId 贯穿 ────────────────────────────

function mirrorBatch(overrides) {
  return {
    batchSeq: 1,
    createdAt: 1_700_000_000_000,
    eventId: "evt-mirror-1",
    fromSeq: 1,
    ops: [
      { content: "hi", kind: "user_message", messageId: "m1", seq: 1, timestamp: 1_700_000_000_000 },
      { event: { taskId: "task-1", traceId: "trace-1", type: "assistant_text" }, kind: "stream_event", seq: 2 },
    ],
    runId: "trace-1",
    taskId: "task-1",
    terminal: false,
    toSeq: 2,
    traceId: "trace-1",
    type: "task_stream_mirror_batch",
    workspacePath: "/repo/acode",
    workspaceKey: "/repo/acode",
    ...overrides,
  };
}

test("gap(9): mirror batch——runId 必须等于 traceId（贯穿 identity），否则拒绝", () => {
  assert.equal(taskRealtimeEventSchema.safeParse(mirrorBatch()).success, true);
  // runId 与 traceId 不一致 = 无法把这段流关联回权威 run（identity 断裂）。
  const bad = taskRealtimeEventSchema.safeParse(mirrorBatch({ runId: "some-other-run" }));
  assert.equal(bad.success, false, "runId !== traceId 必须被拒");
  assert.match(bad.error?.issues?.[0]?.message ?? "", /runId must match traceId/u);
});

test("gap(10): mirror batch——ops.seq 与 fromSeq/toSeq 必须为正整数（重放序号可记账）", () => {
  // 正例已在 gap(9) 覆盖；这里钉负例：seq=0 的 op 被拒（seq 从 1 起，正整数）。
  const zeroSeqOp = taskRealtimeEventSchema.safeParse(
    mirrorBatch({
      ops: [{ content: "hi", kind: "user_message", messageId: "m1", seq: 0, timestamp: 0 }],
    }),
  );
  assert.equal(zeroSeqOp.success, false, "op.seq 必须为正整数（>0）");
  // fromSeq=0 被拒（mirror batch 的区间从 1 记账，区别于快照帧的 fromSeq=0）。
  assert.equal(taskRealtimeEventSchema.safeParse(mirrorBatch({ fromSeq: 0 })).success, false);
  // workspaceKey 脏了同样被拒（贯穿 fallback 规则）。
  assert.equal(
    taskRealtimeEventSchema.safeParse(mirrorBatch({ workspaceKey: "/wrong" })).success,
    false,
  );
});
