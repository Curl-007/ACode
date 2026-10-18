// 懒加载观测面（specs/websearch-multi-engine.md §2）：引擎模块在顶层调用
// markEngineModuleLoaded 注册自己，测试据此断言「导入注册表不加载任何引擎模块，
// 首次 getSearchProvider 才加载对应模块」。纯测试缝，无行为作用。
const loadedEngineModules = new Set<string>();

export function markEngineModuleLoaded(id: string): void {
  loadedEngineModules.add(id);
}

/** 已加载引擎模块 id 的快照（仅测试观测用）。 */
export function getLoadedEngineIdsForTest(): string[] {
  return [...loadedEngineModules];
}

/** 重置观测集（仅测试用）。 */
export function resetLoadedEnginesForTest(): void {
  loadedEngineModules.clear();
}
