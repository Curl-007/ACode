# ACode 1.0.3 深度 Review · 测试体系横切质量

审查日期：2026-10-22（Asia/Shanghai）。基线：`dev/1.0.3`，提交 `ebe9033b`。方法：只读源码审查 + 单包快速实跑（`@acode/rpc` 30/30 pass）+ 历史文档交叉核对，未跑全量测试，未改动代码。总入口见 [../../project-review-2026-10-22.md](../../project-review-2026-10-22.md)。

范围：横切全仓测试质量——入口与运行方式、覆盖、实现一致性、守护测试有效性、flake 风险、E2E 与跨平台缺口、覆盖盲区。

---

## 1. 整体评估

测试体系**可信度中上，能挡住大部分回归**，但门禁边界与 UI 层是薄弱点。578 个测试文件、10 个包有 `test` 脚本（CI `pnpm test` 串行跑，ubuntu-only）。核心 CLI 逻辑（apps/acode-cli）有 297+ 个测试文件集中覆盖，守护测试（rpc-descriptor-surface、architecture-coverage）**是真负向测试，违规会红**，近期 flake 修复也确实用有界轮询替换了固定 sleep。三个结构性缺口：(a) **CI 无 Windows/macOS 矩阵**，而大量近期 bug 是 win32 专有（路径大小写、8.3 短名），CI 在 Linux 上对这些恒绿；(b) **`e2e:smoke` 不进 CI**，Electron 启动链路无自动回归；(c) **若干近期修复无配套测试**（speed 两档错误消息 8122e200）。UI 层 1574 源文件仅 81 测试，且 12 个是「读源码字符串匹配」而非真实渲染。

## 2. 测试体系现状表

| 包 | test 脚本 | 源文件 | 测试文件 | 比例 | 备注 |
|---|---|---|---|---|---|
| packages/services | 有 | 365 | 61 | 0.17 | 健康 |
| packages/shared | 有 | 286 | 42 | 0.15 | 健康 |
| packages/ui | 有 | 1574 | 81 | 0.05 | 🔴 稀薄，12 个为源码字符串匹配 |
| packages/desktop | 有 | 262 | 46 | 0.18 | e2e:smoke 另计，不进 CI |
| packages/server | 有 | 65 | 7 | 0.11 | 🔴 偏薄 |
| packages/acode-server-cli | 有 | 45 | 4 | 0.09 | 🔴 偏薄 |
| packages/provider | 有 | 29 | 6 | 0.21 | OK |
| packages/rpc | 有 | 21 | 3 | 0.14 | ✅ 实跑 30/30 pass |
| packages/provider-node | 有 | 21 | 1 | 0.05 | 🔴 极薄（物化/下载/vault 无测） |
| packages/harness-sdk | 有 | 14 | 1 | 0.07 | 🔴 单文件 |
| packages/client | 🔴 无 | 9 | 0 | 0 | 无 test 脚本 |
| packages/web | 🔴 无 | 11 | 0 | 0 | 无 test 脚本 |
| packages/formal-proof | 🔴 无 | 5 | 0 | 0 | 无 test 脚本（另见架构治理专项 P2） |
| packages/model-option-map | 🔴 无 | 11 | 0 | 0 | 无脚本，但被 apps/acode-cli model-compat-pipeline 间接编译测试 |
| apps/acode-cli（根） | 有 | — | 297 | — | 集中覆盖 bootstrap/core/cli-workflow/contracts |
| └ packages/core | 有 | 833 | 19 | 0.02 | 🔴 目录内薄，主逻辑靠根 tests 覆盖 |
| └ packages/adapters | 有 | 297 | 1 | 0.003 | 🔴 8442a233 刚补首个 test |
| └ packages/bootstrap | 无 | 198 | 0 | 0 | 67 个根 tests 引用其 src |
| └ packages/cli / tui / contracts / cli-workflow / dynamic-workflow | 无 | 89/93/152/70/104 | 0 | 0 | 靠根 tests 或直接源码导入覆盖 |

## 3. 问题清单

**[P1] CI 仅 ubuntu，win32 专有 bug 在门禁恒绿** — `.github/workflows/ci.yml:28`
- 描述：全部 `runs-on: ubuntu-latest`，无 matrix。近期 66a11532（read-state win32 大小写）、01d457f8（prompt-routing walk-up）、多个 8.3 短名处理都是 Windows 文件系统语义 bug。
- 证据：`docs/reviews/2026-10-08/*` 明记「Linux/macOS /tmp 祖先无此文件故 CI 常绿」；`bash-target-blast-radius.test.mjs:506` 注释「%TEMP% 在本机是 8.3 短名」。这些测试用 `platform` 显式入参钉死 win32 键空间（read-file-state-path-key.test.ts:35），设计良好，但**其余未参数化的路径逻辑在 Linux CI 上永远走 posix 分支**。
- 建议：CI 增 windows-latest leg（至少跑 core/services/shared 三包）。
- 验收：CI 出现 windows job 且能复现历史 win32 bug。

**[P1] `e2e:smoke` 不进 CI，Electron 启动链路无自动回归** — `packages/desktop/scripts/e2e-smoke.mjs`（383 行）
- 描述：CP1-CP3 检查点 + 进程树/临时目录清理验证，`process.exit(code)` 正确传非零——门禁 `pnpm test` 只跑 `tests/**/*.test.mjs`，不含 `scripts/e2e-*`。
- 证据：`grep e2e:smoke .github/workflows/` 无命中；历史文档记「Windows isolated-profile smoke 全 PASS」但为手工执行。
- 建议：release.yml 增 smoke leg（需 GUI runner）。
- 验收：发布门禁含 smoke 且失败可阻断。

**[P2] speed 两档错误消息修复无配套测试** — `8122e200`（改 `provider-registry-selection.ts` + `subagent-selection.ts`）
- 描述：`git show --stat` 无任何 `.test.*` 文件。违反 AGENTS.md「有行为改动先补对应测试」。
- 证据：同批其他修复（49a9247b/5568807a/207e53a4/9bf1d0b4/66a11532）都带测试，唯此提交缺。
- 建议：补 `createRegistrySelectionProtocolError` 映射断言。
- 验收：该错误码闭集有测试钉住。

**[P2] `rpc-descriptor-surface` 用 `>= 40` 下限而非精确计数** — `packages/services/tests/rpc-descriptor-surface.test.mjs:88`
- 描述：`assert.ok(descriptorCount >= 40)`。当前实际 84 个 `createServiceDescriptor` 调用点。若 descriptor 因重构掉到 41 个仍绿，漏登记只在「逐个 descriptor 内部」被检（每个都验 allowedMethods 冻结/校验器齐全/无多余键——这部分是真负向）。
- 建议：改精确计数或按 interface 名集合比对。
- 验收：删一个 descriptor 门禁变红。
- 注：协议专项（[protocol.md](protocol.md) §2 P3）独立指出同一处阈值贴边问题，两份结论一致。

**[P2] provider-node / acode-server-cli / server 覆盖偏薄**
- 描述：provider-node 21 源仅 1 测（builtin 下载/物化/远程同步/vault 无测）；server 65 源仅 7 测；acode-server-cli 45 源仅 4 测（supervisor 生命周期）。这些是远端/持久化高风险区。
- 建议：按 owner-lease 测试的「真 sqlite + 小时间参数」范式补关键路径。
- 验收：每包比例 ≥0.15。

**[P3] 12 个 UI 测试是「读源码字符串匹配」而非渲染** — `packages/ui/test/splitPaneErrorIsolation.test.ts` 等
- 描述：用 `readFileSync`+`assert.match(block, /<ScopedErrorBoundary/)` 钉 JSX 结构。文件头注释坦承「ui 无 jsdom 套件…只钉接线」。价值：防结构回归有效；风险：改属性名/换等价实现即假红，且不验证真实错误捕获行为。
- 建议：关键交互补 `renderToStaticMarkup`（26 个已用此法）或 jsdom。
- 验收：错误边界真实捕获有行为测试。

**[P3] adapters 297 源仅 1 测** — `apps/acode-cli/packages/adapters/tests/usage.test.ts`（8442a233 刚补，手写 schema 断言 SQL 聚合，质量良好但唯一）。存储层其余 repository 无覆盖。

## 4. 守护/门禁测试有效性（逐个核实）

| 守护测试 | 负向有效性 | 证据 |
|---|---|---|
| `architecture-coverage` deep-import | ✅ **真红** | `:135` 坏导入断言 `deep-import.length===1`，改类型导入后 `===0`，双向验证 |
| `architecture-coverage` v4-imports-legacy | ✅ **真红** | `:170` 导入 legacy barrel 断言违规===1，改 shared 后===0 |
| `architecture-coverage` workspace 解析 | ✅ **真红** | `:186` 静态+动态深导入断言===2 |
| `rpc-descriptor-surface` 每 descriptor 校验 | ✅ **真红** | 逐个验 allowedMethods 冻结、校验器齐全、无表外键、与 interface 精确一致（`:54` deepEqual） |
| `rpc-descriptor-surface` 计数下限 | ⚠️ **半绿** | `:88` `>=40` 是下限，删至 41 仍绿（见 P2） |

三个 architecture fixture 都用 `mkdtemp`+`t.after(rm)` 正确隔离与清理。守护体系整体**不是恒绿**，漏登记/深导入确会失败。

## 5. flake 风险清单

- `apps/acode-cli/tests/workflow-owner-lease-manager.test.mjs:60,70,102,130…` — 大量 `sleep(1_400/1_700/900)`。有注释钉时序模型（租约 1.2s、心跳 300ms、下限 `Math.max(1_000,leaseMs)`），但**仍是墙钟依赖**：CI 高负载下若续租 tick 延迟，`sleep(1700)` 后 claim 可能未达预期状态。属「已知可控但非零」风险。
- `packages/rpc/test/transport-frame-limits.test.ts:202,226,274` — `sleep(500/300/450)` 等空闲超时/watchdog。真超时语义，难去，但 300-500ms 在慢 runner 上有风险。
- `packages/server/tests/server-auth.test.mjs:168,677,690,1013,1210` — 多处 `sleep(120)`/`setTimeout(120)`，认证握手时序，并行负载下偏紧。
- `packages/harness-sdk/tests/parity.test.mjs:365,597` — `setTimeout(300/200)`。
- **8.3 短名/大小写环境依赖**：已系统性处理——`git-invocation-hardening.test.mjs:32`、`subagent-worktree-isolation.test.mjs:45` 用 `realpath.native` 展开 %TEMP% 短名；`bash-target-*` 有意拒绝静态无法验证的短名。**非残留 flake，是主动防御**。
- **固定端口**：browser-relay-lease（9224）、supervisor-health（1234）均为 `makeFakeServer`/未真实 bind，**无端口冲突 flake**。
- 近期已根修：mcp-startup-gate（19c7eebf，50ms→`waitUntil` 轮询 20s 封顶）、mcp-crash-storm-ladder + prompt-routing（01d457f8，20ms→`waitUntil(2s)` + walk-up 收进 temp root）。**修复方向正确**。

**残留隐患**：`skillSyncArchiveTrust.test.ts`（179 行，多处 `mkdtemp`）全程无 `rm`/`t.after`/`finally`——**临时目录泄漏**，CI 累积占盘。同类待逐个确认：`subagentsBundledCatalog.test.ts`、`archiveTrustTiers.test.ts`、`pluginSyncPathWindowsLexical.test.ts`、`official-service-switches.test.mjs`、`guide-live-build-section.test.mjs`。

## 6. E2E 与跨平台缺口

- **Electron smoke**：`e2e-smoke.mjs` 落地且设计完整（DevToolsActivePort→CDP `/json/version`、首窗 page target+launchMarks、`taskkill /T /F` 杀树后验证无残留引用临时目录、超时转储 stdio）。`fail()` 经 `process.exit(code)` 传非零，**机制有效**。但**仅手工/Windows 本地跑，不进任何 CI workflow**（见 P1）。
- **SSH 首次批准对话框真实 GUI 驱动**：仍未闭环。`docs/reviews/2026-10-08/fix-status-2026-10-09.md` 明记「CDP 已可接管，属下一增量」。现有 SSH 测试（`ssh-host-key-trust`、`ssh-known-hosts`、`ssh-keyboard-interactive`、`ssh-prompt-channel`）是逻辑层，非真实 GUI 对话框驱动。
- **跨平台矩阵**：CI 零矩阵（仅 release.yml 有 windows-latest 用于打包/签名，不跑测试）。macOS/Linux 行为矩阵「仍待真实环境」（历史文档确认）。

## 7. 覆盖盲区（高风险区）

按测试文件名统计：`abort`=0、`hydrate`=0、`reconcil`=1、`snapshot`=1、`queue`=2、`persistence`=2、`cancel`=3、`identity`=3、`lease`=4、`owner`=5、`resume`=5、`recover`=4。

具体缺测点：
1. **取消/中止（abort）**：0 个专门测试文件。CommandInbox 有 invariants/discard-terminal/redelivery 三测，但「运行中取消」的并发中止路径缺专门覆盖。
2. **水合（hydrate）**：0 文件。daf32bee（resume 水合镜像 live 修剪）、b3779769（压缩后已读状态修剪）是近期高频改动区，靠 read-file-state/post-compact 测试间接覆盖，无端到端水合恢复测试。
3. **远程 identity**：`workspaceIdentity` vs `workspacePath` 隔离是 AGENTS.md 核心不变量，仅 3 个 identity 测试，远程链路贯穿传递（`remoteSessionId`）的跨 Host 路由 identity 一致性缺专门测。
4. **provider-node 物化/下载/vault**：21 源 1 测，builtin 配置物化、远程同步、apikey vault 持久化几乎裸奔。
5. **快照/重放对账（snapshot/reconcile）**：各 1 测，`desktop-continuous` vs `web-remote-replayable` 两种语义的分叉（AGENTS.md 明确要求「同时验证」）缺对照测试。

## 8. 修复入口建议

优先级最高的单点是给 `ci.yml` 加一个 windows-latest leg 跑 core/services/shared 三包——这一项直接堵住 P1 的两条（win32 CI 恒绿 + 顺带能跑 smoke）。

> 已确认可运行：`pnpm --filter @acode/rpc test` 实跑 30/30 pass（1.84s），验证 `node --import tsx --test` 直跑 TS 无需预构建成立。其余包仅源码评估。
