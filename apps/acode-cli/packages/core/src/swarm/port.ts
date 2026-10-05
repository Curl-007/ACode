// K2 对话内 Swarm 任务图 R5（specs/swarm-task-graph.md）：runtime 级注册端口。
//
// port 形态 = plan-store + runner 的 runtime 级绑定面（spec R5「工具注册门：runtime 级
// swarmPlanPort 在场，与 workflowPort 同款装配模式」）。为什么是这两个成员的最小接口：
// - 五个 plan-* 工具工厂（2a）全部只闭包 store——注册门只需要 store；
// - turn 后调度点（R4）只需要 runner.dispatchReadyNodes；reminder（R7）只需要
//   store.getPlan（快照深拷贝，读者不写穿）。
// 不暴露 executeNode / ownerIdFactory 等内部装配细节：那是 bootstrap 在构造 runner 时
// 绑定的实现面，进了端口就成了第二份可调用面（违反「图只经 ops 变更、执行只经 runner」
// 的单一写者原则，R6）。
//
// 注入式消费方：AgentRuntimeDeps.swarmPlanPort（core runtime 域，2b）与 bootstrap 装配
// （swarm-plan-runtime.ts：store/runner/持久化 seam/取消观测一次装齐再整体交出）。

import type { SwarmPlanStore } from "./plan-store.js";
import type { SwarmRunner } from "./runner.js";

/**
 * swarm plan 的 runtime 级端口。在场即注册 plan 工具族（registerBuiltInTools 的
 * swarmPlanPort 门）；workflow 子会话拿到同一端口也只见只读面（PlanStatus，
 * runtime-tools.ts 按 taskType 推导，R5「防 worker 自改图」）。
 */
export interface SwarmPlanPort {
  runner: SwarmRunner;
  store: SwarmPlanStore;
}
