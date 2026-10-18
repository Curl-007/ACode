// ============================================================
// 脚本工作流（RunWorkflow / /ultracode）三档本机产品开关
// ============================================================
// 与 dynamic-workflow-feature.ts 并列但刻意**不**同构完整链：脚本工作流是本机产品开关
// 而非发布灰度——没有远端下发 key、没有环境变量覆盖、没有三段折叠
// （apps/acode-cli/specs/script-workflow-management-surface.md §3.2）。消费折叠只在
// services 侧的 resolveScriptWorkflowModeWithLocalOverride 一处（读 AppSettings，
// 缺省/非法落 DEFAULT_SCRIPT_WORKFLOW_MODE）。
//
// 也不与 dynamic-workflow-feature.ts 共用文件：两套系统的取值域各自独立演进，
// 共享一个文件会让人误以为词表必须同步变化（spec §3.1）。

export const SCRIPT_WORKFLOW_MODES = ["disabled", "onDemand", "alwaysOn"] as const;
export type ScriptWorkflowMode = (typeof SCRIPT_WORKFLOW_MODES)[number];

/**
 * 缺省 = onDemand：与既有可用性逐字一致（RunWorkflow 当前跟随 dwf 灰度门，
 * GATED_WORKFLOW_TOOL_NAMES 现含 RunWorkflow，缺省降档会造成行为回归），并与工具描述的
 * 「用户显式选择才可调用」门槛天然对齐——onDemand 就是「显式选择才触发」的档位
 * （spec §3.1）。
 */
export const DEFAULT_SCRIPT_WORKFLOW_MODE: ScriptWorkflowMode = "onDemand";

/** 非法/形状错误的输入归一化为 undefined，由调用方决定落缺省档（与 normalizeDynamicWorkflowMode 同构）。 */
export function normalizeScriptWorkflowMode(value: unknown): ScriptWorkflowMode | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (SCRIPT_WORKFLOW_MODES as readonly string[]).includes(trimmed)
    ? (trimmed as ScriptWorkflowMode)
    : undefined;
}

/**
 * 解析保留三态取值域，消费侧统一转换为布尔开关（与 isDynamicWorkflowModeEnabled 逐字
 * 同构，dynamic-workflow-feature.ts:47-53 的既有裁决）；将来 onDemand 有独立行为时，
 * 只需调整消费侧。
 */
export function isScriptWorkflowModeEnabled(mode: ScriptWorkflowMode): boolean {
  return mode !== "disabled";
}
