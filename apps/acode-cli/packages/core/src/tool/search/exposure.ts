// ============================================================
// 启用判定与请求投影入口（specs/tool-search.md R1/R4/R7/R8/R9/R12）
// ============================================================
// Runtime 是唯一的请求决策点：本模块把「模式解析 → 候选目录 → 启用判定 →
// tools 投影 → messages 投影 → executor 搜索 context」收在纯函数里，
// 请求准备单点调用一次。不生成新公告、不写历史/DB/全局状态。

import {
  DEFERRED_TOOL_CALL_NAME,
  TOOL_SEARCH_NAME,
  type ModelToolContract,
  type ResolvedToolSearchMode,
  type ToolSearchCandidate,
  type ToolSearchCapability,
  type ToolSearchExecutionContext,
  type ToolSearchMode,
} from "@acode/contracts";
import type { ToolRegistry } from "../registry.js";
import type { ToolMetadata } from "../types.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { LOCAL_TOOL_SEARCH_DESCRIPTION } from "./description.js";
import { collectToolSearchHistory, projectToolReferences } from "./history.js";
import {
  ToolSearchCapabilityError,
  type ToolSearchExposureReason,
} from "./capability.js";

const LOCAL_ADDED_TOOLS_NOTICE = `The following deferred tools are available via ${TOOL_SEARCH_NAME}. Use query "select:<name>[,<name>...]" to load their complete schemas, then call them through ${DEFERRED_TOOL_CALL_NAME} with {name, input}. Call resident tools directly:`;
const MAX_REMOVED_NAME_LINES = 30;
const AMBIENT_CONTEXT_NOTICE =
  "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.";

/**
 * 模型侧事实（由请求准备点从 Model/adapters capability 解析后传入）：
 * 波 1 中 capability.defaultEnabled 恒 false，auto 实际解析为 local。
 */
export interface ToolSearchModelFacts {
  /** 模型是否支持普通工具调用；local 模式的最低能力要求。 */
  readonly supportsToolCall: boolean;
  /** wire 能力探测结果（波 2 由 adapters 能力解析供给，spec R2）；缺席按不支持 native。 */
  readonly capability?: ToolSearchCapability;
}

/**
 * 模式解析（R1）：off 直通；显式 native 在波 1 发送前显式报错（不静默降级）；
 * auto 按 native 能力（波 1 恒 false）→ local → off 逐级回落；显式 local 要求
 * 模型支持普通工具调用，否则同样发送前报错。
 * R13：报错路径统一携带闭集信号（ToolSearchCapabilityError.signal，fail 档），
 * message 保持波 1 文案；消费方按 signal 字段区分原因档位，不解析 message。
 */
export function resolveToolSearchMode(
  mode: ToolSearchMode,
  facts: ToolSearchModelFacts,
): ResolvedToolSearchMode {
  if (mode === "off") return "off";
  if (mode === "native") {
    // 波 1 未实装 native（spec R1/非目标）：显式请求必须报错，不能静默降级。
    throw new ToolSearchCapabilityError(
      "native_not_implemented",
      "native tool search is not implemented in this build; use --toolsearch-mode local or auto",
    );
  }
  if (mode === "auto" && facts.capability?.protocolSupported && facts.capability.defaultEnabled) {
    // 波 2 native 实装后此分支才可达；defaultEnabled 恒 false 时继续向下解析。
    throw new ToolSearchCapabilityError(
      "native_not_implemented",
      "native tool search is not implemented in this build; use --toolsearch-mode local or auto",
    );
  }
  if (facts.supportsToolCall) return "local";
  if (mode === "local")
    // 显式 local + 模型无普通工具调用能力：R1 发送前报错（fail 档，换模型前重试无意义）。
    throw new ToolSearchCapabilityError(
      "tool_call_unsupported",
      "tool search mode local requires a provider that supports tool calls",
    );
  return "off";
}

/**
 * defer 判定（R4）：控制工具与 provider 原生工具永不 defer；alwaysLoad 豁免；
 * metadata.shouldDefer 显式声明或 MCP 工具（mcpPresentation 在场）默认 defer。
 * MCP 默认 defer 走 mcpPresentation 而非名称前缀判定：presentation 只由可信
 * 注册路径写入，模型可见名称不参与决策。
 */
export function isDeferredTool(tool: ModelToolContract, metadata?: ToolMetadata): boolean {
  return (
    tool.name !== TOOL_SEARCH_NAME &&
    tool.name !== DEFERRED_TOOL_CALL_NAME &&
    !tool.providerNative &&
    metadata?.alwaysLoad !== true &&
    (metadata?.shouldDefer === true || metadata?.mcpPresentation !== undefined)
  );
}

export interface ToolExposureInput {
  facts: ToolSearchModelFacts;
  mode?: ToolSearchMode;
  /** 完整候选目录（未经 deferred 裁剪，R8：调用方必须提供全集）。 */
  tools: readonly ModelToolContract[];
  registry?: Pick<ToolRegistry, "get">;
  entries: readonly RuntimeMessageEntry[];
}

/**
 * 候选目录解析：把工具契约 + registry metadata 投影成搜索候选；compact 检查点
 * 提升（R8）在这里生效——preCompactDiscoveredTools 里的工具在 local 模式下不再
 * 标记 deferred（提升为本上下文普通 tools），但控制入口保持可用。
 */
function resolveToolSearchCatalog(
  input: ToolExposureInput,
  preCompactDiscoveredTools: ReadonlySet<string>,
) {
  const requestedMode = resolveToolSearchMode(input.mode ?? "off", input.facts);
  let hasConfiguredDeferred = false;
  const catalog: ToolSearchCandidate[] = input.tools
    .filter((tool) => requestedMode === "local" || tool.name !== DEFERRED_TOOL_CALL_NAME)
    .map((tool) => {
      const entry = input.registry?.get(tool.name);
      const metadata = entry?.metadata;
      const configuredDeferred = isDeferredTool(tool, metadata);
      hasConfiguredDeferred ||= configuredDeferred;
      return {
        name: tool.name,
        ...(entry?.aliases ? { aliases: entry.aliases } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(metadata?.searchHint !== undefined ? { searchHint: metadata.searchHint } : {}),
        ...(metadata?.mcpPresentation
          ? {
              mcp: {
                serverName: metadata.mcpPresentation.serverName,
                toolName: metadata.mcpPresentation.toolName,
              },
            }
          : {}),
        deferred:
          configuredDeferred &&
          !(requestedMode === "local" && preCompactDiscoveredTools.has(tool.name)),
      };
    });
  const deferred = new Set(catalog.filter((tool) => tool.deferred).map((tool) => tool.name));
  const controlsAvailable =
    catalog.some((tool) => tool.name === TOOL_SEARCH_NAME) &&
    (requestedMode !== "local" || catalog.some((tool) => tool.name === DEFERRED_TOOL_CALL_NAME));
  // 全部提升后仍需要控制入口处理后续目录变化，不能用剩余 deferred 数量关闭 local。
  const enabled = requestedMode !== "off" && hasConfiguredDeferred && controlsAvailable;
  const mode: ResolvedToolSearchMode = enabled ? requestedMode : "off";
  // 降级原因闭集（R12/R13）：一次性 debug 日志由调用方记录。R13 分档——auto 因
  // 模型不支持普通工具调用而降级 off 时落 tool_call_unsupported（能力事实），与
  // 用户配置 off 的 provider_disabled（意图事实）可辨识；对照上游 tool_deferred vs
  // tool_deferred_unavailable 的回合原因分档思想。
  const reason: ToolSearchExposureReason = enabled
    ? mode
    : requestedMode === "off"
      ? (input.mode ?? "off") === "off"
        ? "provider_disabled"
        : "tool_call_unsupported"
      : !hasConfiguredDeferred
        ? "no_deferred_tools"
        : "tool_unavailable";
  return { catalog, deferred, enabled, mode, reason };
}

/**
 * 请求准备单点的投影入口（R7/R8）：返回 tools 投影（常驻+控制+已提升）、
 * messages 投影（引用展开/移除）、启用事实与 executor 搜索 context。
 * off 路径（含降级）必须保证 tools 与 entries 原样返回——零行为变化红线。
 */
export function buildToolExposure(input: ToolExposureInput) {
  const { discovered, preCompactDiscoveredTools } = collectToolSearchHistory(input.entries);
  const { catalog, deferred, enabled, mode, reason } = resolveToolSearchCatalog(
    input,
    preCompactDiscoveredTools,
  );
  const tools =
    mode === "off"
      ? // off/降级：完整目录原样发送（引用不可变，快照字节不变）。
        [...input.tools]
      : input.tools
          .filter((tool) => {
            if (tool.name === TOOL_SEARCH_NAME) return enabled;
            if (tool.name === DEFERRED_TOOL_CALL_NAME) return mode === "local";
            // deferred 未提升工具的 schema 不进 tools；native（波 2）按发现集放行。
            return !deferred.has(tool.name);
          })
          .map((tool) =>
            mode === "local" && tool.name === TOOL_SEARCH_NAME
              ? // 控制工具以实际发送的定义覆盖原文案：local 的调用约定不同。
                { ...tool, description: LOCAL_TOOL_SEARCH_DESCRIPTION }
              : tool,
          );
  // local 使用完整目录做引用解析；常驻控制工具以实际发送的定义参与投影。
  const projection = projectToolReferences(
    input.entries,
    mode,
    mode === "local" ? [...input.tools, ...tools] : tools,
    deferred,
  );
  const context: ToolSearchExecutionContext = { enabled, mode, catalog, discovered };
  return { tools, ...projection, enabled, context, reason };
}

/**
 * compact 检查点提升的纯函数面（R8）：成功 compact 的发现检查点把「当前允许的
 * 已发现 deferred 工具」提升为本上下文普通 tools。提升名单 = 发现集 ∩ 当前允许
 * 目录 ∩ configured-deferred；接线点在 compact 边界 payload 的
 * preCompactDiscoveredTools 字段（写侧），读侧由 resolveToolSearchCatalog 生效。
 */
export function computeCompactPromotedTools(
  discovered: ReadonlySet<string>,
  catalog: readonly ToolSearchCandidate[],
): string[] {
  const allowedDeferred = new Set(
    catalog.filter((tool) => tool.deferred).map((tool) => tool.name),
  );
  return [...discovered].filter((name) => allowedDeferred.has(name)).sort();
}

/**
 * 公告生成（R9）：向模型公告 deferred 目录名称清单的增量变化。公告是持久化
 * 轨迹的一部分（attachment entry + metadata 事实），冷恢复由水合重建；本函数
 * 只从历史里的公告事实恢复「已公告/已列出」状态，不建第二缓存。
 */
export function buildToolSearchAnnouncement(
  input: ToolExposureInput,
  compactDiscoveredTools?: ReadonlySet<string>,
): RuntimeMessageEntry | undefined {
  // off 不需要公告或提升信息，保持关闭路径不扫描公告历史。
  if (resolveToolSearchMode(input.mode ?? "off", input.facts) === "off") return undefined;
  const announced = new Set<string>();
  const listed = new Set<string>();
  const preCompactDiscoveredTools = new Set(compactDiscoveredTools);
  for (const entry of input.entries) {
    for (const name of entry.metadata?.compactBoundary?.preCompactDiscoveredTools ?? [])
      preCompactDiscoveredTools.add(name);
    const delta = entry.metadata?.toolSearchAnnouncement;
    if (!delta) continue;
    const readded = new Set(delta.readdedNames);
    for (const name of delta.addedNames) {
      announced.add(name);
      if (!readded.has(name)) listed.add(name);
    }
    for (const name of delta.removedNames) announced.delete(name);
  }
  const { enabled, deferred, mode } = resolveToolSearchCatalog(input, preCompactDiscoveredTools);
  if (!enabled) return undefined;
  const names = [...deferred].sort();
  const addedNames = names.filter((name) => !announced.has(name) || !listed.has(name));
  const readdedNames = names.filter((name) => !announced.has(name) && listed.has(name));
  // deferred 转 alwaysLoad 后工具仍然可用，删除必须对照完整的当前作用域目录。
  const available = new Set(input.tools.map((tool) => tool.name));
  const removedNames = [...announced].filter((name) => !available.has(name)).sort();
  if (addedNames.length === 0 && removedNames.length === 0) return undefined;
  const readded = new Set(readdedNames);
  const listedNames = addedNames.filter((name) => !readded.has(name));
  const paragraphs: string[] = [];
  if (listedNames.length) paragraphs.push(`${LOCAL_ADDED_TOOLS_NOTICE}\n${listedNames.join("\n")}`);
  // 目录变化只证明当前可用性，不能据此推断 MCP 连接状态或其他变化原因。
  if (readdedNames.length) {
    paragraphs.push(
      `${readdedNames.length} deferred tool${readdedNames.length === 1 ? " is" : "s are"} available again (names announced earlier in this conversation): ${summarizeToolNames(readdedNames)}. Load via ${TOOL_SEARCH_NAME} as before.`,
    );
  }
  if (removedNames.length) {
    // 名称事实仍完整保留在 metadata；只有模型可见文案按 server 分组，避免大批删除刷屏。
    paragraphs.push(
      removedNames.length > MAX_REMOVED_NAME_LINES
        ? `${removedNames.length} deferred tools are no longer available: ${summarizeToolNames(removedNames)}. Do not search for them — ${TOOL_SEARCH_NAME} will return no match.`
        : `The following deferred tools are no longer available. Do not search for them — ${TOOL_SEARCH_NAME} will return no match:\n${removedNames.join("\n")}`,
      AMBIENT_CONTEXT_NOTICE,
    );
  }
  void mode;
  return {
    kind: "attachment",
    content: paragraphs.join("\n\n"),
    metadata: {
      source: "tool_search_announcement",
      toolSearchAnnouncement: { addedNames, removedNames, readdedNames },
    },
  };
}

function summarizeToolNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) {
    const group = name.startsWith("mcp__") ? `${name.split("__", 2).join("__")}__*` : name;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => (count > 1 ? `${name} (${count})` : name))
    .join(", ");
}
