import { countContextPrefixMessages } from "../deps.js";
import type { Model } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";
import { getRuntimeCacheDiagnosticsPort } from "../runtime-cache-diagnostics.js";
import { getRuntimeContextInitPort } from "../runtime-context-init.js";

export function rebuildContextPrefix(
  runtime: AgentRuntimeInternal,
  options: { model?: Model; turnRequestEntries?: readonly RuntimeMessageEntry[] } = {},
): readonly RuntimeMessageEntry[] {
  if (!runtime.contextBuilder || !runtime.contextInitialized) {
    // 首轮 context 初始化前，model/outputStyle/language 变更只能刷新同步预览，
    // 不能把 config-only fallback envInfo 写入 config.envInfo。否则真实 context source
    // 会以为 envInfo 已由外部显式提供，跳过平台和 git 探测。
    if (runtime.contextBuilder) {
      // R1-01 B4：contextBuilder 归 RuntimeContextInitOwner，写面经端口（端口获取
      // 留在写分支内——未初始化分支是纯读面，与迁移前一样不触 owner）。
      getRuntimeContextInitPort(runtime).commitContextBuilder(
        runtime.createContextBuilderFromSnapshot(
          runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
          runtime.memoryRoot,
          {
            memoryIndexContent: runtime.memoryIndexContent,
            model: options.model,
            persistEnvInfo: false,
          },
        ),
      );
    }
    return options.turnRequestEntries ?? runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  }

  // R1-01 B4：contextBuilder/latestContextBuildResult 归 RuntimeContextInitOwner，写面经端口。
  const contextInitPort = getRuntimeContextInitPort(runtime);
  const contextSnapshot =
    runtime.contextSourceSnapshot ??
    runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory);
  const rebuiltBuilder = runtime.createContextBuilderFromSnapshot(
    contextSnapshot,
    runtime.memoryRoot,
    { memoryIndexContent: runtime.memoryIndexContent, model: options.model },
  );
  contextInitPort.commitContextBuilder(rebuiltBuilder);
  const effectiveContextResult = rebuiltBuilder.build();
  const contextEntries = buildContextHistoryEntries(effectiveContextResult);
  const canonicalEntries = runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  const canonicalConversationEntries = canonicalEntries.slice(
    countContextPrefixMessages(canonicalEntries),
  );

  contextInitPort.commitContextBuildResult(effectiveContextResult);
  runtime.messageHistory.replaceMessages([...contextEntries, ...canonicalConversationEntries]);
  // context 前缀重建后缓存前缀可能已变（prompt-cache-diagnostics.md R1）。
  // R1-01 B1：pendingCacheMissCause 归 RuntimeCacheDiagnosticsOwner，写入经端口。
  getRuntimeCacheDiagnosticsPort(runtime).setPendingCacheMissCause("context_refresh");

  const turnEntries = options.turnRequestEntries;
  if (!turnEntries) return runtime.messageHistory.borrowReadOnlyRuntimeEntries();
  return [...contextEntries, ...turnEntries.slice(countContextPrefixMessages(turnEntries))];
}
