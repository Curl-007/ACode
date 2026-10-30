# Web 端本地诊断报告（U12）

契约真源：[`packages/shared/specs/local-diagnostic-report.md`](../../shared/specs/local-diagnostic-report.md)（产品规则、字段组、可用性四态、验收场景 U12-A1..A6、量化门槛、回退）。本 spec 只钉 **Web 端本地**的所有权与不变量，不重复契约。

## 范围

`packages/web/src/diagnostics/webDiagnostics.ts`（采集 + 下载）、`packages/web/src/webPlatform.ts`（两个平台方法接线）、`packages/web/src/main.tsx`（连接事实源注入）。

## Web 拥有的事实 vs 省略的事实

| 字段 | Web 处理 | 依据 |
|---|---|---|
| `platformType` | 恒 `"web"`（顶层必填） | 端类型永远可知 |
| `build.locale` | 采集，权威源 `document.documentElement.lang` | 与 `webPlatform.ts` `openCommunity` 同源，不新开第二真源 |
| `build.capabilities` | 采集，`["saveDiagnosticReport"]` | 只列真实可用通道；`exportLogs`/`exportSupportBundle` 在 Web 仍 unsupported，故不列 |
| `build.os` / `arch` / `appVersion` / `commit` | **省略** | 所有者是 Desktop main。Web 读 `navigator.userAgentData` 会新开设备指纹面，违反契约产品规则 2「只报自己拥有的事实、不猜测」 |
| `buildAvailability` | `collected`（提供了 locale/capabilities 自有字段） | 契约 §接口契约的判定规则：提供自有字段即 collected，省略不可知字段不算伪造 |
| `connection.deliveryMode` | 常量 `"web-remote-replayable"` | 真源 `packages/server/src/http.ts:539`（`/ws` 的 `setupChannelServer(..., "web-remote-replayable")`）。Web 入口只可能是这一档；**不做探测**——探测要问 server，违反零副作用不变量 |
| `connection.phase` | 采集，映射为公开稳定词 | `reconnected`/`null`→`connected`、`waiting`/`connecting`→`reconnecting`、`exhausted`→`disconnected`、`idle`→`idle` |
| `connection.reconnectCount` | 采集，取重连控制器 `attempt` | 控制器是重连次数的唯一所有者 |
| `connection.errorCodes` | **恒空数组** | 重连层只有原始 `Error`，无公开稳定码。契约禁止透传原始 `err.message`/URL/token，故宁缺毋滥 |
| `connectionAvailability` | 有连接源→`collected`；缺席→`unavailable` 且省略该组 | 渲染 bootstrap 错误屏路径无控制器，不猜测 |

## 不变量

1. **零副作用**（契约产品规则 4 / 验收 U12-A1）：`collectWebDiagnosticFacts` 只读当前内存状态——不 `fetch`、不开 socket、不触发 provider probe、不为采集而重连。手机离线必须能产出报告。测试以注入的计数 fake 断言外联次数为 0。
2. **不新建连接状态副本**（AGENTS.md）：连接事实经 `createWebConnectionFactsSource` 的 **getter 惰性读** `main.tsx` 已有的 `controller`/`lastState`，本模块不持有副本、不订阅、不缓存。
3. **object URL 释放率 100%**（契约验收 U12-A5）：`saveWebDiagnosticReport` 用 `try/finally` 保证成功与失败路径都 `revokeObjectURL`。
4. **不谎报成功**：浏览器可能拦截程序化下载；无法确认下载完成时返回 `{saved:false, error:"download-unsupported"}`（导出为 `WEB_DOWNLOAD_UNSUPPORTED` 常量），由 UI 降级为剪贴板复制。绝不返回 `saved:true` 当作已验证。
5. **字节不改动**：下载路径把 UI 产出的 JSON 原样写入 Blob（UI 已保证 schema 合法且脱敏，Web 是哑 sink），不 re-parse、不改写。

## 验收场景（映射契约编号）

| 编号 | Web 端断言 |
|---|---|
| U12-A1 | 离线/降级态下 `collectWebDiagnosticFacts` 产出过 `localDiagnosticFactsSchema` 校验；注入 fake 断言外联调用 0 次、未触发重连；`build.os`/`arch`/`appVersion` 缺席 |
| U12-A3 | 连接态含合成敏感值（带 userinfo 的 URL、Bearer 形态 token）时，序列化后的 facts 内这些子串零出现 |
| U12-A4 | 无连接源时 `connectionAvailability === "unavailable"` 且 `connection` 缺席（非空对象） |
| U12-A5 | 下载成功与失败路径各 `revokeObjectURL` 恰好 1 次；Blob 内容与入参逐字节相同；失败返回稳定码 |

## 边界与未验证项

真实移动浏览器的程序化下载行为（是否被拦截、是否弹保存框）**无法在本仓测试环境验证**（无 jsdom、无真机浏览器）；实现按「不可确认即不谎报成功」处理，真机行为须在发布前人工验证并记录。
