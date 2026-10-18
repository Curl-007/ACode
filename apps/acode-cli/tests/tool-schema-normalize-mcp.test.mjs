import assert from "node:assert/strict";
import { test } from "node:test";

// spec: apps/acode-cli/specs/tool-schema-normalize.md 验收场景 2（MCP 方言 + descriptor 集成）。
// 移植锚点：omp packages/ai/test/schema-normalization.test.ts 的 normalizeSchemaForMCP 章节。

const { normalizeSchemaForMCP } = await import(
  "../packages/adapters/src/model/schema-normalize/dialect-mcp.ts"
);
const { normalizeMcpToolDescriptor } = await import(
  "../packages/adapters/src/mcp/descriptor.ts"
);

test("MCP: 校验关键字保留、description 不改写（omp 锚点用例）", () => {
  const normalized = normalizeSchemaForMCP({
    type: "string",
    pattern: "^\\d+$",
    minLength: 1,
    description: "ID",
  });
  assert.deepEqual(normalized, {
    type: "string",
    pattern: "^\\d+$",
    minLength: 1,
    description: "ID",
  });
});

test("MCP: 恰好叫 def 的普通属性名不被误当定义块处理（omp 锚点用例）", () => {
  const schema = {
    type: "object",
    properties: { def: { type: "string" } },
    required: ["def"],
  };
  assert.deepEqual(normalizeSchemaForMCP(schema), schema);
});

test("MCP: 剥 $schema 与 nullable 关键字（nullable:true 先经 draft 升级为 null union）", () => {
  const normalized = normalizeSchemaForMCP({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      a: { type: "string", nullable: true },
      b: { type: "number", nullable: false },
    },
  });
  assert.equal("$schema" in normalized, false);
  // draft 升级把 nullable:true 折进 type union；MCP 方言不做标量化，union 保留。
  assert.deepEqual(normalized.properties.a, { type: ["string", "null"] });
  assert.deepEqual(normalized.properties.b, { type: "number" });
});

test("MCP: 注册边界内联本地 $defs 引用并剥除 $defs（发送面不再需要解析器）", () => {
  const normalized = normalizeSchemaForMCP({
    type: "object",
    properties: {
      child: { $ref: "#/$defs/Child", description: "sibling wins" },
    },
    $defs: { Child: { type: "string", description: "def" } },
  });
  assert.deepEqual(normalized, {
    type: "object",
    properties: { child: { type: "string", description: "sibling wins" } },
  });
});

test("MCP: draft-07 tuple 形态在注册边界升级为 prefixItems", () => {
  const normalized = normalizeSchemaForMCP({
    type: "object",
    properties: {
      pair: { type: "array", items: [{ type: "string" }, { type: "number" }] },
    },
  });
  assert.deepEqual(normalized.properties.pair, {
    type: "array",
    prefixItems: [{ type: "string" }, { type: "number" }],
  });
});

// ------------------------------------------------------------
// descriptor 物化点集成（spec R2.1 插点）
// ------------------------------------------------------------

test("descriptor: inputSchema 在物化点统一归一（draft-07 升级 + $defs 内联）", () => {
  const descriptor = normalizeMcpToolDescriptor(
    "srv",
    {
      name: "tool.a",
      description: "d",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          child: { $ref: "#/$defs/Child" },
          pair: { type: "array", items: [{ type: "string" }] },
        },
        $defs: { Child: { type: "string" } },
      },
    },
    1000,
  );
  assert.equal(descriptor.name, "mcp__srv__tool_a");
  assert.equal("$schema" in descriptor.inputSchema, false);
  assert.equal("$defs" in descriptor.inputSchema, false);
  assert.deepEqual(descriptor.inputSchema.properties.child, { type: "string" });
  assert.deepEqual(descriptor.inputSchema.properties.pair, {
    type: "array",
    prefixItems: [{ type: "string" }],
  });
});

test("descriptor: 存量形状零变化（注册面零回归锚点：{type:object,properties:{}}）", () => {
  const descriptor = normalizeMcpToolDescriptor("srv", {
    name: "echo",
    description: "echo",
    inputSchema: { type: "object", properties: {} },
  });
  assert.deepEqual(descriptor.inputSchema, { type: "object", properties: {} });
});

test("descriptor: 非对象 inputSchema 走既有兜底投影（fail-safe，不归一）", () => {
  const descriptor = normalizeMcpToolDescriptor("srv", { name: "t", inputSchema: "nope" });
  assert.deepEqual(descriptor.inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: true,
  });
});

test("descriptor: 归一保留 additionalProperties 与校验关键字（温和归一，不折叠）", () => {
  const descriptor = normalizeMcpToolDescriptor("srv", {
    name: "t",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string", pattern: "^x", minLength: 2 } },
      required: ["a"],
      anyOf: [{ required: ["a"] }],
    },
  });
  assert.equal(descriptor.inputSchema.additionalProperties, false);
  assert.deepEqual(descriptor.inputSchema.properties.a, {
    type: "string",
    pattern: "^x",
    minLength: 2,
  });
  // combiner 保留（MCP 方言不折叠）
  assert.deepEqual(descriptor.inputSchema.anyOf, [{ required: ["a"] }]);
});
