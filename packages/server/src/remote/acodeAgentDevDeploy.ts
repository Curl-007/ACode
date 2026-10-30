// 拆分说明：开发态资产发现/哈希/插件打包上传已移到 acodeAgentDevDeployAssets.ts（满足 400 行
// 架构上限）；本文件保留远端 skip 决策与 wrapper/版本标记的部署编排。公开符号不变。
import { ACODE_AGENT_PROVIDER } from "@acode/shared";
import type { IRemoteBackend } from "@acode/server/remote/backend.js";
import {
  buildRemoteExecutableReplaceCommand,
  buildRemoteMoveCommand,
  type DeployLoggers,
  waitForClose,
} from "@acode/server/remote/deployShared.js";
import {
  buildWriteLiteralFileCommand,
  quotePosixPathArg,
} from "@acode/server/remote/posixShell.js";
import {
  REMOTE_AGENT_BUNDLE_NAME,
  buildRemoteAgentBundleWrapper,
  isRemoteAgentBundleWrapperCurrent,
} from "@acode/server/remote/acodeAgentBundleWrapper.js";
import {
  deployRemoteAgentWrapper,
  isWslBackend,
} from "@acode/server/remote/acodeAgentWrapperDeploy.js";
import {
  computeDevelopmentAgentAssetsSha256,
  findMissingRemoteOfficialPluginAssetPaths,
  resolveDevelopmentAgentBundle,
  uploadDevelopmentOfficialPluginPackages,
} from "@acode/server/remote/acodeAgentDevDeployAssets.js";

const REMOTE_DEV_AGENT_BUNDLE_NAME = REMOTE_AGENT_BUNDLE_NAME;
const REMOTE_DEV_AGENT_VERSION_FILE_NAME = ".dev-version";

interface DeployDevelopmentACodeAgentRuntimeParams {
  runtimeVersion: string;
  runtimeResourceDir: string;
  remoteProviderDir: string;
  remoteVersionFile: string;
  remoteBinaryPath: string;
  force: boolean;
}

async function shouldSkipDevelopmentACodeAgentDeploy(params: {
  backend: IRemoteBackend;
  remoteVersionFile: string;
  remoteDevVersionFile: string;
  remoteBinaryPath: string;
  remoteBundlePath: string;
  runtimeResourceDir: string;
  runtimeVersion: string;
  devVersion: string;
  force: boolean;
  missingOfficialPluginAssetPaths: string[];
  loggers: DeployLoggers;
}): Promise<boolean> {
  if (params.force) {
    return false;
  }

  let remoteVersion: string;
  let remoteDevVersion: string;
  try {
    remoteVersion = (await params.backend.readFile(params.remoteVersionFile)).trim();
    remoteDevVersion = (await params.backend.readFile(params.remoteDevVersionFile)).trim();
  } catch {
    return false;
  }

  if (remoteVersion !== params.runtimeVersion || remoteDevVersion !== params.devVersion) {
    return false;
  }

  if (!(await params.backend.exists(params.remoteBinaryPath))) {
    return false;
  }

  if (isWslBackend(params.backend)) {
    try {
      const remoteWrapper = await params.backend.readFile(params.remoteBinaryPath);
      if (!isRemoteAgentBundleWrapperCurrent(remoteWrapper, params.runtimeResourceDir)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  if (!(await params.backend.exists(params.remoteBundlePath))) {
    return false;
  }

  if (params.missingOfficialPluginAssetPaths.length > 0) {
    return false;
  }

  params.loggers.log(`[acode-agent-deploy] ${ACODE_AGENT_PROVIDER}: 开发态 acode.cjs 未变化，跳过`);
  return true;
}

export async function deployDevelopmentACodeAgentRuntime(
  backend: IRemoteBackend,
  params: DeployDevelopmentACodeAgentRuntimeParams,
  loggers: DeployLoggers,
): Promise<boolean> {
  const developmentBundle = resolveDevelopmentAgentBundle();
  if (!developmentBundle) {
    return false;
  }

  const remoteBundlePath = `${params.remoteProviderDir}/${REMOTE_DEV_AGENT_BUNDLE_NAME}`;
  const remoteDevVersionFile = `${params.remoteProviderDir}/${REMOTE_DEV_AGENT_VERSION_FILE_NAME}`;
  const devVersion = await computeDevelopmentAgentAssetsSha256({
    localBundlePath: developmentBundle.localBundlePath,
    repoRoot: developmentBundle.repoRoot,
  });
  const missingOfficialPluginAssetPaths = await findMissingRemoteOfficialPluginAssetPaths({
    backend,
    remoteProviderDir: params.remoteProviderDir,
  });

  if (
    await shouldSkipDevelopmentACodeAgentDeploy({
      backend,
      remoteVersionFile: params.remoteVersionFile,
      remoteDevVersionFile,
      remoteBinaryPath: params.remoteBinaryPath,
      remoteBundlePath,
      runtimeResourceDir: params.runtimeResourceDir,
      runtimeVersion: params.runtimeVersion,
      devVersion,
      force: params.force,
      missingOfficialPluginAssetPaths,
      loggers,
    })
  ) {
    return true;
  }

  // 开发态 SSH 远端过去只会部署本地 acode.cjs，不会携带 packages/*-plugin。
  // builtin plugin seed 依赖 agent 包旁边的官方插件源资源，所以 dev 部署需要同步 bundle 与插件资源。
  // 本地修改 apps/acode-cli 后，远端测试仍运行滞后的发布包。这里改为上传 dev 启动时刚构建的
  // dist/acode.cjs，并用远端已部署的 node 包一层 wrapper 启动，保证 agent 仍运行在目标机器内。
  loggers.log(
    `[acode-agent-deploy] ${ACODE_AGENT_PROVIDER}: 开发态上传本地 acode.cjs ${devVersion.slice(0, 12)}`,
  );
  const mkdirStream = await backend.exec(`mkdir -p ${quotePosixPathArg(params.remoteProviderDir)}`);
  await waitForClose(mkdirStream);

  const remoteBundleTempPath = `${remoteBundlePath}.new`;
  await backend.upload(developmentBundle.localBundlePath, remoteBundleTempPath);
  const bundleStream = await backend.exec(
    buildRemoteMoveCommand(remoteBundleTempPath, remoteBundlePath),
  );
  await waitForClose(bundleStream);
  await uploadDevelopmentOfficialPluginPackages({
    backend,
    repoRoot: developmentBundle.repoRoot,
    remoteProviderDir: params.remoteProviderDir,
    loggers,
  });

  const wrapperContent = buildRemoteAgentBundleWrapper(params.runtimeResourceDir);
  const markerCommands = [
    buildWriteLiteralFileCommand(remoteDevVersionFile, devVersion),
    buildWriteLiteralFileCommand(params.remoteVersionFile, params.runtimeVersion),
  ];
  let markerStream;
  if (isWslBackend(backend)) {
    await deployRemoteAgentWrapper({
      backend,
      content: wrapperContent,
      remoteWrapperPath: params.remoteBinaryPath,
    });
    markerStream = await backend.exec(markerCommands.join(" && "));
  } else {
    const remoteWrapperTempPath = `${params.remoteBinaryPath}.new`;
    markerStream = await backend.exec(
      [
        buildWriteLiteralFileCommand(remoteWrapperTempPath, wrapperContent),
        buildRemoteExecutableReplaceCommand(remoteWrapperTempPath, params.remoteBinaryPath),
        ...markerCommands,
      ].join(" && "),
    );
  }
  await waitForClose(markerStream);
  loggers.log(
    `[acode-agent-deploy] ${ACODE_AGENT_PROVIDER}: 开发态部署完成 ${devVersion.slice(0, 12)}`,
  );
  return true;
}
