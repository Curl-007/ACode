// ============================================================
// 发现集合与历史引用投影（specs/tool-search.md R7/R8/R10）
// ============================================================
// 纯函数投影：历史只存真实 tool_reference 引用，本模块在请求准备时把引用
// 在**真实结果位置**展开为 functions 容器；未变化的 entry 复用不可变引用，
// 仅在删除或展开引用时复制对应结果（R7 单一共用循环）。

import type {
  CompactBoundaryPayload,
  ModelMessageContentBlock,
  ModelToolContract,
  ResolvedToolSearchMode,
} from "@acode/contracts";
import { TOOL_SEARCH_NAME } from "@acode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  createLocalToolDefinitionRenderer,
  localToolsAlreadyLoadedReminder,
  localToolsLoadedReminder,
} from "./local-projection.js";

const OPEN_FUNCTIONS_TAG = "<" + "functions>";
const CLOSE_FUNCTIONS_TAG = "</" + "functions>";

/** compact 边界的发现元数据投影：只保留发现事实，不携带 token 计数等边界细节。 */
export function compactDiscoveryMetadata(
  boundary: Pick<CompactBoundaryPayload, "boundaryId" | "preCompactDiscoveredTools">,
) {
  return {
    boundaryId: boundary.boundaryId,
    preCompactDiscoveredTools: [...(boundary.preCompactDiscoveredTools ?? [])],
  };
}

/**
 * 扫描历史收集发现集合：ToolSearch 结果位里的 tool_reference + compact 边界
 * metadata 携带的 pre-compact 发现名（冷恢复水合后同样在此汇合）。
 */
export function collectToolSearchHistory(entries: readonly RuntimeMessageEntry[]) {
  const discovered = new Set<string>();
  const preCompactDiscoveredTools = new Set<string>();
  for (const entry of entries) {
    for (const name of entry.metadata?.compactBoundary?.preCompactDiscoveredTools ?? []) {
      discovered.add(name);
      preCompactDiscoveredTools.add(name);
    }
    if (entry.kind === "attachment" || entry.message.role !== "tool" || entry.message.isError)
      continue;
    if (!Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block.type === "tool_reference") discovered.add(block.toolName);
    }
  }
  return { discovered, preCompactDiscoveredTools };
}

export function collectDiscoveredTools(entries: readonly RuntimeMessageEntry[]): Set<string> {
  return collectToolSearchHistory(entries).discovered;
}

/**
 * 引用投影（Local/Off 共用单一循环）：
 * - local：成功 ToolSearch 结果里的每个引用展开为 function 定义块，连续引用合并进
 *   同一 functions 容器；中间文本切断容器（不跨结果或中间文本合并，保留顺序）；
 *   已在本上下文交付过的工具不再重复展开，改为「已加载」提示；失效引用按移除规则
 *   降级为占位文本；不输出空容器。
 * - off：引用一律移除并降级为占位文本（模式切换只改投影，不伪造历史）。
 * loadedToolCallIds 收集 native 语义下「结果外提示」的调用 id，波 1 local 不消费。
 */
export function projectToolReferences(
  entries: readonly RuntimeMessageEntry[],
  mode: ResolvedToolSearchMode,
  tools: readonly ModelToolContract[],
  deferred: ReadonlySet<string> = new Set(),
): { entries: RuntimeMessageEntry[]; loadedToolCallIds: ReadonlySet<string> } {
  const catalog = mode === "off" ? undefined : new Map(tools.map((tool) => [tool.name, tool]));
  const renderDefinition = mode === "local" ? createLocalToolDefinitionRenderer() : undefined;
  // 同批结果尚未被模型看到：直到下一条 assistant 才合入已交付集合，避免并行搜索互相去重。
  const visible = mode === "local" ? new Set<string>() : undefined;
  const pending = mode === "local" ? new Set<string>() : undefined;
  const projected: RuntimeMessageEntry[] = [];
  const loadedToolCallIds = new Set<string>();
  for (const entry of entries) {
    if (pending && entry.kind !== "attachment" && entry.message.role === "assistant") {
      for (const name of pending) visible!.add(name);
      pending.clear();
    }
    // off 模式不发送公告 attachment（R7：模式切换只改请求投影）。
    if (mode === "off" && entry.metadata?.toolSearchAnnouncement) continue;
    if (
      entry.kind === "attachment" ||
      entry.message.role !== "tool" ||
      !Array.isArray(entry.message.content)
    ) {
      projected.push(entry);
      continue;
    }
    const original = entry.message.content;
    let content: ModelMessageContentBlock[] | undefined;
    let definitions: string[] | undefined;
    let alreadyLoaded: Set<string> | undefined;
    let newlyLoaded: Set<string> | undefined;
    const successfulSearch = entry.message.toolName === TOOL_SEARCH_NAME && !entry.message.isError;
    for (let index = 0; index < original.length; index++) {
      const block = original[index]!;
      if (block.type !== "tool_reference") {
        if (definitions) {
          content!.push(localDefinitionsBlock(definitions));
          definitions = undefined;
        }
        content?.push(block);
        continue;
      }
      const tool = catalog?.get(block.toolName);
      if (tool && !renderDefinition) {
        // 结果外的成功提示仅用于 native（波 2）；local 已在结果内给出加载和调用指引。
        if (successfulSearch && entry.message.toolCallId)
          loadedToolCallIds.add(entry.message.toolCallId);
        content?.push(block);
        continue;
      }
      // 仅在引用确实被移除/展开时复制；普通结果与有效引用直接共享原历史（不可变前缀）。
      content ??= original.slice(0, index);
      if (tool && renderDefinition) {
        if (successfulSearch && deferred.has(tool.name) && visible!.has(tool.name)) {
          (alreadyLoaded ??= new Set()).add(tool.name);
        } else {
          (definitions ??= []).push(renderDefinition(tool));
          // 常驻及 compact 提升工具仍直接调用，不能混入包装调用的首搜指引。
          if (successfulSearch && deferred.has(tool.name))
            (newlyLoaded ??= new Set()).add(tool.name);
        }
        if (successfulSearch) pending!.add(tool.name);
      }
      // 被删除的引用（tool === undefined）不切断连续段：保持“先过滤再展开”的合并语义。
    }
    if (definitions) content!.push(localDefinitionsBlock(definitions));
    if (newlyLoaded)
      content!.push({ type: "text", text: localToolsLoadedReminder([...newlyLoaded]) });
    if (alreadyLoaded)
      content!.push({ type: "text", text: localToolsAlreadyLoadedReminder([...alreadyLoaded]) });
    projected.push(
      content === undefined
        ? entry
        : {
            ...entry,
            message: {
              ...entry.message,
              content: content.length
                ? content
                : [
                    {
                      type: "text",
                      text:
                        mode === "off"
                          ? "[Tool references removed - tool search not enabled]"
                          : "[Tool references removed - tools no longer available]",
                    },
                  ],
            },
          },
    );
  }
  return { entries: projected, loadedToolCallIds };
}

function localDefinitionsBlock(definitions: readonly string[]): ModelMessageContentBlock {
  return {
    type: "text",
    text: `${OPEN_FUNCTIONS_TAG}\n${definitions.join("\n")}\n${CLOSE_FUNCTIONS_TAG}`,
  };
}
