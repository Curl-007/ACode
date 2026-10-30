# CI 平台矩阵与 Desktop smoke 门禁

## 背景与根因

2026-10-22 深度 review（`docs/reviews/2026-10-22/testing.md`）标记两条 P1 门禁缺口：

- **R1-03 CI 仅 ubuntu**：`.github/workflows/ci.yml` 全部 `runs-on: ubuntu-latest`，无平台矩阵。
  近期至少 3 个已修 bug 是 Windows 文件系统语义专有——`66a11532`（read-state win32 大小写）、
  `01d457f8`（prompt-routing walk-up）、8.3 短名处理（`bash-target-blast-radius.test.mjs:506`
  注释「%TEMP% 在本机是 8.3 短名」）。这些逻辑在 Linux CI 上**永远走 posix 分支**，回归无法被拦。
- **R1-04 `e2e:smoke` 不进任何 CI workflow**：`packages/desktop/scripts/e2e-smoke.mjs`（383 行，
  CP1-CP4 检查点 + 进程树/临时目录清理，`process.exit(code)` 正确传非零）仅手工/Windows 本地执行，
  Electron 启动链路无自动回归。`grep e2e:smoke .github/workflows/` 无命中。

本 spec 登记两处门禁的范围、所有者与验收，作为 workflow 改动的单一真源。

## 规则与所有者

### R1. Windows 平台 leg（ci.yml）

1. ci.yml 新增**独立 `windows-verify` job**（`runs-on: windows-latest`），**不**把既有 `verify`
   改成 matrix。理由：matrix 会让主门禁（ubuntu）与 Windows leg 共享 job 身份，Windows 首跑
   若暴露既有 win32 失败会连带弄红/拖慢主门禁；独立 job 让两者失败面隔离、可分别定位。
2. Windows leg 步骤范围（与 `verify` 对齐但只取跨平台高价值子集）：
   - `pnpm install --frozen-lockfile`；
   - `pnpm typecheck`（单一入口 `scripts/typecheck-gate.mjs`，见 cli-validation-gates.md 规则 5，
     workflow 里含 `typecheck` 的 `run` 必须逐字 `pnpm typecheck`，不得内联单入口）；
   - `pnpm lint`；
   - `core / services / shared` 三包测试：`pnpm --filter @acode/core test`、
     `pnpm --filter @acode/services test`、`pnpm --filter @acode/shared test`。
3. `core` 测试经 tsx 引 apps/acode-cli 源码，源码按包名解析兄弟包 `@acode/contracts` 的 `dist/`
   （`main: ./dist/index.js`）。干净检出无 dist 会 `ERR_MODULE_NOT_FOUND`。故 core 测试前保留
   `Build CLI workspace packages`（turbo，与 `verify` 同因同命令）。services/shared 的依赖经
   `src/*.ts` 直接解析，不需 dist，但同批构建成本已被 core 覆盖，不单独拆分。
4. **工具链对齐**：Node 固定 `24.14.0`（对齐 `mise.toml`，而非其他 job 的 `24`——Windows leg 的
   目标是可复现 win32 行为，钉死次版本消除 runner 漂移）；pnpm 经 `pnpm/action-setup@v4`
   `version: 10.33.2`（与全仓既有 job 同款；等价于 corepack 钉版，不另引入 corepack 以免与
   既有 job 分歧）。`run` 统一 `shell: bash`（windows-latest 自带 Git Bash），消除 pwsh/bash
   在 `--filter`、glob、退出码上的语义差异。
5. **缓存纪律**：`warm-cache.yml` 只生产 Linux 条目（`pnpm-store-Linux-*`），Windows 无对应
   生产者。Windows leg **不加**任何 `actions/cache`、**不用** `setup-node` 的 `cache: pnpm`
   （后者会 save，违反 omp「只 restore 不 save」教训并吃配额）。代价是每次冷装依赖；若后续
   Windows leg 稳定，再由 `warm-cache.yml` 增开 Windows 生产者，键前缀改 `pnpm-store-Windows-`。
6. **失败处置**：Windows leg 是**必需** job（不设 `continue-on-error`）。若首跑暴露既有 win32
   真实失败，**不为过 CI 而跳过/放宽测试**——按 AGENTS.md 如实登记待修项并修复源码。退一步的
   分批方案（仅在失败面过大无法一次落地时）：先只跑 `typecheck + lint + shared 一包`，其余分批，
   并在本 spec 追记分批计划与原因。

### R2. Desktop smoke leg（release.yml）

7. release.yml 新增**独立 `desktop-smoke` job**（`runs-on: windows-latest`），跑
   `pnpm --filter @acode/desktop e2e:smoke`。选 Windows 而非 Linux：smoke 的进程树清理用
   `taskkill /T /F`（Windows 原生路径，见 e2e-smoke.mjs:213），且脚本注释与历史验收均以
   Windows isolated-profile 为准；Linux 需 `xvfb-run` 提供虚拟显示，可靠性未知，不采用。
8. smoke 启动的是**已构建的 dev 态 Electron**（`out/main/index.js`，desktop package.json `main`），
   CP4 还会 fork Host utility process。故 smoke 前必须构建：先 `Build CLI workspace packages`
   （agent bundle 消费 `apps/acode-cli/packages/cli/dist/acode.cjs`），再
   `pnpm --filter @acode/desktop build`（`prepare:runtime-assets` + tsup + vite 产出 `out/`）。
9. smoke 失败**必须阻断发布**：`desktop-smoke` 纳入 `publish` 的 `needs`，`publish` 的 `if`
   增 `needs.desktop-smoke.result == 'success'`。**不设** `continue-on-error: true`。
   `desktop-smoke` `needs: verify`（基础门禁红则不浪费 Windows runner），与 `release` 并行。
10. **ci.yml 不跑 smoke**：smoke 需 GUI/显示环境 + 完整桌面构建（agent bundle + tsup + vite，
    分钟级），放进每次 push/PR 的主门禁成本过高且拖慢反馈。分工：**smoke 只在 release.yml 作
    发布门禁**（发布是低频、高价值、需要启动链路确证的时刻）；ci.yml 的 Windows leg 覆盖
    跨平台**单元/集成**回归（R1），两者互补不重叠。此分工是本 spec 的正式结论。

### R3. 发布产物校验 leg（release.yml `verify_assets`）

11. `verify_assets` 下载各平台发布产物后做结构/尺寸/哈希/签名校验。Windows leg 校验**两个**产物：
    安装版 `ACode-<VERSION>-win-<arch>.exe`（nsis）与免安装版 `ACode-<VERSION>-win-<arch>.zip`。
    二者各做 sha256 + 50MiB 尺寸下限；zip 额外解压做结构抽查。
12. **zip 结构检查按产品名精确断言主 exe**（26R2-03）：解压到子目录 `zip-extracted` 后，必须
    `Test-Path ACode.exe`（产品名取自 `desktop-product-identity.mjs` production 身份
    `productName: "ACode"`，release 说明 :232/:267 亦以此名指引用户运行），并 `resources/app.asar`
    在场。**不得**退回 `Get-ChildItem -Filter '*.exe' | Select-Object -First 1`——那只证明「存在
    某个 exe」，主 exe 改名/缺失而其他辅助 exe 在场仍会通过。解压到子目录是为避免污染顶层
    `assets\*.exe`（顶层 glob 非递归，只匹配 nsis 安装包）。
13. **签名校验覆盖内层便携 exe**（26R2-03）：`WIN_SIGNING=true` 时，除顶层 nsis 安装包外，
    `zip-extracted\ACode.exe`（内层便携 exe）的 Authenticode 也必须为 `Valid`。zip 与 nsis 共用
    同一 win-unpacked app 目录，签名开启时内层 exe 同样已签名；此前只校验顶层安装包，内层便携
    exe 即便 `WIN_SIGNING=true` 也不检查。未签名（`WIN_SIGNING != 'true'`）时走 `Signature note`
    步显式跳过（当前仓库未配置 Windows 签名 secrets，三态 none）。

## 与既有门禁的关系

- cli-validation-gates.md 规则 3/5：`typecheck` 单一入口约束继续适用——Windows leg 的 typecheck
  `run` 逐字 `pnpm typecheck`，不内联 renderer/CLI 单入口。
- git-collaboration.md「发布与版本」：release 门禁全绿定义不变（verify/licenses-notices 等专项）；
  `desktop-smoke` 是**追加**的发布级闸门，使全绿定义额外包含「Electron 启动链路 smoke 通过」。
  不放宽任何既有闸门。

## 验收

1. ci.yml 出现 `runs-on: windows-latest` 的独立 job，跑 install + typecheck + lint + core/services/shared
   三包测试；job 失败可使 CI 整体红（必需 job）。
2. 复现历史 win32 bug：注入一个只在 Windows 大小写/8.3 短名语义下失败的用例时，Windows leg 红、
   ubuntu leg 绿（证明矩阵不再对 win32 恒绿）。
3. release.yml 出现 `desktop-smoke` job（windows-latest），构建桌面后跑 `e2e:smoke`；smoke 非零退出
   → `publish` 不执行 → release 保持 draft。
4. 两个 workflow 所有含 `typecheck` 的 `run` 仍逐字 `pnpm typecheck`（cli-validation-gates 规则 5）。
5. Windows leg 与 smoke leg 均无 `continue-on-error`、无 `setup-node` 的 `cache: pnpm`、无
   `actions/cache` save（缓存纪律）。
6. release.yml `verify_assets` 的 zip 结构检查按名断言 `ACode.exe`（非「某 exe 存在」）；
   `WIN_SIGNING=true` 的签名校验步同时校验顶层 nsis 安装包与 `zip-extracted\ACode.exe` 内层
   便携 exe 的 Authenticode。YAML 可解析、步骤顺序为「结构检查 → 签名校验」（签名步依赖结构步
   的解压产物）。

## 未验证边界

CI/workflow 改动无法本地实跑（禁止 push 触发真实 runner）。验收 1-5 以**静态核对 YAML + 与既有
job 对齐**为准；首次真实 runner 结果为准绳，Windows leg 可能暴露既有 win32 失败（R1 的目的），
smoke leg 的构建时长与 GUI 可用性以首跑为准。
