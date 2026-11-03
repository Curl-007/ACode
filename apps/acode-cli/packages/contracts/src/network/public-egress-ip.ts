// ============================================================
// 公网出口 IP 阻断表 —— re-export
// ============================================================
// 实现已上提到根 `@acode/shared` 的 Node-only 面（`packages/shared/src/node/publicEgressIp.ts`），
// 本文件只保留契约面的转发，使 `@acode/contracts` 的公开导出名逐字不变（`index.ts` 的
// `export * from "./network/public-egress-ip.js"` 因此无需改动，三个既有消费方
// ——adapters 的 doctor endpoint-policy、adapters 的 public-egress-policy、core 的 WebFetch
// egress guard——也无需改动）。
//
// 上提理由：根侧 `@acode/server-cli` 的 release 下载出口校验需要同一张表，而根 `packages/*`
// 当前不依赖任何嵌套包，反向依赖会新开依赖方向。放 shared、由 contracts 转发，两侧都可达
// 且只有**一份**阻断表——补段时所有消费方同时收紧。详见该文件头注释。
//
// 刻意用具名转发而不是 `export *`：`@acode/shared/node` 是个大桶（文件锁、凭据密码学、
// server auth、归档信任分级……），`export *` 会把它们全部灌进契约面，凭空放大 @acode/contracts
// 的公开表面。

export {
  getIpAddressVersion,
  getPublicEgressIpBlockReason,
  normalizeIpAddressLiteral,
  type IpAddressVersion,
  type PublicEgressIpBlockReason,
} from "@acode/shared/node";
