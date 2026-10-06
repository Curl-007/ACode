/**
 * scripts/desktop-product-identity.mjs 中 resolveWindowsAppUserModelIdForFlavor 的类型化镜像。
 *
 * 镜像原因：main 的编译单元（tsconfig.main.json：rootDir=src/main、未开 allowJs）无法为
 * 直接相对导入的构建期 .mjs 脚本提供类型（TS7016），而在 scripts/ 旁补 .d.ts 又超出
 * src/main 的改动边界。逻辑与脚本逐行一致；打包态 AUMID 必须等于 electron-builder 的
 * appId，否则 Windows 会把快捷方式、开始菜单索引与运行中的 Electron 进程视为不同应用。
 *
 * 修改 scripts/desktop-product-identity.mjs 的 appId / 开发态 AUMID 时必须同步本文件。
 */

/** 与 scripts/desktop-product-identity.mjs 的 desktopProductIdentities[*].appId 一一对应。 */
const PRODUCT_APP_IDS = {
  production: "dev.acode.app",
  preview: "dev.acode.app.preview",
} as const;

/** 开发态沿用旧身份，避免本地调试快捷方式与正式/Preview 安装包互相污染。 */
const DEV_WINDOWS_APP_USER_MODEL_ID = "cn.aminer.acode";

export function resolveWindowsAppUserModelIdForFlavor(
  flavor: string,
  runtime: { isPackaged?: boolean } = { isPackaged: true },
): string {
  if (runtime.isPackaged === false) {
    return DEV_WINDOWS_APP_USER_MODEL_ID;
  }
  return PRODUCT_APP_IDS[flavor === "preview" ? "preview" : "production"];
}
