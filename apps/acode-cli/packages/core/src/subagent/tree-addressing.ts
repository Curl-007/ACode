// 编排方案 Phase 5 P2（specs/agent-peer-tree-addressing.md）：整树寻址表——同树跨层
// peer 投递的 live 索引。与 tree-budget.ts 同款姿态与纪律（script-workflow-runtime
// 三个真实 bug 的教训）：
// - 键 = **树根**（rootSessionId）而不是 runtime 实例——每层子代理各有一份
//   registry，按实例建键的表在 depth≥2 各查各的，跨层寻址失效；
// - 单一登记/注销点：runner 准入原语（前台/后台/resume 三路全经）登记，settle 事件
//   唯一出口注销；非结算路径不清零（「地址被悄悄撤掉」是 bug 模式）；
// - 进程内存态 + 测试 reset；不用 WeakRef——确定性注销（settle + 级联停止）比
//   GC 非确定的「有时可寻址有时不可」语义更优（spec 取舍 #4）。
//
// 窄面纪律：entry 携带 registry 只用于取任务快照与投递（sink/queue），不透传
// stop/cancel——peer 面的侵蚀边界与 P0 一致（定向发消息，仅此一条能力）。

import type { SessionId } from "@acode/contracts";
import type { RuntimeTaskRegistry } from "../runtime-task/contract.js";

export interface TreeAddressEntry {
  agentId: string;
  childSessionId: SessionId;
  /** 持有该 agent 任务的 registry（= 其直接父 runtime 的任务面），投递经它走既有单点。 */
  registry: RuntimeTaskRegistry;
}

const treeAddresses = new Map<string, Map<string, TreeAddressEntry>>();

/** 派发准入点登记（resume 重臂 = 覆盖写，自动刷新）。 */
export function registerTreeAddress(input: { entry: TreeAddressEntry; rootKey: string }): void {
  let byAgentId = treeAddresses.get(input.rootKey);
  if (byAgentId === undefined) {
    byAgentId = new Map();
    treeAddresses.set(input.rootKey, byAgentId);
  }
  byAgentId.set(input.entry.agentId, input.entry);
}

/** 结算注销（单点 = emitSubagentEvent settle 分支；幂等，未知根 no-op）。 */
export function unregisterTreeAddress(input: { agentId: string; rootKey: string }): void {
  treeAddresses.get(input.rootKey)?.delete(input.agentId);
}

/** 同树查询：跨树 agentId 结构性 miss（域闸，spec R1）。 */
export function lookupTreeAddress(input: {
  agentId: string;
  rootKey: string;
}): TreeAddressEntry | undefined {
  return treeAddresses.get(input.rootKey)?.get(input.agentId);
}

/** 测试重置（tree-budget/process-policy-floor 同款「进程单例 + 测试重置」模式）。 */
export function resetTreeAddressingForTest(): void {
  treeAddresses.clear();
}
