import { z } from "zod";
import { acodeWorkspaceRefSchema } from "../acode-session-types.js";
import { modelSelectionSchema } from "../model-selection.js";
import { accountProviderUnavailableReasonSchema } from "../account-provider-state.js";

// provider + process 域的 v4 零件（M2-8，specs/m2-8-workspace-provider-process.md）：
// updateAccountConfig（Account Provider Config 快照热同步，revision 回执校验）+
// testModelConnectivity（连通性测试，先刷新 Registry 再测）+ childProcesses（MCP 子进程
// 注册表内存态的观测面暴露）。
//
// 形状纪律：与 legacy barrel 对应段**逐字 parity**（同字段、同 strict、同值域），消费者语义
// 零变化；不反向 import legacy barrel（protocol-boundary 纪律），两侧形状由
// packages/shared/tests/protocol-boundary.test.mjs 钉住。modelSelectionSchema 与
// accountProviderUnavailableReasonSchema 取自中立叶（legacy barrel 同源 import）。

const nonEmptyString = z.string().trim().min(1);

// ── v4/provider/updateAccountConfig ──
export const v4ProviderUpdateAccountConfigParamsSchema = z
  .object({
    revision: nonEmptyString,
    basedOnACodeBuiltinRevision: nonEmptyString,
    // Provider Config 的字段校验由 @acode/provider 负责；协议层只约束可传输信封。
    providers: z.record(z.string(), z.unknown()),
    // 账号状态与 Overlay 必须一起传递，否则 Worker 会丢失非当前套餐的执行门禁。
    states: z.record(
      z.string(),
      z
        .object({
          availability: z.enum(["available", "pending", "unavailable", "unknown"]),
          entitled: z.boolean(),
          unavailableReason: accountProviderUnavailableReasonSchema.optional(),
          current: z.boolean().optional(),
          connectionKey: z.string().optional(),
          effectiveAt: z.number().finite().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type V4ProviderUpdateAccountConfigParams = z.infer<
  typeof v4ProviderUpdateAccountConfigParamsSchema
>;
export const v4ProviderUpdateAccountConfigResultSchema = z
  .object({
    // 收到账号结果不代表配套 Built-in 已到达；应用版本只能读取 Registry 快照。
    receivedRevision: nonEmptyString,
    providerCount: z.number().int().nonnegative(),
    status: z.enum(["received", "unchanged"]),
  })
  .strict();
export type V4ProviderUpdateAccountConfigResult = z.infer<
  typeof v4ProviderUpdateAccountConfigResultSchema
>;

// ── v4/provider/testModelConnectivity ──
export const v4ProviderTestModelConnectivityParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    selection: modelSelectionSchema,
  })
  .strict();
export type V4ProviderTestModelConnectivityParams = z.infer<
  typeof v4ProviderTestModelConnectivityParamsSchema
>;
export const v4ProviderTestModelConnectivityResultSchema = z
  .object({ success: z.literal(true) })
  .strict();
export type V4ProviderTestModelConnectivityResult = z.infer<
  typeof v4ProviderTestModelConnectivityResultSchema
>;

// ── v4/process/childProcesses ──
export const v4ProcessChildProcessesParamsSchema = z.object({}).strict();
export type V4ProcessChildProcessesParams = z.infer<typeof v4ProcessChildProcessesParamsSchema>;
export const v4ProcessChildProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    serverName: nonEmptyString,
    mcpSource: z.enum(["builtin", "plugin", "custom"]),
    /** 官方/第三方插件的插件名（`plugin:<name>:<key>` 的 name，或官方 host MCP 对应插件）；custom 无 */
    pluginName: nonEmptyString.optional(),
  })
  .strict();
export type V4ProcessChildProcess = z.infer<typeof v4ProcessChildProcessSchema>;
export const v4ProcessChildProcessesResultSchema = z
  .object({
    processes: z.array(v4ProcessChildProcessSchema).max(10_000),
  })
  .strict();
export type V4ProcessChildProcessesResult = z.infer<typeof v4ProcessChildProcessesResultSchema>;
