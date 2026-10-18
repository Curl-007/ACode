// 工具 intent 字段（specs/tool-intent-field.md）验收：R1 门控、R2 注入守卫（纯函数）、
// R3 归一化收口剥离（strict schema 防御 + 自有 i 豁免）。
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const {
  TOOL_INTENT_FIELD,
  TOOL_INTENT_ENV,
  TOOL_INTENT_PARAMETER_DESCRIPTION,
  isToolIntentFieldEnabled,
  injectToolIntentParameter,
  stripToolIntentField,
  toolSchemaOwnsIntentField,
} = await import("../packages/core/src/tool/intent-field.ts");
const { prepareInitialToolExecutionInput } = await import(
  "../packages/core/src/tool/input-normalization.ts"
);

afterEach(() => {
  delete process.env[TOOL_INTENT_ENV];
});

test("(R1) 门控：缺省关闭；1/true 开启；其他值不开启", () => {
  assert.equal(isToolIntentFieldEnabled({}), false);
  assert.equal(isToolIntentFieldEnabled({ ACODE_TOOL_INTENT: "1" }), true);
  assert.equal(isToolIntentFieldEnabled({ ACODE_TOOL_INTENT: " true " }), true);
  assert.equal(isToolIntentFieldEnabled({ ACODE_TOOL_INTENT: "0" }), false);
  assert.equal(TOOL_INTENT_FIELD, "i");
  assert.equal(TOOL_INTENT_ENV, "ACODE_TOOL_INTENT");
});

test("(R2) 注入：object schema 加非 required 的 i；纯函数不改原对象", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  };
  const injected = injectToolIntentParameter(schema);
  assert.equal(injected.properties.i.type, "string");
  assert.equal(injected.properties.i.description, TOOL_INTENT_PARAMETER_DESCRIPTION);
  assert.deepEqual(injected.required, ["path"]); // 不进 required
  assert.equal(schema.properties.i, undefined); // 原对象未被修改
  assert.notEqual(injected, schema);
});

test("(R2) 注入守卫：已自有 i / 非 object / 无 properties → 原样返回", () => {
  const owns = { type: "object", properties: { i: { type: "number" } } };
  assert.equal(injectToolIntentParameter(owns), owns);
  const notObject = { type: "string" };
  assert.equal(injectToolIntentParameter(notObject), notObject);
  const noProps = { type: "object" };
  assert.equal(injectToolIntentParameter(noProps), noProps);
  assert.equal(toolSchemaOwnsIntentField(owns), true);
  assert.equal(toolSchemaOwnsIntentField(noProps), false);
  assert.equal(toolSchemaOwnsIntentField(undefined), false);
});

test("剥离纯函数：删顶层 i 并返回修剪意图；非 record/无 i 透传", () => {
  assert.deepEqual(stripToolIntentField({ a: 1, i: " 看看配置 " }), {
    input: { a: 1 },
    intent: "看看配置",
  });
  assert.deepEqual(stripToolIntentField({ a: 1 }), { input: { a: 1 } });
  assert.deepEqual(stripToolIntentField("text"), { input: "text" });
  assert.deepEqual(stripToolIntentField({ i: 42 }), { input: {} }); // 非字符串意图不透出
});

function strictFakeEntry(schemaOwnsI = false) {
  return {
    metadata: { name: "FakeStrict" },
    inputSchema: schemaOwnsI
      ? { type: "object", properties: { i: { type: "string" }, a: { type: "number" } } }
      : { type: "object", properties: { a: { type: "number" } } },
    // 模拟 .strict() zod：额外键即失败（Edit/Agent 等真实 strict schema 的行为）。
    runtimeInputSchema: {
      safeParse: (value) => {
        const allowed = schemaOwnsI ? ["a", "i"] : ["a"];
        if (value && typeof value === "object") {
          const extra = Object.keys(value).filter((key) => !allowed.includes(key));
          if (extra.length > 0) {
            return { success: false, error: { issues: [{ message: `extra: ${extra}` }] } };
          }
        }
        return { success: true, data: value };
      },
    },
  };
}

test("(R3) 开启态：strict 工具收到带 i 的调用——i 被剥、校验通过、handler 输入干净", () => {
  process.env[TOOL_INTENT_ENV] = "1";
  const prepared = prepareInitialToolExecutionInput({
    entry: strictFakeEntry(),
    input: { a: 1, i: "update the counter" },
  });
  assert.deepEqual(prepared.input, { a: 1 });
  assert.equal(prepared.runtimeValidationIssues, undefined);
});

test("(R3) 开启态 + 工具自有 i：不剥（注入让位形态，i 是合法参数）", () => {
  process.env[TOOL_INTENT_ENV] = "1";
  const prepared = prepareInitialToolExecutionInput({
    entry: strictFakeEntry(true),
    input: { a: 1, i: "owned" },
  });
  assert.deepEqual(prepared.input, { a: 1, i: "owned" });
});

test("(R1/R3) 关闭态：零行为变化——不剥离（模型幻觉的 i 仍按既有语义被 strict 拒）", () => {
  const prepared = prepareInitialToolExecutionInput({
    entry: strictFakeEntry(),
    input: { a: 1, i: "hallucinated" },
  });
  assert.deepEqual(prepared.input, { a: 1, i: "hallucinated" });
  assert.ok(Array.isArray(prepared.runtimeValidationIssues));
});

test("(R3) JSON 字符串输入先归一再剥离（适配器字符串形态链路）", () => {
  process.env[TOOL_INTENT_ENV] = "1";
  const prepared = prepareInitialToolExecutionInput({
    entry: strictFakeEntry(),
    input: JSON.stringify({ a: 2, i: "string form" }),
  });
  assert.deepEqual(prepared.input, { a: 2 });
});
