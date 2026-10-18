# Bundled skill 设置页只读可见（线 A）+ 官方 cache 权威解析统一（M1）

状态：draft（待交叉评审）
owner：skills-surface-fixer（services/ui/shared 侧）；adapters 侧实现归 plugin-release-fixer
事实基线：`.agent-teams/reports/t2-skill-listing-diff.md`、`.agent-teams/reports/t4-cross-verification.md`（§二.B3、§三.M1、§五）
用户裁决（已定，不在本 spec 重开）：
1. 7 个 bundled skill（code-review / dynamic-workflows / research-report / run / script-workflows / verify / visualize）在设置 skill 管理页以「内置技能」分组**只读**展示：可见名称/描述/来源，**无启停开关、无删除按钮**。
2. bundled skill **不进 Composer `$` 引用面板**：保留 `apps/acode-cli/packages/bootstrap/src/acode-protocol/skill-reference-catalog.ts:44-48` 的 `source !== "bundled"` 过滤，不改。

---

## 一、产品规则

### R1 bundled skill 的管理面语义（线 A）

- bundled skill 是随 CLI 内容包分发的只读资源：设置页**可见**（名称/描述/路径），**不可启停、不可删除、不可卸载**。它们不产生任何用户可写的持久化状态（不写 `~/.acode/cli/config.json` 的 `skills` 启用表）。
- 设置页分组标题为「内置技能」（i18n 双语，见 §五 i18n）；组内条目只读渲染（无 Switch、无删除按钮），点击可打开详情弹窗（description / scope / path）。
- bundled skill 在 user 与 workspace 两个 scope tab 下**都展示**（与 plugin 分组同待遇：plugin skill 同样跨两个 tab 展示，见 `pluginCapabilityProjection.ts:84-107` 现行为）。bundled 是全局资源，不属于任一 scope。
- bundled skill **不进 Composer `/` 与 `$` 面板**：`skill-reference-catalog.ts` 的过滤保持不动；UI 侧 `filterSkillsForProvider` 对 Composer 两个调用点（`SlashCommandPlugin.tsx:112`、`skillsMentionProvider.ts:81`）维持现状（见 I5）。
- bundled pack 缺席时（资源未随包分发、候选目录找不到）：分组整体隐藏，**不报错、不产生 diagnostic、不伪造条目**。与官方预置 agent 的降级姿态一致（`subagentsService.ts:668` bundledAgentsRoot 缺省语义，specs/builtin-subagent-catalog.md R7）。

### R2 bundled skill 的运行时语义不变（线 A 非目标）

- 运行时加载链路（系统提示注入、`/workflow`、`/ultracode` 内置命令、工具技能门）**零改动**。本线只改管理面可见性。
- `~/.acode/cli/config.json` 的 `skills.<path>.enable` 启用表**不适用**于 bundled skill：服务层拒绝为 bundled skill 写启用状态（见 I3），运行时也不读该表决定 bundled 加载（现状即如此，bundled 根 priority=1_000_000 直接入发现配置）。

### R3 官方 cache 扫描权威统一（M1）

- **唯一权威**：`<pluginStorageRoot>/marketplaces/acode-plugins-official/bundled-marketplace.json` 分片（bundled 分片权威原则，adapters 侧注释 `adapters/src/plugins/index.ts:871-874` 已声明）。分片存在且 `version === 1` 时，官方 cache 只加载其 `manifest.plugins[].cachePath` 指向的插件根；分片**不存在/损坏/version≠1** 时，回退 `readdir` 全扫 cache 目录。
- 分片有效但 `plugins` 为**空数组**：权威声明"无内置插件"，返回**空数组**，**不回退**全扫。`undefined`（无分片）与 `[]`（空分片）语义必须区分——这是现 adapters 实现的既有语义（`official-marketplace.ts:35-61` 返回 `string[] | undefined`，`scanOfficialCache:875-881` 以 `!== undefined` 判定），统一后不得丢失。
- 分片内单条记录无效（name/cachePath 缺失、cachePath 越界）时**丢弃该条**，不使整个分片失效、不抛错（`official-marketplace.ts:46-60` 现语义）。
- 三条管线（CLI 插件解析 adapters `scanOfficialCache`、设置页 skills 数据源 services `scanOfficialPluginCacheRoots`、设置页 commands 数据源 services `commandsService`）消费**同一份解析结果**，插件根集合不再分叉。设置页数据源层不再包含被权威清单屏蔽的插件贡献的 skill 与命令（消除 t4 §三.M1 的"数据源层含、UI 层过滤"分裂——统一后数据源层即不含）。commands 管线曾残留第三份私有实现（全版本目录 readdir + 字典序先到先得），已收敛到 services 侧单点 `#src/plugins/officialPluginCacheRoots.ts`（skills 与 commands 共同 import），不再分叉。

---

## 二、状态所有者

| 状态 | 唯一所有者 | 说明 |
| --- | --- | --- |
| bundled skill 清单（设置页展示用） | `packages/services` skillsService `discoverSkills` | 扫描 host 注入的 `bundledSkillsRoot` 目录产出 `SkillSummary[]`；不新增第二份清单缓存 |
| bundled 资源根定位 | desktop/remote host（`packages/services/src/node.ts` ServiceCollection 装配 options） | host 持有资源定位链（`findACodeAgentRuntimeNodeBundle` + cwd 候选），services 只消费注入的路径字符串 |
| bundled skill 的启停/删除状态 | **不存在**（设计上无此状态） | 服务层对 bundled scope 的 setEnabled/deleteSkill fail-closed |
| bundled-marketplace.json 分片内容 | CLI adapters（bootstrap 启动 seed 覆盖写 + CDN 刷新合并写） | services 只读，绝不写该文件 |
| 官方 cache 插件根集合 | shared 纯函数 `resolveBundledOfficialPluginCachePaths`（§四.M1）+ services 侧单点 `#src/plugins/officialPluginCacheRoots.ts`（分片读取与回退择优） | 解析逻辑单点；adapters、services skills、services commands 是三个消费方，不是三份实现 |
| Composer `$` 面板 skill 清单 | CLI `getSkillReferenceCatalog`（不变） | 继续过滤 `source === "bundled"` |

---

## 三、线 A 接口

### I1 UI 侧获取 bundled 清单的通道（三选一论证，选定：host 注入资源路径）

| 候选 | 论证 | 结论 |
| --- | --- | --- |
| ① CLI 经协议下发（新 v4 方法） | skillsService 的消费点在 host/server 进程（`packages/services/src/node.ts:1666` 装配），不在 CLI 进程内；协议通道需 host↔CLI 往返 + 会话/无会话两种 authority + CLI 启动时序耦合（CLI 未就绪时设置页无数据）。bundled 清单是**静态资源目录扫描**，不依赖会话态，不值得一条常驻协议方法；remote 场景还要求 remote host 侧实现同一方法。 | 否 |
| ② 提取共享解析进 packages/shared | `resolveBundledSkillRoots`（`bootstrap/src/app/bundled-skills.ts:90-110`）含 SEA 物化副作用（解压写盘、内容 hash 校验），非纯函数；且 shared 是最底层包、被 apps/acode-cli 反向依赖，shared → bootstrap 方向会成环。`packages/services` 直接 import bootstrap 同样违反任务约束的依赖方向（t2 报告第六节方案的问题所在，不可照抄）。 | 否 |
| ③ host 注入资源路径（IPlatformService/ServiceCollection options） | 与官方预置 agent 的既有通道**完全同构**：`node.ts` ServiceCollection options 已有 `bundledAgentsRoot?: string`（:1361），desktop host（`host/index.ts:2238`）与 remote host（`remoteWorkspaceServiceCollection.ts:365`）用 `resolveBundledAgentsRoot()` 注入。资源定位链（`findACodeAgentRuntimeNodeBundle` 同级目录 + monorepo cwd 候选）已存在且被验证。新增 `bundledSkillsRoot` 是同一模式的平行扩展，零新依赖边、零协议面。 | **选定** |

选定的具体形态：

- 新增 `resolveBundledSkillsRoot(): string | undefined`（services 侧，建议落 `packages/services/src/skills/bundledSkillsRoot.ts`）：候选推导与 `subagentStorage.ts:26 resolveBundledAgentsRoot` 同款（`findACodeAgentRuntimeNodeBundle()` 同级 `packages/bundled-skills/skills`，加 monorepo cwd 候选），仅把末端段从 `agents` 换成 `skills`；同步装配（存在性探测），找不到返回 undefined。
  - 注明的既有 TODO 保持有效（`subagentStorage.ts:22-24`）：待 services/desktop → bootstrap 依赖方向确认合法后，两条候选推导一并收敛到 `@acode/bootstrap` 导出的 `resolveBundledContentPackRoot`；本线不强行收敛，但新代码必须与该 TODO 注释互相引用，防止第三份候选布局滋生。
- ServiceCollection options（`node.ts` 装配函数的 options 接口，`bundledAgentsRoot` 相邻处）新增 `bundledSkillsRoot?: string`，`createSkillsService({ isDesktopRuntime: true, bundledSkillsRoot: options?.bundledSkillsRoot })` 注入。
- desktop host `host/index.ts` 在 `createLocalServices` options 里与 `bundledAgentsRoot` 并排注入 `resolveBundledSkillsRoot()`（已落地）。
- remote host `remoteWorkspaceServiceCollection.ts`（已落地；落地形态与字面「并排注入 options」有一处如实偏差，理由如下）：remote workspace 的 `ISkillsService` 是远端 stub（项目级/用户级/插件技能在远端文件系统，不能拿本机服务扫远端 workspacePath），远端机器上的服务装配不经过 desktop 资源定位链，`bundledSkillsRoot` 无法作为 options 并排传入既有注册。因此 remote 侧按 `ISubagentsService` 的 `bundledAgentsRoot` 同款先例，在 collection 内以 `resolveBundledSkillsRoot()` 构造本机 `createSkillsService` 作 bundled lister：`list` 结果中的 `scope: "bundled"` 分组由本机 lister 并入（scope 双向过滤：远端结果中的 bundled 条目被替换、本机 lister 的非 bundled 条目被丢弃，远端数据零丢失），其余方法（启停/删除/prompt 上下文/复制）原样转发远端 stub。bundled 清单唯一所有者仍是 skillsService `discoverSkills`（§二），collection 只组装消费。

**边界诚实声明**：该通道解析的是「与 agent spawn 同一条资源定位链上的 staged 内容包」，与 CLI 进程实际加载的 bundled 根在桌面/远端形态下是同一份目录（`prepare-agent-node-bundle` stage 到 acode.cjs 旁）；SEA 单二进制形态的运行时自物化副本不在本线覆盖内（SEA 形态无设置页，headless）。若未来出现"CLI 实际加载根 ≠ host 解析根"的部署形态，需回到协议下发方案重新评估——写入 TODO 注释。

### I2 SkillScope 类型扩展（packages/shared）

- `packages/shared/src/skills-types.ts:1`：`SkillScope = "workspace" | "user" | "plugin" | "bundled"`。
- 与 CLI contracts 的映射：shared `scope: "bundled"` ≡ contracts `scope: "system"` + `source: "bundled"`（`contracts/src/skills/index.ts:15-16`、`bundled-skills.ts:106-107`）。shared 侧不引入 `"system"`：shared 的 scope 已承担 UI 展示分组语义（`plugin` 亦然），产品词是「内置技能」；两套枚举的映射关系在此登记，收敛时按此对齐。
- 排查所有对 `SkillScope` 的穷举 switch（typecheck 会暴露）；已确认需同步的：`SkillsSection.tsx:260-285 renderScopeLabel`（新增 case，详见 I6）。

### I3 skillsService 行为（packages/services）

`createSkillsService(options)` 新增 `bundledSkillsRoot?: string`。行为：

1. **discoverSkills**（`skillsService.ts:845`）：`bundledSkillsRoot` 已注入且目录存在时，push root descriptor `{ scope: "bundled", rootPath: bundledSkillsRoot }`；目录缺席或未注入 → 不 push、无 diagnostic。扫描复用现有 `collectSkillMarkdownPaths` 管线，产出 `SkillSummary { scope: "bundled", enabled: true, 无 pluginName/pluginId }`。名称冲突处置与现有一致（根去重 `dedupeScanRootsByRealpath` + skill 路径去重）；bundled 与用户/项目/插件同名时 UI 各分组各自展示（scope 分组天然隔离），不合并。
2. **setEnabled**：目标 skill `scope === "bundled"` → throw（文案对齐插件分支风格，如"内置技能不可启停"）。只读语义 fail-closed：UI 不显示开关（I6），服务层再拒一次。
3. **deleteSkill**：`scope === "plugin"` 的拒绝分支（`skillsService.ts:1193`）扩展为 `plugin | bundled`（"内置技能不可删除"）。
4. **buildPromptContext**（`skillsService.ts:1086`）：激活过滤**排除** `scope === "bundled"`。原因（bug 预防，非风格）：该函数按 `$name` 文本匹配 `list()` 全量结果；bundled 进入 list 后，用户 prompt 中手打 `$code-review` 等字样会把 bundled skill 正文重复注入会话上下文——bundled 的上下文注入由 runtime 内置命令/系统提示独占管理，UI 侧重复注入会造成上下文重复且绕过 `/workflow`、`/ultracode` 的技能门语义。
5. **copyToCommon / removeFromCommon**：无入口改动（设置页无 bundled 行的复制按钮；removeFromCommon 的受控根路径判断天然拒绝 bundled 路径）。I6 只读渲染不提供该入口。

### I4 skillSourceFilter（packages/ui）

- `isAcodeSkill`（`skillSourceFilter.ts:30-48`）增加可选放行：`filterSkillsForProvider(skills, provider, options?: { includeBundled?: boolean })`，默认 `false`。
  - `includeBundled: true` 时 `skill.scope === "bundled"` 视为命中 provider 源。**实现偏离回写（t-8 验证门）**：初稿理由「bundled 路径既不在 `/.acode/skills/` 也不在 `/.acode/cli/plugins/cache/` 下，现路径启发式必拒」已被实现证伪——bundled 条目 id 带 `glm:` 前缀（services buildSkillId），会被 `^glm:` id 前缀条件误放行，路径启发式拦不住。实际防线是 `isAcodeSkill` 开头对 `scope === "bundled"` 的**显式拒绝分支**（`skillSourceFilter.ts:34-40`：默认 `return options?.includeBundled === true`，即默认拒、显式传 true 才放行）。钉测试：`packages/ui/test/skillBundledProjection.test.ts` 的 `filterSkillsForProvider` describe 块（:108-124，「glm: 前缀 id」与「非 glm id + 非 glm 路径」两形状）。
  - 默认 false 保证 Composer 两个调用点（`SlashCommandPlugin.tsx:112`、`skillsMentionProvider.ts:81`）**零改动且行为不变**——它们的数据源本就是 CLI catalog（已过滤 bundled），此处是结构性双保险：即使未来 catalog 过滤被误删，Composer 面板也不会因 settings 侧的放行而漏入 bundled。
- `SkillsSection.tsx:457`（scopedProviderSkills）传 `{ includeBundled: true }`；`:514`（找 skill-creator）**不传**（bundled 无该名，保持最小放行面）。

规范结论不变：bundled 默认不进 `$` 引用面板（用户裁决 2），仅设置页「内置技能」分组只读展示。

### I5 UI 分组与只读渲染（packages/ui）

1. `groupSkillsByPlugin`（`pluginManagedResourceGroups.ts:151`）：bundled 不进 `local` 桶（否则会重复出现在「已安装」组）。`ResourceGroups<TLocal, TPlugin>` 扩展第三桶 `bundled: TLocal[]`（local 同型：完整 SkillSummary）。
2. `groupScopedSkillsBySource`（`pluginCapabilityProjection.ts:142`）：bundled 不进 direct 组，产出独立组 `{ id: "bundled", label: <调用方传入的 i18n 文案>, source: "bundled" }`（新增函数参数 `bundledLabel: string`；组内按现有 name 排序约定）。
3. `selectSkillsForScope`（`pluginCapabilityProjection.ts:96-98`）：非 plugin 分支对 `scope === "bundled"` 直接放行（bundled 跨双 tab 展示，不受 scopeFilter 过滤；与 plugin 分支同型的全局资源待遇）。
4. `SkillsSection.tsx` 渲染：分组顺序为「已安装（direct）→ 内置技能（bundled）→ 插件分区（plugin:N）」。bundled 组复用 `SettingsResourceGroupHeader`（title = i18n，count = 组内条数，无 actions）。
5. `renderSkillRow`（`:574`）：控件分支 `skill.scope === "plugin"` 扩展为 `plugin | bundled` → 不渲染 Switch 与删除按钮；行主体（名称/描述/点击开详情）不变。
6. `renderScopeLabel`（`:260`）：新增 `case "bundled"` → i18n `settings.skills.scope.bundled`。
7. 计数修正：`directInstalledSkillCount`（`:492-494`）与 `filteredSkillCount`（`:490`）把 bundled 排除出"已安装"计数，避免 bundled 条目掩盖「没有技能」空态（空态含"新建技能/导入"按钮，bundled 不能让它消失）。
8. 详情弹窗：bundled 的 status 字段恒显「已启用」（enabled 恒 true，诚实投影——bundled 无禁用态）。

### I6 i18n（packages/ui，en-US / zh-CN 双语）

| key | en-US | zh-CN |
| --- | --- | --- |
| `settings.plugin.skills.bundled` | `Built-in skills` | `内置技能` |
| `settings.skills.scope.bundled` | `Built-in` | `内置` |

（对照现有 `settings.plugin.skills.installed` = Installed/已安装、`settings.skills.scope.plugin` = Plugin/插件 的命名与位置惯例。）

### I7 bundled-skills.ts 契约注释更新（apps/acode-cli，注释-only）

`apps/acode-cli/packages/bootstrap/src/app/bundled-skills.ts:13`：

> 旧：它不是插件：不进官方市场目录、没有启停开关、不能卸载，也不出现在设置页与 `$` 引用面板。
> 新：它不是插件：不进官方市场目录、没有启停开关、不能卸载，也不进 `$` 引用面板；设置页以「内置技能」分组只读展示（specs/skills-bundled-visibility-and-official-cache-authority.md R1）。

注释-only，零行为改动；`skill-reference-catalog.ts:44-48` 过滤与注释保持不动。

---

## 四、M1 接口：官方 cache 权威解析单点（与 plugin-release-fixer 的约定）

### M1-1 归属包与公开入口

- 归属包：**`packages/shared`**（adapters 已依赖 `@acode/shared: workspace:*`，services 亦然；shared 是双方唯一共同可达且不违反依赖方向的包。contracts 是 CLI 侧包，services 不可达，排除）。
- 文件：`packages/shared/src/plugin-official-marketplace-partition.ts`（与现有 `plugin-marketplaces.ts` 命名对齐）；经 `src/index.ts` `export *` 进 `@acode/shared` 主入口。
- **纯函数，零 IO、零 `node:*` import**（shared 主入口跨端，浏览器构建不可被 node 模块污染；平台能力由调用方注入）。

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
 * bundled-marketplace.json 分片的权威解析（线 A/M1 spec §四）。
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

分片字段形状（与 `official-marketplace.ts` 现实现逐语义等价，helper 内手写结构校验，不引 zod，避免消费方依赖差异）：

```
partition = { version: 1, manifest: { name: <string>, plugins: [ { name: string, cachePath: string, ... }, ... ] } }
```

解析规则（每条都对齐 `loadBundledOfficialPluginRootsSync`，`official-marketplace.ts:35-61`）：
1. `partition` 非对象或 `version !== 1` → `undefined`。
2. `manifest` 非对象 → `undefined`；`manifest.plugins` 非数组 → 视为空权威集 `[]`（现实现 `readPluginEntries` 对非数组返回 `[]`，即有效分片 + 空条目集）。
3. 每条 plugin：`name`、`cachePath` 均为非空 string，否则丢弃该条。
4. `pluginCacheRoot = resolve(officialCacheRoot, name)`；`resolvedCachePath = resolve(cachePath)`（cachePath 允许绝对或相对）。
5. 双重严格后代校验：`officialCacheRoot ⊋ pluginCacheRoot ⊋ resolvedCachePath`，任一失败丢弃该条（防 `../` 越界与指向分片外的路径）。
6. 返回 `resolvedCachePath` 数组（保持分片内顺序；调用方如需稳定输出自行排序，不属 helper 职责）。

### M1-3 消费方式与分工

| 侧 | owner | 改动 |
| --- | --- | --- |
| adapters（CLI 插件解析） | plugin-release-fixer | `loadBundledOfficialPluginRootsSync` 重构为 `readFileSync + JSON.parse + resolveBundledOfficialPluginCachePaths`（`path` 传 node:path）。**行为等价重构**，现有语义（undefined vs []、逐条丢弃、双重后代校验）由 helper 承接；`scanOfficialCache` 调用面不变。 |
| services（设置页数据源） | skills-surface-fixer（本任务） | `scanOfficialPluginCacheRoots`（`skillsService.ts:688-716`）改造：async 读分片文件（`<pluginStorageRoot>/marketplaces/acode-plugins-official/bundled-marketplace.json`，读失败按 undefined 处理）+ JSON.parse（失败同 undefined）+ 调 helper；返回 `string[]` → 直接作为官方 cache roots（不再自行 readdir cache）；返回 `undefined` → 保留 readdir 全扫，并按规则 V2 做组内 semver 择优（同 spec 6 规则 V：官方 cache 按插件名分组，组内仅保留目录名可解析为版本（semver.coerce 兼容）中 semver 最高者，不可解析目录名含 `.backup*`/`.tmp-*`/`.seed-lock*` 一律不产出候选根；**同版本并列时取目录名字典序较大者**，判据用 V3 shared 纯函数）。实现收敛于 `#src/plugins/officialPluginCacheRoots.ts`，skills（经 `skillsService.ts` 既有导出路径 re-export）与 commands（`commandsService` 直接 import）两条设置页管线共同消费。 |
| bootstrap seed / CDN 写侧 | 不变 | 分片的**写**仍归 adapters（`writeBundledOfficialMarketplacePartitionSync` / `rebuildOfficialMarketplaceSync`），services 绝不写。 |

前置事实（已核实，两管线根推导今天已一致，无需再动）：skillsService `resolveCliStorageRoot`/`resolvePluginStorageRoot`（`skillsService.ts:657-664`）与 bootstrap `getCliStorageRoot`/`getPluginStorageRoot`（`bootstrap/src/app/paths.ts:5-11`）推导相同，`installed_plugins.json`、`cache/`、`marketplaces/` 三个相对位置两侧同源。分片文件位置 `partitionPath = <pluginStorageRoot>/marketplaces/acode-plugins-official/bundled-marketplace.json`（`official-marketplace.ts:129-131`）。

统一后的可见性收敛（对照 t4 §三.M1）：设置页数据源层不再产出被权威分片屏蔽的插件的 skill（如 acode-guide 0.2.0 残留版本贡献的 diagnosing-* / dynamic-workflows 副本）；UI 层 `selectSkillsForScope` 的 plugin 过滤退居二线（仍保留，防御"分片指向已禁用插件"以外的状态漂移），不再是唯一屏障。

### M1-4 与线 D（desktop 打包）的衔接说明

本 spec 不改打包清单（prepare-agent-node-bundle / prepare-prebuilds / build-desktop-agent-cli，归线 D owner）。M1 落地后，打包补齐 → seed 分片条目变多 → 两条管线同步看见，无需再改消费侧。

---

## 五、依赖方向

新增跨包依赖边：**无**。所有改动都在既有依赖方向内：

- `shared`（类型 + 纯 helper）：不新增任何 import；被 services 与 adapters 消费（两方向既有）。
- `services` → `shared`：既有（`skillsService.ts:28` 等）。
- `adapters` → `shared`：既有（package.json:114 `workspace:*`；plugin-release-fixer 消费 helper 时用既有依赖）。
- `ui` → `shared`：既有。
- `desktop host` → `services`（node entry）：既有（`host/index.ts` import `@acode/services/node`）。
- 禁止项重申：`packages/services`、`packages/shared` **不得** import `apps/acode-cli/*`（含 bootstrap 的 `resolveBundledSkillRoots`）；线 A 通道（I1）即为此设计。
- 架构检查：`pnpm architecture:check --changed` 零新违规；skillsService.ts 已有 `max-lines` disable（:1），新增逻辑控制在既有例外内，不新增 disable。

---

## 六、改动面清单

| # | 包 | 文件 | 改动 | 线 |
| --- | --- | --- | --- | --- |
| 1 | shared | `src/skills-types.ts` | `SkillScope` 增 `"bundled"`（I2） | A |
| 2 | shared | `src/plugin-official-marketplace-partition.ts`（新） | 纯解析 helper + `OfficialMarketplacePartitionPathOps`（M1-2） | M1 |
| 3 | shared | `src/index.ts` | `export * from "./plugin-official-marketplace-partition.js"` | M1 |
| 4 | services | `src/skills/bundledSkillsRoot.ts`（新） | `resolveBundledSkillsRoot()`（I1） | A |
| 5 | services | `src/skills/skillsService.ts` | options 增 `bundledSkillsRoot`；discoverSkills 增 bundled 根；setEnabled/deleteSkill/buildPromptContext 守卫；`scanOfficialPluginCacheRoots` 改造为分片权威优先（I3 + M1-3） | A+M1 |
| 6 | services | `src/node.ts` | ServiceCollection options 增 `bundledSkillsRoot` 并注入 createSkillsService（I1） | A |
| 7 | desktop | `src/host/index.ts`、`src/host/remoteWorkspaceServiceCollection.ts` | host/index.ts：与 `bundledAgentsRoot` 并排注入 `resolveBundledSkillsRoot()`；remoteWorkspaceServiceCollection.ts：本机 bundled lister 并入 remote `list` 的 bundled 分组（落地形态见 §三 I1）（I1） | A |
| 8 | ui | `src/lib/skillSourceFilter.ts` | `includeBundled` 选项（I4） | A |
| 9 | ui | `src/settings/pluginCapabilityProjection.ts` | `selectSkillsForScope` 放行 bundled；`groupScopedSkillsBySource` 增 bundled 组（I5.2/I5.3） | A |
| 10 | ui | `src/settings/pluginManagedResourceGroups.ts` | `groupSkillsByPlugin` 增 bundled 桶；`ResourceGroups` 扩展（I5.1） | A |
| 11 | ui | `src/settings/SkillsSection.tsx` | 只读分组渲染、控件分支、renderScopeLabel、计数修正（I5.4-8） | A |
| 12 | ui | `src/i18n/locales/en-US.ts`、`zh-CN.ts` | 两个新 key（I6） | A |
| 13 | acode-cli | `packages/bootstrap/src/app/bundled-skills.ts` | 契约注释更新（I7），注释-only | A |
| 14 | acode-cli | `packages/adapters/src/plugins/official-marketplace.ts` | helper 化重构（M1-3，**plugin-release-fixer**） | M1 |
| 15 | 各包 | `test/`（新测试文件） | 见 §七 | A+M1 |

不做：`skill-reference-catalog.ts`（保留过滤）、Composer 面板组件、运行时 bundled 加载链、打包清单（线 D）、cache 旧版本清理执行（线 D）。

---

## 七、验收场景与测试计划

### 场景（全部可测）

- **S1**：注入 `bundledSkillsRoot`（fixture：tmp 目录含 2 个 skill）→ `skillsService.list()` 返回含 `scope: "bundled"`、`enabled: true`、无 pluginName/pluginId 的条目。
- **S2**：未注入或目录不存在 → list 无 bundled 条目、无 diagnostic、无错误（R1 降级）。
- **S3**：`setEnabled(bundledSkillId)` reject；`deleteSkill(bundledSkillId)` reject（I3.2/3）。
- **S4**：`buildPromptContext` 的 prompt 含 `$<bundled 名>` → `activatedSkillNames` 不含该名（I3.4）。
- **S5**：分片权威优先：fixture `<root>/plugins/marketplaces/acode-plugins-official/bundled-marketplace.json` 只列插件 P1，cache 下存在 P1、P2 两插件目录 → `list()` 的 plugin skill 只来自 P1（M1 R3）。
- **S6**：分片缺失/坏 JSON/version≠1 → 回退全扫（含规则 V2 组内择优），P1、P2 都出现（M1 R3）。
- **S6a**：分片缺失 + cache 下同名插件多版本目录 → 回退全扫后按规则 V2 择优：仅 semver 最高版本产出候选根，不可解析名（含 `.backup*`/`.tmp-*`/`.seed-lock*`）不出现；同版本并列取目录名字典序较大者（与 spec 6 验收 2 同 fixture，两管线输出一致）。
- **S7**：分片有效但 `plugins: []` → 无官方 cache plugin skill，且不回退全扫（M1 R3 undefined vs [] 区分）。
- **S8**：helper 纯函数表：合法分片 → cachePath 数组；坏 version → undefined；越界 cachePath（`../../`、绝对路径出根）→ 该条丢弃；非串 name/cachePath → 该条丢弃；空 plugins → `[]`（M1-2 规则 1-6 逐条）。
- **S9**：UI 纯函数：`selectSkillsForScope` 在 user 与 workspace 两个 scope 下都返回 bundled 条目；`groupSkillsByPlugin` 不把 bundled 放进 local；`groupScopedSkillsBySource` 产出 `id: "bundled"` 组；`filterSkillsForProvider` 默认排除 bundled、`includeBundled: true` 放行（I4/I5）。
- **S10**：SkillScope 穷举消费点经 typecheck 全过（`pnpm typecheck`，I2）。

### 测试落位（哪个包哪一层）

| 测试 | 包 / 层 | 风格 |
| --- | --- | --- |
| helper 纯函数表（S8） | `packages/shared/test/pluginOfficialMarketplacePartition.test.ts`（shared/test 既有 node --test 惯例） | `node --import tsx --test`，纯函数无需 fixture 盘；**V3 比较函数表驱动测试与 D2 清理测试共用样本**（`0.2.0 < 0.3.0`、`0.10.0 > 0.9.0`、coerce 失败 = 不可解析，两侧同一批用例，见 spec 6 规则 V3） |
| skillsService bundled 行为（S1-S4）+ 权威消费（S5-S7） | `packages/services/test/skillsBundledScopeAndCacheAuthority.test.ts` | tmp 目录 fixture；既有 skills 测试无现成文件，参照 `packages/services/test/` 其他服务的 tmp-dir 惯例 |
| UI 纯函数（S9） | `packages/ui/test/skillBundledProjection.test.ts` | 对 projection/groups/filter 纯函数断言（ui/test 既有风格；SkillsSection 组件级无测试先例，不新增组件测试基建） |
| adapters helper 化等价性（S8 复用 + 既有 adapters 测试回归） | plugin-release-fixer 侧；`apps/acode-cli/packages/adapters` 既有 plugins 测试必须全绿 | 行为等价由既有用例 + S8 表驱动兜底 |
| 接线（I1 注入） | typecheck + 评审覆盖（无运行时 E2E 环境；诚实标注未验证面） | — |

### 最终门（实现完成后）

`pnpm typecheck` + `pnpm lint` + `pnpm --filter @acode/shared test && pnpm --filter @acode/services test && pnpm --filter @acode/ui test` + `pnpm architecture:check --changed`；全程不 commit，保留工作树既有未提交改动。

---

## 八、风险与未验证面（诚实登记）

- **host 解析根 vs CLI 加载根**的理论分叉（I1 边界声明）：当前部署形态（desktop/remote 均为 acode.cjs 旁 staged 目录）下同一份；SEA 形态无设置页。若未来部署形态打破该假设，须重新评估协议下发方案——已要求 TODO 注释互相引用。
- **remote workspace 的 bundled 分组来自 desktop 本机内容包**（I1 remote 落地形态）：远端机器的服务装配未注入 `bundledSkillsRoot`，remote 设置页的「内置技能」由 desktop 本机 staged 内容包并入（见 §三 I1）。当前部署形态下 desktop 与远端的 staged 目录随同版本资产部署同源同内容；若未来出现「远端内容包 ≠ desktop 内容包」的部署形态，需把注入下沉到远端装配侧重新评估。
- **UI 组件级行为**（分组渲染、开关隐藏）无组件测试基建，靠纯函数测试（S9）+ typecheck 覆盖，真实渲染效果未验证（无 E2E 环境），实现后如实报告。
- **`useSkills`/Composer 面板回归**：I4 默认 false 保证零行为变化，但仍列入实现后回归检查（`SlashCommandPlugin`、`skillsMentionProvider` 的数据源不受 skillsService.list 影响，静态可证）。
- bundled skill 的 `SkillSummary.body` 会进入 list 返回值（现有行为：全 scope 都带 body）。bundled 正文较大（dynamic-workflows 附 patterns.md/examples.md，但 walk 只取 SKILL.md），列表载荷增量可控；不为本线新增加载模式，若后续需要裁剪属独立优化。
