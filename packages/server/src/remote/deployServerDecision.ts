// 拆分依据：deploy.ts 超 400 行架构上限。「是否需要部署」的裁决（版本/标记/SHA 实体检查）与
// 裁决后的执行编排（磁盘预检、强刷标记、逐组件部署）是独立链路，经显式上下文参数接入，
// 与 deployServer 的锁/manifest 门禁状态解耦。行为逐点等价（原 deployWithDecision 闭包体）。
import { ACODE_VERSION, type RemoteResourcePackageId } from "@acode/shared";
import type { IRemoteBackend, RemoteEnvironment, StdioStream } from "./backend.js";
import { deployACodeAgentRuntime } from "./acodeAgentDeploy.js";
import {
  deployNodePtyPrebuilds,
  deployNodeRuntime,
  logDeployRequired,
} from "@acode/server/remote/remoteAssetDeployDecision.js";
import { REMOTE_BASE, type DeployLoggers, type RemoteAssetDeployOptions } from "@acode/server/remote/deployShared.js";
import { selectRemoteAssetManifestComponents } from "@acode/server/remote/remoteAssetCache.js";
import { detectRemoteAssetTools } from "@acode/server/remote/remoteAssetPreflight.js";
import type { RemoteAssetInstallMode } from "@acode/shared";
import { quotePosixPathArg } from "@acode/server/remote/posixShell.js";
import { checkServerBundleRequiredMarkers } from "@acode/server/remote/serverBundleDeployCheck.js";
import { deployRuntimeTools } from "@acode/server/remote/runtimeToolDeploy.js";
import {
  fetchRemoteDownloadManifest,
  LocalUploadAssetInstaller,
  RemoteDownloadAssetInstaller,
  type RemoteAssetInstaller,
  type RemoteManifestRef,
} from "@acode/server/remote/remoteAssetInstaller.js";
import {
  checkRemoteAssetComponentIdentity,
  hasRemoteAssetComponentRefreshPending,
  markRemoteAssetComponentRefreshPending,
  writeRemoteAssetComponentMeta,
} from "@acode/server/remote/remoteAssetLiveIdentity.js";
import { preflightRemoteDeployDiskSpace } from "@acode/server/remote/remoteDeployDiskSpace.js";
import {
  resolveRequiredMockReleasePaths,
  SERVER_BUNDLE_COMPONENT_ID,
} from "@acode/server/remote/deployReleaseDir.js";

export type ServerDeployDecision =
  | { shouldDeploy: false }
  | {
      shouldDeploy: true;
      reason: string;
      appVersionChanged?: boolean;
    };

export async function checkServerDeployDecision(
  backend: IRemoteBackend,
  options: {
    platformArch: string;
    expectedSha256: string | null;
  },
  log: (...args: unknown[]) => void,
): Promise<ServerDeployDecision> {
  try {
    log("checking if deploy needed...");
    const nodePath = `${REMOTE_BASE}/node`;
    const exists = await backend.exists(nodePath);
    log("remote node exists:", exists);
    if (!exists) {
      return {
        shouldDeploy: true,
        reason: `remote file missing path=${nodePath}`,
      };
    }

    const serverPath = `${REMOTE_BASE}/acode-server.cjs`;
    const serverExists = await backend.exists(serverPath);
    log("remote server exists:", serverExists);
    if (!serverExists) {
      return {
        shouldDeploy: true,
        reason: `remote file missing path=${serverPath}`,
      };
    }

    // Check version
    log("checking remote version...");
    const stream = await backend.exec(
      `${quotePosixPathArg(nodePath)} ${quotePosixPathArg(serverPath)} --version`,
    );
    const version = (await collectStdout(stream)).trim();
    log("remote version:", JSON.stringify(version), "local:", ACODE_VERSION);
    if (version !== ACODE_VERSION) {
      return {
        shouldDeploy: true,
        reason: `remote server version mismatch remote=${version} expected=${ACODE_VERSION}`,
        appVersionChanged: true,
      };
    }
    const requiredFeatureDecision = await checkServerBundleRequiredMarkers(
      backend,
      nodePath,
      serverPath,
    );
    if (requiredFeatureDecision.shouldDeploy) {
      return requiredFeatureDecision;
    }
    if (options.expectedSha256) {
      const identityDecision = await checkRemoteAssetComponentIdentity(backend, {
        componentId: SERVER_BUNDLE_COMPONENT_ID,
        platformArch: options.platformArch,
        expectedIdentity: { sha256: options.expectedSha256 },
      });
      if (identityDecision.shouldDeploy) {
        return identityDecision;
      }
    }
    return { shouldDeploy: false };
  } catch (err) {
    log("checkServerDeployDecision error (will deploy):", err);
    return {
      shouldDeploy: true,
      reason: `remote deploy check failed: ${String(err)}`,
    };
  }
}

export interface ServerDeployExecutionContext {
  backend: IRemoteBackend;
  env: RemoteEnvironment;
  /** DeployOptions.force（content-addressed 资产强刷三条件之一）。 */
  force: boolean;
  platformArch: string;
  selectedResourcePackageIds: RemoteResourcePackageId[];
  installer: RemoteAssetInstaller;
  assetDeployOptions: RemoteAssetDeployOptions;
  /** 磁盘预检的 releaseDir 解析（全量选中资源包范围）。 */
  resolveReleaseDirForPreflight: () => Promise<string | null>;
  getExpectedComponentVersion: (componentId: string) => Promise<string | null>;
  resolveManifestComponentsForEstimate: () => Promise<readonly unknown[] | null>;
  log: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
}

/** 裁决后的部署执行（原 deployServer 内 deployWithDecision 闭包体，逐点等价）。 */
export async function executeServerDeployDecision(
  context: ServerDeployExecutionContext,
  serverDeployDecision: ServerDeployDecision,
  expectedServerBundleSha256: string | null,
): Promise<boolean> {
  const {
    backend,
    env,
    force,
    platformArch,
    selectedResourcePackageIds,
    installer,
    assetDeployOptions,
    resolveReleaseDirForPreflight,
    getExpectedComponentVersion,
    resolveManifestComponentsForEstimate,
    log,
    logWarn,
  } = context;
  const shouldDeployResourcePackage = (packageId: RemoteResourcePackageId): boolean =>
    selectedResourcePackageIds.includes(packageId);

  if (serverDeployDecision.shouldDeploy) {
    // 修复原因：远端磁盘不足的失败形态是中途 ENOSPC 并留下半成品部署目录。
    // 在任何远端写入（含强刷 pending marker）之前做 df 等价探测：余量必须
    // ≥ 7× 资产估算，不足即拒绝并解释（specs/remote-deploy-hardening.md R1）。
    await preflightRemoteDeployDiskSpace(backend, {
      requiredRelativePaths: resolveRequiredMockReleasePaths(
        platformArch,
        [...selectedResourcePackageIds],
      ),
      resolveReleaseDir: resolveReleaseDirForPreflight,
      manifestComponents: await resolveManifestComponentsForEstimate(),
      loggers: { log, logWarn },
    });
  }
  const hasPendingAppVersionRefresh = await hasRemoteAssetComponentRefreshPending(backend, {
    componentId: "glm",
    platformArch,
  });
  const shouldForceRefreshContentAddressedAssets =
    force ||
    hasPendingAppVersionRefresh ||
    (serverDeployDecision.shouldDeploy && serverDeployDecision.appVersionChanged === true);

  if (shouldForceRefreshContentAddressedAssets) {
    // server 会先于 GLM 更新；若后续步骤失败，下次连接时 server 版本
    // 已经匹配。必须持久化升级强刷状态，让重试继续绕过同 SHA cache，直到 GLM 成功覆盖 marker。
    await markRemoteAssetComponentRefreshPending(backend, {
      componentId: "glm",
      platformArch,
      appVersion: ACODE_VERSION,
    });
  }

  // Check if deploy is needed
  if (!serverDeployDecision.shouldDeploy) {
    log("skipped — remote version matches");
    // 主 server 版本相同只证明 node/acode-server.cjs 可启动，不代表随包工具仍存在。
    // glm 内容跟随 app/server 版本刷新；但 wrapper/bundle 被清理或开发态 bundle 变化时仍要按实体检查修复。
    if (shouldDeployResourcePackage("node-pty")) {
      await deployNodePtyPrebuilds(
        backend,
        env,
        {
          ...assetDeployOptions,
          platformArch,
          onlyIfMissing: true,
          installer,
        },
        { log, logWarn },
      );
    }
    await deployACodeAgentRuntime(
      backend,
      env,
      {
        ...assetDeployOptions,
        platformArch,
        installer,
        force: shouldForceRefreshContentAddressedAssets,
        selectedResourcePackageIds,
      },
      { log, logWarn },
    );
    await deployRuntimeTools(
      backend,
      env,
      {
        ...assetDeployOptions,
        platformArch,
        installer,
        selectedResourcePackageIds,
      },
      { log, logWarn },
    );
    return false;
  }

  await deployNodeRuntime(
    backend,
    {
      ...assetDeployOptions,
      platformArch,
      force,
      installer,
      expectedVersion: await getExpectedComponentVersion("node-runtime"),
    },
    { log, logWarn },
  );

  logDeployRequired({
    loggers: { logWarn },
    installer,
    componentId: SERVER_BUNDLE_COMPONENT_ID,
    reason: serverDeployDecision.reason,
  });
  await installer.installFile({
    componentId: SERVER_BUNDLE_COMPONENT_ID,
    sourceRelativePath: "server/acode-server.cjs",
    remotePath: `${REMOTE_BASE}/acode-server.cjs`,
    // App 版本变化是新的发布边界，不能只凭历史 cache 的 `.ready`
    // 判断 server-bundle 可复用；与 GLM 一致，必须重新下载并校验当前 manifest 制品。
    forceRefresh: shouldForceRefreshContentAddressedAssets,
  });
  if (expectedServerBundleSha256) {
    // App/version 相同不代表 server-bundle 制品相同。安装成功后才写
    // manifest SHA marker，避免失败重试把旧 server 误判成当前制品。
    await writeRemoteAssetComponentMeta(backend, {
      id: SERVER_BUNDLE_COMPONENT_ID,
      sha256: expectedServerBundleSha256,
      platformArch,
    });
  }
  log("server install done");

  if (shouldDeployResourcePackage("node-pty")) {
    await deployNodePtyPrebuilds(
      backend,
      env,
      {
        ...assetDeployOptions,
        platformArch,
        force,
        onlyIfMissing: false,
        installer,
        expectedVersion: await getExpectedComponentVersion("node-pty"),
      },
      { log, logWarn },
    );
  }

  log("all uploads complete");

  // 部署 ACode Agent runtime 到远程，历史资源包选择已在入口统一忽略。
  await deployACodeAgentRuntime(
    backend,
    env,
    {
      ...assetDeployOptions,
      platformArch,
      installer,
      // 旧版 App 会覆盖 agents/glm，却不会同步新版引入的 GLM SHA marker。
      // App 版本变化后该 marker 可能与实际 bundle 不一致，必须绕过 marker 与远端 cache，
      // 按当前 App 的 manifest 重新下载并部署；同 App 版本内仍按 SHA 精确判断。
      force: shouldForceRefreshContentAddressedAssets,
      selectedResourcePackageIds,
    },
    { log, logWarn },
  );
  await deployRuntimeTools(
    backend,
    env,
    {
      ...assetDeployOptions,
      platformArch,
      installer,
      selectedResourcePackageIds,
    },
    { log, logWarn },
  );

  return true;
}

/** installer 工厂：按 assetInstallMode 选择本地上传或远端下载实现（含延迟实例化）。 */
export function createRemoteAssetInstaller(
  backend: IRemoteBackend,
  options: RemoteAssetDeployOptions & {
    version: string;
    platformArch: string;
    assetInstallMode?: RemoteAssetInstallMode;
  },
  loggers: DeployLoggers,
  getPinnedRemoteManifest: (() => Promise<RemoteManifestRef>) | null = null,
): RemoteAssetInstaller {
  if (options.assetInstallMode !== "remote-download") {
    return new LocalUploadAssetInstaller(backend, options, loggers);
  }

  let remoteInstallerPromise: Promise<RemoteAssetInstaller> | null = null;
  let remoteManifestPromise: ReturnType<typeof fetchRemoteDownloadManifest> | null = null;
  const getRemoteManifest = (): ReturnType<typeof fetchRemoteDownloadManifest> => {
    if (getPinnedRemoteManifest) {
      return getPinnedRemoteManifest();
    }
    if (!remoteManifestPromise) {
      remoteManifestPromise = fetchRemoteDownloadManifest(options, loggers);
    }
    return remoteManifestPromise;
  };
  const getRemoteInstaller = async (): Promise<RemoteAssetInstaller> => {
    if (!remoteInstallerPromise) {
      remoteInstallerPromise = detectRemoteAssetTools(backend, loggers).then(
        (tools) =>
          new RemoteDownloadAssetInstaller(backend, options, tools, loggers, getRemoteManifest()),
      );
    }
    return remoteInstallerPromise;
  };

  return {
    mode: "remote-download",
    async resolveComponentVersion(componentId) {
      const manifestRef = await getRemoteManifest();
      return (
        selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.version ?? null
      );
    },
    async resolveComponentSha256(componentId) {
      const manifestRef = await getRemoteManifest();
      return (
        selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.sha256 ?? null
      );
    },
    async installFile(params) {
      const remoteInstaller = await getRemoteInstaller();
      await remoteInstaller.installFile(params);
    },
    async installDirectory(params) {
      const remoteInstaller = await getRemoteInstaller();
      await remoteInstaller.installDirectory(params);
    },
  };
}

function collectStdout(stream: StdioStream): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    stream.stdout.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    stream.onClose(() => resolve(data));
  });
}
