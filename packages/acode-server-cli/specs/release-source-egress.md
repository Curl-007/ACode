# Spec：Release 下载源的出口策略

实现：`src/runtime/releaseSourcePolicy.ts`（策略）、`src/runtime/releaseDownload.ts`（接线）、
`src/packaging/stageCli.ts`（打包期例外）
测试：`tests/release-source-egress.test.mjs`（13 用例）
登记来源：`docs/security/mimosa-findings-triage-2026-11.md` §6.3.3 缺口一、`docs/tech-debt-backlog.md`

## 背景与威胁模型

`ACODE_SERVER_RELEASE_MANIFEST_URL` 决定 server CLI 从哪儿取更新目录，目录里的 `archiveUrl` /
`manifestUrl` 又决定下一跳去哪儿取**代码与组件归档**。这条链投递的是可执行物，加固前却是裸
`fetch(url, { redirect: "follow" })`：无协议白名单、无主机校验、无内网/环回/链路本地/metadata
阻断；schema 侧只有 `z.string().url()`（`src/contracts.ts:194-195`），而它**放行 `file:` / `data:` /
`gopher:`**。该 env 在本包原有的 5 个 spec 中零提及。

对照事实：桌面侧同样「由 env 决定下载哪份代码」的 `ACODE_UPDATE_FEED_URL` 早有 isPackaged 门禁
（`packages/desktop/src/main/autoUpdater.ts:880-907`，注释明引安全加固 P1-7），server-cli 侧一个都没有。

三条具体风险：

1. **非 HTTP 协议**：`file:///etc/passwd` 能通过 `z.string().url()`，被当成下载源交给 fetch。
2. **内网探测 / 云 metadata**：目录 URL 或其跳转目标指向 `169.254.169.254`、`127.0.0.1`、
   `10.0.0.0/8` 等，由 server 进程代为请求——它通常跑在权限与网络位置都比攻击者更高的主机上。
3. **重定向绕过**：`redirect: "follow"` 下，任何对首跳 URL 的校验都形同虚设，服务端一个 302
   就能把请求送到内网。

## 产品规则

### R1 守卫落在 fetch 层，不落在 env 读取处

`archiveUrl` / `manifestUrl` 来自目录**内容**而不是 env；只在 `updatePreparation.ts:67` 校验 env
那个 URL 的话，控制目录响应的人就能把下一跳指向任意地址。故守卫接在 `releaseDownload.ts` 的两个
fetch 站点（`fetchReleaseJson` 与 `downloadOnce`），一次覆盖三条 URL：env 的 catalogUrl、目录给的
archiveUrl、目录给的 manifestUrl。

这也是**唯一**的咽喉点：catalogUrl 根本不经过 schema，所以「在 schema 上加协议 refine」覆盖不全。
刻意不做第二道 schema 校验——一条路径，不是两条。

### R2 协议白名单：只允许 http/https

`file:` / `data:` / `gopher:` / `ftp:` 一律拒（`unsupported_protocol`）。**本条不受 R5 的放行开关
影响**：那些协议对内网镜像同样没有合法用途，而 `file:` 能把本地文件读进解析器。

### R3 主机与地址校验：默认拒绝非公网

- 主机名字面量：`localhost`、`*.localhost`、`*.local`、以及非 IP 的单标签主机名
  （`http://intranet/…`）一律拒（`blocked_host`）。
- IP 字面量：环回、私网、链路本地、CGNAT、组播、保留、 unspecified，以及把内网 IPv4 编进 IPv6
  字面量的过渡段（NAT64 WKP / 6to4 / Teredo）一律拒（`blocked_address`）。判定表见 R7。
- 域名：出网前解析，**解析出的全部地址**都必须公网；只校验 `addresses[0]` 会被「公网地址排前、
  内网地址排后」绕过。解析必须要求 `{ all: true, verbatim: true }`。零地址 → `dns_no_address`。

语义与 `apps/acode-cli/packages/adapters/src/doctor/endpoint-policy.ts` 对齐，不另立一套。

### R4 重定向逐跳校验

`fetchPublicReleaseSource` 用 `redirect: "manual"` 自己走跳，**每一跳都重新过 R2+R3**（先校验、
后建连）。相对 `Location` 按当前跳的 URL 解析。跳数上限缺省 5，超出即 `too_many_redirects`，
不静默截断也不无限跟随。3xx 但没有 `Location` 的不算跳转，按原样交回调用方按 HTTP 状态处理。

前提事实（2026-11-04 实测）：Node 全局 `fetch` 在 manual 档返回 `type: "basic"` 的 3xx，
`Location` 头可读——浏览器那套 opaqueredirect 过滤在 Node/undici 上不存在，故逐跳方案可行。

### R5 内网镜像放行开关

`ACODE_SERVER_RELEASE_ALLOW_PRIVATE_SOURCE=1` 时跳过 R3（主机名、IP 字面量、DNS 全跳过），
**R2 与 R4 仍然生效**。取值形态与本包 `ACODE_SERVER_SKIP_SERVICE_REGISTRATION` 一致（严格 `=== "1"`）。

为什么需要它：`packages/services/specs/agent-command-env-gate.md` R3(c) 已裁决「独立
acode-server-cli 分发不设打包标记：其管理员对本机有完全控制权，env 配置属合法用法」。全仓只有
`updatePreparation.ts:67` 一处读这个 env、没有任何代码设置它，即它纯粹是部署方的选择；把更新目录
指向内网镜像（自建 / 离线）因此是合法用法，无条件阻断私网会**静默打断**这类部署。

为什么它不削弱威胁模型：能设置这个开关的人本来就能设置 `ACODE_SERVER_RELEASE_MANIFEST_URL` 本身。
开关只是让管理员**显式**行使 R3(c) 已经承认的控制权，而不是给攻击者新能力。

调用方可以用 `allowPrivateSource: false` 强制收紧（显式选项优先于 env）；反向不成立——代码不能
用选项强制放宽到 env 未授权的范围之外。

### R6 失败语义

- 被拒时抛 `ReleaseSourceBlockedError`，其 `name` **不在** `releaseDownload.ts` 的
  `isRetryableDownloadError` 名单里，故「指向内网」这类配置错误立刻失败，不会重试三次后才失败。
- DNS 预检发生在建连之前，但**必须继承调用方的 signal**，否则一次挂死的解析会绕过
  `downloadOnce` 刚设好的 idle / overall 超时边界。
- 逐跳过程中每收到一个 3xx 都要把它的 body 收干（`body.cancel()`），否则 socket 不归还连接池。

### R7 阻断表是单一事实源，住在 `@acode/shared`

`getPublicEgressIpBlockReason` / `getIpAddressVersion` / `normalizeIpAddressLiteral` 的实现已从
`apps/acode-cli/packages/contracts/src/network/public-egress-ip.ts` **上提**到
`packages/shared/src/node/publicEgressIp.ts`，经 `@acode/shared/node` 子路径导出；contracts 侧改为
具名 re-export，公开导出名逐字不变（其 `index.ts:94` 的 `export *` 与三个既有消费方均无需改动）。

上提理由：消费方跨两个 pnpm 目录树——嵌套 CLI 侧的 doctor endpoint-policy、adapters 的
public-egress-policy、core 的 WebFetch egress guard，以及根侧的本包。根 `packages/*` 当前**不依赖
任何嵌套包**（2026-11-04 全仓实测零命中），让本包反向依赖 `@acode/contracts` 会新开一条依赖方向、
并把整个 CLI 契约面拖进远端 server 的发布物；而 `@acode/contracts` 本就依赖 `@acode/shared`，
且本包的 `module-boundary.md` 明确允许 `@acode/shared`（含 `/node` 子路径）。

刻意用具名 re-export 而不是 `export *`：`@acode/shared/node` 是大桶（文件锁、凭据密码学、
server auth、归档信任分级……），`export *` 会凭空放大 contracts 的公开表面。

**补段时四个消费方同时收紧**（安全方向，无放宽）。

### R8 打包期例外（`stageCli.ts`）

`src/packaging/stageCli.ts` 的 `downloadFile` 从 `ACODE_NODE_DIST_MIRROR`（CI 既有旋钮，见
`nodeDistMirror.ts` 与 `.gitlab/ci/00-workflow.yml`）下载 Node 二进制并打进发布物，此前同样是裸
`fetch(url, { redirect: "follow" })`。本次**只给它加 R2 协议白名单**，不加 R3 主机校验：

- 加 R2 的理由：`file:` / `data:` 对 dist 镜像没有任何合法用途，却能把构建机上的本地文件读进
  发布物；这条零破坏风险（所有真实镜像都是 http/https）。
- 不加 R3 的理由：指向内网镜像是 CI 的合法用法，而本函数跑在**构建机**上——能改构建机 env 的人
  本来就能直接改发布物，主机校验在这里不构成有意义的边界；无条件阻断则会打断发布管线。
- 该例外必须**显式**写成 `allowPrivateSource: true`（接线钉子会盯住这个字面量），避免日后被误读成
  「打包期也已全面加固」。

## 验收场景

对应 `tests/release-source-egress.test.mjs`：

1. `https://` / `http://` 放行，且 `plaintextHttp` 可观测；`file:///etc/passwd`、`data:text/plain,…`、
   `gopher://`、`ftp://` 一律 `unsupported_protocol`。
2. **开了 R5 放行开关，`file:` / `data:` 仍然被拒**（R2 不受开关影响）。
3. `localhost`、`release.localhost`、`mirror.local`、单标签 `intranet` → `blocked_host`。
4. 18 个非公网字面量全部 `blocked_address`，含云 metadata `169.254.169.254`、IPv4-mapped loopback
   `::ffff:7f00:1`、NAT64 内嵌 metadata `64:ff9b::a9fe:a9fe`；`8.8.8.8` / `1.1.1.1` /
   `93.184.216.34` 放行。
5. DNS 解析出 `[公网, 169.254.169.254]` → 拒（全部地址都要查）；全公网 → 放行且断言请求参数是
   `{ all: true, verbatim: true }`；零地址 → `dns_no_address`。
6. 字面量 IP 与放行开关两种情况都**不触发 DNS**（用恒抛的 stub 证明）。
7. 放行开关只在值恰为 `"1"` 时生效（`"0"` / `"true"` / `""` / `"yes"` 都不算）；显式
   `allowPrivateSource: false` 压过 env。
8. **首跳 302 指向 `http://169.254.169.254/latest/meta-data/…` 时：抛 `blocked_address`，且第二跳
   根本没有发出请求**（断言 fetch 调用次数为 1），并且传给 fetch 的 `redirect` 是 `"manual"`。
9. 多跳重定向逐跳校验，相对 `Location` 按当前跳解析，三跳的 URL 序列逐一断言。
10. `maxRedirects: 3` 时无限 302 环 → `too_many_redirects`，且 fetch 恰好被调用 4 次（首跳 + 3 跳）。
11. 3xx 但无 `Location` → 原样返回该响应（不当跳转）。
12. 已 abort 的 signal → DNS 预检不发解析，直接抛取消原因。
13. **接线钉子**：`releaseDownload.ts` 从 `releaseSourcePolicy.js` 导入守卫、守卫调用**恰好 2 处**、
    代码行内无裸 `fetch(`；`stageCli.ts` 有 `inspectReleaseSourceUrl(` 且显式写
    `allowPrivateSource: true`；运行时两个文件无 `redirect: "follow"`。静态断言一律先滤掉整行注释
    （说明性注释必然含被禁字面量）。

## 残余与已知边界（记录，不在本 spec 修）

1. **归档摘要的自指信任（最重要）**：`archiveSha256` 与 `archiveUrl` 来自**同一份目录**，期望值与
   被校验物同源。故控制了目录主机的人可以提供任意归档并附上匹配的摘要——**对这种攻击者，出口校验
   不是防线，签名才是**。验签（钉扎公钥分发、签名 sidecar 格式、`invalid` 的强制语义）已登记在
   `packages/server/specs/remote-deploy-hardening.md`「登记项 2」，属发布管线，本次不实装。
   出口校验防的是更窄的三类：配置错误指向内网、能设 env 但不控制公网的攻击者、以及对 server 宿主
   所在网络的探测。
2. **DNS 重绑定窗口未闭合**：DNS 预检与 fetch 自己的解析之间存在毫秒级窗口，记录可在其间改变。
   adapters 那条路是靠把校验过的 `lookup` 注入 `node:http` 闭合的；全局 `fetch` 要注入 `lookup`
   必须给本包新增 `undici` **直接依赖**（实测：Node 不暴露 `Agent`，`node:undici` 不可导入，
   `undici` 只是根 `node_modules` 的传递依赖），而 `module-boundary.md` 的允许清单不含它。
   本次裁决是**不为此新增直接依赖**：结合残余 1，能改 manifest 主机 DNS 的人已经能直接换归档。
   若日后要闭合，路径是「加 undici 直接依赖 + 改 module-boundary 允许清单 + 用 `dispatcher` 注入
   `connect.lookup`」。
3. **明文 http 允许**：R2 放行 `http:`，而代码投递走明文意味着归档可被中途替换（叠加残余 1 的
   自指摘要，替换不会被发现）。verdict 里保留了 `plaintextHttp` 供调用方观测，但当前无调用方
   据此告警——本次未加日志，避免把 `updatePreparation.ts` 拖进日志装配。
4. **R5 开关没有 isPackaged 类门禁**：它是纯 env 开关。依据是 R3(c) 对 server-cli 信任位置的既有
   裁决（管理员对本机有完全控制权）。若日后 server-cli 也要区分「管理员部署」与「被托管」两种
   信任位置，本开关需要重新裁决。
5. **未做全仓普查**：只审了本包 `src/` 内的 fetch 站点（3 处，全部处置）。仓库其它位置是否还有
   「env 或远端内容决定 URL 的裸 fetch」，本次未查。
