# ACode 1.0.4 深度 Review · services 业务服务层

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`。方法：只读源码审查 + 上轮（2026-10-22，基线 `ebe9033b`）修复逐条核验；自基线以来 `packages/services/src` 仅 1 个提交触碰（`725f1244`，限于日志+identity），改动面极小。总入口见 [../../project-review-2026-10-26.md](../../project-review-2026-10-26.md)。

范围：`packages/services/**` —— 会话库、owner/lease、task index、storage、workflow owner、workspace identity、OAuth/凭据服务、日志纪律。

---

## 1. 上轮修复回归核对

| finding | 声称修复 | 核验结论 | 当前证据（file:line） |
|---|---|---|---|
| **R2-03 [P2]** OAuth/凭据日志绕过脱敏漏斗（裸 console.log） | oauthService + zaiProviderAdapter → `createServiceLogger`；oauth 目录裸 console 归零 | **HOLDS** | `oauth/oauthService.ts:43,49`（`serviceLog=createServiceLogger("oauthService")`，`log=(...args)=>serviceLog.info(undefined,...args)`——正确传 `undefined` 进 traceId 槽）；`oauth/providers/zaiProviderAdapter.ts:61,67` |
| services/src 全部裸 console 清除 | 5 处转换，非 logger 裸 console = 0 | **HOLDS（主审亲验 grep = 0）** | 唯一可执行 console 命中是 `logger/logPrivacy.ts:93`——logger 模块内部的 fail-closed 诊断（刻意避开 serviceLogger 防递归），豁免成立。其余命中全为注释文本。无 `process.stdout/stderr.write` 旁路 |
| **identity key [P3, EI-2]** 10+ 份手写 `workspaceIdentity?.trim() \|\| workspacePath` 副本 | 全部 → `resolveWorkspaceKey`；grep 归零；新测试 workspaceKeySemantics | **HOLDS** | services/src 内构造模式多行 grep = **0**（仅注释文本）。`paths.ts:199-200`、`bots/workspaceHelpers.ts:13-15` 已是 `resolveWorkspaceKey` 薄封装；单一实现在 `shared/src/task-realtime-core.ts:76-81`。测试在位（5 例）。`acodeAgentConnectionScope.ts:875` 等 3 处 `?.trim()` 命中是**存在性门/布尔检查**非 key 构造；`runtime-tools/agentProxyEnv.ts:119` 是 env 注入（空时返回 `{}`，无 path fallback）——语义合法不同。**无新副本引入** |
| owner/lease generation fence、task-index writers 白名单、幂等守护 | 上轮：「全部健在且更严」 | **HOLDS** | `acodeAgentConnectionScope.ts:589-598` late-ACK generation fence 完整（`runtimeGenerationByWorkspaceKey`，旧 runtime ACK 永不反向退订新 runtime）；`tests/task-index-writers.test.mjs` 10 文件白名单 + 「vanished file」守护完整 |

## 2. 新发现

### [P2] traceId 槽位误用同时是**脱敏漏斗旁路**，且 7 处位于 OAuth 凭据文件（主审亲验机制）

上轮 review 把 traceId 槽位误用记为「日志前缀污染的调用形态笔误」（cosmetic）。**它不止于此**——机制核验：

```ts
// serviceLogger.ts:48,61
const source = traceId ? `${scope}][trace:${traceId}` : scope;
consoleFn(formatLogPrefix(source, pid), ...args.map(redactServiceLogArg));
```

**前缀（内插 traceId）原样进 sink，不经 `redactServiceLogArg`**（只有 `...args` 被 map）。即：任何写进 traceId 槽的字符串**整体绕过脱敏漏斗**。当调用方写 `serviceLog.info("some message", {ctx})` 时，消息落在 `[trace:...]` 内且未脱敏。

- **7/31 处误用位于 `oauth/oauthService.ts`**（`:234,311,328,723,779,851,1091`）——正是 R2-03 要收进漏斗的凭据面文件。修复加了正确的 `log()` helper（`:49`），但这些直调 `serviceLog.info("字面量", …)` 未动。
- **实际泄漏：当前无**——31 处误用消息全是静态字面量或内插非秘密 ID（如 `task=${offPeakTaskId}`），今天没有 token/code 流经 traceId 槽。**泄漏是潜在的，不是活体的。**
- **结构性漏洞：CONFIRMED**——traceId 槽永不脱敏，漏斗的「单一脱敏点」保证不覆盖它。这在最高敏感度文件里削弱了 R2-03 建立的不变量。
- **规模被低估**：主审复核 grep 计 27 处字面量首参（代理口径 31 含 offPeak 三文件的 `deps.logger` 间接型），上轮估「~25」是低计。分布：`node.ts`(3)、`oauthService.ts`(7)、`providerModelDiscovery.ts`(5)、`officialMcpCredentials.ts`(3)、`settingsSyncService.ts`(1)、`offPeakMockGateway.ts`(5)、`offPeakServerClient.ts`(1)、`offPeakTaskService.ts`(6)。`TraceId = string`（`shared/src/acode-task-types-core.ts:27`）使误用**类型不可见**，编译静默通过。
- 修复曾正确改过一处同模式（`providers/api/nodeApiClient.ts:149`），说明团队知道正确形态——只应用到了一个调用点。
- **修复入口**：① 批量扫描替换 `(undefined, "msg", ctx)` 形态（一次 codemod，31 处）；② 二选一的结构封堵——`write()` 内对 traceId 也过 `redactServiceLogArg`（一行），或把 ServiceLogger 首参类型从 `string` 收紧为 branded `TraceId`（编译期拒绝字面量）。②的 branded type 是根治：让误用不可编译。

### [P3] 非桌面 sink 的对象内容脱敏缺口（已登记的里程碑，非回归）

`redactServiceLogArg`（`logPrivacy.ts:102-118`）对象按引用透传，脱敏依赖终局字符串化漏斗（桌面 main write / host reportHostLog）。非桌面进程（CLI/server）命中裸 sink 时对象字段不脱敏。这是上轮 R2-04 跨文件事项的有意保留（避免破坏 `agent-prewarm-claim` 的结构化身份断言），守护测试 `serviceLogger.redaction.test.ts:87-100` 钉住现契约。正确登记为里程碑：须先解耦 session-start-timing 观测面为结构化 telemetry 出口。

自基线的 diff（`725f1244` 仅日志+identity）中**无新重复状态、无多写入路径、无 owner 歧义、无 fail-closed 缺失**。

## 3. 层面健康度

**良**。1.0.4 两个头号修复（OAuth 漏斗 + identity key 单一实现）经 grep、源码阅读、守护测试三重核验真实成立；无新状态复制或写入路径漂移。不到优的原因是 traceId 槽位误用：31 处仍未修（登记为后续项但已长过上轮「~25」的估计），且机制上不止 cosmetic——traceId 槽不经脱敏直出，在 OAuth 凭据文件里削弱了 R2-03 建立的漏斗保证。建议一次批量清扫 + lint/守护规则防复发（`TraceId=string` 使误用类型不可见，branded type 可根治）。
