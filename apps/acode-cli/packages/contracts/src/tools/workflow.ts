// ============================================================
// RunWorkflow Tool - deterministic multi-agent workflow launcher
// ============================================================
// 脚本工作流（纯 JS DSL：`export const meta` + agent/parallel/pipeline/phase/log/args/budget）。
// 与 dwf 的 CreateWorkflow 家族是**两套独立系统**，分工与边界见
// apps/acode-cli/specs/script-workflow-revival.md R6。
//
// 工具名为什么是 RunWorkflow 而不是 Workflow：`Workflow` 是这个条目被移出 builtInTools 之前
// 用过的名字，按 provider-visible-order-hygiene 的「死名永不回收」纪律保持死亡；而
// `RunWorkflow` 既不与 dwf 的 `CreateWorkflow` 字面相近（模型不会在两者间选错），
// 也符合仓库既有的动词开头命名。

import { z } from "zod";
import type { TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

export const RUN_WORKFLOW_TOOL_NAME = "RunWorkflow";

/**
 * 教模型写脚本工作流的内置技能名
 * （apps/acode-cli/packages/bundled-skills/skills/<name>/SKILL.md）。
 * 与 dwf 的 `DYNAMIC_WORKFLOW_SKILL_NAME` 并列且互不替代：两套 DSL 的编写契约不同
 * （那边禁 `export`、这边必须以 `export const meta` 开头），加载错的那份只会让模型
 * 写出编译不过的脚本。
 */
export const RUN_WORKFLOW_SKILL_NAME = "script-workflows";

export const WORKFLOW_SCRIPT_MAX_LENGTH = 524_288;
export const WORKFLOW_RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/;

export const WorkflowInputSchema = z
  .object({
    args: z
      .unknown()
      .optional()
      .describe(
        "Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, NOT as a JSON-encoded string — a stringified list breaks `args.filter`/`args.map` in the script. Use for parameterized named workflows (e.g. a research question).",
      ),
    description: z
      .string()
      .optional()
      .describe(
        "Ignored — set the workflow description in the script's `meta` block.",
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Name of a predefined workflow (built-in or from .acode/workflows/). Resolves to a self-contained script.",
      ),
    resumeFromRunId: z
      .string()
      .regex(WORKFLOW_RUN_ID_PATTERN)
      .optional()
      .describe(
        "Run ID of a prior RunWorkflow invocation to resume from. Completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same-session only. Stop the prior run first (TaskStop) before resuming.",
      ),
    script: z
      .string()
      .max(WORKFLOW_SCRIPT_MAX_LENGTH)
      .optional()
      .describe(
        "Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().",
      ),
    scriptPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Path to a workflow script file on disk. Every RunWorkflow invocation persists its script under the session directory and returns the path in the tool result. To iterate, edit that file with Write/Edit and re-invoke RunWorkflow with the same `scriptPath` instead of re-sending the full script. Takes precedence over `script` and `name`.",
      ),
    title: z
      .string()
      .optional()
      .describe("Ignored — set the workflow title in the script's `meta` block."),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.scriptPath || input.script || input.name || input.resumeFromRunId) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "RunWorkflow requires scriptPath, script, name, or resumeFromRunId.",
    });
  });

export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

export const WorkflowInputJsonSchema = toToolJsonSchema(WorkflowInputSchema);

export const WorkflowOutputStatusSchema = z.enum(["backgrounded", "completed", "failed"]);
export type WorkflowOutputStatus = z.infer<typeof WorkflowOutputStatusSchema>;

export const WorkflowOutputSchema = z
  .object({
    backgroundTaskId: z.string().regex(WORKFLOW_RUN_ID_PATTERN),
    name: z.string().min(1).optional(),
    response: z.string(),
    runId: z.string().regex(WORKFLOW_RUN_ID_PATTERN),
    scriptPath: z.string().min(1).optional(),
    status: WorkflowOutputStatusSchema,
    traceId: z.string().min(1),
  })
  .strict();

export type WorkflowOutput = z.infer<typeof WorkflowOutputSchema>;

export const WorkflowOutputJsonSchema = toToolJsonSchema(WorkflowOutputSchema);

export interface WorkflowToolResult {
  output: WorkflowOutput;
  traceId: TraceId;
}
