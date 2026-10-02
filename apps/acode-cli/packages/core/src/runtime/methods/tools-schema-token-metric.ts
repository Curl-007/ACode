/**
 * P5 tools schema token 度量（specs/tools-schema-token-metrics.md）。
 *
 * 延迟工具 ToolSearch 的立项判据是「tools schema token 占比 > 15%」，判据成立与否需要数据。
 * 本模块提供两个 debug 级本地度量点中的**度量点一**（工具面事实，R1）：
 * `getTools` 缓存重建时点（= 工具面变化时点）记一条 `tools_schema_token_metric`，
 * 给出工具数量、MCP 占比与 schema 的本地估算 token——「MCP-heavy 会话分布」的采样点。
 * 占比判据字段（度量点二 `toolSchemaRatioPercent`）住 context usage 快照的日志投影层
 * （`context-usage-log-compact.ts`，R2）。
 *
 * 红线（R3/no-telemetry）：只写本地 debug 日志，不外发、不进遥测通道、不新增写入路径；
 * 度量纯读 `ModelToolContract[]`，不改变工具组装与调度决策。
 */

import { estimateTokens } from "../deps.js";
import type { ModelToolContract } from "../deps.js";
import { parseMcpToolName, stringifyForEstimation } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 与 context usage 快照同一个估算器标识（`context-usage.ts` 的 `estimatedMetricFromKnown`）。
 * 判据比较只在同一估算器内进行（R4）；两个度量点各写各的字面量会漂移，测试锁定同值。
 */
const SCHEMA_TOKEN_ESTIMATOR = "acode.estimateTokens.v1";

export interface ToolsSchemaTokenMetric {
  toolCount: number;
  systemToolCount: number;
  mcpToolCount: number;
  /** 去重后的 MCP server 数（`mcp__<server>__<tool>` 的 server 段）。 */
  mcpServerCount: number;
  schemaChars: number;
  /** 本地估算 token（非 provider 计数，confidence=low，R4）。 */
  schemaTokens: number;
  tokenizer: string;
}

/**
 * 单个工具契约的估算序列化。**唯一口径源**：context usage 快照的逐工具明细
 * （`buildToolUsageDetail`）与本度量共用它，两处字段清单不可能各抄一份漂移（R4）。
 * 字段集 = 发给 provider 的 schema 承载面（name/description/capability/输入输出 schema/
 * 安全与权限声明/结果预算）。
 */
export function stringifyToolContractForEstimation(tool: ModelToolContract): string {
  return stringifyForEstimation({
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
  });
}

/** 纯函数：对一组工具契约算出 R1 度量。空列表合法（全 0）。 */
export function buildToolsSchemaTokenMetric(tools: ModelToolContract[]): ToolsSchemaTokenMetric {
  let systemToolCount = 0;
  let mcpToolCount = 0;
  let schemaChars = 0;
  let schemaTokens = 0;
  const mcpServers = new Set<string>();
  for (const tool of tools) {
    const content = stringifyToolContractForEstimation(tool);
    schemaChars += content.length;
    schemaTokens += estimateTokens(content);
    const mcp = parseMcpToolName(tool.name);
    if (mcp) {
      mcpToolCount += 1;
      mcpServers.add(mcp.serverName);
    } else {
      systemToolCount += 1;
    }
  }
  return {
    toolCount: tools.length,
    systemToolCount,
    mcpToolCount,
    mcpServerCount: mcpServers.size,
    schemaChars,
    schemaTokens,
    tokenizer: SCHEMA_TOKEN_ESTIMATOR,
  };
}

/**
 * 度量点一的日志出口：debug 级、每缓存重建至多一条。口径 = 运行时可见工具全集
 * （缓存重建时点；每模型的 WebSearch 过滤与 projection 只可能再减一个工具，不影响量级，R1）。
 */
export function logToolsSchemaTokenMetric(
  runtime: AgentRuntimeInternal,
  tools: ModelToolContract[],
): void {
  runtime.logger?.debug("Tools schema token metric", {
    event: "tools_schema_token_metric",
    module: "core.runtime",
    status: "completed",
    ...buildToolsSchemaTokenMetric(tools),
  });
}
