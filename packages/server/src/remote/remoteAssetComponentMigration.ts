// 拆分依据：remoteAssetCache.ts 1928 行，超 400 行架构上限。旧缓存迁移（hash 版本目录、
// 旧 release 目录按内容哈希前缀匹配）自成一体，独立成叶。
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  REMOTE_ASSET_READY_MARKER,
  type RemoteAssetCacheLoggers,
  type RemoteAssetManifestComponent,
} from "@acode/server/remote/remoteAssetCacheTypes.js";
import {
  extractContentHashPrefixFromComponentVersion,
  resolveRemoteAssetComponentCacheVersion,
  resolveComponentCacheRootDir,
} from "@acode/server/remote/remoteAssetCachePaths.js";
import {
  assertExtractedArchiveNotEmpty,
  commitStagingDirectoryAtomically,
  computePathContentSha256,
  isDirectoryPath,
  isReadyComponentDir,
  isReadyReleaseDir,
  materializeDirectoryContents,
  resolvePathWithinBase,
  writeReadyMarker,
} from "@acode/server/remote/remoteAssetCacheFs.js";

export async function tryMigrateComponentDirFromHashVersionComponentCache(
  options: {
    remoteCacheDir: string;
    platformArch: string;
  },
  component: RemoteAssetManifestComponent,
  componentDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<boolean> {
  const cacheVersion = resolveRemoteAssetComponentCacheVersion(component.version);

  const componentRootDir = resolveComponentCacheRootDir(
    options.remoteCacheDir,
    component,
    options.platformArch,
  );
  let entries: Dirent[];
  try {
    entries = await readdir(componentRootDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const legacyVersionPrefix = `${cacheVersion}+`;
  const candidates: Array<{ dir: string; version: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(legacyVersionPrefix)) {
      continue;
    }

    const candidateDir = join(componentRootDir, entry.name);
    if (resolve(candidateDir) === resolve(componentDir)) {
      continue;
    }
    if (!(await isReadyComponentDir(candidateDir))) {
      continue;
    }

    const candidateStat = await stat(candidateDir);
    candidates.push({
      dir: candidateDir,
      version: entry.name,
      mtimeMs: candidateStat.mtimeMs,
    });
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const candidate = candidates[0];
  if (!candidate) {
    return false;
  }

  // 旧版组件 cache 把内容 hash 拼进目录名（如 v0.11.1+abcd）。
  // 新版只按语义版本命中；即使线上旧 manifest 仍带 hash，也要先迁移到纯版本目录，
  // 避免同语义版本因为 hash 后缀不同反复下载。
  await migrateComponentSourceDir(
    candidate.dir,
    componentDir,
    component,
    `legacy component cache ${candidate.version}`,
    options.platformArch,
    options.remoteCacheDir,
    loggers,
  );
  return true;
}

export async function tryMigrateComponentDirFromLegacyReleaseCache(
  options: {
    remoteCacheDir: string;
    version: string;
    platformArch: string;
  },
  component: RemoteAssetManifestComponent,
  componentDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<boolean> {
  const expectedContentHashPrefix = extractContentHashPrefixFromComponentVersion(component.version);
  if (!expectedContentHashPrefix) {
    return false;
  }

  const releasesRootDir = join(options.remoteCacheDir, "releases");
  let releaseEntries: Dirent[];
  try {
    releaseEntries = await readdir(releasesRootDir, { withFileTypes: true });
  } catch {
    return false;
  }

  const legacyReleaseVersions = releaseEntries
    .filter((entry) => entry.isDirectory() && entry.name !== options.version)
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));

  for (const legacyVersion of legacyReleaseVersions) {
    const legacyReleaseDir = join(releasesRootDir, legacyVersion, options.platformArch);
    if (!(await isReadyReleaseDir(legacyReleaseDir, options.platformArch))) {
      continue;
    }

    const legacyComponentSourceDir = resolvePathWithinBase(
      legacyReleaseDir,
      component.mount,
      `legacy component ${component.id} mount`,
    );
    if (!(await isDirectoryPath(legacyComponentSourceDir))) {
      continue;
    }

    let legacyContentHash: string;
    try {
      legacyContentHash = await computePathContentSha256(legacyComponentSourceDir);
    } catch (error) {
      loggers.logWarn(
        `[remote-assets] skip legacy component migration for ${component.id}@${component.version} from ${legacyVersion}: ${String(error)}`,
      );
      continue;
    }
    if (!legacyContentHash.startsWith(expectedContentHashPrefix)) {
      continue;
    }

    await migrateComponentSourceDir(
      legacyComponentSourceDir,
      componentDir,
      component,
      `legacy release ${legacyVersion}`,
      options.platformArch,
      options.remoteCacheDir,
      loggers,
    );
    return true;
  }

  return false;
}

async function migrateComponentSourceDir(
  sourceDir: string,
  componentDir: string,
  component: RemoteAssetManifestComponent,
  sourceLabel: string,
  platformArch: string,
  remoteCacheDir: string,
  loggers: RemoteAssetCacheLoggers,
): Promise<void> {
  const stagingBaseDir = join(remoteCacheDir, "staging");
  await mkdir(stagingBaseDir, { recursive: true });
  const stagingDir = join(
    stagingBaseDir,
    `remote-component-migrate-${component.id}-${platformArch}-${component.version}-${process.pid}-${randomUUID()}`,
  );
  const componentStagingDir = join(stagingDir, "component");
  await mkdir(componentStagingDir, { recursive: true });

  try {
    // 迁移时仍走 staging + ready 原子提交，避免半成品目录被后续连接误判为可用 cache。
    await materializeDirectoryContents(sourceDir, componentStagingDir);
    await assertExtractedArchiveNotEmpty(
      componentStagingDir,
      `[remote-assets] migrated component source is empty for ${component.id}@${component.version}`,
    );
    await writeReadyMarker(componentStagingDir, REMOTE_ASSET_READY_MARKER);
    await commitStagingDirectoryAtomically(componentStagingDir, componentDir);
    loggers.log(
      `[remote-assets] migrated ${component.id}@${component.version} from ${sourceLabel}`,
    );
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
