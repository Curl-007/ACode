# Spec：官方 cache 权威解析单点（M1，adapters 侧）

owner：plugin-release-fixer（adapters 侧）；契约另一方：skills-surface-fixer
（packages/services 侧，spec：`packages/services/specs/skills-bundled-visibility-and-official-cache-authority.md`
§四——**双方以同一份契约为准**，本文与其 §四逐条同义，评审时对照阅读）。
事实基线：`.agent-teams/reports/t4-cross-verification.md` §二.B3、§三.M1、§五。

## 背景（为何 adapters 侧也要动）

- 两条管线今天对官方 cache 的解析不同：adapters `scanOfficialCache`
  （index.ts:866-905，bundled 分片权威优先，回退 readdir 全扫）vs services
  `scanOfficialPluginCacheRoots`（skillsService.ts:688-716，永远 readdir 全扫）。
  同一磁盘状态下两侧根集合分叉（t4 M1：数据源层含、UI 层过滤的分裂）。
- 修复方式：把 adapters 的分片解析提取为 shared 纯函数，adapters 改为消费同一函数
  （行为等价重构），services 侧由 skills-surface-fixer 消费同一函数。解析逻辑单点，
  两条管线不再可能分叉。

## M1 契约（与 skills-surface-fixer §四 M1-1/M1-2/M1-3 同文）

### M1-1 归属包与公开入口

- 归属包：**`packages/shared`**（adapters 已依赖 `@acode/shared: workspace:*`
  （package.json:114），services 亦然；shared 是双方唯一共同可达且不违反依赖方向的包。
  contracts 是 CLI 侧包，services 不可达，排除）。
- 文件：`packages/shared/src/plugin-official-marketplace-partition.ts`（与
  `plugin-marketplaces.ts` 命名对齐）；经 `src/index.ts` `export *` 进 `@acode/shared`
  主入口。
- **纯函数，零 IO、零 `node:*` import**（shared 主入口跨端；平台能力由调用方注入）。

### M1-2 签名与字段形状

```ts
/** 路径操作注入：Node 调用方传 node:path（resolve/relative/isAbsolute/sep），保持 helper 纯度与跨端安全。 */
export interface OfficialMarketplacePartitionPathOps {
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
  resolve(...segments: string[]): string;
  sep: string;
}

/**
 * bundled-marketplace.json 分片的权威解析（M1 契约）。
 * 返回 undefined：分片缺失/损坏/version !== 1 → 调用方回退 readdir 全扫；
 * 返回数组（可为空）：权威结果，空数组 = 权威声明无内置插件，调用方不得回退。
 * 单条记录无效（name/cachePath 非串、cachePath 越界）时丢弃该条，不影响其余条目。
 */
export function resolveBundledOfficialPluginCachePaths(params: {
  partition: unknown;        // 分片文件的 JSON.parse 产物
  officialCacheRoot: string; // <pluginStorageRoot>/cache/acode-plugins-official（绝对路径）
  path: OfficialMarketplacePartitionPathOps;
}): string[] | undefined;
```

解析规则（每条对齐 `loadBundledOfficialPluginRootsSync`，official-marketplace.ts:35-61）：

1. `partition` 非对象或 `version !== 1` → `undefined`。
2. `manifest` 非对象 → `undefined`；`manifest.plugins` 非数组 → 视为空权威集 `[]`。
3. 每条 plugin：`name`、`cachePath` 均为非空 string，否则丢弃该条。
4. `pluginCacheRoot = resolve(officialCacheRoot, name)`；
   `resolvedCachePath = resolve(cachePath)`（cachePath 允许绝对或相对）。
5. 双重严格后代校验：`officialCacheRoot ⊋ pluginCacheRoot ⊋ resolvedCachePath`，
   任一失败丢弃该条。
6. 返回 `resolvedCachePath` 数组（保持分片内顺序；稳定排序属调用方职责）。

### M1-3 消费方式与分工

| 侧 | owner | 改动 |
| --- | --- | --- |
| adapters（CLI 插件解析） | plugin-release-fixer | `loadBundledOfficialPluginRootsSync` 重构为 `readFileSync + JSON.parse + resolveBundledOfficialPluginCachePaths`（`path` 传 node:path）。**行为等价重构**：undefined vs []、逐条丢弃、双重后代校验由 helper 承接；`scanOfficialCache` 调用面不变；读失败/JSON.parse 失败按 `undefined` 处理（与现 `readJsonRecord` 语义一致）。 |
| services（设置页数据源） | skills-surface-fixer | `scanOfficialPluginCacheRoots` 改造：async 读分片 + JSON.parse（失败按 undefined）+ 调 helper；`string[]` → 直接作为官方 cache roots；`undefined` → 保留 readdir 全扫（含规则 V2 择优）。 |
| bootstrap seed / CDN 写侧 | 不变 | 分片的**写**仍归 adapters（`writeBundledOfficialMarketplacePartitionSync` / `rebuildOfficialMarketplaceSync`），services 绝不写。 |

### M1-4 与线 D 的衔接

打包补齐（specs/desktop-official-plugin-packaging.md）→ seed 分片条目变多 → 两条管线
经同一解析同步看见，消费侧零改动。本 spec 不改打包清单。

## 规则 V：回退分支版本择优（评审锚点，两管线同文）

> 状态：已发 skills-surface-fixer 对表（2026-10-17）；无异议即定稿，有异议以其回文
> 条文为准并在评审门核对两份 spec 一致。

**现状实测**（规则动机）：回退全扫分支两侧都把同名插件全部版本目录收进候选，
下游按**字典序先到先得**去重——adapters `discoverPluginsSync` seen 集合
（index.ts:170-180，重复 id 仅 `plugin_duplicate_id` 警告）、services
`discoverSkills` seenPluginIds（skillsService.ts:819-822）+ localeCompare 预排序。
acode-guide 0.2.0 排在 0.3.0 前 → 降级态**加载旧版本**。

- **V1 分片分支不做择优**：权威清单已单点选定版本；残留目录由
  specs/official-plugin-cache-cleanup.md 兜底删除，扫描器天然忽略。
- **V2 回退分支组内择优**：官方 cache 按插件名（`cache/<name>/<version>` 二级）分组；
  组内仅保留「目录名可解析为版本（semver.coerce 兼容）中 semver 最高者」作为该插件
  候选根；**同版本并列时取目录名字典序较大者**（保证两条管线对同一磁盘状态输出确定
  且一致）；不可解析目录名（含 `.backup*`/`.tmp-*`/`.seed-lock*` 非版本形状）不产出
  候选根。adapters 侧在 `scanOfficialCache` 回退分支内实施；services 侧在
  `scanOfficialPluginCacheRoots` 回退分支内实施。下游 seen 去重退化为纯防御。
- **V3 判据单点**：shared 纯函数（数值三元组、semver.coerce 兼容语义，不给 shared
  引入 semver 依赖；表驱动测试钉 `0.2.0 < 0.3.0`、`0.10.0 > 0.9.0`、coerce 失败 =
  不可解析）。三处消费：M1 回退择优（本 spec）、D2 清理「更旧」判定、一致性测试。
  adapters `version-compare.ts`（更新状态 UX）保持 semver 不动，与判据单点的一致性
  由测试钉住。
- **V4 语义变更声明**：相对现状这是降级分支的显式行为变更（字典序先到先得 →
  semver 最高），理由：消除降级态加载 stale 版本；「undefined → 回退全扫」的触发
  条件与回退事实不变，全扫改为「全扫后组内择优」。分片主路径（正常态）零行为变更
  （M1-3 行为等价）。

## 状态所有者

| 状态 | 唯一所有者 |
| --- | --- |
| 分片解析逻辑 | shared 纯函数（M1-2） |
| bundled-marketplace.json 分片内容 | adapters（seed/CDN 写侧不变） |
| 官方 cache 根集合（两条管线） | 各自消费同一 helper，无第二份解析实现 |
| 版本比较判据 | shared 纯函数（V3） |

## 验收场景

1. 分片权威：分片只列 P1、cache 有 P1/P2 → 两条管线都只返回 P1 根（services 侧场景
   由对方 spec S5 承接；adapters 侧由既有 scanOfficialCache 行为等价断言承接）。
2. 分片缺失/坏 JSON/version≠1 → 回退全扫 + V2 择优（多版本 fixture 只出 semver
   最高者；不可解析名不出现）。
3. 分片有效但 `plugins: []` → 空数组，不回退（undefined vs [] 语义保持）。
4. helper 表驱动：M1-2 规则 1-6 逐条（含越界 cachePath `../../`、绝对路径出根、
   非串 name/cachePath）。
5. 行为等价：adapters 既有 plugins 测试全绿（`scanOfficialCache` 对同一分片输入的
   输出与重构前一致——分片路径主路径）。

## 测试

- `packages/shared/test/pluginOfficialMarketplacePartition.test.ts`：helper 表驱动
  （对方 spec S8 同表）+ V3 比较函数表（与 D2 清理测试共用样本）。
- `apps/acode-cli/tests/`（adapters 侧新测试或并入既有 plugins 测试文件）：V2 回退
  择优 fixture（多版本目录 + 不可解析名 + .tmp-/.backup 干扰项）；M1-2 语义在真实
  `loadBundledOfficialPluginRootsSync` 接线下的等价断言。
- 最终门：`pnpm typecheck` + `pnpm lint` + `pnpm --filter @acode/adapters test` +
  `pnpm --filter @acode/shared test` + `pnpm architecture:check --changed`；全程不 commit。
