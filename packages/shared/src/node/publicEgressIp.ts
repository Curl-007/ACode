// ============================================================
// 公网出口的 IP 阻断表（单一事实源）
// ============================================================
// 判定「一个字面量 IP 是否属于不可出网的段」：环回、私网、链路本地、CGNAT、组播、保留，
// 以及把内网/保留 IPv4 编码进 IPv6 字面量的过渡段（NAT64 WKP / 6to4 / Teredo）。
//
// **为什么住在 @acode/shared 而不是 @acode/contracts**：消费方跨两个 pnpm 目录树——嵌套 CLI 侧的
// doctor endpoint-policy、adapters 的 public-egress-policy、core 的 WebFetch egress guard，以及根侧
// 的 @acode/server-cli（release 下载出口校验）。根 `packages/*` 当前**不依赖任何嵌套包**（2026-11-04
// 全仓实测零命中），让 server-cli 反向依赖 @acode/contracts 会新开一条依赖方向、并把整个 CLI 契约面
// 拖进远端 server 的发布物；而 @acode/contracts 本就依赖 @acode/shared，故表放这里、由 contracts
// re-export，两侧都可达且不产生第二套真相。
//
// 补段时所有消费方同时收紧（安全方向，无放宽）。本文件是 Node-only（依赖 node:net 的 BlockList），
// 只能经 `@acode/shared/node` 子路径导入，renderer/browser bundle 不得引入。

import { BlockList, isIP } from "node:net";

export type IpAddressVersion = 0 | 4 | 6;

export interface PublicEgressIpBlockReason {
  reason: string;
  version: IpAddressVersion;
}

interface BlockedIpRange {
  address: string;
  family: "ipv4" | "ipv6";
  prefix: number;
  reason: string;
}

const BLOCKED_IP_RANGES: BlockedIpRange[] = [
  { address: "0.0.0.0", family: "ipv4", prefix: 8, reason: "unspecified IPv4 address" },
  { address: "10.0.0.0", family: "ipv4", prefix: 8, reason: "private IPv4 address" },
  { address: "127.0.0.0", family: "ipv4", prefix: 8, reason: "loopback IPv4 address" },
  {
    address: "100.64.0.0",
    family: "ipv4",
    prefix: 10,
    reason: "carrier-grade NAT IPv4 address",
  },
  { address: "169.254.0.0", family: "ipv4", prefix: 16, reason: "link-local IPv4 address" },
  { address: "172.16.0.0", family: "ipv4", prefix: 12, reason: "private IPv4 address" },
  { address: "192.168.0.0", family: "ipv4", prefix: 16, reason: "private IPv4 address" },
  {
    address: "192.0.0.0",
    family: "ipv4",
    prefix: 24,
    reason: "IETF protocol assignment IPv4 address",
  },
  { address: "198.18.0.0", family: "ipv4", prefix: 15, reason: "benchmark IPv4 address" },
  { address: "224.0.0.0", family: "ipv4", prefix: 4, reason: "multicast IPv4 address" },
  { address: "240.0.0.0", family: "ipv4", prefix: 4, reason: "reserved IPv4 address" },
  { address: "::", family: "ipv6", prefix: 128, reason: "unspecified IPv6 address" },
  { address: "::1", family: "ipv6", prefix: 128, reason: "loopback IPv6 address" },
  { address: "fc00::", family: "ipv6", prefix: 7, reason: "unique-local IPv6 address" },
  { address: "fe80::", family: "ipv6", prefix: 10, reason: "link-local IPv6 address" },
  { address: "ff00::", family: "ipv6", prefix: 8, reason: "multicast IPv6 address" },
  // IPv6 过渡/保留段（对抗复核 F1）：这些段会把内网/保留 IPv4 地址编码进 IPv6 字面量
  // （如 NAT64 WKP `64:ff9b::a9fe:a9fe` 内嵌 169.254.169.254 云元数据地址），仅凭
  // IPv4 段与既有 IPv6 段判不到。
  {
    address: "64:ff9b::",
    family: "ipv6",
    prefix: 96,
    reason: "NAT64 well-known prefix (RFC 6052)",
  },
  { address: "2002::", family: "ipv6", prefix: 16, reason: "6to4 transition range (RFC 7526)" },
  { address: "2001::", family: "ipv6", prefix: 32, reason: "Teredo tunneling range (RFC 7359)" },
];

const BLOCKED_PUBLIC_EGRESS_RANGES = BLOCKED_IP_RANGES.map((range) => {
  const blockList = new BlockList();
  blockList.addSubnet(range.address, range.prefix, range.family);
  return { ...range, blockList };
});

export function normalizeIpAddressLiteral(value: string): string {
  return value.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
}

export function getIpAddressVersion(value: string): IpAddressVersion {
  return isIP(normalizeIpAddressLiteral(value)) as IpAddressVersion;
}

/**
 * 返回阻断理由；`undefined` 表示这是一个可出网的公网地址。
 *
 * 注意 `version === 0`（根本不是 IP 字面量）也会返回一个理由——调用方必须自己先判版本，
 * 否则会把所有域名都当成「被阻断」。既有三个消费方都是先 `getIpAddressVersion(...) !== 0`
 * 再调本函数，新消费方照此办理。
 */
export function getPublicEgressIpBlockReason(value: string): PublicEgressIpBlockReason | undefined {
  const normalized = normalizeIpAddressLiteral(value);
  const version = isIP(normalized) as IpAddressVersion;
  if (version === 0) {
    return { reason: "not an IP address", version };
  }

  const family = version === 4 ? "ipv4" : "ipv6";
  // BlockList 按 CIDR 匹配时能覆盖 IPv4-mapped IPv6，
  // 避免手写正则漏掉 ::ffff:7f00:1 这类标准化后的 loopback 表示。
  for (const range of BLOCKED_PUBLIC_EGRESS_RANGES) {
    if (range.blockList.check(normalized, family)) {
      return { reason: range.reason, version };
    }
  }

  return undefined;
}
