/**
 * provider-node 的唯一公开契约（架构治理登记面）。
 *
 * 本文件整体转发包根入口 index.ts 的公开面（index.ts 是 14 个实现文件的
 * `export *` barrel，符号面过大且随实现演进，逐名枚举会产生漂移）；两者同时
 * 登记为 publicEntrypoints，消费方经包根 `@acode/provider-node` 使用。
 *
 * 公开面按职责分组（枚举见 index.ts）：ACode Built-in 配置源/下载/缓存路径/
 * 远程同步、endpoint 作用域源、配置物化器、Personal 配置文件仓库与编解码
 * （schemaVersion + 迁移表 + 锁内 CAS + 原子写）、Config/Registry 运行时组装
 * （NodeProviderConfigRuntime / NodeProviderRegistryRuntime）、模型选择
 * Facade（身份分类 + legacy reasoning level 归一）与运行时路径解析。
 */
export * from "./index.js";
