// ============================================================
// 工作流工具的灰度门控名单
// ============================================================
// 从 handlers/index.ts 抽出，理由不只是整洁：那个文件已经顶在 architecture-policy.yaml 的
// maxFileLines: 400 上，而它是「只减不增」ratchet 的存量文件——每加一行都是逆行。
// 名单搬出来后 index.ts 只 import，行数下降。
//
// 这里放**两个**集合而不是一个，因为它们回答的是两个不同的问题：
//   DYNAMIC_WORKFLOW_TOOL_NAMES = 「dwf 是哪十一个工具」（语义与 S1 之前完全一致，
//     多处注释与文档按这个含义引用它，改名或扩容都会让那些引用说谎）；
//   GATED_WORKFLOW_TOOL_NAMES   = 「灰度关时该下架哪些工具」（dwf 十一个 + 脚本工作流一个）。
// 后者是前者加上 RunWorkflow，用展开而不是手抄第二份名单来保证不会漂移。

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  RUN_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
} from "@acode/contracts";

/**
 * 动态工作流（dwf）灰度门关闭时不注册的十一个工具。
 * 灰度关的语义是「没有任何办法开始一条工作流」，所以创建、修订、保存、快照实验与四个
 * run 面工具一起下架；只读的 run 内省工具也在列，因为关闭态下它们只会指向用户无法再操作的历史。
 * `ListModels` 也在列：它唯一的用途是给一次 run 挑 `subagent_model`，没有 CreateWorkflow 可填时
 * 留着它只会把模型引向不存在的工具。
 * 脚本工作流的 `RunWorkflow` **不在**这份名单里（它是另一套系统），但在下面的门控集合里。
 */
export const DYNAMIC_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  SAVE_WORKFLOW_TOOL_NAME,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  LIST_MODELS_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  GET_WORKFLOW_RUN_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
]);

/**
 * 受 `includeDynamicWorkflow`（dwf 总闸）门控的工具名集合：dwf 十一个 + 脚本工作流一个。
 *
 * 语义分工（spec script-workflow-management-surface.md §3.2，评审必改项 2 后的表述）：
 * **dwf 工具面仍由 includeDynamicWorkflow 单门管**；`RunWorkflow` 额外与
 * `scriptWorkflowEnabled` **合取**（`core/src/tool/handlers/index.ts` 的独立支：
 * 任一门显式 false 即不注册）。保留合取而不是把 RunWorkflow 拆出本集合的理由：
 * 用户在 dwf 总闸上关掉「动态工作流」时，对「脚本工作流也没了」的预期成立——
 * 桌面端的 UI 入口（Automations 的「工作流」tab）、命令目录与工具面由同一次 Host 判定
 * 驱动，dwf 总闸关闭时工作流 tab 整体不挂载，RunWorkflow 若还注册就是「模型有工具 /
 * 界面无入口」的裂口。反方向（dwf 开、script 关）由 includeScriptWorkflow 独立支覆盖，
 * 两道门一开一关的每个组合都有明确结论。
 *
 * 极性由调用方保证（**只有显式 false 才下架**，缺席即保留），不在这里判定：
 * 缺席代表调用方不参与灰度（TUI、headless、workflow_child），它们必须保留全部工具面。
 * 极性搞反的后果记录在 runtime/methods/embedded-search-branch.ts 的注释里。
 */
export const GATED_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...DYNAMIC_WORKFLOW_TOOL_NAMES,
  RUN_WORKFLOW_TOOL_NAME,
]);

/**
 * registerBuiltInTools 过滤链里两道工作流门的合取谓词（spec
 * script-workflow-management-surface.md §4.5）：dwf 总闸（includeDynamicWorkflow）显式
 * false 时下架 GATED_WORKFLOW_TOOL_NAMES（dwf 十一个 + RunWorkflow，现状语义不变）；
 * 脚本工作流门（includeScriptWorkflow）显式 false 时**只**下架 RunWorkflow——补
 * 「dwf 开、script 关」的另一半。两门独立、合取生效：任一显式 false 即不注册 RunWorkflow。
 *
 * 谓词收在本文件而不是 handlers/index.ts：那个文件顶在 maxFileLines: 400 的「只减不增」
 * ratchet 上，每加一行都是逆行；且两个注册入口（runtime-tools.ts 首次装配、
 * embedded-search-branch.ts 分支刷新）共用这一个谓词，与 tool-allowlist.ts 的推导同一份
 * 语义，不会漂移。
 */
export function shouldSkipWorkflowToolEntry(
  toolName: string,
  gates: { includeDynamicWorkflow?: boolean; includeScriptWorkflow?: boolean },
): boolean {
  if (gates.includeDynamicWorkflow === false && GATED_WORKFLOW_TOOL_NAMES.has(toolName)) {
    return true;
  }
  return toolName === RUN_WORKFLOW_TOOL_NAME && gates.includeScriptWorkflow === false;
}
