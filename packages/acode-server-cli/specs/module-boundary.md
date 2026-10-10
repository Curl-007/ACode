# acode-server-cli module boundary

## Scope

`packages/acode-server-cli` 是远程服务器侧 CLI 与 Supervisor：`acode` 可执行文件
（bin → main.ts）编排 serve/status/stop/restart/update/uninstall 生命周期，
Supervisor 监督 server-core 进程（崩溃预算 + 退避拉起），runtime 目录持有
lock/manifest/release 安装事实，packaging 负责离线部署 staging。本 spec 登记其
纳管为架构模块（managed，ARCH-04 batch 2）：公开契约、状态所有权、依赖方向与
验收场景。纳管批次不改变任何运行时行为与包导出面。

## Ownership and invariants

- owner：`server-cli-supervisor`。
- 生命周期事实的唯一落点是 data-root 持久化状态快照（readPersistedStatus 回读
  必须过 `serverStatusSchema` zod 校验，不信任磁盘旧 JSON）；generation/协议版本
  （SERVER_CLI_PROTOCOL_VERSION）随快照单调演进。
- 崩溃监督唯一所有者是 Supervisor + `CrashBudget`：滑动窗口 CRASH_WINDOW_MS、
  指数退避 CRASH_BACKOFF_MS，预算耗尽（exhausted）后不再拉起，不用无限重启
  掩盖崩溃。
- 安装/release 事实唯一所有者是 runtime 目录（lock、manifest、canonical 路径）；
  同一物理 data-root 的符号链接别名会派生不同 control endpoint 与 OS service
  identity，生命周期命令在 IO 前统一 `resolveCanonicalServerLayout` 收敛，防止
  第二个 Supervisor 绕过探测重复注册（cli.ts 注释即此约束）。
- 控制通道（ipc/）帧上限 MAX_CONTROL_FRAME_BYTES = 64KiB；server-core 鉴权与
  会话语义见 specs/server-core-auth.md。
- CLI 的全部宿主 IO 经 `CliIO` 注入（stdout/stderr/confirm/legacyDelegate），
  编排层可离线测试；bundled agent 接线只作为本次 CLI 的显式依赖传入，不污染
  全局 env（main.ts 注释即此约束）。

## Public boundary

- 公开契约是 `src/contract.ts`（治理登记面，`export *` 整体转发 index.ts）；
  `src/index.ts`（包根 `@acode/server-cli`）与 `src/main.ts`（包导出 `"./main"`，
  bin 真实入口）同时登记为 publicEntrypoints。其余源文件是内部实现，跨模块
  deep import 会被 architecture checker 以 `deep-import` 拒绝。
- **命名边界**：`src/contracts.ts`（复数，223 行，16 个模块内 importer）是内部
  zod schema 实现文件，纳管时保持原名不改名、不移动；治理契约面是新增的
  `src/contract.ts`（单数）。checker 的 max-contract-lines 只匹配 basename 以
  `contract.` 开头的文件，`contracts.ts` 不受 300 行契约上限约束（纳管前已核对
  scripts/architecture/index.mjs）。
- 全仓无源码以包名 import 本模块（bin/exports 消费；纳管前扫描确认零 deep
  import）。
- 行数/抑制例外（限期债，expires 2026-12-31）：
  - `onboard-server-cli-over-limit`（max-file-lines）：cli.ts 517、
    packaging/stage.ts 652、supervisor/supervisor.ts 648；
  - `onboard-server-cli-disables`（disable-count）：同 3 文件（各 1 条首行
    max-lines 抑制）。
    到期前必须拆分/清理并移除例外；`.architecture-baseline.json` 不动。

## Dependency direction

- 允许：`@acode/rpc`（传输）、`@acode/services`（含 /node 子路径，会话运行时
  装配）、`@acode/shared`（含 acode-protocol-v4、/node 子路径投影）、hono/
  @hono/node-server/@hono/node-ws/ws（HTTP/WS 承载）、yauzl（release 解包）、
  zod、node 内置模块（80+ 处 node: 导入：进程、文件、网络、OS 服务）
  ——requires: [rpc, services, shared]，与 module.ts 清单一致。
- 禁止：acode-server-cli 依赖 desktop/web/ui 等客户端模块；任何模块反向依赖
  本模块内部文件。
- 层：单层 `app`（`layers: { app: "." }`）——CLI/Supervisor 的存在意义就是持有
  进程、文件与网络 IO，声明 domain 层会触发 domain-io。

## Acceptance scenarios

1. `node scripts/architecture/architecture-check.mjs check`：acode-server-cli 在
   managed 语义下，除已登记的 `onboard-server-cli-over-limit` 与
   `onboard-server-cli-disables` 两条例外外零违规（forbidCycles、deep-import、
   max-contract-lines、max-public-methods）。
2. `node scripts/architecture/architecture-check.mjs context acode-server-cli`
   展示 owner `server-cli-supervisor`、module.ts 与 contract.ts（contracts.ts
   会作为 `contract.` 前缀文件一并列入阅读包，属预期展示而非契约面）。
3. `pnpm --filter @acode/server-cli test` 全绿；包导出面（"." 与 "./main"）与
   纳管前逐名一致。
4. `tsc -b packages/acode-server-cli`（根 `pnpm typecheck` 名单内）通过；
   `contract.example.ts` 随包工程一起编译（无 IO，仅编译与文档验证）。
