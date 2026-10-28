// Managed Policy Floor —— 管理员策略地板契约（安全加固 P2）。
// 例外偿还（contracts-onboarding-max-file-lines-config-index）：自 config/index.ts
// 拆出。策略地板是独立的安全面，单独成叶；原 index.ts 降为 barrel 并对本叶
// `export *`，公开导出面逐名不变。本叶不反向 import index.ts。

import type { PermissionRuleValue } from "../interfaces/permission.port.js";

// ============================================================
// Managed Policy Floor（安全加固 P2）
// ============================================================

/**
 * 管理员经 OS 托管路径下发的策略地板（wire 形态）。**只能表达收紧**：
 * deny/ask 规则、disallowedTools 追加、禁用 yolo/bypass 直通。schema 拒绝 allow 类字段
 * （见 adapters/src/config/managed-policy.ts），防止策略文件被误用成放宽通道。
 */
export interface ManagedPolicyFloorData {
  readonly deny: readonly PermissionRuleValue[];
  readonly ask: readonly PermissionRuleValue[];
  readonly disallowedTools: readonly string[];
  readonly disableBypassPermissionsMode: boolean;
}
