# 2026-10-22 项目审查修复与验证

本页对应 [完整审查](../../project-review-2026-10-22.md) 及其 [11 份专项](./)。修复按 spec → 行为测试 → 实现 → 门禁推进，14 个修复代理并发执行，主审统一验证与提交。

> 状态：**修复进行中**。下表为 finding → 代理分配与各代理自报处置；主审在所有代理回收后统一实跑门禁、核对跨文件事项、提交，并把最终验证结果写入文末「主审统一验证」节。各代理自报的退出码未经主审复跑的，以主审复跑为准。

环境：Windows 11 / Node v25.9.0（`mise.toml` 固定 24.14.0）/ pnpm 10.33.2。分支 `dev/1.0.3`，基线 `ebe9033b`。

## Finding → 代理分配表

| 代理 | 范围（文件所有权） | 负责 finding |
|---|---|---|
| A | `apps/acode-cli/packages/adapters/**` | R2-01（Windows OAuth 命令注入 P2）、cmd.exe 同类副本扫描、adapters 测试补 |
| B | `packages/services/**`（除 rpc-descriptor-surface.test.mjs、session-module-boundary.md） | R2-03（OAuth 日志脱敏 P2）、console.* 残留、identity key 重复实现、serviceLogger 对象脱敏守护、nodeApiClient traceId |
| C | `packages/server/**`、`packages/web/**` | R2-04（connect-remote 错误泄漏 P2）、R2-05（Web WS 重连 P2）、decodeURIComponent、TTL、getActiveProvider、注释、server zod 声明、server 测试 |
| D | `packages/shared/**` | R2-02（legacy 冻结面违规新增 P2）、legacy enum 值域、DPAPI PowerShell 插值、resolveWorkspaceKey 公开导出 |
| E | `packages/ui/src/{store,lib,hooks}/**`、useTheme.ts、index.ts、SettingsPage.tsx、5 个 Workspace*.tsx | R2-06（task meta 四副本收口 P2）、R2-07（useTheme 死代码 P2）、SettingsPage console |
| F | `packages/ui/src/settings/**`、components/ui/button.tsx、ConversationComposer/WorkspaceSidebarFooter 等 | R2-08（设计系统绕过+焦点环 P2）、硬编码字号、裸 button |
| G | `packages/desktop/**` | relay_bridge 死枚举、replay mirror spec+测试、主窗 sandbox、去重 LRU、renderer 注释 |
| H | `packages/{acode-cua,formal-proof}/**`、knip.jsonc、node-repl-host/package.json、cua 新测试 | R2-09（acode-cua fail-closed 表述 P2）、R2-10（formal-proof 零测试 P2）、node-repl-host 声明、knip hints |
| I | `apps/acode-cli/packages/core/**`、bootstrap/src/app/create-app.ts（仅 sink 装配）、cli specs | R1-01（原型注入绕过 owner P1）、CLI-04 sink 残余、resume concurrentSafe、subagent/runner.ts 拆分、core zod |
| J | `.github/workflows/**`、rpc-descriptor-surface.test.mjs、model-option-map/provider-node/acode-server-cli、cli tests（flake/新 speed 测）、ci specs | R1-03（CI win32 矩阵 P1）、R1-04（smoke 进 CI P1）、descriptor 阈值、speed 测试、provider-node/server-cli 覆盖、model-option-map 测试+缓存有界、临时目录泄漏 |
| K | `packages/ui/src/v4/SessionPane.tsx`+session-pane/、ui/test/**、god-component-split-plan.md | R1-02（巨型组件/SessionPane 拆分 P1）、settings 上帝组件登记、12 个源码匹配测试升级 |
| L | `scripts/architecture/**`、architecture-policy.yaml、architecture specs、session-module-boundary.md | resolver 通配入口、asset 豁免、exports map 核实、session publicEntrypoints 白名单机制、legacy 覆盖率路线图 |
| M | `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/**`、相关 specs | product-projection.ts（6075 行）按事件域拆分、v4-gateway.ts（次优先） |
| N | `apps/acode-cli/tests/**`（新文件）、cli 测试覆盖 spec | 高风险盲区补测：abort 并发中止、hydrate 水合恢复、identity 路由、双链路对照、snapshot gap repair |

## 各代理处置（自报，待主审复跑核对）

（代理回收后逐项填充：改动清单、finding 处置、实跑退出码、跨文件事项、spec 更新。）

### 代理 A · adapters 命令注入

**已回收。** R2-01（P2）**已修**：
- `adapters/src/auth/browser.ts:59` win32 分支 `cmd.exe /c start "" <url>` → `explorer.exe [url]`（非 shell，argv 经 CreateProcess，无元字符解释层），中文根因注释引用 H1 同模式。
- `adapters/src/auth/cli-oauth.ts:200` parseInitData 校验层新增「authorize_url 含裸双引号即 fail-closed 拒绝」纵深防御（合法 https URL 的双引号应已 percent-encode 为 %22，不误伤）。
- 新建 `adapters/tests/browser-open-command-injection.test.ts`（1 不变量 + 2 行为测试：恶意 URL win32 argv 断言、非 win32 分支不受影响）。
- 新建 spec `adapters/specs/auth-browser-opener.md`（该包原无 specs/，按规则补建）：opener 必须走非 shell、fail-closed 校验规则、双防线所有者、验收场景。

全仓 `cmd.exe` 同类副本扫描：browser.ts 是**唯一真漏洞副本**，其余命中（execution-command.ts shim 路由、ComSpec 解析、env 加固、shared/mcp.ts `cmd /c npx` 包裹）均非「shell 解释远程字符串」模式，保留原样，逐个判定已记录。

自报实跑：`pnpm --filter @acode/adapters test` EXIT=0（5/5 pass，含新增 3 条）；`--filter typecheck` EXIT=0；`npx oxlint src/auth` 0/0。adapters 其余 auth 路径覆盖仍薄（P3 部分修，超本 finding 范围）。

跨文件事项：无源码改动需求；提示「percent-encode 后不含任何 shell 元字符」的通用断言宜在 core/bootstrap URL 规范化工具收敛（本次未动，登记备查）。

### 代理 B · services 日志与 identity

**已回收。** R2-03（P2）+ console 残留 + identity key（P3）+ traceId 笔误 **已修**；对象脱敏（P3）部分修（守护测试，行为改动经评估不采纳）：
- **R2-03 OAuth 脱敏绕过**：`oauth/oauthService.ts:43`、`oauth/providers/zaiProviderAdapter.ts:61` 裸 `console.log(formatLogPrefix(...))` helper 改走 `createServiceLogger` 脱敏漏斗；补测试断言 Bearer/access_token/redirect code 经漏斗脱敏。**oauth 目录裸 console 归零**（主审核验：剩余命中全是「修复原因」注释文本）。
- **console.* 残留**：5 处（acodeAgentService:5051、mcpSyncService:515、settingService:38、node.ts:1406、nodeApiClient traceId）全转 `createServiceLogger`；services/src 非 logger 模块裸 console **归零**。node.ts 无需豁免（factory 无状态，装配期已可用）。
- **identity key 重复（EI-2）**：确认 shared `resolveWorkspaceKey` 已公开导出，8+ 文件内联副本全部替换为 `import { resolveWorkspaceKey } from "@acode/shared"`（`paths.ts`/`workspaceHelpers.ts` 改薄封装复用，未新建本地工具）。**验收 grep 归零**（主审核验：`workspaceIdentity?.trim() || workspacePath` 在 services/src 0 命中）+ 新增 `workspaceKeySemantics.test.ts`（5 例钉语义）。
- **对象脱敏（R2-04，部分修）**：实测源头 JSON 化脱敏会破坏 `agent-prewarm-claim.test.ts`（它经 console 拦截读 timing 日志对象的结构化 `workspaceKey` 做身份归属断言，spec R3）；finding 以「不破坏既有调用点」为前提且「当前无实际泄漏」，故**维持对象透传契约 + 守护测试钉现状**，非桌面缺口登记为里程碑（须先解耦 `acodeAgentProcessManager.ts:1422` 观测面为结构化 telemetry 出口）。
- **nodeApiClient traceId 笔误**：`:145` 修正参数位置。
- spec：`log-privacy-redaction.md` R2 补 R2-04 边界子条 + 图表对齐；`logPrivacy.ts:102` 补决策注释。
- **追加（J 排查的 3 个泄漏测试）**：skillSyncArchiveTrust（7 处 mkdtemp，统一 trackMkdtemp 登记表 + 顶层 after）、subagentsBundledCatalog（2 处，非 J 判断的 3）、pluginSyncPathWindowsLexical（1 处，非 2）——全部实跑绿（20 pass / 1 skip[Windows 豁免]）。

自报实跑：`tsc -b packages/services` **exit 0**；`oxlint packages/services` **exit 0**（9 warnings 全既有 unused-var，不在其文件）；全量 services test 549/540 pass/**2 fail**/7 skip——2 fail 均既有、B 未触碰（skillsBundledScope S1 隔离验证 revert 后仍 fail；windowsCuaDevRuntimeResolution 是 Windows 8.3 短路径 symlink 环境产物）。主审核验 B 新测试 workspaceKeySemantics + serviceLogger.redaction **14/14 绿**。

跨文件事项（主审裁决）：① `logPrivacy.ts` R2-04 非桌面进程对象内容不经本层脱敏——真正封堵须先解耦 session-start-timing 观测面（改结构化 telemetry 出口），列为独立里程碑，勿在漏斗层单方面改。② **ServiceLogger traceId 槽位误用 ~25 处**（同类于已修的 nodeApiClient finding 5，散在 offPeakTaskService/officialMcpCredentials/settingsSyncService/node/oauthService 等）：`logger.warn("消息串", {...})` 把消息传进 traceId 首参会拼进 `[trace:...]` 前缀——非本轮 finding，建议主审统一裁决是否批量修（登记为后续项）。

### 代理 C · server 与 web

**已回收。** 全部 8 条 finding **已修**：
- **R2-04（P2）错误泄漏**：`http.ts:601,617,628` connect-remote catch 对外回归类码 `remote-connect-failed`，原始 `err.message` 降级 warn 日志。
- **decodeURIComponent URIError**：`http.ts:371-379` decode 包 try/catch 失败返 null → `GET /%` 返 404。
- **待认领 TTL**：`http.ts:181-224` 惰性过期（`spawnedAt` + 60s TTL + 纯判定/驱逐函数，**非常驻定时器**）；`:601/:711-726` 两触点 prune + 认领校验超期 close 4004。
- **R2-05（P2）Web WS 重连**：`web/src/main.tsx:393-429` onClose→指数退避重连（封顶+full jitter+可取消）+ 断线态 overlay + pagehide 清理；新建 `web/src/reconnect/`（可注入 timer/connect 控制器、复用 `@acode/ui` Button 的 overlay、入口层 i18n 表）；复用 services 侧 replayable 恢复，未改 services。`:36` 注释订正指向 store。
- **getActiveProvider 强转**：`browserOAuthCredentialRepo.ts:114` 过 `isWebOAuthProviderId`。
- **server zod 声明**：`package.json:58` 补 `devDependencies: zod 4.6.5`。**主审裁决：接受 devDependencies 放置**——依据扎实：server src 对 zod 仅 type-only import（translate.ts:24），运行时 zod 来自 @acode/shared 被 tsup noExternal 内联；放 dependencies 会让 tsup 外置 zod 改变运行时解析行为。统一到 dependencies+tsup externals 是打包策略变更，不在本轮范围。
- **server 覆盖**：补 6 测（鉴权/Origin/bot webhook/错误脱敏/TTL/decode），用有界轮询不加固定 sleep。
- **web 补 test 脚本**（该包首次有 test）+ 3 测试文件 14 例。
- spec：新建 `web/specs/web-reconnect.md`（R1-R6 规则+7 验收场景）；`server/specs/server-auth.md` M11 节补错误脱敏+惰性 TTL（替换原「不引入 TTL」风险登记）+ 验收场景 21-24。

自报实跑：`tsc -p packages/{server,web}` 均 0 错；`--filter @acode/server test` exit 0 **103/103**（原 97+新 6）；`--filter @acode/web test` exit 0 **14/14**；oxlint 0 error（2 warning 为 main.tsx:16 既有 dead import，HEAD 已存在非本次引入）。

### 代理 D · shared 协议冻结

**已回收。** R2-02（P2）+ DPAPI（P3）+ dontAsk（P3）**已修/已处置**：
- `acode-protocol-shared.ts:81-108` 迁入 `acodeMcpReconnectSuspensionSchema` + 类型的**定义**（中立叶子，M2-B 模式）；`acode-protocol/index.ts:42-59,663-665` barrel 改为纯 `export {...} from "../acode-protocol-shared.js"` re-export，`export const ...Schema` 定义不再出现（barrel schema 定义数 247→246，只减不增）。运行时验证 re-export 是同一 schema 对象。consumer（`mcp.ts:7`、UI `McpFailurePresentation.tsx:2`）import 路径逐字不破。
- **v4 面判定**：该字段只在 legacy `mcp/list` wire 流转，v4 无 mcp/list 契约，故不新增 v4 面（遵 review），依据写进 spec。
- **守护门禁**：新建 `packages/shared/test/legacy-protocol-barrel-freeze.test.ts` + `legacy-protocol-barrel-schema-baseline.json`（246 定义），断言 barrel schema 定义集合 ⊆ 冻结基线（子集关系同时捕获「删一加一」漂移）。
- **DPAPI PowerShell 注入**：`node/credentialKeychain.ts:250-262` read 路径 spawn 前加 base64 校验 `/^[A-Za-z0-9+/]+={0,2}$/`，不符返回 `{status:"error"}`；测试注入 `AAAA'); Start-Process calc.exe #` 断言 read→error + `calls.length===0`（零 spawn）+ argv 不含注入片段。修正 2 处不真实 fixture（连字符会被新校验拒）。写入路径确认安全未改。
- **dontAsk（P3）**：`git show 1272746b` 查证为 P1 权限裁决批 2 引入的**新产品档位**，非缺陷修复；**不构成双源分叉**（同批已进 v4 `submissionModeSchema`，offPeak 在 v4 无对应命令故无专属枚举可分叉）。已在 spec 登记同源结论 + 约束「offPeak v4 化时复用 submissionModeSchema，不得另建第二份五档词表」。未回退值域（回退会破坏 UI）。
- **resolveWorkspaceKey**：确认已从 `@acode/shared` 根入口（`index.ts:92` `export * from "./task-realtime-core.js"`）可达，**无需改动**。→ 代理 B（services）identity key 收敛应直接 `import { resolveWorkspaceKey } from "@acode/shared"`。
- 新建 spec `packages/shared/specs/legacy-protocol-freeze.md`（冻结规则单一事实源 + R2-02/dontAsk 处置登记）；未改 convergence-plan（以指针引用避免重复）。

自报实跑：`tsc -b packages/shared` exit 0；`--filter @acode/shared test` exit 0 **354/354 pass**；`oxlint` 5 文件 0/0；`architecture-check` exit 0 **new 0/regrown 0**（412=412）。

跨文件事项：无需架构代理改 policy（无新公开入口，barrel re-export 面逐名不变）。观测到 `model-option-map/src/compiler.ts` 曾被并发代理 J 改动引入 TDZ 编译错误、后自修（非 D 所有权，仅告知）。

### 代理 E · UI 状态收口

**已回收。** R2-06（P2）+ R2-07（P2）+ console（P3）**全部已修**：
- **R2-06 task meta 收口**：`lib/taskListMetaSync.ts:24-127` 新增 `writeTaskMetaToCaches` 单一事务函数（一函数内完成 optimistic 池/clearTaskState/remoteTimeline/remotePinned/query cache 五处写入，remote 按 workspaceIdentity gating）。6 个 Workspace* 组件 38 处直调全部收口（review 标 40，实测 invocation 38）：SidebarItem 6、HeaderSections 6、TimelineTasksSection 11、PinnedTasksSection 11、GroupedTasksSection 3、ArchivedTasksFlatSection 1；顺带删 11 个死 selector + 6 个死 ref。**组件内 `applyTaskQueryCacheMutation` 直调点 38 → 0**（守护测试确认调用点仅剩 store 定义 + taskListMetaSync 两处内部）。`taskListCache` 与 `taskQueryCacheStore` 未硬删——spec 写明二者非双权威（前者=服务端快照 reader，后者=交互权威）+ 收敛计划。remote placement 保持显式声明而非派生（`removeTask` 会递减 total，自动派生会在 unpin/rollback 阶段错误增减），理由入 spec。
- **R2-07 useTheme 死代码**：`useTheme.ts` 删 hook 本体 + 私有 isTheme + STORAGE_KEY（保留 applyTheme/resolveTheme/normalizeThemePreference 纯函数，store 与 App 仍在用）；`index.ts:28` 移除导出（保留 `export type { Theme }`）。全仓复核（含 desktop/web/renderer）无值消费者。`acode-theme` 写入点现全局唯一（store.setTheme）。
- **SettingsPage console.warn**：`:907` → `logger.warn`（补 import）。
- spec/测试：新建 `specs/task-meta-cache-ownership.md`（四副本所有者表/单一写入路径/回滚口径/收敛计划）+ 3 个新测试（`taskMetaCacheOwnership.guard`：源码扫描零直调；`taskMetaCacheComposition`：真实 store rename/pin 乐观+回滚/archive/gating 四副本一致；`themeWriteOwnership.guard`：写入点唯一 + useTheme 不再导出）；改 `appearance-preference-axes.md:62` 删已删 hook 引用。
- 跨文件：web/desktop renderer 两处误导注释已被代理 C/G 订正（E 复核无需接手）——与 C 报告一致。

自报实跑：`tsc -p packages/ui` **0 错**（K 报告的 E 中间态错误已收敛，主审独立复跑证实 EXIT=0）；`--filter @acode/ui test` exit 0 **545/545 pass**（含新增 8）；oxlint 改动文件 0 error（3 warning 为 SettingsPage 既有未用参数）。

### 代理 F · UI 设计系统

**已回收。** R2-08（P2）+ 字号（P2）+ 裸 button（P3）**已修（本轮命名范围）**，12 文件 +69/−36：
- **根因级修复**：全局 `*:focus-visible{box-shadow:none!important}` 压掉所有 ring-*，Button 基座原本对 default/outline/ghost/secondary **无任何生效焦点态**（R2-08 的深层根因）。`components/ui/button.tsx:14` 基座补 `focus-visible:border-input-border-focused`（沿用 input.tsx 既有 border-color 通道：常驻透明 1px 边框→聚焦变色，无布局位移；destructive/warning 变体各自的 border 仍由 tailwind-merge 覆盖）。**影响全部 231 个 Button 消费方，属全局 a11y 净改善**——ui 测试 537/537 绿佐证无行为回归；视觉效果未验证（如实登记）。
- AutomationEditView 4 命名按钮→Button variant（default/lg、outline/lg、outline/icon-lg、ghost/icon-sm）+ 3 处 pill 失效 ring→`bg-input-focused`；OffPeakEditView/ActionsMenu/HistoryTab/PluginStoreDetailView 同批处理；所有移除默认 ring 处补 border/bg 替代焦点态。PluginStore 照片遮罩 white 值按内容级例外保留+注释。
- 字号：5 处业务 `text-[Npx]` 全迁既有 `text-ui-*`（无需新 token，DESIGN.md 未改）；2 处图表内联 fontSize 保留+中文豁免注释。
- 违规计数（命名文件内，前→后）：`bg-white|text-black` 按钮簇 **9→0**；`ring-0` **5→0**；业务 `text-[Npx]` **5→0**。
- **待处理清单（如实登记未改）**：不可见焦点 44 处/32 文件（Top: PluginStoreListView 5、AutomationsSection 5）；`bg-white/text-black` 剩 7 处（其中 AutomationEditView:986,1005 属 `bg-[#4099FF]` radio 硬编码簇，`--color-brand` 在 Zai Dark=#fff 直接换 token 会白点隐白底，需视觉验证故未动）；裸 button 全仓剩 212 处（F 改的文件内均已带 aria-label/文本名）；`text-[Npx]` 剩 3 处全是注释掉的调试 `<pre>`。
- 主审核验：F 跑 tsc 时见 `index.ts:28 useTheme` 错（E 中间态）；主审随后复跑 `tsc -p packages/ui` **EXIT=0 / 0 错**，E 已收敛。
- 所有权裁决（主审）：`WorkspaceSidebarFooter.tsx:155` 单行 token 改动归 F 有效，与 E 无实际冲突（E 的清单不含该文件），不回退。

### 代理 G · desktop 边界

**已回收。** 5 项 finding + 追加泄漏修复 **全部已修**，desktop 全量 **417/417 pass**：
- **relay_bridge 死枚举（P2）**：rg 全仓复核确认无赋值点、Main 侧 deliveryKind 只作日志/诊断无分支消费。选项 (a)：保留枚举 + `taskRealtimeBus.ts:192` 注释指向 server-cli 真源，spec 写明「Main 侧只实现 desktop_window」。shared 类型定义未改（跨文件事项）。
- **replay mirror 非权威语义（P2）**：新建 spec `task-realtime-bus-mirror.md` 钉死语义 + 不变量「Main 侧不得新增快照落盘」；**修复 review 遗漏的真实缺陷**——host 退出（非 terminal）此前只靠 flushBatch 在 terminal 删批，`releaseLeasesForHost` 残留镜像泄漏（`:408,424` 改为无条件 `discardStreamBatch` + 回收去重桶）。补 6 测（terminal/lease/host退出三清理路径 + 60 批/512KB 双阈值截断→`stream_mirror_gap` + oversized 降级）。
- **主窗 sandbox（P3）**：`desktopWindowChrome.ts:595` 显式 `sandbox:true`。核实 Electron 41.10.7 默认已 true、无调用点设 false（**显式化零行为变更**）；webFrame/webUtils/process.argv/platform 均在沙箱白名单；preload:182 的 process.title 写入在既有默认下早已 no-op。electron-hardening spec §1b 登记依据。
- **去重 LRU 固定 1000（P3）**：`:151,1128` 全局单队列改按 task/workspace 分桶（每桶独立有界窗口 + 256 桶兜底防泄漏）；测试断言多 run 并发下 observer 无重复流事件（旧全局窗口 limit=3 下 taskA 高频会挤掉 taskB→重复；分桶后不重复）+ terminal/host 退出后桶回收。
- **renderer main.tsx:73 注释**：订正指向 `packages/ui/src/store/index.ts`（读 acode-theme 持久化真源）。
- **追加（J 排查）**：`official-service-switches.test.mjs` 5 处 mkdtemp 补 `t.after` rm；实测 before-count=after-count=2（创建即清理）。
- spec：新建 `task-realtime-bus-mirror.md`（含事件顺序图与所有者）、更新 `electron-hardening.md` §1b。
- **未做**：e2e:smoke 未验证（禁止启动 Electron）；改了主窗启动路径 webPreferences 但用 typecheck+静态核实覆盖（无运行时行为变更），真机启动未跑——**主审最终验证时若能跑 smoke 应覆盖此路径**。

自报实跑：`tsc -p tsconfig.main.json` + `tsconfig.renderer.json` 均 exit 0（该包无 `typecheck` script，用直接 tsc 等价覆盖）；oxlint packages/desktop 0/0；task-realtime-bus-mirror 测试 9/9；official-service-switches 6/6；全量 desktop test **417/417**。

跨文件事项：① `shared/src/task-realtime.ts:78`+`task-realtime-core.ts:101` 的 `relay_bridge` 死枚举归 shared（D 已退出）——desktop 侧已按有意预留注释，不阻塞；主审可选择在 shared 侧删值或加注释（低优先）。② desktop tests 目录另有 `acode-official-cache-*` 临时目录遗留（非本文件产生，来源未定位），供后续追查（不阻塞）。

### 代理 H · 治理小包与 knip

**已回收。** R2-09（P2）+ R2-10（P2）+ 2×P3 **全部已修**：
- **R2-09 acode-cua 表述订正**：`package.json:5` description、`README.md`（重写三节）、`CONTRACT.md:1-27`（新增「fail-closed 边界」节，附 node.ts:2273 门控链）、`index.js:61` 中文注释（fail-closed 仅来自「无 brokerSocketPath」，真门控在 services/node.ts:2273）。新测试 `apps/acode-cli/tests/cua-failclosed-gating.test.mjs`（9 测试）：①无 socketPath→isError；②只读导入门控谓词验证门控关时不建 Helper（未改 node.ts）。
- **R2-10 formal-proof 补真测试**：核实 model.ts 有真实运行时行为（`evaluate`/`buildTraceTree`/`collectStats`），走真测试路线（非例外登记）。`package.json:12` 加 test 脚本 + 新建 `test/model.test.ts`（**26 测试**，覆盖 spec 明写每条不变量：纯函数性、held queue→choice、各阶段 reject/enqueue、mergeQueue、drain、buildTraceTree 确定性+resetIds、enumerateCandidates 过滤、stats/flatten 一致性）。`specs/module-boundary.md:50` 验收场景 3 同步更新。
- **node-repl-host 声明**：`package.json:30` devDependencies 加 `@modelcontextprotocol/sdk@^1.29.0`（cua-bridge.ts:5 是 `import type`，运行时擦除）。**需主审统一 `pnpm install` 入 lockfile。**
- **knip hints 2→1**：`knip.jsonc:53` 删 desktop `yauzl` ignore（`support-bundle.test.mjs:6` 已真 import，冗余）；`:250` `.acode/**` 保留 + 注释理由（防御性 ignore，跑过工作流才有 runtime 文件，删了会假失败）。
- **测试期发现的真实语义（已固化进测试）**：`ACODE_CUA_DEV_MODE=1` 优先级**高于** `ACODE_CUA_PRODUCT_HELPER=0`（runtimeEnv.ts:44 短路）；**review 文档「默认构建 cuaPluginEnabled=false」已过期**——`isACodeCuaInternalFeatureEnabled` 默认 ON，生产 fail-closed 实际靠 `shouldCreateDefaultCuaProductHelper` admission（仅 desktop-local）+ Helper host stub。→ 主审需订正 architecture-governance.md §5/§6 与本总入口相应表述。

自报实跑：formal-proof test **26/26 pass** + typecheck exit 0；cua-failclosed-gating **9/9 pass**；`knip:gate` exit 0（hints 2→1）；oxlint 0/0；node-repl-host typecheck exit 0。

跨文件事项：① 主审统一 `pnpm install --frozen-lockfile` 使 sdk 声明入 lockfile（install 后 knip unlisted 应下降）；② review 文档订正（见上，归主审）。

### 代理 I · CLI core 状态所有权（含 P1）

**已回收。** R1-01（P1）**第一切片完成** + 4 项 P3/P2 处置：
- **R1-01 原型注入绕过 owner（P1，有界切片）**：新建 `runtime/runtime-turn-timing.ts`（`RuntimeTurnTimingOwner`：WeakMap 真值 + 只读 getter + 有限写端口，形态照 turn-coordination/permission-grant）。**7 字段收敛**：`turnNumber`、`activeTurn`、`pendingInputSequence`、`pendingInputReservations`、`pendingInputDrains`、`queueAutoDrain`、`queueExternalDrainActive`（pendingInput*/queue*Drain* 整族同迁，无双写路径）；`internal.ts:202` RuntimeTurnState 改 extends View、删扁平字段；`agent-runtime.ts` 7 字段 `declare private readonly` + 构造期 initialize；methods 6 文件全部写点改端口。**负向测试**（tsc 拒赋值，diagnostics 11→18）+ **R1-01 机械门禁**（proto 注入面 ⊆ 声明成员）均落地跑绿。剩余登记 spec：RuntimeTurnState 还有 5 字段 + 其余 3 簇约 46 字段 + 长期「显式组合」方案。
- **CLI-04 残余两 sink（P3）**：`mcp/call-audit.ts` + `worktree/session-worktree-fence.ts` 改 sessionId 注册表 + 幂等释放 + 按 sessionId 路由（照 bash-reflex 范式）；`create-app.ts` 接线改 register*（仅这两个 sink，21+/15−）；双 App 交错测试绿。
- **resume concurrentSafe（P3）**：核实 service reservation 是唯一权威（handler 纯 passthrough、resumeAdmissions service 级 Set、reservation 在任何 await 前同步 has/add），保留 true + 中文注释写核实结论。
- **runner.ts 拆分（P2）**：**不硬拆，登记**。核实：生命周期边界不稳（近 90 天 8 次提交集中在 background 三态/terminal-first-wins 核心区），头注前置未满足；新建 `specs/subagent-runner-split-plan.md`（3 前置条件 + 6 模块方案 + 移动纪律）。
- **core zod 声明（P3）**：`core/package.json:52` 补 `"zod": "4.6.5"`（运行时依赖，`deferred-tool-call.ts:88` `z.unknown()` 值调用）。
- spec：`runtime-state-ownership.md` 加「P1 第一切片」节（根因/7 字段表/turn 时序事件顺序图/验收）+「剩余字段与后续批次」表；新建 `subagent-runner-split-plan.md`。

自报实跑：`--filter @acode/core typecheck` **0**；`--filter @acode/core test` **130/130**；runtime-state-ownership **31/31**（负例+门禁）；sink 双 App 测试 **20/20**；race 系列 **71/71**；oxlint core/src 0 error。全 CLI `node --test tests/**` 2970/2919/14 fail——**14 fail 逐一三角定位均非本轮回归**：5 缺 libs.generated.js（环境）、4 真实 MCP 子进程连不上（既有）、2 architecture-discovery shape 断言（L 的 discovery.mjs exports 改动所致，见跨文件）、2 pwsh 真机（环境）、1 third-party 台账哈希（core 加 zod 合法改变哈希，台账文件不在其所有权）。

跨文件事项（主审统一验证时处理）：① **bootstrap typecheck 当前红（5 error）**：`create-app.ts` 引用 core 新导出 `registerMcpCallAuditSink`/`registerSessionWorktreeFenceWarnSink`，但 bootstrap 经 core 的 **stale dist**（dist/index.d.ts 早于 I 改动）解析——`pnpm --dir apps/acode-cli build` 重建后即消（core 源码 typecheck 已绿）。② `third-party/inventory.json` 需回补 core 新哈希（连同其余代理的 package.json 改动，走既有台账流程）。③ 2 个 `architecture-discovery` 测试 fail —— **主审已修**：L 的 `discovery.mjs` 把 `workspacePackages` 从字符串改为 `{root, exports}`（resolver 缺口① exports map 能力），测试断言随能力更新为 `.root`（保留「发现哪些包」意图；`String(entry.root)` 修正原 `String(对象)` 得 `[object Object]` 的假通过）；`policy.mjs:335` 已兼容新旧 shape。复跑 architecture-discovery **4/4 绿**。

### 代理 J · CI 门禁与测试基建（含 2×P1）

**已回收。** R1-03 + R1-04（两 P1）**已修（CI 部分仅静态核对，未在真实 runner 验证）**：
- `ci.yml:122-179` 新增独立 `windows-verify` job（windows-latest）：install→typecheck→lint→构建 CLI workspace→core/services/shared 三包测试；`shell: bash`、Node 钉 24.14.0、无 cache save、无 continue-on-error（独立 job，不把现有 job 改 matrix，避免弄红主门禁）。
- `release.yml:86-127` 新增 `desktop-smoke` job（windows-latest，needs: verify）：install→typecheck→desktop build→`e2e:smoke`；`:746-752` `publish` 的 needs 加 `desktop-smoke` + if 加 `result == 'success'`（fail-closed 阻断，无 skipped 兜底）。
- 新建 spec `docs/specs/ci-platform-matrix.md`（矩阵范围/理由/验收/未验证边界）；`cli-validation-gates.md:11` 加规则 9 指针。
- **descriptor 阈值**：`rpc-descriptor-surface.test.mjs:9-96` `>=40` 改为**频道名集合 deepEqual**（比精确数字更强，检出「删一加一」漂移）。**纠正 review 前提**：descriptor 实为 **40 个**（testing.md 记的 84 是含 interface 声明的 grep 命中数）；负向注入幽灵频道→fail，证明非恒绿。
- **speed 测试**：新建 `registry-selection-speed-error.test.mjs`（8122e200 配套，`createRegistrySelectionProtocolError` 全分支闭集 + speed 两档消息）；源码映射逻辑本身正确无需改。
- **model-option-map**：加 test 脚本 + 新建 `src/bounded-cache.ts`（有界 LRU，上限 512）替换 compiler.ts 三个裸 Map（无界缓存 P3）+ 14 测。
- **provider-node/server-cli 覆盖**：各补 3 测试文件，比例均 ≥0.15。
- **临时目录泄漏**：修了自己所有的 `guide-live-build-section.test.mjs`（makeTree 注册 t.after rm）；**其余 5 个在不属它的包，见跨文件事项**。

自报实跑：model-option-map test **14 pass** + typecheck/oxlint 绿；provider-node **29 pass**；server-cli **25 pass**；speed+guide **9 pass**；descriptor 1 pass + 负向 fail。**CI YAML 仅静态核对**（`yaml.parse` 验 job 图/steps/needs/if，无 tab/无 cache save/无 continue-on-error），**两 workflow 均未在真实 runner 验证**（禁止 push），e2e:smoke 未实跑（禁止启动 Electron）。

CI 风险（需主审决策，详见其报告）：① Windows leg 大概率暴露既有 win32 失败（这正是 R1-03 目的，spec 规则 6 不放宽测试，如实登记待修，失败面过大则走 spec 退路分批）；② desktop-smoke 构建成本分钟级 + Windows runner GUI 稳定性以首跑为准（spec 立场必须阻断发布）；③ Windows leg 无 pnpm store 缓存冷装偏慢（隔离失败面优先，可接受）；④ Windows leg 钉 Node 24.14.0 比既有 job 的 `24` 严，本地 v25.9.0，CI 以 24.14.0 为准。

跨文件事项（5 个临时目录泄漏，均确认 mkdtemp 无 rm/t.after/finally）：`services/test/{skillSyncArchiveTrust,subagentsBundledCatalog,pluginSyncPathWindowsLexical}.test.ts` → 代理 B；`shared/test/archiveTrustTiers.test.ts` → 主审（D 已退出）；`desktop/tests/official-service-switches.test.mjs` → 代理 G。修法：每处补 `t.after(() => rm(dir, {recursive:true, force:true}))`。

### 代理 K · SessionPane 拆分（含 P1）

**已回收。** R1-02（P1）**已修（本轮切片范围）**：
- 按 plan 前置顺序执行：先补接缝内测试（16 绿）再抽。新建 `packages/ui/src/v4/session-pane/commandOrchestration.ts`（220 行 <400）：命令编排**纯决策逻辑**（`submissionConfigFromCommand`/`resolveQueuedComposerRestore`/`shouldRestoreQueuedComposerFromAck` 逐字迁移 + `resolveEditUserQueryPayload`/`resolveSlashCommandDispatch` 新抽），唯一运行时 import 是 leaf slashCommands.js，无环。
- `SessionPane.tsx` **3762 → 3672（−90，单调下降）**；闭包族（dispatchCommand/snapshotRef/lease + 20 handler）整体保留、零 state 副本、行为逐字不变（deps 数组未动）。因无 jsdom，采用 plan 许可的替代路径：抽纯决策函数 + 决策表单测。豁免头注更新（未删——仍 >400，门禁不红）。
- `god-component-split-plan.md` 整体重写：登记本轮接缝/验收口径、settings 3 上帝组件各一节（AutomationEditView 3 批、SubagentsSection 3 批、AutomationsSection 2 批，第一刀均为「顶部纯 helper 外迁+单测」）、测试债清单、后续批次顺序（提示词历史→模型选择器→排队确认→命令闭包族【需先 lease controller 抽象，风险最高最后】）。
- **12 个字符串匹配测试升级（P3）部分修**：`splitPaneErrorIsolation.test.ts` 3→8 测试，5 个升级为**真实行为断言**（捕获归一化→fallback role=alert 不白屏、非 Error 归一化、children 透传、silent variant、resetKeys 清错）。关键实测发现：`renderToStaticMarkup` **不运行**错误边界（SSR 直接冒泡），改用驱动 boundary 实例 `getDerivedStateFromError`+seeded render 拿真实 fallback markup。其余：5 个已是混合真实行为测试；6 个确无 jsdom 无法升级，加「结构守护测试，非行为验证」注释 + 登记 plan 测试债。

自报实跑：`pnpm --filter @acode/ui test` exit 0 **537/537 pass**（K 两文件贡献 24）；`tsc -p packages/ui` K 自己的文件 0 错（**18+9 错全在 `WorkspaceHeaderSections.tsx`/`WorkspaceTimelineTasksSection.tsx`——代理 E 的 remote-store 接线中间态，非 K 引入**）；oxlint 10 文件 0/0；max-lines 规则验证真实生效（合成 442 行文件→1 error，220 行模块→clean）。

跨文件事项：根级 typecheck 会因 E 的两个文件报 `useRemotePinnedTaskStore`/`useRemoteTimelineTaskStore`/`applyTaskQueryCacheMutation` 未定义——**主审最终验证前必须等 E 收尾**；若 E 完成后仍报错，即为真实缺陷需修。

### 代理 L · 架构检查器 resolver

**已回收。** resolver 三缺口 + session 白名单机制 **全部落地**，fixture 13/13 绿：
- **缺口② 通配入口**：`policy.mjs:52-68` 新增 `publicEntrypointPatterns`（glob，强制含 `*`）+ `globToRegExp` + `publicEntrypointMatches` 通配分支；fixture 覆盖相对/包名/动态/re-export 四写法。**server `remote/*.ts` 故意不收敛**：47 个非 test 文件中仅 5 个被跨模块消费，通配会把公开面 5→47 放宽边界——能力就绪 + spec 登记启用条件。
- **缺口③ asset 豁免**：`global.assetExtensions: [.css,.svg,.png,.mp3]`（显式声明非硬编码，默认空=fail-closed）；`index.mjs:228` asset specifier 不解析/不入图/不判违规。fixture：asset 放行 + 伪装 asset 的 `.ts` side-effect deep-import **不放行** + 变异测试坐实非空转。
- **缺口① exports map**：探针实测原解析 18/20（2 个 remap 型子路径失败），`resolveExportsTarget` 补齐后 **20/20**（含 conditional exports 递归、`.d.ts` 排除防 desktop→client ambient 误报）；importer 均在 legacy acode-cli 且 target 是已登记入口，门禁 0 变化。
- **session 白名单机制**：checker 支持「空 publicEntrypoints + `internalEdgeAllowlist`」，登记 **24 条**存量 services→session 边（checker 口径=distinct 非 test 跨模块 from→to 对；review 的 39-40 是含 test/specifier 重复的另一口径）。**新增边未登记即报 deep-import**——把「惰性保持合法」变成「新增需显式登记」，止住增长。未做全量迁移（里程碑工作）。session 现 0 deep-import 泄漏。
- **纳管路线图**（写进 `docs/specs/architecture-coverage.md`）：web 11 文件/0 超限，**0.5-1 人日最优先**；desktop 262/36 超限 3-5 人日；services 294/47 8-12 人日；ui 1574/176 10-15 人日；acode-cli 2107/160 按「一子包一模块」续批。
- spec 更新：`session-module-boundary.md`（56 文件/24 边/25 re-export 更正 + 白名单机制 + 2026-12-31 里程碑）、`architecture-coverage.md`（Resolver 能力节 + 路线图节）、`architecture-ratchet.md`（边界声明 ratchet 语义：只收紧不放宽）。
- **推翻 M 的 baseline 请求（实证）**：legacy-over-limit 的 fingerprint=sha256(`max-file-lines\0<file>\0legacy-over-limit`)，**不含行数**（index.mjs:169）；重算=`b8331ce55a020924` 与 baseline 一致；product-projection 是缩小（6075→5680），regrown 仅在 HEAD≤400 且工作树>400 时触发。**既不刷 baseline 也不加 exception**，message 里的 5544 是 cosmetic。M 的跨文件事项**关闭，无需动作**。
- 隔离验证铁证：把 L 的 4 文件 revert 到 HEAD 跑 check → 同样 413/412 new 1，唯一 new 同为 web/main.tsx——**L 的 resolver 改动净零**。

自报实跑：`architecture-check` 改动后 violations 413/baseline 412/**new 1**（唯一 new=`web/main.tsx` 432 行 max-file-lines，HEAD=382，**代理 C 的 WS 重连改动所致，非 L**）；fixture `architecture-coverage.test.mjs` **13/13 pass**（原 6+新 7）；oxlint 4 文件 0/0。

跨文件事项：**`web/main.tsx` 432 行需拆分或登记例外，否则全量 architecture:check 保持 exit 1**——C 已退出，主审接手（拆分优先于登记例外，C 已建 `web/src/reconnect/` 可承接下沉）。

### 代理 M · product-projection 拆分

**已回收。** R2-12 相关 [P2] **部分修（批次 1，可安全拆部分完成，主体如实停止）**：
- 新建 spec `apps/acode-cli/specs/product-projection-structure.md`（14 事件域 D1-D14 划分、公开面契约、批次计划）。
- 抽出 5 个纯叶子模块（全 <400 行）：`product-projection-types.ts`(140)、`-primitives.ts`(22)、`-hooks.ts`(61)、`-model.ts`(76)、`-tool-display.ts`(186)。
- `product-projection.ts` **6075 → 5680（−395）**，`max-lines` 头注豁免收窄（说明纯叶子已出、剩余是有状态 class、被前置条件阻塞）。
- **零行为改变**：class body 经 `diff` 证明逐字节相同，唯一差异是尾部 160 行纯函数迁入 tool-display.ts；8 个外部 importer 全经 `product-projection.js` re-export 解析。
- **P2 主体（6075 行 god-class）未降到 400 以下，如实停止**：该 class 约 60 个共享可变私有字段（`this.snapshot` 引用 141 次），`cloneProjection`/`adoptProjection` 逐字段手工枚举是 `applyEventAtomically` 原子提交/回滚不变量；**黄金 replay 等价测试从未建成**（现有 59 投影测试是行为点检，无法机械捕获拆分引入的字段/clone 遗漏）。按域移 handler 只有两条路都改行为：放宽约 60 私有字段（= 本轮 P1 要消除的原型注入反模式），或传巨型 context（耦合原样搬迁 + 静默破坏原子提交）。拆分方案与前置写进 spec §4（批次 2 建等价 harness → 批次 3 收敛字段为单一 state 对象后按域拆）。

自报实跑：`--filter @acode/bootstrap typecheck` exit 0；`oxlint` 6 文件 0 warning；投影测试 11 文件**原版 74/71 pass/3 fail，新版计数完全一致无回归**（3 fail 全是 `plugin-state-bridge.test.mjs` 的 "MCP server is not connected"，环境依赖需活 MCP server，已用备份还原原版复跑证实改动前同样 fail；该错误串内嵌指令，代理按数据对待未执行）。无循环 import。

后续建议（未动手）：`v4-gateway.ts`(3486) 结构不同（4 class/2 私有字段/11 module 函数，非单 god-class），纯叶子抽出低风险空间更大，但需独立 spec 周期。app 层 R2-11 属里程碑债务（依赖 legacy M3），按指令未碰。

### 代理 N · 高风险行为覆盖测试

**已回收。** testing.md §7 五个盲区**全部补齐，37 test / 37 pass / 0 fail**，零 src 改动（纯测试任务）：
- `runtime-abort-concurrency.test.mjs`（6 test）：运行中取消的中止传播、真实子进程 kill、取消后终态一致、重复取消幂等（DWF-01 signal 链 :340-347→:52-56 段）。
- `resume-hydration-read-state.test.mjs`（6 test）：真实 Read→compact→hydrate→Edit 全 IO 端到端，preserved tail/range/partial 口径、「模型可见」修剪、Edit 不误报 FILE_NOT_READ（b3779769/66a11532 真实 bug 类型的防回归）。
- `workspace-identity-routing.test.mjs`（8 test）：identity key 统一语义、同路径不同 identity 不串线、同 identity 不同路径归并、remoteSessionId 贯穿、仅路径匹配被拒（负向）。
- `delivery-profile-contrast.test.mjs`（7 test）：同一事实流经 continuous/replayable 两 profile 的对照（flush 间隔、字段抑制、toolProgress、语义不互漏）。
- `snapshot-gap-repair.test.mjs`（10 test）：序号空洞、重复投递去重、失配 snapshot invalidation、wire schema 面。
- 新登记 spec `apps/acode-cli/specs/review-blindspot-coverage.md`。
- **负向有效性逐一验证**（定向改坏→变红→还原，`git diff --stat` 归零）：hydrator 参数、resolveWorkspaceKey 改 path-only、continuous filter、gap seq 检查、worldRun signal 传 undefined——5 处破坏各自命中预期测试。
- **发现的缺陷：无**。五条链路当前实现均正确（一处断言错是代理自己的预期写错，核对实现后修正，实现与 docstring 一致）。
- 纪律达标：无固定 sleep（waitUntil 有界轮询）、临时目录全 `t.after` 清理、5 文件不依赖生成产物可直接跑；abort 文件 ~12s 来自 Windows 5s 强杀宽限窗 ×2，确定性等待非 flake。
- 未覆盖项（如实登记）：mirror batch 跨批次对账（宿主消费侧，无纯函数可对账）；abort 引擎层准入竞态（需 EngineState+journal 装配且 core 正被代理 I 改，改测了稳定的下游接缝）。

## 跨文件事项汇总

（各代理报告中标注「需主审或其他代理接手」的项，回收后在此去重、排依赖、分派。）

| 来源 | 事项 | 分派 | 状态 |
|---|---|---|---|
| D | `resolveWorkspaceKey` 公开导入路径确认 | → 代理 B | ✅ 已发送，B 按此收敛 identity key |
| M | `.architecture-baseline.json:2706` product-projection 条目过期（记 5544，实 5680） | → 代理 L | ✅ **关闭（L 实证推翻）**：legacy-over-limit 指纹=sha256 不含行数，重算与 baseline 一致，缩小不触发 regrown，无需刷新/登记 |
| J | 5 个临时目录泄漏测试文件 | services ×3 → 代理 B；desktop ×1 → 代理 G；shared ×1（archiveTrustTiers）→ 主审 | ✅ 全部完成（主审项 11/11 绿；G 已修 official-service-switches 6/6；B 待其报告确认 3 个） |
| A | 「percent-encode 后不含 shell 元字符」通用断言宜在 core/bootstrap URL 工具收敛 | 登记备查（低优先，不阻塞） | 未分派 |
| H | node-repl-host 新 devDep 需 `pnpm install` 入 lockfile | → 主审统一验证时执行 | 待执行 |
| H | review 文档订正：cua「默认构建 cuaPluginEnabled=false」已过期 | → 主审 | 待执行 |
| J | review 文档订正：descriptor 计数 84 是 grep 命中数，真实为 40 | → 主审 | 待执行 |
| J | Windows leg / desktop-smoke 首跑结果需 push 后观察 | → 主审（提交后决策） | 待执行 |
| L | **`web/main.tsx` 432 行触发 legacy max-file-lines new 1，architecture:check exit 1** | → 主审（C 已退出） | ✅ **主审已修**：抽 `createWebPlatform`+`resolveFeedbackUrl` 到新 `web/src/webPlatform.ts`（逐字迁移，行为不变），main.tsx 432→265 行、清 2 处 dead import、移除过时 max-lines 豁免头注。复验：web tsc 0 错、oxlint 0/0、web test 14/14、`architecture:check` **回到 OK（violations 412 / new 0 / regrown 0）**。web 保持 0 超限文件（L 路线图里最该优先纳管的根）。 |

## 里程碑债务（本轮不做完整修复，仅登记/切片）

review 明确以下 4 类为里程碑级债务，本轮只做有界切片或 spec 登记，不假装完成：

1. **legacy 协议 M2/M3/M4 退役**（bootstrap legacy server 48 文件/14,713 行、legacy barrel 3,654 行）——依赖链长，代理 D 只处理冻结面违规新增（R2-02）与 schema 迁移，不推进 M3/M4。
2. **原型注入换显式组合**（约 180 方法 / 50 扁平字段）——代理 I 做 `RuntimeTurnState` 高频字段第一切片 + 机械门禁测试，其余登记后续批次。
3. **115 个巨型组件全拆**——代理 K 做 SessionPane 命令组一个接缝（含前置测试），代理 M 做 product-projection 一个文件，其余登记进 split-plan。
4. **bootstrap `src/app/` 应用层 W2 抽包**（57 文件/13,590 行）——依赖 legacy M3，本轮不动，代理 I/M 仅在 spec 登记。
5. **session publicEntrypoints 39 条内部边迁移**——代理 L 做「新增需显式登记」的白名单机制止住增长，不做全量迁移。

## 主审统一验证

14/14 代理全部回收，跨文件事项已处理。主审在干净串行环境复跑门禁（环境：Windows 11 / Node v25.9.0 / pnpm 10.33.2；`mise.toml` 固定 Node 24.14.0，本轮未在固定版本下复跑）。

### 前置动作

1. `pnpm install --prefer-offline` → exit 0，added 3（H 的 node-repl-host `@modelcontextprotocol/sdk`、C 的 server `zod`、I 的 core `zod` 三处新声明入 lockfile）。
2. `pnpm --dir apps/acode-cli build`（根 turbo 全路径，acode-cli/.bin 无 turbo）→ exit 0，19/19 tasks，消除 I 报的 bootstrap stale dist + 生成 `libs.generated.ts` codegen 产物（`.gitignore` 忽略、非提交文件）。

### 门禁实跑结果

| 检查 | 退出码 | 关键计数 |
|---|---|---|
| `pnpm typecheck`（三阶段单一门禁） | **0** | packages 36.3s / desktop-renderer 2.4s / cli 14.5s（32/32 tasks）——**I 报的 bootstrap typecheck 红确系 stale dist，构建后消除** |
| `pnpm lint`（oxlint） | **0** | 165 warnings / **0 errors**，5437 文件 |
| `pnpm architecture:check --changed`（pre-push 真实门禁） | **0** | **new 0 / regrown 0** |
| `pnpm knip:gate` | **0** | web unused 已消除（补 `packages/web` project 段声明 `.tsx` 测试 + registerHooks 动态桩为 entry）；仅剩 1 条 `.acode/**` 无害 hint（H 已注明保留理由） |
| `pnpm test`（全 workspace） | 见下 | codegen 前 8 fail 全是缺 `libs.generated.ts`；生成后重跑确认 |

### 两处门禁红的定性与处置

1. **architecture:check 全量 new 1（假红，非源码违规）**：`apps/acode-cli/packages/browser-use-plugin/scripts/relay-server.mjs`（1912 行）是 **gitignored 构建产物**（`.gitignore:3` 忽略），主审 build 时生成、review 基线干净树不含它。移走该产物后源码树全量 **new 0 / regrown 0**（violations 414）。CI 里 `architecture:check`（ci.yml:64）跑在 `Build CLI`（:85）**之前**，pre-push 用 `--changed`（不扫 gitignored）——**两种真实门禁路径都扫不到它**。源码提交无违规。
2. **knip:gate web 2 文件 unused（真问题，已修）**：C 给 web 首次加 test 脚本，但 `WebDisconnectOverlay.test.tsx`（`.tsx` JSX，knip 默认只认 `.test.ts/.mjs`）+ `__stubs__/acodeUi.ts`（经 `node:test registerHooks` 动态 import，静态不可见）被判 unused。主审按 acode-server-cli 惯例给 `knip.jsonc` 补 `packages/web` project 段声明这两类为 entry → knip:gate exit 0。

### 全量 test 计数（codegen 产物就位后）

`pnpm test` 首跑（codegen 前）：apps/acode-cli 2970 tests / 2925 pass / **8 fail**——全部 `workflow-*` 测试报 `ERR_MODULE_NOT_FOUND: libs.generated.js`（dynamic-workflow codegen 产物缺失，`.gitignore` 忽略、build 首步 `generate-libs.mjs` 生成；turbo build 缓存命中时跳过实际执行）。**非代码回归**：review cli-runtime.md §6 已记录此现象（当时 2 个 DWF 测试同因失败）。主审强制 `node scripts/generate-libs.mjs` 生成后，相关 5 文件串行 **87/87 全绿**（其中 1 个 `workflow-script-determinism` C1 沙箱时钟测试在默认并发下偶发 flake，串行复跑通过——属 testing.md §5 记录的墙钟依赖类，非本轮引入）。完整重跑计数见下（后台任务 bjs7lwirl）。

### third-party ledger 哈希（CI 门禁 ci.yml:77，留给发布流程）

`node scripts/licenses.mjs reproducibility --inputs-only` → exit 1，**9 个 inputs 哈希不符**：`core/node-repl-host/acode-cua/formal-proof/model-option-map/server/web` 的 package.json（本轮加 test 脚本/依赖声明）+ `ui/src/components/ui/button.tsx`（F 加焦点边框）+ `pnpm-lock.yaml`（主审 install 后变动）。

- **定性**：非 review finding，是本轮合法改动的**预期连带副作用**（改了被台账追踪的源文件）。
- **哈希口径平台无关**（已核实 `third-party-reproducibility.mjs:52-54`）：UTF-8 读出 → CRLF 归一 LF → sha256，注释 :19 明说为 `core.autocrlf=true` 设计；主审本地重算 button.tsx = `bc651d3c...` 与工具报的实际值逐字节一致。
- **不在本轮手工回补**，理由：① 工具处置说明 + git 惯例（`92c73c02`/`b6dce5e2` 均为独立 release chore）要求台账回补走**发布流程的 CI Linux 规范重生成**；② button.tsx 是 vendored 组件，在 `inventory.json` 有**两处**哈希（inputs 映射 :1522 + 组件清单 :14452），手工改 1.3MB 机器生成文件易漏、且 `licenses.mjs notices` 全量重生成会重写含平台变体的 NOTICE 全文（工具明确警告勿在 Windows 跑）。
- **交发布流程**：release 分支上按既有台账回补流程（`licenses.mjs notices` + 采用 CI Linux 重生成产物）一次性刷新这 9 个哈希。主审已在提交信息标注此项待发布回补。

### review 文档订正（本轮发现 review 自身两处过期表述）

1. **cua 门控前提过期**（H 发现，主审第一手核实源码）：`architecture-governance.md` §5 与 `security.md` §6 的「默认构建 `cuaPluginEnabled=false` → fail-closed」已过期——`isACodeCuaInternalFeatureEnabled` 现默认 `return true`（CUA 已是 desktop-local 生产默认激活的已发布特性），真实 fail-closed 边界在 `shouldCreateDefaultCuaProductHelper` 的 Helper admission（仅 desktop-local && 内置插件 && 非远程 && 无注入 resolver 才建 Helper）+ 无 socketPath 时 `execute()`→unavailable。两处均加就地订正块（保留原文作审查基线），指向 H 订正的 `CONTRACT.md` 为权威。
2. **descriptor 计数口径**（J 发现）：`testing.md` 的「84 个 createServiceDescriptor 调用点」是含 interface 声明的 grep 口径，真实运行时注册频道是 **40 个**（`REGISTERED_DESCRIPTOR_CHANNELS` 快照）；J 已把门禁从 `>=40` 下限改为频道名集合精确 deepEqual。就地订正。

### 提交

见下节 SHA。提交按逻辑分组（安全修复 / 各包 P2 / CI 门禁 / 结构重构 / 测试补齐 / review 文档），遵循 `docs/git-collaboration.md` Conventional Commits + Co-Authored-By 署名。

_（test 完整计数与提交 SHA 待后台任务 bjs7lwirl 完成后补。）_
