// 2026-12-31 例外债务偿还：原 580 行 provider-config.ts 按职责拆为 4 个叶子（均 <400 行），
// 本文件降级为 barrel 保持导出面逐名不变，首行 oxlint max-lines 抑制头注随拆分删除：
// - provider-access-config.ts    Access 配置族（ApiKey/ZhipuAccount/联合类型/isApiKeyAccess）
// - provider-core-config.ts      Provider 主配置族（ProviderApiConfig/ProviderConfig）
// - provider-template.ts         Provider Template 族（含 resolveProviderTemplateName/ProviderTemplateMap）
// - provider-config-map.ts       Provider 规则索引族（ProviderConfigRule/ProviderConfigMap）
export * from "./provider-access-config.js";
export * from "./provider-core-config.js";
export * from "./provider-template.js";
export * from "./provider-config-map.js";
