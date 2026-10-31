// inbound 交互 / 权限裁决 wire 类型。M4 从 acode-protocol-legacy-types.ts 中立迁移。

import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const acodePermissionDecisionSchema = z.enum(["allow", "deny", "escalate", "modify"]);

export const acodePermissionRuleBehaviorSchema = z.enum(["allow", "deny", "ask"]);

export const acodePermissionRuleValueSchema = z
  .object({
    toolName: nonEmptyString,
    ruleContent: z.string().optional(),
  })
  .strict();

export const acodePermissionUpdateSchema = z
  .object({
    type: z.literal("addRules"),
    behavior: acodePermissionRuleBehaviorSchema,
    rules: z.array(acodePermissionRuleValueSchema).min(1),
    // TTL 持久授权（apps/acode-cli/specs/mcp-lifecycle-ttl-approval.md R4）：带
    // expiresAt（ISO 8601）的 allow 更新进 TTL 存储、到期回落 ask；不带维持既有
    // 语义（会话级 sessionRules 或项目持久 ruleset）。可选字段是向后扩展——旧客户端
    // 不发送它，strict 校验照常通过；期限的语义校验（可解析/夹紧/过期丢弃）由 CLI 侧
    // TtlApprovalStore fail-closed 收口，wire 层只保证非空字符串。
    expiresAt: nonEmptyString.optional(),
  })
  .strict();

export const acodePermissionResponseSchema = z
  .object({
    decision: acodePermissionDecisionSchema,
    reason: z.string().optional(),
    modifiedInput: z.unknown().optional(),
    permissionUpdates: z.array(acodePermissionUpdateSchema).optional(),
  })
  .strict();

export const acodePermissionOptionSchema = z
  .object({
    optionId: nonEmptyString,
    kind: nonEmptyString,
    name: nonEmptyString,
    description: z.string().optional(),
    response: acodePermissionResponseSchema,
  })
  .strict();

export const OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME = "acode:permission-capability:official_cua";

export const WORKFLOW_REFINE_PERMISSION_OPTION_ID = "workflowRefine";

export type ACodePermissionResponse = z.infer<typeof acodePermissionResponseSchema>;

export const acodeInteractionOriginAncestorSchema = z
  .object({
    agentId: nonEmptyString,
    agentType: nonEmptyString,
    sessionId: nonEmptyString,
    parentSessionId: nonEmptyString,
    description: z.string().optional(),
    parentToolCallId: nonEmptyString.optional(),
    parentTurnId: nonEmptyString.optional(),
  })
  .strict();

export type ACodeInteractionOriginAncestor = z.infer<typeof acodeInteractionOriginAncestorSchema>;

export const acodeInteractionRequestOriginSchema = z
  .object({
    kind: z.literal("subagent"),
    agentId: nonEmptyString,
    agentType: nonEmptyString,
    childSessionId: nonEmptyString,
    childTurnId: nonEmptyString.optional(),
    description: z.string().optional(),
    parentSessionId: nonEmptyString,
    parentToolCallId: nonEmptyString.optional(),
    parentTurnId: nonEmptyString.optional(),
    // depth≥2：祖先链内→外 + 客户端可见根会话；depth 1 两字段缺席（历史载荷原样通过）。
    ancestors: z.array(acodeInteractionOriginAncestorSchema).optional(),
    rootSessionId: nonEmptyString.optional(),
  })
  .strict();

export type ACodeInteractionRequestOrigin = z.infer<typeof acodeInteractionRequestOriginSchema>;
