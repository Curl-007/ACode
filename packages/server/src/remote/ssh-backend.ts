// 拆分说明（满足 400 行架构上限）：exec channel/简单命令/环境探测/$HOME 缓存 → sshBackendExec.ts；
// 连接装配（SSHBackendOptions、debug 过滤、keyboard-interactive responder）→ sshBackendConnect.ts；
// SFTP / exec pipe 上传与失败分类 → sshBackendUpload.ts。本文件保留连接生命周期、host key 挑战、
// 上传编排与 dispose；SSHBackendOptions 原为本文件公开符号，重导出以保公开面不变。
import { Client as SSHClient } from "ssh2";
import type { ConnectConfig } from "ssh2";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Emitter } from "@acode/rpc";
import type {
  IRemoteBackend,
  RemoteDisconnectEvent,
  RemoteDisconnectReason,
  RemoteEnvironment,
  RemoteUploadOptions,
  StdioStream,
} from "@acode/server/remote/backend.js";
import { quotePosixShellArg, resolvePosixHomePath } from "@acode/server/remote/posixShell.js";
import {
  buildSSHConnectConfig,
  normalizeSSHHostKeyFingerprint,
  SSHHostKeyDecisionError,
  normalizeSSHConnectError,
  SSHHostKeyVerificationError,
  type SSHHostKeyChallenge,
  type SSHHostKeyDecision,
  type SSHHostKeyTrust,
  type SSHHostKeyVerificationStatus,
} from "@acode/server/remote/sshAuth.js";
import {
  createHostKeyChallengePromptHandler,
  createSSHPromptChannel,
  type SSHPromptChannel,
} from "@acode/server/remote/sshPromptChannel.js";
import type { SSHKeyboardInteractiveResponder } from "@acode/server/remote/sshKeyboardInteractive.js";
import { formatSSHUploadLabel } from "@acode/server/remote/sshUploadProgress.js";
import {
  attachKeyboardInteractiveAuth,
  attachSshClientDebugFilter,
  type SSHBackendOptions,
} from "@acode/server/remote/sshBackendConnect.js";
import {
  createSshHomeDirResolver,
  detectRemoteEnvironmentViaSsh,
  execSshCommand,
  execSshCommandSimple,
} from "@acode/server/remote/sshBackendExec.js";
import {
  describeSSHUploadFailure,
  shouldFallbackToSSHExecUpload,
  throwIfSSHUploadAborted,
  uploadViaExec,
  uploadViaSftp,
} from "@acode/server/remote/sshBackendUpload.js";

export type { SSHBackendOptions };

export class SSHBackend implements IRemoteBackend {
  private client: SSHClient;
  private connected = false;
  private readonly config: ConnectConfig;
  private readonly hostKeyTrust: SSHHostKeyTrust | undefined;
  private connecting: Promise<void> | undefined;
  private readonly homeDir = createSshHomeDirResolver((command) => this.execSimple(command));
  private execUploadOnly = false;
  private disposed = false;
  private hasEverConnected = false;
  private disconnectReported = false;
  private readonly disconnectEmitter = new Emitter<RemoteDisconnectEvent>();
  readonly onDidDisconnect = this.disconnectEmitter.event;
  private hostKeyDecision: SSHHostKeyVerificationStatus | undefined;
  private hostKeyChallenge: SSHHostKeyChallenge | undefined;
  /**
   * 连接期提示通道（specs/ssh-prompt-mediation.md R4/R5）：一次连接（backend）一个
   * 实例；通道是「对端已确认」状态与 pending 提示表的唯一所有者。host-key challenge
   * 是第一个消费者；passphrase/otp 单提示经同一通道中介（顺序闸治理）。
   * 无 onHostKeyChallenge 时不创建（challenge 保持拒绝，行为同现状）。
   */
  private readonly promptChannel: SSHPromptChannel | undefined;
  /** keyboard-interactive responder 实例；认证失败时读取 takeLastRefusal 注入错误归一化 context。 */
  private readonly keyboardInteractiveResponder?: SSHKeyboardInteractiveResponder;

  private readonly onClientError = (error: unknown): void => {
    if (this.disposed) {
      // ssh2 在 ready timeout 后销毁 socket 时，close/end 阶段可能再次发出 error。
      // dispose 期间保留监听器只为吸收这类迟到事件，不能再向上层重复报告或触发未捕获异常。
      return;
    }
    // R3：认证失败那一轮如果拒绝过交互提示，真实原因是「服务器要求 ACode 无法
    // 代答的提示形态」而不是密码错误；take 语义防止陈旧拒绝污染后续无关错误。
    const normalizedError = normalizeSSHConnectError(error, {
      keyboardInteractiveRefusal: this.keyboardInteractiveResponder?.takeLastRefusal(),
    });
    // ready 之后如果底层连接抖动，ssh2 仍会发出 "error" 事件。
    // 若没有常驻监听，Node 会把它当成未捕获异常直接抛出，可能导致 host 进程崩溃。
    // 这里先记录错误详情再上报断连；上层收到断连后会退出 host，反过来会丢掉真实 error 文案。
    console.error("[ssh] client error:", normalizedError);
    this.reportDisconnect("error", normalizedError);
  };

  private readonly onClientClose = (): void => {
    this.reportDisconnect("close");
  };

  private readonly onClientEnd = (): void => {
    this.reportDisconnect("end");
  };

  constructor(options: SSHBackendOptions) {
    this.hostKeyTrust = options.hostKeyTrust;
    // 连接期提示通道：存量 SSHHostKeyChallengeHandler（Desktop requestId IPC 闭环）
    // 经 createHostKeyChallengePromptHandler 适配为通道 handler，既有闭环零改动
    // 作为通道后端（specs/ssh-prompt-mediation.md R4.5）。
    this.promptChannel = options.onHostKeyChallenge
      ? createSSHPromptChannel({
          handler: createHostKeyChallengePromptHandler(options.onHostKeyChallenge),
          host: options.host,
          port: options.port ?? 22,
          logWarn: (message) => console.warn(`[ssh] ${message}`),
        })
      : undefined;
    this.client = new SSHClient();
    this.client.on("error", this.onClientError);
    this.client.on("close", this.onClientClose);
    this.client.on("end", this.onClientEnd);
    this.config = buildSSHConnectConfig({
      host: options.host,
      port: options.port,
      username: options.username,
      privateKey: options.privateKey,
      passphrase: options.privateKeyPassphrase,
      password: options.password,
      agent: options.agent,
      hostKeyTrust: options.hostKeyTrust,
       onHostKeyDecision: (status, keyHash, expectedFingerprints) => {
        this.hostKeyDecision = status;
         this.hostKeyChallenge =
           status === "unknown" || status === "changed"
             ? {
                 challengeId: randomUUID(),
                 host: options.host,
                 port: options.port ?? 22,
                 status,
                 candidateFingerprint: normalizeSSHHostKeyFingerprint(keyHash),
                 expectedFingerprints: expectedFingerprints.map(normalizeSSHHostKeyFingerprint),
               }
             : undefined;
        // R5 顺序闸：verifier 裁决 trusted 即「对端已确认」，secret 类提示
        // （passphrase/otp）此后才可交给 handler；其余状态不产生确认。
        this.promptChannel?.notifyHostKeyOutcome(status);
      },
    });
    attachSshClientDebugFilter(this.config);
    this.keyboardInteractiveResponder = attachKeyboardInteractiveAuth(
      this.client,
      options.password,
      this.promptChannel,
    );
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("SSH backend 已释放，无法重新建立连接");
    }
  }

  private async ensureConnected(): Promise<void> {
    this.assertNotDisposed();
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    // 异步 trust refresh 与多条 exec/detect 可能交错；每个 backend 只准入一个握手，
    // 其他调用等待同一个结果，避免在刷新期间对同一 ssh2 client 重复 connect。
    const connecting = this.connectWithChallenge();
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }

  private async connectWithChallenge(): Promise<void> {
    let challengeRetryCount = 0;
    for (;;) {
      try {
        await this.connect();
        return;
      } catch (error) {
        if (
          !(error instanceof SSHHostKeyVerificationError) ||
          !error.challenge ||
          !this.promptChannel ||
          challengeRetryCount >= 1
        ) {
          throw error;
        }
        challengeRetryCount += 1;
        const challenge = error.challenge;
        // 委托连接期提示通道（specs/ssh-prompt-mediation.md R4.5）：决策绑定校验
        // （challengeId/候选指纹回显、unknown→approve、changed→replace、reject 直通）
        // 收敛在通道内，与既有 backend 规则一致；handler 抛错/绑定不符/abort 一律
        // 抛 SSHHostKeyDecisionError 语义错误，fail-closed。
        const decision: SSHHostKeyDecision =
          await this.promptChannel.requestHostKeyDecision(challenge);
        if (decision.action === "reject") {
          throw error;
        }
        if (!this.hostKeyTrust?.commitDecision) {
          throw new SSHHostKeyDecisionError("当前 SSH 信任存储不支持交互批准");
        }
        await this.hostKeyTrust.commitDecision(challenge, decision.action);
        await this.hostKeyTrust.refresh?.();
      }
    }
  }

  private async connect(): Promise<void> {
    // 连接取消会先释放 backend，但迟到的 deploy/cleanup continuation 仍可能
    // 调用 ensureConnected。ssh2 Client 支持 end 后再次 connect，必须在 backend 边界阻止旧凭据复活。
    this.assertNotDisposed();
    await this.hostKeyTrust?.refresh?.();
    this.assertNotDisposed();
    return new Promise((resolve, reject) => {
      const handleReady = () => {
        this.client.off("error", handleConnectError);
        if (this.hostKeyDecision && this.hostKeyDecision !== "trusted") {
          this.client.end();
          reject(
            new SSHHostKeyVerificationError(
              this.hostKeyDecision as Exclude<SSHHostKeyVerificationStatus, "trusted">,
              this.hostKeyChallenge,
            ),
          );
          return;
        }
        if (this.disposed) {
          // dispose 与 ssh2 ready 可能交错；迟到的 ready 若重新标记 connected，
          // 后续 detect 会继续使用已取消连接的旧凭据。再次关闭 socket，并让原调用失败。
          this.client.end();
          reject(new Error("SSH backend 已释放，无法重新建立连接"));
          return;
        }
        this.connected = true;
        this.hasEverConnected = true;
        this.disconnectReported = false;
        resolve();
      };
      const handleConnectError = (error: unknown) => {
        this.client.off("ready", handleReady);
        reject(
          this.hostKeyDecision && this.hostKeyDecision !== "trusted"
            ? new SSHHostKeyVerificationError(
                this.hostKeyDecision as Exclude<SSHHostKeyVerificationStatus, "trusted">,
                  this.hostKeyChallenge,
              )
            : // R3：认证失败若本轮拒绝过交互提示，归一化为携带解释文案的拒绝错误
              // （take 语义防陈旧拒绝污染后续无关错误）；未注入时行为不变。
              normalizeSSHConnectError(error, {
                keyboardInteractiveRefusal:
                  this.keyboardInteractiveResponder?.takeLastRefusal(),
              }),
        );
      };
      this.client.once("ready", handleReady);
      this.client.once("error", handleConnectError);
      this.hostKeyDecision = undefined;
      this.hostKeyChallenge = undefined;
      this.client.connect(this.config);
    });
  }

  private reportDisconnect(reason: RemoteDisconnectReason, error?: Error): void {
    const shouldReport =
      !this.disposed && !this.disconnectReported && (this.connected || this.hasEverConnected);

    this.connected = false;
    this.homeDir.reset();

    if (!shouldReport) {
      return;
    }

    this.disconnectReported = true;
    this.disconnectEmitter.fire(error ? { reason, error } : { reason });
  }

  async detect(): Promise<RemoteEnvironment> {
    await this.ensureConnected();
    return detectRemoteEnvironmentViaSsh((command) => this.execSimple(command));
  }

  async upload(
    localPath: string,
    remotePath: string,
    options?: RemoteUploadOptions,
  ): Promise<void> {
    throwIfSSHUploadAborted(options?.signal);
    await this.ensureConnected();
    this.assertNotDisposed();
    const resolved = await this.resolveRemotePath(remotePath);
    throwIfSSHUploadAborted(options?.signal);
    this.assertNotDisposed();
    const uploadLabel = formatSSHUploadLabel(resolved);
    console.log(`[ssh] upload: resolved ${uploadLabel} to ${resolved}`);
    const dir = posix.dirname(resolved);
    await this.execSimple(`mkdir -p ${quotePosixShellArg(dir)}`);

    const port = {
      client: this.client,
      exec: (command: string) => this.exec(command),
      assertNotDisposed: () => this.assertNotDisposed(),
    };

    if (this.execUploadOnly) {
      // exec-only 只缓存传输能力，不能丢掉每次上传独立的取消信号与进度回调；
      // 否则首次 SFTP 降级后的后续资源会脱离连接取消流程，并让 UI 停止更新进度。
      await uploadViaExec(port, localPath, resolved, options);
      return;
    }

    try {
      await uploadViaSftp(port, localPath, resolved, options);
    } catch (error) {
      if (!shouldFallbackToSSHExecUpload(error)) {
        throw error;
      }

      // 某些网关 / 跳板 SSH 会把 exec 与 SFTP 落到不同的文件系统视图。
      // 这类场景下，前面的 `mkdir -p` 已经证明 shell 视图可写，但 SFTP 往同一路径写文件仍会报 NO_SUCH_FILE。
      // 这里回退到 `cat > file`，强制复用已验证可用的 shell 通道，避免把“网关不支持 SFTP 直写”误判成连接失败。
      // 同一个 backend 后续继续试 SFTP 只会重复失败并刷日志，因此在首次能力失败后记住 exec-only 状态；
      // 新连接会创建新的 backend，自然会重新探测 SFTP 能力。
      this.execUploadOnly = true;
      console.warn(
        `[ssh] upload: switching ${uploadLabel} from sftp to exec pipe after ${describeSSHUploadFailure(error)}`,
      );
      await uploadViaExec(port, localPath, resolved, options);
    }
  }

  async exec(command: string): Promise<StdioStream> {
    await this.ensureConnected();
    // ensureConnected 的 await 与真正创建 channel 之间允许取消屏障插入，必须再次校验。
    this.assertNotDisposed();
    return execSshCommand(this.client, command);
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      const resolvedRemotePath = await this.resolveRemotePath(remotePath);
      const result = await this.execSimple(
        `test -f ${quotePosixShellArg(resolvedRemotePath)} && printf OK`,
      );
      return result.trim() === "OK";
    } catch {
      return false;
    }
  }

  async readFile(remotePath: string): Promise<string> {
    const resolvedRemotePath = await this.resolveRemotePath(remotePath);
    return this.execSimple(`cat ${quotePosixShellArg(resolvedRemotePath)}`);
  }

  /** Execute a simple command and return stdout as string */
  private execSimple(command: string): Promise<string> {
    this.assertNotDisposed();
    return execSshCommandSimple(this.client, command);
  }

  private async resolveRemotePath(remotePath: string): Promise<string> {
    const homeDir = await this.homeDir.resolve();
    return resolvePosixHomePath(remotePath, homeDir);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // 首次握手失败后，ssh2 可能在 socket end/close 之后继续发出 error。
    // dispose 后保留 onClientError 作为 no-op sink，不能按 end/close 事件时序提前移除，
    // 否则迟到事件会逃逸为 uncaughtException，让共享 Window Host 连带退出其它 workspace。
    // client 只由当前 backend 持有，监听器会随 client 一起回收；此处优先保证退役阶段不崩溃。
    this.client.off("close", this.onClientClose);
    this.client.off("end", this.onClientEnd);
    this.client.end();
    // 通道 dispose：全部 pending 提示以 expired 结算，后续请求一律 expired
    // （specs/ssh-prompt-mediation.md R4.3），防止 backend 退役后 UI 悬挂等待。
    this.promptChannel?.dispose();
    this.connected = false;
    this.disconnectEmitter.dispose();
  }
}
