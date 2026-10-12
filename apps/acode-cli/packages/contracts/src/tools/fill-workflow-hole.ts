// ============================================================
// FillWorkflowHole Tool - 向停驻中的 workflow 洞提交该处函数体的语句
// ============================================================
// 见端口 `DynamicWorkflowRunPort.fillHole`
// （interfaces/dynamic-workflow-run.port.ts）与 apps/acode-cli/specs/workflow-holes.md。
//
// 挖洞-填充的主代理侧：run 停在 `hole<T>(stage, prompt)` 上等待，本工具把 fill 的**语句**
// splice 进 run 草稿（`await (async () => { <语句> })()`）、重编译、重开确认窗，然后沿
// amend/supersede 链续跑。fill 与脚本的二选一同 CreateWorkflow：`script`（内联语句）或
// `path`（fill 文件），XOR 在工具层 validateInput 强制（照 create-workflow 先例），schema
// 层两者都可缺省是为了让「两个都不给」也能进 handler 拿到结构化拒绝而不是 400。
//
// 输出只有成功形：失败走 ToolHandlerFailure（core 侧）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const FILL_WORKFLOW_HOLE_TOOL_NAME = "FillWorkflowHole";

export const FillWorkflowHoleInputSchema = z
  .object({
    // snake_case 照 GetWorkflowRun 的 run_id / ResumeWorkflowRun 的 run_id：同一族的不透明
    // 标识键。停在洞上的那条 run，不是 splice 后的新 run。
    run_id: z
      .string()
      .min(1)
      .describe("The workflow run ID that is parked at the hole (from the notification or GetWorkflowRun)"),
    // hole_ref 是复合身份：站点 id（hole#N）+ 首达 ordinal，形如 `hole#1@1`。判定权威在
    // 服务端（hole_not_waiting），describe 只引导去哪里取。
    hole_ref: z
      .string()
      .min(1)
      .max(80)
      .describe(
        "The hole's ID, shaped `hole#N@ordinal` — from the hole notification or GetWorkflowRun's pending holes",
      ),
    // fill 语句：该洞函数体的**语句**（不是表达式、不是整份脚本）。允许再留 hole()（嵌套
    // 生长）；返回值的类型是洞调用上写的 T。与 `path` 二选一（XOR 在工具层 validateInput
    // 强制；两者都可缺省是为了让「两个都不给」也能进 handler 拿到结构化拒绝）。
    script: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The statements of the hole's body, inline. They are spliced in as `await (async () => { <statements> })()`, so top-level await is legal and a `return` yields the hole's type T",
      ),
    // 被拒后再提的主路：fill 文件已落盘（拒绝响应里带路径），Edit 后以 path 重提。
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Path to a file holding the statements of the hole's body (edit and resubmit after a rejection)"),
    // —— 以下两个键由工具的 resolveInput 归一化后写入（AmendWorkflow 的 predecessor 同款
    // 先例）：`fill` 是落定的 fill 语句原文（`path` 已读成文本），`spliced_script` 是 splice +
    // 分析干净的产物脚本（确认窗重算读的就是它）。模型入参里的同名字段一律被覆盖、无效。
    fill: z.string().min(1).optional().describe("Resolved by the tool: the fill statements (do not set)"),
    spliced_script: z
      .string()
      .min(1)
      .optional()
      .describe("Resolved by the tool: the spliced script that will run (do not set)"),
  })
  .strict();

export type FillWorkflowHoleInput = z.infer<typeof FillWorkflowHoleInputSchema>;

export const FillWorkflowHoleInputJsonSchema = toToolJsonSchema(FillWorkflowHoleInputSchema);

/**
 * 成功输出：fill 已 splice、旧 run 已被 supersede、新 run 在后台飞行。
 *
 * - `backgroundTaskId ≡ runId`（新 run 的 id；与 CreateWorkflow/ResumeWorkflowRun 的
 *   backgrounded 输出同一恒等式），取消、TaskOutput、终态通知共用这一个键。
 * - `cacheImported`：前驱的已完成工作是否作为缓存导入新 run。false 时
 *   `cacheImportedReason` 说明原因（如前驱的世界在结果落定后已被改写，缓存不再可信、
 *   相关步骤重跑）——这是安全优先的可接受代价，如实告知（specs/workflow-holes.md 的
 *   最大风险条目）。
 * - `fillPath`：落盘的 fill 文件（诊断、重提与审计的把手）。
 */
export const FillWorkflowHoleOutputSchema = z
  .object({
    ok: z.literal(true),
    runId: z.string().min(1),
    response: z.string(),
    status: z.literal("backgrounded"),
    backgroundTaskId: z.string().min(1),
    fillPath: z.string().min(1).optional(),
    cacheImported: z.boolean(),
    cacheImportedReason: z.string().min(1).optional(),
  })
  .strict();

export type FillWorkflowHoleOutput = z.infer<typeof FillWorkflowHoleOutputSchema>;

export const FillWorkflowHoleOutputJsonSchema = toToolJsonSchema(FillWorkflowHoleOutputSchema);
