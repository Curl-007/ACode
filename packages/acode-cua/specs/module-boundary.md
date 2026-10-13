# Spec: acode-cua 模块边界（fail-closed 占位包 → 角色 B 收窄）

## 背景与产品规则

`packages/acode-cua` 是 Computer Use 的 API 兼容构建：它让所有既有消费者
（services 的 cua-permission-broker、desktop main、acode-cli node-repl-host/core）
在不改代码的前提下编译与运行，且任何**尚未落地**的 CUA 能力都以明确的
unavailable 语义失败，绝不静默降级为“看起来可用”。

本包承担 U14「角色范围洞裁决」（`docs/upgrades/product-and-support-2026-10.md`
§7.8「角色范围洞裁决」）拆出的**两个不同角色**，解析路径不同：

- **角色 B（host 侧 broker RPC 客户端 + host 编排）**：经**按名 import**
  （`workspace:*`）被 5 个 workspace 包消费，故**只能补实在本包内**（B-1 裁决，
  `product-and-support-2026-10.md:632-634`）。纯 JS、只依赖 node 内建，阶段 2 落地。
- **角色 A（Helper 侧原生 producer）**：`ax_native.node` + `windows-helper.js` +
  14 工具处理器，经**路径加载**（dev `ACODE_CUA_DEV_ROOT` / 产品
  `resources/tools/cua-helper`），由 `windowsCuaDevHelperHost` fork 运行，
  放仓内顶层 `cua-producer/`（glob 外，`product-and-support-2026-10.md:627`/`:619`）。
  **不进本包**——原生产物必带 `src/` + addon 构建步骤，与不变量 4 冲突
  （`product-and-support-2026-10.md:621`）。

> **实现状态（2026-10-13 更新）**：下文不变量 1 栏① 的**增量 1/2/3 已落地**
> （`broker.js` wire 客户端 + 谓词 + win32 socket 分支、`broker-server.js` marker 三件套 +
> `waitForCuaHelperStartup`、`index.js` `createComputerUseRuntime`；提交 562d132 / bcb7f95 / e0cd769）。
> **但角色 A（Helper 侧原生 + `windows-helper.js`）尚未落地，整条 CUA 链路仍不可用**——角色 B 只补
> host 侧纯 JS，Helper 缺席时端到端仍走 unavailable / `CUA_NOT_READY`（warming-up）语义，
> `execute` 对未接线 Helper 返回可重试的 not-ready 信封而非假成功。故「本包不再是占位」的说法
> **仍不成立**：栏② 的一切（Helper 服务端 `dispatchRequest` 系、原生 seam、mac-only、PiP、installer）
> 保持 fail-closed，且栏① 中 `isPotentialACodeCuaAgentMcpServer` / `isOfficialCuaPluginEnabledForWorkspace` /
> `createCuaProductMcpServerResolver` / `CuaProductHelperWorkspaceRegistry` / `isScreenCaptureProbeSuccess`
> 亦仍占位（最小可用集延后，见下栏）。

## 状态所有权

- 包本身无**业务持久**状态、无后台进程；`CuaHelperLifecycleManager` 仅持有调用方
  传入的 dispose 回调与当前 managed 引用（占位实现中 create 返回 undefined）。
  （marker 三件套的 WeakSet 是 host-keyed 的**派生标志位**，见下条——它随 host 回收，
  不是包自持的业务状态，故不违背「包不持有 host 生命周期」。）
- marker 三件套（`mark/has/clearCuaProductHelperAgentEnvUnavailable`）补实后是
  **host-keyed** 的 fail-closed 标志：以传入的 host 对象为 key（WeakMap/WeakSet 语义），
  **不同 host 对象互不串扰**，随 host 被回收而自然释放；包不持有 host 生命周期。
- 权限/Helper/PiP 的业务状态归消费者模块（services cua-permission-broker、
  `node.ts` 的 Helper lifecycle 层）所有；acode-cua 只提供协议类型、常量、host 侧
  wire 客户端与 fail-closed 实现。

## 公开接口（唯一合法访问面）

公开面 = `package.json` exports 的 12 个子路径，逐一映射到包根扁平文件：

| 导出子路径                  | 文件（.js / .d.ts）       |
| --------------------------- | ------------------------- |
| `.`                         | `index`                   |
| `./frame-contract`          | `frame-contract`          |
| `./host-display-contract`   | `host-display-contract`   |
| `./request-access-contract` | `request-access-contract` |
| `./pip-session`             | `pip-session`             |
| `./pip-session/node`        | `pip-session-node`        |
| `./broker`                  | `broker`                  |
| `./broker/server`           | `broker-server`           |
| `./broker/ports`            | `broker-ports`            |
| `./broker/socketPath`       | `broker-socket-path`      |
| `./broker/helperConstants`  | `broker-helper-constants` |
| `./broker/helperHealth`     | `broker-helper-health`    |

架构检查器没有 `<pkgRoot>/src/<subpath>` 之外的包内解析约定，因此
`architecture-policy.yaml` 的 `global.aliasRules` 为每个子路径声明精确映射
（模块级 aliasRules 只对本模块内部导入生效，覆盖不了外部 importer，故必须
声明在 global 段）。`publicEntrypoints` 与上表 .js 文件一一对应。

角色 B 补实**不新增导出子路径、不新增公开类型、不改 `.d.ts`**（见不变量 3）：
`isBrokerMethod` / `isReadOnlyBrokerMethod` 的 wire 语义收窄在**实现体内**完成，
其 `broker.d.ts:92-93` 的签名（`method is BrokerMethod` / `boolean`）保持不变。

## 不变量

### 不变量 1：fail-closed 收窄（精确到函数）

原「全部运行时表面 fail-closed」按 U14 §7.8 裁决收窄为**两栏**。栏① **已随阶段 2
角色 B 增量 1/2/3 落地**；栏② 与未列进栏① 的一切**仍 fail-closed**（角色 A 就位前不变）。

**① 阶段 2 角色 B 已实现（host 侧纯 JS，B-1 + §7.8 三分裁决；提交 562d132/bcb7f95/e0cd769）**

下表「补实后语义」栏描述的是**已落地**的实现（不再是目标状态）。「补实后语义」列名保留以对照
下方栏② 的 fail-closed 现状。

| 函数                                       | 文件                   | 补实后语义                                                                                                                                                      | 依据                                                                                                    |
| ------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `callBrokerMethod`                         | `broker.js:39`         | 链路乙 **wire 客户端**：连 `socketPath`、写请求行、读到 `\n` 解析响应；`ok:false` 抛 `BrokerError`（透传 `error.code`），绝不返回空成功                         | wire spec §2/§3/§4.2/§4.3                                                                               |
| `probeHelperHealth`                        | `broker.js:43`         | 发带外 `broker_info` 探测，返回真实 `{bundleId,pid}`；**探测失败必须 throw，不得返回 `{bundleId:null,pid:null}`**（该空值形态正是当前占位返回值，补实后禁止）   | wire spec §6.1/§6.4；`product-and-support-2026-10.md:641`                                               |
| `isBrokerMethod`                           | `broker.js:90`         | = `COMPUTER_METHOD_NAMES.includes(method)`（14 方法能力表谓词）                                                                                                 | wire spec §8.1                                                                                          |
| `isReadOnlyBrokerMethod`                   | `broker.js:94`         | = `isBrokerMethod(method) && !MUTATING_METHODS.has(method)`（14−10=4 只读）                                                                                     | wire spec §8.2                                                                                          |
| `mintBrokerSocketPath`（win32 分支）       | `broker.js:47`         | 补 win32 named-pipe 分支（`\\.\pipe\...`），非 win32 保持 `tmpdir/*.sock`；恒返回 `.sock` 盘符路径会让 Windows `net.listen` EACCES                              | `product-and-support-2026-10.md:471`/`:582`；链路甲 `node-repl-host/src/cua-broker.ts:27-29` 为同形参照 |
| `createComputerUseRuntime`                 | `index.js:3`           | `execute` 经 `callBrokerMethod` 走真实 socket，返回 `CallToolResult` 形态                                                                                       | wire spec §5.4；`product-and-support-2026-10.md:676`                                                    |
| `markCuaProductHelperAgentEnvUnavailable`  | `broker-server.js:162` | host-keyed 置位 fail-closed 标志                                                                                                                                | `node.ts` mark 3 处（`:583`/`:586`/`:1231`）                                                            |
| `hasCuaProductHelperAgentEnvUnavailable`   | `broker-server.js:164` | host-keyed 读位；门控 spawn 返回 `BROKER_UNAVAILABLE` env 还是 `{BROKER_SOCKET_ENV, ACODE_CUA_PLUGIN_AUTHORITY_ENV_KEY}` 元组                                   | `node.ts` has 8 处（`:1102`/`:1115`/`:1142`/`:1163`/`:1179`/`:1197`/`:1221`）                           |
| `clearCuaProductHelperAgentEnvUnavailable` | `broker-server.js:168` | host-keyed 清位（健康恢复时）                                                                                                                                   | `node.ts:1110`                                                                                          |
| `waitForCuaHelperStartup`                  | `broker-server.js:150` | 有界 deadline race；**超时须抛 `CuaHelperError` `code:"caller_timeout"`**（语义 = 共享 30s startup 仍在后台跑、不设 retryAt），不得忽略 `deadlineMs` 直接 await | `node.ts:1159`/`:1191`；`:1211` 精确判 `isCuaHelperError(error) && error.code === "caller_timeout"`     |
| `isPotentialACodeCuaAgentMcpServer`        | `broker-server.js:154` | **包内自包含**匹配 CUA candidate（见不变量 2 补注）；fail-closed 方向**宁可过判不漏判**                                                                         | `node.ts:789` stale-generation 过滤                                                                     |

**② 仍 fail-closed 直至对应角色就位**

- **Helper 服务端（随角色 A 的 `windows-helper.js`）**：`dispatchRequest`
  （`broker.js:82`）/ `handleRequestLine`（`broker.js:86`）/ `parseRequestLine`
  （`broker.js:59`）——虽物理位于 `broker.js`，但**全仓 0 host 消费者**，是 Helper
  服务端原语，归角色 A（§7.8「纠正二」，`product-and-support-2026-10.md:671`/`:678`）。
- **原生 seam（角色 A）**：`loadRealNativeAddon` / `resolvePackagedNativeAddonPath` /
  `resolveInTreeAddonPath` / `createAxReadOnlyMethods` / `ROLE_TO_KIND` / `roleToKind`
  （6 项，`broker-server.js:45-65`）。
- **refresh marker（角色 A）**：`cuaBrokerRefreshMarkerPath` /
  `publishCuaBrokerRefreshMarker`（2 项，`broker-server.js:37-43`；standalone-helper 懒启动机制）。
- **macOS-only 面（阶段 2/3/4 均不触碰，§7.7 平台门槛）**：`buildHelperOpenArgs` /
  `isCuaLocalDevelopmentRuntime` / `resolveHelperPermissionSubjectIdentity` /
  `createCuaHelperInstaller` / `defaultCuaHelperVerifierDependencies` /
  `createProductCuaHelperHost` / `reapOrphanedHelpers` /
  `requestHelperAccessibilityPermissionViaLaunchServices` /
  `requestHelperScreenRecordingPermissionViaLaunchServices`（9 项，
  `product-and-support-2026-10.md:666`）。
- **角色 B 拥有、但阶段 2 首版未列入上表①的三项 host 编排占位**（§7.8 表① 判其归角色 B，
  但仍保持占位、**不等角色 A**；是否随阶段 2 首版补实取决于「最小可用集」分类，属待裁决项）：
  `isOfficialCuaPluginEnabledForWorkspace`（`broker-server.js:132`，恒 false——dev/internal
  路径被 `isACodeCuaInternalFeatureEnabled` 默认 true 短路，`node.ts:1697`）、
  `createCuaProductMcpServerResolver`（`broker-server.js:136`，passthrough——上游**开源侧同为
  stub**（`zcode-cua/broker-server.js:137-139` 的 `resolveMcpServers` 直接 `return servers`），
  其真实形态在闭源 producer，无法据开源材料确认是否 passthrough，故本项延后证据较软，属待裁决）、
  `CuaProductHelperWorkspaceRegistry`（`broker-server.js:95`，`setEnabled` no-op——全仓
  **write-only、无读者**，`node.ts:1685` 构造 + `:2191`/`:2203`/`:2214` 三处 set，无 get）。
- **端口/探针门控（2026-10-13 主循环核实：`isScreenCaptureProbeSuccess` 属 macOS-only 可达，已从栏①移出）**：
  `shouldRunCuaScreenCaptureProbe`（`broker-ports.js:5`）恒 false，且其下游
  `isScreenCaptureProbeSuccess`（`broker-server.js:158`）的唯一消费者
  `runCuaScreenCaptureReadinessProbe`（`node.ts:729-742`）只在 `getStatus` 的
  `node.ts:1975` 被调，而 `:1975` 被 `shouldUseCuaPermissionService`（`node.ts:709-714`，
  `platform === "darwin" && cuaEnabled`）门控——Windows 上 `getStatus` 在 `:1894-1902`
  就早退返回 not-enabled，**永不触达 probe**（且 `:1971-1974` 探针注释全是 macOS TCC/WindowServer 语义）。
  故 `isScreenCaptureProbeSuccess` 当前是 macOS-only 可达、**不在 C05 Windows dev 路径上**，
  归角色 B 但**阶段 2 首版不补实**（保持占位不影响 Windows）。初稿 §7.8 三分把它列进「Windows 会执行」栏
  是过宽，据本次核实纠正。若未来 Windows 也接入 screen-capture 探针（阶段 3+），再随该特性补实。
- **PiP**：`pip-session.js` / `pip-session-node.js` 的 `createPipSessionClient().enabled === false`。
- **installer**：`createCuaHelperInstaller(...).ensureInstalled` 仍以 `CuaHelperError` 拒绝。

> **不得写成整包不再是占位。** 上表①只是把 host 侧纯 JS 从 fail-closed 收窄为真实实现；
> **角色 A（Helper 侧原生）就位前，整条链路仍不可用**——Helper 缺席时 `execute` 仍走
> unavailable 语义，marker 三件套仍会把 spawn fail-closed 到 `BROKER_UNAVAILABLE`。

### 不变量 2：无反向依赖

包内只 import node 内建模块与包内相对文件；`requires: []` 保持。

- **角色 B 净新增 import 只有 `node:net`（builtin）**——`callBrokerMethod` /
  `probeHelperHealth` 用 `net.createConnection` 连 socket/named pipe；
  `node:crypto` / `node:os` / `node:path` 已在用（`broker.js:1-3`）。**不引入任何
  workspace 依赖或第三方包**，否则 `requires: []` 与单层 `layers: { app: "." }`
  的架构登记需一并修订（`product-and-support-2026-10.md:639`）。
- **`isPotentialACodeCuaAgentMcpServer` 不能 import `@acode/shared` 的单一事实源**
  （`isACodeCuaMcpCommand` / `isACodeCuaMcpPackageArg`，`packages/shared/src/mcp.ts:259`/`:268`）：
  acode-cua `requires: []`，反向 import `@acode/shared` 会破坏不变量 2 与依赖方向。
  故须在**包内自包含匹配**，并**用 services 侧对照测试防漂移**（见下）。

  **`node.ts:789` 消费点的 `server` 对象实际形状（本仓核实）**：`node.ts:789` 的
  `servers?.filter((server) => !isPotentialACodeCuaAgentMcpServer(server))` 中，
  `servers` 来自 `createDynamicCuaProductMcpServerResolver` 的 `resolveMcpServers(servers, …)`
  （`node.ts:781`）。两个上游调用点都传 `ACodeAgentMcpServer[]`：
  `acodeSessionService.ts:183`（`withResolvedMcpServers`，`params.mcpServers`）与
  `acodeTaskServiceAdapter.ts:346`（`resolveProductMcpServers`）。故谓词入参是
  `ACodeAgentMcpServer`（`packages/shared/src/mcp.ts:166-197`）——一个 **stdio | http/sse
  联合类型**：
  - stdio 变体：`{ name: string; command: string; args: string[]; env: Array<{name,value}>; … }`；
  - http/sse 变体：`{ name: string; type: "http"|"sse"; url: string; headers: …; … }`。

  **谓词须匹配的字段**（与 `mcp-config.ts:168-186` `isACodeCuaStdioServer` 的判别面对齐，
  fail-closed 宁可过判）：
  1. `name === "computer-use"`（`mcp.ts:10` `ACODE_CUA_OFFICIAL_PLUGIN_ID` 的用户露出名；
     `node.ts:1073`）；
  2. **stdio 变体的 `command`** 命中 acode-cua 包规格（在包内复刻
     `matchesACodeCuaSpec` + `acodeCuaArgLeaf`，`mcp.ts:228-252`：下划线归一、`@`/`==`/`[`/`.`
     边界、路径叶子）；
  3. **stdio 变体的 `args`** 任一元素命中同一包规格；
  4. **`env` 是 `Array<{name,value}>`（非 Record）**，须**扫描数组**找
     `{ name: "ACODE_PLUGIN_ID"（mcp.ts:16）, value: "computer-use@acode-plugins-official" }`
     ——官方 plugin server 的 command/args 都不含 acode-cua 字样，只有 `_plugin` id env 可识别
     （`mcp-config.ts:174-182`）。

  **防漂移方案（主循环建议，本 spec 采纳）**：在 **services 侧**（不受本包 `requires: []`
  约束，可同时 import 两处）加对照测试，对**同一组样本**断言 acode-cua 的
  `isPotentialACodeCuaAgentMcpServer` 与 `@acode/shared` 的
  `isACodeCuaMcpCommand`/`isACodeCuaMcpPackageArg`（+ name/plugin-id 判别）判定一致，
  把「两处漂移」变成测试可抓。测试文件在 services，不写进 acode-cua，不破坏不变量 2。

### 不变量 3：API 兼容

导出名与类型签名保持与上游真实 CUA 包一致，消费者零改动。

- 角色 B 补实**只在实现体内**收窄语义，**不新增导出、不改 `.d.ts`**。
- **常量表为 `broker.js` 模块私有**：14 方法表 `COMPUTER_METHOD_NAMES`、10 变更方法表
  `MUTATING_METHODS`、`PLATFORM_EXCLUDED_METHODS`（`Object.freeze({})`）、17 条错误码映射表
  ——逐字复制自 Apache-2.0 上游
  `apps/zcode-cli/packages/zcode-cua-plugin/scripts/computer-use-client.mjs`（`:30-45`/`:60-71`/
  `:57`/`:76-95`；许可登记见 wire spec §8.5），**在 `broker.js` 内以模块私有 `const` 持有，
  不 `export`、不进 `broker.d.ts`**。上游 `computer-use-client.mjs` 导出 `COMPUTER_METHOD_NAMES`
  是 **plugin SDK 客户端**的公开面，**不是 `broker.js` 的公开面**——两者分属不同层。
- **`isBrokerMethod` 不是 `callBrokerMethod` 的传输门（关键正确性约束）**：14 方法表是
  **能力命名空间**谓词（供 SDK 挂载 `cua.computer.*` 与角色 A `dispatchRequest` 派发用），
  **不得**用来 gate `callBrokerMethod` 能发哪些 method。host 侧存在**带外控制面方法**：
  `node.ts:1926` 经 `callBrokerMethod` 发 `method:"permission_status"`、`probeHelperHealth`
  发 `method:"broker_info"`（wire spec §6.1），二者都**不在 14 表内**。若 `callBrokerMethod`
  以 `isBrokerMethod` 为前置门，这两条控制面调用会被误判为非法（→ `method_not_found`）。
  故 `callBrokerMethod` 对 method 名**透明转发**；方法合法性由**服务端**（角色 A）判定。

### 不变量 4：布局冻结

保持扁平 .js/.d.ts 构建（不引入 `src/`、不新增构建步骤）；`module.ts` / `contract.ts` /
`contract.example.ts` 为治理工件，运行时与根 typecheck（tsc -b 清单不含本包）均不编译它们。
角色 B 补实**不破坏本不变量**（纯 JS 直接写进现有扁平 `.js`）；角色 A 的原生产物（必带
`src/` + addon 构建）**不进本包**，走 `cua-producer/` 路径加载（见「迁移边界」）。

## 失败语义

- 任何“CUA 是否可用”的判定失败都必须落到 denied / unknown / unavailable，
  不得因异常路径泄露探测能力或伪造成功。
- 环境变量逃生门（ACODE_CUA_PERMISSION_BROKER_SOCKET /
  ACODE_CUA_PERMISSION_BROKER_UNAVAILABLE / ACODE_CUA_HELPER_ADDON）只影响
  socket 路径解析与显式禁用，不能让未落地的能力变为可用。
- **Helper 缺席/未就绪时的可观测行为由 `specs/broker-wire-protocol.md` 定义，验收以其为准**：
  - warming-up 期 `runtime.execute` 返回 `CUA_NOT_READY` **非 error 结果**（单文本块装
    JSON 信封，`{kind:"CUA_NOT_READY", reasonCode:"broker_not_accepting", retryable:true}`），
    **不返回 isError 结果、不抛错**（抛错会绕过 SDK 的 not-ready 退避重试循环，wire spec §5.4）；
    `possibly_sent ⇒ retryable=false`（防重放红线，wire spec §5.2）。
  - `probeHelperHealth` 探测失败**必须 throw**（`broker_unavailable`/`timeout`/非法响应），
    **不得返回 `{bundleId:null,pid:null}`**（wire spec §6.4）。
  - `callBrokerMethod` 遇连接失败/非法 JSON/`ok:false`/`ok:true` 缺 `result`/超时**一律抛
    `BrokerError`**，绝不返回看似成功的空值（wire spec §4.3）。

## 迁移边界

U14 §7.8 裁决已**推翻**旧措辞「真实能力经 `@acode/acode-cua-plugin`（插件商店分发）提供；
本包永远保持占位」——它与两个角色的实际落地路径冲突。更新为：

- **角色 B（host 侧纯 JS）补实在本包内**（B-1 裁决，`product-and-support-2026-10.md:632-634`）：
  因为它经 `workspace:*` 按名 import 被 5 个包消费，pnpm 只会解析到 workspace 内的
  `packages/acode-cua`，放 glob 外的 `cua-producer/` **不会被按名 import 解析到**
  （`product-and-support-2026-10.md:628`）。补实已随阶段 2 增量 1/2/3 落地（见不变量 1「实现状态」）。
- **角色 A（Helper 侧原生 producer）走仓内 `cua-producer/` 路径加载**
  （`product-and-support-2026-10.md:627`/`:619`）：不进 workspace 解析图，靠
  `ACODE_CUA_DEV_ROOT`（dev）/ `resources/tools/cua-helper`（产品）被
  `windowsCuaDevHelperHost` fork。**不放本包**——原生产物必带 `src/` + addon 构建步骤，
  与不变量 4 直接冲突（`product-and-support-2026-10.md:621`）。
- **两角色解耦但须同批端到端**：角色 B 纯 JS、不受 C++ 工具链阻塞，可先行并对 fixture
  socket 单测；角色 A 解阻后对接，两者一起才能让端到端首次跑通（C05，
  `product-and-support-2026-10.md:680`）。
- **向后兼容承诺保留**：无论角色 B 补实还是角色 A 对接，`package.json` exports 的
  **12 个子路径与公开类型保持向后兼容**——消费者零改动，`.d.ts` 不因补实而变。
- **回退**：任一角色未就绪时保持 fail-closed 语义（返回 unavailable，不静默降级）；
  任何阶段失败不得让 CUA「看起来可用」（`product-and-support-2026-10.md:587`）。

## 验收场景

1. 架构检查：`node scripts/architecture/architecture-check.mjs context acode-cua`
   显示 owner、契约文件与 publicEntrypoints；`check` 对本模块零违规。
2. 导入解析：services / desktop / acode-cli 中所有
   `@acode/acode-cua/<subpath>` 导入都解析到上表声明的 publicEntrypoints，
   无 deep-import、无 unresolved-workspace-import。
3. 运行时（仍 fail-closed 面）：消费者调用 Helper 侧 / 原生 / mac-only / PiP / installer
   入口得到明确的 unavailable 错误（`BrokerError` `code: unavailable`、`CuaHelperError`
   `code: helper_unavailable`）或 isError 结果，进程不崩溃。
4. **角色 B 落地后的运行时验收（已由测试锁定，2026-10-13）**：测试落 `apps/acode-cli/tests/`
   （本包无 test 脚本，managed 模块塞测试会被当生产源码严格检查且跑不到）——
   `cua-broker-wire.test.mjs`（`broker.js` wire 客户端 + 谓词 + win32 socket 分支，22 用例）、
   `cua-broker-server-host.test.mjs`（marker 三件套 + `waitForCuaHelperStartup`，11 用例）、
   `cua-runtime-execute.test.mjs`（`index.js` execute 结果契约，18 用例）。
   - **Helper 缺席/未就绪时的可观测行为以 `specs/broker-wire-protocol.md` 为准**（见「失败语义」）：
     `execute` 在 warming-up 期返回 `CUA_NOT_READY` 非 error 信封、不抛错；`probeHelperHealth`
     探测失败必 throw 而非返回 `{null,null}`；`callBrokerMethod` 失败一律抛 `BrokerError`。
     本 spec **不重复定义**该行为，只登记「验收以 wire spec 为准」。
   - **marker 三件套的门控行为验收**（host-keyed）：
     - `mark(host)` 后 `has(host) === true`；`clear(host)` 后 `has(host) === false`；
     - **不同 host 对象互不串扰**：`mark(hostA)` 不得让 `has(hostB) === true`
       （两个独立 host 对象各持自己的标志）；
     - host 被 GC 回收后标志随之释放（WeakMap/WeakSet 语义，不内存泄漏）；
     - 与 `node.ts` 门控对接：`has(host) === true` 时 `buildCuaProductHelperAgentEnv`
       返回 `{ [BROKER_UNAVAILABLE_ENV]: … }`，`clear` 后恢复返回
       `{ [BROKER_SOCKET_ENV], [ACODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] }` 元组
       （`node.ts:1115-1120`/`:1171-1174`）。
   - **`waitForCuaHelperStartup` 超时验收**：超过 `deadlineMs` 抛 `CuaHelperError`
     `code:"caller_timeout"`（被 `node.ts:1211` 精确捕获，不设 retryAt）。
   - **不变量 3 的控制面透明性验收**：`callBrokerMethod` 能发 `permission_status` /
     `broker_info` 等**非 14 表**方法而不被本地拒绝（`isBrokerMethod` 不 gate 传输）。
   - **`isPotentialACodeCuaAgentMcpServer` 防漂移验收**：services 侧对照测试断言其与
     `@acode/shared` 单一事实源在同一组样本上判定一致（不变量 2 补注）。
