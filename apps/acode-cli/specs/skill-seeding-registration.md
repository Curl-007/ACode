# 技能/插件封装与注册机制强化（tier · 播种预算 · description 单源 · 归因）

对标外部范式 T2-4「技能封装/注册机制」的机制面移植（manifest tier、惰性播种上限、
description 单一来源、共享校验套件工程法）与 T3 env 归因条目的现状盘点。**只搬机制，
不搬内容本体**；外部厂商代号不进入 ACode 表面（`bundled:` skillId 前缀、`agentSkillsRef`
等不照抄——ACode 已有自己的身份约定：`<name>@<marketplace>` 插件 id、`<plugin>:<skill>`
技能 qualifiedName、`SkillSource` 闭集）。

落点裁决：新建本 spec。既有 `agent-teams-derived-config.md` 是单插件注册链 spec
（R1/R2 继续有效，本 spec 不改其裁决）；`plugin-foreign-manifest-compat.md` 管 manifest
目录候选集，本 spec 的 tier 字段沿同一发现链读取，不新增候选目录。

## 背景：已核实的现状（基线 635f6a7）

| 事实 | 位置 |
| --- | --- |
| enabled 派生 = `config.enabledPlugins[id] ?? (candidate.defaultEnabled \|\| officialPluginsEnabledByDefault.has(id))`；默认名单在 bootstrap definitions（`defaultEnabled`）与 `packages/shared/src/plugin-marketplaces.ts` 手工镜像两处，parity 测试机械对照 | `adapters/src/plugins/index.ts:186-191,1005-1007`、`bootstrap/src/app/official-plugin-definitions.ts:332-336` |
| 官方插件 seed：锁 + 唯一 backup + rename 原子替换 + hash 校验 + 旧缓存降级回退（moveExistingAside 语义已完备）；filesystem 源 walk **无条目上限** | `bootstrap/src/app/bundled-plugins.ts`（`replaceSeedRoot`、`collectFilesystemPluginFiles`） |
| bundled 技能包 SEA 物化：tmp + rename + 完整性 marker + 旧包回退；manifest.files **无条目上限**；marker 只有 `{hash,version}`，无来源归因字段 | `bootstrap/src/app/bundled-skills.ts:143-188` |
| zip 安装已有 `ZIP_MAX_ENTRIES=20_000`；安装链已有 atomic-directory 事务（backup/transaction record/recovery） | `adapters/src/plugins/zip-source.ts:17`、`atomic-directory.ts` |
| 商店描述：bundled 分区条目 `description` 取 plugin.json（单源），`description_i18n` 只取 definitions listing seed——**plugin.json 自己的 description_i18n 无人消费**，且与 listing seed 现存漂移（agent-teams、image-search、documents/pdf/presentations/spreadsheets 四表驱动条目共 6 插件） | `bundled-plugins.ts:410-451`、`official-plugin-definitions.ts`、各 `.acode-plugin/plugin.json` |
| 同名技能双拷贝：`bundled-skills/skills/dynamic-workflows`（1617 行，持续演进）与 `acode-guide-plugin/skills/dynamic-workflows`（557 行，469024e 引入）**内容漂移**；发现按 path 去重不按 name，两份都会进模型技能列表（`dynamic-workflows` 与 `acode-guide:dynamic-workflows`），路由文本互相矛盾 | `adapters/src/skills/index.ts:72-88`、两包 skills 目录 |
| 归因面已存在：`SkillRoot.source/pluginId`、Skill 遥测 metadata（qualifiedName/pluginId/source）、`PluginMetadata.marketplace/source/rootPath/manifestPath`、seed marker（marketplace/plugin/pluginVersion/source∈{filesystem,sea}/hash）、bundled 分区条目（source+cachePath）、日志 `module/operation/pluginId` 结构化字段 | contracts、`bundled-plugins.ts:608-617`、`official-marketplace.ts` |
| env 注入面已存在：MCP stdio 得 `ACODE_PLUGIN_ID/ROOT/DATA` + `ACODE_PROJECT_DIR` + `CLAUDE_PLUGIN_ROOT/DATA`、`CLAUDE_PROJECT_DIR` 兼容位（ID 由 resolver 权威覆写防伪造）；hooks 得 `ACODE_PLUGIN_NAME/ID/ROOT/DATA` + SESSION/PROJECT；技能正文与自定义命令支持 `${ACODE_SKILL_DIR}`/`${CLAUDE_SKILL_DIR}` 展开 | `adapters/src/plugins/mcp.ts:211-227`、`core/src/hooks/configured-runner-input.ts:126-166`、`core/src/tool/handlers/skill.ts:74-77` |
| 四个文档插件（documents/presentations/spreadsheets/pdf）的 `env_setup/*` 与 `agents/visual-judge.md` 均为 per-toolchain 定制（docx=defusedxml、xlsx=openpyxl+LibreOffice、pdf=LaTeX），sha256 两两不同，**不存在字节级相同的共享校验层** | 各插件包 skills/*/env_setup、agents |
| 架构 ratchet：`bundled-plugins.ts`（710）、`adapters/src/plugins/index.ts`（1007）、`marketplace.ts`（2814）在 legacy baseline，**只减不增**；新文件 ≤400 行 | `.architecture-baseline.json` |

## 裁决总览（A–E）

| 项 | 裁决 | 理由 |
| --- | --- | --- |
| A manifest tier | **做**（插件级，官方市场限定） | 包自描述默认启停，向「enabled 派生单一来源」收敛的第一步；缺省=现状，向后兼容 |
| A' enabled 名单完全单源化（退役 definitions.defaultEnabled 与 shared 镜像） | **分批**（本波不做） | `packages/shared` 为禁触面；镜像名单由 parity 测试看守，漂移即红。批 2 需协调 shared/desktop |
| B maxEntries 播种预算 | **做**（官方插件 seed 两源 + bundled-skills SEA 物化，2000 上限） | 防失控膨胀；对齐外部范式 maxEntries=2000 |
| B' moveExistingAside | **不做**（已存在，本 spec 钉住语义 + 测试固化） | `replaceSeedRoot` 唯一 backup/回滚、atomic-directory 事务、bundled-skills tmp+rename 已是同语义实现，不重造 |
| B'' 市场安装链（git 源）条目上限 | **不做**（登记） | zip 已有 20k 上限；git 源体量天然由仓库约束，且 `activateDirectoryAtomically` 是多流程共享工具，本波不动 |
| C description 单一来源 | **做**（plugin.json 为商店描述事实源；definitions listing 降级为回退；两源并存 locale 必须逐字一致，测试守护）；现存 6 插件漂移**本波修** | 外部范式「两处冗余必须逐字相同」；包内文本随 CDN/SEA/filesystem 三通道同行，最贴近单一来源 |
| C' SKILL.md ↔ 插件 manifest description 逐字校验 | **不做** | ACode plugin.json 不逐技能声明 description（`skills` 只指目录），该冗余不存在，无物可比 |
| C'' 同名技能单源（删双拷贝） | **做（裁决落地）**：dynamic-workflows 单源=bundled，删 acode-guide 陈旧副本；守护测试断言 bundled∩官方插件无同名技能 + 已删副本不复活 | 双拷贝致 `/workflow` 路由不确定 + 模型列表两条矛盾同名路由；bundled 副本与当前工具集吻合且持续演进（详见 R4） |
| D 归因面 | **做便宜部分**：seed 结果 info 级生命周期日志（outcome 闭集）、bundled-skills marker 补来源字段；**env 面盘点后裁决不新增**（MCP 不补 `ACODE_PLUGIN_NAME`：ID 已含 name，避免表面膨胀） | AGENTS.md：生命周期事件用 info；env 面已覆盖 root/data/id/name/skill-dir，无实质缺口 |
| E 共享校验套件工程法 | **评估登记**（本波无实现） | 四文档插件无字节级重复脚本（hash 已核）；「单拷贝 + sha256 parity 守护 + `--original` 基线化」登记为后续文档技能校验层的设计指引 |
| 技能级 tier（skill 粒度 default_false） | **不做**（登记落点） | bundled 技能无启停表面（不可卸载/无开关）；插件技能随插件启停。未来需要时落点：SKILL.md frontmatter `tier` + discovery 过滤，与 `disabledPaths` 机制合流 |

## 产品规则

### R1 plugin.json `tier` 字段（插件级默认启停的包内事实源）

- `.acode-plugin/plugin.json` 新增可选顶层字段 `tier`，闭集 `"always" | "default_false"`。
  缺省（字段不存在）= 现状行为，任何既有插件/第三方插件不受影响。
- **只对官方市场生效**：`marketplace === "acode-plugins-official"` 的候选（内置 seed 与
  CDN 安装同路）才读取 tier；inline / 第三方市场 manifest 里的 tier 一律忽略——第三方
  插件不得自我声明默认启用。
- 派生顺序（单一函数 `resolvePluginDefaultEnabled`，`adapters/src/plugins/manifest-tier.ts`）：
  1. 官方市场且 tier 合法：`defaultEnabled = tier === "always"`（**tier 优先于** bootstrap
     默认名单——包是事实源）；
  2. 其余：`candidate.defaultEnabled || officialPluginsEnabledByDefault.has(id)`（现状）；
  3. 用户显式配置永远最高：`enabledPlugins[id] ?? defaultEnabled`（`resolveEnabled` 不变）。
- tier 值非法（非闭集字符串）：发 `plugin_manifest_invalid` / severity `warning` 诊断，
  按缺省处理。不新增诊断码（contracts 闭集为禁触面）。
- 官方插件包全量补齐 tier，与现状 `defaultEnabled` 一致（行为零变化）：
  `always` = node-repl-host、browser-use、image-search、documents、pdf、presentations、
  spreadsheets、skill-creator、plugin-creator、acode-guide、agent-teams；
  `default_false` = android-emulator、ios-simulator、restore-legacy-sessions。
  **例外登记**：computer-use（acode-cua-plugin）本波不加 tier——其 plugin.json 被
  第三方发布台账按 sha256 逐字钉住（`third-party/inventory.json` 上游派生组件清单，
  L01 门禁），加字段必须同批再生台账，而台账不在本波所有权内。tier 缺省 = 现状行为
  （default 关），无行为差异；批 2（contracts/shared 单源化）随台账再生一并补齐。
- tier 是内容变更非版本变更：seed 缓存身份是内容 hash（marker.hash），加字段自动触发
  re-seed；同版本 CDN zip 无 tier 时走缺省路径，无需版本 bump。
- **一致性守护**：parity 测试机械对照「plugin.json tier ↔ definitions.defaultEnabled」，
  两处漂移即红（过渡期双源必须同真值；批 2 单源化后退役对照）。

### R2 播种条目预算（maxEntries）

- 官方插件 seed（filesystem 与 SEA 两种源同点把关）：单插件 `files.length > 2000` 拒绝
  写缓存，按既有降级协议处理——`warnCacheDegraded`（operation `seed_plugin`，errorCode
  `ACODE_PLUGIN_SEED_TOO_LARGE`）+ 进入 failedSeeds 走旧缓存回退；**不得**静默丢插件。
- bundled 技能包 SEA 物化：`manifest.files.length > 2000` 拒绝物化，warn 后按
  「pack 不可用」既有路径降级（filesystem 候选兜底 → 缺席时技能门 fail-closed）。
- 上限常量各自文件内单点定义（`MAX_OFFICIAL_PLUGIN_SEED_ENTRIES` /
  `MAX_BUNDLED_SKILL_PACK_ENTRIES`），取值 2000 对齐外部范式；调整需在 spec 登记。
- 构建期（sea-*.mjs 暂存脚本）**不设**同款上限：SEA manifest 是发布产物，运行时门已
  兜底；构建产物失控属发布管线问题，登记不做。
- moveExistingAside 既有语义（本 spec 钉住，测试固化）：
  - 官方插件：写唯一 tmp 目录 → 唯一 backup（pid+时间戳）→ rename promote；promote 失败
    且目标非并发赢家时恢复 backup；成功后清理自己的 backup 与遗留 backup。
  - bundled 技能包：tmp（pid+uuid）→ rename；失败回退任一完整旧包。
  - 任何播种失败不得毁坏既有可用缓存（失败即回退旧代，不删旧代）。

### R3 description 单一来源（商店描述）

- **事实源 = 插件包 `.acode-plugin/plugin.json`** 的 `description`（EN 基线，现状已单源）
  与 `description_i18n`（本波接入）：`writeOfficialMarketplace` 生成的 bundled 分区条目，
  `description_i18n` 在 plugin.json 声明时**整表覆盖** definitions listing seed 的
  `description_i18n`；plugin.json 未声明时 listing seed 作回退（browser-use、computer-use
  等仅有 listing zh-CN 的插件行为不变）。
- definitions `listing.description_i18n` 自本波起定位为**回退文案**：凡 plugin.json 与
  listing seed 都声明同一 locale，两处必须逐字一致（parity 测试守护）。
- 现存漂移修复（以 plugin.json 为准，改 definitions 侧，插件包文本不动以免影响外部
  CDN 目录管线）：agent-teams zh-CN、image-search zh-CN、documents/pdf/presentations/
  spreadsheets 表驱动 zh-CN。用户可见影响：内置分区的商店 zh-CN 描述与 EN 描述
  （doc 系四插件 + agent-teams 的 `description_i18n.en`）切换为包内文本。
- SKILL.md frontmatter description 仍是技能路由文本的唯一来源（无第二处冗余，见 C'）。

### R4 同名技能单源规则（dynamic-workflows 双拷贝裁决已落地）

- **规则**：一个技能名不得同时由 bundled 技能包与官方插件包携带。技能发现按 root 优先级
  去重、`loadSkill` 按裸名 `find` 首个匹配——同名双拷贝会让 `/workflow` 的
  `skills: dynamic-workflows` 命中哪一份取决于 name 排序后的数组次序（两份 name 相同），
  路由不确定；且陈旧副本仍进模型技能列表，两条同名路由文本互相矛盾。单源即消除歧义。
- **裁决（2026-10-15，方案 b）**：`dynamic-workflows` 的唯一来源是 bundled 技能包，删除
  `acode-guide-plugin/skills/dynamic-workflows/` 陈旧副本（557 行，引用旧世代 facade §14）。
  依据：bundled 副本（1617 行，引用 §17 + 覆盖 hole()/FillWorkflowHole/SaveWorkflow/背景
  运行）与当前工具集吻合并持续演进；技能门 `DYNAMIC_WORKFLOW_SKILL_NAME` 依赖 bundled 侧；
  桌面 stage 注释已证实 `/workflow` 依赖 bundled 副本；安装版技能列表指向 bundled 侧内容。
  同步项：`OFFICIAL_ACODE_GUIDE_REQUIRED_SEED_PATHS` 收敛为 `commands/workflow.md`（不再钉
  已删技能正文）、acode-guide 版本三处 bump 0.2.0→0.3.0（package.json/plugin.json/definition）、
  插件 README 的技能计数与 dynamic-workflows 归属更正。acode-guide 不进 SEA/desktop/server
  三个运行时插件清单（仅 browser-use/node-repl-host/agent-teams），无额外发布清单需改。
- **守护**（`plugin-registration-description-parity.test.mjs`）：断言 bundled∩官方插件无同名
  技能（任何双拷贝即红）、已裁决单源技能存在于 bundled、已删副本不复活。`SINGLE_SOURCE_SKILLS`
  登记裁决名单，防回归。

### R5 归因面（日志/清单/env）

- seed 生命周期 info 日志（一次 seeding 一条汇总）：`module: bootstrap.official_plugin_cache`、
  `operation: "seed_summary"`、`source ∈ {filesystem, sea}`、`plugins: [{pluginId, version,
  outcome}]`；**outcome 闭集**：`reused | written | degraded | rejected_incomplete |
  rejected_oversize`。不使用 `status` 键（避开日志保留闭集）。degraded/rejected 明细仍走
  既有 warn（errorCode、missingSeedPaths 字段不变）。**降级集合的唯一事实源是
  seed_summary 的 outcomes**：`resolveOfficialPluginRoots` 的返回值是根路径数组
  （string[]），不承载 failed 语义；测试与消费方不得从返回值反推降级集合
  （2026-10-20 修复：旧测试 `string[].name` 恒 undefined，dist 未构建 checkout 上
  对降级插件误断言 marker 存在）。
- seed marker（`.acode-plugin-seed.json`）字段维持并钉住：`{hash, marketplace, plugin,
  pluginVersion, source∈{filesystem,sea}, version:1}`；bundled 技能包 marker
  （`.acode-bundled-skills-seed.json`）补 `{source:"sea", entries}` 归因字段（读取端只依赖
  `hash`，向后兼容）。
- env 盘点结论（登记，不新增）：MCP stdio=`ACODE_PLUGIN_ID/ROOT/DATA`+`CLAUDE_*` 兼容位；
  hooks=`ACODE_PLUGIN_NAME/ID/ROOT/DATA`+SESSION/PROJECT；技能正文/自定义命令=
  `${ACODE_SKILL_DIR}`/`${CLAUDE_SKILL_DIR}` 展开。命名规约对齐 `ACODE_*`=运行时、
  `CLAUDE_*`=兼容位。缺口裁决：MCP 不补 NAME（ID 已含 name）；不引入
  `ACODE_SKILL_ATTRIBUTION`/`ACODE_PLUGIN_ATTRIBUTION` 类开关（ACode 无遥测面，
  specs/no-telemetry.md，归因走日志与清单而非 env 开关）。

### R6 共享校验套件工程法（E，评估登记）

- 现状：documents/presentations/spreadsheets/pdf 四插件无字节级共享脚本层；`env_setup`
  五件套与 `visual-judge.md` 逐插件定制（工具链不同：Word COM / openpyxl+LibreOffice /
  LaTeX），**非**同一文件的三份拷贝，无「单一来源化」便宜候选。
- 登记设计指引（后续文档技能新增校验器时适用）：
  1. 同一校验/工具脚本被 ≥2 个文档技能需要时，落**单拷贝**（如共享包或单插件内），
     消费方经 `${ACODE_PLUGIN_ROOT}`/`${ACODE_SKILL_DIR}` 引用；确需物理多份分发时，
     parity 测试钉 sha256 逐字节相同。
  2. 校验器带「基线化」能力（外部 `--original` 范式）：对输入文件先跑一次基线校验，
     只把**新增**错误计为失败，模板自带的存量错误不阻塞交付。
  3. 公式/重算类交付闸门（外部 recalc 范式）：校验脚本报错即不许交付，不静默降级。

### R7 pack root 的 dev 形态可解析性（ESM runtimeDir 回退）

`candidateBaseDirs()` 的 runtimeDir 在 bootstrap `type: module` 下经 tsx/ESM 运行时
`__dirname` 为 undefined，filesystem 三形态解析在 dev 形态（src 直跑、仓库内测试）
永远落空——bundled 技能/预置 agent 包明明在 `apps/acode-cli/packages/bundled-skills`
却解析为缺席（2026-10-20 builtin-subagent-catalog R6 断言失败的根因）。修复：
`__dirname` 缺席时回退 `dirname(fileURLToPath(import.meta.url))`（src/app 与 dist/app
同深度，候选相对路径两形态同命中）；SEA 形态与 entrypoint/cwd 候选语义不变。

## 验收场景

1. 官方插件包 plugin.json 均含合法 tier，且与 definitions.defaultEnabled 真值一致；
   漂移即红（`plugin-registration-tier-parity.test.mjs`）。
2. `resolvePluginDefaultEnabled`：官方+always→默认开；官方+default_false→即使 id 在
   bootstrap 默认名单也默认关（tier 优先）；缺省→现状名单语义；inline 市场 tier 被忽略；
   非法 tier→warning 诊断+缺省语义；用户显式 `enabledPlugins[id]` 永远压过 tier。
3. seed 文件数 >2000 的官方插件被拒绝写缓存并 warn（errorCode `ACODE_PLUGIN_SEED_TOO_LARGE`），
   既有旧缓存可回退；bundled 技能包 SEA manifest >2000 拒绝物化并 warn
   （`skill-seeding-entry-budget.test.mjs`）。
4. 播种失败（hash 不匹配/超预算/缺 required 路径）不毁坏既有缓存代：目标目录要么是完整
   新代，要么保持旧代可用（`skill-seeding-integration.test.mjs` + 既有降级路径）。
5. 真实 monorepo 布局下 `resolveOfficialPluginRoots` 播种：marker 含归因字段；bundled
   分区条目 description=plugin.json、description_i18n 包内优先/缺席回退 listing；重跑幂等
   （无 .tmp-*/.backup-* 残留，marker 不变）（`skill-seeding-integration.test.mjs`）。
6. 6 个漂移插件的 definitions listing zh-CN 与 plugin.json 逐字一致；全部官方插件两源同
   locale 均一致（`plugin-registration-description-parity.test.mjs`）。
7. 技能单源：bundled∩官方插件无同名技能（双拷贝即红）；`dynamic-workflows` 存在于
   bundled 且已从 acode-guide 删除、不复活；`SINGLE_SOURCE_SKILLS` 登记裁决
   （`plugin-registration-description-parity.test.mjs`）。
8. 既有回归：`agent-teams-registration-parity`（tier 加入后版本四处一致与默认名单对照
   仍绿）、`sea-bundled-skill-assets`、`bundled-verify-run-skills`、
   `bundled-research-review-skills`、`plugin-zip-extract`、`plugin-foreign-manifest-compat`。

## 边界与登记

- 禁触面依赖：`PluginManifest`（contracts）暂无 tier 类型位，adapters 侧以 unknown 收窄
  读取（`parsePluginManifestTier`）；批 2 把 tier 提升进 contracts 类型与 shared 镜像退役
  一并做（需协调 packages/shared、desktop 设置页）。
- 已落地（协调裁决后本波补做）：acode-guide dynamic-workflows 副本删除 + 单源化（R4）；
  plugin-creator `references/plugin-json-spec.md` 补 tier 字段文档。
- 批 2 已处理（2026-10-16）：computer-use 补 `tier: "default_false"`（definitions 无
  `defaultEnabled: true`，R1 同真值守护满足），同批以 CI Linux 规范重生成
  `third-party/inventory.json` sha256 钉扎回补（licenses-notices workflow_dispatch 产物），
  tier parity 测试的 `TIER_PENDING_LEDGER_REGENERATION` baseline 缩小为空。仍待批：
  tier 提升进 contracts `PluginManifest` + shared 镜像名单退役（禁触面，需协调
  packages/shared 与 desktop 设置页）。
- 本 spec 不改 `agent-teams-derived-config.md` R1/R2 的注册与清单裁决；唯一交叠是 R3 把
  agent-teams listing 的 zh-CN 回退文案对齐到 plugin.json（「分支原样 listing」的措辞以
  本 spec R3 为准修订）；tier 与 defaultEnabled 在过渡期必须同真值（R1 守护）。
