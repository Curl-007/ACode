/**
 * 页内查找二期：scope provider 契约与注册表（specs: packages/desktop/specs/find-in-page.md R8-R11）。
 *
 * 宿主组件（虚拟化长列表等）经 registerFindInPageProvider 把「应用级可搜作用域」接入
 * provider 双路：协调器（findInPageCoordinator.ts）按 scope 元素文档位置把各 provider
 * 腿与内置 DOM 腿归并成单一命中序列。注册表非空 = provider 路激活（经桥申报 main）。
 *
 * 生产接线：ConversationTimeline（packages/ui/src/v4/conversationFindInPageProvider.ts，
 * spec R15）；其余宿主组件可经同一注册 API 接入。机制与语义由单测锁定。
 * 模块级注册表不进 store——查找是高瞬态 UI 态，唯一所有者是协调器 + main 会话。
 */

/**
 * 应用级搜索作用域 provider。所有同步方法都可能被协调器 safe-call 包裹：
 * 抛错按 0 命中/无操作收口（spec R14），provider 实现不必自我防御到 coordinator 层。
 */
export interface FindInPageScopeProvider {
  /** 作用域子树根元素；null/失联（isConnected=false）= 本腿排尾，不参与文档序插入。 */
  getScopeEl(): Element | null;
  /** 当前查询在本作用域的命中数（只数已物化进 DOM 的内容，不作假命中）。 */
  count(text: string): number;
  /**
   * 绘制本作用域高亮。activeIndexInScope = 归并后落在本腿的活动命中序号（0-based），
   * -1 = 只绘全部命中不绘 active。epoch 为协调器本地 epoch，异步实现须自守卫。
   */
  show(text: string, activeIndexInScope: number, epoch: number): void;
  /** 清除本作用域全部高亮（clear 广播 / 注销时调用）。 */
  clear(): void;
  /** 本腿第 indexInScope 个命中是否位于已渲染窗口（虚拟化感知；缺省视为 true）。 */
  isMatchRendered?(text: string, indexInScope: number): boolean;
  /**
   * 请求宿主列表把剩余项物化进 DOM（蓝本 loadRest 语义）。协调器仅在本轮 total=0
   * 时触发，等待全部 loadRest（每个 4s 封顶）后 grow 重搜一次。缺席 = 无加载能力，
   * 未渲染区按「不可搜」收口（hasUnsearchableRegions）。
   */
  loadRest?(): Promise<void> | void;
  /** 作用域内是否仍有未物化内容（配合 loadRest 缺席 → hasUnsearchableRegions=true）。 */
  hasUnrenderedContent?(): boolean;
  /** 观测维度标签（蓝本 surface；缺省 "dom"）。 */
  surface?: string;
}

const providers: FindInPageScopeProvider[] = [];
const listeners = new Set<() => void>();

/**
 * 注册 scope provider，返回注销器。注册/注销都会通知订阅者（桥同步 main 的
 * providerActive 申报；协调器在查询激活时重跑归并）。
 */
export function registerFindInPageProvider(provider: FindInPageScopeProvider): () => void {
  providers.push(provider);
  notifyRegistryChanged();
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    const index = providers.indexOf(provider);
    if (index >= 0) {
      providers.splice(index, 1);
    }
    notifyRegistryChanged();
  };
}

/** 注册表快照（只读视图；协调器每轮搜索取一次，避免中途变动撕裂归并）。 */
export function getFindInPageProviders(): readonly FindInPageScopeProvider[] {
  return providers;
}

/** 订阅注册表变动（注册/注销），返回退订器。 */
export function subscribeFindInPageProviderRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notifyRegistryChanged(): void {
  // 快照遍历：监听者可能在通知中退订/再注册（Set 变动），快照保证本轮通知不漏不重。
  const snapshot = Array.from(listeners);
  for (const listener of snapshot) {
    try {
      listener();
    } catch {
      // 订阅者抛错不得阻断注册/注销（fail-soft 纪律，spec R14）。
    }
  }
}
