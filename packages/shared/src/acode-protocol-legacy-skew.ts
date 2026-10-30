// M3 遗留偏斜面（spec apps/acode-cli/specs/m3-legacy-server-removal.md §7-E / 遗留①）：
// 偏斜期 legacy 回落方法词 + 仍存活的 legacy 通知词的 wire 字面量登记。
//
// 背景：CLI→host 的 v4 反向请求走 dual-form（v4 优先，-32601 回落 legacy）。回落分支是
// 「新 CLI + 旧 host」兼容面，与 host 侧 17 条 inbound legacy 字面量分支同属独立偏斜面，
// 待与发布形态一并单独裁决。本批（M4）仅把这些词从已删除的 legacy barrel 迁出，不改逻辑。
//
// 绝不为本面扩新能力：新增 wire 词一律进 v4，不进本模块。

/** 偏斜期 legacy 回落方法词（dual-form 的 legacy 备选形态）。 */
export const LEGACY_SKEW_FALLBACK_METHODS = {
  automationList: "automation/list",
  automationCreate: "automation/create",
  automationUpdate: "automation/update",
  automationDelete: "automation/delete",
  offPeakList: "offPeak/list",
  offPeakCreate: "offPeak/create",
  interactionRequestPermission: "interaction/requestPermission",
  interactionRequestUserInput: "interaction/requestUserInput",
  interactionRequestProviderRuntimeHeaders: "interaction/requestProviderRuntimeHeaders",
  interactionRequestOfficialMcpAuthHeaders: "interaction/requestOfficialMcpAuthHeaders",
  interactionBrowserList: "interaction/browserList",
  interactionBrowserExecute: "interaction/browserExecute",
  computerUseOperationEvent: "computer-use/operation-event",
} as const;
export type LegacySkewFallbackMethod =
  (typeof LEGACY_SKEW_FALLBACK_METHODS)[keyof typeof LEGACY_SKEW_FALLBACK_METHODS];

/** 仍存活的 legacy 通知词（CLI→host 单向通知，无 v4 对应面）。 */
export const LEGACY_NOTIFICATIONS = {
  storageStartup: "startup/storageState",
  providerRuntimeHeadersCancelled: "interaction/providerRuntimeHeadersCancelled",
  mcpTelemetry: "process/mcpTelemetry",
  mcpResourceSamples: "process/mcpResourceSamples",
  toolExecResource: "process/toolExecResource",
  pluginOperationProgress: "plugins/operationProgress",
  processResourceSample: "process/resourceSample",
  runtimeIdleExit: "runtime/idleExit",
} as const;
export type LegacyNotification =
  (typeof LEGACY_NOTIFICATIONS)[keyof typeof LEGACY_NOTIFICATIONS];
