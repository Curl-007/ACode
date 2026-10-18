// ============================================================
// LSP 域日志
// ============================================================
// core 包无既有 logger 设施（现有先例 mcp/call-audit.ts 用带前缀的 console.warn），
// 且 core 未依赖 @acode/services（package.json 属共享桶，本波不改动）。
// 这里按 AGENTS.md 的日志分级纪律做最小 scoped 实现：
//   debug = 高频诊断（协议原始帧、流式 chunk），生产不输出；
//   warn  = 可恢复异常；error = 不可恢复错误。
// 待共享桶允许加 @acode/services 依赖后，可整体替换为 createServiceLogger("core:lsp")。

const SCOPE = "[core:lsp]";
const DEBUG_ENABLED = process.env.ACODE_LSP_DEBUG === "1";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export const logger = {
  debug(message: string, fields?: Record<string, unknown>): void {
    if (!DEBUG_ENABLED) return;
    console.warn(`${SCOPE} ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    console.warn(`${SCOPE} ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
  },
  error(message: string, fields?: Record<string, unknown>): void {
    console.error(`${SCOPE} ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
  },
  formatError,
};
