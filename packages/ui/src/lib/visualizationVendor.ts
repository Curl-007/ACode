// 对话内可视化卡片的 vendored 钉版渲染库运行态（specs/gen-ui-visualize-card.md）。
//
// 目录数据与纯形状函数在 ./visualizationVendorData.ts（零 import 的 config-safe
// 叶子，vite 插件在 Node 加载期消费它，不得引入裸包导入——缘由见该文件头注释）。
// 本文件承载 SCHEME 常量转发与运行态解析：消费方是 renderer 应用包（Vite 打包，
// 裸导入安全）与 desktop main（tsup noExternal 打包），不经 vite.config 的
// Node 加载期，故此处允许 import @acode/shared 公开入口。
//
// 背景（specs/gen-ui-visualize-card.md「vendored 钉版渲染库」）：片段过去只能从
// CDN 白名单取 mermaid/chart.js——离线不可用且供应链面开放。本模块把两个库钉版为
// 本地资产：文件名带包名+版本（钉版可强缓存），sha256 进目录常量，构建期由
// packages/ui/vite/visualizationVendorPlugin.ts 校验（mismatch 即构建失败），桌面
// 生产态另在 main 的 acode-viz-vendor: 协议处理器里按 manifest 复核（fail-closed）。
//
// 加载路径（2026-10-15 Electron 41 实验判决，见 spec）：
// - http(s) 页面（Web dev/prod、桌面 dev）：srcdoc iframe 继承父文档 base URL，
//   片段里的相对路径 `visualization-vendor/<file>` 直接落到应用源，CSP 以
//   「源+目录前缀」精确放行；
// - file: 页面（桌面生产 loadFile）：opaque-origin 沙箱 iframe 加载 file: 子资源
//   被 Chromium 拒绝（实验实测 onerror），因此宿主把目录内引用重写为
//   `acode-viz-vendor://vendor/<file>`（main 注册的 privileged scheme，仅服务
//   vendored 资产目录）。
// 红线不动：iframe sandbox 仍只有 allow-scripts，CSP connect-src 仍为 'none'。
//
// 本文件不得 import node:* ——它被 renderer 组件引用；Node 侧的读取/哈希在 vite
// 插件与 desktop main 协议模块里各自实现。

export {
  VISUALIZATION_VENDOR_DIRECTORY,
  VISUALIZATION_VENDOR_LIBRARIES,
  buildVisualizationVendorRelativePath,
  isVisualizationVendorFileName,
  type VisualizationVendorLibrary,
} from "./visualizationVendorData.js";

import {
  VISUALIZATION_VENDOR_DIRECTORY,
  VISUALIZATION_VENDOR_LIBRARIES,
  buildVisualizationVendorRelativePath,
} from "./visualizationVendorData.js";

// 桌面生产态（file: 页面）服务 vendored 资产的自定义 scheme 与固定 host 段：
// 单一事实源在 packages/shared（platform.ts），main 侧协议处理器与本文件的
// renderer 重写引用同一常量；shared 根入口对 renderer 安全（无 node:* 依赖）。
// 本模块内部（resolveVisualizationVendorRuntime 等）也要用这两个名字，故 import 后再导出。
import { VISUALIZATION_VENDOR_SCHEME, VISUALIZATION_VENDOR_SCHEME_HOST } from "@acode/shared";

export { VISUALIZATION_VENDOR_SCHEME, VISUALIZATION_VENDOR_SCHEME_HOST };

/**
 * 宿主运行态：决定 CSP script-src 放行的本地源与片段引用的重写方式。
 * - `origin`：http(s) 页面。cspSource 是「源+目录」前缀（比裸 origin 更窄），
 *   片段里的相对引用经 base 继承直接可用，不重写。
 * - `scheme`：file: 页面（桌面生产）。cspSource 是 `acode-viz-vendor:`，
 *   片段里的规范相对路径重写为 scheme URL。
 */
export type VisualizationVendorRuntime =
  | { kind: "origin"; cspSource: string; baseUrl: string }
  | { kind: "scheme"; cspSource: string; baseUrl: string };

/**
 * 从文档 baseURI 解析运行态。纯函数（baseURI 显式传入，测试可注入）。
 * 非 http(s)/file 的意外协议按 origin 语义处理但 CSP 源仍是精确目录前缀，
 * 不放行任何额外面。
 */
export function resolveVisualizationVendorRuntime(baseURI: string): VisualizationVendorRuntime {
  const base = new URL(baseURI);
  if (base.protocol === "file:") {
    return {
      kind: "scheme",
      cspSource: `${VISUALIZATION_VENDOR_SCHEME}:`,
      baseUrl: `${VISUALIZATION_VENDOR_SCHEME}://${VISUALIZATION_VENDOR_SCHEME_HOST}/`,
    };
  }
  const vendorDirectoryUrl = new URL(`${VISUALIZATION_VENDOR_DIRECTORY}/`, base);
  return {
    kind: "origin",
    cspSource: vendorDirectoryUrl.href,
    baseUrl: vendorDirectoryUrl.href,
  };
}

/** renderer 组件用的文档侧入口；无 DOM 环境（静态渲染/测试）返回 undefined。 */
export function resolveVisualizationVendorRuntimeFromDocument():
  | VisualizationVendorRuntime
  | undefined {
  if (typeof document === "undefined") return undefined;
  try {
    return resolveVisualizationVendorRuntime(document.baseURI);
  } catch {
    return undefined;
  }
}

/** 单个库在当前运行态下的可加载 URL（两种运行态的 baseUrl 都以 `/` 结尾）。 */
export function buildVisualizationVendorScriptUrl(
  runtime: VisualizationVendorRuntime,
  fileName: string,
): string {
  return `${runtime.baseUrl}${fileName}`;
}

/**
 * scheme 运行态（桌面生产 file: 页面）下，把片段里对 vendored 库的规范相对引用
 * 重写为 `acode-viz-vendor://vendor/<file>`。字面量全串替换：文件名钉版、含 `@`/`.`
 * 但绝无正则/HTML 元字符歧义，替换不触碰片段其余字节。origin 运行态不重写
 * （base 继承已可解析）。
 */
export function rewriteVisualizationVendorReferences(
  fragment: string,
  runtime: VisualizationVendorRuntime,
): string {
  if (runtime.kind !== "scheme") return fragment;
  let rewritten = fragment;
  for (const library of VISUALIZATION_VENDOR_LIBRARIES) {
    rewritten = rewritten.replaceAll(
      buildVisualizationVendorRelativePath(library.fileName),
      buildVisualizationVendorScriptUrl(runtime, library.fileName),
    );
  }
  return rewritten;
}
