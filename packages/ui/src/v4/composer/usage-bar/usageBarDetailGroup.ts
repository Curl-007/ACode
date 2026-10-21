/**
 * 明细浮层互斥组的纯状态机（apps/acode-cli/specs/usage-statusbar-port.md §2.2）。
 *
 * 互斥规则是实机反馈的真 bug（钉住「子智能体」后再悬停「今日合计」，两个浮层同屏
 * 互相遮挡）。把规则做成纯函数就能钉住「谁最后展开谁生效」「收起只清自己」
 * 「展开 = 自己是当前者且本地开着或被钉住」。状态所有者是状态栏（唯一持有者）。
 */

export interface UsageBarDetailGroup {
  /** 当前展开的明细 id；null = 没有展开的。 */
  activeId: string | null;
  /** 声明「现在由我展开」：组内其他实例随即收起（含它们的钉住状态）。 */
  activate(id: string): void;
  /** 声明「我收起了」：仅当自己是当前展开者时才清空，避免误关别人的展开。 */
  deactivate(id: string): void;
}

type UsageBarDetailGroupState = { activeId: string | null };

export const EMPTY_DETAIL_GROUP_STATE: UsageBarDetailGroupState = { activeId: null };

/** 展开某条明细：无条件接管（上一个是谁都会被顶掉）。 */
export function activateDetail(
  state: UsageBarDetailGroupState,
  id: string,
): UsageBarDetailGroupState {
  return state.activeId === id ? state : { activeId: id };
}

/** 收起某条明细：只有当前展开者能清空，别人的收起动作不影响它。 */
export function deactivateDetail(
  state: UsageBarDetailGroupState,
  id: string,
): UsageBarDetailGroupState {
  return state.activeId === id ? EMPTY_DETAIL_GROUP_STATE : state;
}

/**
 * 某条明细当前是否可见：必须同时满足「它是组里当前展开的那条」与「本地开着或被钉住」。
 * 组外的实例（没有 id / 没有组）恒按本地状态判断，由调用方决定是否走这里。
 */
export function isDetailVisible(
  state: UsageBarDetailGroupState,
  id: string,
  local: { open: boolean; pinned: boolean },
): boolean {
  return state.activeId === id && (local.open || local.pinned);
}
