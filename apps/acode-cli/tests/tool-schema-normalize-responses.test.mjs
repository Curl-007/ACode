import assert from "node:assert/strict";
import { test } from "node:test";

// spec: apps/acode-cli/specs/tool-schema-normalize.md 验收场景 3（Responses 方言，必做路径）。
// 移植锚点：omp packages/ai/test/schema-normalization.test.ts 的
// sanitizeSchemaForOpenAIResponses 与 empty-schema normalization 章节语义。

const { sanitizeSchemaForOpenAIResponses } = await import(
  "../packages/adapters/src/model/schema-normalize/dialect-openai-responses.ts"
);

test("Responses: oneOf 重写为 anyOf；与既有 anyOf 拼接", () => {
  const out = sanitizeSchemaForOpenAIResponses({
    type: "object",
    properties: {
      a: { oneOf: [{ type: "string" }, { type: "number" }] },
      b: { anyOf: [{ type: "boolean" }], oneOf: [{ type: "null" }] },
    },
  });
  assert.deepEqual(out.properties.a, { anyOf: [{ type: "string" }, { type: "number" }] });
  assert.deepEqual(out.properties.b, {
    anyOf: [{ type: "boolean" }, { type: "null" }],
  });
  assert.equal("oneOf" in out.properties.a, false);
});

test("Responses: object 节点（含 type 数组携带 object）补空 properties", () => {
  const out = sanitizeSchemaForOpenAIResponses({
    type: "object",
    properties: {
      nested: { type: "object" },
      unionObj: { type: ["object", "null"] },
    },
  });
  assert.deepEqual(out.properties.nested, { type: "object", properties: {} });
  assert.deepEqual(out.properties.unionObj, {
    type: ["object", "null"],
    properties: {},
  });
});

test("Responses: 剥离 pattern 里的 lookaround，转义形态与合法分组不误伤", () => {
  const out = sanitizeSchemaForOpenAIResponses({
    type: "object",
    properties: {
      lookahead: { type: "string", pattern: "foo(?=bar)" },
      lookbehind: { type: "string", pattern: "(?<=a)b" },
      negative: { type: "string", pattern: "a(?!b)" },
      escaped: { type: "string", pattern: "\\(?maybe" },
      group: { type: "string", pattern: "(?:ab)+" },
    },
  });
  assert.equal("pattern" in out.properties.lookahead, false);
  assert.equal("pattern" in out.properties.lookbehind, false);
  assert.equal("pattern" in out.properties.negative, false);
  assert.equal(out.properties.escaped.pattern, "\\(?maybe");
  assert.equal(out.properties.group.pattern, "(?:ab)+");
});

test("Responses: patternProperties 的 lookaround 键回退进 .*（多键 anyOf 聚合）", () => {
  const out = sanitizeSchemaForOpenAIResponses({
    type: "object",
    patternProperties: {
      "^x(?=y)": { type: "string" },
      "^z(?=w)": { type: "number" },
      "^plain$": { type: "boolean" },
    },
  });
  assert.deepEqual(out.patternProperties, {
    ".*": { anyOf: [{ type: "string" }, { type: "number" }] },
    "^plain$": { type: "boolean" },
  });
});

test("Responses: {} 空 schema 归一为 true（grammar 采样器语义，omp issue #1179）", () => {
  const out = sanitizeSchemaForOpenAIResponses({
    type: "object",
    properties: { open: {}, annotated: { description: "kept" } },
  });
  assert.equal(out.properties.open, true);
  // 带注解的节点非空对象，不归一为 true
  assert.deepEqual(out.properties.annotated, { description: "kept" });
  // 全部键都被剥空的节点同样归一为 true（空输出 ≡ 空 schema）
  const stripped = sanitizeSchemaForOpenAIResponses({
    type: "object",
    properties: { p: { pattern: "(?=x)" } },
  });
  assert.equal(stripped.properties.p, true);
  // 空 oneOf 数组会以 anyOf:[] 重新发射（wire 只接受单个 union）
  const emptied = sanitizeSchemaForOpenAIResponses({
    type: "object",
    properties: { q: { oneOf: [] } },
  });
  assert.deepEqual(emptied.properties.q, { anyOf: [] });
});

test("Responses: 字面载荷（enum/const/default/examples）内的 schema 形态关键字不改写", () => {
  const literal = { oneOf: [{ const: "literal" }], type: "object" };
  const out = sanitizeSchemaForOpenAIResponses({
    type: "object",
    properties: {
      a: { enum: [literal] },
      b: { const: literal },
      c: { default: literal },
      d: { examples: [literal] },
    },
  });
  assert.deepEqual(out.properties.a.enum, [literal]);
  assert.deepEqual(out.properties.b.const, literal);
  assert.deepEqual(out.properties.c.default, literal);
  assert.deepEqual(out.properties.d.examples, [literal]);
});

test("Responses: 无改写时按引用直通（引用相等 = 零变化验收锚点）", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string", description: "d" } },
    required: ["a"],
    additionalProperties: false,
  };
  assert.equal(sanitizeSchemaForOpenAIResponses(schema), schema);
});

test("Responses: $defs/dependencies 映射位置被归一，非对象 dependencies 直通", () => {
  const out = sanitizeSchemaForOpenAIResponses({
    type: "object",
    $defs: { D: { type: "object" } },
    dependencies: { a: ["b"] },
    dependentSchemas: { c: { type: "object" } },
  });
  assert.deepEqual(out.$defs.D, { type: "object", properties: {} });
  assert.deepEqual(out.dependencies, { a: ["b"] });
  assert.deepEqual(out.dependentSchemas.c, { type: "object", properties: {} });
});
