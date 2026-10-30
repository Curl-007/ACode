// ============================================================
// 工具按需检索的请求准备单点（specs/tool-search.md R8/R9/R12）
// ============================================================
// turn-loop 在 provider 投影前调用一次：公告生成（R9）→ exposure 判定 →
// tools/messages 投影 → executor 搜索 context 注入。off/降级路径原样返回
// 输入引用——默认 off 零行为变化红线由「不动输入」结构性保证。

import type { Model, ModelToolContract, ToolSearchMode } from "@acode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildToolExposure,
  buildToolSearchAnnouncement,
  type ToolSearchModelFacts,
} from "../../tool/search/exposure.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { getRuntimeToolCachePort } from "../runtime-tool-cache.js";

/** 模型侧事实解析：波 1 native 恒不可用（R2），capability 只登记不参与 auto 解析。 */
function resolveToolSearchModelFacts(model: Model): ToolSearchModelFacts {
  return { supportsToolCall: model.properties.supportsToolCall !== false };
}

function resolveConfiguredMode(runtime: AgentRuntimeInternal): ToolSearchMode {
  // 模式在 runtime 创建/冷恢复时固定（R3）；缺席 = off（旧 Host/旧配置缺省）。
  return runtime.config.toolSearchMode ?? "off";
}

/**
 * 公告生成（R9）：启用搜索的轮次开始时公告 deferred 目录名称清单变化。
 * 返回的 attachment entry 由调用方 commit 进本轮请求 entries（持久化轨迹的一部分）。
 * off/未启用/无变化返回 undefined——关闭路径不扫描公告历史。
 */
export function buildTurnToolSearchAnnouncement(
  runtime: AgentRuntimeInternal,
  model: Model,
  tools: readonly ModelToolContract[],
): RuntimeMessageEntry | undefined {
  const mode = resolveConfiguredMode(runtime);
  if (mode === "off") return undefined;
  // R1 显式模式能力不符：发送前报错，不静默降级（异常沿 turn 错误链上抛）。
  return buildToolSearchAnnouncement({
    facts: resolveToolSearchModelFacts(model),
    mode,
    tools,
    registry: runtime.registry,
    entries: runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
  });
}

/**
 * 请求投影（R7/R8）：返回本次请求实际发送的 tools 与 entries，并把搜索 context
 * 写入 runtime 状态供 executor 注入（ToolSearch/DeferredToolCall 准入的事实源）。
 * 同模型传输重试复用配套请求（调用方在同一次准备内完成）；纯展示/记录/估算
 * 投影不得调用本函数。
 */
export function projectToolSearchRequest(
  runtime: AgentRuntimeInternal,
  model: Model,
  tools: readonly ModelToolContract[],
  entries: readonly RuntimeMessageEntry[],
): { tools: ModelToolContract[]; entries: readonly RuntimeMessageEntry[] } {
  const mode = resolveConfiguredMode(runtime);
  if (mode === "off") {
    // R1-01 B4：toolSearchContext 归 RuntimeToolCacheOwner，写面经端口。
    getRuntimeToolCachePort(runtime).clearToolSearchContext();
    return { tools: [...tools], entries };
  }
  const exposure = buildToolExposure({
    facts: resolveToolSearchModelFacts(model),
    mode,
    tools,
    registry: runtime.registry,
    entries,
  });
  // R1-01 B4：toolSearchContext 归 RuntimeToolCacheOwner，写面经端口。
  getRuntimeToolCachePort(runtime).commitToolSearchContext(exposure.context);
  if (!exposure.enabled) {
    // R12 降级：fail-open 到现状（全量目录照常发送），一次性 debug 原因，不 fail 请求。
    runtime.logger?.debug("Tool search disabled for this request", {
      event: "tool_search.disabled",
      module: "core.runtime",
      reason: exposure.reason,
      requestedMode: mode,
    });
  }
  return { tools: exposure.tools, entries: exposure.entries };
}

