import { z } from "zod";

/**
 * Schemas shared by the legacy protocol and protocol v4.
 *
 * Keep this module dependency-free from either protocol directory. The v4
 * command surface may consume these compatibility shapes while the legacy
 * protocol remains available, but v4 must never import the legacy barrel.
 */

const nonEmptyString = z.string().trim().min(1);

const acodeProtocolMcpEntrySchema = z
  .object({
    name: nonEmptyString,
    value: z.string(),
  })
  .strict();

const acodeProtocolMcpOAuthSchema = z.union([
  z
    .object({
      type: z.literal("client_credentials"),
      clientId: nonEmptyString,
      clientSecret: nonEmptyString,
      clientName: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("authorization_code"),
      clientId: nonEmptyString.optional(),
      clientSecret: nonEmptyString.optional(),
      clientName: nonEmptyString.optional(),
      redirectPath: nonEmptyString.optional(),
      scope: z.string().optional(),
    })
    .strict(),
]);

export const acodeProtocolMcpServerSchema = z.union([
  z
    .object({
      name: nonEmptyString,
      command: nonEmptyString,
      args: z.array(z.string()),
      env: z.array(acodeProtocolMcpEntrySchema),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      name: nonEmptyString,
      type: z.enum(["http", "sse"]),
      url: nonEmptyString,
      headers: z.array(acodeProtocolMcpEntrySchema),
      oauth: acodeProtocolMcpOAuthSchema.optional(),
      isolation: z.enum(["session", "workspace"]).optional(),
      protocolVersion: z.enum(["legacy", "auto", "2026-07-28"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type ACodeProtocolMcpServer = z.infer<typeof acodeProtocolMcpServerSchema>;

/**
 * App 在提交 prompt 前只读采集的 IAB 可见状态。该字段只用于 provider-visible
 * ambient context，不进入用户可见 transcript；内容有界，禁止携带页面正文或凭据。
 */
export const acodeBrowserAmbientContextSchema = z
  .object({
    tabCount: z.number().int().positive().max(100),
    currentUrl: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();
export type ACodeBrowserAmbientContext = z.infer<typeof acodeBrowserAmbientContextSchema>;

/**
 * 重连熔断挂起附加事实（apps/acode-cli/specs/mcp-lifecycle-ttl-approval.md R1/R2.3）。
 * CLI live status 原样透传本字段，此前 strict schema 直接拒收——熔断发生的那一刻
 * mcp/list 整条命令抛 ZodError，设置页拿不到任何状态。形态与 contracts 的
 * McpReconnectSuspension 对齐；suspendedBy 缺失按 connect_failures 理解（历史形态）。
 *
 * 定义落点（2026-10-22 review R2-02 修复）：本 schema 由提交 43afaba1（冻结日 2026-10-05
 * 之后）新增，最初误置于 legacy barrel，违反「新 schema 只进 v4；
 * legacy 面只删不增」冻结规则。按 M2-B 既定模式迁到本中立叶子——legacy barrel 改为纯
 * re-export（不再出现 `export const ...Schema` 定义），v4 若将来消费同一 wire 字段可直接
 * 从这里取，M4 删 barrel 时不形成反向依赖或被迫回迁。当前该字段只在 legacy mcp/list wire
 * 上流转（v4 无 mcp/list 契约），故不新增 v4 面；登记见 specs/legacy-protocol-freeze.md。
 */
export const acodeMcpReconnectSuspensionSchema = z
  .object({
    consecutiveFailures: z.number().int().nonnegative(),
    consecutiveInCallCrashes: z.number().int().nonnegative().optional(),
    suspendedAt: nonEmptyString,
    suspendedBy: z.enum(["connect_failures", "in_call_crashes", "crash_storm"]).optional(),
  })
  .strict();
export type ACodeMcpReconnectSuspension = z.infer<typeof acodeMcpReconnectSuspensionSchema>;
