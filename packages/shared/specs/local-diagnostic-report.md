# 本地诊断报告（Local Diagnostic Report）

## 背景

桌面 App 出问题时，用户报障全靠口述；已有的 [Desktop exportLogs](../src/main/exportLogs.ts)（main 侧日志整理+脱敏）与 [supportBundle](../src/main/supportBundle.ts)（分节 zip）是重型、桌面专属、面向维护者的通道，且 UI 侧 [帮助菜单](../../ui/src/WorkspaceHelpMenuButton.tsx) 未暴露入口（`helpMenuActions.ts` 已有 `exportLogs` 动作分支但菜单未接线）。手机 Web 侧 [webPlatform](../../web/src/webPlatform.ts) 的 `exportLogs` 直接返回 unsupported，离线时连客户端已知事实都导不出。

本 spec 定义一个**轻量、跨端、用户自助**的本地诊断报告（JSON）：用户在帮助菜单生成、**预览将包含的内容**、自行选择范围、决定是否下载给维护者；手机离线也能导出客户端侧事实。立项依据见 [docs/upgrades/product-and-support-2026-10.md §6](../../../docs/upgrades/product-and-support-2026-10.md)（U12，2026-10-09 调查）；[docs/desktop-evolution-analysis-2026-10-26.md](../../../docs/desktop-evolution-analysis-2026-10-26.md) §2.1 核验其地基已就绪。

本项**不做**：自动上传、新增遥测（[no-telemetry](../../ui/specs/no-telemetry.md) 红线）、默认采集会话正文/tool input-output/完整 headers/凭据/用户身份/机器路径/原始截图；不为导出另起远程 Host 或诊断模型；Web 不声称已读取 Desktop 全部日志。与 Desktop 现有 zip 导出并存，两者范围分别说明。

## 产品规则

1. **白名单优先，非黑名单**：报告只由结构化白名单 DTO 组合而成，字段规则由 shared 严格 schema + 运行时校验共同约束。**禁止透传 arbitrary metadata**（schema `.strict()`，未知字段拒绝）。不得「先塞完整日志再交 UI 清洗」。
2. **各端只报自己拥有的事实**：build/version/OS/arch 的唯一所有者是 Desktop main（`app.getVersion()` 等），Web 无法提供则标 `unavailable`，不猜测、不伪造。连接档位/重连次数的所有者是各端连接层；renderer 内存计数的所有者是 `uiMemoryDiagnosticsRegistry`。UI 只组合预览与范围选择，不新造业务状态副本。
3. **可用性四态，缺失不伪造健康**：每个字段组带一个 availability 标记 —— `collected`（已采集）/ `unavailable`（该端无法提供，如 Web 无 `performance.memory`）/ `not-collected`（用户未选入范围）/ `truncated`（超上限被截断）。未检查的字段**不得**标 `passed`/`healthy`。
4. **生成期不触发副作用**：报告生成不发起网络请求、不触发 provider live probe（U08 未落地时 provider 摘要只含「已有结果」，无则整组 `unavailable`）、不为采集断线重连。断线时只记录「来源不可用」，不重连采集敏感信息。上传次数 0、模型请求 0。
5. **脱敏是承重不变量**：报告内不得出现 Bearer/API key/cookie、query token、URL userinfo、原始 workspacePath、用户名/主机名、内部 endpoint、会话正文。结构化字段优先白名单（不靠单个正则兜底）；纳入报告的本机日志片段（如 Desktop 侧）必须过 [logPrivacy](../../services/src/logger/logPrivacy.ts) 同源脱敏。
6. **大小与条目有界**：轻量 JSON ≤ 1 MiB；事件摘要默认最近 15 分钟、最多 200 条，超限显式 `truncated`（不静默丢弃）。
7. **下载经平台接口，临时资源必释放**：下载通过 `IPlatformService`（新增的下载能力标为**拟议接口** `saveDiagnosticReport`，Desktop/Web 各自实现，UI 不直接访问 native bridge）。预览关闭/下载完成后 object URL 释放率 100%。下载失败可重试且不重复后台采集；平台确实无法下载时显示受限，不声称成功。

## 状态所有者与不变量

- **报告 schema（`LocalDiagnosticReport`）** — 所有者 `packages/shared/src/localDiagnosticReport.ts`（新中立叶子，经 `index.ts` 公开导出，**不进** legacy barrel 冻结面）；不变量：`.strict()`、`schemaVersion` 字面量、每组带 availability、运行时 `parse` 拒绝未知字段。
- **build/env 事实 DTO** — 所有者 Desktop main（新增受控采集，读 `app.getVersion()`/`process.platform`/`process.arch`/locale）；Web 侧所有者 `webPlatform`，返回其可得子集（locale、平台能力、连接事实），版本标 `unavailable`。不变量：只出白名单字段，无用户名/主机名/原始路径。
- **连接档位/重连事实** — 所有者各端连接层（Desktop `taskRealtimeBus`/handshake、Web `reconnect` 控制器）；不变量：只出 deliveryMode、phase、公开稳定错误码、重连计数，不出 URL/token/正文。
- **renderer 内存计数** — 所有者 `packages/ui/src/lib/memoryDiagnostics.ts` 的 `uiMemoryDiagnosticsRegistry`（已有）；不变量：只出有界计数（rows/index/cache/字节），不出原始堆快照。
- **provider 摘要** — 所有者既有 provider 诊断结果（U08 落地前为「已有 tier/checkpoint 状态」）；不变量：仅用户选入范围的，出状态与码，**绝不出** API key/凭据引用/key hash，不后台启动新 probe。
- **报告组合与预览/范围选择** — 所有者 `packages/ui`（组合器 + 预览组件 + 帮助菜单入口）；不变量：不新增业务状态副本，只做 DTO 组合 + 展示 + 下载触发。

## 接口契约

### shared schema（`localDiagnosticReport.ts`）

```
LocalDiagnosticReport = {
  schemaVersion: 1（字面量）
  platformType: "desktop"|"web"（顶层必填——Web 的 build 组可能整体缺席，但端类型永远可知）
  generatedAt: ISO 字符串
  fieldAvailability: { build, connection, performance, provider, events } → 四态枚举
  build?: { appVersion?, commit?, os?, arch?, locale, capabilities: string[] }
  connection?: { deliveryMode?, phase?, errorCodes: string[], reconnectCount: number }
  performance?: { counts: Record<string, number>, memoryAvailable: boolean }
  provider?: { entries: Array<{ id, tier?, checkpoint?, status?, code? }> }  // 仅用户选入
  events?: Array<{ at: ISO, code: string, count?: number }>  // ≤200，超限 fieldAvailability.events=truncated
}
```

> **build 组字段可选性的设计依据**（2026-10-26 核验订正）：字段的所有者分两类——
> `appVersion`/`commit` 来自 `packages/shared/src/version.ts` 的 **bundler 注入常量**
> （`__ACODE_VERSION__`/`__ACODE_COMMIT__`），desktop 与 web 两个 vite 配置都注入
> （`packages/desktop/vite.config.ts:194`、`packages/web/vite.config.ts:101`），故**两端都能诚实上报**
> 自己 bundle 的构建版本，且这不是设备指纹。`os`/`arch` 来自 Node 的 `process.platform`/`process.arch`，
> **仅 Desktop main 拥有**；Web 读 `navigator.userAgentData` 会新开设备指纹面，违反产品规则 2
> 「只报自己拥有的事实、不猜测」，故省略。`locale`/`capabilities` 两端各有权威源，照常上报。
> 未构建环境下常量回退为 `"0.0.0-dev"`/`"unknown"`（version.ts:8-12），这类回退值**不是事实**，
> 采集侧必须识别并省略，不得当作真实版本上报。`platformType` 因此在顶层必填。

`.strict()`；所有敏感字段**不在 schema 内**（结构性排除，而非采集后过滤）。导出 `LOCAL_DIAGNOSTIC_REPORT_SCHEMA`、类型、`parseLocalDiagnosticReport()`（运行时校验，失败抛稳定错误码）、`LOCAL_DIAGNOSTIC_MAX_BYTES = 1 MiB`、`LOCAL_DIAGNOSTIC_MAX_EVENTS = 200`。

### 平台接口（`IPlatformService`，拟议新增）

- `collectLocalDiagnostics(): Promise<LocalDiagnosticFacts>` —— 各端返回自己拥有的白名单事实（`platformType` + build/connection 组）。build 组可用性判定规则：**该端能提供自己实际拥有的字段即为 `collected`，未拥有的字段直接省略（不是填空串、不是猜值）**；Web 提供 `locale`/`capabilities`/`platformType`、省略 `os`/`arch`/`appVersion`/`commit`，仍算 `collected`。只有当该端对整组一无所知时才标 `unavailable` 并省略该组。返回**事实 DTO**（schema 字段组的子集），非完整报告（报告由 UI 组合）。
- `saveDiagnosticReport?(json: string, suggestedName: string): Promise<{ saved: boolean; path?: string; cancelled?: boolean; error?: string }>` —— 可选；Desktop 走 save dialog + 写文件，Web 走 Blob + object URL 下载（并在返回前 `revokeObjectURL`）。缺席即 UI 降级为「复制 JSON 到剪贴板」并说明。

> 这两个是**拟议接口**，最终命名/形状由实现 PR 确认；不得让 UI 直接访问 native bridge。

## 事件顺序

```
用户点帮助菜单「生成诊断报告」
  → UI 调 platform.collectLocalDiagnostics()（各端并行取自身白名单事实；无网络、无 probe）
  → UI 合并 memoryDiagnostics 计数 + provider 已有结果（若用户选入）
  → 组装 LocalDiagnosticReport，parseLocalDiagnosticReport 自校验（失败=bug，fail-loud）
  → 渲染预览（分字段组显示 collected/unavailable/not-collected/truncated + 实际内容）
  → 用户勾选范围（默认最小集：build+connection+performance；provider/events 默认不选）
  → 用户点下载 → platform.saveDiagnosticReport(json, name)
      · Desktop：save dialog → 写文件 → toast 路径
      · Web：Blob → object URL → <a download> → revokeObjectURL（释放）
      · 接口缺席：降级「复制 JSON」+ 说明当前平台不支持直接下载
  → 关闭预览：释放所有临时 URL；不残留后台采集
```

## 验收场景

| 编号 | 前提 | 操作 | 必须断言 |
|---|---|---|---|
| U12-A1 | 手机 Web 离线，已有客户端计数 | 预览并下载报告 | 生成客户端 JSON，**外联计数 0**；build.version 等远端字段 `unavailable`；不触发 Agent/Host/provider probe |
| U12-A2 | Desktop 正常连接 | 导出轻量 JSON 及原有 zip | 两种范围说明清楚；原 zip 入口保持可用；JSON 过 schema 校验；不含会话正文 |
| U12-A3 | 合成敏感 fixture（含 Bearer/API key/cookie/query token/URL userinfo/Windows+POSIX 路径） | 生成 JSON | 精确 forbidden-value 断言：上述敏感值在报告内**零出现**；覆盖 escaped 字符串、跨 chunk 分割、大小写差异、多行值 |
| U12-A4 | 指标缺失 / 权限拒绝 / 数量超限（>200 events） | 生成报告 | `unavailable`/`not-collected`/`truncated` 分别准确；缺失字段不被标 passed/healthy；events 超限时 `fieldAvailability.events === "truncated"` 且条目 = 200 |
| U12-A5 | 下载失败 / 生成后连接改变 / 关闭预览 | 重试或关闭 | 无重复后台采集；旧结果不混入新范围；object URL 释放率 100%；错误可恢复、可重试 |
| U12-A6 | schema 负向 | 注入未知字段 / 缺 schemaVersion / 敏感字段名 | `parseLocalDiagnosticReport` 拒绝（`.strict()`）；报告大小 >1 MiB 时拒绝或截断并标记 |

## 量化门槛（上线前）

- 轻量 JSON ≤ 1 MiB；events ≤ 200 条、默认窗口最近 15 分钟。
- 固定 fixture 客户端生成 p95 ≤ 500 ms（30 次样本）；Desktop zip 磁盘 IO 单列，不与 JSON 混计。
- 导出流程上传次数 0、模型请求 0；手机离线能生成可用文件。
- 敏感合成值泄露 0；object URL 释放率 100%；字段来源与可用性覆盖率 100%（无 undefined 被误当通过）。
- 上线前只用合成数据审查样例，不收集真实用户数据验证脱敏。

## 回退

隐藏新 JSON 入口，保留 Desktop 原有 zip 导出与说明；不删除用户已下载文件，不改变服务事实。任何凭据/正文泄露、默认上传、缺失字段伪造通过均阻止发布。
