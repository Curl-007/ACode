// ============================================================
// FillWorkflowHole Tool Handler（挖洞-填充的主代理侧）
// ============================================================
// specs/workflow-holes.md：run 停在 `hole<T>(stage, prompt)` 上等待，本工具把 fill 的
// **语句**交给服务端 splice 进 run 草稿、重编译、重开确认窗，然后沿 amend/supersede 链
// 续跑。与 AmendWorkflow 的分工：修订是**整份脚本**的重提交，fill 是**一个洞的函数体**。
//
// 分层（照 resolve-workflow-question 的「handler 刻意很薄」）：确认之前的一切（读世界、
// splice、分析、fill_unchanged）在 fill-workflow-hole-resolve.ts；本文件是工具条目、
// 落盘（fill 文件 + splice 后的草稿）、端口调用与契约投影。

import path from "node:path";
import {
  createWorkflowPhaseNames,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  FillWorkflowHoleInputJsonSchema,
  FillWorkflowHoleInputSchema,
  FillWorkflowHoleOutputJsonSchema,
  FillWorkflowHoleOutputSchema,
  type FillWorkflowHoleInput,
  type FillWorkflowHoleOutput,
  type ModelMessageContent,
} from "@acode/contracts";
import type {
  ToolApprovalGate,
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
} from "../types.js";
import { boundGraphOfAnalysis, displayOfAnalysis } from "./workflow-analysis-display.js";
import { resolveTraceContext } from "./create-workflow.js";
import { recordAuthoredWorkflowDraft } from "./workflow-draft-read-state.js";
import { resolveWorkflowDraftName, writeWorkflowDraft } from "./workflow-drafts.js";
import { analyzeScript } from "./workflow-script-analysis.js";
import {
  FILL_WORKFLOW_HOLE_ERROR_CODE,
  fillingUnavailableFailure,
  rememberRejectedFill,
  resolveFillWorkflowHoleInput,
  validateFillWorkflowHoleSource,
} from "./fill-workflow-hole-resolve.js";
// 确认之前的一切在 fill-workflow-hole-resolve.ts（amend-workflow-resolve 的同款拆分）；
// 这两个名字按 amend 的先例在此再导出，既有消费方（测试、未来的接线）导入路径不变。
export { validateFillWorkflowHoleSource } from "./fill-workflow-hole-resolve.js";

const FILL_WORKFLOW_HOLE_TIMEOUT_MS = 15_000;
const FILL_WORKFLOW_HOLE_MODEL_BYTES = 24_000;

const FILL_WORKFLOW_HOLE_DESCRIPTION = [
  "Fills one hole in a RUNNING dynamic-workflow run: the script parked itself at a `hole(stage, prompt)` call and is waiting for the statements of that gap's body.",
  "",
  "- Takes `run_id`, `hole_ref` (shaped `hole#N@ordinal`, from the hole notification or GetWorkflowRun's pending holes) and the statements as `script`, or a file holding them as `path`.",
  "- The statements are spliced in as `await (async () => { <statements> })()`, so top-level await is legal and a `return` yields the hole's type T. The body sees every binding declared before the hole; it may end in a new tail hole when the next step is still unknown (nested growth).",
  "- Splicing produces new executable code, so the confirmation window is recalculated and the user confirms again — including any new `world.run` commands the fill introduces. On confirmation the parked run is stopped and superseded by its continuation, which imports the finished work as cache.",
  "- Diagnostics mean nothing was spliced and the hole still waits: the response names the fill file — edit it and resubmit with `path`, never paste the statements again. Resubmitting byte-identical statements is refused as unchanged.",
  "- A hole returns code, not data: when only the data is missing, use a subagent ask (or the run's own escalate path) instead.",
].join("\n");

const fillWorkflowHoleHandler: ToolHandler = async (
  input,
  context: ToolExecutionContext,
) => {
  const parsed = FillWorkflowHoleInputSchema.parse(input) as FillWorkflowHoleInput;
  const port = context.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.fillHole !== "function") {
    return fillingUnavailableFailure();
  }
  // resolveInput 恒把两个归一化字段落定进来；缺了只可能是绕过归一化的调用方——结构化失败，
  // 而不是把 undefined 交给服务端。
  const fill = parsed.fill;
  const splicedScript = parsed.spliced_script;
  if (fill === undefined || splicedScript === undefined) {
    return {
      result: false,
      errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_SOURCE,
      message:
        "workflow_fill_source: the fill statements could not be resolved; pass them inline as `script` or as a file `path`.",
    };
  }
  const cwd = context.workingDirectory;

  // 分析读单槽记忆（resolveInput/确认窗刚跑过同一段脚本，这里命中），阶段表与新 run 同车。
  const analysis = analyzeScript(splicedScript);
  const causalityGraph = boundGraphOfAnalysis(analysis);

  // fill 文件：与 run 草稿同目录（specs/workflow-holes.md），被拒后的 Edit-and-`path` 把手。
  // run 记过脚本文件就落它旁边；没记过（草稿写不下去的项目）落 workflow-drafts。
  const detail = await port.getRunDetail?.(parsed.run_id);
  const fillDirectory =
    detail?.scriptPath !== undefined ? path.dirname(detail.scriptPath) : undefined;
  const fillStage = detail?.pendingHoles?.find((hole) => hole.holeId === parsed.hole_ref)?.stage;
  const fillDraft = await writeWorkflowDraft({
    cwd,
    ...(fillDirectory === undefined ? {} : { directory: fillDirectory }),
    name: `hole-fill ${fillStage ?? parsed.hole_ref}`,
    source: fill,
  });
  if (fillDraft !== undefined) {
    // fill 是模型亲手写的字节：记作它写过的文件，下一次 Edit 不必先 Read。
    await recordAuthoredWorkflowDraft(context, {
      path: fillDraft.path,
      source: fill,
      toolName: FILL_WORKFLOW_HOLE_TOOL_NAME,
    });
  }
  // splice 后的脚本草稿：新 run 记的永远是装着**这一次脚本**的文件（amend 同一条纪律，
  // 绝不沿用前驱的路径——那个文件装的是旧脚本）。
  const splicedDraft = await writeWorkflowDraft({
    cwd,
    name: resolveWorkflowDraftName(detail?.label, causalityGraph),
    source: splicedScript,
  });

  const filled = await port.fillHole({
    runId: parsed.run_id,
    holeId: parsed.hole_ref,
    fill,
    cwd: context.workingDirectory ?? ".",
    ...(fillDraft === undefined ? {} : { fillPath: fillDraft.path }),
    ...(splicedDraft === undefined ? {} : { scriptPath: splicedDraft.path }),
    ...(() => {
      const phaseNames =
        causalityGraph === undefined ? undefined : createWorkflowPhaseNames(causalityGraph);
      return phaseNames === undefined ? {} : { phaseNames };
    })(),
    parentSessionId: context.sessionId,
    toolCallId: context.toolCallId,
    trace: resolveTraceContext(context),
  });
  if (!filled.ok) {
    if (filled.reason === "fill_compile_failed") {
      // 服务端权威 splice 撞上了（草稿在确认之后被换过）：记忆槽换新，文案带服务端诊断。
      rememberRejectedFill(`${parsed.run_id}#${parsed.hole_ref}`, fill);
      return {
        result: false,
        errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.FILL_COMPILE,
        message: filled.message,
      };
    }
    return {
      result: false,
      errorCode: FILL_WORKFLOW_HOLE_ERROR_CODE.HOLE_NOT_WAITING,
      message: filled.message,
    };
  }

  return {
    ok: true,
    runId: filled.runId,
    response: [
      filled.supersededRunId === undefined
        ? `The hole's continuation started as run ${filled.runId}.`
        : `Run ${filled.supersededRunId} was parked at the hole; it has been stopped and superseded, and its finished work is imported as cache. The continuation started as run ${filled.runId}.`,
      filled.cacheImported
        ? undefined
        : `Cache was only partially imported: ${filled.cacheImportedReason ?? "the predecessor's workspace had changed since some results were recorded."}`,
      "It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.",
      fillDraft === undefined ? undefined : `The fill file is ${fillDraft.path}.`,
    ]
      .filter((line) => line !== undefined)
      .join(" "),
    status: "backgrounded",
    backgroundTaskId: filled.runId,
    ...(filled.fillPath === undefined ? {} : { fillPath: filled.fillPath }),
    cacheImported: filled.cacheImported,
    ...(filled.cacheImportedReason === undefined
      ? {}
      : { cacheImportedReason: filled.cacheImportedReason }),
  } satisfies FillWorkflowHoleOutput;
};

/**
 * 确认窗预览（**必须重算**，specs/workflow-holes.md）：splice 后的脚本是新可执行代码，
 * 新的 world.run 命令集与新拓扑必须重新展示授权——防 fill 绕过 CreateWorkflow 的授权面。
 * 读的是 resolveInput 落定的 `spliced_script`；编不过（resolveInput 已拒）或字段缺席直接
 * 放行给 handler 收口。
 */
function prepareFillWorkflowHoleApproval(input: unknown): ToolApprovalGate {
  const parsed = FillWorkflowHoleInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.spliced_script === undefined) return { gate: "proceed" };
  const analysis = analyzeScript(parsed.data.spliced_script);
  if (!analysis.ok) return { gate: "proceed" };
  const display = displayOfAnalysis(analysis, FILL_WORKFLOW_HOLE_TOOL_NAME);
  return { gate: "ask", ...(display ? { display } : {}) };
}

function formatFillWorkflowHoleModelContent(output: unknown): ModelMessageContent {
  const parsed = FillWorkflowHoleOutputSchema.safeParse(output);
  if (!parsed.success) return "FillWorkflowHole returned an invalid result.";
  return parsed.data.response;
}

export const fillWorkflowHoleToolEntry: ToolEntry = {
  capability:
    "Fill one hole in a running dynamic-workflow run with the statements of that gap's body, continuing the run along the revision chain",
  metadata: {
    name: FILL_WORKFLOW_HOLE_TOOL_NAME,
    description: FILL_WORKFLOW_HOLE_DESCRIPTION,
    // splice 后是新可执行代码（新 world.run 命令集）——不是只读。
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: FILL_WORKFLOW_HOLE_TIMEOUT_MS,
    maxOutputBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: fillWorkflowHoleHandler,
  validateInput: (input) => validateFillWorkflowHoleSource(input),
  resolveInput: (input, context) => resolveFillWorkflowHoleInput(input, context),
  prepareApproval: prepareFillWorkflowHoleApproval,
  inputSchema: FillWorkflowHoleInputJsonSchema,
  outputSchema: FillWorkflowHoleOutputJsonSchema,
  runtimeInputSchema: FillWorkflowHoleInputSchema,
  runtimeOutputSchema: FillWorkflowHoleOutputSchema,
  formatModelContent: formatFillWorkflowHoleModelContent,
  permission: {
    permission: "fillWorkflowHole",
    reason: "fillWorkflowHole.runConfirmation: user must confirm the spliced script that continues the run",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: true,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
    // 与 CreateWorkflow / AmendWorkflow 同一道门（alwaysAsk）：splice 后是一份新的可执行
    // 脚本，上一次批准覆盖不了它。会话级减免照 amend（allowAlways: session）。
    alwaysAsk: true,
    askOptions: { allowAlways: "session" },
  },
  resultBudget: {
    maxInlineBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES,
    maxModelBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: FILL_WORKFLOW_HOLE_MODEL_BYTES, direction: "head" },
  },
  timeout: {
    kind: "timed",
    defaultMs: FILL_WORKFLOW_HOLE_TIMEOUT_MS,
    maxMs: FILL_WORKFLOW_HOLE_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage: "FillWorkflowHole splices synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
