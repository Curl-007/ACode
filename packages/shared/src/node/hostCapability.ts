import { randomBytes } from "node:crypto";
import type { ServerRemoteHostCapability } from "../server-remote.js";

/**
 * 短期、一次性、绑定主体的 desktop host capability。
 *
 * 安全加固 P0-1：此前 `packages/server` 与 `packages/acode-server-cli` 各持一份等价实现，
 * 且只校验 nonce + TTL，不绑定已认证主体。这里收敛到 `@acode/shared/node` 单一实现，
 * 在 nonce + TTL 之上叠加**主体指纹绑定**与**单次兑换**语义，两套 server 共用，消除分叉。
 *
 * 状态所有者：仅存活于 server 进程内存（`Map<nonce, entry>`），不落盘、不跨进程共享。
 */

export const DEFAULT_HOST_CAPABILITY_TTL_MS = 30_000;

/**
 * 存活能力条目的硬上限。
 *
 * `purgeExpired` 只清理**已过期**条目，本身不限制存活数量；而 `POST /api/rpc-host-capability`
 * 在未配置 token 的 loopback 默认配置下是**无鉴权**的，且属于不需要 CORS 预检的 simple request。
 * 因此恶意网页可以在每个 TTL 窗口内跨源狂刷该端点，把 Map 无限撑大——一个可由浏览器触达的
 * 内存耗尽 DoS，且恰好落在本次加固声称要保护的那个面上。上限把每个进程的存活条目钉死在
 * 有界范围（远超真实用途：一台桌面同时最多几个 host 连接）。
 *
 * 满了之后 `issue` 直接拒绝而不是静默淘汰最旧条目——淘汰会让攻击者能定向踢掉合法桌面 host
 * 尚未兑换的能力，把 DoS 从「耗尽内存」变成「拒绝服务合法连接」。
 */
export const MAX_LIVE_HOST_CAPABILITIES = 256;

/** 已认证主体；`fingerprint` 为 token 的 sha256 前缀，不含原始 token。 */
export interface HostCapabilityPrincipal {
  fingerprint: string;
}

/** 未配置 token 的 loopback 场景主体（仍走鉴权 fail-closed 不变量，非 loopback 不允许无 token）。 */
export const ANONYMOUS_HOST_CAPABILITY_PRINCIPAL: HostCapabilityPrincipal = {
  fingerprint: "anonymous",
};

export interface HostCapabilityStoreOptions {
  ttlMs?: number;
  /** 存活条目硬上限；缺省 `MAX_LIVE_HOST_CAPABILITIES`。测试可注入更小值。 */
  maxLive?: number;
  now?: () => number;
  createCapability?: () => string;
}

interface HostCapabilityEntry {
  expiresAt: number;
  principal: HostCapabilityPrincipal;
}

export interface HostCapabilityStore {
  /**
   * 铸造一次性能力，绑定到已认证主体（缺省为 anonymous）。
   * 存活条目达 `MAX_LIVE_HOST_CAPABILITIES` 时返回 null（调用方应回 503），
   * 堵住无鉴权铸造端点被刷爆内存的 DoS。
   */
  issue(principal?: HostCapabilityPrincipal): ServerRemoteHostCapability | null;
  /**
   * 兑换能力：首次且未过期返回绑定主体，否则（无效/过期/重放）返回 null。
   * 无论成功与否都先作废该 nonce，杜绝可重放的长期提权声明。
   */
  consume(capability: string | undefined): HostCapabilityPrincipal | null;
}

/** 短期、一次性 desktop host capability；只在 server 进程内存中存在。 */
export function createHostCapabilityStore(
  options: HostCapabilityStoreOptions = {},
): HostCapabilityStore {
  const ttlMs = options.ttlMs ?? DEFAULT_HOST_CAPABILITY_TTL_MS;
  const maxLive = options.maxLive ?? MAX_LIVE_HOST_CAPABILITIES;
  const now = options.now ?? Date.now;
  const createCapability =
    options.createCapability ?? (() => randomBytes(32).toString("base64url"));
  const entryByCapability = new Map<string, HostCapabilityEntry>();

  const purgeExpired = (at: number): void => {
    for (const [capability, entry] of entryByCapability) {
      if (entry.expiresAt <= at) entryByCapability.delete(capability);
    }
  };

  return {
    issue(principal) {
      const issuedAt = now();
      purgeExpired(issuedAt);
      // 先清过期再判上限：让上限只约束「同时存活」的条目，而不是累计铸造次数。
      if (entryByCapability.size >= maxLive) {
        return null;
      }
      const capability = createCapability();
      const expiresAt = issuedAt + ttlMs;
      // 把能力与已认证主体指纹绑定；兑换时一并返回，供调用点核对主体一致。
      entryByCapability.set(capability, {
        expiresAt,
        principal: principal ?? ANONYMOUS_HOST_CAPABILITY_PRINCIPAL,
      });
      return { capability, expiresAt };
    },
    consume(capability) {
      if (!capability) return null;
      const consumedAt = now();
      const entry = entryByCapability.get(capability);
      // ticket 无论成功、过期还是重放都先删除，只有首次且 TTL 内的消费能获得主体；
      // 这样同一 capability 的二次兑换必然失败（单次兑换语义）。
      entryByCapability.delete(capability);
      purgeExpired(consumedAt);
      if (!entry || entry.expiresAt <= consumedAt) return null;
      return entry.principal;
    },
  };
}
