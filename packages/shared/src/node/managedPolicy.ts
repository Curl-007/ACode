// Managed Policy 文件加载（安全加固 P2；单一来源，spec 见
// packages/services/specs/bot-permission-local-approval.md R3 与
// apps/acode-cli/specs/managed-policy-floor-and-bypass-immune-breakers.md R1）。
//
// 读取 OS 托管路径下管理员部署的策略文件——普通用户与项目配置都不可达的位置，
// 因此它是唯一「只能收紧、不能放宽」的配置层（strictest-wins 地板）。
//
// 本模块是 canonical 实现：CLI adapters 与 host services 都从这里读取，避免两份
// schema 漂移（管理员部署一个新键时，任何一份 strict schema 不认识它就会把整份策略
// 降级 fail-closed，丢掉 deny 规则）。本模块**只如实报告**解析结果（missing/invalid/
// empty/ok + policy），不做 fail-closed 决策——CLI 侧把 invalid 映射成 MINIMAL_LOCKDOWN，
// host 侧把 invalid 映射成「bot 权限需本机确认」，各自的克制形态由消费方决定（R3.4）。
//
// 同步 IO：策略文件是单个小 JSON，且 CLI createConfig 整条管线是同步的（配置在进程
// 启动期一次性定型）；host 侧权限事件天然低频，同步读不构成 IO 热点。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const ACODE_MANAGED_POLICY_FILE_ENV = "ACODE_MANAGED_POLICY_FILE";

const managedPolicyRuleSchema = z
  .object({
    toolName: z.string().trim().min(1),
    ruleContent: z.string().trim().min(1).optional(),
  })
  .strict();

/**
 * strict() 是「只能收紧」的第一道闸：`permissions.allow`、顶层未知键都会解析失败。
 * 策略文件里出现放宽意图时宁可整份拒绝并上报，也不能静默丢弃后让管理员以为生效了。
 *
 * `requireLocalPermissionApproval` 是可选收紧键：CLI 权限判定接受但忽略它（不进 floor），
 * 语义由 host botsService 消费（bot 任务权限只能在桌面本机确认）。必须让 strict schema
 * 认识它，否则管理员一部署该键，CLI 就会因未知键把整份策略降级、丢掉 deny 规则。
 */
const managedPolicyFileSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    permissions: z
      .object({
        deny: z.array(managedPolicyRuleSchema).optional(),
        ask: z.array(managedPolicyRuleSchema).optional(),
        disallowedTools: z.array(z.string().trim().min(1)).optional(),
        disableBypassPermissionsMode: z.boolean().optional(),
        requireLocalPermissionApproval: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export interface ManagedPolicyFileOptions {
  /** 测试/开发覆盖；打包态忽略（见 resolveManagedPolicyFilePath）。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** app.isPackaged 语义：打包版只信 OS 托管路径，不吃 env 注入（与 P1-7 更新源门禁同一哲学）。 */
  readonly isPackaged?: boolean;
  readonly platform?: NodeJS.Platform;
}

export interface ManagedPolicyRule {
  readonly toolName: string;
  readonly ruleContent?: string;
}

/** 解析成功且有内容时的策略数据（wire 形态，全部只读收紧字段）。 */
export interface ManagedPolicyFileData {
  readonly deny: readonly ManagedPolicyRule[];
  readonly ask: readonly ManagedPolicyRule[];
  readonly disallowedTools: readonly string[];
  readonly disableBypassPermissionsMode: boolean;
  /** host 消费：bot 任务权限是否强制只能桌面本机确认。CLI 忽略。 */
  readonly requireLocalPermissionApproval: boolean;
}

/**
 * - `missing`：文件不存在（ENOENT）——零行为变化。
 * - `invalid`：读失败/JSON 解析失败/schema 拒绝——消费方各自 fail-closed。
 * - `empty`：schema 合法但无任何收紧内容——等同未部署。
 * - `ok`：schema 合法且有收紧内容，`policy` 有值。
 */
export type ManagedPolicyFileStatus = "missing" | "invalid" | "empty" | "ok";

export type ManagedPolicyInvalidKind = "unreadable" | "json" | "schema";

export interface ManagedPolicyFileLoadResult {
  readonly status: ManagedPolicyFileStatus;
  readonly filePath: string;
  /** 仅 `status === "ok"` 时有值。 */
  readonly policy?: ManagedPolicyFileData;
  /** 仅 `status === "invalid"` 时有值：失败类别，供消费方构造各自的诊断文案。 */
  readonly invalidKind?: ManagedPolicyInvalidKind;
  /** 仅 `status === "invalid"` 时有值：错误摘要或 schema issues（不回显文件内容）。 */
  readonly invalidReason?: string;
}

export function resolveManagedPolicyFilePath(
  options: ManagedPolicyFileOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // 打包态忽略 env 覆盖：否则用户级环境变量就能把策略地板指向一个空文件，
  // 等于给了「本机管理员策略」一个用户态旁路。
  const override = options.isPackaged ? undefined : env[ACODE_MANAGED_POLICY_FILE_ENV]?.trim();
  if (override) return override;
  if (platform === "win32") {
    return join(env.ProgramData?.trim() || "C:\\ProgramData", "ACode", "managed-settings.json");
  }
  if (platform === "darwin") {
    return "/Library/Application Support/ACode/managed-settings.json";
  }
  return "/etc/acode/managed-settings.json";
}

export function loadManagedPolicyFile(
  options: ManagedPolicyFileOptions = {},
): ManagedPolicyFileLoadResult {
  const filePath = resolveManagedPolicyFilePath(options);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return { status: "missing", filePath };
    }
    // 读失败（权限/IO）与解析失败同等待遇：管理员部署过策略文件，就不能静默当无策略。
    return { status: "invalid", filePath, invalidKind: "unreadable", invalidReason: describe(error) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { status: "invalid", filePath, invalidKind: "json", invalidReason: describe(error) };
  }

  const result = managedPolicyFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return { status: "invalid", filePath, invalidKind: "schema", invalidReason: issues };
  }

  const permissions = result.data.permissions;
  const hasContent =
    (permissions.deny?.length ?? 0) > 0 ||
    (permissions.ask?.length ?? 0) > 0 ||
    (permissions.disallowedTools?.length ?? 0) > 0 ||
    permissions.disableBypassPermissionsMode === true ||
    permissions.requireLocalPermissionApproval === true;
  if (!hasContent) {
    // 空策略文件等同未部署：不给消费方增加无意义的策略源。
    return { status: "empty", filePath };
  }

  return {
    status: "ok",
    filePath,
    policy: Object.freeze({
      deny: Object.freeze((permissions.deny ?? []).map(freezeRule)),
      ask: Object.freeze((permissions.ask ?? []).map(freezeRule)),
      disallowedTools: Object.freeze([...(permissions.disallowedTools ?? [])]),
      disableBypassPermissionsMode: permissions.disableBypassPermissionsMode === true,
      requireLocalPermissionApproval: permissions.requireLocalPermissionApproval === true,
    }),
  };
}

function freezeRule(rule: { toolName: string; ruleContent?: string }): ManagedPolicyRule {
  return Object.freeze({
    toolName: rule.toolName,
    ...(rule.ruleContent === undefined ? {} : { ruleContent: rule.ruleContent }),
  });
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
