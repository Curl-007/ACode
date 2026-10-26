// U07 目录索引与窗口外跳转的 renderer 侧读取入口（specs/conversation-index-navigation.md）。
//
// AGENTS.md：组件通过 hooks 访问服务，Zustand/外部 store 状态不在组件里复制第二份。
// 本 hook 只做「订阅 + 转发动作」，所有裁决仍在 store/控制器里——因此目录打开
// 不触发任何 rowsRange 请求（spec 规则 1 / U07-A1 门槛）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSyncExternalStore } from "react";
import { useACodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import {
  IDLE_INDEX_FOCUS_STATE,
  type IndexFocusState,
} from "@/v4/conversationIndexFocusController.js";
import type { IndexDirectory } from "@/v4/conversationIndexNavigation.js";
import { EMPTY_INDEX_DIRECTORY } from "@/v4/conversationIndexFocusTypes.js";

export interface ConversationIndexFocusApi {
  /** 目录视图（0 个正文请求）；含覆盖范围与淘汰可识别标记。 */
  directory: IndexDirectory;
  /**
   * 目录面板开关（UI 局部状态，唯一所有者就是本 hook）。
   *
   * 为什么状态放在这里而不是面板组件：目录求值成本与索引规模成正比
   * （实测 8000 项时冷求值 ≈2 ms），而索引在流式输出期间每个 delta 都会变，
   * 缓存必然未命中。若无论面板开关都求值，等于在流式热路径上白烧 CPU
   * （本仓库正是被 renderer 侧这类无谓开销拖到 OOM 的，见 renderer-memory-budget.md）。
   * 因此开关必须与求值在同一层，才能做到「关闭时零成本」。
   */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** 派生只读焦点视图；idle 时 rows 为空。 */
  focus: IndexFocusState;
  /** 焦点正文（严格早于尾部窗口）；调用方前插到渲染 rows 之前。 */
  focusRows: IndexFocusState["rows"];
  /** 是否处于历史聚焦（据此显示「返回最新」并抑制尾部跟随）。 */
  isFocused: boolean;
  /** 点击目录项定位；陈旧点击/响应由 store 内部作废（spec 规则 7）。 */
  focusIndexedRow: (rowId: number) => void;
  /** 显式「继续加载更早」（spec 规则 3：超范围必须用户动作）。 */
  continueOlder: () => void;
  /** 返回最新：清焦点、作废在途请求、恢复尾部滚动意图。 */
  returnToLive: () => void;
}

function subscribeNoop(): () => void {
  return () => {};
}

/**
 * 订阅 store 的目录与历史焦点。
 *
 * 焦点态走独立订阅通道（`subscribeIndexFocus`），避免历史浏览触发主投影订阅者的
 * 全量重渲染；主投影订阅只用于让目录在索引/尾部变化后重新求值。
 */
export function useConversationIndexFocus(
  store: ConversationProjectionStore | null,
): ConversationIndexFocusApi {
  const { intl } = useACodeIntl();
  const fallbackSummary = intl.formatMessage({ id: "chat.indexDirectory.emptySummary" });

  // 目录摘要空文案由 i18n 注入 store（store 不持有词典）。变更后控制器会失效缓存。
  useEffect(() => {
    store?.setIndexDirectoryFallbackSummary(fallbackSummary);
  }, [fallbackSummary, store]);

  const projectionState = useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? subscribeNoop(),
    () => store?.getState() ?? null,
    () => null,
  );
  const focus = useSyncExternalStore(
    (listener) => store?.subscribeIndexFocus(listener) ?? subscribeNoop(),
    () => store?.getIndexFocusState() ?? IDLE_INDEX_FOCUS_STATE,
    () => IDLE_INDEX_FOCUS_STATE,
  );
  const [open, setOpen] = useState(false);

  // 目录由控制器按 (size, evictions, bytes, revision, tailFirstRowId) 缓存；命中时返回
  // 同一引用（不触发子树重渲染）。但流式输出期间索引 size/bytes 每个 delta 都变，
  // 缓存必然未命中 → 每帧重算一次 O(索引规模) 的目录。因此**关闭时根本不求值**：
  // 返回稳定的空目录引用，把这笔开销压到 0（详见 ConversationIndexFocusApi.open 注释）。
  const directory = useMemo(
    () => (open ? (store?.getIndexDirectory() ?? EMPTY_INDEX_DIRECTORY) : EMPTY_INDEX_DIRECTORY),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 目录缓存键由控制器内部裁决
    [open, store, projectionState, fallbackSummary],
  );

  const focusIndexedRow = useCallback(
    (rowId: number) => {
      if (!store) return;
      // 由 store 原子捕获 sessionId + generation + logEpoch + rowId（同一次读取），
      // 会话/workspace 切换或订阅换代后到达的响应应用次数为 0（spec 规则 7 / U07-A3）。
      const target = store.captureIndexFocusTarget(rowId);
      if (!target) return;
      void store.focusIndexedRow(target);
    },
    [store],
  );

  const continueOlder = useCallback(() => {
    if (!store) return;
    void store.continueIndexFocusOlder();
  }, [store]);

  const returnToLive = useCallback(() => {
    store?.returnToLive();
  }, [store]);

  const isFocused = focus.rows.length > 0 || focus.status === "loading";
  // 必须 memo：每次渲染返回新对象会让 memo 化的面板/桥接组件失去意义，
  // 进而在流式输出期间被高频重渲染（AGENTS.md：避免重复状态与无谓重渲染）。
  // store 为 null 时各依赖均为稳定常量/回调，返回引用同样稳定，不需要早退分支
  // （早退会构成条件调用 useMemo 的 hooks 违规）。
  return useMemo(
    () => ({
      directory,
      open,
      setOpen,
      focus,
      focusRows: focus.rows,
      isFocused,
      focusIndexedRow,
      continueOlder,
      returnToLive,
    }),
    [directory, open, focus, focusIndexedRow, continueOlder, returnToLive, isFocused],
  );
}
