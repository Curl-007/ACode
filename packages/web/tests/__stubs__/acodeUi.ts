// @acode/ui 的最小 Button 桩，仅供 WebDisconnectOverlay 测试经 registerHooks 短接使用。
// overlay 只依赖 Button 的 DOM 契约（渲染成 <button>，透传 type/onClick/children/size），
// 不需要 @acode/ui 的真实图（资产/store/provider 很重，且与断线态契约无关）。
import { createElement } from "react";

export function Button({
  type,
  onClick,
  children,
  className,
  size,
}: {
  type?: string;
  onClick?: () => void;
  children?: unknown;
  className?: string;
  size?: string;
}) {
  return createElement("button", { type, onClick, className, "data-size": size }, children as never);
}
