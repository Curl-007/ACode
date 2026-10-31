# ACode 1.0.4 深度 Review · 架构治理与 CI/发布工程

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`。方法：只读源码审查 + 上轮（2026-10-22，基线 `ebe9033b`）治理修复逐条核验 + CI/发布 workflow 静态核对 + 台账全量比对。门禁实跑由主审统一执行，见总入口。总入口见 [../../project-review-2026-10-26.md](../../project-review-2026-10-26.md)。

范围：`scripts/architecture/**`、`architecture-policy.yaml`、`.architecture-baseline.json`、`knip.jsonc`、`.github/workflows/**`、third-party 台账、发布打包。

---

## 1. 上轮修复回归核对

| finding | 声称修复 | 核验结论 | 当前证据（file:line） |
|---|---|---|---|
| **R1-03 [P1]** CI 仅 ubuntu | 独立 `windows-verify` job（windows-latest，install→typecheck→lint→build CLI→core/services/shared 测试，`shell: bash`，Node 钉 24.14.0，无 `continue-on-error`） | **HOLDS** | `.github/workflows/ci.yml:132-174`；ci.yml 无 `continue-on-error`（grep 确认）；`afdd7c79` 证明它真跑过（见 §2） |
| **R1-04 [P1]** e2e:smoke 不进 CI | `desktop-smoke` job（windows-latest，`needs: verify`）；publish `needs: desktop-smoke` + `if …result=='success'` | **HOLDS** | `release.yml:96-127`（job）、`:770-775`（publish 门禁）。`always()` + 显式 `=='success'` = fail-closed：smoke 失败 → publish 跳过 → release 留 draft |
| resolver 缺口① exports map | `resolveExportsTarget`（精确 + 单 `*` 模式，`.d.ts`→null） | **HOLDS** | `policy.mjs:295-313`，接线 `:341-345` |
| resolver 缺口② glob 入口 | `publicEntrypointPatterns`（须含 `*`）、`globToRegExp`、`publicEntrypointMatches` | **HOLDS** | `policy.mjs:52-59,124-140,159-177`（fail-closed：未匹配模式 = 无入口） |
| resolver 缺口③ asset 豁免 | `global.assetExtensions` 显式，默认 `[]`=fail-closed | **HOLDS** | `policy.mjs:90-92`、`isAssetSpecifier:184-189`；`architecture-policy.yaml:346` = `[.css,.svg,.png,.mp3]`（与声称一致） |
| session 内部边白名单 | 24 条已登记边；新增边须显式登记 | **HOLDS（未增长）** | `architecture-policy.yaml:94-118` = **24 条**（主审亲验 `grep -c "{ from:"` = 24）；`publicEntrypoints: []` `:92`；机制 `internalEdgeAllowed:195-202`、`moduleHasBoundary:207-213` |
| **R2-09 [P2]** acode-cua 表述 | CONTRACT.md fail-closed 边界节 + `cua-failclosed-gating.test.mjs`（9 测） | **HOLDS** | `packages/acode-cua/CONTRACT.md:3-27`（逐表面精确措辞）；测试文件在位，**9 测**确认 |
| **R2-10 [P2]** formal-proof 零测试 | test 脚本 + `test/model.test.ts`（26 测） | **HOLDS** | `packages/formal-proof/package.json:14`（`node --import tsx --test`）；`test/model.test.ts` = **26 测**确认 |
| review 文档订正（cua 门控过期） | architecture-governance.md §5 + security.md §6 就地订正块 | **HOLDS** | `architecture-governance.md:57-61`；`security.md:71`——均关于 `isACodeCuaInternalFeatureEnabled` 默认 true、真 fail-closed = `shouldCreateDefaultCuaProductHelper` admission |
| **R2-12 [P2]** descriptor 阈值 | `>=40` 下限 → 频道名集合 deepEqual | **HOLDS** | `rpc-descriptor-surface.test.mjs:17-64`（40 频道）、`:157-161` `assert.deepEqual(uniqueChannels, REGISTERED_DESCRIPTOR_CHANNELS)`——捕获删一加一 |
| knip hints 2→1 | 删 desktop `yauzl` ignore；保留 `.acode/**` + 理由 | **HOLDS** | `knip.jsonc` desktop 块（`:19-58`）无 `yauzl`；`:252-266` `**/.acode/**` 保留 + 注释（hint 仅干净树触发） |
| 12 unlisted deps [P3] | server zod + core zod + node-repl-host sdk 声明 | **HOLDS（3 目标）** | `packages/server/package.json:58` `zod 4.6.5`；`core/package.json:53` `zod 4.6.5`；`node-repl-host/package.json:30` `@modelcontextprotocol/sdk ^1.29.0`。**主审亲验 lockfile importer**：node-repl-host 的 sdk `version: 1.29.0(zod@4.6.5)` 在 committed lockfile 中正确记录（typecheck 期的 turbo「node-repl-host not found」warning 是 turbo 工作区路径解析 quirk——包在 `apps/acode-cli/packages/` 而 turbo 找 `packages/`，非依赖缺口） |
| managed 覆盖 / web | 路线图登记；web 最优先（0.5-1 人日） | **PARTIAL（如设计）** | `docs/specs/architecture-coverage.md:88-117` 路线图在位。**web 仍 `managed: false`**（`architecture-policy.yaml:194`）——已登记，尚未纳管。managed 计数仍 **18** |

## 2. windows-verify 首跑证据（`afdd7c79`）——P1 修复在现实中生效

提交 `afdd7c79`（"fix(services): 两个测试的 tmpdir 8.3 短名归一——windows-verify 首跑暴露的既有脆弱性"）是 HEAD 的祖先，是 Windows leg 在真实 GitHub runner 上跑过并抓到真实失败的**直接证据**：

- **抓到的根因**：CI runner 的 `%TEMP%` 是 8.3 短名形态（`C:\Users\RUNNER~1\...`），但 `skillsService` 返回 realpath 归一为长名的 `skill.path`（`canonicalSkillPath`），C04e 的 `fsRealpath(linkPath)` 也返回长名 → 未归一的 fixture root 使 `startsWith`/相等断言失败（短 ≠ 长）。
- **修复的两个测试**（mkdtemp 前 `realpath(tmpdir())`）：`packages/services/test/skillsBundledScopeAndCacheAuthority.test.ts`（S1 bundled-scope）与 `packages/services/tests/windowsCuaDevRuntimeResolution.test.mjs`（C04e 真 symlink dev-root 拒绝）。
- **为何重要**：提交信息明说这两个测试**从未在 Windows 跑过**（CI 曾 ubuntu-only，它们总走 posix 分支 = 恒绿）。windows-verify leg 的**首跑**暴露了它们——坐实 R1-03 的前提（win32 专有脆弱性藏在全绿 Linux 门禁后）。断言**未被放宽**（spec 规则 6），与仓库既有防御一致（`subagent-worktree-isolation.test.mjs:46`）。
- **注意**（见测试专项 §3）：afdd7c79 修的是这两个 services 测试，**不是** apps/acode-cli 的 PS-13/PS-14 powershell 8.3 短名测试——后者仍未硬化，但 CI 不可见（windows-verify 只跑 core/services/shared）。

## 3. 新发现

| 级别 | 问题 | 位置 | 证据 | 定性 |
|---|---|---|---|---|
| **P3** | 基线 JSON 条目计数 vs 工具报告 over-limit 不对账（差 7，含陈旧条目） | `.architecture-baseline.json` | committed 文件有 **419** 条条目，在 `ebe9033b` 与 HEAD **逐字节相同**（`git diff --stat` 空）。主审亲验：**419 条全部是 `max-file-lines`、0 条指向测试文件**——故 419 与工具口径 legacy over-limit **412** 的差 = **7 条陈旧条目**（文件已缩到 400 以下、或 gitignored 构建产物如 relay-server.mjs，未从基线剔除）。这是**保守**方向：基线多计不会掩盖**新**违规（new/regrown 仍按当前树实算），但 7 条陈旧条目意味着棘轮「只减不增」的减数被虚高、且基线含不再存在的超限事实。主审实跑工具口径：`--changed` 与全量均报 **violations 412 / new 0 / regrown 0**（见总入口门禁节），legacy over-limit 414→**412**（棘轮收紧 2）。**修复入口**：`architecture:baseline:update` 重生成基线剔除 7 条陈旧项，使基线数字与真实超限集一致 | Confirmed（主审亲验 419 全 max-file-lines/0 测试文件；工具报 412） |
| **P3** | 便携 zip 结构检查偏粗 | `release.yml:687-701` | `Get-ChildItem -Filter '*.exe' \| Select-Object -First 1` 断言「存在某 exe」，非特指 `ACode.exe`；且内层便携 exe 的 Authenticode 签名即便 `WIN_SIGNING=true` 也**不校验**（注释 `:704` 刻意把签名检查限定于顶层 nsis `.exe`）。影响低：当前 Windows 发布未签名，且它也检查 `resources/app.asar` 存在 | Confirmed |

无 P1/P2 新发现。

## 4. 发布工程健康度

**zip 打包（`6b0cff63`）——健全，无新供应链表面：**
- `win.target: ["nsis","zip"]`（`electron-builder.config.js:776`）。zip 是对 nsis 安装器所用**同一** win-unpacked app 目录的再归档——相同 `afterPack` 管线（asar 完整性刷新、原生资源策略、node-pty prebuild 断言、install-manifest 写入对 win32 均运行，与 target 无关）。不拉新依赖。
- **自动更新表面未变**：zip 经 `ArchiveTarget(isWriteUpdateInfo=false)` 创建 → **不写 latest.yml**；`NsisUpdater` 仍只消费 `.exe`。提交信息以真实本地 electron-builder 运行佐证（exe 169.6MiB + zip 232.7MiB，latest.yml 只指向 `.exe`）。
- **verify_assets**（`release.yml:661-701`）下载两产物、各做 sha256 + 50MiB 尺寸下限、加 zip 解压结构抽查（解到子目录，避免污染顶层 exe）。上传步已无条件 glob `*.zip`（`:485`）。
- 发布说明诚实边界（`:232,267`）：「免安装」非数据便携（用户数据仍在 `%APPDATA%\ACode`）。

**台账（`88a31ce3`）——一致（主审工具实跑亲验）：**
- 主审在干净 committed 树上实跑 `node scripts/licenses.mjs reproducibility --inputs-only` → **exit 0，「2902 项源文件哈希全部相符」**。修复轮的 9 个不符哈希已解（CI Linux run 39737772095 重生成；`hasown@2.0.2` dedupe 移除）。`noticesSha256` 同提交更新（`80f2c0bc→99af6726`）。
- 代理侧全量比对补充：2902 条 inputs 中唯一曾观察到的漂移是 `pnpm-lock.yaml` 的 `patch_hash` 编码格式——那是**本机未提交修改**（主审 pnpm 9.10.0 vs 钉定 10.33.2 的版本产物，同版本同 patch），已 `git checkout` 还原，还原后工具全绿。committed 树无任何台账漂移。

## 5. 层面健康度

**优**。两个 P1 CI 缺口（R1-03 windows-verify、R1-04 desktop-smoke）以 fail-closed 接线保持，无 `continue-on-error`；R1-03 被 `afdd7c79` 首跑抓到两个从未在 Windows 跑过的测试**证明为活**。三个 resolver 缺口 + session 白名单（仍精确 24 边，未增长）机械在位；R2-09/R2-10/R2-12、knip hints、3 个目标依赖声明全部保持；review 文档 cua 订正在两文件落地。发布工程健全：新 zip 加零供应链表面、零自动更新表面，committed 第三方台账一致（2901/2902，唯一漂移是本机未提交 lockfile 格式迁移）。仅开放项是 by-design 路线图工作（web 仍 `managed:false`，覆盖 18 managed / 5 legacy 未变）与两个 P3 观察（基线计数 vs 文档对账、偏粗的 zip 结构检查）——均非回归。
