// 拆分依据：remoteAssetInstaller.ts 超 400 行架构上限。本地上传实现（本地 release 解析 →
// staging 上传 → 原子替换；目录走 tar.gz）自成一体，只依赖共享命令叶子，独立成叶。
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import type { IRemoteBackend } from "@acode/server/remote/backend.js";
import {
  buildRemoteExecutableReplaceCommand,
  buildRemoteMoveCommand,
  createRemoteAssetPlaceholderError,
  fileExists,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
  waitForClose,
} from "@acode/server/remote/deployShared.js";
import { quotePosixPathArg } from "@acode/server/remote/posixShell.js";
import {
  ensureRemoteReleaseDirFromCdn,
  selectRemoteAssetManifestComponents,
  type RemoteAssetManifest,
  type RemoteAssetManifestComponent,
} from "@acode/server/remote/remoteAssetCache.js";
import { createTarGzArchive } from "@acode/server/remote/localTarGz.js";
import type { RemoteAssetInstaller } from "@acode/server/remote/remoteAssetInstallerInterface.js";
import {
  buildRequiredReleasePaths,
  buildStaleRemoteStagingCleanupCommand,
  findMissingLocalRequiredReleasePaths,
  throwIfRemoteAssetInstallAborted,
} from "@acode/server/remote/remoteAssetInstallCommands.js";

export class LocalUploadAssetInstaller implements RemoteAssetInstaller {
  readonly mode = "local-download-upload" as const;

  constructor(
    private readonly backend: IRemoteBackend,
    private readonly options: RemoteAssetDeployOptions & {
      platformArch?: string;
      version?: string;
    },
    private readonly loggers: DeployLoggers,
  ) {}

  async resolveComponentVersion(componentId: string): Promise<string | null> {
    return (await this.resolveManifestComponent(componentId))?.version ?? null;
  }

  async resolveComponentSha256(componentId: string): Promise<string | null> {
    const resolvedSha256 = await this.options.resolveComponentSha256?.(componentId);
    if (resolvedSha256) {
      return resolvedSha256;
    }
    return (await this.resolveManifestComponent(componentId))?.sha256 ?? null;
  }

  private async resolveManifestComponent(
    componentId: string,
  ): Promise<RemoteAssetManifestComponent | null> {
    const platformArch = this.options.platformArch?.trim();
    const releaseDir =
      this.options.releaseDir?.trim() ??
      (await this.options.resolveReleaseDir?.([componentId]))?.trim();
    if (!platformArch || !releaseDir) {
      return null;
    }

    try {
      const manifest = JSON.parse(
        readFileSync(join(releaseDir, `manifest-${platformArch}.json`), "utf8"),
      ) as RemoteAssetManifest;
      return selectRemoteAssetManifestComponents(manifest, [componentId])[0] ?? null;
    } catch {
      return null;
    }
  }

  async tryResolveLocalPath(
    componentIds: string[],
    sourceRelativePath: string,
    requiredReleasePaths?: string[],
    forceRefresh = false,
  ): Promise<string | null> {
    const releaseDir =
      this.options.releaseDir ??
      (await this.options.resolveReleaseDir?.(componentIds, {
        forceRefresh,
      })) ??
      null;
    if (!releaseDir) {
      return null;
    }

    const localPath = join(releaseDir, sourceRelativePath);
    if (await fileExists(localPath)) {
      const missingRequiredPaths = await findMissingLocalRequiredReleasePaths(
        releaseDir,
        requiredReleasePaths,
      );
      if (missingRequiredPaths.length === 0) {
        return localPath;
      }
      // 旧 cache 可能已经有 packages 父目录，但缺少本次部署要求的 plugin.json。
      // 这里不能只看父目录存在，否则会继续上传残缺官方插件资源。
      this.loggers.logWarn(
        `[remote-assets] local release asset incomplete: source=${localPath} missing=${missingRequiredPaths.join(",")}; trying CDN cache fallback`,
      );
    }

    const cdnReleaseDir = await this.tryResolveCdnReleaseDir(
      componentIds,
      requiredReleasePaths,
      forceRefresh,
    );
    if (!cdnReleaseDir) {
      return null;
    }
    const cdnLocalPath = join(cdnReleaseDir, sourceRelativePath);
    if (!(await fileExists(cdnLocalPath))) {
      return null;
    }
    const missingCdnRequiredPaths = await findMissingLocalRequiredReleasePaths(
      cdnReleaseDir,
      requiredReleasePaths,
    );
    if (missingCdnRequiredPaths.length > 0) {
      this.loggers.logWarn(
        `[remote-assets] CDN release asset incomplete: source=${cdnLocalPath} missing=${missingCdnRequiredPaths.join(",")}`,
      );
      return null;
    }
    return cdnLocalPath;
  }

  async resolveLocalPath(
    componentIds: string[],
    sourceRelativePath: string,
    requiredReleasePaths?: string[],
    forceRefresh = false,
  ): Promise<string> {
    const localPath = await this.tryResolveLocalPath(
      componentIds,
      sourceRelativePath,
      requiredReleasePaths,
      forceRefresh,
    );
    if (localPath) {
      return localPath;
    }

    const releaseDir =
      this.options.releaseDir ??
      (await this.options.resolveReleaseDir?.(componentIds, {
        forceRefresh,
      })) ??
      null;
    if (!releaseDir) {
      throw createRemoteAssetPlaceholderError(
        this.options.platformArch ?? "<unknown>",
        this.options,
        componentIds.join(","),
      );
    }
    throw new Error(
      `[deploy] local remote asset not found: ${join(releaseDir, sourceRelativePath)} (component=${componentIds.join(",")})`,
    );
  }

  async installFile(params: {
    componentId: string;
    sourceRelativePath: string;
    remotePath: string;
    executable?: boolean;
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const localPath = await this.resolveLocalPath(
      [params.componentId],
      params.sourceRelativePath,
      undefined,
      Boolean(params.forceRefresh),
    );
    // 共享本地 cache 可以在取消后完成，但不得让迟到 continuation 再写远端 staging。
    throwIfRemoteAssetInstallAborted(this.options.signal);
    // 多个 Desktop 实例或跨窗口连接可能同时部署到同一 distro/user。
    // 固定 `.new` 会互相覆盖 staging 文件，唯一 owner 路径保证失败清理和最终 rename 不串写。
    const tempRemotePath = `${params.remotePath}.new-${Date.now()}-${randomUUID()}`;
    this.loggers.log(
      `[remote-assets] uploading ${params.sourceRelativePath} to ${params.remotePath}`,
    );
    const remoteParentDir = posix.dirname(params.remotePath);
    const cleanupRemoteStaging = async (): Promise<void> => {
      try {
        const cleanupStream = await this.backend.exec(`rm -f ${quotePosixPathArg(tempRemotePath)}`);
        await waitForClose(cleanupStream);
      } catch (error) {
        this.loggers.logWarn(
          `[remote-assets] failed to clean owned file staging ${tempRemotePath}: ${String(error)}`,
        );
      }
    };

    try {
      const prepareCommands = [
        ...(this.options.signal
          ? [
              buildStaleRemoteStagingCleanupCommand(remoteParentDir, [
                `${posix.basename(params.remotePath)}.new-*`,
              ]),
            ]
          : []),
        `mkdir -p ${quotePosixPathArg(remoteParentDir)}`,
      ];
      const mkdirStream = await this.backend.exec(prepareCommands.join("\n"));
      await waitForClose(mkdirStream);
      await this.backend.upload(localPath, tempRemotePath, {
        signal: this.options.signal,
      });
      throwIfRemoteAssetInstallAborted(this.options.signal);
      const stream = await this.backend.exec(
        params.executable
          ? buildRemoteExecutableReplaceCommand(tempRemotePath, params.remotePath)
          : buildRemoteMoveCommand(tempRemotePath, params.remotePath),
      );
      await waitForClose(stream);
    } catch (error) {
      // 文件替换失败时必须清理当前 owner 的 `.new-*` 文件，否则
      // Docker 非 root 场景会把 chmod 失败的宿主 owner 文件长期留在远端。
      // 取消路径可能已经释放 backend，不能用旧凭据再次 cleanup；由后续 janitor 回收。
      if (!this.options.signal?.aborted) {
        await cleanupRemoteStaging();
      }
      throw error;
    }
  }

  async installDirectory(params: {
    componentId: string;
    sourceRelativePath: string;
    remoteDir: string;
    requiredRelativePaths?: string[];
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const localPath = await this.resolveLocalPath(
      [params.componentId],
      params.sourceRelativePath,
      buildRequiredReleasePaths(params.sourceRelativePath, params.requiredRelativePaths),
      Boolean(params.forceRefresh),
    );
    const localTarPath = join(
      tmpdir(),
      `acode-remote-${params.componentId}-${Date.now()}-${randomUUID()}.tar.gz`,
    );
    await createTarGzArchive(localTarPath, [
      { sourcePath: localPath, archivePath: basename(localPath) },
    ]);

    const ownerSuffix = `${Date.now()}-${randomUUID()}`;
    // 目录上传曾复用 `<remoteDir>.tar.gz`，并发部署会互相覆盖压缩包，
    // 甚至把半写文件解压到最终目录。archive/extract 都带 owner，失败时也只清理自己的 staging。
    const remoteTarPath = `${params.remoteDir}.tar.gz-${ownerSuffix}`;
    const remoteExtractDir = `${params.remoteDir}.extract-${ownerSuffix}`;
    const extractedSourceDir = `${remoteExtractDir}/${basename(localPath)}`;
    const cleanupRemoteStaging = async (): Promise<void> => {
      try {
        const cleanupStream = await this.backend.exec(
          `rm -f ${quotePosixPathArg(remoteTarPath)} && rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
        );
        await waitForClose(cleanupStream);
      } catch (error) {
        this.loggers.logWarn(
          `[remote-assets] failed to clean owned directory staging ${ownerSuffix}: ${String(error)}`,
        );
      }
    };

    try {
      // 本地归档不共享远端生命周期；归档完成后再次检查，禁止取消后创建远端 staging。
      throwIfRemoteAssetInstallAborted(this.options.signal);
      this.loggers.log(
        `[remote-assets] uploading ${params.sourceRelativePath} to ${params.remoteDir}`,
      );
      const remoteParentDir = posix.dirname(params.remoteDir);
      const remoteDirName = posix.basename(params.remoteDir);
      const prepareCommands = [
        ...(this.options.signal
          ? [
              buildStaleRemoteStagingCleanupCommand(remoteParentDir, [
                `${remoteDirName}.tar.gz-*`,
                `${remoteDirName}.extract-*`,
              ]),
            ]
          : []),
        `mkdir -p ${quotePosixPathArg(remoteParentDir)}`,
      ];
      const mkdirStream = await this.backend.exec(prepareCommands.join("\n"));
      await waitForClose(mkdirStream);
      await this.backend.upload(localTarPath, remoteTarPath, {
        signal: this.options.signal,
      });
      throwIfRemoteAssetInstallAborted(this.options.signal);
      const stream = await this.backend.exec(
        [
          "set -eu",
          `cleanup_staging() { rm -f ${quotePosixPathArg(remoteTarPath)}; rm -rf ${quotePosixPathArg(remoteExtractDir)}; }`,
          "trap cleanup_staging EXIT HUP INT TERM",
          `rm -rf ${quotePosixPathArg(remoteExtractDir)}`,
          `mkdir -p ${quotePosixPathArg(remoteExtractDir)} ${quotePosixPathArg(posix.dirname(params.remoteDir))}`,
          `tar -xzf ${quotePosixPathArg(remoteTarPath)} -C ${quotePosixPathArg(remoteExtractDir)}`,
          `test -d ${quotePosixPathArg(extractedSourceDir)}`,
          `rm -rf ${quotePosixPathArg(params.remoteDir)}`,
          buildRemoteMoveCommand(extractedSourceDir, params.remoteDir),
          "cleanup_staging",
          "trap - EXIT HUP INT TERM",
        ].join("\n"),
      );
      await waitForClose(stream);
    } catch (error) {
      // 连接取消监听会先释放 SSH backend；若随后仍用同一 backend 清理 staging，
      // SSH 实现可能以旧凭据重新连接。取消路径只保留唯一 owner staging，不再触碰正式目录。
      if (!this.options.signal?.aborted) {
        await cleanupRemoteStaging();
      }
      throw error;
    } finally {
      try {
        unlinkSync(localTarPath);
      } catch {
        // 忽略临时文件清理失败，部署结果不应受本地清理影响。
      }
    }
  }

  private async tryResolveCdnReleaseDir(
    componentIds: string[],
    requiredReleasePaths?: string[],
    forceRefresh = false,
  ): Promise<string | null> {
    const platformArch = this.options.platformArch?.trim();
    const version = this.options.version?.trim();
    if (!platformArch || !version || !this.options.remoteCacheDir) {
      return null;
    }

    const hasRemoteCdnBase =
      Boolean(this.options.remoteCdnBaseUrl?.trim()) ||
      (this.options.remoteCdnBaseUrls?.some((url) => url.trim().length > 0) ?? false);
    if (!hasRemoteCdnBase) {
      return null;
    }

    try {
      // 开发态默认优先 mock-cdn；但用户可先用远端下载再切回本地上传，
      // 此时 mock-cdn 可能没有对应平台/provider 资源。本地上传语义是“本地拿到资源后上传”，
      // 因此缺本地伪 CDN 文件时应回落到真实 CDN 的本地缓存，而不是直接报缺包。
      return await ensureRemoteReleaseDirFromCdn(
        {
          remoteCdnBaseUrl: this.options.remoteCdnBaseUrl,
          remoteCdnBaseUrls: this.options.remoteCdnBaseUrls,
          remoteCacheDir: this.options.remoteCacheDir,
          version,
          platformArch,
          componentIds,
          requiredReleasePaths,
          manifestRequestTimeoutMs: this.options.manifestRequestTimeoutMs,
          remoteAssetNetwork: this.options.remoteAssetNetwork,
          forceRefresh,
        },
        this.loggers,
      );
    } catch (error) {
      this.loggers.logWarn(
        `[remote-assets] local upload CDN fallback failed for ${componentIds.join(",")}: ${String(error)}`,
      );
      // App 版本变化时必须重新获取当前 manifest 对应的 GLM 制品。
      // 强制刷新失败后若继续回退旧 cache，会让上传和部署表面成功但远端仍运行旧资源。
      if (forceRefresh) {
        throw error;
      }
      return null;
    }
  }
}
