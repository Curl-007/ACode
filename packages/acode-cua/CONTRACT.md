# acode-cua contract

Computer Use 的 API 兼容包。本包承担两个角色（U14 §7.8「角色范围洞裁决」）：
**角色 B（host 侧 broker RPC 客户端 + host 编排，纯 JS，补实在本包内）**与
**角色 A（Helper 侧原生 producer，走仓内 `cua-producer/` 路径加载，不进本包）**。

**角色 B 的增量 1/2/3/4 已落地（2026-10-13/14，对应提交 562d132/bcb7f95/e0cd769/96dea05）**：`broker.js` wire 客户端

- 谓词 + win32 socket 分支、`broker-server.js` marker 三件套 + `waitForCuaHelperStartup` +
  `isPotentialACodeCuaAgentMcpServer`（增量 4：包内自包含 CUA candidate 判别 + services 侧
  防漂移对照测试）、`index.js` `createComputerUseRuntime`。
  **角色 A 现状（2026-10-14，A1/A2/A3 批次）**：Helper 侧原生 producer 已在 `cua-producer/`
  树内落地并 **14/14 wire handler 齐套**（A1 骨架 + A2 指针/键盘/截图 + A3 UIA 六工具；
  契约见 `cua-producer/specs/windows-helper-producer.md`），宿主平台判定面（阶段 4）同批
  收口。**dev 链（`ACODE_CUA_DEV_ROOT`）已具备端到端物质基础**（真机烟测 --capture/--uia/
  --host 实证）；C05/C07 真机人工验收待执行。**产品链仍不可用**——阶段 5 打包/签名未落地，
  且角色 B 中**仍占位**的 4 项（`isOfficialCuaPluginEnabledForWorkspace`、`createCuaProductMcpServerResolver`、
  `CuaProductHelperWorkspaceRegistry`、`isScreenCaptureProbeSuccess`）
  见 `specs/module-boundary.md` 不变量 1 栏②。Helper 缺席时端到端
  仍走 unavailable / `CUA_NOT_READY`（warming-up）语义，绝不静默降级为“看起来可用”。

* 真实公开面 = `package.json` exports 的 12 个子路径，映射到包根下的扁平
  `.js`/`.d.ts` 文件（无 `src/` 目录、无构建步骤）。`contract.ts` 是类型
  精选阅读视图，不新增运行时导出。
* 跨模块导入只能使用 exports 子路径（如 `@acode/acode-cua/broker/server`）；
  架构检查器经 `architecture-policy.yaml` 的 `global.aliasRules` 把子路径
  解析到实际文件，并以其为 publicEntrypoints 做 deep-import 校验。

## 类型无法表达的不变量（角色 B 收窄后）

- **谓词不再一律恒 `false`**：`isBrokerMethod`（`broker.js:90`）/ `isReadOnlyBrokerMethod`
  （`broker.js:94`）**已补实**，依 14 方法能力表返回真实判定（wire spec §8.1/§8.2），
  **不再恒 `false`**。`isPotentialACodeCuaAgentMcpServer`（`broker-server.js:225`）**已补实**
  （增量 4）为包内自包含 CUA candidate 判别（`name` / stdio `command`/`args` 包规格 /
  `env` 数组官方 plugin id 四维，见下「依赖方向与常量表」），**不再恒 `false`**。仍恒 `false`
  （角色 B 拥有但阶段 2 首版延后，见 `specs/module-boundary.md`
  不变量 1 栏②）：`isScreenCaptureProbeSuccess`（`broker-server.js:245`，
  经核实 macOS-only 可达、不在 C05 Windows 路径）、`isOfficialCuaPluginEnabledForWorkspace`
  （`broker-server.js:132`，插件 enablement 默认 OFF，dev/internal 路径被短路）、
  `isOfficialCuaImageRefText`（`frame-contract.js:7`，frame 面仍占位）、
  `shouldRunCuaScreenCaptureProbe`（`broker-ports.js:5`）。
- **`callBrokerMethod`（`broker.js:39`）已实现为链路乙 wire 客户端**：连 `socketPath`、
  写请求行、读到 `\n` 解析响应；`ok:false` 抛 `BrokerError`（透传 `error.code`），
  连接失败/非法 JSON/缺 result/超时一律抛错，**绝不返回空成功**（wire spec §2/§3/§4.2/§4.3）。
  **`isBrokerMethod` 不是它的传输门**：host 侧带外控制面方法（`node.ts:1926` 的
  `permission_status`、`probeHelperHealth` 的 `broker_info`）不在 14 表内，`callBrokerMethod`
  对 method 名透明转发（不变量 3；wire spec §6.1/§9.2）。
- **`probeHelperHealth`（`broker.js:43`）已补实**：发带外 `broker_info` 返回真实
  `{bundleId,pid}`；**探测失败必 throw，不再返回 `{bundleId:null,pid:null}`**
  （该空值形态曾是占位返回值，现已消除；wire spec §6.4）。Windows 无 CFBundle id 时
  `bundleId=null` 但探测仍成功（health 门只校 PID）。
- **`dispatchRequest`（`broker.js:82`）/ `handleRequestLine`（`broker.js:86`）/
  `parseRequestLine`（`broker.js:59`）在本包内保持 fail-closed（裁决：不回填）**：虽物理位于
  `broker.js`，但全仓 0 host 消费者，是 **Helper 服务端**原语——角色 A 已按 producer spec
  §1.2 裁决 (b) 在 `cua-producer/src/wire-server.ts` **树内自建**同构实现（A1 落地，A2/A3
  扩展），本包占位三件套**永不回填**、仍以 `CuaHelperError` 拒绝（§7.8「纠正二」，
  `product-and-support-2026-10.md:671`/`:678`）。
- **marker 三件套**（`mark`/`has`/`clearCuaProductHelperAgentEnvUnavailable`，
  `broker-server.js:255`/`:260`/`:265`）**已补实**为 **host-keyed** fail-closed 标志（WeakSet，
  随 host 回收、不泄漏），不同 host 对象互不串扰；门控 `node.ts` 的 spawn 返回 `BROKER_UNAVAILABLE`
  env 还是 broker 凭据元组。`waitForCuaHelperStartup`（`broker-server.js:150`）**已补实**为超时抛
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
  （`isACodeCuaMcpCommand` / `isACodeCuaMcpPackageArg`）——那会破坏 `requires: []`。**已按此
  补实为包内自包含匹配**（增量 4，`broker-server.js:225`：对 `ACodeAgentMcpServer` 的 `name` /
  stdio `command` / `args` / `env: Array<{name,value}>` 中的 `ACODE_PLUGIN_ID` 判别，包内复刻
  `mcp.ts:228-252` 判别面），并用 **services 侧对照测试防漂移**——已落地
  `packages/services/test/cuaAgentMcpPredicateParity.test.ts`
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
