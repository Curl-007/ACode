// ============================================================
// CreateWorkflow Tool - typecheck a dynamic-workflow script and start a background run
// ============================================================
//
// 例外偿还（contracts-onboarding-max-file-lines-create-workflow）：本文件原为 510 行单体，
// 已拆为 2 个叶子并降级为 barrel——入参契约在 create-workflow-input（来源 XOR、归一化输入、
// 诊断形态），因果图与输出在 create-workflow-graph（三层有界投影 + 输出 schema）；公开导出面
// 逐名不变，消费方零改动。依赖单向：create-workflow-graph → create-workflow-input，
// 本文件只 re-export，无叶子回边。
// 工具名与技能名常量留在本 barrel：core 的门与 bootstrap 的技能包都读它们。

export const CREATE_WORKFLOW_TOOL_NAME = "CreateWorkflow";

/**
 * 教模型写工作流的内置技能名（apps/acode-cli/packages/bundled-skills/skills/<name>/SKILL.md）。
 * 四个创作工具（Create/Amend/Save/EvalWorkflowSnippet）的 resolveInput 以它为门：会话里没有
 * 加载过这份技能就拒绝提交脚本。
 * 住在 contracts 里是因为 core 的门与 bootstrap 的技能包都读它，而两者不能互相 import。
 */
export const DYNAMIC_WORKFLOW_SKILL_NAME = "dynamic-workflows";

// —— 叶子 re-export（`export *` 要求跨叶无重名：input 叶与 graph 叶符号不相交）——
export * from "./create-workflow-input.js";
export * from "./create-workflow-graph.js";
