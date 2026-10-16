/**
 * app-shell 侧的内容状态面包屑上报挂载（specs/main-stall-diagnostics.md R11）。
 *
 * 只做装配：route kind 来自 tabStore，transcript 规模与持有行数来自存活 projection store
 * 汇总，composer 块数来自 gauge；折算纯函数在 contentBreadcrumbSample.ts，周期上报器在
 * hooks/useContentStateBreadcrumb.ts。桥缺席（Web / 静态回放 / 桥未接线）时整体不启动，
 * 不产生 interval 与采样开销。
 */
import { useCallback } from "react";
import { useContentStateBreadcrumb } from "@/hooks/useContentStateBreadcrumb.js";
import type { ContentBreadcrumbWirePayload } from "@/lib/contentStateBreadcrumb.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { summarizeLiveProjectionStores } from "@/v4/conversationProjectionStore.js";
import { readComposerContentGauge } from "@/v4/composer/composerContentGauge.js";
import { sampleContentState } from "./contentBreadcrumbSample.js";

export function useAppShellContentBreadcrumb(): void {
  const platform = useOptionalPlatform();
  const sendContentBreadcrumb = platform?.sendContentBreadcrumb;
  // tab 切换是低频事件；selector 只取激活 tab 的 kind（原始值，不产生新对象引用）。
  const activeTabKind = useOptionalTabStore((state) => {
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    return activeTab?.kind ?? null;
  });

  const sample = useCallback(() => {
    // 采样时才读汇总与 gauge：拿到本 tick 的最新值，而不是渲染时快照。
    const summary = summarizeLiveProjectionStores();
    return sampleContentState({
      activeTabKind,
      projectionRows: summary.rows,
      projectionTurnIndexEntries: summary.turnIndexEntries,
      composerBlockCount: readComposerContentGauge(),
    });
  }, [activeTabKind]);

  const send = useCallback(
    (payload: ContentBreadcrumbWirePayload) => {
      sendContentBreadcrumb?.call(platform, payload);
    },
    [platform, sendContentBreadcrumb],
  );

  useContentStateBreadcrumb({
    sample,
    send,
    enabled: typeof sendContentBreadcrumb === "function",
  });
}
