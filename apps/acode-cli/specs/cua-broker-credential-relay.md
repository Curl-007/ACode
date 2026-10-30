# CUA broker 凭据中继门（node_repl credential relay）

修复 `fix/cua-spawn-broker-credentials`。CLI bootstrap 把宿主下发的 CUA broker 凭据
（`ACODE_CUA_PERMISSION_BROKER_SOCKET` + `ACODE_CUA_PLUGIN_AUTHORITY`）中继进内置
`node_repl` MCP server 配置 env 的**资格门**（`cuaBridgeServerNames`）此前只认
「computer-use 插件启用记录」一个信号；dev/internal 链的宿主权威（Helper ready +
凭据随 agent spawn env 下发）与它分裂，导致凭据已到达 agent 进程却被扣在私有快照里，
`node_repl` 子进程缺 socket env → `agent.computerUse` fail-closed。

## 背景与根因（2026-10-31 取证）

CUA 启用判定在链路上存在**两个权威**，且缺省方向相反：

| 层 | 判定 | 缺省 | 位置 |
| --- | --- | --- | --- |
| 宿主（desktop/services） | `isCuaEnabledForContext` = `isACodeCuaInternalFeatureEnabled`(默认 **ON**) ∥ `isOfficialCuaPluginEnabledForWorkspace`(占位恒 false) | ON | `packages/services/src/node.ts:1726`、`packages/shared/src/runtimeEnv.ts:41` |
| CLI agent | `pluginRuntimeFeatures.computerUse` ⇐ `enabledPlugins["computer-use@…"] ?? tier(default_false)` | OFF | `packages/bootstrap/src/app/plugin-runtime-features.ts:17`、`acode-cua-plugin/.acode-plugin/plugin.json` |

宿主权威决定「是否创建 Helper、是否把 broker 凭据放进 agent spawn env」
（`node.ts:2276-2348`）；CLI 权威决定「是否把捕获的凭据中继进 node_repl 配置 env」
（`runtime-config.ts` 的 `cuaBridgeServerNames` → `mcp-config.ts` 的
`injectACodeCuaBrokerMcpServers`）。dev 链（`ACODE_CUA_DEV_MODE=1`）下宿主恒 ON、
CLI 恒 OFF（无落盘启用记录），中继门永闭。

取证（本机 2026-10-30 观测运行）：

1. Helper ready（host 日志 19:38:13）且无 broker_unavailable warn → 凭据已随 spawn env
   进入 agent 进程并被 `captureACodeCuaBrokerCredentials` 捕获（`runtimeEnv.ts:158`）。
2. 同日 22 次 agent bootstrap 全部 `enabledPluginCount: 11`（computer-use 不在内）；
   `~/.acode/cli/config.json` 不存在 → `computerUse` feature 恒 false。
3. 隔离实测：写入启用记录 + 捕获凭据后，`resolveAppRuntimeConfig` 注入链全通
   （node_repl env 含 socket/authority/marker）→ 读侧与装配侧机制健康，唯一断点是
   中继门与宿主权威的分裂。

`packages/acode-cua/CONTRACT.md`「fail-closed 边界」已把宿主 spawn-env 注入
（`node.ts` 的 `cuaPluginEnabled`）登记为客户端活路径的**唯一上游门控**；
`node-repl-host/src/server.ts:372` 的工具面同样只认 socket env。CLI 中继门叠加的
第二权威与这两处文档化契约相矛盾——本 spec 把中继门收敛回宿主权威。

## 所有者与事件顺序

```
desktop host (services/node.ts)          CLI agent 进程                    node_repl 子进程
──────────────────────────────          ──────────────────────────────   ─────────────────
isCuaEnabledForContext ──┐
  (dev/internal: ON)     │ spawn env: BROKER_SOCKET + PLUGIN_AUTHORITY
Helper lifecycle ────────┴────────────▶ CLI 入口 sanitize：捕获进私有快照
                                          （env 键被剔除，绝不下传其它子进程）
                                        bootstrap 装配：
                                          中继门 = computerUse feature
                                                ∥ (dev 激活旗标 ∧ 凭据已下发)
                                          开门 ⇒ injectACodeCuaBrokerMcpServers
                                          把凭据写进 node_repl 配置 env ────────▶ captureComputerUse
                                                                                   RuntimeFromEnvironment
                                                                                 socket 存在 ⇒ CUA 工具面活
```

- 凭据铸造/下发：宿主唯一所有（Helper transport tuple / darwin 懒启动铸造）。
- 凭据中继资格：CLI bootstrap 唯一所有（本 spec 的门）。
- 工具面启活：node-repl-host 唯一所有（socket env 驱动，既有语义不变）。

## 产品规则

- **R1 中继门双信号**：`node_repl` 进入 `cuaBridgeServerNames`（获得凭据注入资格）当且
  仅当 `configuredMcpServers.node_repl` 存在，且下列任一成立：
  - (a) `pluginRuntimeFeatures.computerUse === true`（用户经设置页开关落盘
    `enabledPlugins` 的显式启用路径，生产与 dev 通用，既有语义不变）；
  - (b) **dev 激活 ∧ 凭据已下发**：agent 进程 env 带显式 dev 激活旗标
    （`isACodeCuaDevActivationRequested`：`ACODE_CUA_DEV_MODE` 真值，或
    `ACODE_CUA_PRODUCT_HELPER` 显式真值——非空且非 `0/false/off`），且宿主已向本进程
    下发可解析的 broker socket（`hasDeliveredACodeCuaBrokerCredentials`，与注入器共用
    同一解析函数：捕获快照优先、env 兜底）。
- **R2 生产语义零变化**：dev 激活旗标是本地开发旋钮，正式 desktop bundle 在编译期
  关闭并在 main→host 边界删除（`runtimeEnv.ts:28-29` 既有边界），打包生产的 agent 进程
  收不到旗标 ⇒ (b) 恒闭 ⇒ 生产链中继仍**只**由设置页开关（(a)）驱动，
  「电脑控制默认关闭、需用户显式开启」的产品决策
  （`official-plugin-definitions.ts:247-255`）不受本修复影响。宿主未下发凭据时
  （生产 Helper stub / packaged runtime 无效 → `BROKER_UNAVAILABLE` 标记或空 env）
  (b) 同样恒闭。
- **R3 fail-closed**：门开不等于凭据被伪造——注入器无 socket 可写时原样 no-op；
  半组凭据（socket/authority 只出现一个）被 `captureACodeCuaBrokerCredentials` 清空
  且不落 env（CLI 入口已 sanitize），(b) 判定的「凭据已下发」随之为 false。
- **R4 authority 隔离不变**：`cuaBridgeServerNames` 仅作为 `omitMcpServers` 的注入
  资格集，绝不并入 `trustedOfficialCuaServerNames`（官方 CUA 图片 authority /
  exact-raster gate 的判定集，`runtime-config.ts:135-138` 既有注释约束保持）。
- **R5 下游校验不变**：`__acode-plugin-host` 的凭据恢复三门（plugin id + 捕获凭据组 +
  canonical socket，`cli/src/plugin-host-command.ts:83`）与 broker 连接门的代码签名
  身份裁决均不因本修复放宽。
- **R6 用户自设 dev 旗标自负**：用户在打包生产 shell 手工导出 `ACODE_CUA_DEV_MODE=1`
  属于文档化的本地开发开关（「不是安全边界」，`acode-cua/index.js:71-72`），且仍需
  宿主真的下发凭据（有效 Helper runtime）才可能开门，与宿主侧
  `isCuaEnabledForContext` 对同一旗标的既有解释一致。

## 接口

- `packages/shared/src/runtimeEnv.ts`：新增 `isACodeCuaDevActivationRequested(env?)`
  ——显式 dev 激活判定（缺省 false；与缺省 ON 的 `isACodeCuaInternalFeatureEnabled`
  是不同谓词，不得混用）。
- `apps/acode-cli/packages/bootstrap/src/mcp-config.ts`：新增
  `hasDeliveredACodeCuaBrokerCredentials()`——与 `injectACodeCuaBrokerMcpServers` 的
  socket 解析同源（`resolveACodeCuaBrokerSocket`），保证「门开 ⇒ 注入器有料可写」。
- `apps/acode-cli/packages/bootstrap/src/app/runtime-config.ts`：`cuaBridgeServerNames`
  装配按 R1 收敛。

## 验收场景（tests/cua-broker-credential-relay.test.mjs）

- **A1（本缺陷）**：dev 旗标 + 完整凭据捕获 + computerUse 未启用 + node_repl 注册
  → `runtimeConfig.mcp.servers.node_repl.env` 含 broker socket / plugin authority /
  `ACODE_CUA_NODE_REPL_HOST=1` / 官方 plugin id。
- **A2（生产形态钉住）**：无 dev 旗标 + 凭据捕获 + computerUse 未启用 → 不注入
  （R2：生产不因宿主下发凭据而绕过设置页开关）。
- **A3（开关路径钉住）**：computerUse=true + 凭据捕获（无 dev 旗标）→ 注入（既有
  用户显式启用路径逐字保留）。
- **A4**：dev 旗标 + 无凭据 → 不注入（门开也无料可写，R3）。
- **A5**：dev 旗标 + 半组凭据（只有 socket，无 authority，经 sanitize 捕获）→ 不注入
  （R3 半组 fail-closed）。
- **A6**：`isACodeCuaDevActivationRequested` 谓词闭集（DEV_MODE=1 ⇒ true；
  PRODUCT_HELPER=1 ⇒ true；PRODUCT_HELPER=0/off/false/空 ⇒ false；缺省 ⇒ false）。

## 范围外（登记，不在本修复内裁决）

1. **宿主生产门补实**：`isOfficialCuaPluginEnabledForWorkspace` 仍是占位恒 false
   （`acode-cua/broker-server.js:132`，CONTRACT.md 登记的角色 B 待补面）。阶段 5
   产品化（真实 Helper 可在生产启动）之前必须补实并让 `isCuaEnabledForContext` 的
   生产分支真正落到插件 enablement，否则宿主会先于用户开关下发凭据——届时 R2 的
   CLI 侧门是最后一道「默认关闭」防线，不得删除。
2. **设置页乐观投影**：`pluginManagementStoreEnabled.ts` 的 optimistic ON 在
   `isCurrentRequest()` 守卫失效时既不合并服务端确认值也不回滚；且初始化守卫
   （`ComputerUseSection.tsx:141-148`）静默跳过时无任何日志。建议另行立项加
   「未确认 ON」的对账/提示（P2，非本缺陷断点：观测运行的管理面 RPC 从未发生，
   `~/.acode/plugin-workspace` 不存在、全天零条 `[plugins]` renderer 日志）。
3. **观测面「开关显示 ON」**：无法从 ACode 落盘 artifacts 复现（列表投影必然 OFF）；
   同机 ZCode 产品的 `computer-use@zcode-plugins-official: true` 为真实 ON，疑似
   跨产品误归因，留待报告确认。
