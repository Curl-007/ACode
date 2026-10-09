# provider-node

`contract.ts` 是本模块的治理登记契约面，整体转发 `index.ts`（包根
`@acode/provider-node`）的公开符号；两者同时登记为 publicEntrypoints。消费方拿到
的是 Provider 配置域的 Node.js 运行时物化层：ACode Built-in 配置的
源/下载/缓存路径/远程同步（`NodeACodeBuiltinProviderConfigSource`、
`EndpointScopedACodeBuiltinSource`、`ACodeBuiltinRemoteSynchronizer` 等）、
Personal 配置文件仓库与编解码（schemaVersion + 迁移表 + 锁内 CAS + 原子写）、
Config/Registry 运行时组装（`NodeProviderConfigRuntime` /
`NodeProviderRegistryRuntime` 及 create\* 工厂）、模型选择 Facade
（`createNodeModelSelectionFacade`）与运行时路径解析。

owner 是 `provider-node-runtime`。状态所有权：文件 watch、轮询定时器与恢复回调的
唯一所有者是对应 source/repository 实例；`NodeProviderConfigRuntime` 只做装配与
生命周期治理（`#startPromise` 单次启动、`#disposed` 幂等释放），不复制第二份配置
缓存——双层配置合并的唯一漏斗是 provider 模块的 `ProviderConfigService`
（runtime.configService 透出）。BYO API Key 的明文字节唯一落点是注入的
`ProviderApiKeyVault`，配置文件只留 credentialRef。

依赖方向：requires [provider, shared]——配置域模型、Service 与 Facade 类型来自
`@acode/provider`，协议/模型配置投影来自 `@acode/shared`（含 model-config、
model-selection、node 子路径）。本模块有 12 处 node: 内置模块导入（fs/path/os/
crypto 等），因此是单层 `app`，不声明 domain 层。任何模块不得反向依赖本模块内部
文件；desktop 生产构建经 tsup noExternal 内联本包 TS 源码，导入面仍是包根。

已知潜在债（不新增入口掩盖）：apps/acode-cli/tests/protocol-worker-vault-injection
.test.mjs 以相对路径 deep import 本模块 3 个内部文件（acode-builtin-release.ts /
provider-config-file-codec.ts / runtime-paths.ts）。它命中 legacy importer + 测试
文件豁免（RATCHET_EXEMPT_PATTERN），当前不产生违规；登记于此，后续应改为经包根
入口消费。
