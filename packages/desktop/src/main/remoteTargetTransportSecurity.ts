import type { RemoteTarget } from "@acode/shared";

/**
 * 跨环境 Provider Provisioning 的传输加密分类（安全审计 M5）。
 * spec: packages/desktop/specs/provisioning-transport-encryption-gate.md
 *
 * provisioning 信封在源端把 credentials.json 的 allowlist 条目**解密成明文**装入
 * credentials[]（OAuth access/refresh、acodejwttoken、account-provider Key、P1-5 的
 * BYO provider:apikey:*）。server kind 连接的协议由用户 URL 决定，ws:// 明文 WebSocket
 * 是受支持形态——中间人可全量截获长期凭据。Main 在连接建立（handleConnected）时按本
 * 分类决定是否注册 provisioning lane：未加密 → 整体跳过同步并告警。
 *
 * 判定依据与 host 侧 `resolveServerEndpoints` / shared `normalizeServerEndpoint` 的协议
 * 归一同源（ws→http、wss→https；非 https/wss 一律按明文处理，fail-closed）：
 * - `ssh`：远端 server 经 SSH 部署，RPC 走 SSH 子进程 stdio，处于 SSH 加密隧道内 → 加密；
 * - `wsl` / `docker`：同机 distro/容器，RPC 走本机 stdio 管道，不上网络，不受链路窃听威胁 → 加密；
 * - `server`：仅 https:/wss: 视为加密；http:/ws:/未知协议/非法 URL 一律未加密。
 *
 * 刻意做成无 electron 依赖的纯函数模块：Main 侧逻辑无法在 node:test 里直接 import
 * desktopRemoteSessions.ts（electron 绑定），分类事实必须可独立单测。
 */
export interface RemoteProvisioningTransportSecurity {
  /** true = 传输被视为加密，允许携带明文凭据的 provisioning 信封通过。 */
  readonly encrypted: boolean;
  /** 判定原因（进结构化日志的短码，不含 URL/凭据等敏感内容）。 */
  readonly reason:
    | "ssh-tunnel-stdio"
    | "local-stdio"
    | "tls"
    | "plaintext-http"
    | "unknown-protocol"
    | "invalid-url";
}

export function resolveProvisioningTransportSecurity(
  target: RemoteTarget,
): RemoteProvisioningTransportSecurity {
  switch (target.kind) {
    case "ssh":
      return { encrypted: true, reason: "ssh-tunnel-stdio" };
    case "wsl":
    case "docker":
      return { encrypted: true, reason: "local-stdio" };
    case "server": {
      let parsed: URL;
      try {
        parsed = new URL(target.url.trim());
      } catch {
        // 非法 URL fail-closed：连接层会各自给出明确错误，安全判定不放行。
        return { encrypted: false, reason: "invalid-url" };
      }
      // 与 resolveServerEndpoints 同一映射：最终 ws 协议为 wss 当且仅当用户 URL 是 https/wss。
      if (parsed.protocol === "https:" || parsed.protocol === "wss:") {
        return { encrypted: true, reason: "tls" };
      }
      if (parsed.protocol === "http:" || parsed.protocol === "ws:") {
        return { encrypted: false, reason: "plaintext-http" };
      }
      return { encrypted: false, reason: "unknown-protocol" };
    }
  }
}
