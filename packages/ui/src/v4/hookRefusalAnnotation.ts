// Hook 拒绝/失败注记的渲染支撑（apps/acode-cli/specs/plugin-hook-middleware.md 二 W2-ui）。
// refusalAnnotation 是运行时 hook-refusal-visibility 的 payload 增补字段（闭集原因
// 格式化行「<hook 名>: <事件> 被拒: <原因>; 已用引擎默认行为」）：wire 投影 schema 的
// 增补（shared rows.ts）与投影透传（bootstrap product-projection）属其他接线面，本叶子
// 只做防御式读取——字段缺席（旧投影/未增补 wire）时零渲染、门控回退旧判定，零破坏。
import type { HookExecutionProjection, HookInvocationRow } from "@acode/shared/acode-protocol-v4";

/** 防御式读取注记：只认非空字符串，其余一律视为缺席（不信任 wire 上的任意值）。 */
export function readHookRefusalAnnotation(execution: HookExecutionProjection): string | undefined {
  const value = (execution as { refusalAnnotation?: unknown }).refusalAnnotation;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Hook 明细入口是否可达：有已执行环节，或有携带拒绝注记的环节——admission/trust
 * 拒绝（didExecute=false）也必须可观测（「每个被拒执行都留下带闭集原因的可观测行」，
 * plugin-hook-middleware.md 二）。旧投影（无注记字段）下与旧判定
 * `some(execution => execution.didExecute)` 逐点等价。
 */
export function hasVisibleHookExecutions(rows: readonly HookInvocationRow[]): boolean {
  return rows.some((row) =>
    row.executions.some(
      (execution) => execution.didExecute || readHookRefusalAnnotation(execution) !== undefined,
    ),
  );
}
