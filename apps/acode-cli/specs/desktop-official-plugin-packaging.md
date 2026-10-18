# Spec：desktop/远端打包补齐 default-enabled 官方插件（official plugin packaging parity）

## 背景

- `OFFICIAL_PLUGIN_DEFINITIONS`（`apps/acode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`）
  定义 15 个官方插件，其中 11 个 default-enabled（`packages/shared/src/plugin-marketplaces.ts:28-49`
  镜像名单，bootstrap 单测机械对照）。内容型 default-enabled 共 8 个：
  documents / pdf / presentations / spreadsheets / acode-guide / skill-creator /
  plugin-creator / image-search。
- 三份发布暂存清单只登记了 3 个插件（browser-use、node-repl-host、agent-teams），8 个
  内容型插件缺位（.agent-teams/reports/t3-plugin-management.md 缺口 7）：desktop 安装包
  `resources/glm/packages/` 只有 3 个插件目录 → filesystem seed 找不到 8 个包 →
  `bundled-marketplace.json` 被覆盖成 3 条目 → `scanOfficialCache` 权威分片屏蔽 cache 里
  其余 default-enabled 插件的残留目录 → /命令 catalog、设置插件「内置」分组、设置 skill
  页 UI 层全部缺失这些插件。
- 用户裁决（2026-10-17）：把 8 个内容型插件补齐进打包链，逐个判断 requiresRuntime 与
  纯资产归属；staging 路径必须匹配各 definition 的 rootCandidates。

## 产品规则

### R1 打包完备性不变式

任何随应用分发的官方插件暂存清单（desktop 生产、远端 prebuild、dev 链）必须覆盖**全部
default-enabled 官方插件**。覆盖判定以 `OFFICIAL_PLUGIN_DEFINITIONS` 为唯一权威
（defaultEnabled + rootCandidates + requiredSeedPaths + version 事实源），
`packages/shared/src/plugin-marketplaces.ts` 的镜像名单由既有 parity 单测对照，不在本线重复。

staging 路径规则：`packages/<name>-plugin`（相对 glm 目录）。它与
`resolveFilesystemPluginRoot`（bundled-plugins.ts:374-382）从 entrypointDir 解析
rootCandidates 首候选 `packages/<name>-plugin` 一致；现有 3 个条目即此形态。

### R2 三份清单的分工与本次改动

| # | 文件 | 清单对象 | 本次改动 |
| --- | --- | --- | --- |
| 1 | `packages/desktop/scripts/prepare-agent-node-bundle.mjs` | `officialPluginPackages`（生产桌面 seed staging） | 新增 8 条目（§R3 表） |
| 2 | `scripts/prepare-prebuilds.mjs` | `remoteOfficialPluginPackages`（远端资产 staging）+ `remoteOfficialPluginRequiredPaths`（manifest 存在性钉） | 新增 8 条目 + 8 条 `packages/<name>-plugin/.acode-plugin/plugin.json` |
| 3 | `scripts/build-desktop-agent-cli.mjs` | `requiredDevPluginRuntimeBuilds`（dev 链 dist 运行时构建清单） | **不新增条目**（§R4） |

第 1、2 份的新条目形态（与现有条目同构）：

```
{
  packageName: "@acode/<name>-plugin",
  relativePath: "apps/acode-cli/packages/<name>-plugin",
  requiresRuntime: false,
  requiredSeedPaths: <镜像 definition.requiredSeedPaths，见 §R3 表>,
  stagedPath: "packages/<name>-plugin",
}
```

staging 流程不需要改：`requiresRuntime: false` 跳过 runtime 构建；顶层白名单
（`includedOfficialPluginTopLevelPaths` / `remoteOfficialPluginTopLevelPaths`）已覆盖
8 个插件的全部顶层目录（`.acode-plugin`、`agents`、`commands`、`package.json`、`skills`、
`README.md`、`.mcp.json`）。

注意：`NOTICE.md` 不在顶层白名单 → 与 bundled seed 的 `includedTopLevelPaths`
（bundled-plugins.ts:46-63）行为一致（cache 亦不携带），许 可证文本不随插件缓存分发，
不算遗漏，不改白名单。

### R3 逐插件判定表（8 行，判定依据 = definition + 包实测）

| 插件 | version（definition = 包内 manifest，已逐一核对一致） | 顶层资产 | requiredSeedPaths（镜像 definition） | requiresRuntime | 判定依据 |
| --- | --- | --- | --- | --- | --- |
| documents | 0.1.7 | .acode-plugin / agents / skills / package.json | `agents/visual-judge.md`、`skills/docx/SKILL.md` | false | 纯内容；无 dist 钉子 |
| pdf | 0.2.0 | 同上 | `agents/visual-judge.md`、`skills/pdf/SKILL.md` | false | 同上 |
| presentations | 0.1.7 | 同上 | `agents/visual-judge.md`、`skills/pptx/SKILL.md` | false | 同上 |
| spreadsheets | 0.1.7 | 同上 | `agents/visual-judge.md`、`skills/xlsx/SKILL.md` | false | 同上 |
| acode-guide | 0.3.0 | .acode-plugin / commands / skills / README / package.json | `commands/workflow.md`（OFFICIAL_ACODE_GUIDE_REQUIRED_SEED_PATHS） | false | dynamic-workflows 副本已删（specs/skill-seeding-registration.md R4），纯 commands+skills |
| skill-creator | 0.1.0 | .acode-plugin / skills / package.json | 无（definition 未钉） | false | 纯 skill 资产 |
| plugin-creator | 0.1.1 | .acode-plugin / skills / package.json | definition 钉 8 条（SKILL.md + 5 scripts + 2 references，全部源跟踪 .md/.mjs） | false | scripts 是 skill 源文件非构建产物 |
| image-search | 0.1.1 | .acode-plugin / .mcp.json / README / package.json | `.mcp.json` | false | `.mcp.json` 声明**远端 http MCP**（`type: "http"`，无本地 dist）；无 skills 目录仍需打包（default-enabled 且市场可见） |

requiresRuntime=true 的现有三条（browser-use / node-repl-host / agent-teams）维持不变：
它们的 definition 钉了构建产物（`dist/mcp/server.js`、`scripts/browser-client.mjs`），
dist 不入库，必须构建后 stage。

### R4 dev 链（build-desktop-agent-cli.mjs）为何不新增条目

`requiredDevPluginRuntimeBuilds` 的语义是「dev 必需的独立 **dist** 运行时构建」：
每个条目会执行 `pnpm --filter <pkg> build` 并断言 artifactPath 在场。8 个内容型插件的
package.json **没有 build script**（实测 `scripts: {}`），塞进该清单会让 dev 链在
`pnpm --filter` 缺脚本处直接失败。

dev 形态下内容型插件无需 staging：filesystem seed 经 `candidateBaseDirs()`（含
monorepo cwd 候选）直接读 workspace 源码包；已 seeded 的用户 storage cache 持久存在，
dev 启动 seed 命中 `isSeedCurrent` 复用。dev 链的完备性由 §R5 断言 C 钉住：任何
default-enabled 插件未来新增 dist 钉子时，dev 清单必须同步，否则一致性测试失败。

### R5 一致性防漂移测试（本 spec 的执行机制）

新增 `apps/acode-cli/tests/official-plugin-packaging-parity.test.mjs`，沿用
`sea-bundled-skill-assets.test.mjs` 惯例：`import` bootstrap TS 源拿
`OFFICIAL_PLUGIN_DEFINITIONS`（测试经 `node --import tsx --test` 直跑）；脚本清单对象
未导出且桌面脚本 import 即执行打包 → 按既有惯例做**源文本断言**（`readPackListBlock` /
`extractQuotedArray` 同款工具函数）。

- **断言 A（清单 ⊇ default-enabled 集）**：每个 `defaultEnabled: true` 的 definition
  ⇒ `officialPluginPackages` 与 `remoteOfficialPluginPackages` 各存在一条
  `relativePath: "apps/acode-cli/packages/${name}-plugin"`、`stagedPath: "packages/${name}-plugin"`
  的条目。
- **断言 B（远端 manifest 钉完备）**：`remoteOfficialPluginRequiredPaths` 含每个
  default-enabled 插件的 `packages/${name}-plugin/.acode-plugin/plugin.json`。
- **断言 C（dev 链 dist 钉覆盖）**：definition `requiredSeedPaths` 含任一 `dist/`
  前缀路径且 defaultEnabled ⇒ `requiredDevPluginRuntimeBuilds` 存在对应
  `packageName` 条目。现满足（agent-teams、node-repl-host 已登记）；未来内容型插件
  新增 dist 钉子时此断言强制 dev 链跟进。
- **断言 D（requiredSeedPaths 镜像一致）**：两份 staging 清单条目的
  `requiredSeedPaths` 集合 === 对应 definition 的 `requiredSeedPaths ?? []`。
- **断言 E（requiresRuntime 反向护栏）**：`officialPluginPackages` 中
  `requiresRuntime: true` 的条目，其 definition 的 `requiredSeedPaths` 必须含
  `dist/` 前缀路径或已有条目注释声明的构建产物（防止给纯资产插件误挂 runtime 构建）。

## 状态所有者

| 状态 | 所有者 |
| --- | --- |
| 插件清单事实（defaultEnabled/rootCandidates/requiredSeedPaths/version） | `OFFICIAL_PLUGIN_DEFINITIONS`（唯一权威） |
| 三份 staging 清单 | 各脚本文件（本 spec 登记其必须覆盖的集合） |
| bundled-marketplace.json 分片条目数 | seed 链（`writeOfficialMarketplace`），由 staging 完备性间接决定 |

## 接口

- 无协议/运行时接口变化。打包补齐后 seed 分片条目自然变多，两条管线经 M1 统一解析
  （specs/plugin-official-cache-authority-m1.md M1-4 衔接说明）同步看见，消费侧零改动。

## 验收场景

1. 生产打包（prepare-agent-node-bundle）后 `resources/glm/packages/` 含全部 11 个
   default-enabled 插件目录，`packages/<name>-plugin/.acode-plugin/plugin.json` 在场。
2. 远端 prebuild 同上（mock-cdn glm 组件目录）。
3. desktop 安装包首启 seed 后，`bundled-marketplace.json` 含 11 个 default-enabled
   条目；设置插件页「内置」分组、设置 skill 页、/命令 catalog 三处可见集合一致。
4. 一致性测试（§R5 断言 A-E）通过；从清单删除任一 default-enabled 条目时测试变红。
5. 打包链对 8 个纯资产插件不执行任何 runtime 构建（构建日志无对应 `building ... runtime`）。

## 验证方式（诚实登记）

本环境无法跑完整 electron-builder / 远端发布链。验证手段：§R5 一致性测试 +
staging 脚本语法干跑（`node --check`）+ 对 staging 白名单/路径逻辑的静态核对；
真实安装包首启 seed 行为属**未验证面**，由发布流程验证。
