// ============================================================
// dwf（dynamic-workflow）工具族清单
// ============================================================
// 从 index.ts 的 builtInTools 抽出（架构 ratchet 单文件 ≤400 行）：族成员、顺序与
// 注释逐字保留，index.ts 以展开方式在原位置消费——注册顺序与 registerBuiltInTools
// 过滤链语义不变（过滤按 entry 名/门判定，与承载文件无关）。
// 族谱：CreateWorkflow 的创作/修订/保存、run 内省与恢复、升级问答、洞填充、
// 定义清单与模型目录（服务 `subagent_model`）。RunWorkflow（脚本工作流）是另一套
// 系统，留在 index.ts。

import type { ToolEntry } from "../types.js";
import { createWorkflowToolEntry } from "./create-workflow.js";
import { amendWorkflowToolEntry } from "./amend-workflow.js";
import { saveWorkflowToolEntry } from "./save-workflow.js";
import { evalWorkflowSnippetToolEntry } from "./eval-workflow-snippet.js";
import { listWorkflowRunsToolEntry } from "./list-workflow-runs.js";
import { getWorkflowRunToolEntry } from "./get-workflow-run.js";
import { resumeWorkflowRunToolEntry } from "./resume-workflow-run.js";
import { resolveWorkflowQuestionToolEntry } from "./resolve-workflow-question.js";
import { fillWorkflowHoleToolEntry } from "./fill-workflow-hole.js";
import { listSavedWorkflowsToolEntry } from "./list-saved-workflows.js";
import { listModelsToolEntry } from "./list-models.js";

export const dwfWorkflowToolEntries: ToolEntry[] = [
  createWorkflowToolEntry,
  amendWorkflowToolEntry,
  // 保存的定义：写侧 gate 与 CreateWorkflow 同档（alwaysAsk），读侧无 gate。
  saveWorkflowToolEntry,
  // workflow 创作的实验通道：同步、只读（v1）、完全瞬态。
  evalWorkflowSnippetToolEntry,
  // run 内省的两个只读工具：always-on、无 gate。它们不进 WORKFLOW_CHILD_DISALLOWED_TOOLS——
  // 那条禁令的理由是 CreateWorkflow 的 alwaysAsk 在子 runtime 里无窗可弹，只读查询不适用。
  listWorkflowRunsToolEntry,
  getWorkflowRunToolEntry,
  // run 的恢复入口：与上面两个只读内省工具同族（run_id 键、端口探测失败同款），但它是
  // 执行语义——alwaysAsk 非 yolo 不可（cancelled 是用户的显式停止决定，复活必须先问），
  // 因此须进 WORKFLOW_CHILD_DISALLOWED_TOOLS（child yolo 无窗可弹）。插在 GetWorkflowRun 之后：run 工具簇 list/get/resume 相邻。
  resumeWorkflowRunToolEntry,
  // 升级问答的主代理侧：与上面三个 run 工具同族——
  // 同一个 dwf run 端口、同款 typeof 探测失败。与它们的不同点在下游：它进 actor 会话的
  // 禁用名单（bootstrap 的 workflowActorToolPolicy），子代理不许替主代理作答。
  resolveWorkflowQuestionToolEntry,
  // 挖洞-填充的主代理侧（specs/workflow-holes.md）：与 ResolveWorkflowQuestion 同族，
  // 同样进 actor 禁用名单（洞欠的是主代理的代码；splice 后要过确认窗，child 无窗可弹）。
  fillWorkflowHoleToolEntry,
  // 定义清单（与上面两个 run 工具是两件事：那是历史，这是可跑的东西）。同为只读、无 gate。
  listSavedWorkflowsToolEntry,
  // 模型目录：同为只读、无 gate 的发现面，服务于 CreateWorkflow / AmendWorkflow 的
  // `subagent_model`。不进 WORKFLOW_CHILD_DISALLOWED_TOOLS
  // ——那条禁令的理由是 alwaysAsk 在 child 里无窗可弹，只读查询不适用。
  listModelsToolEntry,
];
