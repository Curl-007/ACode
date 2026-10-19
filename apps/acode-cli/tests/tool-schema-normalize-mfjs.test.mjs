import assert from "node:assert/strict";
import { test } from "node:test";

// spec: apps/acode-cli/specs/tool-schema-normalize.md 验收场景 5（MFJS 方言）。
// 移植锚点：omp packages/ai/test/schema-normalization.test.ts 的
// normalizeSchemaForMoonshot 章节（用例逐条对应）。

const { normalizeSchemaForMoonshot } = await import(
  "../packages/adapters/src/model/schema-normalize/dialect-moonshot.ts"
);

test("MFJS: 全裸 const 的 anyOf 折成 typed enum（omp 锚点用例）", () => {
  const normalized = normalizeSchemaForMoonshot({
    anyOf: [
      { const: "pr_checkout", description: "github operation" },
      { const: "pr_create", description: "github operation" },
    ],
    description: "github operation",
  });
  assert.deepEqual(normalized, {
    type: "string",
    enum: ["pr_checkout", "pr_create"],
    description: "github operation",
  });
});

test("MFJS: 裸 enum 推断标量 type（omp 锚点用例）", () => {
  const normalized = normalizeSchemaForMoonshot({ enum: ["capabilities", "definition"] });
  assert.deepEqual(normalized, { type: "string", enum: ["capabilities", "definition"] });
});

test("MFJS: 剥数组/字符串校验关键字并 spill 进 description（omp 锚点用例）", () => {
  const normalized = normalizeSchemaForMoonshot({
    type: "array",
    description: "globs",
    minItems: 1,
    maxItems: 10,
    items: { type: "string", maxLength: 256, pattern: "^x" },
  });
  assert.equal(normalized.minItems, undefined);
  assert.equal(normalized.maxItems, undefined);
  assert.ok(String(normalized.description).includes("minItems"));
  assert.ok(String(normalized.description).includes("maxItems"));
  const items = normalized.items;
  assert.equal(items.type, "string");
  assert.equal(items.maxLength, undefined);
  assert.equal(items.pattern, undefined);
  // items 子节点被剥的关键字也 spill 进自己的（新建的）description
  assert.ok(String(items.description).includes("maxLength"));
});

test("MFJS: additionalProperties（布尔与 schema）、type:null 分支、default 全保留（omp 锚点用例）", () => {
  const normalized = normalizeSchemaForMoonshot({
    type: "object",
    properties: {
      env: { type: "object", additionalProperties: { type: "string" } },
      extra: { type: "object", additionalProperties: true },
      skip: { anyOf: [{ type: "number" }, { type: "null" }] },
      limit: { type: "integer", default: 10 },
    },
  });
  const props = normalized.properties;
  assert.deepEqual(props.env.additionalProperties, { type: "string" });
  assert.equal(props.extra.additionalProperties, true);
  assert.deepEqual(props.skip.anyOf, [{ type: "number" }, { type: "null" }]);
  assert.deepEqual(props.limit, { type: "integer", default: 10 });
});

test("MFJS: schema 值 additionalProperties 走 walker，字面 default 载荷不走（omp 锚点用例）", () => {
  const literal = { oneOf: [{ const: "literal-a" }, { const: "literal-b" }] };
  const normalized = normalizeSchemaForMoonshot({
    type: "object",
    additionalProperties: { oneOf: [{ const: 1 }, { const: 2 }] },
    default: literal,
  });
  assert.deepEqual(normalized, {
    type: "object",
    additionalProperties: { type: "number", enum: [1, 2] },
    default: literal,
  });
});

test("MFJS: oneOf 折入 anyOf（MFJS 只认 anyOf）", () => {
  const normalized = normalizeSchemaForMoonshot({
    type: "object",
    properties: {
      p: { oneOf: [{ type: "string" }, { type: "number" }] },
    },
  });
  assert.deepEqual(normalized.properties.p, {
    anyOf: [{ type: "string" }, { type: "number" }],
  });
});

test("MFJS: type 必须标量——[T,null] 归约为 T（nullable 不支持），多类型分支化", () => {
  const nullable = normalizeSchemaForMoonshot({ type: ["string", "null"] });
  assert.deepEqual(nullable, { type: "string" });

  const multi = normalizeSchemaForMoonshot({
    type: ["string", "number"],
    minLength: 2,
    minimum: 0,
  });
  // 每个类型一个 anyOf 分支，类型专属键只随对应分支；MFJS 拒绝 minLength/
  // minimum，剥离后 spill 进各分支 description
  assert.deepEqual(multi.anyOf, [
    { type: "string", description: "{minLength: 2}" },
    { type: "number", description: "{minimum: 0}" },
  ]);
});

test("MFJS: 非字符串/数字 enum 整体丢弃但保留推断 type；prefixItems 剥离", () => {
  const normalized = normalizeSchemaForMoonshot({
    type: "array",
    enum: [[1], [2]],
    prefixItems: [{ type: "string" }],
  });
  assert.equal("enum" in normalized, false);
  assert.equal(normalized.type, "array");
  assert.equal("prefixItems" in normalized, false);
});

test("MFJS: 布尔子 schema permissive 折叠（MFJS 无精确 false schema）", () => {
  const normalized = normalizeSchemaForMoonshot({
    type: "object",
    properties: { open: true, closed: false },
  });
  assert.deepEqual(normalized.properties.open, {});
  assert.deepEqual(normalized.properties.closed, {});
});

test("MFJS: nullable 关键字折掉——{type:string,nullable:true} → {type:string}（omp 锚点用例）", () => {
  assert.deepEqual(normalizeSchemaForMoonshot({ type: "string", nullable: true }), {
    type: "string",
  });
});
