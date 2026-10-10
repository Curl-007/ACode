// 编排方案 Phase 4（specs/subagent-nesting-budget.md R1-R4）：受约束深度嵌套的策略
// 纯函数层——模式严苛度排序、根锚定天花板取值、maxDepth 生效值。零 IO、零状态，
// 装配期与派发路径共用同一份裁决（不许两处各写一份排序）。

import type { CollaborationMode } from "@acode/contracts";
import { TREE_BUDGET_CAPS } from "./tree-budget.js";

/**
 * 树级预算准入闸是否已落地（specs/subagent-nesting-budget.md R4）。
 *
 * 2026-10-10 第二批落地：tree-budget.ts 三闸（总量/积压/token）+ 单点准入
 * （runAgentToCompletion 顶部）+ settle 事件单点释放，连同 §6.1 deny 门继承、
 * §6.2 级联停止、§6.3 双重镜像抑制一起验收后翻开。翻回 false 即恢复 fail-closed
 * 硬封（生效 maxDepth 恒 1）。
 */
export const TREE_BUDGET_ADMISSION_LANDED = true;

/**
 * 模式严苛度序（严 → 宽）：auto（当前语义全拒）< plan（只读）< edit < build < yolo。
 * 「天花板 = 不高于根会话」的比较基准；未知值按最严处理（fail-closed）。
 */
const MODE_SEVERITY: Readonly<Record<CollaborationMode, number>> = {
  auto: 0,
  plan: 1,
  edit: 2,
  build: 3,
  yolo: 4,
};

/** 取两者中更严的模式（R2）。任一侧未知词按最严序位处理；双侧缺席 → "auto"（fail-closed）。 */
export function moreRestrictiveMode(
  a: CollaborationMode | undefined,
  b: CollaborationMode | undefined,
): CollaborationMode {
  if (a === undefined) return b ?? "auto";
  if (b === undefined) return a;
  return (MODE_SEVERITY[a] ?? 0) <= (MODE_SEVERITY[b] ?? 0) ? a : b;
}

/**
 * maxDepth 生效值（R3/R4）：策略值向下取整、下限 1、上限 TREE_BUDGET_CAPS.maxDepth；
 * 预算闸未落地时（TREE_BUDGET_ADMISSION_LANDED=false）硬封 1（fail-closed 回退面）。
 * 语义：maxDepth=N 允许 depth 1..N 的子代理链（N=1 = 原硬深度 1 现状）。
 */
export function resolveEffectiveSubagentMaxDepth(configured: number | undefined): number {
  const want = Math.max(1, Math.floor(configured ?? 1));
  return TREE_BUDGET_ADMISSION_LANDED ? Math.min(want, TREE_BUDGET_CAPS.maxDepth) : 1;
}

/**
 * 子 runtime 的派发使能判定（R3 单点）：child 自己的 depth 严格小于生效 maxDepth
 * 才允许它再派子代理。depth 从 1 起（根会话是 0）；maxDepth=1（缺省）时恒 false，
 * 与原 `enabled: false` 写死逐字节等价。
 */
export function resolveChildSubagentsEnabled(input: {
  childDepth: number;
  configuredMaxDepth: number | undefined;
}): boolean {
  return input.childDepth < resolveEffectiveSubagentMaxDepth(input.configuredMaxDepth);
}
