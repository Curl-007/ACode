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
 * 模式严苛度序（严 → 宽）：auto（当前语义全拒）< dontAsk（无人可问即拒）<
 * plan（只读）< edit < build < yolo。
 * 「天花板 = 不高于根会话」的比较基准；未知值按最严处理（fail-closed）。
 *
 * dontAsk 排位裁决（specs/permission-adjudication-batch2.md 接线项 3，接线波落定，
 * 理由同步记录在 specs/subagent-nesting-budget.md 修订记录）：
 * - 严于 plan（序位更低）：plan 的结构拒写仍保留 ask 面（alwaysAsk 工具会弹卡），
 *   无人值守根会话下会挂起等不到人；dontAsk 把一切 ask 终局化为 deny，永不挂起，
 *   作为天花板能保证整棵子树继承「无人可问」姿态（cron/off-peak/-p 的一致安全默认）。
 * - 宽于 auto：auto 是全拒/分类器灰区语义，仍是最严档；dontAsk 的 allow 白名单
 *   （规则+policy floor 双重压制下的放行）照常生效，白名单由规则而非档位决定。
 */
const MODE_SEVERITY: Readonly<Record<CollaborationMode, number>> = {
  auto: 0,
  dontAsk: 1,
  plan: 2,
  edit: 3,
  build: 4,
  yolo: 5,
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
