// 拆分依据：remoteAssetCache.ts 1928 行，超 400 行架构上限。组件缓存目录/内容寻址 release 段
// 等路径解析是纯逻辑，被组件下载、迁移与 release 物化共享，独立成叶。
import { join } from "node:path";
import {
  CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS,
  REMOTE_COMPONENT_MOUNT_RULES,
  type RemoteAssetManifestComponent,
} from "@acode/server/remote/remoteAssetCacheTypes.js";

export function resolveComponentCacheDir(
  remoteCacheDir: string,
  component: RemoteAssetManifestComponent,
  platformArch: string,
): string {
  return join(
    resolveComponentCacheRootDir(remoteCacheDir, component, platformArch),
    usesRemoteAssetContentAddressedCacheIdentity(component.id)
      ? component.sha256
      : resolveRemoteAssetComponentCacheVersion(component.version),
  );
}

export function usesRemoteAssetContentAddressedCacheIdentity(componentId: string): boolean {
  return componentId in CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS;
}

export function resolveContentAddressedReleaseSegments(
  components: readonly RemoteAssetManifestComponent[],
  requestedComponentIds: ReadonlySet<string> | null,
): string[] {
  const segments: string[] = [];
  for (const componentId of Object.keys(CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS)) {
    // 兼容历史全量 release：未指定组件时只沿用原有 GLM 内容目录；server
    // 安装始终显式请求 server-bundle，因此仍会进入独立 SHA release。
    if (
      requestedComponentIds === null
        ? componentId !== "glm"
        : !requestedComponentIds.has(componentId)
    ) {
      continue;
    }
    const component = components.find((item) => item.id === componentId);
    const releaseDirName = CONTENT_ADDRESSED_COMPONENT_RELEASE_DIRS[componentId];
    if (component && releaseDirName) {
      segments.push(releaseDirName, component.sha256);
    }
  }
  return segments;
}

export function resolveRemoteAssetComponentCacheVersion(version: string): string {
  const contentHashPrefix = extractContentHashPrefixFromComponentVersion(version);
  if (!contentHashPrefix) {
    return version;
  }

  // 已发布 manifest 里的 component.version 仍是 vX+hash。
  // cache key 只看语义版本，因此在落盘目录层剥掉 hash；artifactPath/sha256 仍按 manifest 校验下载内容。
  return version.slice(0, -contentHashPrefix.length - 1);
}

export function extractContentHashPrefixFromComponentVersion(version: string): string | null {
  const plusIndex = version.lastIndexOf("+");
  if (plusIndex < 0 || plusIndex === version.length - 1) {
    return null;
  }

  const suffix = version.slice(plusIndex + 1).toLowerCase();
  return /^[a-f0-9]{12,64}$/u.test(suffix) ? suffix : null;
}

export function resolveComponentCacheRootDir(
  remoteCacheDir: string,
  component: RemoteAssetManifestComponent,
  platformArch: string,
): string {
  const mountRule = REMOTE_COMPONENT_MOUNT_RULES[component.id];
  if (!mountRule) {
    throw new Error(`[remote-assets] component id is not in local whitelist: ${component.id}`);
  }
  return mountRule.platformScoped
    ? join(remoteCacheDir, "components", component.id, platformArch)
    : join(remoteCacheDir, "components", component.id);
}

export function resolveRequiredComponentPaths(
  component: RemoteAssetManifestComponent,
  requiredReleasePaths: readonly string[],
): string[] {
  if (requiredReleasePaths.length === 0) {
    return [];
  }

  const mount = component.mount.replace(/\/+$/u, "");
  const requiredComponentPaths: string[] = [];
  for (const requiredReleasePath of requiredReleasePaths) {
    if (requiredReleasePath === mount) {
      continue;
    }
    if (requiredReleasePath.startsWith(`${mount}/`)) {
      requiredComponentPaths.push(requiredReleasePath.slice(mount.length + 1));
    }
  }
  return requiredComponentPaths;
}
