import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "../oauth.js";

/**
 * Credential RPC 通道的 terminal-client 收窄策略（安全修复 M4，Node-only server 侧使用）。
 *
 * 背景：`ICredentialService`（channel `credential`）承载全仓明文凭据面——OAuth access token、
 * JWT、BYO API Key、MCP token、bot secret。此前它经 `exposeOnChannelServer` 无差别注册给每条
 * WS 连接：默认 loopback 无 token 姿态下，本机任意进程或恶意网页可直连 `/ws` dump 全部凭据。
 *
 * 修复：收窄发生在**传输注册层**（两套 server 的 WS 连接装配处，经 overrides 替换该 channel），
 * 不改 `packages/services` 的 credential 服务本体；策略（allowlist + 拒绝语义）收敛在本模块，
 * `packages/server` 与 Server Core 共用同一实现，不允许任一侧另写键列表。
 *
 * 结构化类型（不 import `@acode/services`）：保持 shared 无上游包依赖的依赖方向。
 */

/** 与 `ICredentialService` 结构兼容的最小面（load/save/delete）。 */
export interface CredentialChannelLike {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * terminal-client（`web-remote-replayable`，含纯 Web 客户端）允许 **load** 的键。
 *
 * 证据（grep packages/web、packages/ui 全部 ICredentialService/useCredentials 消费点，
 * 详见 packages/server/specs/server-auth.md M4 节）：
 * - `ModelProviderSection.tsx` 读 `oauth:active_provider` 与 zai/bigmodel 的 access_token
 *   判定登录态；
 * - `useCodingPlanEntryPlanList.ts` 读 zai/bigmodel access_token 拉团队套餐；
 * - Web 自身 OAuth 登录态存浏览器 localStorage（`BrowserOAuthCredentialRepo`），不经此通道；
 * - `remote-workspace:*` 凭据流在 Web 被 `allowRemoteWorkspace=false` 关闭，desktop 走本地
 *   host 通道（desktop-continuous 不受收窄影响）。
 *
 * 宁严勿松：仅上述只读消费面进入 allowlist；save/delete 对 terminal-client 一律拒绝。
 */
export const TERMINAL_CLIENT_CREDENTIAL_ALLOWED_KEYS: readonly string[] = [
  "oauth:active_provider",
  `oauth:${ZAI_PROVIDER_ID}:access_token`,
  `oauth:${BIGMODEL_PROVIDER_ID}:access_token`,
];

/** 键是否在 terminal-client 的 load allowlist 内。 */
export function isTerminalClientCredentialKeyAllowed(key: string): boolean {
  return TERMINAL_CLIENT_CREDENTIAL_ALLOWED_KEYS.includes(key);
}

/**
 * 把真实 credential 服务包成 terminal-client 收窄代理（供两套 server 的 overrides 使用）。
 *
 * - allowed 键的 `load` 委派真实服务；
 * - allowlist 外的 `load`、以及任何 `save`/`delete` 抛错（经 RPC 回传为调用失败）。
 *   拒绝是刻意的显式失败而不是静默返回 null：静默会让「登录态丢失」与「被安全策略拒绝」
 *   不可区分，排障时会误导。
 */
export function createTerminalClientCredentialGuard(
  real: CredentialChannelLike,
): CredentialChannelLike {
  const deny = (operation: string, key: string): never => {
    throw new Error(
      `Credential channel is restricted for terminal-client connections: ${operation} denied for key ${JSON.stringify(key)}`,
    );
  };
  // async 方法：拒绝以 rejected Promise 形式经 RPC 回传，而不是同步 throw。
  return {
    async load(key: string): Promise<string | null> {
      if (!isTerminalClientCredentialKeyAllowed(key)) {
        deny("load", key);
      }
      return real.load(key);
    },
    async save(key: string, _value: string): Promise<void> {
      deny("save", key);
    },
    async delete(key: string): Promise<void> {
      deny("delete", key);
    },
  };
}
