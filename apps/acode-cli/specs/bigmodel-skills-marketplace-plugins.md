# 智谱 BigModel 技能集 → 官方市场按需安装插件（8 个分类内容包）

把「智谱 BigModel 技能市场离线包」（125 个技能，提取日期 2026-10-17，来源
<https://open.bigmodel.cn/managed-agents/skills>）收录为官方市场的**内置插件**
（CONTEXT.md 术语：随应用包分发、启动时播种进官方市场），按源平台分类拆成 8 个纯内容
插件，`tier: "default_false"` 默认关闭——用户在商店按需启用，启用哪类才加载哪类技能。

## 背景与裁决

| 问题 | 裁决 | 理由 |
| --- | --- | --- |
| 放 bundled-skills 内置技能包？ | **否** | 该通道语义是「产品功能的配套技能」（specs/skills-bundled-visibility-and-official-cache-authority.md），无启停开关、全部常驻模型技能列表；125 个通用技能进去即永久占用每次会话上下文且不可卸载。 |
| 做 CDN 插件？ | **否（本波）** | CDN 目录发布在仓库发布面之外，仓库内无法自足交付；内置通道（seed）是唯一仓库内闭环。后续若上 CDN，只需从三份 staging 清单撤下条目，definitions/listing 不变。 |
| 1 个大包还是 125 个小包？ | **8 个分类包** | 启停粒度=插件：1 大包启用后 125 条技能描述全进系统提示；125 小包爆炸市场列表与注册面（每包 ×4 处清单）。8 分类=源平台自有分类（研发 28/数据分析 21/文档办公 16/企业管理 15/销售客服 14/内容创作 12/产品运营 12/运维 7），启用后每类 7–28 技能，上下文可控且用户可按需组合。 |
| 许可可行性 | **可行** | 125 技能逐一核对：Apache-2.0 × 82、MIT × 43，无其他；两者均允许再分发，条件是保留版权与许可声明——每技能目录内的 LICENSE / NOTICE.md / UPSTREAM.md / MODIFICATIONS.md 原样入库即满足。 |

体量：880 文件 / 3.0 MB（纯文本），随桌面安装包与远端 prebuilds 分发；seed 按内容
hash 幂等，单包最大 257 文件，远低于 `MAX_OFFICIAL_PLUGIN_SEED_ENTRIES=2000` 预算。

## R1 包与命名

包目录 `apps/acode-cli/packages/<plugin name>-plugin`，包名 `@acode/<plugin name>-plugin`
（private，无构建脚本），plugin.json `name` = 目录名去 `-plugin` 后缀（loader 规则
`^[a-z0-9][a-z0-9._-]{0,127}$`）。版本三处一致（package.json / plugin.json / definition，
browser-use 分叉教训）：全部 `0.1.0`。

| 分类 | plugin name | 商店 category | displayName | displayName zh-CN | 技能数 | requiredSeedPaths 锚点 |
| --- | --- | --- | --- | --- | --- | --- |
| 研发 | `bigmodel-skills-dev` | developer-tools | BigModel Skills · Development | 智谱技能集 · 研发 | 28 | `skills/optimize-web-performance-cn/SKILL.md` |
| 数据分析 | `bigmodel-skills-data` | productivity | BigModel Skills · Data Analysis | 智谱技能集 · 数据分析 | 21 | `skills/finance-news-analysis/SKILL.md` |
| 文档办公 | `bigmodel-skills-office` | productivity | BigModel Skills · Office & Docs | 智谱技能集 · 文档办公 | 16 | `skills/verify-public-claims-cn/SKILL.md` |
| 企业管理 | `bigmodel-skills-management` | productivity | BigModel Skills · Management | 智谱技能集 · 企业管理 | 15 | `skills/plan-project-delivery-cn/SKILL.md` |
| 销售客服 | `bigmodel-skills-sales` | productivity | BigModel Skills · Sales & Service | 智谱技能集 · 销售客服 | 14 | `skills/discover-customer-opportunities-cn/SKILL.md` |
| 内容创作 | `bigmodel-skills-content` | productivity | BigModel Skills · Content Creation | 智谱技能集 · 内容创作 | 12 | `skills/video-clipper/SKILL.md` |
| 产品运营 | `bigmodel-skills-product` | productivity | BigModel Skills · Product Ops | 智谱技能集 · 产品运营 | 12 | `skills/marketing-psychology/SKILL.md` |
| 运维 | `bigmodel-skills-ops` | developer-tools | BigModel Skills · SRE & Ops | 智谱技能集 · 运维 | 7 | `skills/engineer-service-reliability-cn/SKILL.md` |

锚点=该分类安装量最高技能的 SKILL.md（index.json installCount），作用是 seed 完整性门
的最小钉：分类包整体走 staging 白名单目录复制，锚点缺席即代表 skills 子树被裁。

listing author 统一 `{ name: "Zhipu BigModel Skill Market", url:
"https://open.bigmodel.cn/managed-agents/skills" }`（合集策展方；单技能作者署名在各技能
目录与包 README 清单中保留）。icon 用 `OFFICIAL_PLUGIN_ICON` 内嵌占位。

## R2 许可与署名

- 每技能目录**原样**保留 LICENSE / NOTICE.md / UPSTREAM.md / MODIFICATIONS.md 等许可与
  来源文件（位于 `skills/` 子树内，seed walk 与两份 staging 白名单均全量覆盖）。
- 包根**不放** LICENSE 文件：顶层白名单（`includedTopLevelPaths` /
  `includedOfficialPluginTopLevelPaths` / `remoteOfficialPluginTopLevelPaths`）不含
  `LICENSE`，放了会被静默裁掉造成「仓库可见、分发缺席」的不一致；包级署名以
  `README.md`（白名单内）承载：来源、提取日期、许可构成（Apache-2.0 × 82 / MIT × 43）、
  逐技能清单（displayTitle / 目录 / 作者 / 版本 / sourceUrl）。
- plugin.json 与 package.json 的 `license` 写 SPDX 表达式 `Apache-2.0 OR MIT`（逐技能
  许可以各自 LICENSE 为准，README 说明）。

## R3 内容适配闭清单

对源内容的改动**仅限**以下三类，逐条记入对应技能目录的 MODIFICATIONS.md（沿用离线包
自身的修改登记惯例）；除此之外不改任何技能正文：

1. **目录 slug 重命名**（插件技能按目录发现、Skill 工具按 frontmatter name 调用，
   含空格/大写的名字不符合调用面惯例）：
   - `Excel Analysis/` → `excel-analysis/`，且 frontmatter `name: Excel Analysis` →
     `excel-analysis`；
   - `Lead Research Assistant/` → `lead-research-assistant/`（frontmatter name 本就是
     `lead-research-assistant`，仅目录名对齐）。
2. **删除 ACode 不消费的 frontmatter 键**（未知键会把技能标成 `safeToAutoLoad=false`）：
   - creative-writing：删 `skills:`（含其缩进列表项）；
   - image-analyzer：删 `source:`；
   - weekly-report-writer：删 `depends_on_skill:`、`depends_on_binary:`。
3. **不随包入库的源目录顶层文件**：`README.md`、`index.json`、`.agent-teams/`（离线包
   自身的说明与索引，非技能内容；包 README 由 index.json 数据重新生成）。

除上述三类外不得「顺手修复」技能内容——包括 oxlint 对 vendored 脚本报出的非阻断
warning（如 bi-builder `bi-data-utils.mjs` 的 no-control-regex，是上游 CSV 注入防御的
故意写法）：修它即违反本闭清单，warning 留档不改。

## R4 注册与分发

- definitions 表驱动落在**新文件** `bootstrap/src/app/official-plugin-bigmodel-skills.ts`
  （`official-plugin-definitions.ts` 359/400 行 ratchet，只允许 +2 行 spread 接线）；
  新文件同样受 400 行上限约束，8 条目必须由紧凑表生成，不得逐条展开。
- 三份发布暂存清单登记（specs/desktop-official-plugin-packaging.md R5 机制）：
  1. `packages/desktop/scripts/prepare-agent-node-bundle.mjs` `officialPluginPackages`；
  2. `scripts/prepare-prebuilds.mjs` `remoteOfficialPluginPackages`；
  3. definitions `rootCandidates`（monorepo src/dist、cli/dist、桌面 resources/glm 四布局）。
  条目 `requiredSeedPaths` 与 definition 逐集合一致（packaging-parity 断言 D 看守）。
- **不进**的海面（沿内容插件先例 acode-guide/documents）：SEA `officialSeaPlugins`
  （只嵌 runtime 依赖型插件）、`packages/server` 远端 dev 部署合同（browser-use/
  agent-teams 专属）、`remoteOfficialPluginRequiredPaths` manifest 存在性钉（断言 B 只
  覆盖 default-enabled）。
- **不进** `packages/shared/src/plugin-marketplaces.ts` 默认启用镜像名单（本组插件
  默认关闭；该名单只镜像 defaultEnabled）。
- 8 个插件与既有官方插件一样按 definition 全量参与 filesystem/SEA seed 与
  bundled-marketplace 分片写入：商店公开分段可见（listing 来自 definition listing seed +
  plugin.json description 单源，specs/skill-seeding-registration.md R3）。

## R5 默认关闭与启停语义

- plugin.json `tier: "default_false"`，definition 不写 `defaultEnabled`：
  `resolvePluginDefaultEnabled` 按 tier 得 default-disabled（manifest-tier.ts）。
- enabled 派生 `enabledPlugins[id] ?? defaultEnabled`：用户显式启停永远最高。启用后
  技能以 qualifiedName `bigmodel-skills-<cat>:<skill>` 进模型技能列表；关闭即整体撤出。
- 与 `plugin.json tier ↔ definitions.defaultEnabled` parity 测试一致：
  `default_false` ↔ 无 `defaultEnabled`，两处不得漂移（specs/skill-seeding-registration.md R1）。

## R6 加载有效性不变量（守护测试钉住）

新增 `apps/acode-cli/tests/bigmodel-skills-plugins.test.mjs`：

1. 8 包各就位：`.acode-plugin/plugin.json` 可解析，`name`=目录名去后缀、`tier`
   ="default_false"、`version`=definition.version、声明 `skills` 目录存在。
2. 全部技能可加载：每个 `skills/<dir>/SKILL.md` frontmatter 含非空 `name` 与
   `description`，description ≤ 1024 字符（adapters `MAX_DESCRIPTION_LENGTH`），
   frontmatter 键 ⊆ `SAFE_FRONTMATTER_KEYS`（保 safeToAutoLoad=true）。
3. 名字全局唯一：8 包之间、与 bundled 技能包、与其余官方插件的技能
   （frontmatter name 与目录名两个维度）无冲突（扩展 R4 单源守护到新增面）。
4. 覆盖完整：8 包技能目录合计 =125，且与源 index.json 的分类映射一一对应
   （重命名映射 excel-analysis / lead-research-assistant 显式登记）。
5. 每技能目录保留 LICENSE 文件（R2 署名不丢失）。

## R7 工程面

- 8 个新 workspace 包由根 `pnpm-workspace.yaml` 的 `apps/acode-cli/packages/*` glob
  自动纳管；需同批 `pnpm install` 更新 lockfile importers，否则 CI frozen-lockfile 红。
- 拷贝/生成由一次性脚本完成（scratch，不入库）；入库后内容即事实源，不建持续同步机制
  （离线包是快照，上游更新走人工重提取+版本 bump）。

## 验收场景

1. **首启 seed**：monorepo dev / 桌面 resources/glm 布局下，8 包被 filesystem seed 进
   官方 cache，bundled-marketplace 分片含 8 条 listing（zh displayName 与描述来自
   plugin.json），商店公开分段按 category 分组可见。
2. **默认关闭**：未配置 enabledPlugins 时 8 插件均 disabled；其技能不出现在模型技能
   列表，`/` 面板与 `$` 引用面板不出现其技能。
3. **按需启用**：启用 `bigmodel-skills-dev` 后，28 个研发技能进入技能列表（qualifiedName
   前缀正确）；关闭后撤出。其余 7 包不受影响。
4. **一致性**：`official-plugin-packaging-parity`（断言 A–E）、
   `plugin-registration-description-parity`（R3/R4）、`bigmodel-skills-plugins`（R6）
   全绿；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 无新增违规。
5. **许可完整**：抽查任一启用技能的目录，LICENSE/UPSTREAM/NOTICE/MODIFICATIONS 与源
   离线包逐字节一致（除 R3 登记的适配项）。
