import assert from "node:assert/strict";
import test from "node:test";
import { conversationSnapshotSchema } from "../src/acode-protocol-v4/snapshot.js";
import { statePatchSchema } from "../src/acode-protocol-v4/delta.js";

/**
 * pluginStates 状态键的 wire 兼容：additive optional + default(null)——
 * 旧快照/旧 delta 不带该字段必须照常解析（键剥离语义），新字段带任意插件 JSON 时
 * 原样通过（宿主不解释内容）。完整 snapshot fixture 太重（availability/usage/config
 * 全树），对 snapshot 侧直接测 `pluginStates` 字段的 shape 行为，语义等价。
 */

const pluginStatesField = conversationSnapshotSchema.shape.pluginStates;

test("snapshot field: absent parses to default null (legacy wire)", () => {
  assert.equal(pluginStatesField.parse(undefined), null);
  assert.equal(pluginStatesField.parse(null), null);
});

test("snapshot field: arbitrary plugin JSON passes verbatim", () => {
  const value = {
    "agent-teams@acode-plugins-official:agent-teams": {
      v: 1,
      teamId: "t",
      nested: { list: [1, "two", null, false] },
    },
  };
  assert.deepEqual(pluginStatesField.parse(value), value);
});

test("state patch: pluginStates key passes through, null clears, absent optional", () => {
  const patch = statePatchSchema.parse({
    pluginStates: { "p:any": { a: 1 } },
  });
  assert.deepEqual(patch.pluginStates, { "p:any": { a: 1 } });
  // null 语义 = 清空（卡片消失）。
  const clearing = statePatchSchema.parse({ pluginStates: null });
  assert.equal(clearing.pluginStates, null);
  // 空 patch（其余键全部缺席）依然合法：旧发送端不知道该键。
  assert.equal(statePatchSchema.parse({}).pluginStates, undefined);
});
