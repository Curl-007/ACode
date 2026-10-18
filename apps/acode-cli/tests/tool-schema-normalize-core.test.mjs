import assert from "node:assert/strict";
import { test } from "node:test";

// spec: apps/acode-cli/specs/tool-schema-normalize.md 验收场景 1（内核）。
// 移植锚点：omp packages/ai/test/schema-normalization.test.ts 的
// upgradeJsonSchemaTo202012 / 循环安全 / DAG 共享子树章节语义。

const {
  upgradeJsonSchemaTo202012,
  schemaNeedsDraft202012Upgrade,
} = await import("../packages/adapters/src/model/schema-normalize/draft.ts");
const { dereferenceJsonSchema } = await import(
  "../packages/adapters/src/model/schema-normalize/dereference.ts"
);
const {
  areJsonValuesEqual,
  mergeCompatibleEnumSchemas,
  mergePropertySchemas,
} = await import("../packages/adapters/src/model/schema-normalize/equality.ts");
const { spillToDescription } = await import(
  "../packages/adapters/src/model/schema-normalize/spill.ts"
);
const { isValidJsonSchema } = await import(
  "../packages/adapters/src/model/schema-normalize/meta-validator.ts"
);
const {
  parseLocalRefPointer,
  formatLocalRefPointer,
} = await import("../packages/adapters/src/model/schema-normalize/ref-pointer.ts");
const { normalizeSchema } = await import(
  "../packages/adapters/src/model/schema-normalize/normalize-core.ts"
);

// ------------------------------------------------------------
// draft-07 → 2020-12 升级
// ------------------------------------------------------------

test("draft: 无需升级时按引用直通（零变化快路径）", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(schemaNeedsDraft202012Upgrade(schema), false);
  assert.equal(upgradeJsonSchemaTo202012(schema), schema);
});

test("draft: draft-07 $schema URI 改写为 2020-12，definitions 并入 $defs，$ref 同步改写", () => {
  const upgraded = upgradeJsonSchemaTo202012({
    $schema: "http://json-schema.org/draft-07/schema#",
    definitions: { Foo: { type: "string" } },
    properties: { foo: { $ref: "#/definitions/Foo" } },
  });
  assert.deepEqual(upgraded, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { Foo: { type: "string" } },
    properties: { foo: { $ref: "#/$defs/Foo" } },
  });
});

test("draft: items 数组（tuple）→ prefixItems，additionalItems:false 保留为 items:false", () => {
  const upgraded = upgradeJsonSchemaTo202012({
    type: "array",
    items: [{ type: "string" }, { type: "number" }],
    additionalItems: false,
  });
  assert.deepEqual(upgraded, {
    type: "array",
    prefixItems: [{ type: "string" }, { type: "number" }],
    items: false,
  });
});

test("draft: additionalItems:true 或缺省 == 2020-12 的无 items", () => {
  const upgraded = upgradeJsonSchemaTo202012({
    type: "array",
    items: [{ type: "string" }],
    additionalItems: true,
  });
  assert.deepEqual(upgraded, { type: "array", prefixItems: [{ type: "string" }] });
});

test("draft: dependencies 拆分为 dependentRequired（数组）与 dependentSchemas（schema）", () => {
  const upgraded = upgradeJsonSchemaTo202012({
    type: "object",
    dependencies: {
      a: ["b", "c"],
      d: { required: ["e"] },
    },
  });
  assert.deepEqual(upgraded, {
    type: "object",
    dependentRequired: { a: ["b", "c"] },
    dependentSchemas: { d: { required: ["e"] } },
  });
});

test("draft: OpenAPI nullable:true 按形状升级（标量 type 扩数组 / 无 type 包 anyOf）", () => {
  assert.deepEqual(upgradeJsonSchemaTo202012({ type: "string", nullable: true }), {
    type: ["string", "null"],
  });
  const wrapped = upgradeJsonSchemaTo202012({
    properties: { a: { type: "string" } },
    nullable: true,
  });
  assert.deepEqual(wrapped, {
    anyOf: [{ properties: { a: { type: "string" } } }, { type: "null" }],
  });
});

// ------------------------------------------------------------
// 本地 $ref 解引用
// ------------------------------------------------------------

test("dereference: 内联 $defs 引用、剥除 $defs，兄弟键压过被引 def", () => {
  const out = dereferenceJsonSchema({
    type: "object",
    properties: {
      a: { $ref: "#/$defs/A", description: "sibling wins" },
    },
    $defs: { A: { type: "string", description: "def loses" } },
  });
  assert.deepEqual(out, {
    type: "object",
    properties: { a: { type: "string", description: "sibling wins" } },
  });
});

test("dereference: 循环引用发 {} 断环；外部引用原样保留；无 $defs 按引用直通", () => {
  const cyclic = dereferenceJsonSchema({
    $defs: {
      Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
    },
    properties: { root: { $ref: "#/$defs/Node" } },
  });
  assert.deepEqual(cyclic.properties.root.properties.next, {});

  const external = { properties: { a: { $ref: "https://example.com/x.json" } } };
  assert.deepEqual(dereferenceJsonSchema(external), external);

  const noDefs = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(dereferenceJsonSchema(noDefs), noDefs);
});

// ------------------------------------------------------------
// 相等性与合并原语
// ------------------------------------------------------------

test("equality: 深比较、enum 并集合并、属性合并成 anyOf", () => {
  assert.equal(areJsonValuesEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] }), true);
  assert.equal(areJsonValuesEqual({ a: 1 }, { a: 1, b: 2 }), false);

  const merged = mergeCompatibleEnumSchemas(
    { type: "string", enum: ["a"] },
    { type: "string", enum: ["b", "a"] },
  );
  assert.deepEqual(merged, { type: "string", enum: ["a", "b"] });
  // type 不一致 → null（不合并）
  assert.equal(
    mergeCompatibleEnumSchemas({ type: "string", enum: ["a"] }, { type: "number", enum: [1] }),
    null,
  );

  // 不相等且不兼容 enum → anyOf 去重合并
  assert.deepEqual(mergePropertySchemas({ type: "string" }, { type: "number" }), {
    anyOf: [{ type: "string" }, { type: "number" }],
  });
  assert.deepEqual(
    mergePropertySchemas({ anyOf: [{ type: "string" }] }, { type: "string" }),
    { type: "string" },
  );
});

// ------------------------------------------------------------
// spill 格式化
// ------------------------------------------------------------

test("spill: spill 格式追加 {k: v} 块，paren 格式追加 (k: v)，空条目不动", () => {
  const node = { description: "ID" };
  spillToDescription(node, [
    ["pattern", "^\\d+$"],
    ["minimum", 0],
  ]);
  assert.equal(node.description, 'ID\n\n{pattern: "^\\\\d+$", minimum: 0}');

  const paren = { description: "base" };
  spillToDescription(paren, [["format", "uuid"]], "paren");
  assert.equal(paren.description, "base (format: uuid)");

  const untouched = { description: "x" };
  spillToDescription(untouched, [["pattern", undefined]]);
  assert.equal(untouched.description, "x");
});

// ------------------------------------------------------------
// 结构元校验器
// ------------------------------------------------------------

test("meta-validator: 合法子集通过，畸形关键字拒绝", () => {
  assert.equal(isValidJsonSchema({ type: "object", properties: { a: { type: "string" } } }), true);
  assert.equal(isValidJsonSchema(true), true);
  assert.equal(isValidJsonSchema({ type: "nope" }), false);
  assert.equal(isValidJsonSchema({ type: "array", additionalItems: { type: "string" } }), false);
  assert.equal(isValidJsonSchema({ enum: [] }), false);
  assert.equal(isValidJsonSchema({ pattern: "(" }), false);
  assert.equal(isValidJsonSchema({ type: "object", required: ["a", "a"] }), false);
});

// ------------------------------------------------------------
// RFC 6901 pointer 解析/编码
// ------------------------------------------------------------

test("ref-pointer: 本地解析、~1/~0 反转义、percent 解码、非本地拒绝、往返", () => {
  assert.deepEqual(parseLocalRefPointer("#"), []);
  assert.deepEqual(parseLocalRefPointer("#/$defs/Foo"), ["$defs", "Foo"]);
  assert.deepEqual(parseLocalRefPointer("#/a~1b/c~0d"), ["a/b", "c~d"]);
  assert.deepEqual(parseLocalRefPointer("#%2Fdefinitions%2Ffoo"), ["definitions", "foo"]);
  assert.equal(parseLocalRefPointer("https://x/y"), undefined);
  assert.equal(parseLocalRefPointer("#%zz"), undefined);
  assert.equal(formatLocalRefPointer(["$defs", "a/b"]), "#/$defs/a~1b");
  assert.deepEqual(parseLocalRefPointer(formatLocalRefPointer(["$defs", "a/b"])), ["$defs", "a/b"]);
});

// ------------------------------------------------------------
// 通用 walker（normalizeSchema 选项核）
// ------------------------------------------------------------

const baseOptions = {
  unsupportedFields: () => false,
  normalizeFieldNames: false,
  collapseNullFields: false,
  scalarizeTypeArrays: false,
  stripNullableKeyword: false,
  autoPropertyOrdering: false,
  ensureObjectProperties: false,
  liftStrippedToDescription: false,
  mergeObjectCombiners: false,
  collapseSameTypeCombiners: false,
  collapseMixedTypeCombiners: false,
  stripResidualCombinersFixpoint: false,
  extractNullableFromUnions: false,
  inferTypeForBareEnum: false,
  foldOneOfIntoAnyOf: false,
  dropNonScalarEnum: false,
};

test("walker: snake_case combinator 键改名，碰撞时 snake_case 胜出（python-genai 语义）", () => {
  const out = normalizeSchema(
    { any_of: [{ type: "string" }], anyOf: [{ type: "number" }] },
    { ...baseOptions, normalizeFieldNames: true },
  );
  assert.deepEqual(out, { anyOf: [{ type: "string" }] });
});

test("walker: scalarizeTypeArrays 把 [T,null] 折成 T+nullable，并剔除异型关键字", () => {
  const out = normalizeSchema(
    { type: ["string", "null"], items: { type: "string" } },
    { ...baseOptions, scalarizeTypeArrays: true },
  );
  assert.deepEqual(out, { type: "string", nullable: true });
});

test("walker: 布尔子 schema 折叠——standard 用 not 表达 false，permissive 用 {}", () => {
  const standard = normalizeSchema(
    { type: "object", properties: { a: false, b: true } },
    { ...baseOptions, coerceBooleanSubschemas: "standard" },
  );
  assert.deepEqual(standard.properties, { a: { not: {} }, b: {} });
  const permissive = normalizeSchema(
    { type: "object", properties: { a: false } },
    { ...baseOptions, coerceBooleanSubschemas: "permissive" },
  );
  assert.deepEqual(permissive.properties, { a: {} });
});

test("walker: 关键字槽位的裸布尔保持字面量（additionalProperties:false 不误折）", () => {
  const out = normalizeSchema(
    { type: "object", additionalProperties: false },
    { ...baseOptions, coerceBooleanSubschemas: "standard" },
  );
  assert.equal(out.additionalProperties, false);
});

test("walker: 循环引用短路为 {}，DAG 共享子树在每个出现点都归一", () => {
  const shared = { type: ["string", "null"] };
  const cyclic = { type: "object", properties: { self: null } };
  cyclic.properties.self = cyclic;
  const outCyclic = normalizeSchema(cyclic, { ...baseOptions, scalarizeTypeArrays: true });
  assert.deepEqual(outCyclic.properties.self, {});

  const dag = { type: "object", properties: { a: shared, b: shared } };
  const outDag = normalizeSchema(dag, { ...baseOptions, scalarizeTypeArrays: true });
  assert.deepEqual(outDag.properties.a, { type: "string", nullable: true });
  assert.deepEqual(outDag.properties.b, { type: "string", nullable: true });
});

test("walker: properties 下的键是属性名不是关键字（def/items 属性名不误伤）", () => {
  const schema = {
    type: "object",
    properties: { def: { type: "string" }, items: { type: "number" } },
    required: ["def"],
  };
  const out = normalizeSchema(schema, { ...baseOptions });
  assert.deepEqual(out, schema);
});

test("walker: enum/const/default 字面载荷不被 walker 改写", () => {
  const literal = { any_of: "not-a-combiner-payload", oneOf: [{ const: "x" }] };
  const out = normalizeSchema(
    { type: "object", default: literal, enum: [literal] },
    { ...baseOptions, normalizeFieldNames: true },
  );
  assert.deepEqual(out.default, literal);
  assert.deepEqual(out.enum, [literal]);
});
