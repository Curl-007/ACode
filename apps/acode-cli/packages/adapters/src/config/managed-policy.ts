// Managed Policy Floor 加载器（安全加固 P2）——CLI 侧薄包装。
//
// canonical schema、OS 路径解析与文件读取已单一来源化到 `@acode/shared/node`
// （packages/shared/src/node/managedPolicy.ts），CLI 与 host services 共用同一份，
// 避免两份 strict schema 漂移导致管理员部署新键时整份策略被 fail-closed 丢弃。
// 本文件只负责把 shared 的中性判别结果映射成 CLI 的 floor 形态与 fail-closed 决策：
//   missing/empty → floor undefined（零行为变化）
//   invalid       → MINIMAL_LOCKDOWN_FLOOR + error 诊断（收回 yolo/bypass 直通，不 deny-all）
//   ok            → 收紧地板（requireLocalPermissionApproval 键由 host 消费，CLI 忽略、不进 floor）
// 规格见 apps/acode-cli/specs/managed-policy-floor-and-bypass-immune-breakers.md R1。
import type { ManagedPolicyFloorData } from "@acode/contracts";
import {
  ACODE_MANAGED_POLICY_FILE_ENV,
  loadManagedPolicyFile,
  resolveManagedPolicyFilePath,
  type ManagedPolicyFileLoadResult,
  type ManagedPolicyFileOptions,
} from "@acode/shared/node";
import type { ConfigDiagnostic } from "./schema.js";

export { ACODE_MANAGED_POLICY_FILE_ENV, resolveManagedPolicyFilePath };

export interface LoadManagedPolicyFloorOptions extends ManagedPolicyFileOptions {}

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

export function loadManagedPolicyFloor(
  options: LoadManagedPolicyFloorOptions = {},
): ManagedPolicyFloorLoadResult {
  const result = loadManagedPolicyFile(options);
  return mapManagedPolicyFileResult(result);
}

function mapManagedPolicyFileResult(
  result: ManagedPolicyFileLoadResult,
): ManagedPolicyFloorLoadResult {
  const { filePath } = result;
  switch (result.status) {
    case "missing":
    case "empty":
      return { floor: undefined, diagnostics: [], filePath };
    case "invalid":
      return {
        floor: MINIMAL_LOCKDOWN_FLOOR,
        diagnostics: [invalidPolicyDiagnostic(filePath, result.invalidKind, result.invalidReason)],
        filePath,
      };
    case "ok": {
      const policy = result.policy;
      if (!policy) {
        // 理论上 ok 必带 policy；防御性退回空地板，绝不因内部不一致而放宽。
        return { floor: undefined, diagnostics: [], filePath };
      }
      return {
        floor: Object.freeze({
          ...EMPTY_FLOOR,
          deny: policy.deny,
          ask: policy.ask,
          disallowedTools: policy.disallowedTools,
          ...(policy.disableBypassPermissionsMode ? { disableBypassPermissionsMode: true } : {}),
        }),
        diagnostics: [],
        filePath,
      };
    }
  }
}

function invalidPolicyDiagnostic(
  filePath: string,
  kind: ManagedPolicyFileLoadResult["invalidKind"],
  reason: string | undefined,
): ConfigDiagnostic {
  const detail = reason ?? "unknown error";
  // 诊断消息只含 schema 问题摘要，不回显文件内容——策略文件可能含内部工具名。
  const message =
    kind === "unreadable"
      ? `Managed policy file is unreadable; bypass mode disabled: ${detail}`
      : kind === "json"
        ? `Managed policy file is invalid; bypass mode disabled. JSON parse failed: ${detail}`
        : `Managed policy file is invalid; bypass mode disabled. ${detail}`;
  return {
    code: "config_managed_policy_invalid",
    filePath,
    message,
    severity: "error",
  };
}
