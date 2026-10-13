# acode-cua contract

Computer Use 的 API 兼容包。本包承担两个角色（U14 §7.8「角色范围洞裁决」）：
**角色 B（host 侧 broker RPC 客户端 + host 编排，纯 JS，补实在本包内）**与
**角色 A（Helper 侧原生 producer，走仓内 `cua-producer/` 路径加载，不进本包）**。

**收窄随阶段 2 角色 B 实现提交生效**；在该提交落地前，本包仍是全量 fail-closed 占位。
**角色 A 就位前整条 CUA 链路仍不可用**——角色 B 只补 host 侧纯 JS，Helper 缺席时端到端
仍走 unavailable 语义，绝不静默降级为“看起来可用”。

- 真实公开面 = `package.json` exports 的 12 个子路径，映射到包根下的扁平
  `.js`/`.d.ts` 文件（无 `src/` 目录、无构建步骤）。`contract.ts` 是类型
  精选阅读视图，不新增运行时导出。
- 跨模块导入只能使用 exports 子路径（如 `@acode/acode-cua/broker/server`）；
  架构检查器经 `architecture-policy.yaml` 的 `global.aliasRules` 把子路径
  解析到实际文件，并以其为 publicEntrypoints 做 deep-import 校验。

## 类型无法表达的不变量（角色 B 收窄后）

- **谓词不再一律恒 `false`**：`isBrokerMethod`（`broker.js:90`）/ `isReadOnlyBrokerMethod`
  （`broker.js:94`）补实后依 14 方法能力表返回真实判定（wire spec §8.1/§8.2），
  **不再恒 `false`**；`isPotentialACodeCuaAgentMcpServer`（`broker-server.js:154`）、
  `isScreenCaptureProbeSuccess`（`broker-server.js:158`）同样补实。仍恒 `false` 的谓词：
  `isOfficialCuaImageRefText`（`frame-contract.js:7`，frame 面仍占位）、
  `shouldRunCuaScreenCaptureProbe`（`broker-ports.js:5`）、
  `isOfficialCuaPluginEnabledForWorkspace`（`broker-server.js:132`，插件 enablement 默认 OFF）。
- **`callBrokerMethod`（`broker.js:39`）将实现为链路乙 wire 客户端**：连 `socketPath`、
  写请求行、读到 `\n` 解析响应；`ok:false` 抛 `BrokerError`（透传 `error.code`），
  连接失败/非法 JSON/缺 result/超时一律抛错，**绝不返回空成功**（wire spec §2/§3/§4.2/§4.3）。
  **`isBrokerMethod` 不是它的传输门**：host 侧带外控制面方法（`node.ts:1926` 的
  `permission_status`、`probeHelperHealth` 的 `broker_info`）不在 14 表内，`callBrokerMethod`
  对 method 名透明转发（不变量 3；wire spec §6.1/§9.2）。
- **`probeHelperHealth`（`broker.js:43`）** 补实后发带外 `broker_info` 返回真实
  `{bundleId,pid}`；**探测失败必须 throw，不得返回 `{bundleId:null,pid:null}`**
  （该空值形态是当前占位返回值，补实后禁止；wire spec §6.4）。
- **`dispatchRequest`（`broker.js:82`）/ `handleRequestLine`（`broker.js:86`）/
  `parseRequestLine`（`broker.js:59`）仍 fail-closed 直至角色 A**：虽物理位于 `broker.js`，
  但全仓 0 host 消费者，是 **Helper 服务端**原语，随角色 A 的 `windows-helper.js` 落地
  （§7.8「纠正二」，`product-and-support-2026-10.md:671`/`:678`）。当前仍以 `CuaHelperError` 拒绝。
- **marker 三件套**（`mark`/`has`/`clearCuaProductHelperAgentEnvUnavailable`，
  `broker-server.js:162`/`:164`/`:168`）补实后是 **host-keyed** fail-closed 标志，
  不同 host 对象互不串扰；门控 `node.ts` 的 spawn 返回 `BROKER_UNAVAILABLE` env 还是
  broker 凭据元组。`waitForCuaHelperStartup`（`broker-server.js:150`）补实后超时抛
  `CuaHelperError` `code:"caller_timeout"`（`node.ts:1211` 精确判），不再忽略 `deadlineMs`。
- **其余运行时表面仍 fail-closed**：Helper 侧 `dispatchRequest` 系、原生 seam
  （`loadRealNativeAddon` 等）、macOS-only 面（installer / `createProductCuaHelperHost` /
  LaunchServices 权限请求等）、PiP（`createPipSessionClient().enabled === false`）、
  installer（`ensureInstalled` 以 `CuaHelperError` 拒绝）——以 `BrokerError` /
  `CuaHelperError`（`code: unavailable` / `helper_unavailable`）拒绝。
- **权限端口保持隐私 fail-closed 语义**（宁可报 denied/unknown，不泄露探测能力）。
- **Helper 缺席/未就绪时 `execute` 返回什么，以 `specs/broker-wire-protocol.md` 为准**：
  warming-up 期返回 `CUA_NOT_READY` **非 error 信封**（不抛错、不返回 isError 结果），
  `possibly_sent ⇒ retryable=false`（wire spec §5.2/§5.4）。

## 依赖方向与常量表

- **`requires: []`**——包内只 import node 内建模块；禁止 acode-cua 反向依赖任何
  workspace 模块。角色 B 净新增 import 只有 **`node:net`（builtin）**，`requires: []` 保持。
- `isPotentialACodeCuaAgentMcpServer` **不能 import `@acode/shared` 的单一事实源**
  （`isACodeCuaMcpCommand` / `isACodeCuaMcpPackageArg`）——那会破坏 `requires: []`。须在包内
  **自包含匹配**（对 `ACodeAgentMcpServer` 的 `name` / stdio `command` / `args` /
  `env: Array<{name,value}>` 中的 `ACODE_PLUGIN_ID` 判别），并用 **services 侧对照测试防漂移**
  （详见 `specs/module-boundary.md` 不变量 2 补注）。
- **常量表（14 方法表 / 10 变更方法表 / `PLATFORM_EXCLUDED_METHODS` / 17 条错误码映射）
  为 `broker.js` 模块私有**：逐字复制自 Apache-2.0 上游 `computer-use-client.mjs`，
  **不新增导出、不改 `.d.ts`**（上游导出 `COMPUTER_METHOD_NAMES` 是 plugin SDK 客户端的公开面，
  不是 `broker.js` 的公开面；许可登记见 wire spec §8.5）。

- **链路乙 broker wire 协议（host RPC 客户端 ↔ Helper broker 服务端）见
  `specs/broker-wire-protocol.md`**：传输/framing、请求响应行、错误码映射、`CUA_NOT_READY`
  信封、`probeHelperHealth` health 探测、14 方法表、角色 A 服务端派发。角色 B/A 的 wire
  行为一律以该 spec 为准。
- 边界、不变量收窄两栏清单、迁移边界与验收场景见 `specs/module-boundary.md`。
