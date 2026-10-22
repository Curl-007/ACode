# @acode/acode-cua

Computer Use 的 API 兼容包。本包不是「所有表面都惰性」的占位包——它按面分工，
**两个面的 fail-closed 语义不同**，混为一谈会导致误判（例如以为设了 dev env 也安全）。

## 服务端 / Helper 面：真惰性 fail-closed

Helper 服务端派发、原生 seam、macOS-only 权限面、PiP、installer 等**全部拒绝执行**：

- `dispatchRequest` / `handleRequestLine` 直接 throw `CuaHelperError`；
- `createProductCuaHelperHost()` 返回全方法 unavailable 的空 host（`start`/`restart`/
  `checkHealth` reject，`queryScreenCaptureProbe` 恒 `{ok:false}`）；
- `loadRealNativeAddon()` throw；权限请求恒 `{ok:false, reason:UNAVAILABLE}`；
- 谓词 `isOfficialCuaPluginEnabledForWorkspace` / `isCuaLocalDevelopmentRuntime` /
  `isScreenCaptureProbeSuccess` 恒 `false`。

## 客户端 wire 面：完整实现，由门控关闭（非惰性）

`broker.js` 的 `callBrokerMethod` / `sendBrokerRequest` / `probeHelperHealth` 是**功能完整**
的 socket 客户端（真 `createConnection`、真收发、字节级行缓冲、`possibly_sent` 语义）；
`index.js` 的 `createComputerUseRuntime` **仅在未传 `brokerSocketPath` 时**返回 unavailable，
一旦拿到 socketPath 就会真下发 click/type/key 等变更类动作。它的关闭**不是靠自身惰性**，
而是靠下面两道外部门控：

1. **缺省无 `brokerSocketPath`**：runtime 未接线 Helper 时 `execute()` 返回 `isError`。
2. **上游 workspace 插件启用门控**：`packages/services/src/node.ts` 的 `isCuaEnabledForContext`
   （`:2273` 处的 `cuaPluginEnabled`）决定是否注入 broker socket env。注意
   `isACodeCuaInternalFeatureEnabled`（`@acode/shared` runtimeEnv）**现已默认 ON**——生产端
   到端 fail-closed 实际落在 `shouldCreateDefaultCuaProductHelper` 的 admission（仅
   `desktop-local` 才建 Helper）+ 本包 Helper host 是无法启动的 stub（拿不到 live broker）。

### 激活条件（dev 旋钮可打开活路径）

设 `ACODE_CUA_DEV_MODE=1` 或 `ACODE_CUA_PRODUCT_HELPER=1`（后者 `=0/false/off` 显式关闭），
配合 `ACODE_CUA_DEV_ROOT` 指向 `cua-producer/` 树内 Helper，即可在本地激活客户端活路径。
**这不是安全边界**——它是有意的本地开发旋钮；生产 fail-closed 由上面的门控与 Helper 打包状态
（阶段 5 打包/签名未落地）共同保证，而非「占位包全惰性」。

License: Apache-2.0。契约细节见 `CONTRACT.md` 与 `specs/module-boundary.md`。
