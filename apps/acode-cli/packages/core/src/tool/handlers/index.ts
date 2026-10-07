// ============================================================
// Built-in Tool Handlers
// ============================================================

import {
  RUN_WORKFLOW_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  type JsonSchema,
} from "@acode/contracts";
import type { ToolEntry } from "../types.js";
import type { AgentProfile } from "../../subagent/profile.js";
import { readToolEntry } from "./read.js";
import { writeToolEntry } from "./write.js";
import { editToolEntry } from "./edit.js";
import { applyPatchToolEntry } from "./apply-patch.js";
import { bashToolEntry, createBashToolEntry } from "./bash.js";
import type { BashTimeoutPolicy } from "../bash-timeout-policy.js";
import { createJsToolEntry, jsToolEntry } from "./node-repl.js";
import { globToolEntry } from "./glob.js";
import { grepToolEntry } from "./grep.js";
import { webFetchToolEntry } from "./webfetch.js";
import { webSearchToolEntry } from "./websearch.js";
import {
  agentToolEntry,
  createAgentToolEntry,
  createTaskToolEntry,
  taskToolEntry,
} from "./agent.js";
import { isSubagentDispatchToolName } from "../compat.js";
import { skillToolEntry } from "./skill.js";
import { todoReadToolEntry, todoWriteToolEntry } from "./todo.js";
import {
  cronCreateToolEntry,
  cronDeleteToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
} from "./cron.js";
import { offPeakCreateToolEntry, offPeakListToolEntry } from "./off-peak.js";
import {
  createEnterPlanModeToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
} from "./plan-mode.js";
import { askUserQuestionToolEntry } from "./ask-user-question.js";
import { sendMessageToolEntry } from "./send-message.js";
import { respondToCoordinatorToolEntry } from "./respond-to-coordinator.js";
import { createSubmitResultToolEntry, submitResultToolEntry } from "./submit-result.js";
import { escalateToolEntry } from "./escalate.js";
import { resolveWorkflowQuestionToolEntry } from "./resolve-workflow-question.js";
import { taskOutputToolEntry } from "./task-output.js";
import { taskStopToolEntry } from "./task-stop.js";
import { readSessionContextToolEntry } from "./read-session-context.js";
import { amendWorkflowToolEntry } from "./amend-workflow.js";
import { createWorkflowToolEntry } from "./create-workflow.js";
import { saveWorkflowToolEntry } from "./save-workflow.js";
import { listSavedWorkflowsToolEntry } from "./list-saved-workflows.js";
import { listModelsToolEntry } from "./list-models.js";
import { evalWorkflowSnippetToolEntry } from "./eval-workflow-snippet.js";
import { listWorkflowRunsToolEntry } from "./list-workflow-runs.js";
import { getWorkflowRunToolEntry } from "./get-workflow-run.js";
import { resumeWorkflowRunToolEntry } from "./resume-workflow-run.js";
// 脚本工作流（纯 JS DSL）的入口，与上面 dwf 那十个是两套独立系统；
// 灰度门控名单抽到 workflow-tool-names.ts，理由见那个文件的头注释。
import { runWorkflowToolEntry } from "./run-workflow.js";
import { GATED_WORKFLOW_TOOL_NAMES } from "./workflow-tool-names.js";
import { sessionSearchToolEntry } from "./session-search.js";
import { createOpenToolEntry, type OpenPlatformPort } from "./open.js";
import { createPlanCompleteGateToolEntry } from "./plan-complete-gate.js";
import { createPlanControlToolEntry } from "./plan-control.js";
import { createPlanExpandToolEntry } from "./plan-expand.js";
import { createPlanSeedToolEntry } from "./plan-seed.js";
import { createPlanStatusToolEntry } from "./plan-status.js";
import type { SwarmPlanPort } from "../../swarm/port.js";
import type { AmbientScheduleQueue, ScheduledItem } from "../../ambient/queue.js";
import { createScheduleToolEntry } from "./schedule.js";
import { createToolRuleNameSet } from "../tool-visibility.js";

// direct 分支保留 Glob/Grep 工具实现；embedded search 分支由 registerBuiltInTools
// 统一隐藏 Glob/Grep，并通过 Bash find/grep 接管搜索。

export const builtInTools: ToolEntry[] = [
  readToolEntry,
  writeToolEntry,
  editToolEntry,
  // S2（批次 4）：悬空 contract 落地为真实 handler——上游注释占位在此激活，
  // 规格与两段式执行语义见 specs/apply-patch-tool.md。
  applyPatchToolEntry,
  bashToolEntry,
  globToolEntry,
  grepToolEntry,
  webFetchToolEntry,
  webSearchToolEntry,
  todoReadToolEntry,
  todoWriteToolEntry,
  cronCreateToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
  cronDeleteToolEntry,
  offPeakCreateToolEntry,
  offPeakListToolEntry,
  enterPlanModeToolEntry,
  exitPlanModeToolEntry,
  askUserQuestionToolEntry,
  sendMessageToolEntry,
  respondToCoordinatorToolEntry,
  submitResultToolEntry,
  // actor 的升级通道。与 submit_result 完全同构：
  // 端口在场即注册（includeEscalate），`tools:"none"` 下由 workflow_child 的 allowlist
  // 补回逻辑救回来。不入 actor 的默认 disallow——最可能撞上未预见之墙的 actor 恰是
  // 作者没标记的那一个。
  escalateToolEntry,
  taskOutputToolEntry,
  taskStopToolEntry,
  readSessionContextToolEntry,
  // 跨会话全文搜索（K4）：本地只读、无 gate，与 ReadSessionContext 同级——
  // 都消费 sessionStore 面且不产生副作用，handler 运行时经 context 取存储能力。
  sessionSearchToolEntry,
  agentToolEntry,
  taskToolEntry,
  skillToolEntry,
  jsToolEntry,
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
  // 定义清单（与上面两个 run 工具是两件事：那是历史，这是可跑的东西）。同为只读、无 gate。
  listSavedWorkflowsToolEntry,
  // 模型目录：同为只读、无 gate 的发现面，服务于 CreateWorkflow / AmendWorkflow 的
  // `subagent_model`。不进 WORKFLOW_CHILD_DISALLOWED_TOOLS
  // ——那条禁令的理由是 alwaysAsk 在 child 里无窗可弹，只读查询不适用。
  listModelsToolEntry,
  // 脚本工作流（RunWorkflow）排在 dwf 那十个之后：两套系统相邻便于对照，但它是**另一套**——
  // 纯 JS、以 `export const meta` 开头、无类型检查、runId 前缀 wf_ 而非 dwfrun_、
  // 落 workflow_activity 表而非 dwf_* 表。注册门也不同：它要 `includeWorkflow`（端口在场）
  // 与 `includeDynamicWorkflow`（灰度）两道门同时放行，见下面过滤链的两支。
  runWorkflowToolEntry,
];

interface RegisterBuiltInToolsOptions {
  bashTimeoutPolicy?: BashTimeoutPolicy;
  includeSkill?: boolean;
  includeAgent?: boolean;
  includeSendMessage?: boolean;
  includeRespondToCoordinator?: boolean;
  includeSubmitResult?: boolean;
  /**
   * 在场时 submit_result 以 typed 声明注册（`{ result: <schema> }`，strict 资格），供 dwf mono
   * 子代理；缺席即通用声明。只在 includeSubmitResult 为真时有意义。
   */
  submitResultSchema?: JsonSchema;
  /** actor 的升级通道；门与 includeSubmitResult 同款（注入了 WorkflowEscalatePort 才注册）。 */
  includeEscalate?: boolean;
  /**
   * 脚本工作流（RunWorkflow）的**端口门**：注入了 `WorkflowPort` 才注册。极性是「只有显式
   * true 才注册」，与 includeOffPeak / includeAutomation 同族，所以 embedded-search-branch.ts
   * 那个精简入口省略它是安全的（省略 = 不注册，与首次装配同结论）。
   * 这个选项曾长期是死代码（它匹配的 `"Workflow"` 条目早已移出 builtInTools）；RunWorkflow
   * 落地后重新生效，判据仍是 `Boolean(deps.workflowPort)`。与 includeDynamicWorkflow 是
   * **两道独立的门**（能力 vs 可用性），都放行才注册。
   */
  includeWorkflow?: boolean;
  includeAutomation?: boolean;
  /** Off-Peak 会话内创建工具面；由 host 的 offPeakToolEnabled flag（灰度/远程门）驱动。 */
  includeOffPeak?: boolean;
  /** 开箱（Open 工具）平台端口；在场即注册，缺席不注册（K9 R2 的 port 门控）。 */
  platformOpenPort?: OpenPlatformPort;
  /**
   * K2 swarm plan 工具族的注册门（specs/swarm-task-graph.md R5）：端口在场即注册
   * PlanSeed/PlanExpand/PlanCompleteGate/PlanStatus/PlanControl（工具工厂闭包 store，
   * plan-shared.ts 头注释的 2b 接线位）。只读推导在调用方（runtime-tools.ts 按
   * taskType，includeAutomation 同款先例），本层不做 runtime 配置推断。
   */
  swarmPlanPort?: SwarmPlanPort;
  /** 在场为 true 时只注册 PlanStatus（workflow 子会话的只读面，R5「防 worker 自改图」）。 */
  swarmPlanReadOnly?: boolean;
  /**
   * K6 ambient Schedule 工具的注册门（specs/ambient-budget-scheduler.md R2/场景 10）：
   * flag 推导在调用方（runtime-tools.ts 按 config.ambient.enabled && 非封闭子会话
   * ——subagent_child/workflow_child/nested_workflow_child，F10 批次C 收紧），
   * includeAutomation 同款先例，本层不做 runtime 配置推断——与 swarmPlanPort 的
   * 门分工一致。
   */
  includeAmbientSchedule?: boolean;
  /**
   * K6：Schedule 工具的依赖闭包。queue 是 ambient 域装配面注入的磁盘队列实例（不能进
   * 静态数组的原因与 Open/swarm 相同：handler 闭包依赖装配态）；sessionId 标记创建
   * 来源会话（target=session 提醒的投递目标）；onScheduleCreated 是创建成功后的
   * runner nudge/重启缝。
   */
  ambientSchedule?: {
    queue: AmbientScheduleQueue;
    sessionId?: string;
    onScheduleCreated?(item: ScheduledItem): void;
  };
  /**
   * 动态工作流可用性门。**只有显式 false 才下架** GATED_WORKFLOW_TOOL_NAMES（dwf 十个 +
   * RunWorkflow）：缺席代表调用方不参与灰度（TUI、headless、workflow_child），必须保留全部
   * 工具面。这一层**不持有**缺省档位——协议服务端 appRuntimePreferences 里的 `false` 只是
   * 「Host 判定还没到」的占位，档位的唯一所有者是 shared 的 dynamic-workflow-feature.ts。
   * 两套工作流共用这一道门而不是各设一道，理由见 workflow-tool-names.ts。
   */
  includeDynamicWorkflow?: boolean;
  /** node_repl（js）默认关闭，由官方 browser-use 插件启用。 */
  includeNodeRepl?: boolean;
  /** browser-use 说明和 agent.browsers 注入由官方 browser-use 插件 + 宿主 browser bridge 共同启用。 */
  includeBrowserUse?: boolean;
  embeddedSearchEnabled?: boolean;
  agentProfiles?: readonly AgentProfile[];
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  silentDuplicateWarnings?: boolean;
}

export function registerBuiltInTools(
  registry: {
    register(entry: ToolEntry, options?: { silentDuplicateWarning?: boolean }): void;
  },
  options: RegisterBuiltInToolsOptions = {},
): void {
  const allowedTools = options.allowedTools ? new Set(options.allowedTools) : undefined;
  const disallowedTools = createToolRuleNameSet(options.disallowedTools);

  for (const entry of builtInTools) {
    if (
      options.embeddedSearchEnabled === true &&
      (entry.metadata.name === "Glob" || entry.metadata.name === "Grep")
    ) {
      continue;
    }
    if (allowedTools && !allowedTools.has(entry.metadata.name)) {
      continue;
    }
    if (disallowedTools?.has(entry.metadata.name)) {
      continue;
    }
    if (isSubagentDispatchToolName(entry.metadata.name) && options.includeAgent !== true) {
      continue;
    }
    if (entry.metadata.name === "Skill" && options.includeSkill === false) {
      continue;
    }
    if (entry.metadata.name === "SendMessage" && options.includeSendMessage !== true) {
      continue;
    }
    if (
      entry.metadata.name === "RespondToCoordinator" &&
      options.includeRespondToCoordinator !== true
    ) {
      continue;
    }
    if (entry.metadata.name === "submit_result" && options.includeSubmitResult !== true) {
      continue;
    }
    if (entry.metadata.name === "escalate" && options.includeEscalate !== true) {
      continue;
    }
    // 端口门：没有 WorkflowPort 就没有能启动 run 的东西。这里原本比较的是死名 "Workflow"
    // （那个条目早已移出 builtInTools，所以这一支永不命中）；RunWorkflow 落地后换成活名，
    // 极性不变。死名本身按「永不回收」纪律不在别处复活。
    if (entry.metadata.name === RUN_WORKFLOW_TOOL_NAME && options.includeWorkflow !== true) {
      continue;
    }
    if (
      (entry.metadata.name === "CronCreate" ||
        entry.metadata.name === "CronList" ||
        entry.metadata.name === "CronUpdate" ||
        entry.metadata.name === "CronDelete") &&
      options.includeAutomation !== true
    ) {
      continue;
    }
    if (
      (entry.metadata.name === "OffPeakCreate" || entry.metadata.name === "OffPeakList") &&
      options.includeOffPeak !== true
    ) {
      continue;
    }
    if (
      options.includeDynamicWorkflow === false &&
      GATED_WORKFLOW_TOOL_NAMES.has(entry.metadata.name)
    ) {
      continue;
    }
    if (entry.metadata.name === "js" && options.includeNodeRepl !== true) {
      continue;
    }
    registry.register(resolveBuiltInToolEntryForBranch(entry, options), {
      silentDuplicateWarning: options.silentDuplicateWarnings,
    });
  }
  // Open 工具（K9）：依赖 platform port 构造 handler 闭包，不能进静态数组——
  // 端口缺席即 undefined，不注册（CLI 无平台宿主时 Open 自然缺席，模型看到的世界自洽）。
  const openEntry = createOpenToolEntry({ platform: options.platformOpenPort });
  if (openEntry) {
    registry.register(openEntry, { silentDuplicateWarning: options.silentDuplicateWarnings });
  }
  // K2 swarm plan 工具族（specs/swarm-task-graph.md R5）：与 Open 同款「依赖闭包端口的
  // 工具不进静态数组」——五个工厂闭包 store（plan-shared.ts），端口缺席不注册。只读门
  // （swarmPlanReadOnly）只放行 PlanStatus：worker 子会话可见的图读取面，图变更工具仅
  // 主对话。工具描述（plan-vs-todo 分工 / deep gate 契约话术）由 2a 工厂织入，此处原样注册。
  if (options.swarmPlanPort !== undefined) {
    const { store } = options.swarmPlanPort;
    const planEntries = options.swarmPlanReadOnly
      ? [createPlanStatusToolEntry({ store })]
      : [
          createPlanSeedToolEntry({ store }),
          createPlanExpandToolEntry({ store }),
          createPlanCompleteGateToolEntry({ store }),
          createPlanStatusToolEntry({ store }),
          createPlanControlToolEntry({ store }),
        ];
    for (const entry of planEntries) {
      registry.register(entry, { silentDuplicateWarning: options.silentDuplicateWarnings });
    }
  }
  // K6 ambient Schedule 工具（specs/ambient-budget-scheduler.md R2）：与 Open/swarm 同款
  // 「依赖闭包装配态的工具不进静态数组」。双门：includeAmbientSchedule 是 flag 门
  // （runtime-tools 按 config.ambient.enabled 推导——场景 10：缺省 false 不注册，
  // 没有 runner 在跑时 Schedule 提议永远不兑现，注册只会把模型指向不兑现的承诺）；
  // ambientSchedule 闭包缺席（CLI 未装配 ambient 队列）同样不注册。
  if (options.includeAmbientSchedule === true && options.ambientSchedule !== undefined) {
    registry.register(
      createScheduleToolEntry({
        queue: options.ambientSchedule.queue,
        ...(options.ambientSchedule.sessionId !== undefined
          ? { sessionId: options.ambientSchedule.sessionId }
          : {}),
        ...(options.ambientSchedule.onScheduleCreated !== undefined
          ? { onScheduleCreated: options.ambientSchedule.onScheduleCreated }
          : {}),
      }),
      { silentDuplicateWarning: options.silentDuplicateWarnings },
    );
  }
}

function resolveBuiltInToolEntryForBranch(
  entry: ToolEntry,
  options: RegisterBuiltInToolsOptions,
): ToolEntry {
  if (entry.metadata.name === "Bash") {
    return createBashToolEntry({
      bashTimeoutPolicy: options.bashTimeoutPolicy,
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === SUBMIT_RESULT_TOOL_NAME && options.submitResultSchema !== undefined) {
    return createSubmitResultToolEntry(options.submitResultSchema);
  }
  // 灰度门同时管工具面和**描述**：Agent / Task 的描述里有一条「工作流请求必须改用
  // CreateWorkflow」，关闭时那个工具不存在，留着只会把模型指向不存在的工具。用的是与注册过滤同一个
  // options.includeDynamicWorkflow，所以首次装配与分支刷新产出的描述必然一致。
  if (entry.metadata.name === "Agent") {
    return createAgentToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
      profiles: options.agentProfiles,
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "Task") {
    return createTaskToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
      profiles: options.agentProfiles,
      dynamicWorkflowEnabled: options.includeDynamicWorkflow !== false,
    });
  }
  if (entry.metadata.name === "EnterPlanMode") {
    return createEnterPlanModeToolEntry({
      embeddedSearchEnabled: options.embeddedSearchEnabled,
    });
  }
  if (entry.metadata.name === "js") {
    return createJsToolEntry({
      browserUseEnabled: options.includeBrowserUse === true,
    });
  }
  return entry;
}
