import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * P5 tools schema token 度量的验收测试。
 *
 * 覆盖规格 apps/acode-cli/specs/tools-schema-token-metrics.md 的验收场景 1–4：
 * 度量构建（计数/MCP 去重/确定性）、占比判据字段 toolSchemaRatioPercent、
 * 两个度量点的序列化口径合一、只写本地 debug 日志的红线。
 */

const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const {
  buildToolsSchemaTokenMetric,
  stringifyToolContractForEstimation,
} = await import("../packages/core/src/runtime/methods/tools-schema-token-metric.ts");
const { compactContextUsageSnapshot } = await import(
  "../packages/core/src/runtime/methods/context-usage-log-compact.ts"
);
const { buildToolUsageDetail } = await import(
  "../packages/core/src/runtime/methods/context-usage.ts"
);
const { estimateTokens } = await import("../packages/core/src/context/utils.ts");

const TOKENIZER = "acode.estimateTokens.v1";

function makeTool(overrides) {
  return {
    name: "Read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    readOnly: true,
    sideEffectScope: "none",
    ...overrides,
  };
}

test("(场景 1) 度量：计数、MCP server 去重、chars/tokens 与独立手算一致", () => {
  const tools = [
    makeTool({}),
    makeTool({ name: "mcp__srv1__foo", description: "foo", readOnly: false }),
    makeTool({ name: "mcp__srv1__bar", description: "bar", readOnly: false }),
    makeTool({ name: "mcp__srv2__baz", description: "baz", readOnly: false }),
  ];
  const metric = buildToolsSchemaTokenMetric(tools);
  assert.equal(metric.toolCount, 4);
  assert.equal(metric.systemToolCount, 1);
  assert.equal(metric.mcpToolCount, 3);
  assert.equal(metric.mcpServerCount, 2, "srv1 的两个工具只算一个 server");
  assert.equal(metric.tokenizer, TOKENIZER);

  // chars/tokens 用**独立实现**手算同一个口径（序列化字段集与估算器），锁定数值不是自说自话。
  const expectedContents = tools.map((tool) =>
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      capability: tool.capability,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      readOnly: tool.readOnly,
      destructive: tool.destructive,
      sideEffectScope: tool.sideEffectScope,
      permission: tool.permission,
      resultBudget: tool.resultBudget,
    }),
  );
  assert.equal(metric.schemaChars, expectedContents.reduce((sum, c) => sum + c.length, 0));
  assert.equal(
    metric.schemaTokens,
    expectedContents.reduce((sum, c) => sum + estimateTokens(c), 0),
  );

  // 确定性：同输入两次构建逐字段一致（估算无随机、无时钟依赖）。
  assert.deepEqual(buildToolsSchemaTokenMetric(tools), metric);
});

test("(场景 1) 空工具面：全 0，不抛错", () => {
  const metric = buildToolsSchemaTokenMetric([]);
  assert.deepEqual(metric, {
    toolCount: 0,
    systemToolCount: 0,
    mcpToolCount: 0,
    mcpServerCount: 0,
    schemaChars: 0,
    schemaTokens: 0,
    tokenizer: TOKENIZER,
  });
});

test("(场景 3) 口径合一：context usage 逐工具明细与度量点共用同一序列化", () => {
  const tool = makeTool({ name: "mcp__srv1__foo", readOnly: false });
  const content = stringifyToolContractForEstimation(tool);
  assert.equal(content.length > 0, true);

  // buildToolUsageDetail 是 runtime 方法；用最小 stub 提供 estimatedMetric（与实现同口径）。
  const stubThis = {
    estimatedMetric: (text) => ({
      chars: text.length,
      tokens: estimateTokens(text),
      tokenMethod: "estimated",
      confidence: "low",
      tokenizer: TOKENIZER,
    }),
  };
  const detail = buildToolUsageDetail.call(stubThis, tool);
  assert.equal(detail.chars, content.length);
  assert.equal(detail.tokens, estimateTokens(content));
  assert.equal(detail.source, "mcp_tool");
  // 单工具度量与逐工具明细数值一致 → 两个度量点不可能给出互相矛盾的 schema token。
  const metric = buildToolsSchemaTokenMetric([tool]);
  assert.equal(metric.schemaChars, detail.chars);
  assert.equal(metric.schemaTokens, detail.tokens);
});

test("(场景 2) toolSchemaRatioPercent：两类 schema 合计占比、除零缺席、无 schema 为 0", () => {
  const snapshot = {
    totalTokens: 1000,
    categories: [
      { source: "system_prompt", tokens: 0 },
      { source: "system_tool_schemas", tokens: 100 },
      { source: "mcp_tool_schemas", tokens: 80 },
      { source: "messages", tokens: 820 },
    ],
  };
  const compacted = compactContextUsageSnapshot(snapshot);
  assert.equal(compacted.toolSchemaRatioPercent, 18);

  // tool_prompt 不计入分子（R2）：加上它占比也不变。
  const withToolPrompt = compactContextUsageSnapshot({
    ...snapshot,
    categories: [...snapshot.categories, { source: "tool_prompt", tokens: 0 }],
  });
  assert.equal(withToolPrompt.toolSchemaRatioPercent, 18);

  // 分母为 0：字段缺席，不产出假数字（R2）。
  const zeroDenominator = compactContextUsageSnapshot({ totalTokens: 0, categories: [] });
  assert.equal("toolSchemaRatioPercent" in zeroDenominator, false);
  // 分母非法（缺席/NaN）同样缺席。
  assert.equal(
    "toolSchemaRatioPercent" in compactContextUsageSnapshot({ categories: [] }),
    false,
  );
  assert.equal(
    "toolSchemaRatioPercent" in compactContextUsageSnapshot({ totalTokens: NaN, categories: [] }),
    false,
  );

  // 有分母、无 schema 分类 → 0（合法事实：该请求没有工具面）。
  const noSchemas = compactContextUsageSnapshot({
    totalTokens: 500,
    categories: [{ source: "messages", tokens: 500 }],
  });
  assert.equal(noSchemas.toolSchemaRatioPercent, 0);

  // 既有字段零回归：compact 输出的原有键不受新字段影响。
  assert.equal(compacted.totalTokens, 1000);
  assert.equal(compacted.categories, snapshot.categories);
});

test("(场景 4/红线) 度量点只写本地 debug 日志，装配在 getTools 缓存重建分支", async () => {
  const metricSource = await read(
    "apps/acode-cli/packages/core/src/runtime/methods/tools-schema-token-metric.ts",
  );
  // 收紧口径：只断言**代码级**引用（导入/网络调用），注释里提及 "no-telemetry 红线" 是文档事实。
  assert.doesNotMatch(metricSource, /from\s+["'][^"']*telemetry/i);
  assert.doesNotMatch(metricSource, /fetch\(|new\s+WebSocket|https?:\/\//);
  assert.doesNotMatch(metricSource, /appendEvent|eventStore|sessionStore|writeFile/);
  assert.match(metricSource, /logger\?\.debug/);
  assert.match(metricSource, /tools_schema_token_metric/);

  // R1 装配点：getTools 的缓存重建分支（且仅在该分支——每模型请求不重复序列化）。
  const configSource = await read("apps/acode-cli/packages/core/src/runtime/methods/config.ts");
  const getToolsBody = configSource.slice(
    configSource.indexOf("export function getTools"),
    configSource.indexOf("export function invalidateToolCache"),
  );
  assert.match(getToolsBody, /if \(this\.cachedTools === null\) \{[\s\S]*logToolsSchemaTokenMetric\(this, this\.cachedTools\);/);
  assert.equal(
    getToolsBody.split("logToolsSchemaTokenMetric").length - 1,
    1,
    "metric fires only on cache rebuild",
  );

  // R4 口径一致性：两个度量点声明同一个 tokenizer 标识。
  const contextUsageSource = await read(
    "apps/acode-cli/packages/core/src/runtime/methods/context-usage.ts",
  );
  assert.match(contextUsageSource, /acode\.estimateTokens\.v1/);
  assert.match(metricSource, /acode\.estimateTokens\.v1/);
  // context usage 的逐工具明细确实改走共享序列化（不再各抄一份字段清单）。
  assert.match(contextUsageSource, /stringifyToolContractForEstimation\(tool\)/);
});
