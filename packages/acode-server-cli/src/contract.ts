/**
 * acode-server-cli 的唯一公开契约（架构治理登记面）。
 *
 * 本文件整体转发包根入口 index.ts 的公开面：CLI 编排入口（runServerCli /
 * readPersistedStatus / CliIO）、生命周期与发布的 zod 判别结构（contracts.ts
 * 的 schema 与类型整体转发）、Supervisor 崩溃预算（CrashBudget）以及服务器
 * 布局/release manifest 的解析函数。三者同时登记为 publicEntrypoints 的还有
 * bin 入口 main.ts（包导出 "./main"，顶层装配后调用 runServerCli，不被本
 * 契约转发）。
 *
 * 命名注意：`src/contracts.ts`（复数，223 行）是内部 zod schema 实现文件，
 * 16 个模块内文件 import 它；它不是治理契约面，纳管时保持原名不改动。
 * 本文件（contract.ts，单数）才是架构检查识别的契约（basename `contract.` 前缀）。
 */
export * from "./index.js";
