// Hook 链走查共享状态的类型叶子（runner-chain.ts / runner-link.ts 共用；
// 独立成叶避免两个拆分件之间的类型环）。
import type { HookRunOptions } from "./types.js";

/**
 * 一次 run() 的链走查共享状态：hookInvocationId 与 clientVisible 计数在链内
 * （含 middleware next 的递归段）全程共享，保证生命周期事件的 hookIndex/hookCount
 * 语义与顺序链一致。
 */
export interface HookChainWalkState {
  clientVisibleHookCount: number;
  clientVisibleHookIndex: { value: number };
  hookInvocationId: string;
  options: HookRunOptions;
}
