// 反射门 justification 的 UI 投影（J1-2）。
// 规格见 apps/acode-cli/specs/bash-confirm-reflexive-gate.md R8。
//
// 为什么单独成模块：审批弹窗（PermissionDialog.tsx）带 React/别名依赖图，无法在
// `node --import tsx --test` 下直接加载；把「从权限请求 payload 投影出 justification」
// 这一段纯逻辑放这里，它就有了可执行的验收测试
// （packages/ui/test/permissionJustification.test.ts），而不是只存在于实现侧。
// 只依赖 lib/rawToolCallPayload.ts（同样无别名/React 依赖）。
//
// 渲染侧约定（由验收测试守卫，不在这里重复实现）：论证段带稳定 E2E 定位属性
// `data-permission-justification="true"`，模型论证原文只作为元素内容出现、不进选择器，
// 避免把原文泄漏到 DOM 选择器/测试快照的键里。

import type { ACodePermissionRequest } from "@acode/shared";
import { isPlainRecord, readRawToolCallInput } from "./rawToolCallPayload.js";

/** 论证段标题的 i18n key：en-US 与 zh-CN 两份 locale 必须同时提供（AGENTS.md 国际化约定）。 */
export const PERMISSION_JUSTIFICATION_LABEL_MESSAGE_ID = "chat.permission.justification.label";

/**
 * 模型重提被拒命令时携带的 justification。
 *
 * 协议侧无需改动：`PermissionRequested` payload 的 `input` 是 `z.unknown()` 透传，
 * justification 随工具入参自然到达 UI，取数路径与既有 displayReason 同源
 * （readRawToolCallInput：先兼容 rawInput，再读协议 schema 的 input）。
 * 缺失/非字符串/纯空白 → null，此时不渲染论证段。
 */
export function getPermissionJustification(request: ACodePermissionRequest): string | null {
  const rawInput = readRawToolCallInput(request.raw);
  if (!isPlainRecord(rawInput)) return null;
  const value = rawInput.justification;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
