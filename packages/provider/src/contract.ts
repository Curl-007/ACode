/**
 * provider 的唯一公开契约（架构治理登记面）。
 *
 * 本文件整体转发包根入口 index.ts 的公开面（index.ts 是 15 个实现文件的
 * `export *` barrel，符号面过大且随实现演进，逐名枚举会产生漂移）；两者同时
 * 登记为 publicEntrypoints，消费方经包根 `@acode/provider` 使用。
 *
 * 公开面按职责分组（枚举见 index.ts）：双层配置合并漏斗（ProviderConfigService
 * + config-overlay）、Registry 视图与校验（ProviderRegistry /
 * validateModelSelectionOptions）、账号 Provider 状态与解析、模型选择配置、
 * BYO API Key 凭据接口（ProviderApiKeyVault）、设置/选择投影视图（facades）
 * 与配置数据 schema（config/*）。
 */
export * from "./index.js";
