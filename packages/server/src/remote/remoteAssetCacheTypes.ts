// 拆分依据：remoteAssetCache.ts 1928 行，超 400 行架构上限。共享类型、mount 规则与常量
// 集中于此，作为所有远端资源缓存叶子的公共底座，避免叶子之间互相引用成环。
import type { RemoteAssetNetworkPort } from "@acode/server/remote/remoteAssetNetwork.js";

export const MANIFEST_FILE_NAME_PREFIX = "manifest-";
export const REMOTE_ASSET_READY_MARKER = ".ready";
export const LEGACY_REMOTE_ASSET_READY_MARKER = ".remote-assets-ready";
export const READY_MARKER_CANDIDATES = [REMOTE_ASSET_READY_MARKER, LEGACY_REMOTE_ASSET_READY_MARKER];
export const DEFAULT_REMOTE_ASSET_MANIFEST_REQUEST_TIMEOUT_MS = 10_000;
export const REMOTE_ASSET_PROGRESS_INTERVAL_MS = 1_000;
export const REMOTE_ASSET_PROGRESS_PERCENT_STEP = 5;
export const CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS: Record<string, string> = {
  "server-bundle": "server-content",
  glm: "glm-content",
};
export const REMOTE_ASSET_DIRECTORY_COMMIT_RETRY_DELAYS_MS = [
  50, 100, 200, 400, 800, 1_600, 3_200,
] as const;

export interface RemoteAssetManifest {
  schemaVersion: number;
  appVersion: string;
  platformArch: string;
  components: RemoteAssetManifestComponent[];
}

export interface RemoteAssetManifestComponent {
  id: string;
  version: string;
  sha256: string;
  artifactPath: string;
  mount: string;
}

export interface RemoteAssetManifestRef {
  manifest: RemoteAssetManifest;
  releaseBaseCandidatesForComponents: string[];
}

export type RemoteAssetManifestFetchResult = RemoteAssetManifestRef;

export interface ComponentMountRule {
  platformScoped: boolean;
  resolveExpectedMount: (platformArch: string) => string;
}

export const REMOTE_COMPONENT_MOUNT_RULES: Record<string, ComponentMountRule> = {
  "server-bundle": {
    platformScoped: false,
    resolveExpectedMount: () => "server",
  },
  "node-runtime": {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `node/${platformArch}`,
  },
  "node-pty": {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `node-pty/${platformArch}`,
  },
  glm: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `glm/${platformArch}`,
  },
  bfs: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/bfs`,
  },
  ripgrep: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/ripgrep`,
  },
  ugrep: {
    platformScoped: true,
    resolveExpectedMount: (platformArch) => `tools/${platformArch}/ugrep`,
  },
};

export interface RemoteAssetCacheLoggers {
  log: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
}

export interface EnsureRemoteReleaseDirOptions {
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  version: string;
  platformArch: string;
  componentIds?: string[];
  requiredReleasePaths?: string[];
  /**
   * 将身份决策与实际物化绑定到同一份 manifest 快照。
   * null 表示本次 transaction 已确认 manifest 缺失，不得再次请求。
   */
  manifestRef?: RemoteAssetManifestRef | null;
  /** 仅用于需要观察同 app 版本制品重发的身份检查。 */
  refreshManifest?: boolean;
  /** 忽略当前内容寻址 cache，重新下载并校验所选组件。 */
  forceRefresh?: boolean;
  /** 单个 manifest CDN 候选请求的超时时间。 */
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}
