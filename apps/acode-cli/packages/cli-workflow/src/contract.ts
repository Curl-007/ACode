/**
 * @acode/cli-workflow 公开契约（W1-R3，specs/cli-workflow-package-boundary.md）。
 *
 * 跨包唯一入口（package exports `"."` 与 `"./contract"`）。消费方只有 bootstrap 装配接缝
 * （workflow-wiring / workflow-app-facade / workflow-facade / workflow-methods /
 * script-workflow-methods / create-app / ambient-runtime / overnight-controller /
 * swarm-plan-runtime）、legacy `acode-protocol/saved-workflows.ts` 与 CLI 测试；一律经
 * 包名入口，不得深导入内部文件。
 *
 * 本包拥有：DWF run 应用服务（launch/submit/lifecycle/replay/roster/observation/
 * introspection/reconcile）、expert workflow driver、Script Workflow 引擎（runtime/
 * child-runtime/tool-port/process/replay/reconcile/progress-adapter/meta/format/prepare/
 * utils/child-source/run-status/run-summary）、workflow 支撑件（artifact 发布、并发
 * governor/ceiling、seat gate、escalation registry、worktree manager、world read、
 * snippet/gate/import）。
 * 本包不拥有：会话/runtime 事实（`@acode/core`）、journal 存储（`@acode/adapters`）、
 * run 读模型（`@acode/workflow-run-read`）、跨边界命令顺序（`@acode/workflow-run-command`）、
 * ACodeApp 能力门控（bootstrap facade）。不新建第二份 run 表、journal 或 owner 状态。
 */

// ── 宿主类型解耦（spec 规则 1/2）：引擎不反向依赖 bootstrap ──────────────
export type { PrepareUserExecutionBoundary, ScriptWorkflowHostOptions } from "./host-types.js";

// ── 技能常量（spec 规则 3）：唯一定义在 @acode/contracts，本包公开面 re-export 同一常量 ──
export { DYNAMIC_WORKFLOW_SKILL_NAME } from "@acode/contracts";

// ── 禁用路径收集（spec 规则 5）：skill-command-overrides.ts 已整体移入本包 ──
export { collectDisabledPaths } from "./skill-command-overrides.js";

// ── DWF run 应用服务（journal 窄化 / 构造 / 进度汇 / artifact 投影转发） ──
export { createDynamicWorkflowRunService } from "./dynamic-workflow-run-service.js";
export {
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
  supportsRunIntrospection,
} from "./dynamic-workflow-run-service.js";
export { artifactsOf } from "./dynamic-workflow-run-observation.js";
export { createDynamicWorkflowRunProgressSink } from "./dynamic-workflow-run-progress-sink.js";

// ── 并发治理 / 能力门控 / 瞬态 snippet ──────────────────────────────────
export { getWorkflowConcurrencyGovernor } from "./workflow-concurrency-governor.js";
export type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
export { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";
export { createDynamicWorkflowSnippetService } from "./dynamic-workflow-snippet-service.js";

// ── Script Workflow 引擎 ────────────────────────────────────────────────
export { createScriptWorkflowAgentRuntime } from "./script-workflow-child-runtime.js";
export type { ScriptWorkflowAgentRuntimeDeps } from "./script-workflow-child-runtime.js";
export { ScriptWorkflowRuntime } from "./script-workflow-runtime.js";
export type { ScriptWorkflowRuntimeDeps } from "./script-workflow-runtime.js";
export { createScriptWorkflowToolPort } from "./script-workflow-tool-port.js";
export { reconcileOrphanScriptWorkflowRuns } from "./script-workflow-reconcile.js";
export { replayScriptWorkflowRuns } from "./script-workflow-replay.js";
export { toScriptWorkflowRunSummary } from "./script-workflow-run-summary.js";
export { isScriptWorkflowStore } from "./script-workflow-utils.js";
export { createScriptWorkflowProgressAdapter } from "./script-workflow-progress-adapter.js";

// ── dwf actor 策略（模型 pin / 工具面减法） ─────────────────────────────
export { workflowActorModelPolicy } from "./workflow-actor-model.js";
export { workflowActorToolPolicy } from "./workflow-actor-tools.js";
