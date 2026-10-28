// 拆分依据：remoteAssetInstaller.ts 超 400 行架构上限。远端下载实现（按 manifest SHA/语义版本
// 隔离的远端 component cache + lock/heartbeat + 校验下载 + 原子替换）自成一体，独立成叶。
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { IRemoteBackend, StdioStream } from "@acode/server/remote/backend.js";
import {
  REMOTE_BASE,
  buildRemoteExecutableReplaceCommand,
  buildRemoteMoveCommand,
  type DeployLoggers,
  waitForClose,
} from "@acode/server/remote/deployShared.js";
import { quotePosixPathArg, quotePosixShellArg } from "@acode/server/remote/posixShell.js";
import { buildComponentArtifactUrlCandidates } from "@acode/server/remote/remoteAssetCdn.js";
import {
  resolveRemoteAssetComponentCacheVersion,
  selectRemoteAssetManifestComponents,
  usesRemoteAssetContentAddressedCacheIdentity,
  type RemoteAssetManifestComponent,
} from "@acode/server/remote/remoteAssetCache.js";
import type {
  RemoteAssetTools,
} from "@acode/server/remote/remoteAssetPreflight.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@acode/server/remote/remoteAssetNetwork.js";
import type { RemoteAssetInstaller } from "@acode/server/remote/remoteAssetInstallerInterface.js";
import {
  buildRemoteArtifactDownloadCommand,
  buildRemoteChecksumCommand,
  hashRemoteCacheSegment,
  quoteSafeSegment,
  throwIfRemoteAssetInstallAborted,
} from "@acode/server/remote/remoteAssetInstallCommands.js";
import {
  fetchRemoteDownloadManifest,
  type RemoteDownloadAssetInstallerOptions,
  type RemoteManifestRef,
} from "@acode/server/remote/remoteDownloadManifest.js";

interface RemoteComponentRef {
  component: RemoteAssetManifestComponent;
  componentDir: string;
  fromCache: boolean;
}

export class RemoteDownloadAssetInstaller implements RemoteAssetInstaller {
  readonly mode = "remote-download" as const;
  private readonly manifestPromise: Promise<RemoteManifestRef>;
  private readonly componentCache = new Map<string, Promise<RemoteComponentRef>>();
  private readonly forceRefreshComponentTasks = new Map<string, Promise<RemoteComponentRef>>();

  constructor(
    private readonly backend: IRemoteBackend,
    private readonly options: RemoteDownloadAssetInstallerOptions,
    private readonly tools: RemoteAssetTools,
    private readonly loggers: DeployLoggers,
    manifestPromise?: Promise<RemoteManifestRef>,
  ) {
    this.manifestPromise = manifestPromise ?? fetchRemoteDownloadManifest(options, loggers);
  }

  async installFile(params: {
    componentId: string;
    sourceRelativePath: string;
    remotePath: string;
    executable?: boolean;
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const componentRef = await this.ensureComponent(
      params.componentId,
      [],
      Boolean(params.forceRefresh),
    );
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const sourcePath = buildRemoteComponentSourcePath(componentRef, params.sourceRelativePath);
    const tempPath = `${params.remotePath}.new-${Date.now()}-${randomUUID()}`;
    const stream = await this.backend.exec(
      [
        `mkdir -p ${quotePosixPathArg(posix.dirname(params.remotePath))}`,
        `cp -f ${quotePosixPathArg(sourcePath)} ${quotePosixPathArg(tempPath)}`,
        params.executable
          ? buildRemoteExecutableReplaceCommand(tempPath, params.remotePath)
          : buildRemoteMoveCommand(tempPath, params.remotePath),
      ].join(" && "),
    );
    await waitForClose(stream);
  }

  async installDirectory(params: {
    componentId: string;
    sourceRelativePath: string;
    remoteDir: string;
    requiredRelativePaths?: string[];
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const componentRef = await this.ensureComponent(
      params.componentId,
      params.requiredRelativePaths,
      Boolean(params.forceRefresh),
    );
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const sourcePath = buildRemoteComponentSourcePath(componentRef, params.sourceRelativePath);
    const stagingDir = `${params.remoteDir}.new-${Date.now()}-${randomUUID()}`;
    // 最终目录的 remove + move 由 deployServer 的 install-root transaction lock 串行化；
    // 这里的 UUID staging 负责隔离 owner，并让异常清理保持局部。
    const requiredPathChecks = (params.requiredRelativePaths ?? []).map(
      (relativePath) =>
        `test -e ${quotePosixPathArg(`${params.remoteDir}/${relativePath.replace(/^\/+/u, "")}`)}`,
    );
    const stream = await this.backend.exec(
      [
        "set -eu",
        // 复制或最终替换失败时，原实现会永久遗留 `.new-*` 目录。
        // trap 仅删除本次 owner staging，不触碰其他并发部署者。
        `cleanup_staging() { rm -rf ${quotePosixPathArg(stagingDir)}; }`,
        "trap cleanup_staging EXIT HUP INT TERM",
        `rm -rf ${quotePosixPathArg(stagingDir)}`,
        `mkdir -p ${quotePosixPathArg(stagingDir)} ${quotePosixPathArg(posix.dirname(params.remoteDir))}`,
        `cp -R ${quotePosixPathArg(`${sourcePath}/.`)} ${quotePosixPathArg(stagingDir)}`,
        `rm -rf ${quotePosixPathArg(params.remoteDir)}`,
        buildRemoteMoveCommand(stagingDir, params.remoteDir),
        ...requiredPathChecks,
        "cleanup_staging",
        "trap - EXIT HUP INT TERM",
      ].join("\n"),
    );
    await waitForClose(stream);
  }

  async resolveComponentVersion(componentId: string): Promise<string | null> {
    const manifestRef = await this.manifestPromise;
    return (
      selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.version ?? null
    );
  }

  async resolveComponentSha256(componentId: string): Promise<string | null> {
    const manifestRef = await this.manifestPromise;
    return (
      selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.sha256 ?? null
    );
  }

  private async ensureComponent(
    componentId: string,
    requiredRelativePaths: readonly string[] = [],
    forceRefresh = false,
  ): Promise<RemoteComponentRef> {
    // GLM bundle 与官方插件来自同一个 component，但会依次调用两次安装。
    // 强制刷新若每次都绕过进程内 task，会连续删除并下载两次同一制品；同一次 installer
    // 生命周期内只强刷一次，并让后续 mount 复用这份已校验组件。
    const existing = forceRefresh
      ? this.forceRefreshComponentTasks.get(componentId)
      : this.componentCache.get(componentId);
    if (existing) {
      const componentRef = await existing;
      return this.ensureComponentHasRequiredPaths(componentRef, requiredRelativePaths);
    }
    const task = this.ensureComponentInternal(componentId, forceRefresh);
    this.componentCache.set(componentId, task);
    if (forceRefresh) {
      this.forceRefreshComponentTasks.set(componentId, task);
    }
    try {
      const componentRef = await task;
      return this.ensureComponentHasRequiredPaths(componentRef, requiredRelativePaths);
    } catch (error) {
      if (this.componentCache.get(componentId) === task) {
        this.componentCache.delete(componentId);
      }
      if (this.forceRefreshComponentTasks.get(componentId) === task) {
        this.forceRefreshComponentTasks.delete(componentId);
      }
      throw error;
    }
  }

  private async ensureComponentHasRequiredPaths(
    componentRef: RemoteComponentRef,
    requiredRelativePaths: readonly string[],
  ): Promise<RemoteComponentRef> {
    if (requiredRelativePaths.length === 0) {
      return componentRef;
    }

    const missingPaths = await this.findMissingComponentPaths(
      componentRef.componentDir,
      requiredRelativePaths,
    );
    if (missingPaths.length === 0 || !componentRef.fromCache) {
      return componentRef;
    }

    // 远端 component cache 的 key 只按语义版本命中；如果历史组件缓存缺少关键文件，
    // 部署层会反复把残缺 cache 复制回运行目录。
    // 这里在 cache hit 后按调用方声明的关键文件做完整性检查，缺失时清掉旧 ready/cache 并强制重下组件。
    this.loggers.logWarn(
      `[remote-assets] remote component cache incomplete: component=${componentRef.component.id} missing=${missingPaths.join(",")}; redownloading`,
    );
    await this.removeRemoteComponentCache(componentRef.componentDir);
    const task = this.ensureComponentInternal(componentRef.component.id);
    this.componentCache.set(componentRef.component.id, task);
    return await task;
  }

  private async findMissingComponentPaths(
    componentDir: string,
    requiredRelativePaths: readonly string[],
  ): Promise<string[]> {
    const missingPaths: string[] = [];
    for (const relativePath of requiredRelativePaths) {
      const remotePath = `${componentDir}/${relativePath.replace(/^\/+/u, "")}`;
      if (!(await this.backend.exists(remotePath))) {
        missingPaths.push(remotePath);
      }
    }
    return missingPaths;
  }

  private async removeRemoteComponentCache(componentDir: string): Promise<void> {
    const stream = await this.backend.exec(`rm -rf ${quotePosixPathArg(componentDir)}`);
    await waitForClose(stream);
  }

  private async ensureComponentInternal(
    componentId: string,
    forceRefresh = false,
  ): Promise<RemoteComponentRef> {
    const manifestRef = await this.manifestPromise;
    const component = selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0];
    if (!component) {
      throw new Error(`[remote-assets] manifest is missing requested component: ${componentId}`);
    }

    // server-bundle 和 GLM 都允许语义版本不变但制品内容更新，cache
    // 必须直接按 manifest SHA 隔离；其它资源包继续沿用原有语义版本 key。
    const componentCacheSegment = usesRemoteAssetContentAddressedCacheIdentity(component.id)
      ? component.sha256
      : hashRemoteCacheSegment(resolveRemoteAssetComponentCacheVersion(component.version));
    const componentDir = `${REMOTE_BASE}/asset-cache/components/${quoteSafeSegment(this.options.platformArch)}/${quoteSafeSegment(component.id)}/${componentCacheSegment}`;
    const readyPath = `${componentDir}/.ready`;
    if (await this.backend.exists(readyPath)) {
      if (forceRefresh) {
        // 强制部署要求真的重新下载制品：即使 cache 目录已按 manifest SHA 隔离，
        // 命中 ready 时也必须先清掉，否则会提前返回，把既有缓存当作本次部署结果。
        this.loggers.logWarn(
          `[remote-assets] download required: component=${component.id} reason=force refresh path=${readyPath}`,
        );
        await this.removeRemoteComponentCache(componentDir);
      } else {
        this.loggers.log(
          `[remote-assets] remote component cache hit: ${component.id}@${component.version}`,
        );
        return { component, componentDir, fromCache: true };
      }
    }

    if (!forceRefresh) {
      this.loggers.logWarn(
        `[remote-assets] download required: component=${component.id} reason=remote component cache missing path=${readyPath}`,
      );
    }
    const artifactUrls = buildComponentArtifactUrlCandidates(
      manifestRef.releaseBaseCandidatesForComponents,
      component.artifactPath,
      this.options.version,
    );
    const totalBytes = await resolveRemoteArtifactContentLength(
      artifactUrls,
      this.options.remoteAssetNetwork,
    );
    // HEAD 只服务进度统计，允许其独立收尾；完成后必须重新检查连接生命周期，
    // 禁止取消后的迟到 continuation 使用旧 backend 创建远端下载与 staging。
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const stagingDir = `${REMOTE_BASE}/asset-cache/staging/${quoteSafeSegment(component.id)}-${Date.now()}-${randomUUID()}`;
    const archivePath = `${stagingDir}/component.tar.gz`;
    const extractDir = `${stagingDir}/extract`;
    const componentNewDir = `${componentDir}.new-${Date.now()}-${randomUUID()}`;
    const lockDir = `${componentDir}.lock`;
    const quotedLockDir = quotePosixPathArg(lockDir);
    const cleanupCommand = `if [ -n "\${lock_heartbeat_pid:-}" ]; then kill "$lock_heartbeat_pid" >/dev/null 2>&1 || true; wait "$lock_heartbeat_pid" 2>/dev/null || true; fi; rm -rf ${quotedLockDir} ${quotePosixPathArg(stagingDir)} ${quotePosixPathArg(componentNewDir)}`;
    const downloadCommand = buildRemoteArtifactDownloadCommand({
      tool: this.tools.download,
      urls: artifactUrls,
      outputPath: archivePath,
      progressLabel: `${component.id}@${component.version}`,
      totalBytes,
      expectedSha256: component.sha256,
      sha256Tool: this.tools.sha256,
    });
    const checksumCommand = buildRemoteChecksumCommand({
      tool: this.tools.sha256,
      filePath: archivePath,
    });
    const checksumMismatchMessage = `[remote-assets] sha256 mismatch for ${component.id}@${component.version}`;
    const command = [
      "set -eu",
      `rm -rf ${quotePosixPathArg(stagingDir)}`,
      `mkdir -p ${quotePosixPathArg(stagingDir)} ${quotePosixPathArg(posix.dirname(componentDir))}`,
      // 远端下载中断可能留下 .lock 目录。持锁进程定期刷新 mtime，等待方只清理超过 10 分钟没有心跳的锁，
      // 避免用户断开后再次选择远端下载时一直等待，同时不误伤仍在慢速下载的正常进程。
      `while ! mkdir ${quotedLockDir} 2>/dev/null; do if [ -e ${quotePosixPathArg(readyPath)} ]; then rm -rf ${quotePosixPathArg(stagingDir)}; exit 0; fi; lock_mtime=$({ stat -c %Y ${quotedLockDir} || stat -f %m ${quotedLockDir}; } 2>/dev/null || printf 0); lock_now=$(date +%s); if [ "$lock_mtime" -gt 0 ] && [ $((lock_now - lock_mtime)) -ge 600 ]; then echo ${quotePosixShellArg(`[remote-assets] stale lock for ${component.id}@${component.version}, retrying`)} >&2; rm -rf ${quotedLockDir}; continue; fi; sleep 1; done`,
      `lock_heartbeat_pid=; (while :; do touch ${quotedLockDir} 2>/dev/null || exit 0; sleep 30; done) & lock_heartbeat_pid=$!`,
      `trap ${quotePosixShellArg(cleanupCommand)} EXIT`,
      `if [ -e ${quotePosixPathArg(readyPath)} ]; then exit 0; fi`,
      downloadCommand,
      `actual_sha=$(${checksumCommand})`,
      `if [ "$actual_sha" != ${quotePosixShellArg(component.sha256)} ]; then echo ${quotePosixShellArg(checksumMismatchMessage)} >&2; exit 1; fi`,
      `mkdir -p ${quotePosixPathArg(extractDir)}`,
      `${this.tools.tar} -xzf ${quotePosixPathArg(archivePath)} -C ${quotePosixPathArg(extractDir)}`,
      `test "$(find ${quotePosixPathArg(extractDir)} -mindepth 1 -maxdepth 1 | head -n 1)"`,
      `printf ready > ${quotePosixPathArg(`${extractDir}/.ready`)}`,
      `rm -rf ${quotePosixPathArg(componentNewDir)}`,
      buildRemoteMoveCommand(extractDir, componentNewDir),
      `rm -rf ${quotePosixPathArg(componentDir)}`,
      buildRemoteMoveCommand(componentNewDir, componentDir),
      cleanupCommand,
      "trap - EXIT",
    ].join(" && ");

    this.loggers.log(`[remote-assets] remote downloading ${component.id}@${component.version}`);
    const stream = await this.backend.exec(command);
    forwardRemoteDownloadProgressLogs(stream, this.loggers);
    await waitForClose(stream);
    return { component, componentDir, fromCache: false };
  }
}

function buildRemoteComponentSourcePath(
  ref: RemoteComponentRef,
  releaseRelativePath: string,
): string {
  const mount = ref.component.mount.replace(/\/+$/u, "");
  const normalizedSource = releaseRelativePath.replace(/^\/+|\/+$/gu, "");
  const relativeInsideComponent =
    normalizedSource === mount
      ? "."
      : normalizedSource.startsWith(`${mount}/`)
        ? normalizedSource.slice(mount.length + 1)
        : normalizedSource;
  return relativeInsideComponent === "."
    ? `${ref.componentDir}/.`
    : `${ref.componentDir}/${relativeInsideComponent}`;
}

async function resolveRemoteArtifactContentLength(
  urls: string[],
  network?: RemoteAssetNetworkPort,
): Promise<number | null> {
  const fetchImpl = resolveRemoteAssetFetch(network);
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { method: "HEAD" });
      if (!response.ok) {
        continue;
      }
      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength != null) {
        return contentLength;
      }
    } catch {
      // HEAD 只用于连接日志进度总量；失败时下载本身仍按 curl/wget 候选继续执行。
    }
  }
  return null;
}

function parseContentLength(contentLengthHeader: string | null): number | null {
  if (!contentLengthHeader) {
    return null;
  }
  const parsed = Number.parseInt(contentLengthHeader, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function forwardRemoteDownloadProgressLogs(stream: StdioStream, loggers: DeployLoggers): void {
  let bufferedStdout = "";
  stream.stdout.on("data", (chunk: Buffer | string) => {
    bufferedStdout += chunk.toString();
    const lines = bufferedStdout.split(/\r?\n/u);
    bufferedStdout = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^download progress:/iu.test(trimmed)) {
        loggers.log(trimmed);
      }
    }
  });
  stream.onClose(() => {
    const trimmed = bufferedStdout.trim();
    if (/^download progress:/iu.test(trimmed)) {
      loggers.log(trimmed);
    }
  });
}
