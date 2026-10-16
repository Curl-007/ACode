// 权限规则 where 三态：规则「住在哪」的只读申报（persistent / session / readonly）。
// spec: apps/acode-cli/specs/protocol-attachment-typed-errors.md R6（含证据出处）。
// 「Informational for hosts; never changes rules」——where 是 host 展示/编辑入口分流的参考
// 事实，永不参与权限裁决。权威规则存储在 core/src/permission（P1 面），消费接线见 spec W5。
import { z } from "zod";

export const permissionRuleWhereSchema = z.enum(["persistent", "session", "readonly"]);
export type PermissionRuleWhere = z.infer<typeof permissionRuleWhereSchema>;

/**
 * 规则存储类别（协议侧词表，对齐 ACode 存储事实源）：projectRuleset = 项目持久 ruleset；
 * sessionRules = 会话内存规则（含 TTL 授权，到期回落）；policyFloor / managedPolicy /
 * breaker = 托管策略地板、进程级 floor、bypass-immune breakers（host 不可编辑集）。
 */
export const permissionRuleStorageKindSchema = z.enum([
  "projectRuleset",
  "sessionRules",
  "policyFloor",
  "managedPolicy",
  "breaker",
]);
export type PermissionRuleStorageKind = z.infer<typeof permissionRuleStorageKindSchema>;

export const PERMISSION_RULE_WHERE_BY_STORAGE: Readonly<
  Record<PermissionRuleStorageKind, PermissionRuleWhere>
> = Object.freeze({
  projectRuleset: "persistent",
  sessionRules: "session",
  policyFloor: "readonly",
  managedPolicy: "readonly",
  breaker: "readonly",
});

export function resolvePermissionRuleWhere(
  storage: PermissionRuleStorageKind,
): PermissionRuleWhere {
  return PERMISSION_RULE_WHERE_BY_STORAGE[storage];
}

/** behavior 闭集对齐 contracts PermissionRuleBehavior（"allow" | "deny" | "ask"）。 */
export const permissionRuleBehaviorSchema = z.enum(["allow", "deny", "ask"]);

/** 规则回显（host 只读面）：rule 按存储原文 VERBATIM（转义是显示层责任）；notInEffect 行必须 readonly。 */
export const permissionRuleWhereInfoSchema = z
  .object({
    rule: z.string(),
    behavior: permissionRuleBehaviorSchema,
    where: permissionRuleWhereSchema,
    notInEffect: z.boolean().optional(),
  })
  .strict()
  .superRefine((info, context) => {
    if (info.notInEffect === true && info.where !== "readonly") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["where"],
        message: "notInEffect rules are always readonly",
      });
    }
  });
export type PermissionRuleWhereInfo = z.infer<typeof permissionRuleWhereInfoSchema>;
