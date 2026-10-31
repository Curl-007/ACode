// 拆分依据：remoteAssetCache.ts 1928 行，超 400 行架构上限。manifest 响应解析与字段校验是
// 纯逻辑，独立成叶；被 fetch 链、安装器与身份检查共享。
import { normalizeRemoteAssetRelativePath } from "@acode/server/remote/remoteAssetCdn.js";
import {
  REMOTE_COMPONENT_MOUNT_RULES,
  type RemoteAssetManifest,
  type RemoteAssetManifestComponent,
} from "@acode/server/remote/remoteAssetCacheTypes.js";

export async function parseRemoteAssetManifestFromResponse(
  response: Response,
  sourceUrl: string,
  expectedAppVersion: string,
  expectedPlatformArch: string,
): Promise<RemoteAssetManifest> {
  const content = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`[remote-assets] invalid manifest json from ${sourceUrl}: ${String(error)}`);
  }
  if (!isObjectRecord(parsed)) {
    throw new Error(`[remote-assets] invalid manifest payload from ${sourceUrl}: expect object`);
  }

  const schemaVersion = readRequiredNumber(parsed, "schemaVersion", "manifest");
  if (!Number.isInteger(schemaVersion) || schemaVersion !== 1) {
    throw new Error(
      `[remote-assets] unsupported manifest schemaVersion=${schemaVersion} from ${sourceUrl}`,
    );
  }

  const appVersion = readRequiredString(parsed, "appVersion", "manifest");
  if (appVersion !== expectedAppVersion) {
    throw new Error(
      `[remote-assets] manifest appVersion mismatch from ${sourceUrl}: expected=${expectedAppVersion}, actual=${appVersion}`,
    );
  }

  const platformArch = readRequiredString(parsed, "platformArch", "manifest");
  if (platformArch !== expectedPlatformArch) {
    throw new Error(
      `[remote-assets] manifest platformArch mismatch from ${sourceUrl}: expected=${expectedPlatformArch}, actual=${platformArch}`,
    );
  }

  const rawComponents = parsed.components;
  if (!Array.isArray(rawComponents)) {
    throw new Error(`[remote-assets] manifest.components must be array from ${sourceUrl}`);
  }
  if (rawComponents.length === 0) {
    throw new Error(`[remote-assets] manifest.components is empty from ${sourceUrl}`);
  }

  const components: RemoteAssetManifestComponent[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawComponent] of rawComponents.entries()) {
    const context = `manifest.components[${index}]`;
    if (!isObjectRecord(rawComponent)) {
      throw new Error(`[remote-assets] ${context} must be object`);
    }

    const id = readRequiredString(rawComponent, "id", context);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
      throw new Error(`[remote-assets] ${context}.id is invalid: ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`[remote-assets] duplicate component id in manifest: ${id}`);
    }
    seenIds.add(id);

    const mountRule = REMOTE_COMPONENT_MOUNT_RULES[id];
    if (!mountRule) {
      // 旧 release manifest 可能仍包含已退役的三方 agent 组件。
      // 当前客户端只认识 ACode Agent 与基础运行时，未知组件应跳过，不能阻断当前组件下载。
      continue;
    }

    const version = readRequiredString(rawComponent, "version", context);
    assertSafePathSegment(version, `${context}.version`);

    const sha256 = readRequiredString(rawComponent, "sha256", context).toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error(`[remote-assets] ${context}.sha256 is invalid`);
    }

    const artifactPath = normalizeRemoteAssetRelativePath(
      readRequiredString(rawComponent, "artifactPath", context),
      `${context}.artifactPath`,
    );
    const mount = normalizeRemoteAssetRelativePath(
      readRequiredString(rawComponent, "mount", context),
      `${context}.mount`,
    );
    const expectedMount = normalizeRemoteAssetRelativePath(
      mountRule.resolveExpectedMount(expectedPlatformArch),
      `expected mount for ${id}`,
    );
    if (mount !== expectedMount) {
      throw new Error(
        `[remote-assets] ${context}.mount mismatch for ${id}: expected=${expectedMount}, actual=${mount}`,
      );
    }

    components.push({
      id,
      version,
      sha256,
      artifactPath,
      mount,
    });
  }

  return {
    schemaVersion,
    appVersion,
    platformArch,
    components,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(value: Record<string, unknown>, key: string, context: string): string {
  const fieldValue = value[key];
  if (typeof fieldValue !== "string") {
    throw new Error(`[remote-assets] ${context}.${key} must be string`);
  }
  const trimmed = fieldValue.trim();
  if (!trimmed) {
    throw new Error(`[remote-assets] ${context}.${key} is empty`);
  }
  return trimmed;
}

function readRequiredNumber(value: Record<string, unknown>, key: string, context: string): number {
  const fieldValue = value[key];
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
    throw new Error(`[remote-assets] ${context}.${key} must be finite number`);
  }
  return fieldValue;
}

export function assertSafePathSegment(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`[remote-assets] ${label} is empty`);
  }
  if (value.includes("/") || value.includes("\\")) {
    throw new Error(`[remote-assets] ${label} must be a single path segment: ${value}`);
  }
  if (value === "." || value === "..") {
    throw new Error(`[remote-assets] ${label} is invalid: ${value}`);
  }
}
