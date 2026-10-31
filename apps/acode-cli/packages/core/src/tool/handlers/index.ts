// ============================================================
// Built-in Tool Handlers
// ============================================================

import {
  DEFERRED_TOOL_CALL_NAME,
  RUN_WORKFLOW_TOOL_NAME,
  SUBMIT_RESULT_TOOL_NAME,
  TOOL_SEARCH_NAME,
} from "@acode/contracts";
import type { ToolEntry } from "../types.js";
// 注册选项拆到独立声明文件：index.ts 受 legacy max-file-lines ratchet 约束（只减不增）。
import type { RegisterBuiltInToolsOptions } from "./register-built-in-tools-options.js";
import { readToolEntry } from "./read.js";
import { writeToolEntry } from "./write.js";
import { editToolEntry } from "./edit.js";
import { applyPatchToolEntry } from "./apply-patch.js";
import { bashToolEntry, createBashToolEntry } from "./bash.js";
// PowerShell 工具（specs/powershell-tool.md R8①）：win32 且可解析时注册，timeout 与 Bash 同源。
import {
  powerShellToolEntries,
  resolvePowerShellEntryForBranch,
} from "./powershell-registration.js";
import { createJsToolEntry, jsToolEntry } from "./node-repl.js";
import { globToolEntry } from "./glob.js";
import { grepToolEntry } from "./grep.js";
import { lspToolEntry } from "./lsp.js";
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
// 回合收尾协议（specs/turn-wrap-up.md）：无端口门；义务评估只在主对话成功收口路径。
import { turnWrapUpToolEntry } from "./turn-wrap-up.js";
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
import { taskOutputToolEntry } from "./task-output.js";
import { taskStopToolEntry } from "./task-stop.js";
import { readSessionContextToolEntry } from "./read-session-context.js";
// dwf 工具族（11 个 entry）按架构 ratchet 行数门禁抽到 dwf-workflow-tool-entries.ts，
// 此处原位展开——注册顺序与过滤链语义不变。
import { dwfWorkflowToolEntries } from "./dwf-workflow-tool-entries.js";
// 脚本工作流（纯 JS DSL）的入口，与上面 dwf 那十个是两套独立系统；
// 灰度门控名单抽到 workflow-tool-names.ts，理由见那个文件的头注释。
import { runWorkflowToolEntry } from "./run-workflow.js";
import { shouldSkipWorkflowToolEntry } from "./workflow-tool-names.js";
// 会话级 git worktree 生命周期三工具（specs/session-worktree-lifecycle.md）。
import { enterSessionWorktreeToolEntry } from "./enter-session-worktree.js";
import { mergeBaseBranchToolEntry } from "./merge-base-branch.js";
import { reapSessionWorktreesToolEntry } from "./reap-session-worktrees.js";
// 会话舰队七工具（specs/session-fleet.md）按 ratchet 行数门禁抽到
// fleet-tool-entries.ts，下方原位展开；周期摘要条目随领域模块住 core/src/digest/
//（specs/periodic-digest.md，handlers/ 目录外的领域模块先例同 dwf 族）。
import { fleetToolEntries } from "./fleet-tool-entries.js";
import { generateDigestToolEntry } from "../../digest/generate-digest-tool.js";
import { sessionSearchToolEntry } from "./session-search.js";
// 工具按需检索的两个控制工具（specs/tool-search.md wave 1a）：includeToolSearch 门
// （runtime 启动选项 toolSearchMode 非 off）才注册；off 时连注册表都不进，
// 默认零行为变化由注册面结构性保证，不依赖请求投影兜底。
import { toolSearchToolEntry } from "./tool-search.js";
import { deferredToolCallToolEntry } from "./deferred-tool-call.js";
// 对话内可视化写入工具：技能门 visualize，落点会话存储（specs/gen-ui-visualize.md）。
import { writeVisualizationFragmentToolEntry } from "./write-visualization-fragment.js";
import { createOpenToolEntry } from "./open.js";
import { createPlanCompleteGateToolEntry } from "./plan-complete-gate.js";
import { createPlanControlToolEntry } from "./plan-control.js";
import { createPlanExpandToolEntry } from "./plan-expand.js";
import { createPlanSeedToolEntry } from "./plan-seed.js";
import { createPlanStatusToolEntry } from "./plan-status.js";
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
  ...powerShellToolEntries,
  globToolEntry,
  grepToolEntry,
  lspToolEntry,
  webFetchToolEntry,
  webSearchToolEntry,
  todoReadToolEntry,
  todoWriteToolEntry,
  // 收尾载荷与任务列表同属「UI 耦合的会话事实」族，排在一起便于对照。
  turnWrapUpToolEntry,
  cronCreateToolEntry,
  cronListToolEntry,
  cronUpdateToolEntry,
  cronDeleteToolEntry,
  offPeakCreateToolEntry,
  offPeakListToolEntry,
  // 周期摘要（specs/periodic-digest.md）：只读聚合既有查询面 + session markdown
  // 产物；周期触发复用既有 cron 面（automation prompt 里点名调用 GenerateDigest），
  // 不建第二调度器——调度单一所有者是 host cron，digest 是能力不是策略。
  generateDigestToolEntry,
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
  // 工具按需检索控制工具（specs/tool-search.md R4 常驻名单）：永不 defer；
  // 注册门 includeToolSearch 见 registerBuiltInTools 过滤链。
  toolSearchToolEntry,
  deferredToolCallToolEntry,
  // 对话内可视化片段写入（specs/gen-ui-visualize.md）：技能门 visualize；只写会话存储。
  writeVisualizationFragmentToolEntry,
  agentToolEntry,
  taskToolEntry,
  skillToolEntry,
  jsToolEntry,
  // dwf 工具族（创作/修订/保存、run 内省与恢复、升级问答、洞填充、定义清单、模型
  // 目录）：清单抽至 dwf-workflow-tool-entries.ts，逐条注释与顺序在该文件逐字保留。
  ...dwfWorkflowToolEntries,
  // 脚本工作流（RunWorkflow）排在 dwf 那十个之后：两套系统相邻便于对照，但它是**另一套**——
  // 纯 JS、以 `export const meta` 开头、无类型检查、runId 前缀 wf_ 而非 dwfrun_、
  // 落 workflow_activity 表而非 dwf_* 表。注册门也不同：它要 `includeWorkflow`（端口在场）
  // 与 `includeDynamicWorkflow`（灰度）两道门同时放行，见下面过滤链的两支。
  runWorkflowToolEntry,
  // 会话级 git worktree 生命周期（specs/session-worktree-lifecycle.md）：进入隔离
  // worktree / 宿主合并基分支 / 收割不活跃。无注册门——对任何 git 仓会话自洽，
  // 非 git 仓由工具闭集拒绝面（not_git_repo）兜住；workflow actor 侧经
  // ACTOR_DISALLOWED_TOOLS 分域禁用（actor 已在 workflow 域 worktree 内）。
  enterSessionWorktreeToolEntry,
  mergeBaseBranchToolEntry,
  reapSessionWorktreesToolEntry,
  // 会话舰队（specs/session-fleet.md R1）：清单见 fleet-tool-entries.ts（注释逐字
  // 保留在该文件）；无注册门，无人值守双层收敛与所有权封闭见彼处说明。
  ...fleetToolEntries,
];

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
    // 工具按需检索控制工具的注册门：只有显式 true 才注册（与 includeOffPeak 同极性）。
    if (
      (entry.metadata.name === TOOL_SEARCH_NAME ||
        entry.metadata.name === DEFERRED_TOOL_CALL_NAME) &&
      options.includeToolSearch !== true
    ) {
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
    // 两道工作流门的合取（dwf 总闸 × 脚本工作流门）：谓词单点收在 workflow-tool-names.ts。
    if (shouldSkipWorkflowToolEntry(entry.metadata.name, options)) {
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
  // PowerShell：与 Bash 同款分支重铸（timeout 策略同源透传，spec powershell-tool.md R8①）。
  const powerShellBranch = resolvePowerShellEntryForBranch(entry, options.bashTimeoutPolicy);
  if (powerShellBranch) return powerShellBranch;
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
      // U11 图片外置引用生产门（specs/tool-media-attachment-ref.md R10.1）：默认关闭。
      nodeReplMediaRefs: options.nodeReplMediaRefs === true,
    });
  }
  return entry;
}
