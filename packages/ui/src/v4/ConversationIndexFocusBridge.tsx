// U07 目录桥接组件（specs/conversation-index-navigation.md）。
//
// 归属划分：焦点正文的**合成**必须由宿主（SessionPane）做，因为它同时喂给 timeline 的
// rows prop；而「定位成功后滚到哪」是 timeline 派生事实，只能经 timeline 暴露的
// scrollToRowIdActionRef 落地。本组件只负责两件事：渲染目录面板、在焦点提交后请求滚动。
//
// 因此 SessionPane 侧只需一次 hook 调用 + 一次 rows 合成，不必新增滚动编排状态
// （AGENTS.md：避免重复状态和多条写入路径）。
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { ConversationIndexDirectoryPanel } from "@/v4/ConversationIndexDirectoryPanel.js";
import type { ConversationIndexFocusApi } from "@/hooks/useConversationIndexFocus.js";

interface ConversationIndexFocusBridgeProps {
  focusApi: ConversationIndexFocusApi;
  /** timeline 暴露的 rowId 定位动作（unitIndex 由 timeline 自行解析）。 */
  scrollToRowIdRef: { current: ((rowId: number) => void) | null } | null;
  /** timeline 暴露的「回到底部」动作；返回最新时用它恢复尾部滚动意图。 */
  scrollToBottomRef: { current: (() => void) | null } | null;
  isRunning?: boolean;
  className?: string;
}

/**
 * 焦点提交 → 滚动；返回最新 → 恢复尾部滚动意图。
 *
 * 定位只认 `targetFound` 翻真的那一次：同一焦点目标重复渲染不得重复抢滚动
 * （用户此后在焦点正文里自由滚动是合法交互，不能被 effect 拉回）。
 *
 * 返回最新必须显式滚回尾部（spec 规则 5）：定位路径调用过 `commitFollowing(false)`，
 * 因此焦点释放后 timeline 仍处于「不跟随」状态，光清掉焦点行不会自己回到底部——
 * 否则用户点完「返回最新」仍停在历史位置，看到的是一个变短的窗口而不是当前尾部。
 *
 * 滚动**绑定在用户的显式动作上**，而不是「focus.rows 由非空变空」的状态跳变：
 * 后者也会被 rewind 失效、定位失败等路径触发，那些场景不应把用户拽回底部。
 */
function ConversationIndexFocusBridgeImpl({
  focusApi,
  scrollToRowIdRef,
  scrollToBottomRef,
  isRunning = false,
  className,
}: ConversationIndexFocusBridgeProps) {
  const { focus, returnToLive } = focusApi;
  const scrolledTargetRef = useRef<number | null>(null);

  useEffect(() => {
    if (!focus.targetFound || focus.targetRowId === null) return;
    if (scrolledTargetRef.current === focus.targetRowId) return;
    scrolledTargetRef.current = focus.targetRowId;
    // 焦点正文提交与虚拟列表挂载不在同一帧；action 内部对未挂载目标直接返回，
    // 这里用 rAF 等到 rows 进入 renderUnits 后再请求一次。
    const frame = window.requestAnimationFrame(() => {
      scrollToRowIdRef?.current?.(focus.targetRowId as number);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focus.targetFound, focus.targetRowId, scrollToRowIdRef]);

  // 依赖 returnToLive（hook 内 useCallback 稳定）而非整个 focusApi：
  // 后者每次焦点变化都换引用，会让 panelApi 随之变化并击穿面板的 memo。
  const handleReturnToLive = useCallback(() => {
    returnToLive();
    scrolledTargetRef.current = null;
    // 等焦点行退出渲染后再滚，否则 timeline 会先按变短的内容算一次高度再被拉回。
    window.requestAnimationFrame(() => {
      scrollToBottomRef?.current?.();
    });
  }, [returnToLive, scrollToBottomRef]);

  // 只覆盖 returnToLive 一项，其余原样透传；memo 保持面板引用稳定。
  const panelApi = useMemo(
    () => ({ ...focusApi, returnToLive: handleReturnToLive }),
    [focusApi, handleReturnToLive],
  );

  return (
    <ConversationIndexDirectoryPanel
      focusApi={panelApi}
      isRunning={isRunning}
      className={className}
    />
  );
}

export const ConversationIndexFocusBridge = memo(ConversationIndexFocusBridgeImpl);
