// 拆分依据：remoteAssetCache.ts 1928 行，超 400 行架构上限。manifest 获取链（进程内锁、
// 多 CDN 候选回退、响应解析入口）自成一体，被 release 入口与身份检查共享，独立成叶。
import { resolve } from "node:path";
import {
  assertRemoteCdnBaseVersionMatches,
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
  resolveRemoteCdnBaseUrls,
} from "@acode/server/remote/remoteAssetCdn.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@acode/server/remote/remoteAssetNetwork.js";
import {
  DEFAULT_REMOTE_ASSET_MANIFEST_REQUEST_TIMEOUT_MS,
  MANIFEST_FILE_NAME_PREFIX,
  type EnsureRemoteReleaseDirOptions,
  type RemoteAssetCacheLoggers,
  type RemoteAssetManifest,
  type RemoteAssetManifestFetchResult,
  type RemoteAssetManifestRef,
} from "@acode/server/remote/remoteAssetCacheTypes.js";
import {
  assertSafePathSegment,
  parseRemoteAssetManifestFromResponse,
} from "@acode/server/remote/remoteAssetManifestParse.js";

const remoteAssetManifestLocks = new Map<string, Promise<RemoteAssetManifestFetchResult | null>>();
const remoteAssetManifestRefreshLocks = new Map<
  string,
  Promise<RemoteAssetManifestFetchResult | null>
>();

export function buildRemoteAssetManifestFileCandidates(platformArch: string): string[] {
  return buildRemoteManifestFileCandidates(platformArch);
}

export function createRemoteAssetManifestRequestSignal(
  timeoutMs = DEFAULT_REMOTE_ASSET_MANIFEST_REQUEST_TIMEOUT_MS,
): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `[remote-assets] manifest request timeout must be a positive safe integer: ${String(timeoutMs)}`,
    );
  }
  // manifest 是 server-bundle/GLM SHA 跳过判断的前置输入；网络半开时若不主动取消，
  // 已完整部署的远端也会永久卡在初始化，且 single-flight 会把后续连接绑到同一 pending 请求。
  return AbortSignal.timeout(timeoutMs);
}

export async function fetchRemoteAssetManifestFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifest | null> {
  return (await fetchRemoteAssetManifestRefFromCdn(options, loggers))?.manifest ?? null;
}

export async function fetchRemoteAssetManifestRefFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifestRef | null> {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options);
  const remoteCacheDir = options.remoteCacheDir?.trim();
  const platformArch = options.platformArch?.trim();
  const version = options.version?.trim();

  if (remoteCdnBaseUrls.length === 0 || !remoteCacheDir || !platformArch || !version) {
    return null;
  }

  assertSafePathSegment(version, "appVersion");
  assertSafePathSegment(platformArch, "platformArch");
  assertRemoteCdnBaseVersionMatches(remoteCdnBaseUrls, version);

  const releaseBaseCandidates = buildReleaseBaseCandidates(remoteCdnBaseUrls, version);
  const manifestFileCandidates = buildRemoteManifestFileCandidates(platformArch);
  const manifestFileName =
    manifestFileCandidates[0] ?? `${MANIFEST_FILE_NAME_PREFIX}${platformArch}.json`;
  const manifestUrlCandidates = buildReleaseAssetUrlCandidates(
    releaseBaseCandidates,
    manifestFileCandidates,
  );

  const result = await fetchRemoteAssetManifest(
    {
      remoteCacheDir,
      version,
      platformArch,
      remoteCdnBaseUrls,
      releaseBaseCandidates,
      manifestUrlCandidates,
      manifestFileName,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
    options.refreshManifest ? async () => true : undefined,
  );
  return result;
}

export async function fetchRemoteAssetManifest(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    remoteCdnBaseUrls: string[];
    releaseBaseCandidates: string[];
    manifestUrlCandidates: string[];
    manifestFileName: string;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
  shouldRefreshCachedResult?: (result: RemoteAssetManifestFetchResult) => Promise<boolean>,
): Promise<RemoteAssetManifestFetchResult | null> {
  const lockKey = [
    resolve(options.remoteCacheDir),
    options.version,
    options.platformArch,
    String(options.manifestRequestTimeoutMs ?? "default"),
    ...options.remoteCdnBaseUrls,
  ].join("::");
  const lockedTask = remoteAssetManifestLocks.get(lockKey);
  if (lockedTask) {
    const activeRefreshTask = remoteAssetManifestRefreshLocks.get(lockKey);
    if (activeRefreshTask) {
      return activeRefreshTask;
    }
    const cachedResult = await lockedTask;
    const refreshStartedWhileWaiting = remoteAssetManifestRefreshLocks.get(lockKey);
    if (refreshStartedWhileWaiting) {
      return refreshStartedWhileWaiting;
    }
    const shouldRefresh = Boolean(
      cachedResult && shouldRefreshCachedResult && (await shouldRefreshCachedResult(cachedResult)),
    );
    if (!shouldRefresh) {
      return cachedResult;
    }
    const refreshStartedWhileDeciding = remoteAssetManifestRefreshLocks.get(lockKey);
    if (refreshStartedWhileDeciding) {
      return refreshStartedWhileDeciding;
    }
  }

  let task: Promise<RemoteAssetManifestFetchResult | null>;
  task = fetchRemoteAssetManifestInternal(options, loggers).then(
    (result) => {
      if (!result && remoteAssetManifestLocks.get(lockKey) === task) {
        remoteAssetManifestLocks.delete(lockKey);
      }
      return result;
    },
    (error) => {
      if (remoteAssetManifestLocks.get(lockKey) === task) {
        remoteAssetManifestLocks.delete(lockKey);
      }
      throw error;
    },
  );
  remoteAssetManifestLocks.set(lockKey, task);
  if (shouldRefreshCachedResult) {
    // 多个 remote session 可能同时检查内容寻址组件的 SHA。fresh manifest 也必须
    // single-flight，否则同一批会话会重复请求，甚至在发布切换点看到不同快照。
    remoteAssetManifestRefreshLocks.set(lockKey, task);
    void task.then(
      () => {
        if (remoteAssetManifestRefreshLocks.get(lockKey) === task) {
          remoteAssetManifestRefreshLocks.delete(lockKey);
        }
      },
      () => {
        if (remoteAssetManifestRefreshLocks.get(lockKey) === task) {
          remoteAssetManifestRefreshLocks.delete(lockKey);
        }
      },
    );
  }
  return task;
}

async function fetchRemoteAssetManifestInternal(
  options: {
    version: string;
    platformArch: string;
    releaseBaseCandidates: string[];
    manifestUrlCandidates: string[];
    manifestFileName: string;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
): Promise<RemoteAssetManifestFetchResult | null> {
  const manifestFetchResult = await fetchFirstAvailableManifestOrNullWhenNotFound({
    candidates: options.manifestUrlCandidates,
    fileLabel: options.manifestFileName,
    version: options.version,
    platformArch: options.platformArch,
    manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
    fetch: resolveRemoteAssetFetch(options.remoteAssetNetwork),
  });
  if (!manifestFetchResult) {
    return null;
  }

  loggers.log(`[remote-assets] downloading ${manifestFetchResult.url}`);
  const manifestReleaseBase = resolveReleaseBaseByAssetUrl(
    manifestFetchResult.url,
    options.releaseBaseCandidates,
  );
  // 组件级按需下载后，同一次部署会多次请求 releaseDir。
  // 这里缓存 manifest，并继续优先使用 manifest 命中的 CDN 源，避免重复拉 manifest 和跨源组件不一致。
  const releaseBaseCandidatesForComponents = manifestReleaseBase
    ? [
        manifestReleaseBase,
        ...options.releaseBaseCandidates.filter((candidate) => candidate !== manifestReleaseBase),
      ]
    : options.releaseBaseCandidates;

  return {
    manifest: manifestFetchResult.manifest,
    releaseBaseCandidatesForComponents,
  };
}

async function fetchFirstAvailableManifestOrNullWhenNotFound(options: {
  candidates: string[];
  fileLabel: string;
  version: string;
  platformArch: string;
  manifestRequestTimeoutMs?: number;
  fetch: typeof globalThis.fetch;
}): Promise<{ manifest: RemoteAssetManifest; url: string } | null> {
  const errors: string[] = [];

  for (const candidate of options.candidates) {
    const signal = createRemoteAssetManifestRequestSignal(options.manifestRequestTimeoutMs);
    let response: Response;
    try {
      response = await options.fetch(candidate, { signal });
    } catch (error) {
      errors.push(`${candidate} -> ${String(error)}`);
      continue;
    }
    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      errors.push(`${candidate} -> HTTP ${response.status}`);
      continue;
    }

    try {
      return {
        manifest: await parseRemoteAssetManifestFromResponse(
          response,
          candidate,
          options.version,
          options.platformArch,
        ),
        url: candidate,
      };
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
      // fetch 在收到响应头后已经完成，但 response body 仍可能半开；
      // body 超时也属于候选 CDN 的网络失败，应继续尝试下一个候选而不是永久等待。
      errors.push(`${candidate} -> ${String(error)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`[remote-assets] failed to fetch ${options.fileLabel}: ${errors.join("; ")}`);
  }
  return null;
}

function buildRemoteManifestFileCandidates(platformArch: string): string[] {
  return [`${MANIFEST_FILE_NAME_PREFIX}${platformArch}.json`];
}

function resolveReleaseBaseByAssetUrl(
  assetUrl: string,
  releaseBaseCandidates: string[],
): string | null {
  const matchedReleaseBases = releaseBaseCandidates
    .map((releaseBase) => releaseBase.replace(/\/+$/, ""))
    .filter((releaseBase) => releaseBase.length > 0 && assetUrl.startsWith(`${releaseBase}/`))
    .sort((left, right) => right.length - left.length);
  return matchedReleaseBases[0] ?? null;
}
