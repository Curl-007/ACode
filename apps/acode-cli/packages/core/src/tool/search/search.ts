// ============================================================
// 工具搜索算法（specs/tool-search.md R5）
// ============================================================
// 纯函数：同目录同查询同输出，稳定排序（Array.prototype.sort 在 V8 稳定，
// 同分保持目录顺序），只返回当前请求允许的候选（catalog 即作用域事实）。

import { TOOL_SEARCH_DEFAULT_RESULTS, type ToolSearchCandidate } from "@acode/contracts";
import { toModelVisibleMcpNamePart } from "../../mcp/name.js";

/**
 * 名称分词：MCP 工具按 server/tool 两段粗粒度 + 分隔符细分；普通工具按
 * camelCase/下划线切词。coarse 保留未切分的整段（如 "session" 命中
 * "session-fleet" 的粗段），parts 是细粒度词。
 */
function tokenize(tool: ToolSearchCandidate) {
  const name = tool.name;
  const mcp = tool.mcp
    ? [name, tool.mcp.serverName, tool.mcp.toolName]
    : /^mcp__(.+?)__(.+)$/.exec(name);
  const coarse = mcp ? [mcp[1]!, mcp[2]!].map((s) => s.toLowerCase()) : [name.toLowerCase()];
  const parts = mcp
    ? coarse.flatMap((s) => s.split(/[\s_.]+/)).filter(Boolean)
    : name
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replaceAll("_", " ")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
  return { coarse, parts, full: parts.join(" "), mcp: Boolean(mcp) };
}

function resolveName(name: string, catalog: readonly ToolSearchCandidate[]) {
  return catalog.find((tool) => tool.name === name || tool.aliases?.includes(name));
}

/**
 * select: 直选优先（名称/别名精确匹配，MCP 允许按原始 toolName 反查），
 * 关键词搜索按 名称 > 别名/粗段 > searchHint > description 加权。
 * `+term` 是名称硬过滤：必须命中名称分词才参与打分。
 */
export function searchTools(
  query: string,
  catalog: readonly ToolSearchCandidate[],
  maxResults = TOOL_SEARCH_DEFAULT_RESULTS,
): string[] {
  const deferred = catalog.filter((tool) => tool.deferred);
  const select = /^select:(.+)$/i.exec(query);
  if (select)
    return [
      ...new Set(
        select[1]!.split(",").flatMap((value) => {
          const name = value.trim();
          // deferred 优先：直选常驻工具也允许（返回定义供参考），但同名时先取 deferred。
          const exact = resolveName(name, deferred) ?? resolveName(name, catalog);
          if (exact) return [exact.name];
          return catalog
            .filter(
              (tool) =>
                tool.mcp &&
                (tool.mcp.toolName === name ||
                  toModelVisibleMcpNamePart(tool.mcp.toolName) === name),
            )
            .map((tool) => tool.name);
        }),
      ),
    ];
  const text = query.toLowerCase().trim();
  const exact =
    deferred.find((tool) => tool.name.toLowerCase() === text) ??
    catalog.find((tool) => tool.name.toLowerCase() === text);
  if (exact) return [exact.name];
  // mcp__ 前缀查询是服务器枚举意图：前缀命中直接返回，不再走关键词打分。
  if (text.startsWith("mcp__") && text.length > 5) {
    const names = deferred
      .filter((tool) => tool.name.toLowerCase().startsWith(text))
      .slice(0, maxResults)
      .map((tool) => tool.name);
    if (names.length > 0) return names;
  }
  const terms = text.split(/\s+/).filter(Boolean);
  const required = terms
    .filter((term) => term.startsWith("+") && term.length > 1)
    .map((term) => term.slice(1));
  const keywords =
    required.length > 0
      ? [...required, ...terms.filter((term) => !(term.startsWith("+") && term.length > 1))]
      : terms;
  const patterns = new Map(
    keywords.map((term) => [
      term,
      new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
    ]),
  );
  return deferred
    .map((tool) => {
      const name = tokenize(tool);
      const description = tool.description?.toLowerCase() ?? "";
      const hint = tool.searchHint?.toLowerCase() ?? "";
      if (
        !required.every(
          (term) =>
            name.parts.some((part) => part.includes(term)) ||
            name.coarse.some((part) => part.includes(term)) ||
            patterns.get(term)!.test(description) ||
            patterns.get(term)!.test(hint),
        )
      )
        return { name: tool.name, score: 0 };
      let score = 0;
      for (const term of keywords) {
        // 权重序：名称细词 > 名称粗段 > 全名兜底 > searchHint > description。
        // MCP 名称是模型唯一可辨识的入口，命中权重略高于内置工具。
        if (name.parts.includes(term)) score += name.mcp ? 12 : 10;
        else if (name.parts.some((part) => part.includes(term))) score += name.mcp ? 6 : 5;
        if (name.coarse.includes(term)) score += name.mcp ? 12 : 10;
        else if (name.coarse.some((part) => part.includes(term))) score += name.mcp ? 4 : 3;
        if (name.full.includes(term) && score === 0) score += 3;
        if (hint && patterns.get(term)!.test(hint)) score += 4;
        if (patterns.get(term)!.test(description)) score += 2;
      }
      return { name: tool.name, score };
    })
    .filter((tool) => tool.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((tool) => tool.name);
}
