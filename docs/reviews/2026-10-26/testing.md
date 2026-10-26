# ACode 1.0.4 深度 Review · 测试体系质量

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`。方法：只读源码审查 + 上轮（2026-10-22，基线 `ebe9033b`）测试修复逐条核验 + 守护测试有效性判读（真负向 vs 字符串匹配）。全量门禁由主审统一实跑，见总入口。总入口见 [../../project-review-2026-10-26.md](../../project-review-2026-10-26.md)。

范围：全仓测试体系——各包 test 入口、覆盖比例、守护测试有效性、flake 源、临时目录卫生、E2E 缺口。

---

## 1. 全量测试实跑结果（主审亲跑，codegen 产物就位后）

`pnpm test`（全 workspace，Node v25.8.2 / pnpm 9.10.0）：**3052 tests / 3009 pass / 5 fail / 38 skipped**。

首跑（codegen 前）另有 8 个 ✖，主审逐一根因定位，**全部为环境/连带类，零代码回归**：

| 失败簇 | 数量 | 根因 | 处置 |
|---|---|---|---|
| `workflow-*`（artifact-races/budget-fuses/holes/lifecycle-replay/script-determinism） | 5 | 缺 `libs.generated.js`（gitignored codegen 产物，`dynamic-workflow` 测试直接 import `src/compiler/libs.generated.js`） | 主审 `node scripts/generate-libs.mjs` 生成后重跑 `workflow-holes` **28/28 绿**；与上轮 fix-status 记载同类 |
| L01 `third-party-reproducibility` | 1 | **主审自身环境问题**：本机 pnpm 9.10.0（钉定 10.33.2）install 时把 `pnpm-lock.yaml` 的 `patch_hash` 从长 hex 改写为短 base32（`d3a7c381…`→`nemgxcat…`），同版本同 patch，纯编码格式漂移 | `git checkout -- pnpm-lock.yaml` 还原到 committed 状态后 L01 **9/9 绿**——**committed 树的台账与源文件一致**，非发布门禁失败 |
| `plugin-state-bridge` / `plugin-state-pool` | 5（终态） | `Error: MCP server is not connected: plugin:agent-teams:team`——需活的 MCP 子进程，CI/本机无 | 环境依赖，上轮 fix-status 已明确记载为「既有、需活 MCP server」的同类失败 |

> 注：终态 5 个 fail 全属 plugin-state/MCP 家族（`gate: 预算内就绪走真实工具`、`MCP 插件状态通知桥`、`pooled plugin notifications`、`forwards acode-plugin-state logging`、`keeps marketplace identity from the loader`、`never forwards state notifications without loader-proven pluginId`），与上轮 3052/3012/3/37 的失败家族一致。上轮记载的 PS-13/PS-14（powershell 8.3 短名）本轮**未在失败列表出现**（本机 worktree tmpdir 未触发 8.3 形态），但根因未修（见 §3）。

## 2. 上轮修复回归核对

| finding | 声称修复 | 核验结论 | 证据 |
|---|---|---|---|
| client/web/formal-proof/model-option-map 无 test 脚本 | web 14、formal-proof 26、model-option-map 14 补脚本 | **PARTIAL** | web `package.json` test 在位（14 测：browserOAuthCredentialRepo 5 + WebDisconnectOverlay 3 + webSocketReconnect 6）；formal-proof 在位（26）；model-option-map 在位（14）。**`packages/client/package.json` 仍无 test 脚本、0 测试文件**；`packages/acode-cua` 亦无（占位包，全 fail-closed，可接受） |
| abort=0、hydrate=0 专门文件；两条交付链路缺对照 | 5 文件 / 37 测 + spec | **HOLDS** | `apps/acode-cli/tests/` 下 5 文件齐全：runtime-abort-concurrency(6)、resume-hydration-read-state(6)、workspace-identity-routing(8)、delivery-profile-contrast(7)、snapshot-gap-repair(10) = **精确 37**。spec `review-blindspot-coverage.md` 在位。抽读 4 个——全为真负向（见 §4） |
| descriptor 门禁 `>=40` 下限 | 频道名集合 deepEqual | **HOLDS** | `packages/services/tests/rpc-descriptor-surface.test.mjs:157` `assert.deepEqual(uniqueChannels, REGISTERED_DESCRIPTOR_CHANNELS)`；40 频道 sorted 快照 `:17-58`；无残留 `>=40`（仅注释）。另断言唯一性 `:147` + 逐 descriptor 冻结 allowedMethods/validators |
| speed 两档（8122e200）无测试 | registry-selection-speed-error.test.mjs | **HOLDS** | `apps/acode-cli/tests/registry-selection-speed-error.test.mjs`（3 测）：错误码闭集 deepEqual（3 码集 `:103`）、两 speed 分支 `:68-84`、SUBAGENT_SELECTION_MESSAGES 投影 `:136`。真实 import `createRegistrySelectionProtocolError` |
| provider-node 21 源/1 测 | +3 文件 ratio ≥0.15 | **HOLDS** | 21 源 / 4 测 = **0.19**；server-cli 45/7 = **0.156**。均 ≥0.15 |
| 临时目录泄漏（6 文件） | trackMkdtemp/t.after/rm | **HOLDS（全 6）** | skillSyncArchiveTrust `:22 after`+`:26 trackMkdtemp`（8 处）；subagentsBundledCatalog `:59 after`；pluginSyncPathWindowsLexical `:83 t.after`；official-service-switches `:31,74,106,129 t.after`（×4）；archiveTrustTiers `:30 after`；guide-live-build-section `:49 makeTree→t.after` |
| PS-13/PS-14 8.3 短名 | afdd7c79「两个测试 tmpdir 8.3 归一」 | **PARTIAL / 提交信息误导** | afdd7c79 实际硬化的是 **skillsBundledScopeAndCacheAuthority.test.ts + windowsCuaDevRuntimeResolution.test.mjs**（`realpath(tmpdir())` 后再 mkdtemp——正确归一，断言未改，非掩盖）。**但 PS-13/PS-14 位于 `apps/acode-cli/tests/powershell-tool.test.mjs`，未被触碰**（`git log ebe9033b..HEAD` 对该文件为空），其 `normalizeWin = toLowerCase+replace(/,\)` `:33` **不展开 8.3**。故 afdd7c79 修的是**另一对**；PS-13/14 类未解。缓解：windows-verify CI leg 只跑 core/services/shared，从不跑 apps/acode-cli/tests → PS-13/14 仍是本机 Windows 已知失败，CI 不可见 |
| C1 沙箱时钟 flake（墙钟） | 串行通过 | **未修（仍在）** | `apps/acode-cli/tests/script-workflow-sandbox.test.mjs:103,109`——固定 `setTimeout(25)` 后断言 `requestDone===false`/`settled===false`。墙钟竞态；并行负载下 25ms 可能已过 → flake。未变 |
| L01 台账 9 哈希 | 88a31ce3 CI Linux 重生成 | **HOLDS** | `git show 88a31ce3 -- third-party/inventory.json`：noticesSha256 `80f2c0bc→99af6726`、button.tsx sha256 `→bc651d3c…`（与 fix-status 声称一致）、36 行变更。inventory.json 已重生成。主审亲跑 L01 在干净 committed 树上 **9/9 绿** |
| e2e:smoke 不进 CI | release.yml desktop-smoke fail-closed | **HOLDS** | `.github/workflows/release.yml:96 desktop-smoke` job → `:128 pnpm --filter @acode/desktop e2e:smoke`；`:771 publish needs:[…desktop-smoke]` + `:775 if needs.desktop-smoke.result=='success'`（fail-closed，无 skipped 兜底）。ci.yml windows-verify 在 `:132` |

## 3. 新发现

| 级别 | 问题 | 位置 | 证据 | 定性 |
|---|---|---|---|---|
| **P3** | client 包仍零测试 | `packages/client/package.json` | 唯一无 test 脚本的顶层非占位包；10 个源文件（contract.ts、messageport.ts、websocket.ts、remoteServiceAccess.ts）——远程/传输面无测试。上轮 review 已点名；1.0.4 给 web/formal-proof/model-option-map 补了脚本却**跳过 client** | CONFIRMED |
| **P3** | 临时目录泄漏清扫漏网一处 | `apps/acode-cli/tests/auto-resume-config-chain.test.mjs:112,140` | 3× mkdtemp，无 rm/t.after/finally。**既有**（提交 efa10604，基线 ebe9033b 的祖先）——非 1.0.4 引入，但泄漏清扫未捕获。全仓扫描发现这是**唯一**残留的 mkdtemp-无清理 | CONFIRMED |
| **P3** | PS-13/PS-14 8.3 类实际未硬化 | `apps/acode-cli/tests/powershell-tool.test.mjs:33,346,369` | afdd7c79 提交信息暗示 8.3 类已处理，实际修的是另两个文件。PS-13/14 依赖 `normalizeWin`（无 realpath/8.3 展开）。CI 不可见（windows-verify 排除 apps/acode-cli/tests）。仍是本机 Windows 已知失败 | CONFIRMED |
| **P3** | C1 墙钟 flake 未修 | `apps/acode-cli/tests/script-workflow-sandbox.test.mjs:103,109` | 固定 `setTimeout(25)` + 负向断言 = 并行负载 flake。记载为「串行通过」但根因（墙钟依赖）完整保留 | CONFIRMED |
| **P3** | 2 个新 UI 守护是源码字符串匹配，非行为验证 | `packages/ui/tests/themeWriteOwnership.guard.test.mjs`、`taskMetaCacheOwnership.guard.test.mjs` | readFile+regex 扫 src 树，deepEqual 比对允许写入者列表。对单一写入者不变量是真负向（新增写入者→红），但属结构性——与 testing.md §3 P3 点名的同模式。合法的所有权守护惯用法（与 lns.test.mjs 一致），诚实地非行为测试 | CONFIRMED |

无 P1/P2 测试质量回归。26 个新文件中未检出重言式测试。

## 4. 守护测试有效性判读（真负向评估）

**真负向（违规会红）：**
- **workspace-identity-routing**(8)：真实 `schema.safeParse`——正向（identity→key）+ 负向（path-only-despite-identity 被拒 `:100-103`、remote-missing-identity 被拒 `:127`、address/meta 失配被拒 `:212`）。代理 N 的负向验证声称经阅读**成立**。
- **runtime-abort-concurrency**(6)：spawn **真实子进程**（`process.execPath` blocker），`waitUntil(started)` 后 `controller.abort()`，断言 `result.cancelled===true`/`status==='cancelled'`；pre-aborted 短路断言 `sawStarted===false` `:178`。真行为非 mock。
- **delivery-profile-contrast**(7)：真实 `applyConversationDeltas` 过两 profile 过滤器，断言终态逐字节相同 + 逐 profile 字段抑制。
- **resume-hydration-read-state**(6)：真实 Read→compact→hydrate→Edit IO 链，断言 Edit 不误报 FILE_NOT_READ。
- **snapshot-gap-repair**(10)：真实 `isWindowHostControllerFrameGap` seq/epoch/subscription 连续性。
- **rpc-descriptor-surface**：频道集 deepEqual（强于计数）+ 逐 descriptor 冻结/validator/interface 对齐。
- **registry-selection-speed-error**：错误码闭集 deepEqual（捕获删一加一漂移）。
- **cua-failclosed-gating**(9)：真实 `execute()` 返回 isError，断言 `isACodeCuaInternalFeatureEnabled({})===true`（订正上轮过期声称）。
- **model-option-map**(14)：真实 compile/evaluate + 原型污染检查 `:78`。
- **themeWriteOwnership / taskMetaCacheOwnership guards**：对单一写入者不变量真负向（全扫 + deepEqual offenders==[]）。

**仅结构性（诚实标注，非行为）：**
- splitPaneErrorIsolation：升级 3→8；5 个行为（getDerivedStateFromError + seeded render `:7`），3 个残留显式标注「结构守护测试，非行为验证」`:136,147`。

**e2e-smoke.mjs 是真实检查**（非桩）：CP1 进程存活 5s、CP2 DevToolsActivePort→CDP `/json/version`、CP3 首窗 page target + launchMarks、CP4 `[spawnHostProcess]` 日志；teardown `taskkill /T /F` → 轮询 `Get-CimInstance Win32_Process` 查残留 electron 引用 `:228-238` → rmSync + 验 `!existsSync` `:245` → `process.exit(code)` `:256`。真实验证进程树 + 临时目录清理。

## 5. 层面健康度

**良**。上轮全部 P1/P2 测试基建 finding 真实修复（descriptor deepEqual、speed 闭集、37 盲区测全真负向、6/6 临时目录泄漏修复、provider-node/server-cli 比例 ≥0.15、e2e:smoke 现发布门禁 fail-closed、台账重生成）。残留缺口全为 P3 且多为既有/环境类：client 包仍无测试、PS-13/14 8.3 类实际未硬化（afdd7c79 修的是另一对）、C1 墙钟 flake 完整保留、一处残留 mkdtemp 泄漏。不到优的原因：三个「已知失败」项被携带而非根治，且 afdd7c79 提交信息夸大了 PS-13/14 的范围。**零代码回归**——全量 5 个 fail 全为环境依赖的 MCP plugin-state 家族。
