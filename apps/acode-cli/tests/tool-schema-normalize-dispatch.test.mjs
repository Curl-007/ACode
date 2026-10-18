import assert from "node:assert/strict";
import { test } from "node:test";

// spec: apps/acode-cli/specs/tool-schema-normalize.md 验收场景 7/8（分发计划、
// 统一入口集成、fail-closed）。插点：tool-transform.ts（发送点）与
// schema-normalize/index.ts（applyModelToolSchemaDialect）。

const {
  resolveModelToolSchemaPlan,
  toolSchemaWireOfProviderKind,
  planHasDialectWork,
} = await import("../packages/adapters/src/model/schema-normalize/dialect-plan.ts");
const { applyModelToolSchemaDialect } = await import(
  "../packages/adapters/src/model/schema-normalize/index.ts"
);
const { toAiSdkTools } = await import(
  "../packages/adapters/src/model/tool-transform.ts"
);

function contract(overrides = {}) {
  return {
    name: "t",
    description: "d",
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
    ...overrides,
  };
}

function wireSchema(tools) {
  return tools.t.inputSchema.jsonSchema;
}

// ------------------------------------------------------------
// providerKind → wire 映射与分发计划（禁 id 字符串分支：只消费
// classifyModel 结构化身份 + 标志 + wire 映射）
// ------------------------------------------------------------

test("plan: providerKind→wire 一一映射，gateway/custom 归 unknown（fail-safe 不归一）", () => {
  assert.equal(toolSchemaWireOfProviderKind("openai"), "openai-responses");
  assert.equal(toolSchemaWireOfProviderKind("anthropic"), "anthropic-messages");
  assert.equal(toolSchemaWireOfProviderKind("openai-compatible"), "openai-chat-completions");
  assert.equal(toolSchemaWireOfProviderKind("gateway"), "unknown");
  assert.equal(toolSchemaWireOfProviderKind("custom"), "unknown");
  assert.equal(toolSchemaWireOfProviderKind(undefined), "unknown");
});

test("plan: responses wire → sanitize + strict 资格；anthropic/chat → 无方言", () => {
  const responses = resolveModelToolSchemaPlan({
    providerKind: "openai",
    providerId: "openai",
    modelId: "gpt-5.6-luna",
  });
  assert.equal(responses.wire, "openai-responses");
  assert.equal(responses.responsesSanitize, true);
  assert.equal(responses.responsesStrictEligible, true);
  assert.equal(responses.modelClass, "gpt");
  assert.equal(responses.mfjs, false);

  const anthropic = resolveModelToolSchemaPlan({
    providerKind: "anthropic",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
  });
  assert.equal(anthropic.responsesSanitize, false);
  assert.equal(anthropic.modelClass, "claude");

  const chat = resolveModelToolSchemaPlan({
    providerKind: "openai-compatible",
    providerId: "p",
    modelId: "some-model",
  });
  assert.equal(planHasDialectWork(chat), false);
});

test("plan: requiresMfjsToolSchema 标志路由 MFJS（与 wire 无关）；身份缺席时 modelClass unknown", () => {
  const mfjs = resolveModelToolSchemaPlan({
    providerKind: "openai-compatible",
    providerId: "moonshot",
    modelId: "kimi-k3",
    requiresMfjsToolSchema: true,
  });
  assert.equal(mfjs.mfjs, true);
  assert.equal(mfjs.modelClass, "kimi");
  assert.equal(mfjs.responsesSanitize, false);

  const anonymous = resolveModelToolSchemaPlan({ providerKind: "openai-compatible" });
  assert.equal(anonymous.modelClass, "unknown");
  assert.equal(planHasDialectWork(anonymous), false);

  const gateway = resolveModelToolSchemaPlan({ providerKind: "gateway", modelId: "claude-x" });
  assert.equal(gateway.wire, "unknown");
  assert.equal(gateway.modelClass, "unknown");
});

// ------------------------------------------------------------
// applyModelToolSchemaDialect（顺序：Responses sanitize → MFJS）
// ------------------------------------------------------------

test("apply: 无方言计划按引用直通；responses+mfjs 叠加顺序锚定（{}→true 后被 MFJS 重新对象化）", () => {
  const none = resolveModelToolSchemaPlan({ providerKind: "anthropic" });
  const schema = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(applyModelToolSchemaDialect(none, schema), schema);

  // omp openai-responses.ts:1920-1930 论证：sanitizer 把 {} 归一为 true，
  // Moonshot 拒绝布尔子 schema，MFJS 的 permissive 折叠必须最后跑。
  const both = resolveModelToolSchemaPlan({
    providerKind: "openai",
    providerId: "moonshot",
    modelId: "kimi-k3",
    requiresMfjsToolSchema: true,
  });
  const out = applyModelToolSchemaDialect(both, {
    type: "object",
    properties: { open: {} },
  });
  assert.deepEqual(out.properties.open, {});
});

// ------------------------------------------------------------
// toAiSdkTools 发送点集成
// ------------------------------------------------------------

test("发送点: responses wire 上 oneOf 被重写为 anyOf（必做路径）", () => {
  const tools = toAiSdkTools(
    [
      contract({
        inputSchema: {
          type: "object",
          properties: { p: { oneOf: [{ type: "string" }, { type: "number" }] } },
        },
      }),
    ],
    { providerKind: "openai", providerId: "openai", modelId: "gpt-5.6-luna" },
  );
  const schema = wireSchema(tools);
  assert.deepEqual(schema.properties.p, { anyOf: [{ type: "string" }, { type: "number" }] });
  assert.equal(tools.t.strict, undefined);
});

test("发送点: responses wire + contract.strict → enforce 成功才发 strict:true（全闭合形状）", () => {
  const tools = toAiSdkTools(
    [
      contract({
        strict: true,
        inputSchema: {
          type: "object",
          properties: { a: { type: "string" }, opt: { type: "number" } },
          required: ["a"],
        },
      }),
    ],
    { providerKind: "openai", providerId: "openai", modelId: "gpt-5.6-luna" },
  );
  assert.equal(tools.t.strict, true);
  const schema = wireSchema(tools);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.sort(), ["a", "opt"]);
  assert.deepEqual(schema.properties.opt, {
    anyOf: [{ type: "number" }, { type: "null" }],
  });
});

test("发送点: responses strict 资格失败降级非 strict（不带 strict 字段，schema 合法发出）", () => {
  const tools = toAiSdkTools(
    [
      contract({
        strict: true,
        inputSchema: {
          type: "object",
          patternProperties: { "^a": { type: "string" } },
        },
      }),
    ],
    { providerKind: "openai", providerId: "openai", modelId: "gpt-5.6-luna" },
  );
  assert.equal(tools.t.strict, undefined);
  const schema = wireSchema(tools);
  assert.deepEqual(schema.patternProperties, { "^a": { type: "string" } });
});

test("发送点: anthropic/chat/gateway wire 不做方言改写（存量行为零变化）", () => {
  const oneOfSchema = {
    type: "object",
    properties: { p: { oneOf: [{ type: "string" }, { type: "number" }] } },
  };
  for (const options of [
    { providerKind: "anthropic", providerId: "anthropic", modelId: "claude-sonnet-4-5" },
    { providerKind: "openai-compatible", providerId: "p", modelId: "m" },
    { providerKind: "gateway" },
  ]) {
    const tools = toAiSdkTools([contract({ inputSchema: oneOfSchema })], options);
    assert.deepEqual(wireSchema(tools).properties.p, oneOfSchema.properties.p);
  }
});

test("发送点: MFJS 标志——#/properties 引用 hoist 后被 MFJS 解引用并折叠 const", () => {
  const tools = toAiSdkTools(
    [
      contract({
        inputSchema: {
          type: "object",
          properties: {
            x: { const: "v" },
            y: { $ref: "#/properties/x" },
          },
        },
      }),
    ],
    {
      providerKind: "openai-compatible",
      providerId: "moonshot",
      modelId: "kimi-k3",
      requiresMfjsToolSchema: true,
    },
  );
  const schema = wireSchema(tools);
  // hoist 把 #/properties/x 搬进 $defs，MFJS 归一再把 $defs 内联并折叠 const
  assert.deepEqual(schema.properties.x, { type: "string", enum: ["v"] });
  assert.deepEqual(schema.properties.y, { type: "string", enum: ["v"] });
  assert.equal("$defs" in schema, false);
});

test("发送点: MFJS 标志关闭时 hoist 不跑（与存量门控一致），$ref 原样发送", () => {
  const tools = toAiSdkTools(
    [
      contract({
        inputSchema: {
          type: "object",
          properties: { x: { const: "v" }, y: { $ref: "#/properties/x" } },
        },
      }),
    ],
    { providerKind: "openai-compatible", providerId: "moonshot", modelId: "kimi-k3" },
  );
  const schema = wireSchema(tools);
  assert.deepEqual(schema.properties.y, { $ref: "#/properties/x" });
});

test("发送点: anthropic 首方 strict 存量路径不变（strict-tool-schema 折叠 + strict:true）", () => {
  const tools = toAiSdkTools(
    [
      contract({
        strict: true,
        inputSchema: {
          type: "object",
          properties: { n: { type: "number", minimum: 1 } },
          required: ["n"],
        },
      }),
    ],
    { providerKind: "anthropic", providerId: "anthropic", modelId: "claude-sonnet-4-5" },
  );
  assert.equal(tools.t.strict, true);
  const schema = wireSchema(tools);
  // strict-tool-schema 把 minimum 折进 description（存量语义，非本波方言）
  assert.equal(schema.properties.n.minimum, undefined);
  assert.ok(String(schema.properties.n.description).includes("minimum"));
});

test("发送点: 归一器意外异常 fail-closed——拒绝发送（InvalidModelRequest），不发坏 schema", () => {
  // 属性 map 上的抛异常 getter：walker 读键值即触发（模拟归一器意外失败面）
  const hostile = { type: "object", properties: {} };
  Object.defineProperty(hostile.properties, "bad", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  assert.throws(
    () =>
      toAiSdkTools([contract({ inputSchema: hostile })], {
        providerKind: "openai",
        providerId: "openai",
        modelId: "gpt-5.6-luna",
      }),
    (error) => {
      assert.equal(error.name, "AiSdkModelAdapterError");
      assert.equal(error.code, "invalid_model_request");
      assert.match(error.message, /normalization failed/);
      assert.equal(error.context.toolName, "t");
      return true;
    },
  );
});
