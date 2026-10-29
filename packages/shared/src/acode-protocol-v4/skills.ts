import { z } from "zod";
import { acodeWorkspaceRefSchema } from "../acode-session-types.js";

// Composer Skill 只读引用 catalog 的 v4 面（apps/acode-cli/specs/m2-6-workflows-skills-mcp.md）。
//
// 与 Skills Settings 管理接口分离：sessionId 决定 authority，不提供启停/删除能力。
// 形状与 legacy `acodeSkillsReferenceCatalog*` 逐字 parity；不反向 import legacy barrel
// （protocol-boundary 纪律），parity 由 packages/shared/tests/protocol-boundary.test.mjs 钉住。

const nonEmptyString = z.string().trim().min(1);

// 新草稿读取 workspace 当前目录；已有 Session 读取 AgentRuntime 首次 context 初始化时冻结的
// 发现结果。该协议只承载 Composer 的只读引用投影，不替代 Settings 的 Skill 管理接口。
export const v4SkillReferenceCatalogEntrySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    description: z.string(),
    path: nonEmptyString,
    scope: z.enum(["workspace", "user", "plugin"]),
    enabled: z.literal(true),
    pluginName: nonEmptyString.optional(),
  })
  .strict();
export type V4SkillReferenceCatalogEntry = z.infer<typeof v4SkillReferenceCatalogEntrySchema>;

export const v4SkillsReferenceCatalogParamsSchema = z
  .object({
    workspace: acodeWorkspaceRefSchema,
    // 带 sessionId 时必须命中该进程内的 resident Session；未知 Session fail closed，
    // 禁止回退到 workspace 当前目录而把新 Skill 泄漏进旧对话。
    sessionId: nonEmptyString.optional(),
  })
  .strict();
export type V4SkillsReferenceCatalogParams = z.infer<typeof v4SkillsReferenceCatalogParamsSchema>;

export const v4SkillsReferenceCatalogResultSchema = z
  .object({
    authority: z.enum(["session", "workspace"]),
    skills: z.array(v4SkillReferenceCatalogEntrySchema),
  })
  .strict();
export type V4SkillsReferenceCatalogResult = z.infer<typeof v4SkillsReferenceCatalogResultSchema>;
