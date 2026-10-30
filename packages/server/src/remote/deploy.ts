// 拆分说明（满足 400 行架构上限）：部署入口按职责分叶，本文件保留公开面与编排主干：
// - deployReleaseDir.ts：releaseDir 解析链（mock-cdn → 完整性检查 → CDN/cache 回退）
// - deployServerDecision.ts：是否需要部署的裁决 + 裁决后的执行编排 + installer 工厂。
import {
  ACODE_VERSION,
  formatLogPrefix,
  normalizeRemoteResourcePackageSelection,
  type RemoteAssetInstallMode,
  type RemoteResourcePackageSelection,
} from "@acode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "./backend.js";
import { createRemoteComponentVersionResolver } from "@acode/server/remote/remoteAssetDeployDecision.js";
import { formatOptionalValue, formatOptionalValues } from "@acode/server/remote/deployShared.js";
import {
  selectRemoteAssetManifestComponents,
  type RemoteAssetManifestRef,
} from "@acode/server/remote/remoteAssetCache.js";
import {
  fetchRemoteDownloadManifest,
  type RemoteManifestRef,
} from "@acode/server/remote/remoteAssetInstaller.js";
import { createFreshRemoteAssetManifestRefResolver } from "@acode/server/remote/remoteAssetLiveIdentity.js";
import { assertSupportedRemoteEnvironment } from "@acode/server/remote/remotePlatformSupport.js";
import { acquireRemoteDeployLock } from "@acode/server/remote/remoteDeployLock.js";
import type { RemoteAssetNetworkPort } from "@acode/server/remote/remoteAssetNetwork.js";
import {
  createRemoteAssetManifestGuard,
  type RemoteAssetManifestSignatureVerifier,
} from "@acode/server/remote/remoteAssetManifestSignature.js";
import {
  buildReleaseDirCacheKey,
  findMissingMockReleasePaths,
  hasRemoteAssetCdnFallback,
  resolveMockCdnReleaseDir,
  resolveReleaseDir,
  SERVER_BUNDLE_COMPONENT_ID,
} from "@acode/server/remote/deployReleaseDir.js";
import {
  checkServerDeployDecision,
  createRemoteAssetInstaller,
  executeServerDeployDecision,
  type ServerDeployExecutionContext,
} from "@acode/server/remote/deployServerDecision.js";

const log = (...args: unknown[]) => console.log(formatLogPrefix("deploy", process.pid), ...args);
const logWarn = (...args: unknown[]) =>
  console.warn(formatLogPrefix("deploy", process.pid), ...args);

export type DeployLockMode = "remote" | "caller-serialized";

export interface DeployOptions {
  /** 取消当前远端连接初始化与其拥有的上传。 */
  signal?: AbortSignal;
  /** 开发态本地“伪 CDN”目录，运行时从这里读取 remote 资源 */
  mockCdnDir?: string;
  /** 生产态 remote 资源 CDN 基址 */
  remoteCdnBaseUrl?: string;
  /** 生产态 remote 资源 CDN 基址候选，按顺序回退 */
  remoteCdnBaseUrls?: string[];
  /** 生产态 remote 资源缓存目录 */
  remoteCacheDir?: string;
  /** 单个 manifest CDN 候选请求的超时时间，默认 10 秒。 */
  manifestRequestTimeoutMs?: number;
  /** Desktop Host 注入的远程资源 HTTP(S) 出口；standalone 未注入时保持直连。 */
  remoteAssetNetwork?: RemoteAssetNetworkPort;
  /** Force deploy even if versions match */
  force?: boolean;
  /** 等待远端 install-root deploy lock 的总 deadline，默认 120 秒。 */
  deployLockAcquireTimeoutMs?: number;
  /** 部署串行化边界；默认由远端 install-root lock 保证。 */
  deployLockMode?: DeployLockMode;
  /** SSH-only remote asset install strategy. */
  assetInstallMode?: RemoteAssetInstallMode;
  /** 只在选中资源包范围内做远端部署检查、下载和上传。 */
  resourcePackages?: RemoteResourcePackageSelection;
  /**
   * manifest 验签接口（预留；钉扎公钥管理属发布管线，见
   * specs/remote-deploy-hardening.md R3）。缺省 not-configured：记录一次并放行；
   * 注入的 verifier 返回 invalid 或自身抛错时拒绝部署。
   */
  manifestSignatureVerifier?: RemoteAssetManifestSignatureVerifier;
}

/**
 * Deploy the acode server to the remote machine.
 * Uploads Node.js binary, server bundle, and node-pty prebuild.
 *
 * Returns true if a deploy was performed, false if skipped (version matches).
 */
export async function deployServer(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options?: DeployOptions,
): Promise<boolean> {
  const platformArch = `${env.platform}-${env.arch}`;
  assertSupportedRemoteEnvironment(env);
  const selectedResourcePackageIds = normalizeRemoteResourcePackageSelection();
  const componentResolverOptions = {
    mockCdnDir: options?.mockCdnDir,
    remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
    remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
    remoteCacheDir: options?.remoteCacheDir,
    manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
    remoteAssetNetwork: options?.remoteAssetNetwork,
  };
  const resolveFreshAssetManifestRef = createFreshRemoteAssetManifestRefResolver(
    componentResolverOptions,
    env,
    {
      log,
      logWarn,
    },
  );
  const resolveFreshCdnManifestRef = createFreshRemoteAssetManifestRefResolver(
    { ...componentResolverOptions, mockCdnDir: undefined },
    env,
    { log, logWarn },
  );
  // manifest 门禁（验签状态 + server-cli↔desktop 兼容窗）：deploy 可见的三条
  // manifest 获取路径共用同一 memoized 裁决；invalid/窗外在任何远端写入前拒绝。
  const manifestGuard = createRemoteAssetManifestGuard({
    currentVersion: ACODE_VERSION,
    signatureVerifier: options?.manifestSignatureVerifier,
    loggers: { log, logWarn },
  });
  let remoteManifestPromise: Promise<RemoteManifestRef> | null = null;
  const getRemoteManifestRef = (): Promise<RemoteManifestRef> => {
    remoteManifestPromise ??= fetchRemoteDownloadManifest(
      {
        version: ACODE_VERSION,
        platformArch,
        remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
        remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
        manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
        remoteAssetNetwork: options?.remoteAssetNetwork,
      },
      { log, logWarn },
    ).then(async (manifestRef) => {
      await manifestGuard.inspect(manifestRef.manifest, { source: "cdn" });
      return manifestRef;
    });
    return remoteManifestPromise;
  };
  let localManifestRefPromise: Promise<RemoteAssetManifestRef | null> | null = null;
  const getLocalManifestRef = (): Promise<RemoteAssetManifestRef | null> => {
    // deploy lock 可能等待较久；在获锁前就启动 fresh manifest
    // 会让等待者用旧 SHA 覆盖新 owner 的部署。改为锁内首次需要时才固定，
    // 后续 GLM 身份判断与 release materialize 仍复用同一份快照。
    localManifestRefPromise ??= resolveFreshAssetManifestRef().then(async (manifestRef) => {
      if (manifestRef) {
        await manifestGuard.inspect(manifestRef.manifest, { source: "local-cache" });
      }
      return manifestRef;
    });
    return localManifestRefPromise;
  };
  const getManifestRefForComponents = async (
    componentIds?: string[],
  ): Promise<RemoteAssetManifestRef | null> => {
    if (options?.assetInstallMode === "remote-download") {
      return getRemoteManifestRef();
    }
    const mockReleaseDir = resolveMockCdnReleaseDir(options?.mockCdnDir);
    if (!mockReleaseDir) {
      return getLocalManifestRef();
    }
    const missingMockPaths = await findMissingMockReleasePaths(
      mockReleaseDir,
      platformArch,
      componentIds,
    );
    if (missingMockPaths.length > 0 && hasRemoteAssetCdnFallback(options)) {
      // mock manifest 存在不等于该 component 的文件完整。
      // 回退 CDN 时，SHA 跳过判断与 release materialize 必须共用同一份 CDN 快照。
      const cdnManifestRef = await resolveFreshCdnManifestRef();
      if (cdnManifestRef) {
        await manifestGuard.inspect(cdnManifestRef.manifest, { source: "cdn" });
      }
      return cdnManifestRef;
    }
    return getLocalManifestRef();
  };
  const resolvedReleaseDirs = new Map<string, string | null>();
  const getReleaseDir = async (
    componentIds?: string[],
    resolutionOptions?: { forceRefresh?: boolean },
  ): Promise<string | null> => {
    const forceRefresh = Boolean(resolutionOptions?.forceRefresh);
    const cacheKey = buildReleaseDirCacheKey(componentIds, forceRefresh);
    if (resolvedReleaseDirs.has(cacheKey)) {
      return resolvedReleaseDirs.get(cacheKey) ?? null;
    }
    const releaseDir = await resolveReleaseDir(
      options,
      env,
      { log, logWarn },
      componentIds,
      await getManifestRefForComponents(componentIds),
      forceRefresh,
    );
    resolvedReleaseDirs.set(cacheKey, releaseDir);
    log(
      "releaseDir:",
      releaseDir ?? "<missing>",
      "components:",
      componentIds?.join(",") ?? "<all>",
    );
    return releaseDir;
  };
  const getComponentSha256 = async (componentId: string): Promise<string | null> => {
    const manifestRef = await getManifestRefForComponents([componentId]);
    return manifestRef
      ? (selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.sha256 ??
          null)
      : null;
  };
  const assetDeployOptions = {
    signal: options?.signal,
    resolveReleaseDir: getReleaseDir,
    resolveComponentSha256: getComponentSha256,
    remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
    remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
    remoteCacheDir: options?.remoteCacheDir,
    manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
    remoteAssetNetwork: options?.remoteAssetNetwork,
  };
  const getComponentVersion = createRemoteComponentVersionResolver(componentResolverOptions, env, {
    log,
    logWarn,
  });
  const installer = createRemoteAssetInstaller(
    backend,
    {
      ...assetDeployOptions,
      platformArch,
      version: ACODE_VERSION,
      assetInstallMode: options?.assetInstallMode,
    },
    { log, logWarn },
    options?.assetInstallMode === "remote-download" ? getRemoteManifestRef : null,
  );
  const getExpectedComponentVersion = async (componentId: string): Promise<string | null> => {
    if (installer.resolveComponentVersion) {
      const installerVersion = await installer.resolveComponentVersion(componentId);
      if (installerVersion) {
        return installerVersion;
      }
    }

    // 开发态 mock-cdn 的 manifest 由 LocalUploadAssetInstaller 读取；
    // 之前部署决策只走 CDN resolver，mock-cdn 分支拿不到 expectedVersion，
    // 导致主 server 需要刷新时反复把已匹配的 node-runtime 全量上传。
    return getComponentVersion(componentId);
  };

  log("mockCdnDir:", options?.mockCdnDir ?? "<missing>");
  log("remoteCdnBaseUrl:", formatOptionalValue(options?.remoteCdnBaseUrl));
  log("remoteCdnBaseUrls:", formatOptionalValues(options?.remoteCdnBaseUrls));
  log("remoteCacheDir:", formatOptionalValue(options?.remoteCacheDir));
  log("remote env:", platformArch);
  log("selected remote resource packages:", selectedResourcePackageIds.join(","));

  const resolveManifestComponentsForEstimate = async (): Promise<readonly unknown[] | null> => {
    // 磁盘估算的 sizeBytes 回退只读 manifest 组件声明（发布管线登记字段）；
    // 获取失败不得成为预检的新失败源，退化为 null 走 release dir stat 路径。
    try {
      const manifestRef = await getManifestRefForComponents([...selectedResourcePackageIds]);
      return manifestRef?.manifest.components ?? null;
    } catch {
      return null;
    }
  };

  // 原 deployWithDecision 闭包体（裁决后的逐组件执行）移至 deployServerDecision.ts；
  // 闭包捕获经显式上下文参数传入，行为逐点等价。
  const deployContext: ServerDeployExecutionContext = {
    backend,
    env,
    force: Boolean(options?.force),
    platformArch,
    selectedResourcePackageIds,
    installer,
    assetDeployOptions,
    resolveReleaseDirForPreflight: () => getReleaseDir([...selectedResourcePackageIds]),
    getExpectedComponentVersion,
    resolveManifestComponentsForEstimate,
    log,
    logWarn,
  };

  const deployUsingCurrentRemoteState = async (): Promise<boolean> => {
    const expectedServerBundleSha256 = await getComponentSha256(SERVER_BUNDLE_COMPONENT_ID);
    const decision = options?.force
      ? {
          shouldDeploy: true,
          reason: "force deploy requested",
        }
      : await checkServerDeployDecision(backend, {
          platformArch,
          expectedSha256: expectedServerBundleSha256,
        }, log);
    return executeServerDeployDecision(deployContext, decision, expectedServerBundleSha256);
  };

  if (options?.deployLockMode === "caller-serialized") {
    // 桌面 SSH 已由窗口级 shared Host readiness 保证同一 target 只有一个部署事务；
    // 若仍创建 remote lock-holder，会为无额外互斥收益的路径长期占用 SSH channel。
    // 该模式必须由已具备 single-flight 的调用方显式注入，WSL/Docker 和其他调用继续默认远端锁。
    return deployUsingCurrentRemoteState();
  }

  const preLockDecision = options?.force
    ? { shouldDeploy: true as const, reason: "force deploy requested" }
    : await checkServerDeployDecision(backend, {
        platformArch,
        expectedSha256: null,
      }, log);
  if (preLockDecision.shouldDeploy) {
    log(`waiting for install-root lock: ${preLockDecision.reason}`);
  }
  const deployLock = await acquireRemoteDeployLock(backend, {
    acquireTimeoutMs: options?.deployLockAcquireTimeoutMs,
  });
  let deployOutcome: { ok: true; value: boolean } | { ok: false; error: unknown };
  try {
    // 进程内 WSL single-flight 无法覆盖不同 Desktop/build/backend。
    // 获得远端 install-root lock 后必须重新检查，等待者不能按过期判断重复覆盖部署目录。
    deployOutcome = {
      ok: true,
      value: await deployUsingCurrentRemoteState(),
    };
  } catch (error) {
    deployOutcome = { ok: false, error };
  }

  let releaseOutcome: { ok: true } | { ok: false; error: unknown };
  try {
    await deployLock.release();
    releaseOutcome = { ok: true };
  } catch (error) {
    releaseOutcome = { ok: false, error };
  }
  if (!deployOutcome.ok && !releaseOutcome.ok) {
    // finally 内直接抛 release 错误会覆盖真正的部署失败，排障只能看到次生症状。
    // AggregateError 同时保留 deploy 与 release 两条因果链，且 release deadline 保证这里有界返回。
    throw new AggregateError(
      [deployOutcome.error, releaseOutcome.error],
      "remote deployment and deploy-lock release both failed",
    );
  }
  if (!deployOutcome.ok) {
    throw deployOutcome.error;
  }
  if (!releaseOutcome.ok) {
    throw releaseOutcome.error;
  }
  return deployOutcome.value;
}
