// 桌面生产态（file: 页面）为可视化沙箱卡片服务 vendored 钉版渲染库的自定义协议。
//
// 为什么需要它（specs：packages/ui/specs/gen-ui-visualize-card.md「vendored 钉版
// 渲染库」）：桌面生产 renderer 经 loadFile 跑在 file: 源上，而 srcdoc 沙箱 iframe
// （allow-scripts、无 allow-same-origin → opaque origin）加载 file: 子资源会被
// Chromium 拒绝（2026-10-15 Electron 41 实验实测 onerror）。renderer 侧因此把片段
// 里的 `visualization-vendor/<file>` 引用重写为 `acode-viz-vendor://vendor/<file>`
// （packages/ui/src/lib/visualizationVendor.ts），由本协议在 main 侧应答。
//
// 安全边界：
// - 只应答单一 host（vendor）+ 钉版命名形状（npm_<pkg>@<ver>_<dist>.js）的单段
//   路径；无通配、无路径穿越面（decode 后仍按形状校验，%2F 之类进不来）；
// - fail-closed 完整性：每次装载都按资产目录旁的 manifest.json 复核 sha256，
//   mismatch/缺 manifest/缺文件一律拒绝应答（构建期 vite 插件已校过一次，这里是
//   运行态第二道闸，防打包后被替换）；
// - 只读资产目录，不接受任何写/查询语义；协议不注册 stream，不服务 Range。
//
// scheme/host 常量单一事实源在 packages/shared（platform.ts），与 ui 侧
// visualizationVendor.ts 的 renderer 重写引用同一常量；字面量钉死与再导出链
// 由 tests/visualization-vendor-protocol.test.mjs 守护。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { VISUALIZATION_VENDOR_SCHEME, VISUALIZATION_VENDOR_SCHEME_HOST } from "@acode/shared";

export { VISUALIZATION_VENDOR_SCHEME, VISUALIZATION_VENDOR_SCHEME_HOST };
export const VISUALIZATION_VENDOR_MANIFEST_FILE_NAME = "manifest.json";

/** 与 ui 侧 isVisualizationVendorFileName 同形状（钉版命名约定，杜绝穿越形状）。 */
const VENDOR_FILE_NAME_PATTERN = /^npm_[a-z0-9.-]+@[0-9][a-z0-9.-]*_[a-z0-9.-]+\.js$/u;

/**
 * 请求 URL → 允许服务的文件名；任何不合形状/不合 host/不合 scheme 的输入返回 null
 * （调用方一律按 404 应答）。纯函数，可单测。
 */
export function parseVisualizationVendorRequestUrl(requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${VISUALIZATION_VENDOR_SCHEME}:`) return null;
  if (url.hostname !== VISUALIZATION_VENDOR_SCHEME_HOST) return null;
  let fileName: string;
  try {
    fileName = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  } catch {
    return null;
  }
  if (!VENDOR_FILE_NAME_PATTERN.test(fileName)) return null;
  return fileName;
}

interface VisualizationVendorManifestEntry {
  fileName: string;
  sha256: string;
}

interface VisualizationVendorManifest {
  version: number;
  libraries: VisualizationVendorManifestEntry[];
}

export interface VisualizationVendorFileServer {
  /** 校验通过返回字节；任何缺失/篡改返回 null（调用方 404）。 */
  load(fileName: string): Promise<Uint8Array | null>;
}

interface VisualizationVendorFileServerDependencies {
  resolveVendorDir: () => string;
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  sha256Hex?: (bytes: Uint8Array) => string;
}

/**
 * 资产目录读取器：manifest 复核 + 已校验字节缓存。缓存键含目录路径；桌面窗口
 * 生命周期内目录不变，缓存只按文件名下标（钉版文件名即内容身份）。
 */
export function createVisualizationVendorFileServer(
  dependencies: VisualizationVendorFileServerDependencies,
): VisualizationVendorFileServer {
  const readFileBytes =
    dependencies.readFileBytes ?? (async (path: string) => new Uint8Array(await readFile(path)));
  const sha256Hex =
    dependencies.sha256Hex ??
    ((bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"));
  const verifiedCache = new Map<string, Uint8Array>();

  const readManifest = async (vendorDir: string): Promise<VisualizationVendorManifest | null> => {
    try {
      const bytes = await readFileBytes(join(vendorDir, VISUALIZATION_VENDOR_MANIFEST_FILE_NAME));
      const manifest = JSON.parse(new TextDecoder().decode(bytes)) as VisualizationVendorManifest;
      if (manifest?.version !== 1 || !Array.isArray(manifest.libraries)) return null;
      return manifest;
    } catch {
      return null;
    }
  };

  return {
    async load(fileName) {
      const vendorDir = dependencies.resolveVendorDir();
      const cacheKey = `${vendorDir}\u0000${fileName}`;
      const cached = verifiedCache.get(cacheKey);
      if (cached) return cached;
      const manifest = await readManifest(vendorDir);
      const entry = manifest?.libraries.find((library) => library.fileName === fileName);
      if (!entry || typeof entry.sha256 !== "string") return null;
      let bytes: Uint8Array;
      try {
        bytes = await readFileBytes(join(vendorDir, fileName));
      } catch {
        return null;
      }
      // 运行态完整性闸：与 manifest 不符（打包后被替换/损坏）一律拒绝，绝不带病进沙箱。
      if (sha256Hex(bytes) !== entry.sha256) return null;
      verifiedCache.set(cacheKey, bytes);
      return bytes;
    },
  };
}

interface VisualizationVendorProtocolRegistrar {
  registerSchemesAsPrivileged(
    schemes: Array<{
      scheme: string;
      privileges: {
        standard: boolean;
        secure: boolean;
        supportFetchAPI: boolean;
        corsEnabled: boolean;
      };
    }>,
  ): void;
}

interface VisualizationVendorProtocolHost {
  handle(scheme: string, handler: (request: { url: string }) => Promise<Response> | Response): void;
}

/**
 * Electron 要求 privileged scheme 在 app ready 前注册（localMediaPreviewProtocol
 * 同款约束）。standard+secure 让 URL 按标准 URL 解析并被视为安全上下文；
 * supportFetchAPI+corsEnabled 保留 SRI（integrity+crossorigin）可用面——2026-10-15
 * 实验证明沙箱 iframe 对本 scheme 的 SRI 脚本加载成立。
 */
export function registerVisualizationVendorScheme(
  protocol: VisualizationVendorProtocolRegistrar,
): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: VISUALIZATION_VENDOR_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

export function installVisualizationVendorProtocol(
  protocol: VisualizationVendorProtocolHost,
  server: VisualizationVendorFileServer,
): void {
  protocol.handle(VISUALIZATION_VENDOR_SCHEME, async (request) => {
    const fileName = parseVisualizationVendorRequestUrl(request.url);
    if (!fileName) {
      return new Response("not found", { status: 404 });
    }
    const bytes = await server.load(fileName);
    if (!bytes) {
      return new Response("not found", { status: 404 });
    }
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        // 钉版文件名即内容身份：可强缓存。
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });
}
