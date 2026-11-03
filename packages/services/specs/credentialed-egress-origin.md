# Spec：携凭据出站请求的目标 origin 姿态

实现：`src/providers/api/requestEgressPolicy.ts`（策略）、`src/providers/api/nodeApiClient.ts`（接线）、
`packages/desktop/src/main/startupSanitation.ts`（打包态 drop 闭集）
测试：`packages/services/test/request-egress-origin.test.ts`（8 用例）
登记来源：`docs/security/mimosa-findings-triage-2026-11.md` §6.3.3 缺口二、`docs/tech-debt-backlog.md`

## 背景与威胁模型

services 侧有一批请求把 OAuth / login access token 放进 `Authorization` 头发往**由 env 或设置项决定的
origin**：ACode 端点族（`ACODE_BASE_URL` / `ACODE_ENDPOINT_ORIGIN`）、zai 族
（`ZAI_BUSINESS_BASE_URL` / `ZAI_OAUTH_ORIGIN` / `ZAI_OAUTH_*_URL`）、bigmodel 族
（`BIGMODEL_API_BASE_URL` / `BIGMODEL_OAUTH_*_URL`）、配额族（`*_USAGE_QUOTA_URL`）。加固前的统一校验
只有 `normalizeACodeEndpointOrigin`（`packages/shared/src/acodeEndpoint.ts:87-98`）：非空 + `new URL()`
可解析 + 协议为 http/https，**无主机校验、无环回/私网/链路本地/metadata 阻断**。

三条放大风险的事实：

1. 这些键**既不在** `PACKAGED_BOOT_ENV_DROP_KEYS` **也不在** `SANITIZED_RUNTIME_ENV_KEYS`，故打包桌面下
   用户 shell env 会存活进 main/host。
2. `REMOTE_RUNTIME_ENV_KEYS`（`packages/server/src/remote/connect.ts:56-68`）会把其中四个
   （`ACODE_BASE_URL`、`ACODE_ENDPOINT_ORIGIN`、`ZAI_OAUTH_ORIGIN`、`ZAI_BUSINESS_BASE_URL`）
   **转发给远端 server**，于是一条桌面 shell env 能影响远端主机的出站目标。
3. `packages/services/specs/agent-command-env-gate.md` R3 **覆盖不到**这一类：经核实该 spec 全文不含
   URL / endpoint / ssrf / fetch / origin，其门禁实体全是「替换实际执行的代码面」。
   全仓 16 个 spec 目录对 endpoint env 的出站姿态**零裁决**——是未覆盖，不是已裁决。

### 主次必须说清楚（否则会误判本 spec 的价值）

- **主威胁是 token 外泄，而攻击者的 origin 通常是公网的。** R3 的私网阻断**挡不住**那种情况；
  要挡住它需要的是 origin 白名单，那是产品决策（见「残余」1）。对症的主防线是 **R5**：打包态
  不让不可信 shell env 决定 origin。
- R3 是**纵深防御 + 一类具体滥用**：把凭据送到 `169.254.169.254`（云 metadata）、`127.0.0.1`
  或内网主机——凭据落进元数据服务、以及借 server 的网络位置探测内网。这类目标**就是**非公网地址。

## 产品规则

### R1 守卫落在 `NodeApiClient.request`，不落在逐个调用点

`NodeApiClient.request` 是 services 侧 ACode 后端出站的**唯一咽喉**：OAuth / config / billing / quota /
snapshot 等链路都经 `dependencies.apiClient.request(...)` 或 `readApiJson(apiClient, …)`，且
`src/node.ts` 只创建一个实例。

为什么不能靠枚举调用点：实测这批站点**多数不含字面量 `Authorization:`**，而是走 header 工厂
（`createZaiLoginAuthHeaders` / `createBigModelBizHeaders` / `createBigModelLoginAuthHeaders` /
`createBizAuthHeaders`），故 `grep Authorization` 会**漏掉**它们——§6.3.3 点名的 4 处自己就在漏网之列，
实测同型站点还有 ≥6 处。把安全属性绑在「能否枚举全调用点」上，等于绑在 grep 模式上。

守卫位置：在 `rewriteACodeEndpointUrl` **之后**（rewrite 会把默认 origin 换成 env/设置决定的 origin，
那才是真正要发出去的地址），在凭证读取与建连**之前**，与既有的
`assertNoOfficialPlatformUrl` 双断言同一位置同一理由。

刻意**不判断「这次请求是否真的带了凭据」**：那会把安全属性绑在调用方的 header 组装顺序上，
正是本仓库反复踩过的形态。宁可多判。

### R2 协议白名单：只允许 http/https

`file:` / `data:` / `gopher:` 等一律拒（`unsupported_protocol`）。**本条不受 R4 放行开关影响**：
那些协议对自建后端与 e2e 同样没有合法用途，而 `file:` 能把本地文件读进响应体。

### R3 主机与地址校验

- 主机名字面量：`localhost`、`*.localhost`、`*.local`、非 IP 的单标签主机名一律拒（`blocked_host`）。
- IP 字面量：环回、私网、链路本地、CGNAT、组播、保留、unspecified，以及把内网 IPv4 编进 IPv6
  字面量的过渡段（NAT64 WKP / 6to4 / Teredo）一律拒（`blocked_address`）。判定表见 R7。

**刻意不做 DNS 预检**：本函数在每个 API 请求的热路径上，逐请求解析会引入一次网络往返与新的失败
模式。adapters 那条路做预检，是因为它按 `egressPolicy: "public"` **显式选择**了那个代价。后果如实
登记在「残余」3：指向「解析到私网地址的公网域名」不在本模块射程内。

### R4 三条放行来源，且显式选项只能收紧

`resolveAllowNonPublicRequestTarget` 的优先级：

1. 调用方显式传入 `allowNonPublic`（**只能收紧**：`false` 压过 env 的放行信号；不存在用选项放宽的路径）；
2. `ACODE_ENDPOINT_ALLOW_PRIVATE_ORIGIN=1`——自建/私有 ACode 后端的显式放行；严格 `=== "1"`，
   与本仓既有形态一致；
3. 运行时 test 姿态（`resolveRuntimeACodeEnv(env) === "test"`）——开发与 e2e 要打本地 server。

第 2、3 条为什么**不削弱**威胁模型：`ACODE_ENV` 与整个 endpoint 族键都在 R5 的打包态 drop 闭集里，
打包桌面启动即被删除，攻击者拿不到这两条通道；而能设置它们的人本来就能设置 `ACODE_BASE_URL` 本身。

第 3 条与既有机制咬合：`isTrustedCodingPlanWebviewOrigin` 同样只在 e2e 旗标
（`VITE_ACODE_E2E_STORE_BRIDGE === "1"`）下才信任 loopback。本 spec 沿用「loopback 是 e2e 专用」这一
既有判断，不新立一套。

放行档下 R2 仍然强制（见上）。

### R5 打包态 drop 闭集扩充（**用户可见变更**）

`PACKAGED_BOOT_ENV_DROP_KEYS` 新增 15 个键：endpoint 族（`ACODE_BASE_URL`、`ACODE_ENDPOINT_ORIGIN`）、
zai 族（`ZAI_BUSINESS_BASE_URL`、`ZAI_BUSINESS_LOGIN_URL`、`ZAI_OAUTH_ORIGIN`、
`ZAI_OAUTH_AUTHORIZE_URL`、`ZAI_OAUTH_TOKEN_URL`、`ZAI_OAUTH_USERINFO_URL`）、bigmodel 族
（`BIGMODEL_API_BASE_URL`、`BIGMODEL_OAUTH_AUTHORIZE_URL`、`BIGMODEL_OAUTH_TOKEN_URL`、
`BIGMODEL_OAUTH_USERINFO_URL`）、配额族（`ACODE_BIGMODEL_USAGE_QUOTA_URL`、
`BIGMODEL_USAGE_QUOTA_URL`），以及 **`ACODE_ENDPOINT_ALLOW_PRIVATE_ORIGIN` 本身**。

- 放行开关**必须**一并删除，否则它就成了绕过整个闭集的后门。
- 删除同时切断 `REMOTE_RUNTIME_ENV_KEYS` 的转发链（键已不存在，自然转发不出去）。
- 姿态依据与 `autoUpdater.ts:880-907` 对 `ACODE_UPDATE_FEED_URL` 的 isPackaged 门禁同源（P1-7）：
  打包发行版不以 shell env 作为信任相关配置的通道。
- **刻意不删凭据类键**（`ACODE_BIGMODEL_USAGE_API_KEY` / `BIGMODEL_USAGE_API_KEY`）：它们是密钥而非
  出站目标，不属本缺口射程；删除会直接打断合法用户，需独立裁决。见「残余」5。

**用户可见影响**：打包桌面下用 shell env 配置自定义 ACode/zai/bigmodel 端点的用户，升级后会静默
回落到默认端点。替代通道是设置项 `acodeEndpointOrigin`（写入侧在 `ACODE_ENV === "production"` 时早退，
但**读取侧无门禁**，故手工编辑 settings.json 的值仍然生效）。发布说明需要提及。

### R6 失败语义

被拒时抛 `RequestTargetBlockedError`（带 `code`），发生在任何 header 组装、凭证读取与建连之前。
不是静默降级，也不是 warn 后继续——携凭据请求发往错误 origin 的后果是不可撤销的（token 已出境）。

### R7 阻断表是单一事实源

复用 `@acode/shared/node` 的 `getPublicEgressIpBlockReason` / `getIpAddressVersion` /
`normalizeIpAddressLiteral`，与 doctor endpoint-policy、adapters public-egress-policy、core WebFetch
egress guard、acode-server-cli 的 release 下载源守卫共用同一份表（放置理由与上提经过见
`packages/acode-server-cli/specs/release-source-egress.md` R7）。补段时五处同时收紧。

## 验收场景

对应 `packages/services/test/request-egress-origin.test.ts`：

1. `https://` / `http://` 放行；`file:///etc/passwd`、`data:text/plain,token`、`gopher://` 一律
   `unsupported_protocol`。
2. `localhost`、`api.localhost`、`backend.local`、单标签 `intranet` → `blocked_host`。
3. 12 个非公网字面量全部 `blocked_address`，含云 metadata `169.254.169.254`、IPv4-mapped loopback
   `::ffff:7f00:1`、NAT64 内嵌 metadata `64:ff9b::a9fe:a9fe`；公网域名与 `93.184.216.34` 放行。
4. 三条放行来源逐一验证；`"true"` 不算放行（只认 `"1"`）；显式 `allowNonPublic: false` 压过
   `ACODE_ENV=test`。
5. 放行档下 `localhost:4000` 可用，但 `file:` / `data:` **仍然被拒**。
6. **接线端到端**：真实 `NodeApiClient` + stub fetch，请求 `https://169.254.169.254/…` 与
   `https://localhost:4000/…` 都抛 `RequestTargetBlockedError` 且 **stub fetch 调用次数为 0**；
   随后请求公网 origin **确实到达 fetch**（反向断言，防止「全拦掉」的假绿）。
7. drop 闭集含 endpoint 族键、含放行开关本身、含 `ACODE_ENV`。
8. **跨文件不变量**：`REMOTE_RUNTIME_ENV_KEYS` 中所有 origin/URL 类键都必须在 drop 闭集内
   （键名匹配 `_URL$|_ORIGIN$|BASE_URL$`），并断言该集合非空以防断言空转。

用例 6 的鉴别力已实测：摘掉 `nodeApiClient.ts` 里那一行接线后，其余 7 个用例**全部照绿**，
只有用例 6 变红——即叶子测试证明不了接线存在，用例 6 是承重的那一道。

## 残余与已知边界（记录，不在本 spec 修）

1. **公网 origin 的 token 外泄未被阻断**（本缺口的主威胁）。挡住它需要 origin 白名单，而白名单
   要回答「自建/私有部署算不算合法」，属产品决策。当前姿态是：打包态不信任 shell env（R5）+
   设置项由用户自己在本机写入（与 R3(c) 对 server-cli 的信任位置论证一致）。
2. **设置项 `acodeEndpointOrigin` 的读取侧无门禁**：写入侧在 `ACODE_ENV === "production"` 早退、
   UI 入口只在 `ACODE_ENV === "test"` 渲染，但手工编辑 settings.json 的值仍被采纳。本次**未改**：
   能编辑自己 settings.json 的人与能编辑自己 shell env 的人信任位置相同，而 R5 已经关掉了 env 通道；
   若要连设置通道一起关，需要 isPackaged 语义下沉到 services，属更大的改动。
3. **无 DNS 预检**（R3 的取舍）：公网域名解析到私网地址（DNS 重绑定、或内网 DNS 视图）不在射程内。
4. **只守了 `NodeApiClient` 这一个咽喉**。不经它出站的请求（例如 provider 侧用用户自填 baseUrl 的
   `providerBalanceProvider.ts`、`offPeakRuntimeModel.ts`，以及 oauth adapter 直连 userinfo/token 的
   路径）不在本 spec 射程内。它们的目标同样由 env/用户配置决定，需独立裁决——已登记。
5. **凭据类 env 键未纳入 drop 闭集**（R5 末条），需独立裁决。
6. **未做全仓普查**：只测绘了 `packages/` 下的同型站点（实测 ≥10 处，含 §6.3.3 漏记的 6 处）。
   `apps/acode-cli` 内是否有同类「env 决定 origin + 携凭据出站」的面，本次未查。
