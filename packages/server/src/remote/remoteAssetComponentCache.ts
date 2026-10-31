// 拆分依据：remoteAssetCache.ts 1928 行，超 400 行架构上限。单个组件的缓存目录保证（进程内锁、
// ready/关键路径校验、旧缓存迁移、下载校验、原子提交）自成一体，独立成叶。
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractTarGzArchive } from "@acode/server/remote/localTarGz.js";
import { buildComponentArtifactUrlCandidates } from "@acode/server/remote/remoteAssetCdn.js";
import { resolveRemoteAssetFetch } from "@acode/server/remote/remoteAssetNetwork.js";
import {
  REMOTE_ASSET_READY_MARKER,
  type RemoteAssetCacheLoggers,
  type RemoteAssetManifestComponent,
} from "@acode/server/remote/remoteAssetCacheTypes.js";
import type { RemoteAssetNetworkPort } from "@acode/server/remote/remoteAssetNetwork.js";
import {
  resolveComponentCacheDir,
  usesRemoteAssetContentAddressedCacheIdentity,
} from "@acode/server/remote/remoteAssetCachePaths.js";
import {
  assertExtractedArchiveNotEmpty,
  commitStagingDirectoryAtomically,
  computeFileSha256,
  findMissingReadyComponentPaths,
  isReadyComponentDirForRequiredPaths,
  writeReadyMarker,
} from "@acode/server/remote/remoteAssetCacheFs.js";
import {
  fetchFirstAvailableUrl,
  writeResponseBodyToFile,
} from "@acode/server/remote/remoteAssetArtifactFetch.js";
import {
  tryMigrateComponentDirFromHashVersionComponentCache,
  tryMigrateComponentDirFromLegacyReleaseCache,
} from "@acode/server/remote/remoteAssetComponentMigration.js";

const remoteAssetComponentLocks = new Map<string, Promise<string>>();

export async function ensureRemoteComponentDirFromCdn(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  component: RemoteAssetManifestComponent,
  requiredRelativePaths: readonly string[],
  loggers: RemoteAssetCacheLoggers,
  forceRefresh = false,
): Promise<string> {
  const componentDir = resolveComponentCacheDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  if (
    !forceRefresh &&
    (await isReadyComponentDirForRequiredPaths(componentDir, requiredRelativePaths))
  ) {
    return componentDir;
  }

  // 组件锁 key 之前未带 remoteCacheDir，不同缓存目录会被同一组件下载锁串起来。
  // 这里直接使用 componentDir 绝对路径做 key，保证隔离语义与落盘目录一一对应。
  const lockKey = resolve(componentDir);
  while (true) {
    const lockedTask = remoteAssetComponentLocks.get(lockKey);
    if (!lockedTask) {
      break;
    }
    const lockedComponentDir = await lockedTask;
    const missingPaths = await findMissingReadyComponentPaths(
      lockedComponentDir,
      requiredRelativePaths,
    );
    if (missingPaths?.length === 0) {
      return lockedComponentDir;
    }
    // 不同部署调用会共享同一 component cache 锁。等待已有下载后，
    // 仍要用当前调用方的关键路径复检，避免把只满足旧调用的残缺 cache 返回出去。
    loggers.logWarn(
      `[remote-assets] locked component cache still incomplete: component=${component.id} missing=${(missingPaths ?? []).join(",")}; redownloading`,
    );
  }

  const task = ensureRemoteComponentDirFromCdnInternal(
    options,
    component,
    requiredRelativePaths,
    loggers,
    forceRefresh,
  ).finally(() => {
    remoteAssetComponentLocks.delete(lockKey);
  });
  remoteAssetComponentLocks.set(lockKey, task);
  return task;
}

async function ensureRemoteComponentDirFromCdnInternal(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  component: RemoteAssetManifestComponent,
  requiredRelativePaths: readonly string[],
  loggers: RemoteAssetCacheLoggers,
  forceRefresh = false,
): Promise<string> {
  const componentDir = resolveComponentCacheDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  if (forceRefresh) {
    // App 版本变化代表一次新的资源发布边界；即使 GLM SHA cache 命中，
    // 也必须重新下载、校验并原子替换，避免本地上传把旧 cache 再次部署到远端。
    loggers.logWarn(
      `[remote-assets] forced component refresh: component=${component.id} path=${componentDir}`,
    );
  }
  const initialMissingPaths = await findMissingReadyComponentPaths(
    componentDir,
    requiredRelativePaths,
  );
  if (!forceRefresh && initialMissingPaths?.length === 0) {
    return componentDir;
  }
  if (!forceRefresh && initialMissingPaths) {
    // 旧版本只用 .ready 判断 component cache 可用。用户先部署过只含
    // acode.cjs 的 glm cache 后，再补传 packages 会一直复用残缺 cache。
    // 这里按调用方声明的关键路径校验，缺失时清掉旧 cache 并从 CDN 重下完整组件。
    loggers.logWarn(
      `[remote-assets] local component cache incomplete: component=${component.id} missing=${initialMissingPaths.join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  if (
    !forceRefresh &&
    !usesRemoteAssetContentAddressedCacheIdentity(component.id) &&
    (await tryMigrateComponentDirFromHashVersionComponentCache(
      options,
      component,
      componentDir,
      loggers,
    ))
  ) {
    const migratedMissingPaths = await findMissingReadyComponentPaths(
      componentDir,
      requiredRelativePaths,
    );
    if (migratedMissingPaths?.length === 0) {
      return componentDir;
    }
    loggers.logWarn(
      `[remote-assets] migrated local component cache incomplete: component=${component.id} missing=${(migratedMissingPaths ?? []).join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  if (
    !forceRefresh &&
    !usesRemoteAssetContentAddressedCacheIdentity(component.id) &&
    (await tryMigrateComponentDirFromLegacyReleaseCache(options, component, componentDir, loggers))
  ) {
    const migratedMissingPaths = await findMissingReadyComponentPaths(
      componentDir,
      requiredRelativePaths,
    );
    if (migratedMissingPaths?.length === 0) {
      return componentDir;
    }
    loggers.logWarn(
      `[remote-assets] migrated local component cache incomplete: component=${component.id} missing=${(migratedMissingPaths ?? []).join(",")}; redownloading`,
    );
    await rm(componentDir, { recursive: true, force: true });
  }

  const artifactUrlCandidates = buildComponentArtifactUrlCandidates(
    options.releaseBaseCandidatesForComponents,
    component.artifactPath,
    options.version,
  );

  const stagingBaseDir = join(options.remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-component-${component.id}-${options.platformArch}-${component.version}-${process.pid}-${randomUUID()}`,
  );
  const archivePath = join(stagingDir, "component.tar.gz");
  const extractRoot = join(stagingDir, "extract");
  await mkdir(extractRoot, { recursive: true });

  try {
    const { response: artifactResponse, url: artifactUrl } = await fetchFirstAvailableUrl(
      artifactUrlCandidates,
      `${component.id}@${component.version}`,
      resolveRemoteAssetFetch(options.remoteAssetNetwork),
    );
    loggers.log(`[remote-assets] downloading ${artifactUrl}`);
    await writeResponseBodyToFile(artifactResponse, archivePath, loggers);

    const actualChecksum = await computeFileSha256(archivePath);
    if (actualChecksum !== component.sha256) {
      throw new Error(
        `[remote-assets] sha256 mismatch for ${component.id}@${component.version}: expected=${component.sha256}, actual=${actualChecksum}`,
      );
    }

    await extractTarGzArchive(archivePath, extractRoot);
    await assertExtractedArchiveNotEmpty(
      extractRoot,
      `[remote-assets] extracted component archive is empty for ${component.id}@${component.version}`,
    );
    await writeReadyMarker(extractRoot, REMOTE_ASSET_READY_MARKER);
    await commitStagingDirectoryAtomically(extractRoot, componentDir);
    return componentDir;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
