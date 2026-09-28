// Managed Policy Floor 加载器（安全加固 P2）。
//
// 读取 OS 托管路径下管理员部署的策略文件——普通用户与项目配置都不可达的位置，
// 因此它是唯一「只能收紧、不能放宽」的配置层（strictest-wins 地板）。
// 规格见 apps/acode-cli/specs/managed-policy-floor-and-bypass-immune-breakers.md R1。
//
// 同步 IO：与同目录 loadFileConfig 一致，createConfig 整条管线是同步的
// （配置在进程启动期一次性定型，无异步消费者）；策略文件是单个小 JSON，不构成 IO 热点。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ManagedPolicyFloorData } from "@acode/contracts";
import type { ConfigDiagnostic } from "./schema.js";

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
      })
      .strict(),
  })
  .strict();

export interface LoadManagedPolicyFloorOptions {
  /** 测试/开发覆盖；打包态忽略（见 resolveManagedPolicyFilePath）。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** app.isPackaged 语义：打包版只信 OS 托管路径，不吃 env 注入（与 P1-7 更新源门禁同一哲学）。 */
  readonly isPackaged?: boolean;
  readonly platform?: NodeJS.Platform;
}

export interface ManagedPolicyFloorLoadResult {
  readonly floor: ManagedPolicyFloorData | undefined;
  readonly diagnostics: readonly ConfigDiagnostic[];
  readonly filePath: string;
}

/** 无策略文件时的「空地板」：不附加任何规则，但保留结构以便合并层统一处理。 */
const EMPTY_FLOOR: ManagedPolicyFloorData = Object.freeze({
  deny: Object.freeze([]),
  ask: Object.freeze([]),
  disallowedTools: Object.freeze([]),
  disableBypassPermissionsMode: false,
});

/** 解析失败时的最小封锁：不禁用一切，但收回 yolo/bypass 直通（fail-closed 的克制形态）。 */
const MINIMAL_LOCKDOWN_FLOOR: ManagedPolicyFloorData = Object.freeze({
  deny: Object.freeze([]),
  ask: Object.freeze([]),
  disallowedTools: Object.freeze([]),
  disableBypassPermissionsMode: true,
});

export function resolveManagedPolicyFilePath(
  options: LoadManagedPolicyFloorOptions = {},
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

export function loadManagedPolicyFloor(
  options: LoadManagedPolicyFloorOptions = {},
): ManagedPolicyFloorLoadResult {
  const filePath = resolveManagedPolicyFilePath(options);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return { floor: undefined, diagnostics: [], filePath };
    }
    // 读失败（权限/IO）与解析失败同等待遇：管理员部署过策略文件，就不能静默当无策略。
    return {
      floor: MINIMAL_LOCKDOWN_FLOOR,
      diagnostics: [
        {
          code: "config_managed_policy_invalid",
          filePath,
          message: `Managed policy file is unreadable; bypass mode disabled: ${describe(error)}`,
          severity: "error",
        },
      ],
      filePath,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      floor: MINIMAL_LOCKDOWN_FLOOR,
      diagnostics: [invalidPolicyDiagnostic(filePath, `JSON parse failed: ${describe(error)}`)],
      filePath,
    };
  }

  const result = managedPolicyFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return {
      floor: MINIMAL_LOCKDOWN_FLOOR,
      diagnostics: [invalidPolicyDiagnostic(filePath, issues)],
      filePath,
    };
  }

  const permissions = result.data.permissions;
  const hasContent =
    (permissions.deny?.length ?? 0) > 0 ||
    (permissions.ask?.length ?? 0) > 0 ||
    (permissions.disallowedTools?.length ?? 0) > 0 ||
    permissions.disableBypassPermissionsMode === true;
  if (!hasContent) {
    // 空策略文件等同未部署：不给合并层增加无意义的 Policy 源。
    return { floor: undefined, diagnostics: [], filePath };
  }

  return {
    floor: Object.freeze({
      ...EMPTY_FLOOR,
      ...(permissions.deny ? { deny: Object.freeze(permissions.deny.map(freezeRule)) } : {}),
      ...(permissions.ask ? { ask: Object.freeze(permissions.ask.map(freezeRule)) } : {}),
      ...(permissions.disallowedTools
        ? { disallowedTools: Object.freeze([...permissions.disallowedTools]) }
        : {}),
      ...(permissions.disableBypassPermissionsMode === true
        ? { disableBypassPermissionsMode: true }
        : {}),
    }),
    diagnostics: [],
    filePath,
  };
}

function freezeRule(rule: { toolName: string; ruleContent?: string }) {
  return Object.freeze({
    toolName: rule.toolName,
    ...(rule.ruleContent === undefined ? {} : { ruleContent: rule.ruleContent }),
  });
}

function invalidPolicyDiagnostic(filePath: string, detail: string): ConfigDiagnostic {
  return {
    code: "config_managed_policy_invalid",
    filePath,
    // 诊断消息只含 schema 问题摘要，不回显文件内容——策略文件可能含内部工具名。
    message: `Managed policy file is invalid; bypass mode disabled. ${detail}`,
    severity: "error",
  };
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
