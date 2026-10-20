// ============================================================
// 工具按需检索的冷恢复水合（specs/tool-search.md R10）
// ============================================================
// 会话冷恢复时把持久化载荷还原为运行时事实：ToolSearch 结果内容（引用块）、
// compact 边界发现元数据、公告增量。水合失败不 fail 会话——回退 legacy 工具
// 结果并 warn 一次，与上游 hydrate 系列同语义。

import {
  PersistedToolSearchContentSchema,
  ToolSearchAnnouncementSchema,
  compactBoundaryPayloadSchema,
  type Logger,
} from "@acode/contracts";
import { compactDiscoveryMetadata } from "../tool/search/history.js";

/**
 * ToolSearch 结果内容水合：合法 → 引用块数组（投影时展开为定义容器）；
 * 非法/缺席 → undefined，调用方回退 legacy 工具结果文本并只 warn 一次。
 */
export function hydrateToolSearchContent(value: unknown, logger?: Logger) {
  if (value === undefined) return undefined;
  const parsed = PersistedToolSearchContentSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  logger?.warn("Invalid persisted ToolSearch content; using legacy tool result", {
    event: "session.tool_search.invalid_content",
    module: "core.session",
  });
  return undefined;
}

/** compact 边界 payload 的发现元数据水合：提升名单的读侧事实（R8/R10）。 */
export function hydrateCompactDiscovery(value: unknown) {
  const parsed = compactBoundaryPayloadSchema.safeParse(value);
  return parsed.success ? compactDiscoveryMetadata(parsed.data) : undefined;
}

/** 公告增量水合：非法事实按缺席处理（公告可由下一轮收集重建，不 fail 恢复）。 */
export function hydrateToolSearchAnnouncement(value: unknown) {
  if (value === undefined) return undefined;
  const parsed = ToolSearchAnnouncementSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
