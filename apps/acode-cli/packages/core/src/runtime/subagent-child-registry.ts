import type { AgentRuntimeInternal } from "./internal.js";

// 活 child runtime 注册表（specs/subagent-parent-inheritance.md「完全访问事后传播」R7）。
//
// 父 runtime 是注册条目的唯一所有者：spawn 路径在 child runtime 构造完成后登记
// （methods/subagent.ts），child turn 结算的 finally 注销——覆盖构造后所有退出路径
// （resume 失败、持久化闸失败、turn 完成/取消/异常）。
//
// 为什么用 WeakMap：注册表不为 child（也不为父）延寿。条目随父 runtime 被 GC 而消失；
// Set 持有的 child 引用也随父条目一并回收，注销漏调不会让已废弃 child 永久驻留。
// 广播方（execution-state.ts 的 propagateBypassModeToLiveChildren）只读快照迭代。
const liveChildRuntimesByParent = new WeakMap<
  AgentRuntimeInternal,
  Set<AgentRuntimeInternal>
>();

/** spawn 登记：child runtime 构造完成后由父 runtime 调用。幂等（Set 去重）。 */
export function registerLiveChildRuntime(
  parent: AgentRuntimeInternal,
  child: AgentRuntimeInternal,
): void {
  let children = liveChildRuntimesByParent.get(parent);
  if (!children) {
    children = new Set();
    liveChildRuntimesByParent.set(parent, children);
  }
  children.add(child);
}

/** child turn 结算注销：父 runtime 在 turn finally 调用。幂等，空注册表为 no-op。 */
export function unregisterLiveChildRuntime(
  parent: AgentRuntimeInternal,
  child: AgentRuntimeInternal,
): void {
  const children = liveChildRuntimesByParent.get(parent);
  if (!children?.delete(child)) return;
  if (children.size === 0) liveChildRuntimesByParent.delete(parent);
}

/** 广播方读取：返回快照数组，迭代期间登记/注销不影响本次遍历。 */
export function liveChildRuntimes(parent: AgentRuntimeInternal): AgentRuntimeInternal[] {
  return [...(liveChildRuntimesByParent.get(parent) ?? [])];
}
