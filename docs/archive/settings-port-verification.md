# 设置面两项功能移植独立验收报告

- 验收日期：2026-10-20
- 验收人：verifier（独立验收，未参与实现）
- 目标仓库：`D:\AnkerCodes\QYDemo\ACode1`
- 分支 / HEAD：`dev/1.0.1` @ `38b93920`
- 源仓基线：`D:\Leo1\project\demo\anker-code` @ `cf34bef9`（只读对照）
- 验收范围：仅两项功能——(1) 子智能体批量编辑升级；(2) 新建任务默认值全链移植。
  目标工作树同时存在 AgentTeams 0.4.0、usage-bar、团队侧栏等并行批次改动，不在本报告判定范围。
- 验收快照：2026-10-20 14:00–14:35 +0800。工作树被并发修改，行号只作定位辅助。
- 结论：**通过（有条件）**。t-2/t-3/t-4 的两项功能主链、R1 批量语义、R2 端到端与
  旧设置兼容均通过；t-6（applying 行选择禁用）与 t-7（speed 运行时投影、未用导出、
  services salvage 测试）已交付并独立复核通过。条件项：CLI 全量仍有 4 项既有红 +
  1 项已证实可单跑的 flake；全量定向 `oxfmt --check` 仍因 HEAD 既有 `update.recovery.*`
  格式债 exit 1（本功能行无偏差）；桌面/浏览器视觉与交互、无 jsdom 的渲染级场景未验证。
  另有 1 项 P3 规格偏差（applying 时搜索未禁用，源仓同）登记待裁决。
  验收人未修改任何源码，仅新增本报告。

## 1. 验收结论摘要

| #   | 必修/登记                        | 问题                                                                                                     | 依据                                                                                                                                      | 严重度       |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 1   | 已修复（t-6）                    | 批量应用进行中，行复选框与行点击不可改选中；复选框保留渲染但置灰                                         | 复核证据见 §9.1：`SubagentsSection.tsx:699-701,762,1833,2276-2277`；wiring 测试 `:86-112`；UI 450/450                                     | —            |
| 2   | 已修复（t-7）                    | 运行时投影不再含 `speed`；speed-only 返回 null（等价未固定）；`ResolvedNewTaskDefaults` 改为模块内非导出 | 复核证据见 §9.2：`packages/ui/src/lib/newTaskDefaults.ts:13-17,25-31`；`ui/test/newTaskDefaults.test.ts:51-53,96-108`；knip 该符号 0 命中 | —            |
| 3   | 登记                             | 批量应用进行中搜索框未禁用                                                                               | t-1 §1.5 #16 要求禁用退出/搜索/新建；`packages/ui/src/settings/SubagentsSection.tsx:2333-2342` 未传 `disabled`（源仓同样未禁用）          | P3           |
| 4   | 登记（规格将修订，不计代码缺口） | 模型目录未就绪时「模型」行被禁用；captain 裁决按源仓实现，spec-writer 修订 t-1 §2.8/#10                  | `packages/ui/src/settings/TaskDefaultsSection.tsx:321`；源仓 `TaskDefaultsSection.tsx:358` 同样禁用；captain 消息 `f3b3b7b8`              | —            |
| 5   | 已修复（t-7）                    | 补 `packages/services/tests/settingsExplicitKeyPersistence.test.mjs` 的 `newTaskDefaults` 用例           | 6/6 通过；`:168-217` 覆盖旧设置缺席/显式 patch/不被 strip                                                                                 | —            |
| 6   | 已修复（t-7）                    | knip 不再出现 `ResolvedNewTaskDefaults`                                                                  | 最终 `pnpm knip`：Unused exported types 878，`grep ResolvedNewTaskDefaults` 0 命中；见 §2.11                                              | —            |
| 7   | 登记                             | `pnpm --dir apps/acode-cli test` 最终 5 个失败：4 项确定性既有红 + 1 项 flake                            | 4 项为设计令牌 CRLF 与 browser-use marker；`mcp-startup-gate-deferred-tools` 单跑 9/9 exit 0；见 §2.5、§2.11                              | 不计入本功能 |

## 2. 门禁结果（真实命令与退出码）

本节为 **t-6 / t-7 交付前的首轮**结果；t-6/t-7 交付后的最终结果见 §2.11。
所有命令均在目标仓库根目录执行；退出码用 `cmd > log 2>&1; echo EXIT=$?` 直接获取，未用管道吞码。
日志目录：`C:\Users\admin\AppData\Local\Temp\acode1-settings-verify\`。

| #   | 命令原文                                                                                                              | 退出码 | 结果摘要                                                                                                                                                | 日志                                       |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | `pnpm --filter @acode/ui test`                                                                                        | **0**  | tests 449 / pass 449 / fail 0                                                                                                                           | `ui-test.log`                              |
| 2   | `pnpm --filter @acode/shared test`                                                                                    | **0**  | tests 280 / pass 280 / fail 0（两次运行均为 0）                                                                                                         | `shared-test.log`、`shared-test-rerun.log` |
| 3   | `pnpm --filter @acode/provider test`（补充）                                                                          | **0**  | tests 32 / pass 32 / fail 0                                                                                                                             | `provider-test.log`                        |
| 4   | `pnpm typecheck`                                                                                                      | **0**  | packages 2.7s / desktop-renderer 2.6s / cli 0.7s；通过                                                                                                  | `typecheck.log`                            |
| 5   | `node node_modules/typescript/bin/tsc -b --force packages/shared packages/provider packages/ui`（补充，绕开增量缓存） | **0**  | 无输出，强制重查三包通过                                                                                                                                | `tsc-force.log`                            |
| 6   | `pnpm lint`                                                                                                           | **0**  | Found 166 warnings and 0 errors                                                                                                                         | `lint.log`                                 |
| 7   | `pnpm architecture:check --changed`                                                                                   | **0**  | violations 359 / baseline 359 / new 0 / regrown 0                                                                                                       | `architecture.log`                         |
| 8   | `node_modules/.bin/oxfmt --check <27 个本功能文件>`                                                                   | **1**  | 仅 `packages/ui/src/i18n/locales/en-US.ts`、`zh-CN.ts` 被标记；见 §2.6                                                                                  | `oxfmt.log`                                |
| 9   | `pnpm --dir apps/acode-cli test`                                                                                      | **1**  | tests 2943 / pass 2903 / fail 4 / skipped 36                                                                                                            | `cli-test.log`                             |
| 10  | `pnpm knip`                                                                                                           | **1**  | Unused files 1 / Unlisted dependencies 11 / Unused exports 784 / Unused exported types 879 / Unused exported namespace members 1 / Duplicate exports 39 | `knip.log`                                 |
| 11  | `node --import tsx <临时探针>`（旧设置兼容，见 §2.10）                                                                | **0**  | `PROBE OK`                                                                                                                                              | `settings-compat-probe.log`                |

### 2.1 与既有基线对照

| 项                                  | 既有记录                                      | 本次                                           | 判定                                     |
| ----------------------------------- | --------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| `pnpm typecheck`                    | `docs/archive/agent-teams-port-verification.md` §1：0 | 0                                              | 无回归                                   |
| `pnpm lint`                         | 同前：0，166 warnings                         | 0，166 warnings                                | 无回归                                   |
| `pnpm --filter @acode/ui test`      | 同前：424 pass                                | 449 pass                                       | 通过（新增用例）                         |
| `pnpm --filter @acode/shared test`  | 同前：267 pass                                | 280 pass                                       | 通过（新增用例）                         |
| `pnpm --dir apps/acode-cli test`    | 同前：2935 tests / 8 fail                     | 2943 / 4 fail                                  | 通过（失败数减少，余下 4 项归因见 §2.5） |
| `pnpm fmt:check`                    | 同前：既有 CRLF 红                            | 本报告只做定向 oxfmt；失败行经核对为 HEAD 既有 | 非本批引入                               |
| `pnpm architecture:check --changed` | 同前：358/358/new 0                           | 359/359/new 0                                  | 无回归                                   |

### 2.2 `packages/ui` 测试（exit 0）

- tests 449 / suites 8 / pass 449 / fail 0。
- 本功能新增/相关用例实际执行并通过，日志可见：
  - `packages/ui/test/newTaskDefaults.test.ts` 6 项（日志 `ui-test.log:150-154`）；
  - `packages/ui/test/newTaskDraft.test.ts` 5 项（`:155-158`，另有「解析结果一致返回原对象」）；
  - `packages/ui/test/composerRecentReasoningPick.test.ts` 7 项（`:34-40`）；
  - `packages/ui/test/subagentBatchWiring.test.ts` 9 项（`:272-280`）；
  - `packages/ui/test/taskDefaultsLocaleKeys.test.ts` 2 项（`:296-297`）；
  - `packages/ui/test/subagentModelBatchApply.test.ts` 10 项。

### 2.3 `packages/shared` 测试（exit 0）

- tests 280 / pass 280 / fail 0。
- 新用例逐条执行：schema 默认值、未知字段 strip、旧 setting.json 补齐、object 面保留、非法值拒绝、
  patch 整份替换、mode 归一化（含 `dontAsk`、`plan`）、`defaultReasoningLevelPick` 合法/非法
  （`shared-test-rerun.log:112-119`）。

### 2.4 类型、Lint、架构（均 exit 0）

- `pnpm typecheck` exit 0；为避免 `tsc -b` 增量假绿，另跑强制三包编译 exit 0。
- `pnpm lint` exit 0，166 warnings / 0 errors，与既有基线 166 相同。
- `pnpm architecture:check --changed` exit 0：violations 359 = baseline 359，new 0，regrown 0。

### 2.5 `pnpm --dir apps/acode-cli test`（exit 1，4 项失败均非本批）

tests 2943 / pass 2903 / fail 4 / skipped 36。逐项归因：

| 失败测试                                                                                  | 原因                                                                                               | 归因证据                                                                                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `tests/generate-visualize-design-tokens.test.mjs:30`「产物与 DESIGN.md 重生成逐字节一致」 | 生成产物为 CRLF、脚本期望 LF；差异只在 `\r`                                                        | 日志 `cli-test.log` tail「actual ... \r」；该产物与 `DESIGN.md` 均不在本批 diff                                |
| 同文件「--check 对当前树退出码 0」                                                        | 同上                                                                                               | 同上                                                                                                           |
| 同文件「@generated 头纪律」                                                               | 同上                                                                                               | 同上                                                                                                           |
| `tests/skill-seeding-integration.test.mjs:84`「播种→归因→幂等」                           | `ENOENT ...browser-use\0.5.1\.acode-plugin-seed.json`；该 marker 是 `.gitignore` 产物/既有测试缺陷 | 错误信息 `ENOENT`（日志 `cli-test.log`）；前次验收 `docs/archive/agent-teams-port-verification.md` §4.2 已记录同一失败 |

上述四个失败与 `packages/ui`、`packages/shared`、`packages/provider` 的本批改动无调用关系；
本批未修改 `DESIGN.md`、设计令牌产物或 browser-use 插件。
t-6/t-7 交付后的最终跑为 5 fail：上述 4 项 + `mcp-startup-gate-deferred-tools` flake
（单跑 9/9 exit 0），见 §2.11。

### 2.6 定向 oxfmt（exit 1，失败点为 HEAD 既有）

命令覆盖 27 个本功能文件（shared/provider/ui 源码、测试、locale）。输出只标记两个 locale 文件。

为区分「真实格式偏差」与「CRLF 环境噪声」：

1. 两个文件当前为纯 LF（`CRLF 0 / LF 6946`、`CRLF 0 / LF 6661`），不是 CRLF 噪声。
2. 用 `oxfmt` 写临时副本后 diff，全部差异集中在
   `update.recovery.installNotEffective` 等 6 个键的换行（en-US 约 1385 行、zh-CN 约 1303 行）。
3. `git diff -U0` 对这两个文件不含 `update.recovery` 行；`git show HEAD:` 版本同样被 `oxfmt --check` 判失败
   （临时副本 exit 1）。

结论：**这 6 行是 HEAD 既有格式债，不是本功能新增行**。本功能新增的
`settings.taskDefaults.*` 与 `settings.subagents.batch.*` 键块在归一化 diff 中无变化。
按「只做定向、不动范围外」纪律，未修改这两处既有行。
t-6/t-7 改动的 5 个文件单独跑 `oxfmt --check` 为 **exit 0**（§2.11 #7）。

### 2.7 knip（exit 1）与基线 803 对比

`knip.plain.log` 各节真实计数：

| 节                                | 计数    | 与本功能关系                                                                                                                |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Unused files                      | 1       | `apps/acode-cli/.../usage.test.ts`，非本功能                                                                                |
| Unlisted dependencies             | 11      | 均为既有脚本/配置                                                                                                           |
| **Unused exports**                | **784** | 比 dispatch 基线 **803 少 19**；本功能新增的值导出均未进入该节                                                              |
| **Unused exported types**         | **879** | 含 **1 个本功能新增项**：`ResolvedNewTaskDefaults` @ `packages/ui/src/lib/newTaskDefaults.ts:12:18`（`knip.plain.log:956`） |
| Unused exported namespace members | 1       | 非本功能                                                                                                                    |
| Duplicate exports                 | 39      | 非本功能                                                                                                                    |

说明：dispatch 的「803 unused exports」未注明是否只统计 `Unused exports` 节。按同名节比较为
784（净减 19，无新增）。本节 `ResolvedNewTaskDefaults` 的 1 项新增已由 t-7 关闭；
最终计数见 §2.11。
`packages/ui/src/settings/settingsPageConfig.ts:188` 的 `SETTINGS_SECTIONS` 也出现在未使用导出列表，
但 `git show HEAD:` 已存在（HEAD:179），不是本批引入。

### 2.8 未使用导出修复（已由 t-7 完成）

`ResolvedNewTaskDefaults` 原本只在本文件内被消费。t-7 已把 interface 改为非导出并删除
`speed` 字段，同时落实 t-1 §2.6.1 的运行时投影要求；复核见 §9.2。

### 2.9 类型与架构补充

- 强制 `tsc -b --force packages/shared packages/provider packages/ui` exit 0，排除增量缓存假绿。
- `architecture:check --changed` 的 359 条 violations 与 baseline 相等，new/regrown 均为 0；
  本功能没有新增架构违规。

### 2.10 旧设置文件兼容（临时探针，exit 0）

以 `createSettingService()` + 临时 `ACODE_DESKTOP_HOME_DIR` 验证（不写仓库）：

1. 旧 `setting.json` 无 `newTaskDefaults`：`get()` 得到
   `{enabled:false,mode:null,model:null,reasoningLevel:null,speed:null}`；文件未被物化写入；
   `get()` 前后字节一致。
2. 显式 `update({newTaskDefaults:{enabled:true,mode:"dontAsk",model:{...},reasoningLevel:"high",speed:"fast"}})`
   后整份对象落盘（含 additive `speed`）。
3. 之后仅 `update({locale:"en-US"})`，已落盘的 `newTaskDefaults` 保持不变。
4. 旧文件带 `newTaskDefaults.futureField`：读取被 strip，不报错；`mode:"plan"` 在 schema 层保留，
   运行时由 `resolveNewTaskDefaults` 归一为 null。

探针输出 `PROBE OK`。对应真实 settingService 的「只写显式键」实现：
`packages/services/src/setting/settingService.ts:317-357`、`normalizeSettingsPatch.ts:3-4`。

### 2.11 t-6 / t-7 交付后的最终门禁（2026-10-20 ~14:28）

| #   | 命令原文                                                                                          | 退出码 | 结果摘要                                                                                 | 日志                          |
| --- | ------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | `pnpm --filter @acode/ui test`                                                                    | **0**  | tests 450 / pass 450 / fail 0（t-6 新增 1 项断言）                                       | `ui-test-final.log`           |
| 2   | `pnpm --filter @acode/shared test`                                                                | **0**  | tests 280 / pass 280 / fail 0                                                            | `shared-test-final.log`       |
| 3   | `node --import tsx --test packages/services/tests/settingsExplicitKeyPersistence.test.mjs`        | **0**  | tests 6 / pass 6 / fail 0（含 newTaskDefaults salvage）                                  | `services-explicit-final.log` |
| 4   | `pnpm typecheck`                                                                                  | **0**  | packages / desktop-renderer / cli 全部通过                                               | `typecheck-final.log`         |
| 5   | `pnpm lint`                                                                                       | **0**  | 166 warnings / 0 errors                                                                  | `lint-final.log`              |
| 6   | `pnpm architecture:check --changed`                                                               | **0**  | violations 359 / baseline 359 / new 0 / regrown 0                                        | `architecture-final.log`      |
| 7   | `node_modules/.bin/oxfmt --check <t-6/t-7 改动的 5 个文件>`                                       | **0**  | All matched files use the correct format                                                 | `oxfmt-final.log`             |
| 8   | `node_modules/.bin/oxfmt --check <27 个本功能文件>`（含 locale）                                  | **1**  | 仍只标记 en-US/zh-CN 的 HEAD 既有 `update.recovery.*` 行；本功能行无偏差                 | `oxfmt.log`                   |
| 9   | `pnpm --dir apps/acode-cli test`                                                                  | **1**  | tests 2943 / pass 2902 / fail 5 / skipped 36                                             | `cli-test-final.log`          |
| 10  | `node --import tsx --test tests/mcp-startup-gate-deferred-tools.test.mjs`（cwd=`apps/acode-cli`） | **0**  | 9/9 pass，证实 #9 的第 5 个失败是 flake                                                  | `mcp-gate-rerun.log`          |
| 11  | `pnpm knip`                                                                                       | **1**  | Unused exports 784（< 803）；Unused exported types 878；`ResolvedNewTaskDefaults` 0 命中 | `knip-final.log`              |

最终 CLI 5 个失败：3 个 `generate-visualize-design-tokens`（CRLF 产物漂移）、1 个
`skill-seeding-integration`（browser-use marker ENOENT）为确定性既有红；
`mcp-startup-gate-deferred-tools.test.mjs:305` 单跑 9/9 通过，为已知 flake。均非本功能引入。

## 3. t-5 验收项逐条结论

| 验收项                                                                                | 结论                          | 证据                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 逐条核对 t-1 规格与 t-2/t-3/t-4 验收标准，给出 pass/fail 与文件:行号               | **PASS（依据 captain 摘要）** | t-1 与 §4 已逐项核对；t-2/t-3/t-4 任务记录在 member 视图不可见，captain 在消息 `f3b3b7b8` 给出验收摘要，逐条对照见 §3.1。原始任务记录仍不可见，属信息口径限制                                       |
| 2. 批量编辑：分组菜单/组全选/可批量判定/批量结果/写路径/i18n 与源仓语义一致，且有测试 | **PASS**                      | 分组菜单、组/全局全选、三态、写路径、结果汇总、i18n 均通过；t-6 后 applying 行选择已禁用（`SubagentsSection.tsx:699-701,762,1833`；wiring 测试 `:86-112`）。搜索未禁用作为 P3 规格偏差登记（§1 #3） |
| 3. 任务默认值端到端；旧设置文件兼容                                                   | **PASS**                      | 设置页 → schema → 草稿 → 模型切换/档位叠加/权限模式静态链路与单测通过；旧设置探针 exit 0；t-7 后运行时投影去 speed、services salvage 测试 6/6；#4 已由 captain 裁决为规格修订                       |
| 4. 门禁真实退出码                                                                     | **PASS（含 1 项既有红）**     | 最终：ui 450/450、shared 280/280、provider 32/32、typecheck/lint/architecture 0；t-6/t-7 改动文件定向 oxfmt 0；全量 27 文件 oxfmt exit 1，失败行为 HEAD 既有                                        |
| 5. 补跑 CLI/shared、knip 与 803 对比，无新增未使用导出                                | **PASS（含既有红）**          | 最终 CLI 2943 tests / 2902 pass / 5 fail（4 项确定性既有 + 1 项 flake 单跑 9/9 通过）；shared 280/280；knip `Unused exports` 784 < 803，本功能符号 0 命中                                           |
| 6. 报告写入 `docs/archive/settings-port-verification.md`，含未验证项；不改源码                | **PASS**                      | 本文件；验收人未改源码，仅新增本报告                                                                                                                                                                |

### 3.1 t-2 / t-3 / t-4 验收摘要对照（captain 消息 `f3b3b7b8`）

原始任务记录在 member 视图不可见，以下按 captain 提供的验收摘要逐条核对目标工作树：

| 任务          | captain 摘要条目                                            | 本报告核对结果                                                                                     |
| ------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| t-2 批量编辑  | 分组「…」菜单                                               | PASS（`SubagentsSection.tsx:554-610`，测试 `subagentBatchWiring.test.ts:84-99`）                   |
| t-2           | 组/全局全选、三态                                           | PASS（`:612-654,2086-2115,2343-2366`；测试 `:100-114`）                                            |
| t-2           | 整批推荐、thoughtLevel 合并写盘                             | PASS（`:1913-1951,1864-1906`；测试 `:116-135`）                                                    |
| t-2           | 档位徽标                                                    | PASS（`:708-714,775-779`）                                                                         |
| t-2           | entry/exit TID、batch.\* i18n                               | PASS（`:145-149,2333-2390`；locale 成对测试通过）                                                  |
| t-2           | Bar/Dialog/Apply 与源仓仅差 speed                           | PASS（`SubagentModelBatchApply.ts:132-170`；Bar/Dialog 无 speed；测试 10 项）                      |
| t-2           | SubagentsSection 豁免 400 行                                | PASS（2546 行，architecture new/regrown 0；测试文件不参与 ratchet）                                |
| t-2           | applying 行禁用缺口转 t-6                                   | **PASS（t-6 已复核）**，见 §9.1                                                                    |
| t-3 数据面    | new-task-defaults schema/DEFAULT                            | PASS（`new-task-defaults.ts:29-49`；shared 测试）                                                  |
| t-3           | `AppSettings.newTaskDefaults` + `defaultReasoningLevelPick` | PASS（`protocol.ts:395-397`；`validationAppSettings.ts:522-529,622-623`）                          |
| t-3           | lib/newTaskDefaults 纯函数                                  | PASS（`lib/newTaskDefaults.ts:23-70`；ui 测试 6 项）                                               |
| t-3           | sync-scope N/A                                              | PASS（目标无 `sync-scope.ts`，本批未改同步）                                                       |
| t-3           | speed 仅 additive 存储                                      | **PASS（t-7 已复核）**：存储层保留 speed，运行时投影不含 speed（§9.2）                             |
| t-3           | protocol.ts 已拆到 398 行                                   | PASS（当前 `protocol.ts` 398 行；architecture 0 新增）                                             |
| t-4 UI/草稿链 | TaskDefaultsSection（不含 speed 行）                        | PASS（`TaskDefaultsSection.tsx:210-358`，无 speed 渲染）                                           |
| t-4           | settings 导航/页面                                          | PASS（`settingsNavigation.ts:10,71`；`settingsPageConfig.ts:79-86`；`SettingsPage.tsx:1538-1546`） |
| t-4           | newTaskDraft/refresh                                        | PASS（`newTaskDraft.ts:14-62`；测试 5 项）                                                         |
| t-4           | useDraftConfigControl 设置门禁                              | PASS（`useDraftConfigControl.ts:168-205`）                                                         |
| t-4           | provider reasoning pick                                     | PASS（`model-selection-config.ts:8-75,134-155`；provider 测试 8 项）                               |
| t-4           | 两套 locale 15 键                                           | PASS（`en-US.ts:2445-2464`、`zh-CN.ts:2319-2338`；测试 2 项）                                      |
| t-4           | 相关单测                                                    | PASS（ui 449/449）                                                                                 |

## 4. R1 子智能体批量编辑逐条核对（t-1 §1）

### 4.1 文件与语义

| t-1 条目                                                                                          | 结论                      | 目标证据                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1.2 `SubagentModelBatchApply.ts` 保持目标适配（`SubAgentConfig`、六键、无 `maxTurns`、无 speed） | PASS                      | `SubagentModelBatchApply.ts:132-170`；测试 `subagentModelBatchApply.test.ts:151-208`                                                                                                                                                              |
| §1.2 写路径判定：内置/插件 override，自建 definitionFile                                          | PASS                      | `SubagentModelBatchApply.ts:14-32`；测试 `:29-62`                                                                                                                                                                                                 |
| §1.3 `SubagentModelBatchBar.tsx` 不移植 speed；模型可用性/结果/进度/退出保持                      | PASS                      | `SubagentModelBatchBar.tsx:86,160,215,254-289`；speed grep 零命中                                                                                                                                                                                 |
| §1.4 `SubagentModelBatchDialog.tsx` 不移植 speed；继承默认 footer、档位投影保持                   | PASS                      | `SubagentModelBatchDialog.tsx:54-64,156-240`；无 speed                                                                                                                                                                                            |
| §1.5 #1 五个新 TID 用局部字面量                                                                   | PASS                      | `SubagentsSection.tsx:145-149`；接线测试 `subagentBatchWiring.test.ts:194-208`                                                                                                                                                                    |
| §1.5 #2 分组「…」菜单：统一设置 / 本组恢复继承，无可批量行或 applying 禁用                        | PASS                      | `SubagentsSection.tsx:554-610,2283-2313`；测试 `:84-99`                                                                                                                                                                                           |
| §1.5 #3 分组三态全选，批量模式下替换分组菜单                                                      | PASS                      | `SubagentsSection.tsx:612-654,2288-2296`；测试 `:100-114`                                                                                                                                                                                         |
| §1.5 #4 全局全选：当前过滤可见全部可批量行，三态                                                  | PASS                      | `SubagentsSection.tsx:2343-2366`；`batchTargets/batchSelectableAgents` `:2086-2115`                                                                                                                                                               |
| §1.5 #5 行复选框保留自定义原语                                                                    | PASS                      | `SubagentsSection.tsx:514-546`                                                                                                                                                                                                                    |
| **§1.5 #6 applying 期间行复选框禁用 + 行点击失效 + 入口守卫 + 测试**                              | **PASS（t-6 复核）**      | `checkboxVisible` 含 `!batchApplying`（`:699`）；`batchCheckboxDisabled`（`:701`）传入 `disabled`（`:762`）；`checkboxRendered` 保证列不塌陷（`:700,758`）；handler 入口守卫（`:1833`）且依赖含 `batchApplying`（`:1847`）；wiring 测试 `:86-112` |
| §1.5 #7 行点击=切换选中（目标产品规则）                                                           | PASS                      | `SubagentsSection.tsx:736-741`；目标 spec R1                                                                                                                                                                                                      |
| §1.5 #8 选中行高亮 `bg-selected`                                                                  | PASS                      | `SubagentsSection.tsx:726`                                                                                                                                                                                                                        |
| §1.5 #9 定义文件行档位徽标                                                                        | PASS                      | `SubagentsSection.tsx:708-714,775-779`                                                                                                                                                                                                            |
| §1.5 #10 批量状态由 SubagentsSection 唯一持有                                                     | PASS                      | `:1556-1562` 等 batch 状态；Bar/Dialog 受控                                                                                                                                                                                                       |
| §1.5 #11 选中集按当前过滤裁剪                                                                     | PASS                      | `:2117-2135`；测试 `:65-81`                                                                                                                                                                                                                       |
| §1.5 #12 单行落盘复用既有写路径                                                                   | PASS                      | `applyBatchTarget` `:1864-1906`；接线测试 `:24-63` 禁止第五条通道                                                                                                                                                                                 |
| §1.5 #13 整批一次推荐；拒绝整批不写盘并列失败                                                     | PASS                      | `:1913-1951`；测试 `:116-135`                                                                                                                                                                                                                     |
| §1.5 #14 串行、单行失败不中断、结束清进度、成功才刷新                                             | PASS                      | `:1953-1981`                                                                                                                                                                                                                                      |
| §1.5 #15 弹层目标按当前分组重算                                                                   | PASS                      | `batchDialogGroup` `:2137-2184`                                                                                                                                                                                                                   |
| §1.5 #16 入口/退出：无批量行不显示；applying 禁用退出/搜索/新建                                   | **PASS（搜索项登记 P3）** | 退出 `:2390`、组全选 `:2310`、全局全选 `:2377` 均禁用；新建 `:2455`（`batchMode` 下 `onNew=undefined`）；**搜索 `:2350-2359` 未禁用**（源仓同样未禁用），按 §1 #3 登记待裁决                                                                      |
| §1.5 #17 操作条计数=可见已选、disabled=loading/refreshing                                         | PASS                      | `SubagentsSection.tsx:2508-2522`                                                                                                                                                                                                                  |
| §1.5 #18 speed 维度零回流                                                                         | PASS                      | `grep speed` 在批量 UI/测试零命中；接线测试 `:137-166`                                                                                                                                                                                            |
| §1.5 #19 与批量无关的源仓差异不移植                                                               | PASS                      | 目标保留 bundled 目录、`buildSubagentSaveConfig` 六键、`ACODE_AGENT_PROVIDER`                                                                                                                                                                     |
| §1.6 纯逻辑测试保留                                                                               | PASS                      | `subagentModelBatchApply.test.ts` 10 项通过                                                                                                                                                                                                       |
| §1.6 接线测试保留                                                                                 | PASS                      | `subagentBatchWiring.test.ts` 9 项通过                                                                                                                                                                                                            |
| §1.6 新增 applying 禁用断言                                                                       | **PASS（t-6）**           | `subagentBatchWiring.test.ts:86-112` 断言 checkboxVisible/batchCheckboxDisabled/handler 守卫                                                                                                                                                      |
| §1.6 i18n 键成对、禁止 speed 键                                                                   | PASS                      | `en-US.ts:3557-3576`、`zh-CN.ts:3358-3377`；测试 `:168-180`；`grep batch.speedRequired/batch.dialog.speed/row.speedMissing/chat.toolbar.speed` 零命中                                                                                             |
| §1.7 冲突点裁决（行点击/裁剪/重算/局部 TID/speed/maxTurns）                                       | PASS                      | 逐项与 `packages/ui/specs/subagent-batch-edit.md` 一致                                                                                                                                                                                            |

### 4.2 R1 结论

除 §1.5 #16 的搜索禁用（P3 规格偏差，源仓同样未禁用）外，批量编辑的分组菜单、组/全局全选、
可批量判定、写路径、整批推荐、结果汇总、i18n 与测试均与 t-1/源仓语义一致。§1.5 #6 已由
t-6 关闭：`batchCheckboxDisabled`、`checkboxVisible` 排除 applying、handler 守卫与 wiring
断言均已复核，判 **PASS**。R1 总体判 **PASS（有 1 项 P3 规格待裁决）**。

## 5. R2 新建任务默认值逐条核对（t-1 §2–§4）

### 5.1 数据面（shared / provider）

| t-1 条目                                                                                                               | 结论                 | 目标证据                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| §2.2 新增 `new-task-defaults.ts`：schema、DEFAULT、speed additive、`NEW_TASK_DEFAULT_MODE_IDS` 含 `dontAsk`、plan→null | PASS                 | `packages/shared/src/new-task-defaults.ts:29-81`；测试 `shared/test/newTaskDefaults.test.ts:14-108`                                       |
| §2.2 `index.ts` 追加导出                                                                                               | PASS                 | `packages/shared/src/index.ts:244`                                                                                                        |
| §2.3 protocol 两字段                                                                                                   | PASS                 | `packages/shared/src/protocol.ts:395-397`                                                                                                 |
| §2.3 object schema：外层 default + 内层字段 default；`defaultReasoningLevelPick` 不给 default                          | PASS                 | `validationAppSettings.ts:522-529`；测试 `:41-49,110-132`                                                                                 |
| §2.3 patch schema：整份对象替换                                                                                        | PASS                 | `validationAppSettings.ts:622-623`；测试 `:85-97`                                                                                         |
| §2.4 无同步键改动（目标无 sync-scope）                                                                                 | PASS                 | 全仓无 `sync-scope.ts`；本批未改同步                                                                                                      |
| §2.6.2 provider pick 阶梯 / 别名 / 具体档位降级 / completion 第三参                                                    | PASS                 | `packages/provider/src/model-selection-config.ts:8-75,134-155`；测试 `provider/test/model-selection-pick.test.ts` 8 项通过                |
| §2.7 speed 运行时投影不得含 speed                                                                                      | **PASS（t-7 复核）** | `packages/ui/src/lib/newTaskDefaults.ts:13-17` 不含 speed；`:25-31` speed 不参与判定；测试 `ui/test/newTaskDefaults.test.ts:51-53,96-108` |
| §2.7 `applyNewTaskDefaults` 只写 reasoningLevel                                                                        | PASS                 | `newTaskDefaults.ts:45-69`；测试 `:117-133`                                                                                               |

### 5.2 草稿链（UI）

| t-1 条目                                                                                       | 结论                           | 目标证据                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------- |
| §2.6.1 `resolveNewTaskDefaults` 归一化、三项全空返回 null                                      | **PASS（t-7）**                | `newTaskDefaults.ts:25-31`；speed-only 返回 null（测试 `:51-53`）                                                                                                                                           |
| §2.6.3 `composerRecent` 第三参：recent 只决定模型，档位按 pick 重取；invalidated 语义          | PASS                           | `packages/ui/src/lib/composerRecent.ts:102-133`；测试 `composerRecentReasoningPick.test.ts` 7 项通过                                                                                                        |
| §2.6.4 `initializeNewTaskDraft`：固定 model 为种子、mode 固定、planEnabled=false、叠加固定档位 | PASS                           | `packages/ui/src/v4/composer/newTaskDraft.ts:14-36`；测试 `newTaskDraft.test.ts:41-72`                                                                                                                      |
| §2.6.4 `refreshUneditedNewTaskDefaults`：edited/正文硬门禁、同模型档位变化才写回               | PASS（按源仓实现）             | `newTaskDraft.ts:39-62`；测试 `:74-128`。t-1 文字「模型身份变化时返回新对象」与源仓实现相反；目标与源仓逐行一致，此处按源仓判定                                                                             |
| §2.6.5 `modelSelectionEdited` 类型/读取                                                        | PASS                           | `composerDraftStore.ts:28,138`                                                                                                                                                                              |
| §2.6.6 设置快照门禁、初始化传 settings、刷新块、`updateDraftConfig` 置位、切模型用 pick        | PASS                           | `useDraftConfigControl.ts:168-205,270-284,448-476`                                                                                                                                                          |
| §2.6.7 固定档位优先于 pick；不支持时回落模型默认；不覆盖用户改选                               | PASS                           | `newTaskDraft.ts:23-35`；`useDraftConfigControl.ts:199-205,278`；测试 `newTaskDraft.test.ts:41-114`                                                                                                         |
| §2.8 设置快照未就绪整章不可交互                                                                | PASS                           | `TaskDefaultsSection.tsx:105-106,260-263`                                                                                                                                                                   |
| §2.8 写入失败 toast；pendingDefaultsRef 累积                                                   | PASS                           | `TaskDefaultsSection.tsx:99-102,149-162`                                                                                                                                                                    |
| §2.8 目录未就绪：推理强度行禁用 + catalogUnavailable；mode/model 仍可用                        | **PASS（按源仓；规格将修订）** | 推理行 `:342` + 文案 `:331-335` 正确；模型行 `:321` `disabled={!enabled                                                                                                                                     |     | !catalogReady}`不可用，源仓`TaskDefaultsSection.tsx:358` 同；captain 裁决按实现，spec-writer 修订 t-1 |
| §2.8 plan 永不写入；存储 plan 归一化                                                           | PASS（运行时）                 | `normalizeNewTaskDefaultMode` `:74-81`；UI 变更路径 `TaskDefaultsSection.tsx:276-282`；`resolveNewTaskDefaults` `newTaskDefaults.ts:27`。存储层 schema 仍允许 plan（UI 直接显示时可能为空，属源仓同形边缘） |

### 5.3 设置页与导航

| t-1 条目                                                              | 结论 | 目标证据                                                                                   |
| --------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------ |
| §2.5.1 `settingsNavigation` 加 `taskDefaults`、不隐藏                 | PASS | `settingsNavigation.ts:10,71`；`HIDDEN_SETTINGS_SECTIONS` `:39-47` 不含                    |
| §2.5.2 侧栏条目位于 modelProvider 之后、`basics`、`SlidersHorizontal` | PASS | `settingsPageConfig.ts:79-86`                                                              |
| §2.5.3 SettingsPage 分支位置与本地 Host/workspace 口径                | PASS | `SettingsPage.tsx:1538-1546`                                                               |
| §2.5.4 `SettingsRow.controlLayout="model"`                            | PASS | `SettingsPageParts.tsx:120,127-131`                                                        |
| §3.1 `splitModelTriggerLabelParts`                                    | PASS | `v4/composer/modelTriggerDisplay.ts:14-27`                                                 |
| §3.1 章节结构（pick / 开关 / mode-model-reasoning）                   | PASS | `TaskDefaultsSection.tsx:210-358`                                                          |
| §3.1 optionSourceModel 种子顺序                                       | PASS | `TaskDefaultsSection.tsx:130-143`                                                          |
| §3.1 withStoredValue 保留不支持档位                                   | PASS | `:70-73,146`                                                                               |
| §3.3 15 个 locale 键两套齐全                                          | PASS | `en-US.ts:2445-2464`、`zh-CN.ts:2319-2338`；测试 `taskDefaultsLocaleKeys.test.ts` 2 项通过 |
| §3.3 速度行默认隐藏、不声称生效                                       | PASS | `TaskDefaultsSection.tsx` 无 speed 渲染；文案 `:2455-2461,2319-2338` 不含速度              |

### 5.4 测试映射（t-1 §4.1）

| 要求                                          | 结论                    | 证据                                                                                       |
| --------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `ui/test/newTaskDefaults.test.ts`             | PASS（含 1 项错误契约） | 6 项通过；`:99-115` 与 §2.7 冲突                                                           |
| `ui/test/composerRecentReasoningPick.test.ts` | PASS                    | 7 项通过                                                                                   |
| `shared/test/newTaskDefaults.test.ts`         | PASS                    | 8 项通过                                                                                   |
| `ui/test/newTaskDraft.test.ts`（目标补充）    | PASS                    | 5 项通过                                                                                   |
| `services/tests` 旧设置 salvage 测试          | **PASS（t-7 补齐）**    | `packages/services/tests/settingsExplicitKeyPersistence.test.mjs:168-217`；单跑 6/6 exit 0 |
| 目标仓无 DOM 测试的声明                       | PASS（已声明未验证）    | 本报告 §6                                                                                  |

### 5.5 验收场景（t-1 §4.3）覆盖情况

| 场景                                      | 结论                         | 说明                                                                                                                   |
| ----------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1 开关关闭：与升级前一致                  | PASS（单测/源码）            | `resolveNewTaskDefaults` 返回 null 时走原路径                                                                          |
| 2 固定 mode=`yolo` / `dontAsk`            | PASS（单测）                 | `newTaskDraft.test.ts:41-57`；schema 归一化测试                                                                        |
| 3 固定模型 + 低档；不支持时回落           | PASS（单测）                 | `newTaskDraft.test.ts:41-72`；`newTaskDefaults.test.ts:117-133`                                                        |
| 4 固定模型被移除回落                      | PASS（单测）                 | `newTaskDraft.test.ts:59-72`                                                                                           |
| 5 只固定模型                              | PASS（源码/单测）            | `defaults?.model ?? recent`；mode 回落 recent                                                                          |
| 6 目录刷新不覆盖固定档位                  | PASS（单测）                 | `newTaskDraft.test.ts:74-93`                                                                                           |
| 7 用户改选后不覆盖                        | PASS（单测/源码）            | `modelSelectionEdited` 测试 + `updateDraftConfig:278`                                                                  |
| 8 设置晚于模型目录到达                    | **未验证（无 DOM）**         | 源码门禁 `useDraftConfigControl.ts:168-173`；无渲染级测试                                                              |
| 9 不影响已有会话                          | PASS（源码）                 | 仅 `sessionId === null` 初始化/刷新                                                                                    |
| 10 目录未就绪                             | **PASS（按源仓；规格修订）** | 推理行正确；模型行按源仓禁用，captain 裁决规格改实现                                                                   |
| 11 旧 setting.json 无字段                 | PASS（探针）                 | §2.10                                                                                                                  |
| 12 `highest` / 具体档位 / 别名阶梯        | PASS（单测）                 | `model-selection-pick.test.ts` 8 项                                                                                    |
| 13 文案成对、速度行隐藏                   | PASS                         | `taskDefaultsLocaleKeys.test.ts`                                                                                       |
| 14 speed additive / speed-only 等价未固定 | **PASS（t-7 复核）**         | `newTaskDefaults.ts:25-31`；测试 `newTaskDefaults.test.ts:51-53,96-108`；存储层 speed 仍可读写（shared/services 测试） |

## 6. 未验证项（必须如实标注）

1. **UI 渲染级交互未验证**：目标仓无 jsdom / testing-library，`packages/ui` test script 只匹配
   `.test.ts` / `.tests.mjs`。设置页实际点击、Radix Select 显示、批量操作条视觉、行点击命中
   均未在浏览器/桌面环境中执行；本报告只做源码契约 + 纯函数单测。
2. **设置晚到场景（t-1 §4.3 #8）未验证**：仅在 `useDraftConfigControl.ts:168-173` 静态核对门禁，
   没有 DOM 测试或手工运行证据。
3. **桌面/远程双 Host 未验证**：`TaskDefaultsSection` 与草稿链按本地 Host + 当前 workspace 读取，
   远程 workspace 的运行时行为未执行（无桌面环境）。
4. **t-2/t-3/t-4 原始任务记录未获取**：member 视图不可见任务记录；captain 在消息
   `f3b3b7b8` 提供了验收摘要，报告 §3.1 按摘要逐条核对。原始 acceptances 原文仍不可见，
   若其条目超出摘要，需要补核。
5. **knip 基线口径未确认**：dispatch 只给「803 unused exports」，未说明是否包含
   `Unused exported types` 节；本报告同时列出两节真实计数（最终 784 / 878）。
6. **目录未就绪时模型行的实际 UI 表现未验证**：源码按源仓禁用，规格将修订；无渲染级测试。
7. **applying 时搜索未禁用（P3）**：t-1 §1.5 #16 要求禁用搜索，目标与源仓均未禁用；本批
   未裁决，登记待产品确认，不计入 t-6/t-7 范围。
8. **并发工作树**：验收期间其他批次仍在修改工作树；`git status` 条目数会变化。本报告只对
   上述文件与命令输出负责，不对并行批次做通过判定。

## 7. 改动盘面与「未改源码」声明

本功能相关文件（`git status` 快照）：

- R1：`packages/ui/specs/subagent-batch-edit.md`、`packages/ui/src/settings/SubagentsSection.tsx`、
  `packages/ui/test/subagentBatchWiring.test.ts`、`packages/ui/src/i18n/locales/{en-US,zh-CN}.ts`
  （locale 同时含并行批次键）。
- R2：`apps/acode-cli/specs/settings-port-batch-and-task-defaults.md`（t-1 规格）、
  `packages/shared/src/new-task-defaults.ts`（新）、`index.ts`、`protocol.ts`、
  `validationAppSettings.ts`、`packages/shared/test/newTaskDefaults.test.ts`（新）、
  `packages/provider/src/model-selection-config.ts`、`packages/provider/test/model-selection-pick.test.ts`（新）、
  `packages/ui/src/lib/newTaskDefaults.ts`（新）、`composerRecent.ts`、
  `packages/ui/src/v4/composer/{newTaskDraft,composerDraftStore,useDraftConfigControl,modelTriggerDisplay}.ts`、
  `packages/ui/src/settings/TaskDefaultsSection.tsx`（新）、`SettingsPage.tsx`、
  `lib/settingsNavigation.ts`、`settings/settingsPageConfig.ts`、`settings/SettingsPageParts.tsx`、
  `packages/ui/test/{newTaskDefaults,newTaskDraft,composerRecentReasoningPick,taskDefaultsLocaleKeys}.test.ts`（新）、
  `packages/services/tests/settingsExplicitKeyPersistence.test.mjs`（t-7 增补 newTaskDefaults 用例）。
- t-6：`packages/ui/src/settings/SubagentsSection.tsx`、`packages/ui/test/subagentBatchWiring.test.ts`；
- t-7：`packages/ui/src/lib/newTaskDefaults.ts`、`packages/ui/test/newTaskDefaults.test.ts`、
  `packages/services/tests/settingsExplicitKeyPersistence.test.mjs`。

验收人操作：

- 只新增本报告 `docs/archive/settings-port-verification.md`；
- 临时探针与日志全部在 `C:\Users\admin\AppData\Local\Temp\acode1-settings-verify\`；
- 未执行 `git add/commit`、未修改任何源码、未关闭/削弱门禁；
- 唯一可能的工作树副作用是 `tsc -b` 的构建产物（仓库已忽略，不属于源码改动）。

## 8. 修复状态与剩余建议

1. **已关闭（R1，t-6）**：`batchCheckboxDisabled`、`checkboxVisible` 排除 applying、handler 入口守卫、
   wiring 断言均已落地并复核（§9.1）。
2. **已关闭（R2 契约，t-7）**：运行时投影去 speed、speed-only 返回 null、`ResolvedNewTaskDefaults`
   改为非导出；测试期望已修正（§9.2）。
3. **已关闭（R2 覆盖，t-7）**：`packages/services/tests/settingsExplicitKeyPersistence.test.mjs`
   新增 `newTaskDefaults` 用例，单跑 6/6。
4. **已裁决**：模型目录未就绪时模型行按源仓禁用，spec-writer 修订 t-1 §2.8/§4.3 #10；代码不改。
5. **待裁决（P3）**：applying 时搜索框是否禁用。t-1 §1.5 #16 要求禁用，目标与源仓均未实现；
   建议在目标产品 spec `subagent-batch-edit.md` 中明确取舍后再改代码。
6. **既有红**：`update.recovery.*` 6 行格式债、CLI 设计令牌 CRLF 与 browser-use marker 失败
   不属于本批，建议单独任务处理，不要混入本功能 PR。

## 9. t-6 / t-7 复核记录（已复核）

- 状态：**t-6、t-7 均已交付并通过独立复核**（2026-10-20 ~14:26–14:30）。

### 9.1 t-6（applying 行选择禁用）：PASS

| 复核项                                                          | 结果               | 文件:行号                                                               |
| --------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------- | ---- | ------ |
| `AgentListRow` 接收 `batchApplying`                             | PASS               | `packages/ui/src/settings/SubagentsSection.tsx:668,684`；调用点 `:2276` |
| `checkboxVisible` 含 `!batchApplying`（行点击不切换）           | PASS               | `:699`；行交互 `:746-754`                                               |
| `checkboxRendered` 保证列不塌陷                                 | PASS               | `:700,724-733,758`                                                      |
| `batchCheckboxDisabled = batchApplying                          |                    | !isBatchApplicableAgent(agent)`                                         | PASS | `:701` |
| 传给 `BatchRowCheckbox` 的 `disabled`，按钮置灰                 | PASS               | `:762`；按钮 `:529-532,559-565`                                         |
| `handleBatchCheckChange` 入口守卫 + 依赖                        | PASS               | `:1833,1847`                                                            |
| wiring 测试断言                                                 | PASS               | `packages/ui/test/subagentBatchWiring.test.ts:86-112`                   |
| `pnpm --filter @acode/ui test`                                  | **exit 0**         | tests 450 / pass 450 / fail 0（`ui-test-final.log`）                    |
| 定向 oxfmt（t-6 文件）                                          | **exit 0**         | `oxfmt-final.log`                                                       |
| `pnpm typecheck` / `pnpm lint` / `architecture:check --changed` | **exit 0 / 0 / 0** | `typecheck-final.log`、`lint-final.log`、`architecture-final.log`       |

结论：t-1 §1.5 #6 / §1.6 的必修缺口已关闭；applying 期间复选框仍可见但置灰，行点击不改变选中集。

### 9.2 t-7（speed 运行时投影 + 未用导出 + services 测试）：PASS

| 复核项                                       | 结果       | 文件:行号 / 命令                                                                                                                                 |
| -------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ResolvedNewTaskDefaults` 改为模块内非导出   | PASS       | `packages/ui/src/lib/newTaskDefaults.ts:13`（无 `export`）                                                                                       |
| 运行时投影不含 `speed`                       | PASS       | `:14-17`；`resolveNewTaskDefaults` `:25-31`                                                                                                      |
| speed-only 等价未固定（返回 null）           | PASS       | `:31`；测试 `packages/ui/test/newTaskDefaults.test.ts:51-53,96-108`                                                                              |
| `applyNewTaskDefaults` 只写 `reasoningLevel` | PASS       | `:48-70`                                                                                                                                         |
| 存储层 additive speed 保留                   | PASS       | `packages/shared/src/new-task-defaults.ts:29-49`；services 测试 `:216`                                                                           |
| services salvage 测试                        | PASS       | `packages/services/tests/settingsExplicitKeyPersistence.test.mjs:168-217`；`node --import tsx --test ...` **exit 0，6/6**                        |
| knip 未用符号消失                            | PASS       | `pnpm knip` **exit 1**（既有项）：Unused exports 784、Unused exported types 878，`grep ResolvedNewTaskDefaults` 0 命中（`knip-final.plain.log`） |
| `pnpm --filter @acode/ui test`               | **exit 0** | 450/450（`ui-test-final.log`）                                                                                                                   |
| `pnpm --filter @acode/shared test`           | **exit 0** | 280/280（`shared-test-final.log`）                                                                                                               |

结论：t-1 §2.6.1/§2.7/§4.3 #14 与 t-5 验收 #5 的新增未用导出问题均已关闭。

### 9.3 最终 verdict

- **通过（有条件）**：t-5 的 6 条验收项中，1–5 均满足（含既有红归因），6（报告 + 不改源码）满足。
- 条件：CLI 4 项确定性既有红 + 1 项 flake；全量定向 oxfmt 因 HEAD 既有 locale 格式债 exit 1；
  桌面/浏览器视觉与交互、设置晚到场景、远程 Host 未验证；applying 搜索未禁用为 P3 待裁决。
- 若 captain 要求「门禁必须全绿」而不接受既有红，则本批应另开清理任务后再收口；否则按本报告
  的「通过（有条件）」结论执行。

## 10. 附录：日志

`C:\Users\admin\AppData\Local\Temp\acode1-settings-verify\`：

- `ui-test.log`、`shared-test.log`、`shared-test-rerun.log`、`provider-test.log`
- `typecheck.log`、`tsc-force.log`、`lint.log`、`architecture.log`
- `oxfmt.log`、`cli-test.log`、`knip.log`、`knip.plain.log`
- `settings-compat-probe.mjs`、`settings-compat-probe.log`
- `lf/`（locale LF 归一化副本、HEAD 副本与 oxfmt 归一化副本，用于区分既有格式债）

## 10. 2026-10-20 追加：speed 维度补移植与复验

首轮验收把 speed 登记为暂缓项；用户要求“全部实现”后，主 Agent 直接补齐了整条 speed 链并复验：

- **协议/模型栈**：`model-option-map` 名称与 values、shared `model-config` 的 speed schema、`model-selection` 的 options 与错误码、provider `SpeedOptionSpecConfig`/registry 校验/completion/normalize/resolver/effective-selection。
- **UI**：`SubagentSpeedField`、批量 Bar/Dialog/Apply、SubagentsSection 行内覆盖/编辑表单/徽标、TaskDefaultsSection「模型速度」行、composer `ModelSpeedControl` 与 `handleDraftSelectSpeed`。
- **持久化**：subagent frontmatter `speed` 序列化与解析。
- **实测退出码**：`pnpm typecheck` 0；`pnpm lint` 0（166 既有 warning）；`architecture:check --changed` 0（new 0）；`packages/ui test` 453/453；`shared test` 280/280；`provider test` 32/32；`services test` 478 pass / 2 skip / 0 fail；插件 96/96；完整 `apps/acode-cli test` 2903 pass / 4 fail（均为既有：design-tokens CRLF ×3、browser-use seeding marker ENOENT）。
- **仍未验证**：桌面/浏览器视觉与交互（speed 控件显隐、必选提示、composer 速度选择器、窄宽布局）、远程 Host 运行时。
- 结论：两项设置功能（含 speed 维度）代码验收通过；本追加不改变首轮“有条件通过”的性质，只把 speed 从“暂缓”改为“已实现并复验”。
