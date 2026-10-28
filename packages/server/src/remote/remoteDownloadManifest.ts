// 拆分依据：remoteAssetInstaller.ts 超 400 行架构上限。远端下载 manifest 的获取链（进程内
// single-flight 锁 + 多 CDN 候选回退 + 响应解析）独立于安装实现，独立成叶。
import {
  type DeployLoggers,
  type RemoteAssetDeployOptions,
} from "@acode/server/remote/deployShared.js";
import {
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
  resolveRemoteCdnBaseUrls,
} from "@acode/server/remote/remoteAssetCdn.js";
import {
  buildRemoteAssetManifestFileCandidates,
  createRemoteAssetManifestRequestSignal,
  parseRemoteAssetManifestFromResponse,
  type RemoteAssetManifest,
  type RemoteAssetManifestRef,
} from "@acode/server/remote/remoteAssetCache.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@acode/server/remote/remoteAssetNetwork.js";

export type RemoteManifestRef = RemoteAssetManifestRef;

const remoteDownloadManifestLocks = new Map<string, Promise<RemoteManifestRef>>();

export type RemoteDownloadAssetInstallerOptions = RemoteAssetDeployOptions & {
  version: string;
  platformArch: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteAssetNetwork?: RemoteAssetNetworkPort;
};

export async function fetchRemoteDownloadManifest(
  options: RemoteDownloadAssetInstallerOptions,
  loggers: DeployLoggers,
): Promise<RemoteManifestRef> {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls({
    remoteCdnBaseUrl: options.remoteCdnBaseUrl,
    remoteCdnBaseUrls: options.remoteCdnBaseUrls,
  });
  const lockKey = [
    options.version,
    options.platformArch,
    String(options.manifestRequestTimeoutMs ?? "default"),
    ...remoteCdnBaseUrls,
  ].join("::");
  const lockedTask = remoteDownloadManifestLocks.get(lockKey);
  if (lockedTask) {
    return lockedTask;
  }

  let task: Promise<RemoteManifestRef>;
  task = fetchRemoteDownloadManifestInternal(options, remoteCdnBaseUrls, loggers).finally(() => {
    if (remoteDownloadManifestLocks.get(lockKey) === task) {
      remoteDownloadManifestLocks.delete(lockKey);
    }
  });
  remoteDownloadManifestLocks.set(lockKey, task);
  return task;
}

async function fetchRemoteDownloadManifestInternal(
  options: RemoteDownloadAssetInstallerOptions,
  remoteCdnBaseUrls: string[],
  loggers: DeployLoggers,
): Promise<RemoteManifestRef> {
  const releaseBaseCandidates = buildReleaseBaseCandidates(remoteCdnBaseUrls, options.version);
  const manifestUrls = buildReleaseAssetUrlCandidates(
    releaseBaseCandidates,
    buildRemoteAssetManifestFileCandidates(options.platformArch),
  );
  const candidateErrors: string[] = [];

  for (const url of manifestUrls) {
    loggers.log(`[remote-assets] downloading manifest ${url}`);
    const signal = createRemoteAssetManifestRequestSignal(options.manifestRequestTimeoutMs);
    let response: Response;
    try {
      response = await resolveRemoteAssetFetch(options.remoteAssetNetwork)(url, {
        signal,
      });
    } catch (error) {
      candidateErrors.push(`${url} -> ${String(error)}`);
      loggers.logWarn(`[remote-assets] manifest candidate failed ${url}: ${String(error)}`);
      continue;
    }
    if (!response.ok) {
      if (response.status !== 404) {
        candidateErrors.push(`${url} -> HTTP ${response.status}`);
      }
      continue;
    }

    let manifest: RemoteAssetManifest;
    try {
      manifest = await parseRemoteAssetManifestFromResponse(
        response,
        url,
        options.version,
        options.platformArch,
      );
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
      // manifest 响应头成功不代表响应体会结束；body 超时后必须
      // 取消当前请求并尝试下一个 CDN，避免 remote-download 初始化永久挂起。
      loggers.logWarn(`[remote-assets] manifest candidate failed ${url}: ${String(error)}`);
      candidateErrors.push(`${url} -> ${String(error)}`);
      continue;
    }
    const manifestReleaseBase = resolveReleaseBaseByAssetUrl(url, releaseBaseCandidates);
    return {
      manifest,
      releaseBaseCandidatesForComponents: manifestReleaseBase
        ? [
            manifestReleaseBase,
            ...releaseBaseCandidates.filter((candidate) => candidate !== manifestReleaseBase),
          ]
        : releaseBaseCandidates,
    };
  }

  if (candidateErrors.length > 0) {
    // remote-download 过去丢弃每个 CDN 候选的 timeout/HTTP 诊断，
    // 最终只报 manifest not found，无法区分资源未发布与响应体半开。
    throw new Error(
      `[remote-assets] failed to fetch manifest for ${options.platformArch}: ${candidateErrors.join("; ")}`,
    );
  }
  throw new Error(`[remote-assets] manifest not found for ${options.platformArch}`);
}

function resolveReleaseBaseByAssetUrl(
  assetUrl: string,
  releaseBaseCandidates: string[],
): string | null {
  const matchedReleaseBases = releaseBaseCandidates
    .map((releaseBase) => releaseBase.replace(/\/+$/u, ""))
    .filter((releaseBase) => releaseBase.length > 0 && assetUrl.startsWith(`${releaseBase}/`))
    .sort((left, right) => right.length - left.length);
  return matchedReleaseBases[0] ?? null;
}
