// ============================================================
// LSP 诊断回流闭环公共入口（specs/lsp-diagnostics-loop.md）
// ============================================================
// 对 core 内部（tool handlers）暴露的最小门面；工具注册经
// tool/handlers/lsp.ts 的 lspToolEntry。运行时级 drain 接线（共享桶申请，
// 见报告）落地后，runtime 从这里 import DeferredDiagnosticsQueue 消费面。

export { lspToolEntry, resolveLspPermissionCapability } from "../tool/handlers/lsp.js";
export {
  runPostWriteDiagnostics,
  stashPendingModelContent,
  consumePendingModelContent,
  consumeDeferredDiagnostics,
  resetEditDiagnosticsState,
} from "./edit-diagnostics-hook.js";
export {
  DeferredDiagnosticsQueue,
  formatDeferredDiagnosticsReminder,
  getDeferredDiagnosticsOwner,
} from "./deferred-diagnostics.js";
export { DiagnosticsLedger, diagnosticIdentity } from "./diagnostics-ledger.js";
export { runInProcessTsDiagnostics, isTsDiagnosticTarget } from "./ts-diagnostics.js";
export { LSP_READONLY_ACTIONS } from "./servers.js";
export { shutdownAll } from "./client-shutdown.js";
export type { FileDiagnosticsResult, FileFormatResult, DeferredDiagnosticsEntry } from "./types.js";
