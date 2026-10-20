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

// ---------------------------------------------------------------------------
// 每键元数据三字段试点（T2-s5② 先行件；spec 见
// packages/shared/specs/managed-policy-key-metadata.md）。
//
// 出处：价值提取第二轮台账 R2:1211-1213——企业配置「每键元数据 schema」中的
// redact / support.scopes / predicates.warn 三字段先在现有权限地板 5 键上试点。
// 试点边界（spec R5）：只挂元数据——不新增策略键、不做 GPO 三源分层、不改消费方
// 行为；元数据是构建期静态注册表，不混入 policy wire 数据，loadManagedPolicyFile
// 全程不读它（加载行为与试点前逐字节一致）。
// ---------------------------------------------------------------------------

/**
 * 值脱敏声明（台账 redact 字段，试点取 "hash"|"keep" 两值口径）。
 * - `"hash"`：值可能含内部工具名/命令片段，日志与支持包只允许 sha256 指纹形态。
 * - `"keep"`：值本身可原样出现（布尔开关无敏感内容）。
 *
 * 声明而非执行：脱敏机制单源于 specs/log-privacy-redaction.md，本模块不做脱敏。
 */
export type ManagedPolicyRedactMode = "hash" | "keep";

/**
 * 消费面闭集（台账 support.scopes 字段的 ACode 适配）：声明键在哪些消费面生效。
 * - `"cli-permission-floor"`：CLI 权限地板（apps/acode-cli adapters managed-policy.ts）。
 * - `"host-bot-permission"`：host bot 本机确认门槛（services botPermissionLocalApproval.ts）。
 *
 * 新增消费面须先扩此闭集再改注册表（spec R2），防止 scopes 与实际读取方漂移。
 */
export type ManagedPolicyConsumerScope = "cli-permission-floor" | "host-bot-permission";

/**
 * 键名闭集 = wire 数据键。注册表用它做全覆盖映射（spec R1）：新增策略键必须
 * 同时补齐该键元数据，否则 typecheck 不过——完整性由类型门禁保证，不靠人肉记忆。
 */
export type ManagedPolicyKey = keyof ManagedPolicyFileData;

/** 单键元数据（三字段）。K 参数给 predicates.warn 提供该键的强类型入参。 */
export interface ManagedPolicyKeyMetadata<K extends ManagedPolicyKey = ManagedPolicyKey> {
  readonly redact: ManagedPolicyRedactMode;
  readonly support: { readonly scopes: readonly ManagedPolicyConsumerScope[] };
  readonly predicates: {
    /**
     * 值警告纯函数（台账 predicates.warn）：解析值落入「部署了但无任何收紧效果」
     * 时返回管理员面向警告文案，否则 undefined。警告只复述既有 hasContent 语义
     * （空数组/显式 false 等同未部署；managed 层只能收紧），不参与任何
     * 权限/floor/同意判定——是否展示由未来消费方决定（spec R2/R4）。
     */
    readonly warn?: (
      value: ManagedPolicyFileData[K],
      policy: ManagedPolicyFileData,
    ) => string | undefined;
  };
}

/** 全覆盖映射 = 每键元数据完整性的类型门禁（spec R1）。 */
export type ManagedPolicyKeyMetadataRegistry = {
  readonly [K in ManagedPolicyKey]: ManagedPolicyKeyMetadata<K>;
};

// 警告文案只复述 loadManagedPolicyFile 既有的 hasContent 判定（`length > 0` 与
// `=== true` 归一，spec R2.predicates.warn）：空数组/显式 false 等同未部署，
// managed 层只能收紧、不能放宽。英文与 CLI ConfigDiagnostic 管理员诊断语言一致
// （spec R6）；文案含键路径但不回显任何规则内容（与 R3 hash 声明同纪律）。
function warnEmptyTighteningList(keyPath: string) {
  return (value: { readonly length: number }): string | undefined =>
    value.length === 0
      ? `${keyPath} is an empty list: it contributes no tightening rules and is equivalent to the key being absent. The managed layer can only tighten; it never loosens rules configured elsewhere.`
      : undefined;
}

function warnExplicitFalse(keyPath: string) {
  return (value: boolean): string | undefined =>
    value === false
      ? `${keyPath} is explicitly false: the managed layer can only tighten, so false has no effect and is equivalent to the key being absent. Remove the key instead of setting it to false.`
      : undefined;
}

/** 每键元数据注册表（构建期冻结事实，spec R3/R4）。 */
export const MANAGED_POLICY_KEY_METADATA: ManagedPolicyKeyMetadataRegistry = Object.freeze({
  deny: Object.freeze({
    // 规则含 toolName/ruleContent，可能携带内部工具名 → hash（spec R3 注）。
    redact: "hash",
    support: Object.freeze({ scopes: Object.freeze(["cli-permission-floor"] as const) }),
    predicates: Object.freeze({ warn: warnEmptyTighteningList("permissions.deny") }),
  }),
  ask: Object.freeze({
    redact: "hash",
    support: Object.freeze({ scopes: Object.freeze(["cli-permission-floor"] as const) }),
    predicates: Object.freeze({ warn: warnEmptyTighteningList("permissions.ask") }),
  }),
  disallowedTools: Object.freeze({
    redact: "hash",
    support: Object.freeze({ scopes: Object.freeze(["cli-permission-floor"] as const) }),
    predicates: Object.freeze({ warn: warnEmptyTighteningList("permissions.disallowedTools") }),
  }),
  disableBypassPermissionsMode: Object.freeze({
    // 布尔无敏感内容 → keep；host 只读文件级 status，不消费该键值（spec R3）。
    redact: "keep",
    support: Object.freeze({ scopes: Object.freeze(["cli-permission-floor"] as const) }),
    predicates: Object.freeze({
      warn: warnExplicitFalse("permissions.disableBypassPermissionsMode"),
    }),
  }),
  requireLocalPermissionApproval: Object.freeze({
    redact: "keep",
    // CLI 接受该键但忽略（不进 floor），语义仅由 host botsService 消费——单 scope
    // 正是把这条文档化事实变成机器可读（spec R2）。
    support: Object.freeze({ scopes: Object.freeze(["host-bot-permission"] as const) }),
    predicates: Object.freeze({
      warn: warnExplicitFalse("permissions.requireLocalPermissionApproval"),
    }),
  }),
});

/**
 * 类型化访问器：防止消费方散落手写字面量键名。闭集外键返回 undefined（不抛、
 * 不回落默认值），与 missing 态同一克制形态（spec R4）；hasOwn 判定使
 * `__proto__`/`constructor` 等原型链键也落在 undefined 分支。
 */
export function getManagedPolicyKeyMetadata<K extends ManagedPolicyKey>(
  key: K,
): ManagedPolicyKeyMetadata<K> | undefined {
  return Object.hasOwn(MANAGED_POLICY_KEY_METADATA, key)
    ? MANAGED_POLICY_KEY_METADATA[key]
    : undefined;
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
