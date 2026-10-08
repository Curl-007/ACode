import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";

export interface SSHConnectOptions {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  sshConfigAlias?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
}

export interface WSLConnectOptions {
  kind: "wsl";
  distro?: string;
  user?: string;
}

export interface DockerConnectOptions {
  kind: "docker";
  container: string;
}

/** 附着到已运行的 ACode/ZCode server（WebSocket RPC），不部署、不拉起 stdio server。 */
export interface ServerConnectOptions {
  kind: "server";
  /** server HTTP/WS 根地址，例如 https://studio.example.com:3030。 */
  url: string;
  /** 用户给定的展示名；缺省时身份解析回落到 URL host。 */
  name?: string;
  /** server 的 lite token（ACODE_SERVER_AUTH_TOKEN，全仓唯一鉴权变量名）；secret，只存在于当前连接流程内存态。 */
  token?: string;
  /** 连接后默认打开的 server 端工作目录；留空则连上后再选目录。 */
  workspacePath?: string;
  /** server 自报的稳定 id（来自 /api/server-info）；优先用于身份与环境键。 */
  serverId?: string;
}

export type RemoteTarget =
  | SSHConnectOptions
  | WSLConnectOptions
  | DockerConnectOptions
  | ServerConnectOptions;

/** 删除只应存在于当前连接流程中的 secret，供长期内存状态和跨进程回包使用。 */
export function stripRemoteTargetSecrets(target: RemoteTarget): RemoteTarget {
  if (target.kind === "ssh") {
    const {
      password: _password,
      privateKeyPassphrase: _privateKeyPassphrase,
      ...sanitized
    } = target;
    return sanitized;
  }

  if (target.kind === "server") {
    // token 是 secret：跨进程 descriptor / 快照 / 日志都不应携带原始值。
    const { token: _token, ...sanitized } = target;
    return sanitized;
  }

  return target;
}
