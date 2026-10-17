// 可视化卡片 vendored 钉版渲染库的 Vite 资产管线（Web 与桌面 renderer 共用）。
//
// 职责（specs/gen-ui-visualize-card.md「vendored 钉版渲染库」）：
// 1. 从 node_modules 读取钉版 dist 文件（mermaid@11.17.2 / chart.js@4.5.0，
//    packages/ui 的 exact 依赖），必要时前置 license banner（esbuild IIFE 构建
//    会剥掉头部注释，mermaid 即此形态）；
// 2. sha256 与目录常量（src/lib/visualizationVendor.ts）比对——mismatch 即抛错，
//    dev/build 都失败（fail-fast 挂在 buildStart，serve 模式同样生效）；
// 3. build：把 `visualization-vendor/<fileName>` 与完整性 manifest.json emit 进
//    产物（electron-builder 的 files 规则含 out/**/*，桌面生产打包随之携带；
//    Web dist 由静态服务直接托管）；
// 4. dev：中间件按同一份（已校验的）内存工件服务同名路径。
//
// 先例对齐 pdfJsCMapsPlugin.ts（generateBundle emit + configureServer 中间件）。
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
// 只依赖零 import 的数据叶子：本插件被 web/desktop 的 vite.config 在 Node 加载期
// 引入，若经 visualizationVendor.ts 会连带裸 @acode/shared 根入口——Node 24+ 的
// strip-types 不做 .js→.ts 重映射，config 加载直接 ERR_MODULE_NOT_FOUND
// （v0.0.10 Release 构建实败；缘由详见 visualizationVendorData.ts 头注释）。
import {
  VISUALIZATION_VENDOR_DIRECTORY,
  VISUALIZATION_VENDOR_LIBRARIES,
  isVisualizationVendorFileName,
  type VisualizationVendorLibrary,
} from "../src/lib/visualizationVendorData.js";

const require = createRequire(import.meta.url);

export const VISUALIZATION_VENDOR_MANIFEST_FILE_NAME = "manifest.json";

export interface VisualizationVendorAsset {
  fileName: string;
  source: Uint8Array;
  sha256: string;
}

export class VisualizationVendorIntegrityError extends Error {}

/** dist 字节 → 最终工件：目录声明了 licenseBanner 的前置（含换行），否则原样。 */
export function buildVisualizationVendorArtifact(
  library: VisualizationVendorLibrary,
  distBytes: Uint8Array,
): Uint8Array {
  if (!library.licenseBanner) return distBytes;
  const banner = new TextEncoder().encode(`${library.licenseBanner}\n`);
  const artifact = new Uint8Array(banner.byteLength + distBytes.byteLength);
  artifact.set(banner, 0);
  artifact.set(distBytes, banner.byteLength);
  return artifact;
}

export function computeVisualizationVendorSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 完整性断言：工件 sha256 必须逐字等于目录钉住的值。不等即抛
 * VisualizationVendorIntegrityError——依赖被换版/被篡改/hoisting 漂到别的
 * 构建都在这里拦下，绝不带病进产物。
 */
export function assertVisualizationVendorIntegrity(
  library: VisualizationVendorLibrary,
  artifactBytes: Uint8Array,
): string {
  const actual = computeVisualizationVendorSha256(artifactBytes);
  if (actual !== library.sha256) {
    throw new VisualizationVendorIntegrityError(
      `visualization vendor integrity mismatch: ${library.fileName} ` +
        `(expected sha256 ${library.sha256}, got ${actual}). ` +
        `钉版目录与安装到的 ${library.package}@${library.version} dist 不一致；` +
        `升级版本必须同步更新 visualizationVendor.ts 的 sha256 并复核 license。`,
    );
  }
  return actual;
}

export interface VisualizationVendorLoadDependencies {
  /** 注入点（测试）：按 npm 包名 + 包内相对路径读 dist 字节。 */
  readPackageFile?: (packageName: string, distPath: string) => Promise<Uint8Array>;
}

/** 读取全部钉版库并校验完整性；返回顺序与目录一致。 */
export async function loadVisualizationVendorAssets(
  dependencies: VisualizationVendorLoadDependencies = {},
): Promise<VisualizationVendorAsset[]> {
  const readPackageFile =
    dependencies.readPackageFile ??
    (async (packageName: string, distPath: string) => {
      // 不能 require.resolve("<pkg>/package.json")：chart.js 等包的 exports 图不暴露
      // 该子路径（ERR_PACKAGE_PATH_NOT_EXPORTED）。改从包入口向上找 package.json 定根。
      const entryPath = require.resolve(packageName);
      const packageRoot = findVisualizationVendorPackageRoot(dirname(entryPath), packageName);
      return new Uint8Array(await readFile(join(packageRoot, distPath)));
    });
  const assets: VisualizationVendorAsset[] = [];
  for (const library of VISUALIZATION_VENDOR_LIBRARIES) {
    const distBytes = await readPackageFile(library.package, library.distPath);
    const source = buildVisualizationVendorArtifact(library, distBytes);
    const sha256 = assertVisualizationVendorIntegrity(library, source);
    assets.push({ fileName: library.fileName, source, sha256 });
  }
  return assets;
}

function findVisualizationVendorPackageRoot(startDir: string, packageName: string): string {
  let current = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new VisualizationVendorIntegrityError(
    `visualization vendor: cannot locate package root for ${packageName} from ${startDir}`,
  );
}

/** 完整性 manifest（确定性字节：无时间戳，按 fileName 排序）。 */
export function buildVisualizationVendorManifest(
  assets: readonly VisualizationVendorAsset[],
): Uint8Array {
  const manifest = {
    version: 1,
    libraries: [...assets]
      .sort((left, right) => (left.fileName < right.fileName ? -1 : 1))
      .map((asset) => {
        const library = VISUALIZATION_VENDOR_LIBRARIES.find(
          (entry) => entry.fileName === asset.fileName,
        );
        return {
          fileName: asset.fileName,
          package: library?.package ?? "",
          version: library?.version ?? "",
          sha256: asset.sha256,
        };
      }),
  };
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

export function visualizationVendorPlugin(): Plugin {
  // dev 中间件与 build emit 共用同一份已校验工件；buildStart 先行 fail-fast，
  // 完整性错误不会拖到产物阶段才暴露。
  let assetsPromise: Promise<VisualizationVendorAsset[]> | null = null;
  const loadAssets = (): Promise<VisualizationVendorAsset[]> => {
    assetsPromise ??= loadVisualizationVendorAssets();
    return assetsPromise;
  };

  return {
    name: "acode:visualization-vendor",
    async buildStart() {
      await loadAssets();
    },
    async generateBundle() {
      for (const asset of await loadAssets()) {
        this.emitFile({
          type: "asset",
          fileName: `${VISUALIZATION_VENDOR_DIRECTORY}/${asset.fileName}`,
          source: asset.source,
        });
      }
      this.emitFile({
        type: "asset",
        fileName: `${VISUALIZATION_VENDOR_DIRECTORY}/${VISUALIZATION_VENDOR_MANIFEST_FILE_NAME}`,
        source: buildVisualizationVendorManifest(await loadAssets()),
      });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestPath = request.url?.split("?", 1)[0] ?? "";
        const marker = `/${VISUALIZATION_VENDOR_DIRECTORY}/`;
        const markerIndex = requestPath.indexOf(marker);
        if (markerIndex < 0) {
          next();
          return;
        }
        const fileName = decodeURIComponent(requestPath.slice(markerIndex + marker.length));
        const isManifest = fileName === VISUALIZATION_VENDOR_MANIFEST_FILE_NAME;
        if (
          fileName.length === 0 ||
          fileName.includes("/") ||
          (!isManifest && !isVisualizationVendorFileName(fileName))
        ) {
          next();
          return;
        }
        void loadAssets()
          .then((assets) => {
            const source = isManifest
              ? buildVisualizationVendorManifest(assets)
              : assets.find((asset) => asset.fileName === fileName)?.source;
            if (!source) {
              response.statusCode = 404;
              response.end("not found");
              return;
            }
            response.statusCode = 200;
            response.setHeader(
              "Content-Type",
              isManifest ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8",
            );
            // 文件名带版本号（钉版）：可安全强缓存。
            response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            response.end(Buffer.from(source));
          })
          .catch((error: unknown) => {
            next(error);
          });
      });
    },
  };
}
