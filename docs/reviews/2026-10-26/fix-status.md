# 2026-10-26 项目审查修复与验证

本页对应 [完整审查](../../project-review-2026-10-26.md) 及其 [11 份专项](./)。修复按 spec → 行为测试 → 实现 → 门禁推进，7 个修复代理按**文件所有权互斥**并发执行，主审对每个代理的产出**逐行亲验源码 + 独立复跑其测试**（不采信自报），最后统一实跑全部门禁与真实测试。

> 状态：**修复完成，验证完毕**。7/7 代理回收、主审逐代理亲验、五门禁 + 全量测试 + desktop e2e:smoke 真机全部实跑。各代理自报退出码均经主审独立复跑核对，以主审复跑为准。

环境：Windows 11 / Node v25.8.2 / pnpm 9.10.0（`mise.toml` 钉 24.14.0、仓库惯例 pnpm 10.33.2——与上轮修复同一环境偏差，如实记录）。分支 `fix/project-review-2026-10-26`（基于 review 文档提交 `2c291088` 之上）。

## 修复范围界定

按 review §7 整改顺序执行：**4×P2 全部、全部可立即修的 P3、全部卫生项**。里程碑债务（legacy M2/M3/M4 退役、115 组件全拆、bootstrap W2 抽包）按 review 自身边界只做**文档刷新 + 到期绊线登记**，不假装完成（与上轮 fix-status 同一纪律）。

## Finding → 代理分配表

| 代理 | 范围（文件所有权，互斥） | 负责 finding |
|---|---|---|
| W | `packages/web/**`、`packages/client/**` | 26R2-01（bfcache 死界面 P2）、26R2-02（retryNow 孤儿 socket P2）、client dispose 面 + client 首测（P3） |
| S | `packages/services/**` | 26R2-04（traceId 槽脱敏旁路 P2）：结构修复 + 误用清扫 + 守护测试 |
| A | `scripts/architecture/**`、`scripts/acode-distribution/**`、`release.yml`、2 个 docs/specs、cli 架构测试 | 26R2-03（v4→legacy-types 守护边界 P2）、runner.mjs 第三副本 + 全仓 cmd/start AST 守护（P3）、zip 结构检查（P3） |
| C | `core/**`、create-app.ts（仅 governor 接线）、3 个 cli specs | CliGovernor 多 App fail-safe floor（P3→按主审裁决 P2 级修）、spec 矛盾裁决落地、spec §265 计数订正 |
| U | `packages/ui/**` | pin 回滚逆变换 + total 断言（P3）、远端写守护拓宽（P3）、identity-key 耦合注释（P3）、split-plan 棘轮盲区登记 |
| D | `packages/desktop/**`、`packages/shared/**`、收敛计划文档 | workspace 桶回收顺序（P3）、relay_bridge 虚假权威订正（P3）、冻结守护扩至全导出面（P3）、里程碑进度刷新 |
| T | 3 个 cli 测试文件 | PS-13/14 8.3 短名归一（P3）、C1 墙钟 flake 确定化（P3）、auto-resume mkdtemp 泄漏（P3） |
| 主审 | `.architecture-baseline.json`、knip、台账、门禁、smoke、本文档、提交 | 基线陈旧 7 条清理、跨文件事项裁决、统一验证 |

## 主审对代理产出的独立核验（逐代理，不采信转述）

每个代理回收后，主审**读源码确认关键改动 + 用该包的口径独立复跑其测试**：

- **S（services）**：亲验 `serviceLogger.ts` 的 traceId 现经 `redactServiceLogArg` 后才内插前缀；独立 grep 残留误用 = 2 处，追查确认均为 `AgentSparePoolLogger`（message-first 接口，**正确形态**非误用），ServiceLogger 类误用归零；oauthService 7/7 已改。复跑 `@acode/services` 546 pass/0 fail。
- **D（desktop/shared）**：亲验 `releaseLease` 的 `leases.delete` 已移到 discard 之前；barrel `acode-protocol/index.ts` 逐字节未动（`git diff --stat` 0 行）；新导出基线 449 名含 `acodeProtocolMethods` 等非 Schema 导出。复跑 mirror 测试 **11/11**（须用包口径 `node --import tsx --test`，裸 `node --test` 假红）、freeze 守护 **5/5**。
- **U（ui）**：亲验两处 pin `.catch` 现为 `{pinned}→{pinned:false}` 逆变换 + total 算术根因注释；守护改引用扫描 + 只读白名单。复跑 composition+guard **9/9**。
- **A（architecture/release）**：亲验 `protocol-boundary.mjs` 含全部 6 个幸存 schema 白名单、旧尾斜杠谓词已移除并接线；runner.mjs 已换 explorer.exe；release.yml 断言 `ACode.exe` 专名（产品名经 `desktop-product-identity.mjs` 核实非臆测）。复跑 fixture **17/17** + 新 AST 守护 **3/3**；全量 checker **new 0/regrown 0**、`v4-imports-legacy-protocol` 全树 = 0（谓词扩展未误伤既有 4 条边）。
- **C（CliGovernor）**：亲验 `resolveFleetSessionRunState` 三态、`peekFleetLruIdleVictim` 仅选正向解析为 idle 者（unknown ≠ idle 在选择点强制）；create-app 注册于 configure 点、close 与 startup-failure 双路 release。复跑 cli-governor **15/15**；C 自证两个负向（拆 floor → 3 红；拆 union → 场景 14 红）。
- **W（web/client）**：亲验 pageLifecycle 按 `event.persisted` 分派（persisted→pause 非终态 / 真卸载→cancel 终态 / pageshow persisted→resume）；retryNow 在 connecting 阶段忽略 + overlay 按钮禁用；代际守卫使孤儿 onClose 不驱动当前 controller；client dispose 面 + 两处跨包 `new RemoteServiceAccess(client)` 1-arg 调用向后兼容（transport 参数可选）。复跑 web **33/33**、client **12/12**。
- **T（3 测试文件）**：复跑 powershell-tool **20/20**、script-workflow-sandbox **15/15**、auto-resume-config-chain **9/9**。

### 主审推翻的一个代理「critical finding」（实证）

T 报告称「afdd7c79 用非 native `realpath` 硬化两个 services 测试，实际不展开 8.3 短名，仍脆弱」并升级为跨文件项。主审**四变体实测**（在本机 8.3 启用卷上造真短名目录）：

| 变体 | 展开 8.3？ |
|---|---|
| `fs.realpathSync`（同步非 native） | **否**（T 测的是这个） |
| `fs.realpathSync.native`（同步 native） | 是 |
| `fsp.realpath`（**异步**非 native） | **是** |

afdd7c79 用的是 `node:fs/promises` 的**异步** `realpath`（亲验 `skillsBundledScopeAndCacheAuthority.test.ts:7,68`），异步 libuv 路径**会**展开短名——故那两个 services 文件**正确、无需改**。T 把同步 `realpathSync` 的行为错误泛化到异步 `realpath`。T 自己的修复（`normalizeWin` 用 `realpathSync.native`）不受影响、依然正确。**主审未据 T 的升级项改动任何 services 文件**（T 也守住了所有权未碰）——false alarm，零副作用。这正是「代理的 confident finding 也须实证」的价值：若采信，会对另一代理所有的两个文件做无谓改动。

## 跨文件事项裁决（主审）

| 来源 | 事项 | 裁决 | 状态 |
|---|---|---|---|
| S | `TraceId = string`（shared）是误用类型不可见的根因，建议 branded type | 结构修复已使槽位防泄漏，branded type 是纵深防御非阻塞——登记为**后续项**（需 shared 所有权 + 全仓构造点改造，超本轮范围） | 登记 |
| A | FIX 1 谓词扩展是否需要基线再生成 | 规则在真实树触发 0 次，无新违规入基线；基线陈旧 7 条清理是独立事项归主审 | 主审已做 |
| C | `FleetSessionRecord` 无 owning-app 身份，union 是保守正确；加身份可精确解析 + 按 App 清理 fleet 记录 | union 已 fail-safe 正确，加身份是增强非必需——登记后续 spec 工单 | 登记 |
| W | client `tests/*.test.ts` 新形态是否需 knip entry | 主审实跑 `knip:gate` **exit 0**（knip 自动识别 `*.test.ts` 为 entry，无需声明） | 已验证 |
| W | web typecheck 依赖 client 新声明（返回类型变更），根 `packages` 阶段先建 client 后建 web | 根 `pnpm typecheck` 三阶段**exit 0** 已证顺序正确 | 已验证 |
| T | afdd7c79 两个 services 文件「仍脆弱」 | **实证推翻**（见上节）：异步 realpath 会展开 8.3，无需改 | 关闭 |
| 主审 | `client/package.json` 台账哈希漂移（W 加 test 脚本） | 台账处置说明 + git 惯例要求走**发布流程 CI Linux 重生成**，不在 Windows 本机手工回补（同 1.0.4 的 9 哈希处理） | 交发布流程 |

## 主审统一验证（干净串行环境）

### 前置

- `pnpm install --prefer-offline` exit 0（会话早期已装）；CLI codegen 产物 `libs.generated` 已由 typecheck 阶段的 dynamic-workflow build 生成。
- core `dist/` 由 C 的 scoped typecheck 重建（gitignored 产物），bootstrap typecheck 无 stale dist 问题（上轮曾红）。

### 五门禁 + 全量测试实跑结果

| 检查 | 退出码 | 关键计数 |
|---|---|---|
| `pnpm typecheck`（三阶段） | **0** | packages 73.4s / desktop-renderer 4.2s / cli 66.1s（32/32 tasks）——W 的 client→web 返回类型变更经根 tsc -b 顺序验证通过 |
| `pnpm lint`（oxlint） | **0** | 165 warnings / **0 errors**，5443 文件 |
| `pnpm architecture:check`（CI 全量口径） | **0** | violations **412** / baseline **412** / **new 0 / regrown 0**；managed 18 模块 855 文件；legacy 5 模块 4265 文件 |
| `pnpm architecture:check --changed`（pre-push 口径） | **0** | new 0 / regrown 0 |
| `pnpm knip:gate` | **0** | 仅 1 条 `.acode/**` 无害 hint；W 的 client/web 新测试文件无需 entry |
| `pnpm test`（全 workspace，串行） | 见下 | **3063 tests / 3020 pass / 5 fail / 38 skipped** |

### 架构基线再生成（主审，清 7 条陈旧）

review §3 P3：`.architecture-baseline.json` 有 419 条 max-file-lines 条目（全为 max-file-lines、0 测试文件），但工具口径 over-limit 是 412——7 条陈旧（文件已缩到 400 下、或 gitignored 产物如 relay-server.mjs 未剔除）。`architecture-check.mjs baseline:update` 再生成 → **419→412 条**（纯删除无新增），复查全量 **new 0/regrown 0**。棘轮减数不再虚高。

### 全量测试 5 个 fail 的定性（零代码回归）

| 失败 | 根因 | 定性 |
|---|---|---|
| 4× plugin-state 家族（`MCP 插件状态通知桥`、`pooled plugin notifications`、`forwards acode-plugin-state logging`、`keeps marketplace identity`、`never forwards state notifications`） | `Error: MCP server is not connected: plugin:agent-teams:team`——需活的 MCP 子进程 | **环境依赖**，与 review 轮同一失败家族、上轮 fix-status 已记载；零代码回归 |
| 1× L01 `third-party-reproducibility` | `client/package.json` 哈希漂移（W 加 test 脚本，台账未回补） | **预期连带**，交发布流程 CI Linux 重生成（见跨文件事项） |

首跑（codegen 前）另有 `workflow-*` 5 个 fail 是缺 `libs.generated.js`，typecheck 阶段生成后消除；主审独立复跑 workflow-holes **28/28 绿**。

### 第三方台账

`node scripts/licenses.mjs reproducibility --inputs-only` → 2902 项中 **1 项漂移**（`packages/client/package.json`）。处置：工具明确「不要提交本机（尤其 Windows）重生成结果，行尾与平台依赖变体会把不一致带回去」——走发布流程 CI Linux 重生成，同 1.0.4 的 9 哈希惯例。非本轮 finding，是 W 加 test 脚本的合法连带。

### desktop build + e2e:smoke（真机 Electron）

**本轮真实测试的关键项**：W 改了 client `dispose()` 面（被 desktop host `serverRemoteConnection.ts:240` 消费）、C 改了 `create-app.ts` governor 接线（host 启动路径）——smoke 在真实进程树里验证两者不破坏启动链路。

`pnpm --filter @acode/desktop build` → **exit 0**；`pnpm --filter @acode/desktop e2e:smoke --timeout-ms 280000` → **全 PASS，exit 0**（runId=0f1bc4fe）：

| 检查点 | 结果 |
|---|---|
| CP1 进程存活 | PASS（+5028ms，pid=8960） |
| CP2 CDP | PASS（+5080ms，port=59970，Chrome/146.0.7680.216；DevToolsActivePort 缺失经 listening-port 探针发现） |
| CP3 首窗 | PASS（+5082ms，title="ACode"，launchMarks createdAt/mainStart/appReady/loadUrl 齐全） |
| CP4 Host fork | PASS（+5084ms，`[spawnHostProcess] forked host process for (local-1)`——C 的 governor 接线在真实 host 启动路径无回归） |
| 进程树清理 | PASS（+6974ms，无 electron 进程引用 temp root） |
| 临时目录清理 | PASS（+6992ms，removed） |

一次通过（上轮首跑曾因刚 build 完的文件锁瞬时冲突 exit 1 重跑，本轮无此现象）。

### remote-ssh 出包冒烟

`pnpm --filter @acode/server-cli verify:remote-ssh` **本机无法跑**：需 Docker 起带 sshd 的 Linux 容器，本机 `docker: command not found`（与上轮同一环境限制）。CI 的 remote-ssh job 在 Linux runner 上跑，非本机能力范围，如实记录。

## 里程碑债务（本轮不做完整修复，仅刷新/登记）

沿用上轮纪律，以下 5 类为里程碑级，本轮只刷新文档或登记，不假装完成：

1. **legacy 协议 M2/M3/M4 退役**——D 刷新了收敛计划进度表（2026-10-26 实测：M1 UI 投影消费 12 未降反增、M2 仍 6 legacy 消费文件、M3 bootstrap legacy server 仍 48 文件/15,188 行、M4 barrel 3,652 行），登记 2026-12-31 例外到期硬 deadline（`architecture-policy.yaml` 42 条 `expires` 在 services/session 层，shared 无本地绊线）。未推进退役本身。
2. **原型注入换显式组合**——C 修的是 CliGovernor 单例（不同问题）；R1-01 的 7/~33 扁平字段收敛仍是上轮切片状态，本轮未续批（review 未列为本轮 finding）。
3. **115 巨型组件全拆**——U 在 split-plan 登记了棘轮盲区（修剪未跌破 400、ratchet 看不见已超限后的增长）作为治理后续项，未拆组件。
4. **bootstrap `src/app/` W2 抽包**——依赖 legacy M3，未动。
5. **session publicEntrypoints 内部边迁移**——白名单仍 24 条（A 未触碰），止增机制在位，未做全量迁移。

## 提交

工作树干净，本轮共 **9 个提交**（`2c291088..8dd6d5d7`，基于 review 文档提交之上），59 文件 +2209/−418 另 7 个新文件。按主题分组（Conventional Commits + Co-Authored-By，遵循 `docs/git-collaboration.md`）：

| SHA | 主题 |
|---|---|
| `d1db62b3` | fix(web,client): bfcache 死界面 + retryNow 孤儿 socket 双 P2 + client dispose 面与首测（W） |
| `caa4aef4` | fix(services): traceId 槽脱敏旁路结构修复 + 39 处清扫 + 双守护（S） |
| `d9bb9930` | fix(architecture): v4→legacy-types 守护边界 + cmd/start 第三副本与全仓 AST 守护 + zip 断言（A） |
| `8eae7668` | fix(cli): CliGovernor 多 App fail-safe floor（C） |
| `3ec0dc95` | fix(ui): pin 回滚逆变换 + 守护拓宽 + split-plan 登记（U） |
| `5c2d2de7` | fix(desktop,shared): 桶回收顺序 + relay_bridge 订正 + 冻结守护扩面（D） |
| `501efa98` | test(cli): PS-13/14 native 归一 + C1 确定化 + mkdtemp 清理（T） |
| `e1f77ab5` | chore(architecture): 基线再生成 419→412（主审） |
| （本提交） | docs(review): 修复台账（主审）——自引用 SHA 无法稳定，amend 后即变，故不填具体值 |

**未 push**（按用户要求分支留本地自行处理）。台账 client/package.json 1 哈希留发布流程回补。
