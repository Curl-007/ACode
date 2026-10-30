# Desktop 端本地诊断报告（U12）

契约真源：[`packages/shared/specs/local-diagnostic-report.md`](../../shared/specs/local-diagnostic-report.md)（产品规则、字段组、可用性四态、验收场景 U12-A1..A6、量化门槛、回退）。本 spec 只钉 **Desktop 端本地**的所有权、IPC 边界与不变量，不重复契约。

## 范围

- `packages/desktop/src/main/localDiagnostics.ts` —— main 侧事实采集 + 报告保存。
- `packages/desktop/src/main/desktopMainIpcPlatform.ts` —— 两个 IPC 处理器注册（`CollectLocalDiagnostics` / `SaveDiagnosticReport`）。
- `packages/desktop/src/preload/index.ts` —— preload 桥暴露。
- `packages/desktop/src/renderer/src/desktopPlatform.ts` —— renderer 平台方法接线（含旧 preload 缺席降级）。

## 为什么 build/env 事实的所有者是 main

`os`/`arch` 来自 Node 运行时（`process.platform`/`process.arch`），renderer 与 Web 都无法可靠得知；`appVersion`/`commit` 来自 `packages/shared/src/version.ts` 的 bundler 注入常量（`ACODE_VERSION`/`ACODE_COMMIT`），与 `about.ts` 同源。故采集在 main，renderer 经 IPC 取回——**不在 renderer 猜测或第二处解析版本**。

## Desktop 端不变量

1. **不复用 AboutSnapshot**（脱敏承重）：`about.ts` 的 `AboutSnapshot` 含 `hostname`，而 hostname 是契约明令排除的字段（产品规则 5）。本模块**独立**取 `ACODE_VERSION`/`process.platform`/`process.arch`/`currentApplicationLocale()`，不引入 hostname/用户名/原始路径。
2. **非事实版本值不上报**：未构建环境下 `ACODE_VERSION` 回退为 `"0.0.0-dev"`、`ACODE_COMMIT` 回退为 `"unknown"`（version.ts:8-12）。这类回退值**不是事实**，`realBuildValue` 识别后省略字段，避免报告声称假版本。
3. **connection 组标 unavailable**：Desktop 的交付档位/重连事实属于 renderer 与 Host 的连接层，main 不持有其状态。按「只报自己拥有的事实、不新建状态副本」（AGENTS.md），main 侧不猜测该组——UI 可从 renderer 连接层补充。
4. **零副作用**（契约产品规则 4）：采集只读进程内既有事实，不 fetch、不 spawn、不触发 provider probe、不为采集重连。
5. **main 是保存的哑 sink**：不 re-parse、不改写 UI 产出的 JSON 字节（UI 已保证 schema 合法且脱敏）；只做大小上限校验（`Buffer.byteLength` 按字节而非字符数，中文报告字符数会低估）与落盘。
6. **错误不回传原始消息**（同 R2-04 纪律）：保存失败对外只给稳定码（`diagnostic-report-too-large` / `diagnostic-report-write-failed` / `diagnostic-report-invalid-input`），原始异常只进 main 日志——避免把用户目录路径回传 renderer。
7. **取消不是错误**：用户在保存框点取消 → `{saved:false, cancelled:true}`，UI 静默处理。
8. **异步 IO**：写文件用 `node:fs/promises` 的 `writeFile`（AGENTS.md）。

## IPC 通道

两个通道登记在 `packages/shared/src/channels.ts` 的 `PlatformChannels` 与 `PlatformChannelMap`：

- `CollectLocalDiagnostics`（`acode:collect-local-diagnostics`）：`request: void` → `response: LocalDiagnosticFacts`。
- `SaveDiagnosticReport`（`acode:save-diagnostic-report`）：`request: { json, suggestedName }` → `response: SaveDiagnosticReportResult`。

两者经 `wrapIpcHandle` + `deriveIpcSyncLabel` 注册（与 `ExportSupportBundle` 同范式），复用既有 IPC 时序观测。渲染层 `desktopPlatform.ts` 对旧 preload 缺席做降级：`collectLocalDiagnostics` 缺席 → 返回 build/connection 双 `unavailable` 的事实（诚实报告「本渲染进程拿不到构建事实」，不猜测）；`saveDiagnosticReport` 缺席 → `undefined`，UI 降级为剪贴板复制。

## 验收场景（映射契约编号）

| 编号 | Desktop 端断言 | 测试 |
|---|---|---|
| U12-A2 | 采集产出过 `localDiagnosticFactsSchema` 校验；不含会话正文/hostname/用户名/原始路径 | `tests/local-diagnostics.test.mjs` |
| U12-A3 | 含合成敏感值的环境下，序列化 facts 内敏感子串零出现 | 同上 |
| U12-A4 | 非事实版本回退值被省略；connection 组 unavailable 且缺席 | 同上 |
| U12-A5 | 保存取消 → `cancelled:true` 且不写文件；写失败 → 稳定码不回传原始消息；超 1 MiB → `diagnostic-report-too-large` 且不写 | 同上 |

## 未验证项（如实登记）

真实 Electron 的 `dialog.showSaveDialog` 与写盘行为无法在本仓单测验证（测试用注入的假 dialog/fs）；该路径由 `e2e:smoke` 之外的手动验证覆盖，或由 UI 层的下载降级路径兜底（保存失败即剪贴板）。
