# ACode 完整项目审查（1.0.3）：架构、协议、运行时、UI、安全与质量

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`（相对 `origin/main` ahead 0 / behind 0，工作树 clean）。方法：11 个只读审查子智能体并发覆盖各层面 + 横切，主审并行采集门禁与结构证据；四项目级门禁（typecheck/lint/architecture:check/knip:gate）实跑 exit 0。**未运行真实模型、真实 SSH 服务、Electron GUI、手机远控或多操作系统矩阵**；区分已确认缺陷、源码确认缺口与需设计确认的风险。11 份专项已全部回收，问题索引与总体结论见下。

**修复状态（同日）**：本轮 review 的问题索引已由 14 个并发修复代理按层面落地，逐项处置、门禁实跑结果与提交 SHA 见 [reviews/2026-10-22/fix-status.md](reviews/2026-10-22/fix-status.md)。4 条 P1（CI win32 矩阵、smoke 进 release、SessionPane 拆分、原型注入 owner 收敛）与 8 条 P2 已修或做有界切片；里程碑债务（legacy M2/M3/M4、115 组件全拆、bootstrap W2）按边界只做切片 + spec 登记，未假装完成。修复后统一验证：typecheck/lint/architecture(--changed)/knip:gate 全 exit 0；third-party ledger 9 个哈希不符是本轮合法改动连带，按惯例留发布流程回补。

上一轮全面 review 见 [project-review-2026-10-08.md](project-review-2026-10-08.md)（基线 `dev/0.0.7`，21 项问题 8×P1/13×P2，附 [reviews/2026-10-08/](reviews/2026-10-08/) 专项与修复记录）。本轮重点：**核对历史修复在 1.0.3 是否回归、发现新问题、评估当前健康度**。

## 项目规模

pnpm monorepo，Electron 桌面 + Web + CLI Agent + 远程服务器。约 60 万行 TS（14 个 `packages/*` + `apps/acode-cli` 嵌套 workspace）。Node 24.14.0 / pnpm 10.33.2（以 `mise.toml` 为准）。

| 范围 | 文件数 | 行数 |
|---|---:|---:|
| packages/ui | 1574 | 335,902 |
| apps/acode-cli/packages/core | — | 161,009 |
| packages/services | 365 | 108,760 |
| apps/acode-cli/packages/adapters | — | 70,098 |
| packages/desktop | 262 | 65,572 |
| apps/acode-cli/packages/bootstrap | — | 58,603 |
| packages/shared | 286 | 51,378 |
| apps/acode-cli/packages/contracts | — | 26,183 |
| apps/acode-cli/packages/dynamic-workflow | — | 21,773 |
| packages/server | 65 | 14,881 |

（口径：包 `src/` 下 TS/TSX 物理行，含空行与注释，非净代码行。CLI 另有 40+ 嵌套包/plugin。）

## 阅读入口

| 文档 | 内容 | 状态 |
|---|---|---|
| 本文 | 全局结论、问题索引、跨层面主题、整改顺序 | 进行中 |
| [reviews/2026-10-22/ui-components.md](reviews/2026-10-22/ui-components.md) | UI 组件/渲染层：巨型组件债、DESIGN.md 遵从、i18n、响应式、可访问性 | ✅ |
| [reviews/2026-10-22/ui-state.md](reviews/2026-10-22/ui-state.md) | UI 状态层：Zustand store、hooks 服务访问、平台边界、广播回环、状态归属 | ✅ |
| [reviews/2026-10-22/services.md](reviews/2026-10-22/services.md) | services：会话库、owner/lease、task index、storage、workflow owner、identity | ✅ |
| [reviews/2026-10-22/desktop.md](reviews/2026-10-22/desktop.md) | desktop：Main/Host/Renderer 进程边界、IPC 安全、stdio、两条交付链路 | ✅ |
| [reviews/2026-10-22/protocol.md](reviews/2026-10-22/protocol.md) | 协议/RPC：v4 vs legacy 退役、descriptor 校验、delivery profile、identity 贯穿 | ✅ |
| [reviews/2026-10-22/cli-runtime.md](reviews/2026-10-22/cli-runtime.md) | CLI 运行时：CommandInbox、生命周期、两套 workflow 执行链路、历史回归 | ✅ |
| [reviews/2026-10-22/cli-core-structure.md](reviews/2026-10-22/cli-core-structure.md) | CLI core 内部：状态所有权、原型注入、bootstrap 边界、module-global 状态 | ✅ |
| [reviews/2026-10-22/server-web-provider.md](reviews/2026-10-22/server-web-provider.md) | server/web/provider/model-option-map：依赖分离、鉴权、求值正确性 | ✅ |
| [reviews/2026-10-22/architecture-governance.md](reviews/2026-10-22/architecture-governance.md) | 架构治理：纳管现状、ratchet、knip、门禁/CI、小包边界、门禁实跑 | ✅ |
| [reviews/2026-10-22/security.md](reviews/2026-10-22/security.md) | 横切安全：凭据链、鉴权配对、SSH、路径边界、注入、IPC、fail-closed | ✅ |
| [reviews/2026-10-22/testing.md](reviews/2026-10-22/testing.md) | 测试质量：入口、覆盖、实现一致性、守护测试有效性、flake、E2E 缺口 | ✅ |

## 问题索引

P1=执行/安全/数据正确性或门禁失效；P2=明确缺陷、规则违反或有实际维护成本的边界问题；P3=改进建议。历史编号（ARCH-*/CLI-*/DWF-*/SWF-*）的逐条回归核对在各专项文档内；**2026-10-08 的 21 项问题在 1.0.3 全部无回归**（详见各专项「历史问题回归核对」节），下表为本轮新确认问题。

### P1（4 项）

| 编号 | 问题 | 位置 | 专项 |
|---|---|---|---|
| R1-01 | 原型注入 + `this: AgentRuntimeInternal` 使 owner 只读约束可被绕过：约 180 个方法可读写全部约 50 个未收敛扁平可变字段 | `core/runtime/methods/index.ts:203-398`、`agent-runtime.ts:787` | [cli-core-structure](reviews/2026-10-22/cli-core-structure.md) |
| R1-02 | 巨型组件系统性超限：115 个 tsx 破 400 行闸，SessionPane 3629→3762 行不降反增，拆分计划仅推进 1/5 接缝 | `packages/ui/src/v4/SessionPane.tsx` 等 | [ui-components](reviews/2026-10-22/ui-components.md) |
| R1-03 | CI 仅 ubuntu 无矩阵：win32 专有 bug（路径大小写、8.3 短名）在门禁恒绿，近期至少 3 个修复的回归无法被 CI 拦截 | `.github/workflows/ci.yml:28` | [testing](reviews/2026-10-22/testing.md) |
| R1-04 | Electron `e2e:smoke`（进程树/首窗/清理闭环）不进任何 CI workflow，启动链路无自动回归 | `packages/desktop/scripts/e2e-smoke.mjs` | [testing](reviews/2026-10-22/testing.md) |

### P2（12 项）

| 编号 | 问题 | 位置 | 专项 |
|---|---|---|---|
| R2-01 | **Windows OAuth `cmd.exe /c start` 命令注入**：同仓已修模式（H1，platform-open-port.ts）的漏修第二副本，恶意/被入侵 OAuth 端点可在 CLI 用户上下文执行任意命令 | `apps/acode-cli/packages/adapters/src/auth/browser.ts:50` | [security](reviews/2026-10-22/security.md) |
| R2-02 | legacy 冻结面被违规新增 schema 导出（`acodeMcpReconnectSuspensionSchema`，冻结日后 +2 export），违反「只删不增」退役规则 | `packages/shared/src/acode-protocol/index.ts:659-667` | [protocol](reviews/2026-10-22/protocol.md) |
| R2-03 | OAuth/凭据面日志绕过统一脱敏漏斗：裸 `console.log` helper 不经 `redactServiceLogArg`，token/code 可落 stdout | `services/src/oauth/oauthService.ts:45`、`zaiProviderAdapter.ts:61` | [services](reviews/2026-10-22/services.md) |
| R2-04 | connect-remote 500 把原始 `err.message`（可含主机名/路径/命令）回给调用方 | `packages/server/src/http.ts:546-549` | [server-web-provider](reviews/2026-10-22/server-web-provider.md) |
| R2-05 | Web 端 WS 断开是空 `onClose`：手机 `web-remote-replayable` 恢复语义在 services 侧齐备，但前端不重连不提示，断线即死界面 | `packages/web/src/main.tsx:350-352` | [server-web-provider](reviews/2026-10-22/server-web-provider.md) |
| R2-06 | task meta 四副本 + 40 处组件直调 `applyTaskQueryCacheMutation` 绕过 `taskListMetaSync` 收口，单次操作 3-4 条独立写入，乐观失败回滚路径有 drift 风险 | `ui/src/store/taskQueryCacheStore.ts:1088` 等 | [ui-state](reviews/2026-10-22/ui-state.md) |
| R2-07 | `useTheme()` 死代码保留绕过广播防回环的 theme 双写旁路（直写 localStorage），两处 main.tsx 注释误导 | `packages/ui/src/useTheme.ts:90-117` | [ui-state](reviews/2026-10-22/ui-state.md) |
| R2-08 | settings 按钮簇绕过设计系统（裸 button + `bg-white`/`text-black`）且 `focus-visible:ring-0` 移除焦点环无替代态 | `ui/src/settings/AutomationEditView.tsx:1979` 等 5 文件 | [ui-components](reviews/2026-10-22/ui-components.md) |
| R2-09 | acode-cua「全表面 fail-closed」表述与实现不符：broker.js 客户端 wire 面是功能完整实现，生产关闭实际靠上游插件门控 + dev env 旋钮可激活 | `packages/acode-cua/broker.js:175-217`、`index.js:61-127` | [architecture-governance](reviews/2026-10-22/architecture-governance.md) |
| R2-10 | formal-proof 是 managed 模块却零测试（18 纳管模块中唯一），920 行证明模型不进 `pnpm test`/CI | `packages/formal-proof/package.json` | [architecture-governance](reviews/2026-10-22/architecture-governance.md) |
| R2-11 | bootstrap `src/app/` 仍是 57 文件/13,590 行 application service 层（W1-R3 只迁走 workflow 块），且较 fix-status 宣称的 11,799 行再生长 | `apps/acode-cli/packages/bootstrap/src/app/` | [cli-core-structure](reviews/2026-10-22/cli-core-structure.md)、[cli-runtime](reviews/2026-10-22/cli-runtime.md) |
| R2-12 | 门禁与覆盖缺口：`rpc-descriptor-surface` 计数用 `>=40` 下限（实际 84，删半仍绿）；speed 两档修复（8122e200）无配套测试；provider-node 21 源 1 测 | `services/tests/rpc-descriptor-surface.test.mjs:88` 等 | [testing](reviews/2026-10-22/testing.md) |

### P3（选摘，全量见各专项）

| 问题 | 位置 | 专项 |
|---|---|---|
| CLI-04 同类残余：MCP 写审计 sink 与 worktree fence warn sink 仍是进程级单例（多 App 串线风险） | `bootstrap/src/app/create-app.ts:294,1585` | [cli-runtime](reviews/2026-10-22/cli-runtime.md) |
| Windows DPAPI 钥匙串读取：blob 未校验 base64 即插值进 PowerShell `-Command`（同信任边界纵深防御） | `shared/src/node/credentialKeychain.ts:216` | [security](reviews/2026-10-22/security.md) |
| 身份 key `workspaceIdentity?.trim() \|\| workspacePath` 有 10+ 份手写内联副本（EI-2「一个语义一份实现」违例，语义当前一致） | services 多处 | [services](reviews/2026-10-22/services.md) |
| session publicEntrypoints 留空的迁移债未收敛：services→session 内部边 31→约 39 条**增长**，contract.ts 空转，例外 2026-12-31 到期 | `architecture-policy.yaml:88` | [services](reviews/2026-10-22/services.md) |
| legacy 5 模块文件数 3463→4242（+779），managed 覆盖率 ~17% 被摊薄；ui/web/desktop/services/acode-cli 纳管前置（resolver 通配/asset 缺口）未启动 | `architecture:check` 输出 | [architecture-governance](reviews/2026-10-22/architecture-governance.md) |
| 12 处 unlisted 依赖（zod、@modelcontextprotocol/sdk 等源码 import 但包未声明，靠 hoisting），不在 knip:gate `--include` 范围 | server/core/node-repl-host | [architecture-governance](reviews/2026-10-22/architecture-governance.md) |
| Main 侧 taskRealtimeBus replay mirror 是最大有状态面（有界、不落盘、基本合规，需 spec 钉死非权威语义）；`relay_bridge` 是未接线死枚举 | `desktop/src/main/taskRealtimeBus.ts` | [desktop](reviews/2026-10-22/desktop.md) |
| 主特权窗未显式声明 `sandbox:true`（依赖 Electron 默认值） | `desktop/src/main/desktopWindowChrome.ts:591-602` | [desktop](reviews/2026-10-22/desktop.md) |
| legacy enum 值域冻结面内扩张（offPeak permission mode 追加 `dontAsk`，灰区） | `shared/src/acode-protocol/index.ts` | [protocol](reviews/2026-10-22/protocol.md) |
| 静态路由 `decodeURIComponent` 可抛 URIError 成 500；待认领连接无 TTL（自登记债） | `server/src/http.ts:307,168` | [server-web-provider](reviews/2026-10-22/server-web-provider.md) |
| 业务 UI 硬编码字号 13 处 `text-[Npx]`（DESIGN.md 最高优先级约束） | ui 多处 | [ui-components](reviews/2026-10-22/ui-components.md) |
| model-option-map / client / web / formal-proof 无包内测试脚本 | 各包 package.json | [testing](reviews/2026-10-22/testing.md) |
| 高风险覆盖盲区：abort=0、hydrate=0 个专门测试文件；两条交付链路（continuous vs replayable）缺对照测试 | 全仓 | [testing](reviews/2026-10-22/testing.md) |
| 部分测试临时目录无清理（`skillSyncArchiveTrust.test.ts` 等），CI 累积占盘 | apps/acode-cli/tests | [testing](reviews/2026-10-22/testing.md) |

## 总体结论

### 1. 历史修复全部站住了

2026-10-08 review 的 21 项问题（8×P1/13×P2）逐条核对：**ARCH-01..06、CLI-02/03/05/07、DWF-01..04、SWF-01..08 全部已修复且无回归**；CLI-04 主项已修（bash/auto sink 会话化），残余两个同类进程级 sink 降为 P3；CLI-06/W1-R3 拆包已实现且超出原范围（新增 workflow-run-command/read 两个受管包），但装配层再生长。M2 capability 最小切片健康，v4→legacy 反向依赖双层防护有效。四项目级门禁实跑 exit 0（typecheck 三阶段、lint 0 errors、architecture 412/412 new 0 regrown 0、knip:gate 干净），baseline 415→412 继续收紧。守护测试（architecture-coverage fixture、rpc-descriptor-surface 逐 descriptor 校验、task-index-writers 白名单、深导入自检）**是真负向测试，违规会红**。

### 2. 本轮唯一需要立即修的真实安全缺陷

**R2-01**：Windows CLI 登录的 OAuth authorize_url 经 `cmd.exe /c start` 可命令注入。这不是新漏洞模式——同仓库 2026-10-04 已就同一模式（finding H1）修复了 `platform-open-port.ts` 并留下注释警示，`browser.ts:50` 是漏修的第二份副本。修复方式是照抄已有正确实现（改 `explorer.exe`），约 10 分钟。它揭示的流程问题比漏洞本身更重要：**同一漏洞模式的修复没有全仓扫描同类副本**。

### 3. 三个系统性主题（比单点问题更值得投入）

**主题一：ratchet 机制吸收了单文件增长，巨型文件债在再生长。** 治理门禁锁的是「超限文件计数不增」，不锁单文件行数：SessionPane 3629→3762、product-projection 5432→6075、acodeAgentService 5662→5940、bootstrap/src/app 11,799→13,590，全部被 baseline 静默吸收。已登记的拆分计划（god-component-split-plan、W1 续批）推进速度落后于新代码堆积速度。若不把「已登记拆分计划的文件行数单调下降」纳入某种门禁或周期核对，1.0.x 周期结束时这批文件会更大。

**主题二：legacy 协议退役停摆，是最大的结构里程碑债。** 收敛计划停在 M2-B（2026-10-09），M2/M3/M4 均未推进：bootstrap legacy server 48 文件/14,713 行仍在，legacy barrel 3,654 行，W2（bootstrap 拆包）被 M3 阻塞，session publicEntrypoints 迁移债的内部边反而从 31 涨到约 39 条。且冻结规则已被打破一次（R2-02 违规新增 schema）。风险受控（legacy 只删不增的纪律大体成立、双源真相未发现）但复杂度不会自行消失；`onboard-b3-session-over-limit` 等例外 2026-12-31 到期，届时若未推进会直接门禁转红——这是本轮发现的**最硬的一个 deadline**。

**主题三：CI 平台与门禁覆盖缺口让 win32 回归恒绿。** 近期修复的 bug 中至少 3 个是 Windows 文件系统语义专有（路径大小写、8.3 短名、walk-up），但 CI 只有 ubuntu；Electron smoke 已建成却不进 CI；4 个包无 test 脚本；abort/hydrate 等高风险路径 0 个专门测试。测试体系本身可信（守护测试真红、flake 根修方向正确），缺口在**门禁边界**而非测试质量。给 ci.yml 加一个 windows-latest leg（跑 core/services/shared 三包）是单项收益最高的投入。

### 4. 层面健康度速览

| 层面 | 健康度 | 一句话 |
|---|---|---|
| 协议/RPC | **优** | 治理最扎实的一层；唯一确认的规则违反是 legacy 冻结面新增 schema（R2-02） |
| desktop 进程边界 | **优** | Main 不承载业务状态、无违规 Remote Host、IPC 面干净、清理闭环完整；未发现 P1 |
| server/provider/model-option-map | **优** | provider 0 处 node: 导入、fail-closed 全链、鉴权系统性加固；缺口在错误泄漏与 Web 重连 |
| services | **良** | owner/lease/幂等/守护门禁全部健在且更严；纪律松动在凭据日志与 identity key 重复实现 |
| CLI 运行时 | **良** | 历史修复全部站住；结构债（原型注入、装配层）再生长 |
| 安全 | **良** | 历史加固无回归、无远程无交互利用面；1 个 P2 注入副本 + 1 个 P3 纵深缺口 |
| 架构治理/门禁 | **良** | 四门禁实跑全绿、ratchet 兑现；legacy +779 文件摊薄覆盖率 |
| UI 组件 | **中** | i18n/虚拟化/内存治理优秀；115 个超限组件 + 拆分停滞是最大债 |
| UI 状态 | **良** | 平台边界/日志纪律最干净；task meta 四副本收口缺口需处理 |
| 测试体系 | **中** | 守护测试真红、核心覆盖扎实；CI 平台矩阵与门禁边界是结构性缺口 |

### 5. 建议整改顺序

1. **立即（<1 小时）**：R2-01 browser.ts 命令注入（照抄 platform-open-port.ts 修复）+ 全仓扫描 `cmd.exe.*start` 同类副本；R2-03 OAuth 日志脱敏（换 `createServiceLogger`）；R2-04 connect-remote 错误归类。
2. **本周期（1-2 天）**：R1-03 CI 加 windows-latest leg（core/services/shared）；R2-02 legacy 新增 schema 迁入中立叶子；R2-05 Web WS 重连；R2-12 补 speed 修复的测试 + descriptor 门禁改精确计数。
3. **下周期（按里程碑）**：R1-01 RuntimeTurnState 字段迁 owner（第一个切片 `turnNumber`）；R1-02 SessionPane 命令组先补测试再拆；R2-06 task meta 写入收口进 taskListMetaSync；R2-11 bootstrap 按 bounded context 续抽包。
4. **里程碑债务（2026-12-31 前必须推进）**：legacy M2/M3 与 session publicEntrypoints 迁移——over-limit 例外到期即门禁红；R1-04 smoke 进 release 门禁随 M3 后的发布流程一并处理。
