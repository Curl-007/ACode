// 拆分说明（满足 400 行架构上限）：原 1928 行按职责分叶，本文件保留 release 下载公开入口与
// 进程内 release 锁（行为不变），并集中 re-export 原公开符号，调用方无需改动：
// - remoteAssetCacheTypes.ts：共享类型、mount 规则与常量（公共底座）
// - remoteAssetManifestParse.ts：manifest 响应解析与字段校验（纯逻辑）
// - remoteAssetManifestSelect.ts：组件选择与请求参数归一化（纯逻辑）
// - remoteAssetCachePaths.ts：缓存目录/内容寻址 release 段等路径解析（纯逻辑）
// - remoteAssetCacheFs.ts：就绪标记、完整性检查、物化、原子提交、内容哈希（fs 层）
// - remoteAssetManifestFetch.ts：manifest 获取链（single-flight 锁 + 多 CDN 回退）
// - remoteAssetArtifactFetch.ts：制品下载传输层（候选回退 + 进度日志）
// - remoteAssetComponentMigration.ts：旧缓存迁移（hash 版本目录 + 旧 release 目录）
// - remoteAssetComponentCache.ts：单组件缓存目录保证（组件锁 + 下载校验）
// - remoteAssetReleaseMaterialize.ts：release 目录物化（物化锁 + 组件挂载）
import { join, resolve } from "node:path";
import {
  assertRemoteCdnBaseVersionMatches,
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
  resolveRemoteCdnBaseUrls,
} from "@acode/server/remote/remoteAssetCdn.js";
import type { RemoteAssetNetworkPort } from "@acode/server/remote/remoteAssetNetwork.js";
import {
  MANIFEST_FILE_NAME_PREFIX,
  type EnsureRemoteReleaseDirOptions,
  type RemoteAssetCacheLoggers,
  type RemoteAssetManifestRef,
} from "@acode/server/remote/remoteAssetCacheTypes.js";
import { assertSafePathSegment } from "@acode/server/remote/remoteAssetManifestParse.js";
import {
  normalizeRequestedComponentIds,
  normalizeRequiredReleasePaths,
  selectManifestComponents,
} from "@acode/server/remote/remoteAssetManifestSelect.js";
import {
  resolveContentAddressedReleaseSegments,
  usesRemoteAssetContentAddressedCacheIdentity,
} from "@acode/server/remote/remoteAssetCachePaths.js";
import {
  findMissingLocalRelativePaths,
  isReadyReleaseDirForRequestedPaths,
  pathExists,
} from "@acode/server/remote/remoteAssetCacheFs.js";
import { fetchRemoteAssetManifest } from "@acode/server/remote/remoteAssetManifestFetch.js";
import { ensureRemoteReleaseDirFromManifest } from "@acode/server/remote/remoteAssetReleaseMaterialize.js";

const remoteAssetReleaseLocks = new Map<string, Promise<string>>();

export async function ensureRemoteReleaseDirFromCdn(
  options: EnsureRemoteReleaseDirOptions,
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options);
  const remoteCacheDir = options.remoteCacheDir?.trim();
  const platformArch = options.platformArch?.trim();
  const version = options.version?.trim();

  if (remoteCdnBaseUrls.length === 0 || !remoteCacheDir || !platformArch || !version) {
    throw new Error(
      `[deploy] production remote assets require remoteCdnBaseUrl or remoteCdnBaseUrls, remoteCacheDir and platformArch ` +
        `(remoteCdnBaseUrl=${options.remoteCdnBaseUrl ?? "<empty>"}, remoteCdnBaseUrls=${JSON.stringify(options.remoteCdnBaseUrls ?? [])}, remoteCacheDir=${options.remoteCacheDir ?? "<empty>"}, platformArch=${options.platformArch ?? "<empty>"}).`,
    );
  }

  assertSafePathSegment(version, "appVersion");
  assertSafePathSegment(platformArch, "platformArch");
  assertRemoteCdnBaseVersionMatches(remoteCdnBaseUrls, version);
  const requestedComponentIds = normalizeRequestedComponentIds(options.componentIds);
  const usesContentAddressedArtifactIdentity =
    requestedComponentIds === null ||
    Array.from(requestedComponentIds).some((componentId) =>
      usesRemoteAssetContentAddressedCacheIdentity(componentId),
    );
  const requiredReleasePaths = normalizeRequiredReleasePaths(options.requiredReleasePaths);

  // 之前 cache 目录只按 version 区分，跨平台 remote 会话会互相覆盖资源。
  // 这里改成 version + platformArch 双维隔离，避免 linux/darwin 互串导致部署二进制不匹配。
  const releaseDir = join(remoteCacheDir, "releases", version, platformArch);
  if (
    !options.forceRefresh &&
    !usesContentAddressedArtifactIdentity &&
    (await isReadyReleaseDirForRequestedPaths(releaseDir, platformArch, requiredReleasePaths))
  ) {
    return releaseDir;
  }
  loggers.logWarn(
    `[remote-assets] download required: component=<release> reason=local cache missing or invalid path=${releaseDir}`,
  );

  // 同一个桌面窗口可以并发创建多个 remote session。
  // 若不加进程内锁，会出现多个会话同时下载并解压同一版本资源，最终互相覆盖或留下半成品目录。
  // 之前锁 key 没带 remoteCacheDir，不同缓存目录会误复用同一 Promise。
  // 这会把 A 目录的 release 路径返回给 B 调用方，破坏 cache 隔离语义。
  const requestedComponentLockKey = requestedComponentIds
    ? Array.from(requestedComponentIds).sort().join(",")
    : "<all>";
  const pinnedContentIdentity = usesContentAddressedArtifactIdentity
    ? resolveContentAddressedReleaseSegments(
        options.manifestRef
          ? selectManifestComponents(options.manifestRef.manifest, requestedComponentIds)
          : [],
        requestedComponentIds,
      ).join("/")
    : undefined;
  const lockKey = [
    resolve(releaseDir),
    requestedComponentLockKey,
    options.manifestRef === null ? "<missing-manifest>" : pinnedContentIdentity || "<unpinned>",
    options.forceRefresh ? "force" : "reuse",
    String(options.manifestRequestTimeoutMs ?? "default"),
  ].join("::");
  while (true) {
    const lockedTask = remoteAssetReleaseLocks.get(lockKey);
    if (!lockedTask) {
      break;
    }
    const lockedReleaseDir = await lockedTask;
    const missingPaths = await findMissingLocalRelativePaths(
      lockedReleaseDir,
      requiredReleasePaths,
    );
    if (missingPaths.length === 0) {
      return lockedReleaseDir;
    }
    // 并发 remote session 可能先复用一个“不带 required paths”的 release 下载锁。
    // 等待该锁完成后必须按当前调用方声明的关键路径复检，缺失时继续走后续重下流程。
    loggers.logWarn(
      `[remote-assets] locked release cache still incomplete: missing=${missingPaths.join(",")}; redownloading`,
    );
  }

  const task = ensureRemoteReleaseDirFromCdnInternal(
    {
      remoteCdnBaseUrls,
      remoteCacheDir,
      version,
      platformArch,
      requestedComponentIds,
      requiredReleasePaths,
      manifestRef: options.manifestRef,
      forceRefresh: options.forceRefresh,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
  ).finally(() => {
    remoteAssetReleaseLocks.delete(lockKey);
  });

  remoteAssetReleaseLocks.set(lockKey, task);
  return task;
}

async function ensureRemoteReleaseDirFromCdnInternal(
  options: {
    remoteCdnBaseUrls: string[];
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    requestedComponentIds: Set<string> | null;
    requiredReleasePaths: string[];
    manifestRef?: RemoteAssetManifestRef | null;
    forceRefresh?: boolean;
    manifestRequestTimeoutMs?: number;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  const usesContentAddressedArtifactIdentity =
    options.requestedComponentIds === null ||
    Array.from(options.requestedComponentIds).some((componentId) =>
      usesRemoteAssetContentAddressedCacheIdentity(componentId),
    );
  const releaseDir = join(
    options.remoteCacheDir,
    "releases",
    options.version,
    options.platformArch,
  );
  if (
    !options.forceRefresh &&
    !usesContentAddressedArtifactIdentity &&
    (await isReadyReleaseDirForRequestedPaths(
      releaseDir,
      options.platformArch,
      options.requiredReleasePaths,
    ))
  ) {
    return releaseDir;
  }

  const releaseBaseCandidates = buildReleaseBaseCandidates(
    options.remoteCdnBaseUrls,
    options.version,
  );
  const manifestFileCandidates = buildRemoteManifestFileCandidates(options.platformArch);
  const manifestFileName =
    manifestFileCandidates[0] ?? `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`;
  const manifestUrlCandidates = buildReleaseAssetUrlCandidates(
    releaseBaseCandidates,
    manifestFileCandidates,
  );
  if (options.manifestRef) {
    return ensureRemoteReleaseDirFromManifest(
      {
        remoteCacheDir: options.remoteCacheDir,
        version: options.version,
        platformArch: options.platformArch,
        releaseBaseCandidatesForComponents: options.manifestRef.releaseBaseCandidatesForComponents,
        requestedComponentIds: options.requestedComponentIds,
        requiredReleasePaths: options.requiredReleasePaths,
        forceRefresh: options.forceRefresh,
        remoteAssetNetwork: options.remoteAssetNetwork,
      },
      options.manifestRef.manifest,
      loggers,
    );
  }
  if (options.manifestRef === null) {
    // 上游已在 deploy lock 内固定“manifest 缺失”结果；
    // 若 release materialize 再请求一次，会破坏单事务快照并翻倍超时上限。
    throw new Error(
      `[remote-assets] manifest not found for ${options.platformArch}: ${manifestFileName}`,
    );
  }

  const manifestFetchResult = await fetchRemoteAssetManifest(
    {
      remoteCacheDir: options.remoteCacheDir,
      version: options.version,
      platformArch: options.platformArch,
      remoteCdnBaseUrls: options.remoteCdnBaseUrls,
      releaseBaseCandidates,
      manifestUrlCandidates,
      manifestFileName,
      manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
      remoteAssetNetwork: options.remoteAssetNetwork,
    },
    loggers,
    usesContentAddressedArtifactIdentity
      ? async (cachedResult) => {
          const cachedComponents = selectManifestComponents(
            cachedResult.manifest,
            options.requestedComponentIds,
          );
          const contentSegments = resolveContentAddressedReleaseSegments(
            cachedComponents,
            options.requestedComponentIds,
          );
          return contentSegments.length > 0
            ? pathExists(
                join(
                  options.remoteCacheDir,
                  "releases",
                  options.version,
                  options.platformArch,
                  ...contentSegments,
                  `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`,
                ),
              )
            : false;
        }
      : undefined,
  );
  if (manifestFetchResult) {
    return ensureRemoteReleaseDirFromManifest(
      {
        remoteCacheDir: options.remoteCacheDir,
        version: options.version,
        platformArch: options.platformArch,
        releaseBaseCandidatesForComponents: manifestFetchResult.releaseBaseCandidatesForComponents,
        requestedComponentIds: options.requestedComponentIds,
        requiredReleasePaths: options.requiredReleasePaths,
        forceRefresh: options.forceRefresh,
        remoteAssetNetwork: options.remoteAssetNetwork,
      },
      manifestFetchResult.manifest,
      loggers,
    );
  }

  // 现在生产态只发布 manifest/components。manifest 缺失说明 CDN 发布不完整，
  // 继续探测旧 remote-assets 只会增加无效请求并掩盖真正的发布问题。
  throw new Error(
    `[remote-assets] manifest not found for ${options.platformArch}: ${manifestFileName}`,
  );
}

function buildRemoteManifestFileCandidates(platformArch: string): string[] {
  return [`${MANIFEST_FILE_NAME_PREFIX}${platformArch}.json`];
}

// 以下 re-export 保持原公开面不变，调用方仍从 @acode/server/remote/remoteAssetCache.js 导入。
export type {
  EnsureRemoteReleaseDirOptions,
  RemoteAssetCacheLoggers,
  RemoteAssetManifest,
  RemoteAssetManifestComponent,
  RemoteAssetManifestRef,
} from "@acode/server/remote/remoteAssetCacheTypes.js";
export { parseRemoteAssetManifestFromResponse } from "@acode/server/remote/remoteAssetManifestParse.js";
export { selectRemoteAssetManifestComponents } from "@acode/server/remote/remoteAssetManifestSelect.js";
export { resolveRemoteAssetComponentCacheVersion, usesRemoteAssetContentAddressedCacheIdentity } from "@acode/server/remote/remoteAssetCachePaths.js";
export { readCachedRemoteAssetMarker, resolveFallbackRemoteAssetCacheDir } from "@acode/server/remote/remoteAssetCacheFs.js";
export {
  buildRemoteAssetManifestFileCandidates,
  createRemoteAssetManifestRequestSignal,
  fetchRemoteAssetManifestFromCdn,
  fetchRemoteAssetManifestRefFromCdn,
} from "@acode/server/remote/remoteAssetManifestFetch.js";
