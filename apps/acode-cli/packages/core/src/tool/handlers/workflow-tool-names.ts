// ============================================================
// 工作流工具的灰度门控名单
// ============================================================
// 从 handlers/index.ts 抽出，理由不只是整洁：那个文件已经顶在 architecture-policy.yaml 的
// maxFileLines: 400 上，而它是「只减不增」ratchet 的存量文件——每加一行都是逆行。
// 名单搬出来后 index.ts 只 import，行数下降。
//
// 这里放**两个**集合而不是一个，因为它们回答的是两个不同的问题：
//   DYNAMIC_WORKFLOW_TOOL_NAMES = 「dwf 是哪十个工具」（语义与 S1 之前完全一致，
//     多处注释与文档按这个含义引用它，改名或扩容都会让那些引用说谎）；
//   GATED_WORKFLOW_TOOL_NAMES   = 「灰度关时该下架哪些工具」（dwf 十个 + 脚本工作流一个）。
// 后者是前者加上 RunWorkflow，用展开而不是手抄第二份名单来保证不会漂移。

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
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
 * 动态工作流（dwf）灰度门关闭时不注册的十个工具。
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
]);

/**
 * 受 `includeDynamicWorkflow` 门控的全部工具名：dwf 十个 + 脚本工作流一个。
 *
 * 为什么两套共用同一道开关而不是各设一道：该选项的语义是「这个客户端有没有动态工作流能力」，
 * 不是「有没有 dwf 那十个工具」。桌面端的 UI 入口（Automations 的「工作流」tab）、命令目录
 * 与工具面都由同一次 Host 判定驱动；两套系统一开一关会让「界面有入口 / 模型没工具」
 * 或反过来的裂口重新出现，而那正是 acodeAgentService 的 resolveDynamicWorkflowGate
 * 用「一次判定同源分发」刻意消掉的东西。
 *
 * 极性由调用方保证（**只有显式 false 才下架**，缺席即保留），不在这里判定：
 * 缺席代表调用方不参与灰度（TUI、headless、workflow_child），它们必须保留全部工具面。
 * 极性搞反的后果记录在 runtime/methods/embedded-search-branch.ts 的注释里。
 */
export const GATED_WORKFLOW_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...DYNAMIC_WORKFLOW_TOOL_NAMES,
  RUN_WORKFLOW_TOOL_NAME,
]);
