// vendored 钉版渲染库的目录数据与纯形状函数（visualizationVendor.ts 的数据叶子）。
//
// 为什么单独成文件：web/desktop 的 vite.config.ts 会在 **Node 加载期**经
// visualizationVendorPlugin 拉进本目录数据。Vite 打包 config 时裸包导入
// （@acode/shared 根入口）被留为 external，交给 Node 原生加载——Node 24+ 的
// strip-types 不做 .js→.ts 重映射，shared 根入口首个值导入（./protocol.js）
// 直接 ERR_MODULE_NOT_FOUND（v0.0.10 Release 构建实败，0.0.9 无此链路）。
// 因此本文件纪律：**零 import**（数据自足），config 期由 esbuild 整体内联，
// 不触发任何运行期包解析。SCHEME 常量与运行态解析留在 visualizationVendor.ts
// （renderer 应用包与 desktop main 走各自打包器，裸导入安全）。

/** 资产目录名（相对父文档 base，同时也是构建产物子目录名）。 */
export const VISUALIZATION_VENDOR_DIRECTORY = "visualization-vendor";

/** vendored 库钉版目录。fileName 命名约定 `npm_<pkg>@<ver>_<dist路径，/ 换 _>`。 */
export interface VisualizationVendorLibrary {
  /** 逻辑名（npm 包名）。 */
  readonly package: string;
  /** 钉住的精确版本（与 package.json 的 exact 依赖一致）。 */
  readonly version: string;
  /** 服务/重写到资产文件名。 */
  readonly fileName: string;
  /** 最终工件（含 licenseBanner 前置）的 sha256 hex；构建期与桌面协议侧都按它校验。 */
  readonly sha256: string;
  /** npm 包内 dist 源文件相对路径。 */
  readonly distPath: string;
  /** esbuild IIFE 构建会剥掉 license 头（mermaid 即此形态）；有值时构建期前置。 */
  readonly licenseBanner?: string;
}

export const VISUALIZATION_VENDOR_LIBRARIES: readonly VisualizationVendorLibrary[] = [
  {
    package: "mermaid",
    version: "11.17.2",
    fileName: "npm_mermaid@11.17.2_mermaid.min.js",
    sha256: "d8135ef40856e856f5f991248ff706180a40cbec2c7d66a150a7928950e34a10",
    distPath: "dist/mermaid.min.js",
    licenseBanner: "/*! mermaid v11.17.2 | MIT License | https://github.com/mermaid-js/mermaid */",
  },
  {
    package: "chart.js",
    version: "4.5.0",
    fileName: "npm_chart.js@4.5.0_chart.umd.min.js",
    sha256: "2f27bcf471b2d69dd78494f6e2172fb28470eb843820e2f96bb85d39f9618d30",
    distPath: "dist/chart.umd.min.js",
  },
];

/** 片段侧引用 vendored 库的规范相对路径（技能文档教同一张表）。 */
export function buildVisualizationVendorRelativePath(fileName: string): string {
  return `${VISUALIZATION_VENDOR_DIRECTORY}/${fileName}`;
}

const VENDOR_FILE_NAME_PATTERN = /^npm_[a-z0-9.-]+@[0-9][a-z0-9.-]*_[a-z0-9.-]+\.js$/u;

/** 目录内文件名形状校验（协议处理器/中间件共用判据；也挡住路径穿越形状）。 */
export function isVisualizationVendorFileName(name: string): boolean {
  return VENDOR_FILE_NAME_PATTERN.test(name);
}
