# CUA 启用单一权威（设置页开关）spec

> 2026-10-31 用户裁决：「电脑操控做成前端功能可以开关」。本 spec 定义启用语义的
> 单一事实源与覆盖旗标边界；背景缺陷证据见
> `docs/reviews/2026-10-30/cua-dev-chain-enablement.md` §2 与
> `apps/acode-cli/specs/cua-broker-credential-relay.md`。

## R1 单一权威：设置页开关的落盘记录

生产形态下「电脑操控是否启用」的**唯一**事实源 = 插件启用记录
`plugins.enabledPlugins["computer-use@acode-plugins-official"]`
（user 配置 `~/.acode/cli/config.json` 与 workspace 候选 `acode.json` /
`.acode/config.json`（根→cwd 发现序）并入；键形态与
`manifest-tier.ts:79-81 resolveEnabled` 一致（`enabledPlugins[id] ?? defaultEnabled`），
合并优先级与 CLI `createConfig`/`mergeConfigs` 实物一致：ConfigScopePriority
Project(20) > User(10)，同一 id 冲突时 **workspace 覆盖 user**）。
（2026-10-31 实物核定修正：原文「user 配置优先」与 mergeConfigs 的
enabledPlugins 按 id 后写者胜语义不符，以实物为准。）

- **host 侧**：`isOfficialCuaPluginEnabledForWorkspace`（`packages/acode-cua/broker-server.js`
  占位恒 false）补实为真读盘（上述两路径同键同优先级）；`isCuaEnabledForContext`
  （`packages/services/src/node.ts`）的启用支改为该真读盘结果。
- **CLI 侧**：既有 `pluginOutcome.plugins[].enabled`（同一磁盘记录）→
  `pluginRuntimeFeatures.computerUse` → 中继门，不改。
- 两个权威读**同一份记录**后，「开关 ON 但 CLI enabled=false」类分裂不可能再出现。

## R2 dev 覆盖旗标（独立于开关）

`ACODE_CUA_DEV_MODE` / `ACODE_CUA_PRODUCT_HELPER` 显式真值 = dev 链覆盖
（`isACodeCuaDevActivationRequested`，缺省 false）：host admission 与 CLI 中继门
（`cuaDevCredentialRelay`）两处生效，不依赖开关记录——dev 一键链回归不变。

**打包态硬化**：两键加入 desktop 启动 sanitize 的 drop 闭集
（`startupSanitation.ts PACKAGED_BOOT_ENV_DROP_KEYS`，仅 packaged 生效）——闭合
`runtimeEnv.ts:28-29` 注释的虚假声明（注释声称边界删除但无实物）；dev 构建不受影响。

## R3 infra 语义分离

`isACodeCuaInternalFeatureEnabled`（缺省 ON）**退出启用判定**，只保留「CUA 基础设施
随正式版打包」语义：`shouldEnableDefaultCuaProductHelper` 的平台/infra 判定、
bundled-plugins 抑制面、restore 写门。启用与否一律归 R1/R2。

## R4 UI 可观测性

开关写路径的静默早退点必须留痕（`ComputerUseSection.tsx` 的 service 缺守卫、
初始化守卫；pluginManagement store 成功路径补 debug）——「显示 ON + 磁盘无记录 +
零日志」的不可观测形态不得复现。失败路径既有 error 日志保留。

## R5 开关 OFF 语义

Helper 不创建、凭据不下发、中继门闭、composer 入口隐藏（既有硬门
`cuaComposerEntryState` 读开关态，不改）。**既有 agent 不回收**（admission 只收敛
后续 spawn，与现有 helper 生命周期纪律一致）；OFF 后新 spawn 立即 fail-closed。

## 验收场景

1. 无 dev 旗标：设置页开关 ON → 落盘记录出现 → 新会话 CUA 可用（node_repl 桥接通）。
2. 无 dev 旗标：开关 OFF → 新会话 fail-closed（bridge assertAvailable 抛 unavailable）。
3. 仅 dev 旗标（开关 OFF/无记录）：dev 链可用（本分支既有 E2E 回归）。
4. packaged 态导出 dev 旗标：sanitize 删除之，覆盖不生效（单测钉 drop 闭集）。
5. workspace 与 user 配置并存时合并优先级与 `createConfig`/`mergeConfigs` 实物一致
   （Project(20) > User(10)：同一 id 冲突时 workspace 覆盖 user；仅单层有记录时该层生效；
   workspace 多文件按根→cwd 发现序、每级 `acode.json` 先于 `.acode/config.json`，后写者胜）。
6. 开关写失败：UI 回滚乐观态 + error 日志（既有语义回归钉住）。

## R6 设置页分区放开（2026-10-31 用户裁决）

`HIDDEN_SETTINGS_SECTIONS` 移除 `"computerUse"`（自初始提交起隐藏，无单独决策记录）：
设置页 Computer Use 分区恢复可见，**分区可见性**归平台可用性推导
（`computerUseAvailability.ts`：本地 Windows/macOS 完整卡、remote/web/linux 提示卡），
**启用语义**归 R1 开关落盘记录。分区内含主开关（插件启用）与 composer 入口子开关
（`computerUseComposerEntryHidden`，既有键语义不变）。

## 不在本项范围

- 阶段 5 生产 staging/签名（CUA 在打包态仍 fail-closed 于产物缺席）。
- 设置页乐观投影的静默合并路径（`pluginManagementStoreEnabled.ts:79-108`，P2 另立）。
- macOS Helper installer 链（本 spec 只定义启用语义，平台链不变）。
