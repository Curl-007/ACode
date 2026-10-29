import { z } from "zod";
import { acodeWorkspaceRefSchema } from "../acode-session-types.js";

// 已保存工作流 GUI 中枢的 v4 面（apps/acode-cli/specs/m2-6-workflows-skills-mcp.md）。
//
// ⚠ 域边界：本文件与 workflow-runs*.ts **不同域**——那是会话内 dwf 执行投影（snapshot/delta
// 键族）；这里是 workspace 级、无会话的「已保存工作流」中枢 CRUD/移动/运行历史，每次调用现扫
// `<cwd>/.acode/workflows/`（或全局根），不投影、不订阅。
//
// 形状纪律：与 legacy 旧词表文件的 workflows* 段**逐字 parity**
// （同字段、同 strict、同值域），消费者语义零变化；不反向 import legacy barrel
// （protocol-boundary 纪律），两侧形状由 packages/shared/tests/protocol-boundary.test.mjs 钉住。
// legacy 段自述其与 @acode/contracts 的 saved-workflow.ts 逐字对齐，本文件因此也与 contracts
// 间接同形——三方的漂移由协议测试炸出，不靠 import 链传导。

const nonEmptyString = z.string().trim().min(1);

// ── 域零件（meta/entry/run）──
export const v4SavedWorkflowArgTypeSchema = z.enum(["string", "number", "boolean", "json"]);
export type V4SavedWorkflowArgType = z.infer<typeof v4SavedWorkflowArgTypeSchema>;
export const v4SavedWorkflowArgDeclarationSchema = z
  .object({
    type: v4SavedWorkflowArgTypeSchema,
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
  })
  .strict();
export type V4SavedWorkflowArgDeclaration = z.infer<typeof v4SavedWorkflowArgDeclarationSchema>;
export const v4SavedWorkflowArgsDeclarationSchema = z.record(
  z.string(),
  v4SavedWorkflowArgDeclarationSchema,
);
export type V4SavedWorkflowArgsDeclaration = z.infer<typeof v4SavedWorkflowArgsDeclarationSchema>;
export const v4SavedWorkflowMetaSchema = z
  .object({
    description: nonEmptyString,
    whenToUse: nonEmptyString.optional(),
    args: v4SavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();
export type V4SavedWorkflowMeta = z.infer<typeof v4SavedWorkflowMetaSchema>;
// 作用域两档：项目档落 `<cwd>/.acode/workflows/`、全局档落 agent 机器的 `~/.acode/workflows/`。
// 作用域由文件所在目录推得，frontmatter 不存 scope。
export const v4SavedWorkflowScopeSchema = z.enum(["project", "global"]);
export type V4SavedWorkflowScope = z.infer<typeof v4SavedWorkflowScopeSchema>;
export const v4SavedWorkflowEntrySchema = z
  .object({
    name: nonEmptyString,
    description: z.string(),
    whenToUse: z.string().optional(),
    args: v4SavedWorkflowArgsDeclarationSchema.optional(),
    scope: v4SavedWorkflowScopeSchema,
    path: nonEmptyString,
  })
  .strict();
export type V4SavedWorkflowEntry = z.infer<typeof v4SavedWorkflowEntrySchema>;
export const v4SavedWorkflowInvalidEntrySchema = z
  .object({ path: nonEmptyString, reason: nonEmptyString })
  .strict();
export type V4SavedWorkflowInvalidEntry = z.infer<typeof v4SavedWorkflowInvalidEntrySchema>;
/** 名字非法 / 未找到 / frontmatter 坏 / 读错——与 core store 的 resolve 失败四态逐字对应。 */
export const v4SavedWorkflowFailureReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "parse_error",
  "read_error",
]);
export type V4SavedWorkflowFailureReason = z.infer<typeof v4SavedWorkflowFailureReasonSchema>;
const v4SavedWorkflowFailureSchema = z
  .object({
    ok: z.literal(false),
    reason: v4SavedWorkflowFailureReasonSchema,
    detail: z.string().optional(),
  })
  .strict();

// scope 缺省语义（六法共通）：缺省即 `project`；`global` 时 `workspace` 仍必填，
// 但只是**载体运行时**——处理器对全局档不读它的路径（版本偏斜：不给 scope 的旧 GUI 逐字不变）。
const workflowScopeParam = {
  scope: v4SavedWorkflowScopeSchema.optional(),
} as const;

// ── v4/workflows/list ──
export const v4WorkflowsListParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    ...workflowScopeParam,
  })
  .strict();
export type V4WorkflowsListParams = z.infer<typeof v4WorkflowsListParamsSchema>;
export const v4WorkflowsListResultSchema = z
  .object({
    workflows: z.array(v4SavedWorkflowEntrySchema),
    invalid: z.array(v4SavedWorkflowInvalidEntrySchema),
    // 扫过的目录（本地绝对路径），即使目录还不存在也回：GUI 的文件监听靠它 watch。
    dir: nonEmptyString,
  })
  .strict();
export type V4WorkflowsListResult = z.infer<typeof v4WorkflowsListResultSchema>;

// ── v4/workflows/get ──
export const v4WorkflowsGetParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    name: nonEmptyString,
    ...workflowScopeParam,
  })
  .strict();
export type V4WorkflowsGetParams = z.infer<typeof v4WorkflowsGetParamsSchema>;
export const v4WorkflowsGetResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      name: nonEmptyString,
      path: nonEmptyString,
      scope: v4SavedWorkflowScopeSchema,
      meta: v4SavedWorkflowMetaSchema,
      /** 脚本本体（frontmatter 之后逐字节），即被类型检查与执行的那一份。 */
      script: z.string(),
    })
    .strict(),
  v4SavedWorkflowFailureSchema,
]);
export type V4WorkflowsGetResult = z.infer<typeof v4WorkflowsGetResultSchema>;

// ── v4/workflows/updateMeta ──
export const v4WorkflowsUpdateMetaParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    name: nonEmptyString,
    meta: v4SavedWorkflowMetaSchema,
    ...workflowScopeParam,
  })
  .strict();
export type V4WorkflowsUpdateMetaParams = z.infer<typeof v4WorkflowsUpdateMetaParamsSchema>;
export const v4WorkflowsUpdateMetaResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  v4SavedWorkflowFailureSchema,
]);
export type V4WorkflowsUpdateMetaResult = z.infer<typeof v4WorkflowsUpdateMetaResultSchema>;

// ── v4/workflows/delete ──
export const v4WorkflowsDeleteParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    name: nonEmptyString,
    ...workflowScopeParam,
  })
  .strict();
export type V4WorkflowsDeleteParams = z.infer<typeof v4WorkflowsDeleteParamsSchema>;
export const v4WorkflowsDeleteResultSchema = z.union([
  z.object({ ok: z.literal(true), path: nonEmptyString }).strict(),
  v4SavedWorkflowFailureSchema,
]);
export type V4WorkflowsDeleteResult = z.infer<typeof v4WorkflowsDeleteResultSchema>;

// ── v4/workflows/runs ──
export const V4_WORKFLOWS_RUNS_MAX_LIMIT = 50;
export const v4WorkflowsRunsParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    /** 只要这个名字的 run（`dwf_run.name` 字面等值）；缺省即本项目全部 run。 */
    name: nonEmptyString.optional(),
    limit: z.number().int().min(1).max(V4_WORKFLOWS_RUNS_MAX_LIMIT),
    // 缺省 `project`：只查 `dwf_run.cwd === workspacePath` 的 run。`global` 时**不**按 cwd 过滤，
    // 跨所有项目取该名字的运行历史（全局工作流在任何项目里跑，历史因此跨 cwd）；结果行带 `cwd`
    // 供 GUI 标项目。`workspace` 语义同 list（全局档只当载体）。
    ...workflowScopeParam,
  })
  .strict();
export type V4WorkflowsRunsParams = z.infer<typeof v4WorkflowsRunsParamsSchema>;
// 三终态词汇：errored = 脚本之错，stopped = 被停下（可恢复）。
export const v4SavedWorkflowRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "errored",
  "stopped",
]);
export type V4SavedWorkflowRunStatus = z.infer<typeof v4SavedWorkflowRunStatusSchema>;
export const v4SavedWorkflowRunStopReasonSchema = z.enum([
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
]);
export type V4SavedWorkflowRunStopReason = z.infer<typeof v4SavedWorkflowRunStopReasonSchema>;
export const v4SavedWorkflowRunSchema = z
  .object({
    runId: nonEmptyString,
    name: z.string().optional(),
    status: v4SavedWorkflowRunStatusSchema,
    // `status === "stopped"` 才在场。
    stopReason: v4SavedWorkflowRunStopReasonSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    spentTokens: z.number(),
    /** 发起它的会话与 CreateWorkflow 工具调用：有这两个才能从中枢打开实例详情。老行可缺。 */
    parentSessionId: z.string().optional(),
    toolCallId: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    // 实际运行的项目目录（`dwf_run.cwd`）。全局档的 runs 跨 cwd 查询，GUI 用它给
    // 每行标项目；项目档变体里它恒等于 workspacePath，GUI 可忽略。老行可缺。
    cwd: z.string().optional(),
    // 这次运行发布的**用户面产物**：中枢的运行历史行在状态词之后画一串 kind chips。
    // ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是脚本的顶层返回值。
    // 只带 chip 画得下的字段（≤ 8 件，取最新版的元数据）；字节与条目经 v4 查询按需读。
    artifacts: z
      .array(
        z
          .object({
            id: nonEmptyString,
            kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
            title: z.string().optional(),
            version: z.number(),
            contentType: z.string().optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();
export type V4SavedWorkflowRun = z.infer<typeof v4SavedWorkflowRunSchema>;
export const v4WorkflowsRunsResultSchema = z
  .object({
    runs: z.array(v4SavedWorkflowRunSchema),
    /** 为真时才在场：还有更多 run 没进这一页（多取一条判定，不是 length === limit）。 */
    truncated: z.literal(true).optional(),
  })
  .strict();
export type V4WorkflowsRunsResult = z.infer<typeof v4WorkflowsRunsResultSchema>;

// ── v4/workflows/move ──
// 把本机全局根的同名文件搬到 `workspace` 项目根。**只此一向**：项目→全局不是搬文件而是模型的
// 概括（「提升为全局」在该项目开新会话、经 SaveWorkflow 另存），所以没有 `to` 参数。
// 逐字节搬，不改内容（frontmatter 不存 scope）；不覆盖——目标已存在即拒绝（覆盖是 SaveWorkflow
// 经确认窗才有的动作）。`workspace` 既是载体运行时也是目标项目。
export const v4WorkflowsMoveParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    name: nonEmptyString,
  })
  .strict();
export type V4WorkflowsMoveParams = z.infer<typeof v4WorkflowsMoveParamsSchema>;
export const v4WorkflowsMoveResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      /** 源落点路径（全局根，搬走前）。 */
      from: nonEmptyString,
      /** 目标落点路径（项目根，搬到处）。 */
      to: nonEmptyString,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      // target_exists：目标档已有同名（move 不覆盖）；not_found：源档没有这个名字；
      // read_error / write_error：搬运时的 I/O 失败；invalid_name：名字先验没过。
      reason: z.enum(["invalid_name", "not_found", "target_exists", "read_error", "write_error"]),
      path: z.string().optional(),
      detail: z.string().optional(),
    })
    .strict(),
]);
export type V4WorkflowsMoveResult = z.infer<typeof v4WorkflowsMoveResultSchema>;
