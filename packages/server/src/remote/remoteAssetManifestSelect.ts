// 拆分依据：remoteAssetCache.ts 1928 行，超 400 行架构上限。manifest 组件选择与请求参数归一化
// 是纯逻辑，被 release 入口与物化链共享，独立成叶。
import { normalizeRemoteAssetRelativePath } from "@acode/server/remote/remoteAssetCdn.js";
import type {
  RemoteAssetManifest,
  RemoteAssetManifestComponent,
} from "@acode/server/remote/remoteAssetCacheTypes.js";

export function normalizeRequestedComponentIds(componentIds: string[] | undefined): Set<string> | null {
  if (!componentIds) {
    return null;
  }

  const normalizedIds = componentIds.map((componentId) => componentId.trim()).filter(Boolean);
  if (normalizedIds.length === 0) {
    return null;
  }

  for (const componentId of normalizedIds) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(componentId)) {
      throw new Error(`[remote-assets] component id is invalid: ${componentId}`);
    }
  }

  return new Set(normalizedIds);
}

export function normalizeRequiredReleasePaths(requiredReleasePaths: string[] | undefined): string[] {
  if (!requiredReleasePaths) {
    return [];
  }

  return Array.from(
    new Set(
      requiredReleasePaths
        .map((relativePath) =>
          normalizeRemoteAssetRelativePath(relativePath, "requiredReleasePath"),
        )
        .filter(Boolean),
    ),
  );
}

export function selectRemoteAssetManifestComponents(
  manifest: RemoteAssetManifest,
  componentIds?: string[],
): RemoteAssetManifestComponent[] {
  return selectManifestComponents(manifest, normalizeRequestedComponentIds(componentIds));
}

export function selectManifestComponents(
  manifest: RemoteAssetManifest,
  requestedComponentIds: Set<string> | null,
): RemoteAssetManifestComponent[] {
  if (!requestedComponentIds) {
    return manifest.components;
  }

  const selectedComponents = manifest.components.filter((component) =>
    requestedComponentIds.has(component.id),
  );
  const foundIds = new Set(selectedComponents.map((component) => component.id));
  const missingIds = Array.from(requestedComponentIds).filter(
    (componentId) => !foundIds.has(componentId),
  );
  if (missingIds.length > 0) {
    throw new Error(
      `[remote-assets] manifest is missing requested components: ${missingIds.join(", ")}`,
    );
  }

  return selectedComponents;
}
