/**
 * 嵌入式浏览器站点权限的展示映射（packages/desktop/specs/embedded-browser-site-permissions.md）。
 *
 * 可询问权限闭集（camera / microphone / geolocation / notifications / midi / midiSysex）→
 * i18n 键。集合外的权限名按原文显示——main 对它们同步拒绝，UI 只在管理面读到历史残留时
 * 才可能遇到，不谎译。
 */
const EMBEDDED_BROWSER_PERMISSION_LABEL_IDS: Record<string, string> = {
  camera: "browser.permission.camera",
  microphone: "browser.permission.microphone",
  geolocation: "browser.permission.geolocation",
  notifications: "browser.permission.notifications",
  midi: "browser.permission.midi",
  midiSysex: "browser.permission.midi",
};

/** 权限名 → i18n 键；未知权限返回 undefined（调用方回退原文）。 */
export function embeddedBrowserPermissionLabelId(permission: string): string | undefined {
  return EMBEDDED_BROWSER_PERMISSION_LABEL_IDS[permission];
}
