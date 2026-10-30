// 拆分依据：deploy.ts 超 400 行架构上限。releaseDir 解析链（mock-cdn 目录 → 完整性检查 →
// CDN/cache 回退）与 mock 资源清单枚举是独立的资源定位逻辑，不持有 deployServer 的锁/决策状态，
// 独立成叶子。DeployReleaseDirOptions 是 DeployOptions 的字段子集（本地声明，避免循环类型依赖）。
import { join } from "node:path";
import { ACODE_VERSION } from "@acode/shared";
import type { RemoteEnvironment } from "./backend.js";
import { fileExists } from "@acode/server/remote/deployShared.js";
import type { RemoteAssetNetworkPort } from "@acode/server/remote/remoteAssetNetwork.js";
import { REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS } from "@acode/server/remote/acodeAgentOfficialPluginAssets.js";
import {
  ensureRemoteReleaseDirFromCdn,
  type RemoteAssetManifestRef,
} from "@acode/server/remote/remoteAssetCache.js";

export const SERVER_BUNDLE_COMPONENT_ID = "server-bundle";

/** DeployOptions 中 releaseDir 解析所需的字段子集（本地声明，避免循环类型依赖）。 */
export interface DeployReleaseDirOptions {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

export function buildReleaseDirCacheKey(
  componentIds: string[] | undefined,
  forceRefresh = false,
): string {
  const componentKey =
    componentIds && componentIds.length > 0 ? componentIds.slice().sort().join(",") : "<all>";
  return `${componentKey}:${forceRefresh ? "force" : "reuse"}`;
}

export function resolveMockCdnReleaseDir(mockCdnDir?: string): string | null {
  if (!mockCdnDir) {
    return null;
  }

  return join(mockCdnDir, "releases", ACODE_VERSION);
}

export async function resolveReleaseDir(
  options: DeployReleaseDirOptions | undefined,
  env: RemoteEnvironment,
  loggers: {
    log: (...args: unknown[]) => void;
    logWarn: (...args: unknown[]) => void;
  },
  componentIds?: string[],
  manifestRef?: RemoteAssetManifestRef | null,
  forceRefresh = false,
): Promise<string | null> {
  const mockReleaseDir = resolveMockCdnReleaseDir(options?.mockCdnDir);
  const platformArch = `${env.platform}-${env.arch}`;
  if (mockReleaseDir) {
    const missingMockPaths = await findMissingMockReleasePaths(
      mockReleaseDir,
      platformArch,
      componentIds,
    );
    if (missingMockPaths.length === 0) {
      return mockReleaseDir;
    }

    // WSL/SSH 开发态可能只有版本目录，但缺当前远端平台的具体组件
    // （例如 Windows 侧 mock-cdn 只有 linux-arm64，却连接 linux-x64 WSL）。
    // 直接返回 mock 目录会在上传阶段报 local remote asset not found；
    // 有 CDN/cache 时应按组件回退到完整缓存，没有回退源时保留原错误指向缺失文件。
    loggers.logWarn(
      `[remote-assets] mock-cdn incomplete for ${platformArch}; missing=${missingMockPaths.join(", ")}`,
    );
    if (!hasRemoteAssetCdnFallback(options)) {
      return mockReleaseDir;
    }

    loggers.logWarn(
      `[remote-assets] fallback to CDN/cache for ${platformArch}; components=${componentIds?.join(",") ?? "<all>"}`,
    );
  }

  // 生产态不再打包 remote 资源，必须先从 CDN 下载到本地 cache。
  // 这里统一把“拿 releaseDir”的逻辑收口，避免后续各资源分支继续散落占位判断。
  return ensureRemoteReleaseDirFromCdn(
    {
      remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
      remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
      remoteCacheDir: options?.remoteCacheDir,
      version: ACODE_VERSION,
      platformArch,
      componentIds,
      manifestRef,
      forceRefresh,
      manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
      remoteAssetNetwork: options?.remoteAssetNetwork,
    },
    loggers,
  );
}

export function hasRemoteAssetCdnFallback(options: DeployReleaseDirOptions | undefined): boolean {
  const hasRemoteCacheDir = Boolean(options?.remoteCacheDir?.trim());
  const hasBaseUrl = Boolean(options?.remoteCdnBaseUrl?.trim());
  const hasBaseUrls = Boolean(
    options?.remoteCdnBaseUrls?.some((baseUrl) => baseUrl.trim().length > 0),
  );
  return hasRemoteCacheDir && (hasBaseUrl || hasBaseUrls);
}

export async function findMissingMockReleasePaths(
  releaseDir: string,
  platformArch: string,
  componentIds: string[] | undefined,
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const relativePath of resolveRequiredMockReleasePaths(platformArch, componentIds)) {
    if (!(await fileExists(releaseDir, ...relativePath.split("/")))) {
      missingPaths.push(relativePath);
    }
  }
  return missingPaths;
}

export function resolveRequiredMockReleasePaths(
  platformArch: string,
  componentIds: string[] | undefined,
): string[] {
  const ids =
    componentIds && componentIds.length > 0
      ? componentIds
      : [SERVER_BUNDLE_COMPONENT_ID, "node-runtime"];
  const requiredPaths = new Set<string>();

  for (const componentId of ids) {
    switch (componentId) {
      case SERVER_BUNDLE_COMPONENT_ID:
        requiredPaths.add("server/acode-server.cjs");
        break;
      case "node-runtime":
        requiredPaths.add(`node/${platformArch}/node`);
        break;
      case "node-pty":
        requiredPaths.add(`node-pty/${platformArch}/pty.node`);
        if (platformArch.startsWith("darwin-")) {
          requiredPaths.add(`node-pty/${platformArch}/spawn-helper`);
        }
        break;
      case "glm":
        requiredPaths.add(`glm/${platformArch}/acode.cjs`);
        for (const relativePath of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
          requiredPaths.add(`glm/${platformArch}/packages/${relativePath}`);
        }
        break;
      case "bfs":
        requiredPaths.add(`tools/${platformArch}/bfs/bfs`);
        break;
      case "ripgrep":
        requiredPaths.add(`tools/${platformArch}/ripgrep/rg`);
        break;
      case "ugrep":
        requiredPaths.add(`tools/${platformArch}/ugrep/ugrep`);
        break;
    }
  }

  return [...requiredPaths];
}
