// CreateWorkflow 入参契约 —— 执行体来源（script/saved/path）、归一化输入与诊断形态。
// 例外偿还（contracts-onboarding-max-file-lines-create-workflow）：自 tools/create-workflow.ts
// 拆出。原文件降为 barrel 并对本叶 `export *`，公开导出面逐名不变。
// 依赖单向：create-workflow-graph → 本叶（输出 schema 引用诊断形状）；本叶不 import 其他叶子。
// ============================================================
// CreateWorkflow Tool - typecheck a dynamic-workflow script and start a background run
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { SAVED_WORKFLOW_MAX_NAME_CHARS, SavedWorkflowScopeSchema } from "./saved-workflow.js";

/** 「恰好给一个执行体来源」的违规说明。写成常量是因为模型是它唯一的读者，三条路径同一句话。 */
export const CREATE_WORKFLOW_SOURCE_ERROR =
  "Provide exactly one workflow source: `script` for a one-off script written inline, `saved` to run a workflow saved in this project, or `path` for a script file on disk (the file a previous result named). Passing more than one, or none, is ambiguous.";

/** `args` 只属于 `path` 来源的违规说明（`saved` 有自己的 `saved.args`，内联脚本没有声明）。 */
export const CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR =
  "`args` belongs to the `path` source: it carries values for the arguments a script file declares in its `/* acode-workflow` block. For a saved workflow pass `saved.args`; an inline `script` declares no arguments, so it takes none.";

/**
 * `saved` 来源。模型填 `name`，可选 `args` 与 `scope`（消歧用）；`path` 是 `resolveInput`
 * 解析后**回填**的事实，`scope` 归一化后也变成命中的那一根，所以两者都可选。
 *
 * 归一化输入因此是一个 `script` 与 `saved` **同时在场**的合法执行态——这正是 XOR 不能写在
 * zod 上的原因（见 {@link CreateWorkflowInputSchema}）。
 */
export const CreateWorkflowSavedSourceSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(SAVED_WORKFLOW_MAX_NAME_CHARS)
      .describe("Name of a saved workflow (see ListSavedWorkflows)."),
    args: z
      .record(z.unknown())
      .optional()
      .describe("Values for the arguments the saved workflow declares."),
    /** 解析回填：保存文件的落点。模型不填。 */
    path: z.string().min(1).optional(),
    /**
     * 消歧：从哪一档取这个 workflow。缺省走既有查找顺序（同名时项目档遮蔽全局档）。
     * 归一化后 `scope` 变成**命中**的那一根，见 create-workflow-source.ts。
     */
    scope: SavedWorkflowScopeSchema.optional().describe(
      "Which archive to take it from; omit for the normal lookup order.",
    ),
  })
  .strict();

export type CreateWorkflowSavedSource = z.infer<typeof CreateWorkflowSavedSourceSchema>;

/**
 * 运行时的 `saved` 块：模型面那些字段 + `draft`。
 *
 * `draft` 是 `resolveInput` 写下那份工作副本之后回填的**落点**：保存的定义永远不因为一次 run 被改动，模型要改的是这份拷贝。它与
 * `AmendWorkflow.predecessor` 同一个姿态——事实由工具算，模型的 JSON schema 不列它，所以模型
 * 不会以为自己该填一个路径。写不下去时字段整个缺席（草稿是尽力而为）。
 */
export const CreateWorkflowResolvedSavedSourceSchema = CreateWorkflowSavedSourceSchema.extend({
  draft: z.string().min(1).optional(),
}).strict();

export type CreateWorkflowResolvedSavedSource = z.infer<
  typeof CreateWorkflowResolvedSavedSourceSchema
>;

/**
 * 执行体有三个来源，恰好给一个——但这条 XOR **刻意不写在 schema 上**。
 *
 * 理由是归一化：`resolveInput` 把保存的脚本（或 `path` 文件）解析出来之后，输入同时带着
 * `script`（要跑的字节）与 `saved` / `path`（它的来龙去脉）。一条 superRefine 会在两个地方炸掉
 * 这个合法形状——handler 自己的 `parse`，以及 hook 改写输入后 call-runner 的二次校验——而且
 * **只在非内联路径上**炸，属于那种测不到就上线的错误。XOR 因此由 `entry.validateInput` 在
 * **模型入参**上强制，那里正是它唯一为真的地方。JSON schema 本来也表达不了 refinement，
 * 模型侧靠字段描述引导。
 */
const CreateWorkflowModelInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Short run label in the user's language. Always pass it for an inline script; defaults to the saved workflow's name.",
      ),
    script: z
      .string()
      .optional()
      .describe("The whole workflow script, inline. Exactly one of `script`, `saved` and `path`."),
    saved: CreateWorkflowSavedSourceSchema.optional().describe(
      "A saved workflow to run, by name. Exactly one of `script`, `saved` and `path`.",
    ),
    /**
     * 第三条来源：
     * 盘上的一个脚本文件。它是内联提交的**回程**——工具写下草稿、结果点名那个文件，模型下一次
     * 只改一行再把同一个路径交回来。带 `/* acode-workflow` 块的文件按保存定义解析（块剥掉、
     * 正文当脚本、`args` 按块里的声明校验）。
     */
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A script file on disk (relative or absolute), usually the file a previous result named. Exactly one of `script`, `saved` and `path`.",
      ),
    /**
     * `path` 文件声明的实参。`saved` 有自己的 `saved.args`（同一套校验规则），内联脚本没有声明，
     * 所以这个字段与 `path` 同进同退——`validateInput` 在模型入参上把这条钉住。
     */
    args: z
      .record(z.unknown())
      .optional()
      .describe("Values for the arguments a `path` file declares. Only with `path`."),
    /**
     * run 自己的并发上界。只压低、不抬高：
     * `resolveInput` 钳到 `[1, 天花板]`，确认窗与 handler 看到的就是将要生效的值。缺席即天花板。
     * 只在用户要求时设——provider 限流由运行时自适应，模型不该拿它当保险。
     */
    max_concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Upper bound on subagents working at once. Only when the user asks to limit parallelism; never as a reaction to provider errors.",
      ),
    /**
     * 本 run 子代理跑在哪个模型上。与
     * `max_concurrency` 同族：模型面收一个宽松的字符串，`resolveInput` 经模型目录端口解析成
     * 规范形 `providerId/modelId[$reasoningLevel]`——确认窗与 handler 读到的就是将要生效的值，
     * 解不出来在开窗**之前**就作为业务失败退回。主代理自己恒留在会话模型上；缺席即子代理也是。
     */
    subagent_model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Model for the subagents (`providerId/modelId` or a model id). Only when the user asks; you stay on the session model.",
      ),
    // 修订续跑不在这里：它是 `AmendWorkflow` 的工作（amend-workflow.ts）。`.strict()` 让旧写法 `resume_from` 成为可见的 schema 错误，
    // 而不是被静默忽略后变成一次全价重跑。
  })
  .strict();

/**
 * 运行时入参：模型面那些字段 + `resolveInput` 回填的事实。
 *
 * 回填项与 `AmendWorkflow.predecessor` 同一个姿态——模型的 JSON schema 不列它们，因为它们不是
 * 可填的参数而是解析结果；模型若硬填，归一化会无条件覆盖。
 */
export const CreateWorkflowInputSchema = CreateWorkflowModelInputSchema.extend({
  saved: CreateWorkflowResolvedSavedSourceSchema.optional(),
  /**
   * 正文行 → 文件行的偏移（`path` / `saved` 文件带元数据块时才非零）。诊断按文件行报出来时
   * 加它，好让行号能直接粘进一次对该文件的 `Edit`。
   */
  script_line_offset: z.number().int().nonnegative().optional(),
}).strict();

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInputSchema>;

/** 交给模型的 JSON schema：不含 `script_line_offset`，`saved` 里也不含 `draft`。 */
export const CreateWorkflowInputJsonSchema = toToolJsonSchema(CreateWorkflowModelInputSchema);

export const CreateWorkflowDiagnosticSchema = z
  .object({
    code: z.number(),
    column: z.number(),
    line: z.number(),
    message: z.string(),
  })
  .strict();

export type CreateWorkflowDiagnostic = z.infer<typeof CreateWorkflowDiagnosticSchema>;

// CreateWorkflow display 是独立于模型文本的有界投影：诊断可能很多，必须在协议边界限长，
// 避免类型检查结果把 continuous/replayable 消息扩成无界载荷。
// 诊断的 display 条目形状同时被 create_workflow 与 eval_workflow_snippet 两个 display
// payload 复用（同一 TS 诊断形状、同一道限长），因此定义在这里而不是 tool-result-metadata.ts
// ——后者要反向引用本文件里的 schema，放那里会成环。
export const CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS = 100;
export const CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS = 2_048;

export const createWorkflowToolResultDisplayDiagnosticSchema = z
  .object({
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    code: z.number().int().nonnegative(),
    message: z.string().min(1).max(CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
  })
  .strict();
