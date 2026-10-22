/**
 * 有界 LRU 缓存（compiler 编译缓存专用）。
 *
 * 根因（review 测试专项 P3「compiler 缓存无界」）：compiler.ts 原来用三个裸 `new Map()`
 * 做模块级编译缓存，键是「源码字符串 + 变量名」，永不淘汰。键空间由外部可控的 map 源码
 * 组成，进程长生命周期下只增不减 → 无界内存增长。本模块提供固定上限的 LRU：
 * 基于 Map 的插入序，`get` 命中时 delete+set 把键移到「最近使用」尾端，`set` 溢出时淘汰
 * `keys()` 首个（最久未用）键。
 *
 * 语义不变性：淘汰只影响命中率，不影响结果——compiler 对同一 (source, variableName) 是纯函数，
 * 未命中时重新 parse/compile 得到逐字节一致的产物。因此 LRU 淘汰是安全的性能兜底，
 * 不是行为分支。
 */
export interface BoundedCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  readonly size: number;
  clear(): void;
}

export function createBoundedCache<V>(maxEntries: number): BoundedCache<V> {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new Error(`bounded cache maxEntries must be a positive integer, got ${maxEntries}`);
  }
  const store = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      if (!store.has(key)) return undefined;
      // 命中即刷新为新近使用：删除后重插到 Map 尾部，维持 LRU 序。
      const value = store.get(key) as V;
      store.delete(key);
      store.set(key, value);
      return value;
    },
    set(key: string, value: V): void {
      if (store.has(key)) store.delete(key);
      store.set(key, value);
      while (store.size > maxEntries) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
      }
    },
    get size(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
  };
}
