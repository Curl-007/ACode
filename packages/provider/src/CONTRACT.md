# provider

`contract.ts` 是本模块的治理登记契约面，整体转发 `index.ts`（包根
`@acode/provider`）的公开符号；两者同时登记为 publicEntrypoints。消费方拿到的是
模型 Provider 配置域：双层配置合并漏斗（`ProviderConfigService` +
config-overlay 的 `ProviderConfigLayerSnapshot`/`ProviderConfigLayerUpdate`）、
Registry 视图与选择校验（`ProviderRegistry`/`validateModelSelectionOptions`）、
账号 Provider 状态与解析（account-provider-_）、模型选择配置
（model-selection-config/effective-model-selection）、BYO API Key 凭据接口
（`ProviderApiKeyVault`）、设置/选择投影视图（facades 的
`ProviderSettingsView`/`ModelSelectionView` 等）与配置数据 schema（config/_）。

owner 是 `provider-config`。状态所有权：Provider 事实（revision、providers 列表、
id 索引、变更监听器）的唯一所有者是 `ProviderRegistry` 实例——视图冻结、replace
整体换页并单调递增 revision；`ProviderConfigService` 是 ACode Built-in 与
Personal 双层配置合并的唯一漏斗，层快照由各 `ProviderSource` 提供、本模块不持有
文件/网络句柄（Node 物化在 provider-node 运行时注入）；API Key 明文只经
`ProviderApiKeyVault` 接口进出，selection 视图序列化点负责 api-key 剥离
（specs/model-selection-view-apikey-stripping.md）。

依赖方向：requires [shared]——Provider/Model/ModelSelection 等域类型与配置
schema 投影唯一来自 `@acode/shared`（model-config、model-selection、
config-schema、account-provider-state 子路径）。本模块无 node: 导入、无 IO，
是可独立测试的域+应用层；任何模块不得反向依赖本模块内部文件。

行数/抑制例外（ARCH-04 纳管登记）：`config-service.ts`（757）、`facades.ts`
（688）、`config/model-config.ts`（581）、`config/provider-config.ts`（580）超过
400 行上限，以例外 `onboard-provider-over-limit` 登记；上述 4 文件加
`resolver.ts` 各含 1 条 lint disable，以例外 `onboard-provider-disables` 登记。
两条例外均 expires 2026-12-31，到期前必须拆分/清理并移除例外，
`.architecture-baseline.json` 不参与掩盖。
