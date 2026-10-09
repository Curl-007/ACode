# acode-server-cli

`contract.ts` 是本模块的治理登记契约面，整体转发 `index.ts`（包根
`@acode/server-cli`）的公开符号；`index.ts` 与 bin 入口 `main.ts`（包导出
`"./main"`，`acode` 可执行文件的真实入口）三者同时登记为 publicEntrypoints。
消费方拿到的是：CLI 编排入口（`runServerCli`/`readPersistedStatus`/`CliIO`）、
生命周期与发布的 zod 判别结构（`serverStatusSchema`/`controlRequestSchema`/
`releaseManifestSchema`/`releaseCatalogSchema` 等及推导类型，来自内部文件
`contracts.ts` 的整体转发）、Supervisor 崩溃预算（`CrashBudget`）与服务器布局/
release manifest 解析（`resolveCanonicalServerLayout`/`resolveServerLayout`/
`validateUninstallTarget`/`createRuntimeManifest`/`currentServerTarget`/
`supportedServerTargets`）。

owner 是 `server-cli-supervisor`。状态所有权：服务器生命周期事实（状态快照、
generation、崩溃预算窗口）唯一落点是 data-root 下的持久化快照与 `CrashBudget`
（滑动窗口 CRASH_WINDOW_MS + 指数退避 CRASH_BACKOFF_MS，exhausted 后不再拉起）；
安装/release 事实唯一所有者是 runtime 目录（lock、manifest、canonical 路径——
符号链接别名在生命周期命令入口统一收敛，防止第二个 Supervisor 绕过探测重复
注册）；进程监督归 supervisor/，HTTP/WS 承载与任务活动计数归 server-core/；
控制通道帧有 64KiB 上限（MAX_CONTROL_FRAME_BYTES）。CLI 的全部 IO 经 `CliIO`
注入（stdout/stderr/confirm/legacyDelegate），编排层可测试。

依赖方向：requires [rpc, services, shared]——RPC 传输来自 `@acode/rpc`，会话
运行时装配来自 `@acode/services`（含 /node 子路径），协议与 schema 投影来自
`@acode/shared`（含 acode-protocol-v4、/node 子路径）；HTTP 层使用 hono/
@hono/node-server/@hono/node-ws/ws，解包使用 yauzl。本模块 80+ 处 node: 内置
导入（进程、文件、网络、OS 服务），单层 `app`，不声明 domain。任何模块不得反向
依赖本模块内部文件。

命名注意：`src/contracts.ts`（复数，223 行，16 个模块内 importer）是内部 zod
schema 实现文件，保持原名；治理契约面是本文件旁的 `contract.ts`（单数）。
架构检查的 max-contract-lines 只匹配 basename 以 `contract.` 开头的文件，
`contracts.ts` 不在其列（scripts/architecture/index.mjs，纳管前已核对源码）。

行数/抑制例外（ARCH-04 纳管登记）：`cli.ts`（517）、`packaging/stage.ts`（652）、
`supervisor/supervisor.ts`（648）超过 400 行上限且各含 1 条首行 max-lines 抑制，
分别以例外 `onboard-server-cli-over-limit` 与 `onboard-server-cli-disables` 登记，
均 expires 2026-12-31：到期前必须拆分/清理并移除例外，`.architecture-baseline.json`
不参与掩盖。
