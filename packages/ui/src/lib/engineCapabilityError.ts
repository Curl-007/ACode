/**
 * 「当前引擎不支持该方法」的统一判定（2026-10-24 B 批，审计 P2 收敛）。
 *
 * 外部引擎（jcode）的 shim 对未路由的 v4/legacy 方法回 JSON-RPC -32601，错误文案带稳定
 * 标记 `jcode bridge: method not supported: <method>`（dispatch.ts default 分支）。UI 面板
 * hook 此前靠子串匹配能力名（如 "ArtifactRows"/"WorkspaceNodes"）识别「能力缺失」走静默
 * 降级，认不出 jcode 的 -32601 文案 → 全落入通用 error 分支渲染裸错误串。
 *
 * 本谓词把两种形态（结构化 code=-32601 / shim 稳定标记）归一成同一判定，供面板 hook
 * OR 进既有的 capabilityMissing 分支——jcode 会话下面板静默空（与「该能力未开通」同形态），
 * 不再显示裸协议错误串。native 引擎不会产生该标记，无误判面。
 */
export function isEngineUnsupportedMethodError(error: unknown): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === -32601
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("jcode bridge: method not supported");
}
