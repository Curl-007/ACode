# ACode 完整项目审查（1.0.4）：整改验证、修复引入的缺陷与系统性主题

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`（= `origin/main` `1fb10d77` + 3 个未发布文档提交：README 重写、第二批归档、omp/jcode 两份 CLI 替换候选评估【待产品决策】；相对 origin/main ahead 3 / behind 0，工作树 clean）。方法：11 个只读审查子代理并发覆盖各层面 + 横切，主审并行实跑全部门禁，并**对全部 P2 与关键计数逐行亲验源码**（不采信代理转述与提交声称）。五项目级门禁 + 全量测试 + 台账复现工具全部 exit 0。**未运行真实模型、真实 SSH 服务、Electron GUI/smoke**（desktop main 进程自 `471fe69c` 后无表面变更，上轮修复后 smoke 已实跑全 PASS）。环境差异如实记录：本机 Node v25.8.2 / pnpm 9.10.0（`mise.toml` 钉 24.14.0，仓库惯例 pnpm 10.33.2）。

与上轮的核心差别：**整个 1.0.4 发布（PR #10，23 提交，193 文件 +11785/−1718）正是上轮 review 的整改批次**，故本轮首要任务是逐条核验整改是否在源码中站住，其次才是发现新问题。上一轮见 [project-review-2026-10-22.md](project-review-2026-10-22.md)（基线 `dev/1.0.3` @ `ebe9033b`），再上轮见 [project-review-2026-10-08.md](project-review-2026-10-08.md)。

**修复状态（同日）**：本轮问题索引已由 7 个并发修复代理按文件所有权落地，主审逐代理源码亲验 + 统一门禁实跑（typecheck/lint/architecture 双口径/knip 全 exit 0，全量测试零代码回归），逐项处置与真实测试结果见 [reviews/2026-10-26/fix-status.md](reviews/2026-10-26/fix-status.md)。4×P2 全部修复；里程碑债务按边界只刷新/登记，未假装完成。

## 整改核验总览：上轮 16 项 P1/P2 全部站住

上轮全部 finding（4×P1 + 12×P2）逐条对源码核验：**全部 HOLDS（已修且保持）**，其中 R1-01（原型注入）、R1-02（巨型组件）、R2-11（bootstrap app 层）为诚实登记的「有界切片 + 里程碑债」，未假装完成。逐项 file:line 证据在各专项文档的回归核对表内。硬指标：

| 指标 | 上轮（1.0.3） | 本轮（1.0.4） | 方向 |
|---|---|---|---|
| typecheck / lint / knip:gate | 0 / 0 errors / 0 | 0 / 0 errors（165 warnings）/ 0 | 持平 |
| architecture legacy 超限（棘轮） | 414 | **412**（new 0 / regrown 0，全量与 --changed 双口径） | **收紧 −2** |
| 全量测试 | 3052/3012/3 fail/37 skip | 3052/3009/**5 fail**/38 skip——5 个全为环境依赖（需活 MCP 子进程的 plugin-state 家族），**零代码回归** | 持平 |
| 第三方台账 | 9 哈希待发布回补 | `licenses.mjs reproducibility --inputs-only` **2902/2902 全符 exit 0**（主审亲跑） | **闭合** |
| CI 平台矩阵 | ubuntu-only（R1-03） | windows-verify 在 ci.yml:132-174 + desktop-smoke 发布阻断在 release.yml:96-127,770-775；**`afdd7c79` 证明 windows leg 真跑过**（首跑抓到 2 个从未在 Windows 执行过的 services 测试的 8.3 短名脆弱性） | **落地且实证** |
| SessionPane | 3629→3762（不降反增） | **3672（−90，方向反转）**，修复后无再增长 | **反转** |
| 高风险盲区测试 | abort=0、hydrate=0 | 5 文件/37 测全真负向（主审抽读核验） | **补齐** |

**本轮无 P1 发现**——三轮全面 review 以来首次（2026-10-08：8×P1；2026-10-22：4×P1；本轮：0）。

首跑另有 6 个 fail 被主审逐一根因排除：5 个 `workflow-*` 是缺 gitignored codegen 产物 `libs.generated.js`（生成后 workflow-holes 28/28 绿）；1 个 L01 台账是主审本机 pnpm 9.10.0 重写 lockfile `patch_hash` 格式（还原后 9/9 绿）。两者均非代码缺陷。

## 项目规模

pnpm monorepo，Electron 桌面 + Web + CLI Agent + 远程服务器。约 60 万行 TS。Node 24.14.0 / pnpm 10.33.2（以 `mise.toml` 为准）。

| 范围 | 文件数 | 行数 | vs 1.0.3 |
|---|---:|---:|---|
| packages/ui | 1575 | 335,961 | +59 |
| apps/acode-cli/packages/core | 834 | 161,310 | +301 |
| packages/services | 365 | 108,825 | +65 |
| apps/acode-cli/packages/adapters | 297 | 70,113 | +15 |
| packages/desktop | 262 | 65,703 | +131 |
| apps/acode-cli/packages/bootstrap | 203 | 58,699 | +96 |
| packages/shared | 286 | 51,412 | +34 |
| apps/acode-cli/packages/contracts | 152 | 26,183 | ±0 |
| apps/acode-cli/packages/dynamic-workflow | 104 | 21,773 | ±0 |
| packages/server | 65 | 14,977 | +96 |

（口径与上轮一致：包 `src/` 下 TS/TSX 物理行。整改批次伴随的新代码涌入极小——修复为主，非边修边涨。）

## 阅读入口

| 文档 | 内容 | 健康度 |
|---|---|---|
| 本文 | 整改核验总览、新问题索引、系统性主题、整改顺序 | — |
| [reviews/2026-10-26/security.md](reviews/2026-10-26/security.md) | 横切安全：R2-01/DPAPI 修复核验、危险模式扫描增量、**第三份 cmd/start 出货副本** | 良 |
| [reviews/2026-10-26/shared-protocol.md](reviews/2026-10-26/shared-protocol.md) | 协议/共享类型：R2-02 冻结修复核验、**v4→legacy-types 守护边界缺口（P2）**、退役里程碑全停滞 | 良 |
| [reviews/2026-10-26/services.md](reviews/2026-10-26/services.md) | services：OAuth 漏斗/identity key 收敛核验、**traceId 槽位脱敏旁路（P2 升级）** | 良 |
| [reviews/2026-10-26/desktop.md](reviews/2026-10-26/desktop.md) | desktop：mirror 泄漏/sandbox/分桶修复核验、新 P3（workspace 桶回收顺序）、两链路语义 | **优** |
| [reviews/2026-10-26/ui-components.md](reviews/2026-10-26/ui-components.md) | UI 组件：SessionPane −90、Button 全局焦点态（233 消费方）、115 上帝文件持平的动能分析 | 良 |
| [reviews/2026-10-26/ui-state.md](reviews/2026-10-26/ui-state.md) | UI 状态：R2-06/07 收口核验、守护测试真负向、pin 回滚 total 漂移（既有 P3） | **优** |
| [reviews/2026-10-26/cli-runtime.md](reviews/2026-10-26/cli-runtime.md) | CLI 运行时：sink 会话化/resume/7 字段迁移核验、**CliGovernor 跨 App 单例（P3→条件 P2）**、交付 profile 分离 | 良 |
| [reviews/2026-10-26/cli-core-structure.md](reviews/2026-10-26/cli-core-structure.md) | CLI core 结构：R1-01 切片计分板（7 收敛/33 剩余）、product-projection 批次 1、app 层冻结 | 良 |
| [reviews/2026-10-26/server-web-provider.md](reviews/2026-10-26/server-web-provider.md) | server/web/provider：全部上轮 finding 核验、**新重连模块 2 个 P2（bfcache 死界面 + retryNow 孤儿 socket）** | 良 |
| [reviews/2026-10-26/architecture-governance.md](reviews/2026-10-26/architecture-governance.md) | 架构治理/CI/发布：windows-verify 实证、resolver 三缺口、zip 打包零新表面、台账 2902/2902 | **优** |
| [reviews/2026-10-26/testing.md](reviews/2026-10-26/testing.md) | 测试体系：37 盲区测真负向核验、守护有效性判读、PS-13/14 未真硬化、client 仍零测试 | 良 |

## 问题索引（本轮新发现）

### P2（4 项，主审全部逐行亲验）

| 编号 | 问题 | 位置 | 专项 |
|---|---|---|---|
| 26R2-01 | **bfcache `pagehide` 终态 cancel 永久禁用重连**：`pagehide` 在 bfcache 进入（手机主导后台机制）时也触发，`cancel()` 终态化后 `start()` 永久 no-op，无 `pageshow` 重武装——手机切后台回来 + socket 被回收 = R2-05 死界面症状在**修复自身**里对主用例复发 | `packages/web/src/main.tsx:263` + `reconnect/webSocketReconnect.ts:160,166-170` | [server-web-provider](reviews/2026-10-26/server-web-provider.md) |
| 26R2-02 | **`retryNow()` 在 connect 进行中触发孤儿活 socket**：overlay 在 connecting 阶段可点重试；换代后旧 connect resolve 命中 `if (cancelled) return` 丢弃活 `WebServices`（accessor 无 dispose/close，必然泄漏 WS+ChannelClient）；孤儿 socket 的 `onClose` 闭包引用同一可变 `let controller`，关闭时驱动**当前健康** controller → 工作会话上假性断线 overlay + 再开 socket | `main.tsx:223,227,253-257` + `webSocketReconnect.ts:141-143` | [server-web-provider](reviews/2026-10-26/server-web-provider.md) |
| 26R2-03 | **v4→legacy 反向依赖的守护边界缺口**：架构检查器谓词用尾斜杠目录前缀 `acode-protocol/`，漏掉同级文件 `acode-protocol-legacy-types.ts`；4 个 v4 文件直接 import 它且 fixture 从不演练此路径——上轮「双层守护/无回归」认证实质不完整。减轻：该文件是自述「幸存面」（M4 不删），活体断线风险低，但新增 v4→legacy-types 依赖不会被门禁拦截 | `scripts/architecture/index.mjs:42-49` + `packages/shared/src/acode-protocol-v4/{snapshot,transport,telemetry,script-workflow-management}.ts` | [shared-protocol](reviews/2026-10-26/shared-protocol.md) |
| 26R2-04 | **traceId 槽位是脱敏漏斗旁路**（上轮记 P3「前缀污染」，本轮升级 P2）：`serviceLogger.ts:61` 只对 `...args` 过 `redactServiceLogArg`，内插 traceId 的前缀**原样进 sink**；31 处字面量首参误用（上轮估 ~25，低计），**7 处在 `oauthService.ts`**——R2-03 刚收进漏斗的凭据面文件。当前无活体泄漏（31 处全为静态字面量/非秘密 ID），但「单一脱敏点」保证不覆盖该槽，`TraceId=string` 使误用类型不可见 | `packages/services/src/logger/serviceLogger.ts:48,61` + 8 文件 31 处 | [services](reviews/2026-10-26/services.md) |

### P3（选摘，全量见各专项）

| 问题 | 位置 | 专项 |
|---|---|---|
| **`cmd /c start "" <url>` 第三份出货副本**在「扫描归零」宣称下幸存（`build-acode.mjs:207` 复制进发行包为 `bin/acode.mjs`）；不可远程利用（url 全由本地 CLI 参数构造）但违反新立 auth-browser-opener 不变量——上轮头号流程批评「修一处漏其余」**复发** | `scripts/acode-distribution/runner.mjs:153-154` | [security](reviews/2026-10-26/security.md) |
| **CliGovernor 进程级单例**持首个 App 的 registry/logger，无 per-App 重置（仅有 test-only reset）：多 App 同进程 + 内存压力下可暂停 App#2 真在运行的会话（跨 App 驱逐守护失效）。既有非本轮回归；可恢复（暂停非杀死）。**前置矛盾**：`gen-ui-visualize.md:70` 记载多 App 为真 vs `subagent-policy-floor-inheritance.md:147` 断言不存在——两份 spec 需先裁决，若多 App 确认则升 P2 | `core/src/fleet/governor.ts:44-46,89-96` | [cli-runtime](reviews/2026-10-26/cli-runtime.md) |
| pin 回滚 `{pinned:false}→{pinned:false}` 非逆变 → query-cache `total` 漂移至下次服务端覆盖（可见行正确、刷新自愈）；既有非回归；**组合测试未复制真实回滚路径**、从不断言 total，给出假信心 | `ui/src/WorkspaceTimelineTasksSection.tsx:418-419` | [ui-state](reviews/2026-10-26/ui-state.md) |
| legacy 冻结守护仅提取 `export const …Schema`，不覆盖成文的「不得新增导出」（14 非 schema const + 189 type/function 无守护）；当前无活体违规 | `packages/shared/test/legacy-protocol-barrel-freeze.test.ts:24-25` | [shared-protocol](reviews/2026-10-26/shared-protocol.md) |
| relay_bridge 全仓仍死；desktop 注释/spec 宣称「权威在 acode-server-cli」但 server-cli **零命中**——注释指向不存在的真源 | `shared/src/task-realtime{,-core}.ts` + `desktop/src/main/taskRealtimeBus.ts:15` | [shared-protocol](reviews/2026-10-26/shared-protocol.md) |
| 架构基线含 **7 条陈旧条目**（419 条 JSON vs 工具口径 412；主审亲验全部 max-file-lines、0 测试文件）——保守方向不掩盖新违规，但棘轮减数虚高；`baseline:update` 可清 | `.architecture-baseline.json` | [architecture-governance](reviews/2026-10-26/architecture-governance.md) |
| 便携 zip 结构检查偏粗：断言「存在某 exe」非特指 `ACode.exe`；内层便携 exe 签名即便 `WIN_SIGNING=true` 也不校验（当前发布未签名，影响低） | `release.yml:687-701` | [architecture-governance](reviews/2026-10-26/architecture-governance.md) |
| client 包仍零测试（1.0.4 给 web/formal-proof/model-option-map 补了脚本却跳过它）；remote/传输面无覆盖 | `packages/client/package.json` | [testing](reviews/2026-10-26/testing.md) |
| PS-13/14 powershell 8.3 类**实际未硬化**：`afdd7c79` 修的是另两个 services 测试，提交信息夸大范围；CI 不可见（windows-verify 不跑 apps/acode-cli/tests） | `apps/acode-cli/tests/powershell-tool.test.mjs:33` | [testing](reviews/2026-10-26/testing.md) |
| C1 墙钟 flake 未修（固定 `setTimeout(25)`+负向断言）；`auto-resume-config-chain.test.mjs:112,140` 残留 mkdtemp 无清理（全仓唯一漏网，既有） | 见左 | [testing](reviews/2026-10-26/testing.md) |
| spec 膨胀计数：「约 46 个扁平字段」实为 28（3 簇）/33（含 TurnState 剩余） | `apps/acode-cli/specs/runtime-state-ownership.md:265` | [cli-core-structure](reviews/2026-10-26/cli-core-structure.md) |
| 超 400 行 tsx **115 → 115 持平**（修剪未使任何文件跌破阈值）；棘轮对「已超 400 后继续增长」失明（AutomationEditView 2942→2950 门禁恒绿） | `packages/ui/src` | [ui-components](reviews/2026-10-26/ui-components.md) |
| desktop 单 lease 释放路径 workspace 去重桶回收顺序缺陷（helper 先于 `leases.delete` 调用，`stillUsed` 恒 true）；有界良性、256 桶 LRU 兜底，但违背 spec 明文意图 | `desktop/src/main/taskRealtimeBus.ts:421-422,1180-1195` | [desktop](reviews/2026-10-26/desktop.md) |
| 上轮枢纽文档坏链：`../project-review-2026-10-08.md` 多爬一级（应为同目录相对路径），归档批「同步全部入链」未捕获既有坏链——**本轮已顺手修正路径** | `docs/project-review-2026-10-22.md:7` | 主审 |

## 总体结论

### 1. 整改闭环成立——这是三轮 review 的最高成就

上轮 16 项 P1/P2 **全部**在源码中站住（14 项完整修复 + 2 项诚实切片），四项门禁 + 全量测试 + 台账复现全绿，棘轮净收紧（414→412、regrown 0），台账 9 哈希缺口经发布流程闭合（2902/2902），windows-verify 不是纸面 YAML 而是**被首跑实证**（afdd7c79 抓到 2 个从未在 Windows 跑过的测试）。「review → 并发修复 → 发布 → 再 review 核验」的循环在这个仓库真实运转，且修复质量高：主审对 6 个头号指标（SessionPane 3672、commandOrchestration 220 行、product-projection 5680、explorer.exe、services 裸 console 0、超限 115）独立复测，与代理报告逐一相符。

### 2. 本轮最重要的新信号：4 个 P2 里 2 个是「修复引入的缺陷」

26R2-01/02 都在 1.0.4 全新的 web 重连模块内——R2-05 修复本身。主路径（前台断线重连）正确且测试扎实（假 timer 全状态机、full jitter、溢出安全），但**生命周期边界**（bfcache 往返、controller 换代竞态）不在测试矩阵内，而 bfcache 恰是手机浏览器的主导后台机制、AGENTS.md 明记手机是本链路首要目标。模式教训：**整改催生的新子系统，需要与仓库其他部分同等强度的生命周期边界测试**——本仓对 owner/lease、幂等、清理闭环一贯要求严格，新模块出生时应继承同一标准，而不是只测主路径。

### 3. 另 2 个 P2 是「守护/认证边界窄于成文规则」

26R2-03：检查器谓词的尾斜杠使守护漏掉同级文件——上轮「双层守护」认证只演练了 v4→barrel，未演练 v4→legacy-types。26R2-04：脱敏漏斗的「单一脱敏点」保证不覆盖 traceId 槽，31 处误用类型不可见。同构教训：**守护的实际边界 = 谓词的路径代数 + 测试演练的路径集合**，二者都比成文规则窄时，认证给出假信心。修法一致：谓词补齐 + fixture 演练缺口路径 + 把「一个语义一份实现」推进到类型层（branded `TraceId`）。

### 4. legacy 协议退役仍是唯一的大型结构债，且时钟在走

收敛计划文档自 **2026-10-09 未更新**；M1 消费面未降反增（projection 消费文件 grep 18 处，方向与上轮「10→12」一致）；M2 仍 6 个 legacy 消费文件；M3 bootstrap legacy server 仍 **48 文件**；M4 barrel 仍 **3652 行**。上轮点名的 `onboard-b3-session-over-limit` 等例外 **2026-12-31 到期即门禁转红**——距今约 9 周，shared 层还无本地绊线。冻结纪律本身站住（246 基线精确、无新违规），但冻结 ≠ 退役。这是下一周期唯一需要里程碑级投入的事项。

### 5. 流程主题：「修一处、漏其余」复发，提交信息夸大范围

R2-01 在 1.0.3 就是「同模式第二副本漏修」；本轮其修复的扫描宣称又漏了**第三份出货副本**（runner.mjs:154）；afdd7c79 提交信息暗示 PS-13/14 类已处理（实际修的是另一对）。两个同根：**一次性人工 grep 扫描不构成模式类防护**。建议把模式类不变量机械化为守护测试（如全仓断言 `spawn("cmd"` 不与 `"start"` 共现），让第四份副本在 CI 就红，而不是等下一轮 review。

### 6. 层面健康度速览（vs 上轮）

| 层面 | 健康度 | Δ | 一句话 |
|---|---|---|---|
| desktop 进程边界 | **优** | = | 4 项修复全 HOLDS，mirror 泄漏真闭合；仅 1 个有界 P3 |
| UI 状态 | **优** | ↑（良→优） | R2-06/07 收口经独立核验成立，所有权守护真负向 |
| 架构治理/CI/发布 | **优** | ↑（良→优） | 两个 P1 CI 缺口落地且被首跑实证；台账 2902/2902；zip 零新表面 |
| 协议/共享类型 | **良** | ↓（优→良） | R2-02 真修 + 精确守护；但守护边界缺口（26R2-03）+ 退役全停滞 |
| server/web/provider | **良** | ↓（优→良） | 上轮 finding 全修；新重连模块带 2 个生命周期 P2 出货 |
| services | **良** | = | 两大修复站住；traceId 旁路升级 P2（26R2-04） |
| 安全 | **良** | = | 无远程无交互利用面；cmd/start 第三副本是流程复发信号 |
| CLI 运行时 | **良** | = | 全部修复站住；CliGovernor 既有单例待多 App 前提裁决 |
| CLI core 结构 | **良** | = | R1-01 切片真实且门禁扎实；根因（原型注入面）按设计仍在 |
| UI 组件 | **良** | = | SessionPane 方向反转；115 上帝文件持平，拆分未反超增长 |
| 测试体系 | **良** | ↑（中→良） | 盲区补齐且真负向；CI 矩阵落地；残留全为 P3 环境/既有类 |

### 7. 建议整改顺序

1. **立即（<1 天）**：26R2-01/02 web 重连生命周期——`pagehide` 检查 `event.persisted` + `pageshow` 重武装；`retryNow` 在 connecting 态禁用或代际 token 守卫 + accessor 补 `dispose`；spec `web-reconnect.md` 补 bfcache/换代两条验收场景 + 假 timer 测试。26R2-03 谓词扩展至 legacy-types 文件 + fixture 补 v4→legacy-types 用例。
2. **本周期（1-2 天）**：26R2-04 traceId 批量清扫（31 处 codemod）+ branded `TraceId` 类型（根治，误用不可编译）或漏斗对 traceId 也脱敏（一行兜底）；runner.mjs 换 `explorer.exe` + 全仓 cmd/start 组合守护测试；裁决多 App 前提的两份 spec 矛盾 → 决定 CliGovernor 是否 per-App 化；PS-13/14 `normalizeWin` 补 realpath 归一。
3. **里程碑（2026-12-31 前，硬 deadline）**：legacy M2/M3/M4 + session publicEntrypoints 迁移；刷新收敛计划文档（进度表停在 10-09）；shared 层加本地到期绊线。
4. **卫生（随手）**：`architecture:baseline:update` 清 7 条陈旧基线；C1 墙钟 flake 改事件驱动；auto-resume-config-chain 补 mkdtemp 清理；client 包补首个测试；spec §265 计数订正；zip 结构检查特指 `ACode.exe`；relay_bridge 的 desktop 注释订正（server-cli 无此权威）。
