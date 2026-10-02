# WebFetch 公网出口策略（public egress）

安全分诊残留观察项 #1 的落地规格（来源：[`docs/security-scan-triage-2026-09-29.md`](../../../docs/security-scan-triage-2026-09-29.md) §3）。
WebFetch 的 URL 是**模型可控输入**（prompt injection 可诱导抓取任意域名），既有防线只拦
URL 字面量本地/私网目标；域名解析到内网 IP 的 DNS 重绑定可绕过字面守卫直达
`httpClientPort` 的 fetch 快速路径。适配器层的公网 DNS 校验实现
（`adapters/src/http/public-egress-policy.ts` + `index.ts` 的 `egressPolicy:"public"` 分支）
已存在但全仓无生产调用方——本 spec 把它接到 WebFetch，并定义代理场景的显式降级语义。

## 背景

### 已核实的现状（基线 91c1f71，行号实施前需复核）

- 字面守卫：`core/src/tool/handlers/webfetch-url.ts:117-128` 拒 localhost/.local/私网 IP
  字面量；`webfetch-network.ts:51-54` 每个真实 GET（含重定向逐跳）前
  `assertWebFetchLiteralEgress`；http→https 强制升级（`webfetch-url.ts:38-41`）使明文
  元数据端点大半不可达。
- 缺口：普通**域名**不做 DNS 预检（`webfetch-egress-guard.ts:24-25` 注释自认取舍）；
  解析到内网 IP 的 https 内网服务仍可达。
- 适配器既有能力：`egressPolicy:"public"` 时 ① `assertPublicEgressDestination` 建连前
  DNS 预检（解析结果全部须公网，`public-egress-policy.ts:79-119`）；② `createPublicEgressLookup`
  作为建连 lookup——真正连接使用**已过检的解析结果**，堵「预检与建连之间再解析」的
  TOCTOU；③ `assertPublicEgressProxyBoundary`（`index.ts:276-285`）：代理会在代理侧解析
  目标域名，本地 DNS 校验无法证明最终 IP——**无条件拒绝任何代理**。
- 产品冲突：WebFetch 有意支持用户代理（`resolveWebFetchProxyForRequest` +
  `capturedUserProxyEnvFallback`，代理环境用户依赖它出网）。③ 的无条件拒绝与代理支持
  不可同时成立，必须显式定义降级语义，而不是让「激活校验」悄悄打断代理用户。

## 产品规则

### R1 直连路径：强制公网 DNS 校验（TOCTOU-safe）

WebFetch 的每次 `httpClientPort.request`（含重定向逐跳）携带 `egressPolicy: "public"`。
无代理时适配器必须：建连前 `assertPublicEgressDestination`（所有解析地址均为公网，
否则 `egress_blocked`），且建连 lookup 走 `createPublicEgressLookup`（连接复用已过检
解析）。localhost/单标签主机名/私网与保留 IP 字面量在策略层同样拒绝
（`public-egress-policy.ts:125-139`，与字面守卫双保险）。保留地址段由
`contracts/src/network/public-egress-ip.ts` 的 `BLOCKED_IP_RANGES` 统一枚举（与
doctor endpoint-policy 共享同一张表），并包含 IPv6 过渡/保留段：`64:ff9b::/96`（NAT64
WKP）、`2002::/16`（6to4）、`2001::/32`（Teredo）——对抗复核 F1：这类段会把内网/保留
IPv4 地址编码进 IPv6 字面量（如 `64:ff9b::a9fe:a9fe` 内嵌云元数据地址），缺段即被
误判公网。**直连路径无逃生舱**：不提供关闭校验的配置或 env。

### R2 代理路径：显式 opt-in 降级，可观察

代理侧 DNS 不可验证是物理事实，不允许假装校验。语义分两档：

- **缺省（严格）**：`egressPolicy:"public"` 且解析出代理 → `egress_blocked` 拒绝
  （既有 `assertPublicEgressProxyBoundary` 行为不变，未来强出口调用方依赖它）。
- **显式 opt-in**：请求携带 `allowProxiedPublicEgress: true`（新契约字段）且解析出
  代理 → 跳过 DNS 预检继续请求，防线退化为「调用方字面守卫（R3）+ 代理侧解析」，
  并在响应 `egress.publicEgressDnsVerified: false` 如实记录（直连过检时为 `true`）。
  该字段是**降级授权**，不是开关：仅 WebFetch 允许设置（R4）。

### R3 字面守卫保留，不因 R1/R2 削弱

`assertWebFetchLiteralEgress` 的每跳字面检查原样保留：它是代理路径（R2 opt-in）的
唯一 URL 层防线，也是直连路径 DNS 校验前的第一道过滤。http→https 升级、重定向
同 host/协议/端口限制（`webfetch-url.ts:63-83`）不变。

### R4 降级授权只属于 WebFetch

`allowProxiedPublicEgress` 仅允许出现在 WebFetch 的请求构造点
（`webfetch-network.ts`）。其他 `httpClientPort` 调用方（模型 provider、插件下载、
账号同步等）设置 `egressPolicy:"public"` 时不携带该字段——它们要么直连过检、
要么被拒，代理兼容问题在各自产品面单独决策。代码评审以本条为准绳。

### R5 残余风险登记（诚实边界）

- 代理路径的 DNS 重绑定面**保留**：攻击者域名经用户代理解析到「代理所在网络」的
  内网地址仍可达（不是用户本机 LAN）。缓解：字面守卫拒私网 IP 字面量；企业出口代理
  通常不可达用户 LAN；`publicEgressDnsVerified:false` 使该状态可观察。代理侧校验
  （如 PAC 感知的解析验证）超出本项范围。
- DoH/自定义 resolver 场景下 `dns.lookup` 结果与真实建连解析可能不一致——由
  `createPublicEgressLookup` 消除（连接使用过检地址），仅 R2 代理路径不适用。

## 状态所有者

```
core/src/tool/handlers/webfetch-url.ts        字面守卫 + https 升级 + 重定向限制（不变）
core/src/tool/handlers/webfetch-network.ts    请求构造点：egressPolicy:"public" + allowProxiedPublicEgress:true（R4 唯一授权点）
contracts/src/interfaces/http-client.port.ts  HttpClientRequest.allowProxiedPublicEgress / HttpClientEgressInfo.publicEgressDnsVerified
adapters/src/http/index.ts                    分支裁决：直连→DNS 预检+过检 lookup；代理→缺省拒绝 / opt-in 降级+标记
adapters/src/http/public-egress-policy.ts     校验实现（既有，不改语义）
```

## 接口

- `HttpClientRequest` 新增可选 `allowProxiedPublicEgress?: boolean`（附加式扩展，
  既有调用方零影响）。
- `HttpClientEgressInfo` 新增可选 `publicEgressDnsVerified?: boolean`：仅
  `egressPolicy:"public"` 的请求携带；随既有 `emitNetworkRequestStatus` 的 egress
  字段流向事件/调试面（可观察性要求，AGENTS.md）。
- `assertPublicEgressProxyBoundary` 语义不变（缺省严格档的执行体）。

## 验收场景

见 `apps/acode-cli/tests/webfetch-public-egress.test.mjs`：

1. 策略函数行为：域名解析到 127.0.0.1 / 10.x / 169.254.x → 拒（`egress_blocked`）；
   解析到公网地址 → 过；`localhost`/`*.local`/单标签主机名 → 拒；私网 IP 字面量 → 拒；
   DNS 零地址 → 拒；abort signal 透传。
2. 接线钉住：`webfetch-network.ts` 的请求构造含 `egressPolicy: "public"` 与
   `allowProxiedPublicEgress: true`；`adapters/src/http/index.ts` 的代理分支由
   `allowProxiedPublicEgress` 门控（缺省仍走 `assertPublicEgressProxyBoundary`）；
   契约含两个新字段。
3. 全仓唯一授权点：`allowProxiedPublicEgress` 在 `apps/acode-cli/packages/**/src` 中
   仅出现于契约定义、适配器分支与 `webfetch-network.ts`（R4）。

## 不在本项范围

- 代理侧 DNS 校验（R5 登记为残余）。
- 其他 httpClientPort 调用方的 egressPolicy 接入（R4：各自产品面单独决策）。
- `webfetch-url.ts` 字面守卫规则集的扩展（既有面不动）。
