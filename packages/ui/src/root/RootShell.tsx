import type { ReactNode } from "react";
import { AlertDialogHost } from "@/AlertDialogHost.js";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { CuaPermissionObservationAttachment } from "@/cua-permission/CuaPermissionObservationAttachment.js";
import { EmbeddedBrowserPermissionPromptHost } from "@/browser-use/EmbeddedBrowserPermissionPromptHost.js";

export function RootShell({ children }: { children: ReactNode }) {
  // Web 远控在手机浏览器里不能用固定 100vh，
  // 地址栏收放会让底部输入区被裁到视口外；根节点改用动态视口高度。
  return (
    <div className="relative h-dvh">
      {children}
      <CuaPermissionObservationAttachment />
      <AlertDialogHost />
      <ConfirmDialogHost />
      {/* 嵌入浏览器站点权限弹窗：main 把未决请求推到嵌入浏览器所在窗口，这里随窗口级
          根布局常驻（平台桥缺席时组件自身不渲染任何东西）。 */}
      <EmbeddedBrowserPermissionPromptHost />
    </div>
  );
}
