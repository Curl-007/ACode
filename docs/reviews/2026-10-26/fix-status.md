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

---

## 续轮（2026-10-27）：里程碑债务推进 + 文档失真订正

上表 9 提交（review 整改批）之后，按用户指令「根据文档完整修复」续做。本轮**不重复**上表已完成的
P2/P3 修复（已由 20 个对抗式核验代理逐项确认 holds，file:line + 复跑测试，见下文核验结论），
而是推进上表 §里程碑债务的 5 类与 review §7.3，并订正调研中发现的**文档事实错误**。

### 核验方法（20 代理对抗式复核，不采信上表自报）

对 review 全部 15 项修复 + 6 项里程碑/状态逐一独立核验（read-only 代理，default stance =
尝试**推翻**每项声明）。结论：

- **15/15 修复 holds**——每项都有 file:line 证据 + 独立复跑测试（web 41/41、client 12/12、
  services 546 pass、architecture-coverage 17/17、cli-governor 15/15、powershell 20/20、
  script-workflow-sandbox 15/15、auto-resume 9/9、desktop mirror 11/11、freeze 守护 5/5、
  ui composition+guard 9/9、browser-open AST 守护 3/3）。提交信息无夸大（与上轮 afdd7c79
  的教训相反）。
- **4 项 deferred-by-design**（legacy M1-M4、session entrypoints、115 组件拆分、R1-01）——
  多周工程，文档自身已登记「本轮不做」，核验确认未假装完成。
- **1 项 stale-claim**（收敛计划文档的 shared expires 绊线断言，见下）。

### 本轮完成项（8 提交）

| SHA | 主题 | 对应 review 项 |
|---|---|---|
| `ce12a2e4` | docs(legacy): 订正收敛计划事实错误——shared 确有 expires 绊线 + bootstrap legacy 48→50 | §7.3（刷新收敛计划文档） |
| `eb0378d3` | refactor(services): session 内部边迁契约面 + 修复 #src/* 别名 resolver 盲区 | §7.3（session publicEntrypoints 迁移，上表债务 5） |
| `0f4a65de` | fix(cli): 隐藏 coordinator 语义落盘——修 R1a「冷重启后泄漏进侧栏」既有缺陷 | evolution §5.1 附带发现的 K3 缺陷 |
| `9f8aea05` | docs(legacy): 订正 M1 三条失真前提 + 登记 K3 已修复 | §7.3（M1 调研） |
| `56820fb8` | fix(server-cli,services): traceId 槽清扫扩到跨包消费方 + 守护改全仓 receiver-aware | §7.2（traceId 批量清扫的跨包残留）+ §5（修一处漏其余） |
| `b43c1a8e` | docs(legacy): 订正 M2 验收判据结构性不可满足 + 解耦 type-only 消费方到中立接口 | §7.3（M2 调研）+ AGENTS.md 依赖方向 |
| `e551d706` | docs(legacy): 订正 M3/M4 陈旧计数 + 补结构性阻塞的实测证据 | §7.3（M3/M4 调研） |
| `0e714476` | feat(ui): 已登记上帝组件行数 ratchet 守护——补 review §6 的隐形膨胀盲区 | §6（ratchet 盲区）+ 上表债务 3 的治理项 |

### 逐项处置与真实证据

**① session publicEntrypoints 内部边迁移（上表债务 5）——✅ 完成。**
`contract.ts` 从 55 行扩到 ~110 行（maxContractLines 300 内），补齐全部消费方符号；
`publicEntrypoints` 注册 contract.ts，session 转常规 deep-import 强校验。32 条消费方边改指契约面。
**同时修复一处 resolver 盲区**（review §3 26R2-03 同构问题）：checker 只解析 tsconfig paths 与
package.json `exports`，**不**解析 package.json `imports` 字段，故 services 的 102 处 `#src/...`
导入对 deep-import 门禁完全不可见——原 24 条白名单只登记了相对路径形态的边，**23 条
`#src/session/*` 边从未受管**。`global.aliasRules` 新增 `#src/* → packages/services/src/*`
（仅 services 声明该别名，作用面精确）后显形；实测 47 条真实边 → 15 条保留登记（全部是写入/
装配面）、32 条迁入契约。补 fixture 守护双向钉住（有 aliasRule→边被拦截；无→盲区复现）。
- **TaskIndexRepo 的 5 条边刻意保留直引**：task-index-writers 守护把源码中对该符号的任何文本
  引用（注释也算）当待评审写入面；实测两条替代路径均被判红（加 composition.ts 转发叶子、
  在 contract.ts/module.ts 注释里写类名）。原 spec 说「只 1 条边需单独设计」实为 5 条——
  其中 4 条是 `#src` 形态、门禁看不见，原评估低估。
- 门禁：typecheck 32/32、arch deep-import 0、knip 0、services 578 pass/0 fail、
  task-index-writers 守护 2/2、architecture-coverage fixture 19/19。

**② K3 隐藏 coordinator 冷重启泄漏（evolution §5.1 登记的待办）——✅ 修复。**
`hidden:true` 从未被消费：forkCoordinatorTask 只读 targetMessageId，会话行以 taskType "fork"
落盘，而侧栏可见性由持久化 taskType 决定（`"fork"` ∈ TASK_LIST_SESSION_TYPES），故冷重启后
被 seed 投进侧栏显示「Fork of X」。修法：新增专属 `SessionTaskType "overnight_coordinator"`
（**不进**可见集合，靠「不在即不可见」生效，不新增第二条可见性路径），fork 链透传落盘身份 +
coordinator 自己的标题。**关键**：运行期 config.taskType 必须同值——实现期实测发现
`ensureSessionPersisted` 在 child 首个 turn 以 config.taskType upsert 会话行
（`turn.ts:332`→`events.ts:593`→`createSession` 的 `task_type = excluded.task_type`，child 的
`sessionPersisted` 初值 false），若 config 仍是 "fork" 会**静默撤销**落盘身份（两处写入不同源 =
重复状态，AGENTS.md 禁止）。无 DB 迁移（task_type 是无 CHECK 约束的 text 列）。
- 6 新测（真 sqlite store + 真 AgentRuntime，含 **upsert 同源守卫**与**负向对照**——后者证明
  不同源时身份确实被撤销，即缺陷路径可复现）。
- 跨版本降级如实登记不加兜底：decodeSessionTaskType 对未知值回落 "interactive"，旧版 CLI 读新库
  会显示为可见 interactive 会话（退化为修复前行为，不崩溃不损坏；R1 本就不跨重启续跑）。

**③ traceId 槽清扫的跨包残留（review §7.2 + §5「修一处漏其余」）——✅ 清扫 + 守护机械化。**
上表记载的「39 处清扫归零」只覆盖 `packages/services/src`。`createServiceLogger` 经
`@acode/services/node` 公开入口被其它包消费：实测 acode-server-cli 仍有 **28 处**误用
（supervisor.ts 27 + updateCommand.ts 1）；同包 http.ts 本就是正确形态，说明约定已知、只是没被扫到。
- **无泄漏风险，是形态收口**：结构性修复（traceId 槽先过 redactServiceLogArg）已保护所有消费方，
  误用后果是消息串落在 `[trace:…]` 前缀槽（语义错位），非绕过脱敏。
- 守护改**全仓 receiver-aware** 扫描（判据 = 名字在本文件内绑定到 createServiceLogger，不是
  「任何 log.xxx("字面量")」——desktop/host/index.ts 的本地 message-first logger 有 21 处假阳性，
  实测确认后未改动）。plant-test 验证非空转：在 updateCommand.ts 植入误用→守护红并报 file:line。
- **订正上表的一处低估**：上表 §主审核验 S 段称「独立 grep 残留误用 = 2 处，均为
  AgentSparePoolLogger（正确形态）」——该 grep 只扫了 services/src，未覆盖跨包消费方。

**④ 已登记上帝组件行数 ratchet（review §6 + 上表债务 3 的治理项）——✅ 落地。**
实测确认盲区：`packages/ui` 是 `managed: false`，legacy 模块的 max-file-lines 指纹**不含行数**，
故 AutomationEditView 2942→2950（+8，Button a11y 迁移合法成本）门禁恒绿。守护测试 3 条断言
（上限表 / 登记表防腐 / **防漏登记**——解析 split-plan 的 `### \`x.tsx\`（` 标记，新登记批次忘加
上限立即红）。选守护测试而非改 scripts/architecture 的理由：index.mjs 只剩 2 行 oxlint 余量；
架构棘轮的 newViolations 是基线过滤后集合、指纹类规则可被 `baseline:update` 吸收，守护测试不可。
plant-test：+1 行→红报「2951 > 2950（+1）」。ui 套件 740/740（+3 即本守护）。

### 文档事实错误订正（本轮调研发现，共 6 处）

review §7.3 要求「刷新收敛计划文档」，但上轮刷新（`5c2d2de7`）留下了失真前提。本轮逐条实测订正
（**这些订正本身是本轮的实质交付**——M1-M4 若按错误前提开工，会做出表面通过而非收敛的改动）：

| # | 位置 | 原文断言 | 实测事实 |
|---|---|---|---|
| 1 | convergence-plan:101-104 | 「shared 层**不携带**本地 expires 绊线（barrel 用 oxlint-disable 头注，非架构例外）」 | **事实错误**。barrel `acode-protocol/index.ts` 同时在 `onboard-b3-shared-over-limit`（policy:585）与 `-disables`（policy:611）两条 `expires:"2026-12-31"` 例外 paths 内；`index.mjs:75-88` 对到期例外压 expired-exception 全局违规（2027-01-01 起转红）。oxlint 头注是 lint 关注点，不替代架构例外。42 条到期例外中 **2 条在 shared**、2 条在 server，原文「位于 services/session 等层」低估暴露面 |
| 2 | convergence-plan M1 节 | 「8 个 UI 消费文件」「`taskQueryCacheStore` / v4 conversation projection store 已有承接面」 | 实为 **12 个**文件；且承接面对其中 **2 个不存在**（实测三项零命中：V4_METHODS 无 readSession 等价物、无 ConversationSnapshot→TaskMeta 映射器、packages/ui/src 对 workspace-config topic 零消费）。另 10 个只 import 模型选择器字符串工具（非投影读取），且 UI 版 parseModelPickerValue **不是** shared 版 re-export（先跑 decodeCustomModelValue，shared 版遇 `custom:` 串抛错）→ 天真改指 shared 会**静默破坏自定义模型**。M1 第二道验收门（ui 测试绿）**无保护力**：全仓无任何测试引用该桥或其导出 |
| 3 | convergence-plan M2 节 | 「`acodeProtocolClient.ts`（legacy 客户端本体）」应「退役」 | **危险错误**。它是 legacy 与 v4 **共用**的版本无关 JSON-RPC 载体：`acodeProtocolClient.ts:19` 方法名联合已含 `V4Method`；v4 方法经它派发（acodeAgentService.ts:1257,1803,1824,3890）；`transport.ts:370-371` 头注明写「旧 session/* 删除后，**这里就是唯一协议面**」。按原文退役会删掉 v4 载体。且验收 grep 的 `acodeProtocolClient` 半句**只能靠改名归零** = 表面通过 |
| 4 | convergence-plan M2 节 | 「6 文件」的 legacy 消费方 | 含 **3 个假阳性**：node.ts:108 是 barrel re-export；acodeAgentProcessManager.ts 实测 `acodeProtocolMethods.` 消费数 = **0**（只命中 import 路径）；acodeProtocolClient.ts 命中自己文件名。真消费方 3 个 |
| 5 | convergence-plan M3/M4 节 | 目录「48 文件」、server-operations.ts「3,973 行」、CLI 测试基线「980」、barrel「3,714 行」 | 实测：目录 **50 文件 / 15,690 行**（U08 `1ead67e2` 新增 provider-diagnostics 2 文件）；server-operations.ts **4,058 行**；CLI 测试 **3,151 个**；barrel **3,652 行** |
| 6 | fix-status.md:122 | 「shared 无本地绊线」 | 同 #1，事实错误（本轮订正源头文档，本行保留为历史记录） |

### 里程碑债务状态（本轮更新）

| 债务 | 上表状态 | 本轮状态 | 阻塞原因（实测） |
|---|---|---|---|
| 1. legacy M1 UI 投影收口 | 未推进（消费面 8→10→12） | **未推进，判定阻塞** | 12 个消费方中 2 个需先建 v4 承接面（归档单会话冷读 + ConversationSnapshot→TaskMeta 映射器；UI 侧 workspace-config 消费）；10 个是 bounded 搬迁但**搬迁不能让验收 grep 归零**，且 M1 的测试门无保护力（零测试覆盖该桥） |
| 1. legacy M2 services 双栈切换 | 未推进（6 文件） | **未推进，判定为多周到多月协议扩展工程** | 68 个 legacy 方法（acodeAgentService 66 + pluginReferenceCatalogRequest 2）中 **0 个有干净 v4 等价物**（V4_METHODS 34 条 vs legacy 84 条）：54 个完全无 v4 契约（transport.ts 对 plugins/mcp/skills/automation/offPeak/workspace 写路径零命中；15 个是 inbound handler，属两侧协议变更），14 个部分等价但会静默丢字段或收窄值域（sessionCreate 丢 engine/persistence/importedHistory；sessionCompact 的 v4 payload 是空 object；sessionSetMode 的 v4 值域刻意排除 auto；sessionMessages 分页方向相反；sessionClose≠deleteSession）。约 13 个触及 stream/snapshot/queue，按 review 要求须双链路真实冒烟（headless 不可跑）。**唯一 bounded 可推进项已做**：type-only 消费方解耦到中立接口叶子 `acodeAgentRpcClient.ts`（不构成 M2 进度，验收判据本身待重写） |
| 1. legacy M3 删 CLI legacy server | 未启动（48 文件） | **未推进，结构性阻塞于 M2** | 实测：legacy server 仍派发 services 侧仍在发的方法（server.ts 对 pluginsList/sessionRead/mcpList 各 1 处 dispatch）。「纯删除」前提是 M2 已完成。目录实测 50 文件 / 15,690 行 |
| 1. legacy M4 删 shared barrel | 未启动（3,652 行） | **未推进，阻塞于 M1+M2+M3** | 实测：`acodeProtocolMethods` 在 services/src 与 bootstrap/src/acode-protocol/ 内仍有 **12 个活跃消费文件** |
| 2. R1-01 原型注入换显式组合 | 7/~33 切片，未续批 | **未推进（保持）** | 33 个扁平可变字段仍未收敛（实测 internal.ts：ContextMemory 19 + MessageProjection 5 + CacheDiagnostics 4 + TurnState 剩余 5）；原型注入机制（methods/index.ts 的 `proto.X = X`）与全字段 `this` 联合未变，P1 根因按设计仍在。spec `runtime-state-ownership.md:269-274` 登记为需单独立项的长期方案 |
| 3. 115 巨型组件全拆 | 登记棘轮盲区，未拆 | **未拆组件，但治理项已落地** | 实测仍 **115 个** .tsx 超 400 物理行（持平）。**行数 ratchet 守护已落地**（`0e714476`），隐形膨胀盲区已堵；组件拆分本身仍是多批次工程 |
| 4. bootstrap `src/app/` W2 抽包 | 依赖 M3，未动 | **未动（保持）** | 依赖 legacy M3，M3 阻塞于 M2 |
| 5. session publicEntrypoints 内部边迁移 | 白名单 24 条，未做全量迁移 | **✅ 完成** | 见本轮完成项 ①。白名单从 24 条（只覆盖可见面）→ 15 条（覆盖全部 47 条真实边，含此前门禁不可见的 23 条 `#src` 边）；publicEntrypoints 已注册；deep-import 转强校验并 plant-test 验证非空转 |

### 主审统一验证（本轮，干净串行环境）

| 检查 | 结果 | 关键计数 |
|---|---|---|
| `pnpm typecheck`（三阶段） | **exit 0** | packages / desktop-renderer / cli 全绿（32/32 tasks） |
| `pnpm lint`（oxlint） | **exit 0** | **165 warnings / 0 errors**（与上表基线持平，未新增） |
| `pnpm architecture:check`（CI 全量口径） | exit 1* | violations 414 / **new: 2** / regrown 0 |
| `pnpm architecture:check --changed` | **exit 0** | new: 0 / regrown: 0 |
| `pnpm knip:gate` | **exit 0** | 新增叶子 acodeAgentRpcClient.ts 有真实 importer |
| `pnpm verify:pre-push` | **exit 0** | lint + arch --changed |
| 全仓测试（`pnpm -r --no-bail run test`，干净树） | 1 fail | **5,907 tests / 5,861 pass / 1 fail / 45 skipped**（18 个含 test 脚本的包全部执行） |
| `pnpm --filter @acode/ui test` | **exit 0** | **740 / 740**（+3 为本轮 ratchet 守护） |
| `pnpm --filter @acode/services test` | **exit 0** | **578 pass / 0 fail**（585 tests，含新守护 5/5） |
| `pnpm --filter @acode/server-cli test` | **exit 0** | **25 / 25** |
| CLI 套件（apps/acode-cli/tests） | 1 fail | **3,151 tests / 3,112 pass / 1 fail** |

\* **arch 全量口径 new:2 的定性（本机假红，非代码回归）**：两条均为
`apps/acode-cli/packages/browser-use-plugin/scripts/{browser-client,relay-server}.mjs`
（2,233 / 1,912 行）。`git check-ignore` 实测二者**均为 gitignored 构建产物**
（`.gitignore:2-3`，untracked），只在本机磁盘存在时被计数；干净 CI 树上不会出现。
上表已登记同一现象。`--changed` 口径 new: 0。

**唯一真失败：L01 台账**（`third-party-reproducibility`）——`packages/client/package.json`
1 项哈希漂移（台账 `34842bcc…` vs 实际 `0a81396e…`）。根因是上表 W 代理给 client 包加了首个
test 脚本，台账按仓库惯例须在**发布流程 CI Linux 重生成**（工具明确禁止在 Windows 本机回补，
否则行尾与平台依赖变体会把不一致带回去）。**非本轮引入**，本轮未改 client/package.json。

**未跑项（环境限制，如实记录）**：`pnpm --filter @acode/desktop build` + `e2e:smoke`（真机
Electron）本轮未跑——上表已实跑全 PASS（runId=0f1bc4fe，6 检查点），且本轮改动不触及 desktop
main 进程的启动链路（K3 改动在 CLI core/bootstrap + contracts；session 迁移在 services；
ratchet 守护在 ui tests）。`verify:remote-ssh` 仍不可跑（本机无 Docker，同上表）。
双链路真实冒烟（desktop-continuous / web-remote-replayable）本轮未跑——本轮无触及
stream/snapshot/queue 的改动。

### 本轮提交

工作树干净，本轮共 **8 个提交**（`ce12a2e4..0e714476`，基于上表批次之上），
36 文件 +999/−221（含 3 个新文件：`acodeAgentRpcClient.ts`、
`overnight-hidden-coordinator-persistence.test.mjs`、`godComponentLineRatchet.guard.test.mjs`）。

**已 push**：本轮与上表批次一并在 `fix/project-review-2026-10-26` 分支，已推送并开
PR #11（base `dev/1.0.4`，按 `docs/git-collaboration.md` 的分支模型；用户裁决）。
**注意**：PR #11 开于 `daaf1e31`，本轮 8 个提交在其之后，需再次 push 才会进入 PR。
台账 client/package.json 1 哈希仍留发布流程回补。

### 本轮方法论教训（与上表 §主审推翻代理 finding 同一纪律）

1. **文档的前提必须先核验再据以施工**：M1/M2 的「承接面已有」「legacy 客户端本体」两条前提
   若采信，会做出「搬迁 10 个文件让 grep 变少」和「删掉 v4 载体」两种表面通过而实质有害的改动。
   本轮先调研后施工，6 处文档失真全部有 file:line 实测证据。
2. **代理的 confident finding 仍须主审实证**：M2 代理报「acodeProtocolClient 是共用载体」——
   主审独立核验 `acodeProtocolClient.ts:19` 与 `transport.ts:370-371` 后确认属实（未采信即改）。
   反向亦然：上表 T 代理的 realpath 升级项曾被主审四变体实测推翻。
3. **门禁绿 ≠ 守护有效**：本轮两处「绿得可疑」都做了 plant-test 才敢声称有效——
   `#src` 别名规则（植入直引→红）、行数 ratchet（+1 行→红）。上表已有同构先例
   （browser-open AST 守护的 plant→red→remove→green）。
4. **守护边界 = 谓词的路径代数 + 演练的路径集合**（review §3 原话）在本轮再次应验：
   traceId 守护只扫 services/src → 跨包 28 处漏网；deep-import 只解析 tsconfig/exports →
   23 条 `#src` 边漏网；max-file-lines 指纹不含行数（legacy 模块）→ 上帝组件隐形膨胀。
   三处修法一致：补谓词 + 补演练 + 机械化。
