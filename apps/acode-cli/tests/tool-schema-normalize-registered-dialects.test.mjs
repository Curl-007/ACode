import assert from "node:assert/strict";
import { test } from "node:test";

// spec: apps/acode-cli/specs/tool-schema-normalize.md 验收场景 6（纯入册方言）。
// 移植锚点：omp packages/ai/test/{schema-normalization,google-tool-schema,
// foundation-models-schema}.test.ts 对应章节（CCA 用例逐条取自 omp 原测试期望）。
// 这些方言在 ACode 波 3 无消费者：入册 = 懒加载 + 本文件单测锚定语义。

const {
  normalizeSchemaForGoogle,
  normalizeSchemaForCCA,
} = await import("../packages/adapters/src/model/schema-normalize/dialect-google.ts");
const {
  sanitizeSchemaForOllama,
  sanitizeSchemaForGrammar,
} = await import("../packages/adapters/src/model/schema-normalize/dialect-ollama-grammar.ts");
const { sanitizeSchemaForCursor } = await import(
  "../packages/adapters/src/model/schema-normalize/dialect-cursor.ts"
);
const {
  toFoundationModelsSchema,
  decodeFoundationModelsArguments,
} = await import("../packages/adapters/src/model/schema-normalize/apple-foundation-models.ts");
const { loadSchemaDialect, LAZY_SCHEMA_DIALECTS } = await import(
  "../packages/adapters/src/model/schema-normalize/index.ts"
);

// ------------------------------------------------------------
// Google（Gemini/Vertex）
// ------------------------------------------------------------

test("Google: 剥不支持键（additionalProperties/$schema）且结构键不 spill，校验键 spill 进 description", () => {
  const out = normalizeSchemaForGoogle({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: { a: { type: "string", pattern: "^x" } },
  });
  assert.equal("$schema" in out, false);
  assert.equal("additionalProperties" in out, false);
  // additionalProperties 是结构键：剥了但不进 description
  assert.equal(out.description, undefined);
  assert.deepEqual(out.properties.a, { type: "string", description: '{pattern: "^x"}' });
});

test("Google: [T,null] → T + nullable:true；校验键 spill", () => {
  const out = normalizeSchemaForGoogle({ type: ["string", "null"], minLength: 1 });
  assert.deepEqual(out, { type: "string", nullable: true, description: "{minLength: 1}" });
});

test("Google: 多类型数组分支化，items 只随 array 分支（Gemini 对 string 旁 items 400）", () => {
  const out = normalizeSchemaForGoogle({
    type: ["string", "array"],
    items: { type: "string" },
    minLength: 2,
  });
  const stringBranch = out.anyOf.find((b) => b.type === "string");
  const arrayBranch = out.anyOf.find((b) => b.type === "array");
  assert.equal("items" in stringBranch, false);
  assert.ok(String(stringBranch.description).includes("minLength"));
  assert.deepEqual(arrayBranch.items, { type: "string" });
});

test("Google: const → 单成员 enum；{const:null} 折成 nullable 且 enum 移除（omp 锚点用例）", () => {
  assert.deepEqual(normalizeSchemaForGoogle({ const: "x" }), { type: "string", enum: ["x"] });
  const nullConst = normalizeSchemaForGoogle({ const: null });
  assert.equal(nullConst.type, undefined);
  assert.equal(nullConst.nullable, true);
  assert.equal(nullConst.enum, undefined);
});

test("Google: object 补空 properties；多属性自动生成 propertyOrdering；非字符串 enum 丢弃但保留 type", () => {
  assert.deepEqual(normalizeSchemaForGoogle({ type: "object" }), {
    type: "object",
    properties: {},
  });
  const ordered = normalizeSchemaForGoogle({
    type: "object",
    properties: { b: { type: "string" }, a: { type: "number" } },
  });
  assert.deepEqual(ordered.propertyOrdering, ["b", "a"]);
  assert.deepEqual(normalizeSchemaForGoogle({ type: "number", enum: [1, 2] }), { type: "number" });
});

test("Google: 承载非字符串 enum 的 not 约束整体丢弃（丢否定只放宽不收窄）", () => {
  const out = normalizeSchemaForGoogle({ type: "string", not: { enum: [1, 2] } });
  assert.equal("not" in out, false);
  assert.equal(out.type, "string");
});

// ------------------------------------------------------------
// Cloud Code Assist Claude
// ------------------------------------------------------------

test("CCA: Google 剥键先行 + object 补 properties + spill（omp 锚点用例逐字）", () => {
  const sanitized = normalizeSchemaForCCA({
    type: "object",
    additionalProperties: false,
    properties: {
      config: { type: "object", additionalProperties: false },
      name: { type: "string", minLength: 2, pattern: "^[a-z]+$" },
    },
    required: ["config", "name"],
  });
  assert.deepEqual(sanitized, {
    type: "object",
    properties: {
      config: { type: "object", properties: {} },
      name: { type: "string", description: '{minLength: 2, pattern: "^[a-z]+$"}' },
    },
    required: ["config", "name"],
  });
});

test("CCA: 注解关键字 deprecated/readOnly/writeOnly/$comment 剥除（protojson 400 面）", () => {
  const sanitized = normalizeSchemaForCCA({
    type: "object",
    properties: {
      projectId: { type: "string", deprecated: true, readOnly: true },
      screenId: { type: "string", writeOnly: true, $comment: "internal id" },
      name: { type: "string" },
    },
    required: ["name"],
  });
  assert.deepEqual(sanitized, {
    type: "object",
    properties: {
      projectId: { type: "string" },
      screenId: { type: "string" },
      name: { type: "string" },
    },
    required: ["name"],
  });
});

test("CCA: object-union anyOf 合并后不保留 stale required（omp 锚点用例逐字）", () => {
  const prepared = normalizeSchemaForCCA({
    required: ["a"],
    anyOf: [
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
    ],
  });
  assert.deepEqual(prepared, {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "number" } },
  });
});

test("CCA: object anyOf 合并保留 required 交集（omp 锚点用例语义）", () => {
  const prepared = normalizeSchemaForCCA({
    type: "object",
    properties: {
      profile: {
        anyOf: [
          {
            type: "object",
            properties: { id: { type: "string" }, name: { type: "string" } },
            required: ["id", "name"],
          },
          {
            type: "object",
            properties: { id: { type: "string" }, age: { type: "number" } },
            required: ["id", "age"],
          },
        ],
      },
    },
  });
  const profile = prepared.properties.profile;
  assert.equal(profile.type, "object");
  assert.deepEqual(Object.keys(profile.properties).sort(), ["age", "id", "name"]);
  assert.deepEqual(profile.required, ["id"]);
});

test("CCA: 同型 anyOf 折叠到首分支（mixed 折叠 bailout 时）", () => {
  const prepared = normalizeSchemaForCCA({
    type: "object",
    properties: {
      value: {
        anyOf: [
          { type: "string", description: "first" },
          { type: "string", minLength: 2 },
        ],
      },
    },
    required: ["value"],
  });
  const value = prepared.properties.value;
  assert.equal(value.type, "string");
  assert.equal(value.anyOf, undefined);
});

test("CCA: 混合类型折叠选非数组类型时剥数组专属键", () => {
  const normalized = normalizeSchemaForCCA({
    anyOf: [
      { type: "string", minLength: 1 },
      { type: "array", items: { type: "string" } },
    ],
  });
  assert.equal(normalized.type, "string");
  assert.equal("items" in normalized, false);
  assert.equal("anyOf" in normalized, false);
});

test("CCA: 不可折叠的残留 combiner 触发每工具回退 {type:object,properties:{}}（硬停门）", () => {
  const fallback = normalizeSchemaForCCA({
    type: "object",
    properties: {
      // 两个标量分支携带**冲突的 default**（共享键、非 description）：
      // mixed 折叠对冲突字段 bailout，同型折叠类型不同 bailout，object 合并
      // 非对象分支 bailout → 残留 anyOf → combiners 硬停 → 每工具回退。
      p: { anyOf: [{ type: "string", default: "a" }, { type: "number", default: 1 }] },
    },
  });
  assert.deepEqual(fallback, { type: "object", properties: {} });
});

// ------------------------------------------------------------
// Ollama
// ------------------------------------------------------------

test("Ollama: 布尔子 schema 加宽为全类型 union，false 用 not 包裹", () => {
  const out = sanitizeSchemaForOllama({ type: "array", items: true });
  assert.deepEqual(
    out.items.anyOf.map((b) => b.type),
    ["string", "number", "boolean", "object", "array", "null"],
  );
  const closed = sanitizeSchemaForOllama({ type: "object", properties: { a: false } });
  assert.ok(closed.properties.a.not.anyOf.length === 6);
});

test("Ollama: 布尔 additionalProperties/unevaluatedProperties 剥除（Go 解析器噎住面）", () => {
  const out = sanitizeSchemaForOllama({
    type: "object",
    additionalProperties: false,
    unevaluatedProperties: true,
    properties: { a: { type: "string" } },
  });
  assert.equal("additionalProperties" in out, false);
  assert.equal("unevaluatedProperties" in out, false);
  assert.deepEqual(out.properties, { a: { type: "string" } });
});

test("Ollama: type 数组——单非 null 归约标量，多类型变 allOf+anyOf 包裹", () => {
  assert.deepEqual(sanitizeSchemaForOllama({ type: ["string", "null"] }), { type: "string" });
  const multi = sanitizeSchemaForOllama({ type: ["string", "number"] });
  assert.equal("type" in multi, false);
  assert.deepEqual(multi.allOf, [
    { anyOf: [{ type: "string" }, { type: "number" }] },
  ]);
});

test("Ollama: 无改写时按引用直通", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(sanitizeSchemaForOllama(schema), schema);
});

// ------------------------------------------------------------
// grammar（llama.cpp/LM Studio/vLLM）
// ------------------------------------------------------------

test("grammar: 裸布尔子 schema 加宽，但布尔 additionalProperties 保持闭合语义", () => {
  const out = sanitizeSchemaForGrammar({
    type: "object",
    additionalProperties: false,
    properties: { open: true },
    items: true,
  });
  assert.equal(out.additionalProperties, false);
  assert.ok(out.properties.open.anyOf.length === 6);
  assert.ok(out.items.anyOf.length === 6);
});

test("grammar: 根裸 true 也加宽（子 schema 槽位语义）；对象形态 additionalProperties 内部布尔被加宽", () => {
  assert.ok(sanitizeSchemaForGrammar(true).anyOf.length === 6);
  const out = sanitizeSchemaForGrammar({
    type: "object",
    additionalProperties: { items: true },
  });
  assert.ok(out.additionalProperties.items.anyOf.length === 6);
});

test("grammar: 无裸布尔时按引用直通（比 Ollama 窄——只碰子 schema 槽位）", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { a: { type: "string" } },
  };
  assert.equal(sanitizeSchemaForGrammar(schema), schema);
});

// ------------------------------------------------------------
// Cursor 投影
// ------------------------------------------------------------

function collectCombiners(value, found = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectCombiners(entry, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(value[key])) found.push(key);
    }
    for (const child of Object.values(value)) collectCombiners(child, found);
  }
  return found;
}

test("Cursor: object anyOf 合并进 properties（union 属性并集）", () => {
  const out = sanitizeSchemaForCursor({
    type: "object",
    properties: {
      p: {
        anyOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "number" } } },
        ],
      },
    },
  });
  assert.equal(out.properties.p.type, "object");
  assert.deepEqual(Object.keys(out.properties.p.properties).sort(), ["a", "b"]);
  assert.deepEqual(collectCombiners(out), []);
});

test("Cursor: 标量 union 整体丢弃（加宽为全接受而不是收窄到单分支）", () => {
  const out = sanitizeSchemaForCursor({
    type: "object",
    properties: { s: { anyOf: [{ type: "string" }, { type: "number" }] } },
  });
  assert.deepEqual(collectCombiners(out), []);
  assert.ok("s" in out.properties);
});

test("Cursor: 含 combiner 的 not 整体丢弃（丢否定只放宽），$defs 先解引用", () => {
  const out = sanitizeSchemaForCursor({
    type: "object",
    properties: { x: { $ref: "#/$defs/X" } },
    $defs: { X: { type: "string" } },
    not: { anyOf: [{ type: "string" }] },
  });
  assert.equal("not" in out, false);
  assert.deepEqual(out.properties.x, { type: "string" });
  assert.deepEqual(collectCombiners(out), []);
});

// ------------------------------------------------------------
// Apple Foundation Models lowering
// ------------------------------------------------------------

test("Apple: object 补 title/x-order/required/additionalProperties:false", () => {
  const { schema, encodedPaths } = toFoundationModelsSchema(
    {
      type: "object",
      properties: { a: { type: "string" }, n: { type: "number", minimum: 1 } },
      required: ["a"],
    },
    "my.tool",
  );
  assert.deepEqual(schema, {
    type: "object",
    title: "my_tool",
    properties: { a: { type: "string" }, n: { type: "number", minimum: 1 } },
    required: ["a"],
    "x-order": ["a", "n"],
    additionalProperties: false,
  });
  assert.deepEqual(encodedPaths, []);
});

test("Apple: 自由 map 降级为 JSON 编码字符串并登记 encodedPaths，解码往返", () => {
  const { schema, encodedPaths } = toFoundationModelsSchema(
    {
      type: "object",
      properties: {
        meta: { type: "object", additionalProperties: { type: "string" } },
      },
    },
    "t",
  );
  assert.deepEqual(schema.properties.meta, {
    type: "string",
    description: "(JSON-encoded value)",
  });
  assert.deepEqual(encodedPaths, [["meta"]]);
  const decoded = decodeFoundationModelsArguments({ meta: '{"x":"y"}' }, encodedPaths);
  assert.deepEqual(decoded, { meta: { x: "y" } });
});

test("Apple: 字符串字面量 union 折成 string enum；数组元素路径用 * 通配", () => {
  const { schema } = toFoundationModelsSchema(
    { type: "object", properties: { c: { anyOf: [{ const: "a" }, { const: "b" }] } } },
    "t",
  );
  assert.deepEqual(schema.properties.c, { type: "string", enum: ["a", "b"] });

  const tuple = toFoundationModelsSchema(
    {
      type: "object",
      properties: { list: { type: "array", items: { type: "object", additionalProperties: true } } },
    },
    "t",
  );
  assert.deepEqual(tuple.encodedPaths, [["list", "*"]]);
  const decoded = decodeFoundationModelsArguments({ list: ['{"a":1}', '{"b":2}'] }, tuple.encodedPaths);
  assert.deepEqual(decoded, { list: [{ a: 1 }, { b: 2 }] });
});

test("Apple: 非对象根回退为空参数对象（带原 description）", () => {
  const { schema, encodedPaths } = toFoundationModelsSchema(
    { type: "string", description: "raw" },
    "t",
  );
  assert.deepEqual(schema, {
    type: "object",
    title: "t",
    properties: {},
    required: [],
    "x-order": [],
    additionalProperties: false,
    description: "raw",
  });
  assert.deepEqual(encodedPaths, []);
});

// ------------------------------------------------------------
// 懒加载名录（spec R6：无消费者方言不进启动路径）
// ------------------------------------------------------------

test("懒加载: loadSchemaDialect 按名解析全部入册方言模块", async () => {
  assert.deepEqual(LAZY_SCHEMA_DIALECTS, [
    "google",
    "cca",
    "ollama",
    "grammar",
    "cursor",
    "apple-foundation-models",
  ]);
  const google = await loadSchemaDialect("google");
  assert.equal(typeof google.normalizeSchemaForGoogle, "function");
  assert.equal(typeof google.normalizeSchemaForCCA, "function");
  const ollama = await loadSchemaDialect("ollama");
  assert.equal(typeof ollama.sanitizeSchemaForOllama, "function");
  const grammar = await loadSchemaDialect("grammar");
  assert.equal(typeof grammar.sanitizeSchemaForGrammar, "function");
  const cursor = await loadSchemaDialect("cursor");
  assert.equal(typeof cursor.sanitizeSchemaForCursor, "function");
  const apple = await loadSchemaDialect("apple-foundation-models");
  assert.equal(typeof apple.toFoundationModelsSchema, "function");
});
