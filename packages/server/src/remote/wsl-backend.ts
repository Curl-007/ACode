// 拆分说明（满足 400 行架构上限）：
// - WSL 常量/输出解码/参数构造/UNC 探测 → wslBackendSupport.ts
// - wsl.exe 子进程生命周期（spawn/execFile/owned children）→ wslBackendProcess.ts
// - `cat > file` 流式上传 → wslBackendUpload.ts
// 本文件保留 WSLBackend 类的探测、路径解析、代理裁决与生命周期编排。
// buildWslArgs / ResolvedWSLIdentity 原为本文件公开符号，重导出以保公开面不变。
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import type { WSLConnectOptions } from "@acode/shared";
import type {
  IRemoteBackend,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@acode/server/remote/backend.js";
import {
  normalizeRemoteArch,
  normalizeRemotePlatform,
  resolveRemotePlatform,
} from "@acode/server/remote/detectEnv.js";
import { quotePosixShellArg } from "@acode/server/remote/posixShell.js";
import { isWSLAvailable, listWSLDistros, type WSLDistro } from "@acode/server/remote/wsl-detect.js";
import {
  buildWslHostGatewayCommand,
  buildWslProxyPortProbeCommand,
  isLoopbackProxyHostname,
  normalizeWslProxyUrl,
  parseWslHostGatewayOutput,
  parseWslProxyPortProbeOutput,
  replaceProxyHostname,
} from "@acode/server/remote/wslProxy.js";
import {
  buildWslArgs,
  decodeWslOutput,
  normalizeWslOutput,
  toWslUncCandidates,
  accessAnyPath,
  copyFileToAnyPath,
  type ResolvedWSLIdentity,
  type ResolvedWSLInfo,
} from "@acode/server/remote/wslBackendSupport.js";
import {
  disposeWslOwnedChildren,
  execWslCommandToBuffer,
  spawnWslExec,
  type WslOwnedChildren,
} from "@acode/server/remote/wslBackendProcess.js";
import { uploadFileViaWslCatStream } from "@acode/server/remote/wslBackendUpload.js";

export { buildWslArgs };
export type { ResolvedWSLIdentity };

export class WSLBackend implements IRemoteBackend {
  readonly kind = "wsl" as const;

  private readonly options: WSLConnectOptions;
  private resolvedInfoPromise: Promise<ResolvedWSLInfo> | null = null;
  private readonly ownedChildren: WslOwnedChildren = new Map();
  private disposed = false;
  private disposeInFlight: Promise<void> | null = null;

  constructor(options: WSLConnectOptions) {
    this.options = options;
  }

  async resolveIdentity(): Promise<ResolvedWSLIdentity> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    if (!resolvedInfo.distroName || !resolvedInfo.userName) {
      throw new Error("无法解析 WSL 实际 distro/user 身份");
    }
    return {
      distro: resolvedInfo.distroName,
      user: resolvedInfo.userName,
    };
  }

  async detect(): Promise<RemoteEnvironment> {
    await this.ensureAvailable();
    const reportedPlatform = normalizeRemotePlatform(
      normalizeWslOutput(await this.execSimple("uname -s")),
    );
    const arch = normalizeRemoteArch(normalizeWslOutput(await this.execSimple("uname -m")));
    const kernelOstype = await this.readKernelOstype();
    const platform = resolveRemotePlatform(reportedPlatform, kernelOstype);

    return {
      platform,
      arch,
    };
  }

  async resolveRuntimeProxy(proxyUrl: string): Promise<string> {
    const normalizedProxyUrl = normalizeWslProxyUrl(proxyUrl);
    if (!normalizedProxyUrl) {
      return proxyUrl;
    }
    const parsedProxyUrl = new URL(normalizedProxyUrl);
    if (!isLoopbackProxyHostname(parsedProxyUrl.hostname)) {
      // 非 loopback 代理本来就是远端可解析地址；保留用户输入，避免无意义的 URL 规范化。
      return proxyUrl;
    }

    await this.ensureAvailable();
    const localProbe = await this.probeProxyPort(normalizedProxyUrl);
    if (localProbe === true) {
      // mirrored networking 或代理已监听 WSL loopback，不能替换成另一个地址。
      return normalizedProxyUrl;
    }

    try {
      const gateway = parseWslHostGatewayOutput(
        await this.execSimple(buildWslHostGatewayCommand()),
      );
      if (!gateway) {
        return normalizedProxyUrl;
      }
      const gatewayProxyUrl = replaceProxyHostname(normalizedProxyUrl, gateway);
      const gatewayProbe = await this.probeProxyPort(gatewayProxyUrl);
      return gatewayProbe === true ? gatewayProxyUrl : normalizedProxyUrl;
    } catch {
      // 代理解析只是运行时增强；失败时保留用户原值，让 Agent 自己返回可诊断的网络错误。
      return normalizedProxyUrl;
    }
  }

  async upload(
    localPath: string,
    remotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = await this.resolveLinuxPath(remotePath, resolvedInfo);

    if (options?.onProgress || options?.signal) {
      await uploadFileViaWslCatStream({
        localPath,
        resolvedRemotePath,
        exec: (command) => this.exec(command),
        options,
      });
      return;
    }

    if (resolvedInfo.distroName) {
      const copied = await copyFileToAnyPath(
        localPath,
        toWslUncCandidates(resolvedRemotePath, resolvedInfo.distroName),
      );
      if (copied) {
        return;
      }
    }

    // WSL 1 或默认 distro 名称解析失败时，UNC 路径可能不可用。
    // 如果这里直接报错，remote deploy 会彻底失效；回退到 `cat > file` 的流式写入，
    // 至少能保证 server/node/pty 仍可上传，只是速度慢一些。
    await uploadFileViaWslCatStream({
      localPath,
      resolvedRemotePath,
      exec: (command) => this.exec(command),
    });
  }

  async exec(command: string): Promise<StdioStream> {
    this.assertNotDisposed();
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    // 入口门禁之后的 discovery/identity await 允许 dispose barrier 插入并完成；
    // resolved info 命中缓存时，旧 continuation 会在 barrier 后继续 spawn。最终创建 child 前必须再校验。
    this.assertNotDisposed();

    return spawnWslExec({
      command,
      distroName: resolvedInfo.distroName,
      userName: resolvedInfo.userName,
      ownedChildren: this.ownedChildren,
    });
  }

  async exists(remotePath: string): Promise<boolean> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = await this.resolveLinuxPath(remotePath, resolvedInfo);

    if (resolvedInfo.distroName) {
      const accessiblePath = await accessAnyPath(
        toWslUncCandidates(resolvedRemotePath, resolvedInfo.distroName),
      );
      if (accessiblePath) {
        return true;
      }
    }

    try {
      await this.execSimple(`test -f ${quotePosixShellArg(resolvedRemotePath)} && printf OK`);
      return true;
    } catch {
      return false;
    }
  }

  async readFile(remotePath: string): Promise<string> {
    await this.ensureAvailable();
    const resolvedInfo = await this.resolveInfo();
    const resolvedRemotePath = await this.resolveLinuxPath(remotePath, resolvedInfo);

    if (resolvedInfo.distroName) {
      const accessiblePath = await accessAnyPath(
        toWslUncCandidates(resolvedRemotePath, resolvedInfo.distroName),
      );
      if (accessiblePath) {
        return readFile(accessiblePath, "utf8");
      }
    }

    return normalizeWslOutput(
      await this.execSimple(`cat ${quotePosixShellArg(resolvedRemotePath)}`),
    );
  }

  dispose(): void {
    void this.disposeAndWait();
  }

  disposeAndWait(options?: { graceTimeoutMs?: number; killWaitTimeoutMs?: number }): Promise<void> {
    if (this.disposeInFlight) {
      return this.disposeInFlight;
    }
    this.disposed = true;

    const graceTimeoutMs = Math.max(options?.graceTimeoutMs ?? 300, 0);
    const killWaitTimeoutMs = Math.max(options?.killWaitTimeoutMs ?? 250, 0);
    this.disposeInFlight = disposeWslOwnedChildren(
      this.ownedChildren,
      graceTimeoutMs,
      killWaitTimeoutMs,
    );
    return this.disposeInFlight;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("WSL backend 已释放，无法启动新命令");
    }
  }

  private async ensureAvailable(): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("WSL 连接仅支持在 Windows 上使用");
    }

    const available = await isWSLAvailable((args) => this.execWslForBuffer(args));
    if (!available) {
      throw new Error("当前系统未检测到可用的 WSL 环境");
    }
  }

  private async resolveInfo(): Promise<ResolvedWSLInfo> {
    if (this.resolvedInfoPromise) {
      return this.resolvedInfoPromise;
    }

    this.resolvedInfoPromise = (async () => {
      const distros = await this.safeListDistros();
      const selected = this.pickDistro(distros);
      const launchDistroName = selected?.name ?? this.options.distro?.trim() ?? null;
      const requestedUserName = this.options.user?.trim() || null;
      const identityOutput = normalizeWslOutput(
        await this.execDirect(
          ["bash", "-lc", `printf '%s\\n' "$WSL_DISTRO_NAME"; id -un; printf %s "$HOME"`],
          launchDistroName,
          requestedUserName,
        ),
      );
      const [reportedDistroName = "", actualUserName = "", ...homeLines] =
        identityOutput.split("\n");
      const distroName = reportedDistroName.trim() || launchDistroName;
      const userName = actualUserName.trim() || requestedUserName;
      const homeDir = homeLines.join("\n").trim();
      if (!homeDir) {
        throw new Error("无法解析 WSL 用户 HOME");
      }

      return {
        distroName,
        userName,
        version: selected?.version ?? null,
        homeDir,
      };
    })();

    return this.resolvedInfoPromise;
  }

  private async safeListDistros(): Promise<WSLDistro[]> {
    try {
      return await listWSLDistros((args) => this.execWslForBuffer(args));
    } catch {
      return [];
    }
  }

  private pickDistro(distros: WSLDistro[]): WSLDistro | null {
    const requestedDistro = this.options.distro?.trim();
    if (requestedDistro) {
      if (distros.length === 0) {
        return null;
      }

      const matched = distros.find(
        (distro) =>
          distro.name.localeCompare(requestedDistro, undefined, { sensitivity: "base" }) === 0,
      );
      if (!matched) {
        throw new Error(`未找到名为 ${this.options.distro} 的 WSL distro`);
      }

      return matched;
    }

    return distros.find((distro) => distro.isDefault) ?? distros[0] ?? null;
  }

  private async resolveLinuxPath(
    remotePath: string,
    resolvedInfo: ResolvedWSLInfo,
  ): Promise<string> {
    if (remotePath === "~") {
      return resolvedInfo.homeDir;
    }

    if (remotePath.startsWith("~/")) {
      return posix.join(resolvedInfo.homeDir, remotePath.slice(2));
    }

    return remotePath;
  }

  private async execSimple(command: string): Promise<string> {
    const resolvedInfo = await this.resolveInfo();
    return this.execDirect(
      ["bash", "-lc", command],
      resolvedInfo.distroName,
      resolvedInfo.userName,
    );
  }

  private async probeProxyPort(proxyUrl: string): Promise<boolean | undefined> {
    const command = buildWslProxyPortProbeCommand(proxyUrl);
    if (!command) {
      return undefined;
    }
    try {
      return parseWslProxyPortProbeOutput(await this.execSimple(command));
    } catch {
      return undefined;
    }
  }

  private async readKernelOstype(): Promise<string> {
    try {
      return normalizeWslOutput(
        await this.execSimple(
          "if [ -r /proc/sys/kernel/ostype ]; then cat /proc/sys/kernel/ostype; fi",
        ),
      ).trim();
    } catch {
      return "";
    }
  }

  private async execDirect(
    commandArgs: string[],
    distroName?: string | null,
    userName?: string | null,
  ): Promise<string> {
    const stdout = await this.execWslForBuffer(buildWslArgs(commandArgs, distroName, userName));
    return normalizeWslOutput(decodeWslOutput(stdout));
  }

  private async execWslForBuffer(args: string[]): Promise<Buffer> {
    this.assertNotDisposed();
    return execWslCommandToBuffer(args, this.ownedChildren);
  }
}
