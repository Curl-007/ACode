// ============================================================
// RunWorkflow Tool Handler
// ============================================================
// 脚本工作流的唯一工具入口：接收一段纯 JavaScript 工作流脚本（或一个预定义工作流的名字），
// 交给 bootstrap 的 ScriptWorkflowRuntime 在子进程的 vm realm 里后台跑起来。
//
// 与 dwf 的 CreateWorkflow 是**两套独立系统**，不是同一件事的两种写法：那边是 TypeScript
// 经编译器对着 facade 类型检查、站点身份在编译期铸造；这边是纯 JS、无类型检查、缓存键在运行期
// 由 callPath 铸造。两者的脚本**不可互换**（dwf 禁止 `export`，这边必须以 `export const meta`
// 开头），所以描述里必须把分工说穿——边界与依据见
// apps/acode-cli/specs/script-workflow-revival.md R6。
//
// 本文件只做三件事：技能门、把入参补成 WorkflowStartRequest、把端口结果原样交回。
// 解析 meta、落盘脚本、铸造 runId、跑子进程、写库全部在 bootstrap 侧，这里一个字节都不碰。

import {
  RUN_WORKFLOW_SKILL_NAME,
  RUN_WORKFLOW_TOOL_NAME,
  WorkflowInputJsonSchema,
  WorkflowInputSchema,
  WorkflowOutputJsonSchema,
  WorkflowOutputSchema,
  type ModelMessageContent,
  type WorkflowInput,
  type WorkflowOutput,
  type WorkflowStartRequest,
} from "@acode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import { resolveTraceContext } from "./create-workflow.js";
import { requireWorkflowSkill, runWorkflowNeedsSkill } from "./workflow-skill-gate.js";

/**
 * 启动本身是快的（端口立即返回 `status: "backgrounded"`，run 在后台跑），所以超时对齐
 * CreateWorkflow 的量级而不是「一次多代理编排」的量级。真正的长任务由后台任务面
 * （TaskOutput / TaskStop）与完成通知承载，不占用这个调用。
 */
const RUN_WORKFLOW_TIMEOUT_MS = 15_000;
/** 输出只有 runId / scriptPath / 一句 response，24k 与 CreateWorkflow 同款、绰绰有余。 */
const RUN_WORKFLOW_MODEL_BYTES = 24_000;

const RUN_WORKFLOW_DESCRIPTION = [
  "Run a JavaScript workflow script that orchestrates subagents deterministically. The run happens in the background: this call returns immediately with a run ID, and a task notification arrives when the run finishes.",
  "",
  "ONLY call this tool when the user has explicitly opted into this style of orchestration — they named ultracode, asked for a script workflow or multi-agent fan-out in their own words, or invoked a command or skill that tells you to call it. A task that would merely benefit from parallelism does NOT qualify: use the Agent tool for individual subagents, or say what a workflow could do and roughly cost and ask the user whether to run one.",
  "",
  "This is NOT the dynamic-workflow tool. Two workflow systems coexist and their scripts are not interchangeable:",
  "- `CreateWorkflow` — TypeScript, typechecked against a facade; the script body may not contain `export`. `/workflow` and any plain request to \u201cuse a workflow\u201d route there.",
  "- `RunWorkflow` (this tool) — plain JavaScript whose first statement must be `export const meta = {...}`, with `agent()`/`parallel()`/`pipeline()`/`phase()`/`log()`/`args`/`budget` available. `/ultracode` routes here.",
  "Submitting a script to the wrong one fails: `export` is rejected there, and the facade declarations are absent here.",
  "",
  `Load the \`${RUN_WORKFLOW_SKILL_NAME}\` skill with the Skill tool before writing a script: it carries the full script API, the pipeline-vs-parallel rule, the caps, the determinism bans and the resume semantics. A call that passes \`script\` or \`scriptPath\` is refused until that skill has been loaded in this session; running a predefined workflow by \`name\`, or resuming by \`resumeFromRunId\`, is exempt.`,
  "",
  "Pass exactly one source: `script` (inline), `scriptPath` (a file on disk — takes precedence, and the usual way to iterate on a run whose script you already edited), or `name` (a predefined workflow). Every invocation persists its script and returns the path, so edit that file and re-invoke with `scriptPath` instead of resending the whole script.",
].join("\n");

const runWorkflowHandler: ToolHandler = async (
  input: unknown,
  context: ToolExecutionContext,
): Promise<WorkflowOutput> => {
  const parsed = WorkflowInputSchema.parse(input) as WorkflowInput;

  const port = context.workflowPort;
  if (port === undefined) {
    // 到不了：注册门按 `includeWorkflow`（= 端口在场）放行，端口缺席时这个工具根本不注册。
    // 真发生了说明有人绕过了装配，说出来好过伪造一个 runId——输出 schema 要求 runId 匹配
    // /^wf_[a-z0-9-]{6,}$/，编一个出来等于让模型去等一个永不到来的通知。
    throw new Error("RunWorkflow is not available in this session: no workflow port is wired");
  }

  const request: WorkflowStartRequest = {
    ...parsed,
    parentToolCallId: context.toolCallId,
    sessionId: context.sessionId,
    trace: resolveTraceContext(context),
    ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  };

  // 取消语义：启动阶段可取消（端口会看 signal）；一旦返回 backgrounded，run 已脱离本次
  // tool call，父 turn 取消不再中止它——那条裁决在 script-workflow-tool-port.ts 里，
  // 这里不重复实现，也不代为决定。
  return await port.start(request, { signal: context.abortSignal });
};

function formatRunWorkflowModelContent(output: unknown): ModelMessageContent {
  const parsed = WorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return "RunWorkflow returned an invalid result.";
  return parsed.data.response;
}

export const runWorkflowToolEntry: ToolEntry = {
  capability:
    "Launch a JavaScript workflow script that fans out subagents deterministically, as a background run",
  metadata: {
    name: RUN_WORKFLOW_TOOL_NAME,
    description: RUN_WORKFLOW_DESCRIPTION,
    // 这个调用会启动一个执行子进程与多个子代理会话；只读声明随执行语义翻面。
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: RUN_WORKFLOW_TIMEOUT_MS,
    maxOutputBytes: RUN_WORKFLOW_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: runWorkflowHandler,
  resolveInput: (input, context) => {
    // 技能门先于一切：没读过 script-workflows 就拒绝接受脚本。
    // 按 name 跑预定义工作流、或只带 resumeFromRunId 续跑，都不算创作，免技能（见 gate 模块）。
    if (runWorkflowNeedsSkill(input)) {
      const refused = requireWorkflowSkill(
        context,
        RUN_WORKFLOW_TOOL_NAME,
        RUN_WORKFLOW_SKILL_NAME,
      );
      if (refused) return refused;
    }
    return { input, result: true };
  },
  inputSchema: WorkflowInputJsonSchema,
  outputSchema: WorkflowOutputJsonSchema,
  runtimeInputSchema: WorkflowInputSchema,
  runtimeOutputSchema: WorkflowOutputSchema,
  formatModelContent: formatRunWorkflowModelContent,
  permission: {
    permission: "runWorkflow",
    // 诊断用，不面向用户：确认窗自己渲染本地化标题，UI 会过滤读起来像内部信息的 reason。
    reason: "runWorkflow.runConfirmation: user must confirm running the submitted script",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: true,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // 一整块代码执行 + 多次模型调用，任何权限模式（含 yolo / plan）都要先问。
    // 与 CreateWorkflow 同一条裁决，理由也同一条：run 一次要花钱且有真实副作用，
    // 而 scriptPath 指向的文件在批准之后随时可能被改动，所以「上次批准过」推不出
    // 「这次要跑的还是那段代码」——持久确认永不减免。
    alwaysAsk: true,
    // 放开的只是**会话作用域**：用户看过并批准本会话第一个脚本之后，可以选
    // 「Always allow in this session」让本会话后续免确认。授权只活在 PermissionService
    // 实例的内存里，重启 / 冷恢复 / `/new` 都从零开始。
    askOptions: { allowAlways: "session" },
  },
  resultBudget: {
    maxInlineBytes: RUN_WORKFLOW_MODEL_BYTES,
    maxModelBytes: RUN_WORKFLOW_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: RUN_WORKFLOW_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: RUN_WORKFLOW_TIMEOUT_MS,
    maxMs: RUN_WORKFLOW_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    // 启动阶段本身很快且不可中断；已 backgrounded 的 run 由 TaskStop 管，不归这个工具。
    supported: false,
    cleanup: "none",
    userVisibleMessage: "RunWorkflow hands the script to a background run and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
