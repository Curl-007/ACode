// 拆分依据：remoteAssetCache.ts 1928 行，超 400 行架构上限。release 目录物化（按 manifest 落地所选组件、
// 物化锁串行化、组件目录挂载到 release）自成一体，独立成叶。
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RemoteAssetNetworkPort } from "@acode/server/remote/remoteAssetNetwork.js";
import {
  MANIFEST_FILE_NAME_PREFIX,
  REMOTE_ASSET_READY_MARKER,
  type RemoteAssetCacheLoggers,
  type RemoteAssetManifest,
  type RemoteAssetManifestComponent,
} from "@acode/server/remote/remoteAssetCacheTypes.js";
import { selectManifestComponents } from "@acode/server/remote/remoteAssetManifestSelect.js";
import {
  resolveContentAddressedReleaseSegments,
  resolveRequiredComponentPaths,
} from "@acode/server/remote/remoteAssetCachePaths.js";
import {
  assertExtractedArchiveNotEmpty,
  commitStagingDirectoryAtomically,
  isReadyReleaseDirForRequestedPaths,
  isValidReleaseDir,
  materializeDirectoryContents,
  resolvePathWithinBase,
  writeReadyMarker,
} from "@acode/server/remote/remoteAssetCacheFs.js";
import { ensureRemoteComponentDirFromCdn } from "@acode/server/remote/remoteAssetComponentCache.js";

const remoteAssetReleaseMaterializeLocks = new Map<string, Promise<void>>();

export async function ensureRemoteReleaseDirFromManifest(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
    releaseBaseCandidatesForComponents: string[];
    requestedComponentIds: Set<string> | null;
    requiredReleasePaths: string[];
    forceRefresh?: boolean;
    remoteAssetNetwork?: RemoteAssetNetworkPort;
  },
  manifest: RemoteAssetManifest,
  loggers: RemoteAssetCacheLoggers,
): Promise<string> {
  const selectedComponents = selectManifestComponents(manifest, options.requestedComponentIds);
  const releaseDir = join(
    options.remoteCacheDir,
    "releases",
    options.version,
    options.platformArch,
    ...resolveContentAddressedReleaseSegments(selectedComponents, options.requestedComponentIds),
  );
  if (
    !options.forceRefresh &&
    (await isReadyReleaseDirForRequestedPaths(
      releaseDir,
      options.platformArch,
      options.requiredReleasePaths,
    ))
  ) {
    return releaseDir;
  }

  // 之前组装 releaseDir 会按 manifest 拉齐全部组件，即使后续远端版本检查会跳过。
  // 这里只落地本次部署明确需要的组件，避免主 server 升级时额外下载已最新的工具包。
  const componentCacheEntries: Array<{
    component: RemoteAssetManifestComponent;
    componentDir: string;
  }> = [];
  for (const component of selectedComponents) {
    const componentDir = await ensureRemoteComponentDirFromCdn(
      options,
      component,
      resolveRequiredComponentPaths(component, options.requiredReleasePaths),
      loggers,
      Boolean(options.forceRefresh),
    );
    componentCacheEntries.push({ component, componentDir });
  }

  await runWithReleaseMaterializeLock(releaseDir, async () => {
    await mkdir(releaseDir, { recursive: true });
    for (const { component, componentDir } of componentCacheEntries) {
      await materializeComponentIntoReleaseDir(
        component,
        componentDir,
        releaseDir,
        options.remoteCacheDir,
        options.platformArch,
      );
    }
    await writeFile(
      join(releaseDir, `${MANIFEST_FILE_NAME_PREFIX}${options.platformArch}.json`),
      `${JSON.stringify(manifest)}\n`,
      "utf8",
    );

    if (options.requestedComponentIds) {
      return;
    }

    if (!(await isValidReleaseDir(releaseDir, options.platformArch))) {
      throw new Error("[remote-assets] assembled release directory is invalid");
    }

    await writeReadyMarker(releaseDir, REMOTE_ASSET_READY_MARKER);
  });
  return releaseDir;
}

async function runWithReleaseMaterializeLock(
  releaseDir: string,
  task: () => Promise<void>,
): Promise<void> {
  const lockKey = resolve(releaseDir);
  const previousTask = remoteAssetReleaseMaterializeLocks.get(lockKey);

  const currentTask = (async () => {
    if (previousTask) {
      await previousTask.catch(() => {
        // 前一个写入失败不能阻塞后续重试；当前任务会重新物化自己的组件。
      });
    }
    await task();
  })();

  remoteAssetReleaseMaterializeLocks.set(lockKey, currentTask);
  try {
    await currentTask;
  } finally {
    if (remoteAssetReleaseMaterializeLocks.get(lockKey) === currentTask) {
      remoteAssetReleaseMaterializeLocks.delete(lockKey);
    }
  }
}

async function materializeComponentIntoReleaseDir(
  component: RemoteAssetManifestComponent,
  componentDir: string,
  releaseDir: string,
  remoteCacheDir: string,
  platformArch: string,
): Promise<void> {
  const stagingBaseDir = join(remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-release-component-${component.id}-${platformArch}-${process.pid}-${randomUUID()}`,
  );
  const componentStagingDir = join(stagingDir, "component");
  await mkdir(componentStagingDir, { recursive: true });

  try {
    await materializeDirectoryContents(componentDir, componentStagingDir);
    await assertExtractedArchiveNotEmpty(
      componentStagingDir,
      `[remote-assets] release component is empty for ${component.id}@${component.version}`,
    );
    const mountDir = resolvePathWithinBase(
      releaseDir,
      component.mount,
      `component ${component.id} mount`,
    );
    await commitStagingDirectoryAtomically(componentStagingDir, mountDir);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
