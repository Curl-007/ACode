// 拆分依据：ssh-backend.ts 超 400 行架构上限。连接配置面的「开发态 debug 过滤」与「密码场景的
// keyboard-interactive responder 装配」是独立关注点，与 SSHBackend 的握手/挑战/生命周期编排分开；
// SSHBackendOptions 类型随连接装配下沉到本叶子，主文件重导出以保公开面不变。
import type { Client as SSHClient, ConnectConfig } from "ssh2";
import { resolveACodeRuntimeEnv } from "@acode/shared";
import { createKeyboardInteractiveResponder } from "@acode/server/remote/sshAuth.js";
import type { SSHPromptChannel } from "@acode/server/remote/sshPromptChannel.js";
import type { SSHKeyboardInteractiveResponder } from "@acode/server/remote/sshKeyboardInteractive.js";
import type {
  SSHHostKeyChallengeHandler,
  SSHHostKeyTrust,
} from "@acode/server/remote/sshAuth.js";

export interface SSHBackendOptions {
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  privateKey?: string | Buffer;
  privateKeyPassphrase?: string;
  password?: string;
  agent?: string;
  /** 已批准 host key 的只读查询；缺省时 SSH host key 全部拒绝。 */
  hostKeyTrust?: SSHHostKeyTrust;
  /** Optional host-owned interaction. No handler means unknown/changed keys stay rejected. */
  onHostKeyChallenge?: SSHHostKeyChallengeHandler;
}

export function shouldLogSSHDebugMessage(message: string): boolean {
  return !/\bCHANNEL_(?:DATA|EXTENDED_DATA|WINDOW_ADJUST)\b/u.test(message);
}

export function attachSshClientDebugFilter(config: ConnectConfig): void {
  if (resolveACodeRuntimeEnv(process.env) !== "development") {
    return;
  }
  config.debug = (message: string) => {
    // SSH ready 超时只暴露 client-timeout 时无法判断卡在 TCP、协商还是认证。
    // 仅开发环境输出 ssh2 握手细节；CHANNEL_DATA / EXTENDED_DATA 是命令 stdout/stderr 数据包，
    // 下载阶段会按 chunk 高频刷屏，过滤掉它们，避免连接窗口和 electron 日志被底层传输事件淹没。
    if (!shouldLogSSHDebugMessage(message)) {
      return;
    }
    console.debug(`[ssh2] ${message}`);
  };
}

export function attachKeyboardInteractiveAuth(
  client: SSHClient,
  password: string | undefined,
  promptChannel: SSHPromptChannel | undefined,
): SSHKeyboardInteractiveResponder | undefined {
  if (typeof password !== "string" || password.length === 0) {
    return undefined;
  }
  // `ssh2` 类型定义遗漏了 keyboard-interactive 事件，但运行时确实支持。
  // 这里局部转成 EventEmitter 接口，避免为了一个事件把整段代码降级到 any。
  // R2/R4.6：responder 注入中介与拒绝回调——单密码提示照旧自动应答；
  // passphrase/otp/generic 单提示在通道存在时交真人应答（顺序闸治理，
  // abort 落回拒绝路径）；多提示批次一律拒绝（v1 边界）。
  const responder = createKeyboardInteractiveResponder(password, {
    ...(promptChannel ? { mediator: promptChannel } : {}),
    onRefusal: (refusal) => {
      // 拒绝记录归 responder 实例所有（takeLastRefusal take 语义，认证失败时
      // 注入 normalizeSSHConnectError context）；这里只落结构化 reason 日志，
      // 消毒后的提示快照随归一化错误文案走用户可见通道。
      console.warn(`[ssh] keyboard-interactive refused: reason=${refusal.reason}`);
    },
  });
  (
    client as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): void;
    }
  ).on("keyboard-interactive", responder as unknown as (...args: unknown[]) => void);
  return responder;
}
