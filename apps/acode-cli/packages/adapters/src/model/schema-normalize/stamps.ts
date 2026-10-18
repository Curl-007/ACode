// Ported from oh-my-pi (MIT) — packages/ai/src/utils/schema/stamps.ts, Copyright (c) 2025 Mario Zechner & Stencil Labs
// ============================================================
// 遍历守卫与惰性 memoize（WeakMap 侧表）
// ============================================================
// 记账刻意放在宿主对象之外的模块级 WeakMap 侧表，而不是不可枚举 symbol 属性：
// schema 对象归调用方所有，可能在首次遍历后被 seal/freeze/深度冻结——
// 挂在宿主上的槽会被一起冻结，后续写入全部抛错。侧表对 `{...spread}`、
// `Object.keys`、`JSON.stringify` 与深比较也完全不可见。
// 注意：条目与宿主对象同生命周期，只用于"缓存寿命应跟随宿主"的场景。

const memos = new WeakMap<object, Map<symbol, unknown>>();

export function stamp<T extends object, V>(target: T, key: symbol, compute: (target: T) => V): V {
  let slots = memos.get(target);
  if (!slots) {
    slots = new Map();
    memos.set(target, slots);
  }
  const existing = slots.get(key) as V | undefined;
  if (existing !== undefined) return existing;
  const value = compute(target);
  slots.set(key, value);
  return value;
}

// ------------------------------------------------------------
// epoch 键控循环守卫：比每次调用新建 WeakSet 便宜——每个宿主对象只有
// 一条侧表记录，写一次、后续遍历原地覆盖，无每遍历分配。
// 用法：
//   function walk(node, epoch = epochNext()) {
//     if (!once(node, epoch)) return; // 循环
//     for (const child of node.children) walk(child, epoch);
//   }
// ------------------------------------------------------------
const epochs = new WeakMap<object, number>();
let currentEpoch = 0;

export function epochNext(): number {
  currentEpoch += 1;
  return currentEpoch;
}

/**
 * 把 target 标记为当前 epoch 已访问。同一 (target, epoch) 首次调用返回 true，
 * 同 epoch 内后续调用返回 false。
 */
export function once<T extends object>(target: T, epoch: number): boolean {
  const cur = epochs.get(target);
  if (cur !== undefined && cur >= epoch) return false;
  epochs.set(target, epoch);
  return true;
}

// ------------------------------------------------------------
// 计数器式路径跟踪：区分「当前在递归路径上」与「曾经访问过」——
// 即允许 DAG 共享、只对真循环报警的守卫。进入 +1、退出 -1；
// 平衡遍历结束后计数归零，后续顶层调用无需重置即为全新状态。
// ------------------------------------------------------------
const depths = new WeakMap<object, number>();

/**
 * 首次进入返回 true；target 已在当前路径上返回 false。
 * false 分支**不**加深计数——调用方只在 enter 成功时配对 exit
 * （`if (!enter(n)) bail; try {…} finally { exit(n); }`），
 * 在循环分支上递增会泄漏深度，让同一对象的后续顶层遍历误报循环。
 */
export function enter<T extends object>(target: T): boolean {
  const cur = depths.get(target);
  if (cur !== undefined && cur !== 0) return false;
  depths.set(target, 1);
  return true;
}

export function exit<T extends object>(target: T): void {
  const cur = depths.get(target);
  if (cur === undefined) return;
  depths.set(target, cur - 1);
}
