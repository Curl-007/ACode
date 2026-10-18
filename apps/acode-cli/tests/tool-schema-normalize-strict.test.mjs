import assert from "node:assert/strict";
import { test } from "node:test";

// spec: apps/acode-cli/specs/tool-schema-normalize.md 验收场景 4（OpenAI strict 管线）。
// 移植锚点：omp packages/ai/test/schema-strict-mode.test.ts 与
// schema-normalization.test.ts 的 enforceStrictSchema/tryEnforceStrictSchema 章节语义
//（omp CONSTRAINTS #1.1-#1.6）。

const { sanitizeSchemaForStrictMode } = await import(
  "../packages/adapters/src/model/schema-normalize/strict-sanitize.ts"
);
const {
  enforceStrictSchema,
  tryEnforceStrictSchema,
  StrictSchemaEnforcementError,
} = await import("../packages/adapters/src/model/schema-normalize/strict-enforce.ts");
const { adaptSchemaForStrict } = await import(
  "../packages/adapters/src/model/schema-normalize/adapt.ts"
);

// ------------------------------------------------------------
// sanitize pass
// ------------------------------------------------------------

test("strict sanitize: 剥非结构关键字，default 内联进 description 为 (default: X)", () => {
  const out = sanitizeSchemaForStrictMode({
    type: "string",
    format: "uuid",
    pattern: "^x",
    minLength: 1,
    default: "abc",
    description: "ID",
  });
  assert.deepEqual(out, { type: "string", description: "ID (default: abc)" });
});

test("strict sanitize: description 已含 (default: 时不重复内联；无 description 时不造", () => {
  const has = sanitizeSchemaForStrictMode({
    type: "number",
    default: 3,
    description: "n (default: 3)",
  });
  assert.equal(has.description, "n (default: 3)");
  const none = sanitizeSchemaForStrictMode({ type: "number", default: 3 });
  assert.equal("description" in none, false);
});

test("strict sanitize: const → 单成员 enum；$ref 兄弟键内联且兄弟键胜出", () => {
  const out = sanitizeSchemaForStrictMode({
    $defs: { S: { type: "string", description: "from def" } },
    type: "object",
    properties: {
      c: { const: "only" },
      r: { $ref: "#/$defs/S", description: "sibling wins" },
    },
  });
  assert.deepEqual(out.properties.c, { type: "string", enum: ["only"] });
  assert.deepEqual(out.properties.r, { type: "string", description: "sibling wins" });
});

test("strict sanitize: 单元素 allOf 折叠，内联条目的键压过原兄弟键（openai-python 语义）", () => {
  const out = sanitizeSchemaForStrictMode({
    allOf: [{ type: "string", description: "inner wins" }],
    description: "outer loses",
    minLength: 3,
  });
  assert.deepEqual(out, { type: "string", description: "inner wins" });
});

test("strict sanitize: type 数组分支化，类型专属键只留在对应分支，description 提升到 anyOf 包装", () => {
  const out = sanitizeSchemaForStrictMode({
    type: ["object", "null"],
    description: "maybe object",
    properties: { a: { type: "string" } },
  });
  assert.deepEqual(out, {
    anyOf: [
      { type: "object", properties: { a: { type: "string" } } },
      { type: "null" },
    ],
    description: "maybe object",
  });
});

test("strict sanitize: nullable:true 包成 anyOf null union，description 提升到包装", () => {
  const out = sanitizeSchemaForStrictMode({
    type: "string",
    nullable: true,
    description: "opt",
  });
  assert.deepEqual(out, {
    anyOf: [{ type: "string" }, { type: "null" }],
    description: "opt",
  });
});

// ------------------------------------------------------------
// enforce pass
// ------------------------------------------------------------

test("strict enforce: object 全属性 required + additionalProperties:false，可选属性可空化且 description 提升", () => {
  const out = enforceStrictSchema({
    type: "object",
    properties: {
      req: { type: "string" },
      opt: { type: "number", description: "optional n" },
    },
    required: ["req"],
  });
  assert.deepEqual(out, {
    type: "object",
    additionalProperties: false,
    properties: {
      req: { type: "string" },
      opt: { anyOf: [{ type: "number" }, { type: "null" }], description: "optional n" },
    },
    required: ["req", "opt"],
  });
});

test("strict enforce: 纯 anyOf 节点就地补 null 分支（不套双层包装）", () => {
  const out = enforceStrictSchema({
    type: "object",
    properties: {
      u: { anyOf: [{ type: "string" }, { type: "number" }] },
    },
  });
  assert.deepEqual(out.properties.u, {
    anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
  });
});

test("strict enforce: 嵌套纯 union 拼接展平，内层 description 提升到无注解父级", () => {
  const out = enforceStrictSchema({
    type: "object",
    properties: {
      p: {
        anyOf: [
          { anyOf: [{ type: "string" }, { type: "number" }], description: "inner" },
          { type: "boolean" },
        ],
      },
    },
    required: ["p"],
  });
  assert.deepEqual(out.properties.p, {
    anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
    description: "inner",
  });
});

test("strict enforce: 无 type/combinator/$ref/not 的节点抛 StrictSchemaEnforcementError；循环图抛", () => {
  assert.throws(() => enforceStrictSchema({}), StrictSchemaEnforcementError);
  assert.throws(() => enforceStrictSchema({ type: "array", items: {} }), StrictSchemaEnforcementError);
  const cyclic = { type: "object", properties: {} };
  cyclic.properties.self = cyclic;
  assert.throws(() => enforceStrictSchema(cyclic), StrictSchemaEnforcementError);
});

// ------------------------------------------------------------
// try 组合与预检
// ------------------------------------------------------------

test("strict try: patternProperties / additionalProperties:true / 布尔分支 → strict:false + upgraded 原样", () => {
  for (const schema of [
    { type: "object", patternProperties: { "^a": { type: "string" } } },
    { type: "object", additionalProperties: true },
    { type: "object", properties: { a: { anyOf: [{ type: "string" }, true] } } },
  ]) {
    const out = tryEnforceStrictSchema(schema);
    assert.equal(out.strict, false);
    assert.deepEqual(out.schema, schema);
  }
});

test("strict try: 混合原始类型 enum 不可表达 → strict:false（发无 type schema 只会被 wire 拒绝）", () => {
  const out = tryEnforceStrictSchema({
    type: "object",
    properties: { m: { enum: [1, "two", null] } },
  });
  assert.equal(out.strict, false);
});

test("strict try: 可表达 schema 成功强制，additionalProperties/required 全闭合", () => {
  const out = tryEnforceStrictSchema({
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
  });
  assert.equal(out.strict, true);
  assert.deepEqual(out.schema, {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
  });
});

test("strict try: 结果按输入对象 memoize（重复调用返回同一引用）", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  const first = tryEnforceStrictSchema(schema);
  const second = tryEnforceStrictSchema(schema);
  assert.equal(first, second);
});

// ------------------------------------------------------------
// adapt 组合器与全局旁路
// ------------------------------------------------------------

test("adapt: strict=false 只做 draft 升级直通；strict=true 走强制管线", () => {
  const draft07 = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { a: { type: "string" } },
  };
  const off = adaptSchemaForStrict(draft07, false);
  assert.equal(off.strict, false);
  assert.equal(off.schema.$schema, "https://json-schema.org/draft/2020-12/schema");

  const on = adaptSchemaForStrict(draft07, true);
  assert.equal(on.strict, true);
  assert.equal(on.schema.additionalProperties, false);
  assert.deepEqual(on.schema.required, ["a"]);
});

test("adapt: ACODE_NO_STRICT_TOOL_SCHEMA 全局旁路（omp PI_NO_STRICT 降解）", () => {
  process.env.ACODE_NO_STRICT_TOOL_SCHEMA = "1";
  try {
    const out = adaptSchemaForStrict(
      { type: "object", properties: { a: { type: "string" } } },
      true,
    );
    assert.equal(out.strict, false);
  } finally {
    delete process.env.ACODE_NO_STRICT_TOOL_SCHEMA;
  }
  // 旁路解除后恢复强制
  const restored = adaptSchemaForStrict(
    { type: "object", properties: { a: { type: "string" } } },
    true,
  );
  assert.equal(restored.strict, true);
});
