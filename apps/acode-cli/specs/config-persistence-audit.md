# 配置持久化全量覆盖审计（J1-4）

- 状态：审计完成；`settingService` 缺口已修复（前瞻性）；存量固化键的追溯清理待产品决策（见「残留风险」）。
- 日期：2026-09-30
- 审计范围：`packages/services` 的配置读写（用户设置、provider 配置、bots/MCP/plugin/skills 同步落盘）、`packages/desktop` 的配置存储。
- 审计对象模式（jcode 事故，转引自 `docs/jcode-inspired-upgrade-plan.md` J1-4 小节，原始出处 jcode `docs/DISCOVERY_CONVERSION_ANALYSIS.md:30-41`）：
  `Config::save()`「读入全量 → 内存改一处 → 写回全量」把旧默认值（`sponsors.enabled=false`）冻结进 168 个用户配置文件；之后翻转默认值也救不回来——**已落盘的旧默认值和用户显式选择无法区分**。
- 重点判定：写回时「用户从未显式设置过的键」是被保留（不写入/合并写）还是被当时代码里的默认值固化。

---

## 1. 写路径清单与模式判定

| # | 写路径 | 落盘文件 | 判定 | 关键证据 |
|---|--------|----------|------|----------|
| W1 | `packages/services/src/setting/settingService.ts` `update()` → `writeSettings()` | `~/.acode/v2/setting.json` | **命中事故模式（修复前）**，已修复 | 见 §2 |
| W2 | `settingService.get()` 迁移提交 / `prepareLegacyAccountConnections` 迁移写 | 同上 | 全量写（**有意保留**：一次性迁移提交） | `settingService.ts:307,447` |
| W3 | `packages/services/src/settings-sync/settingsSyncService.ts` `addMcpServerToAcodeConfig` / `addPluginDirToConfig` | `~/.acode/cli/config.json`、`<ws>/.acode/config.json` | 通过（raw 透传，无默认值注入） | `settingsSyncService.ts:1107-1125,1138-1153`（`...parsed` 展开原始 JSON） |
| W4 | `packages/services/src/mcp-sync/mcpSyncService.ts` 导入写 | 用户 MCP 配置 | 通过（raw 透传 + 原子写） | `mcpSyncService.ts:620-624`（`writeServerMapToJson(current,…)` 基于 raw `current`） |
| W5 | `packages/services/src/plugin-sync/pluginSyncService.ts` `addPluginDirToUserConfig` | `~/.acode/config.json` | 通过（raw 透传 + `writeJsonFileAtomic`） | `pluginSyncService.ts:905-934,1107-1119` |
| W6 | provider 配置仓库 `packages/provider-node/src/personal-provider-config-repository.ts` + `provider-config-file-codec.ts`（由 `packages/services/src/model-provider/providerProvisioningTarget.ts` 等调用） | personal provider 配置文件 | **通过（良性范式）**：显式 `schemaVersion` + 迁移表 + 文件锁内 CAS + 原子写；encode 对 undefined 键不物化 | `provider-config-file-codec.ts:42-82`（版本迁移）、`:112-124`（encode 省略缺省键）；`personal-provider-config-repository.ts:83-120`（锁内 transform-CAS）、`:194-205`（canonical 化写盘） |
| W7 | `providerProvisioningTarget.ts` provisioning 状态文件 | state 文件 | 通过（`schemaVersion:1` + records 追加，宽容解析） | `providerProvisioningTarget.ts:42-50,326-363` |
| W8 | `packages/services/src/bots/repo.ts` + `botsService.ts` `saveBot`/bind | `bot-config.v3.json` | **观察项（设计使然，判良性）**：`normalizeBotCommandPolicy` 把 `DEFAULT_BOT_COMMANDS` 全键归一后落盘（`bots/config.ts:36-53`、`botsService.ts:5472,4766`），未触碰的策略键会被固化为显式值；但 bot 的 `allowedCommands` 是**权限策略**，显式快照语义 = fail-safe（日后收紧/放宽默认不应静默改变既有 bot 的权限面），且文件带 `version:3` + legacy 一次性导入（`repo.ts:34-48`）。不修。 | 同左 |
| W9 | `packages/services/src/client-config/clientConfigService.ts` | 无落盘 | 通过（纯内存 TTL 缓存，非持久化路径） | `clientConfigService.ts:31,80-96` |
| W10 | `packages/desktop/src/main/browserView/browserTabRecoveryStore.ts` | tab 恢复快照 | 通过（会话状态快照：文件即全量数据所有者，无 schema 默认可冻结；串行 mutation 队列 + temp/rename） | `browserTabRecoveryStore.ts:162-208` |
| W11 | `packages/desktop/src/main/desktopDeviceMid.ts` | `telemetry-state.json` | 通过（raw record 读-改-写，其他键原样保留，无默认注入）；**观察项**：用 sync fs（`:62-68`），与 AGENTS「异步 IO」相悖，属 main 启动早期路径，不在本项动刀 | `desktopDeviceMid.ts:30-49,62-68` |
| W12 | `packages/desktop/src/main/mcpUserDirectory/{index,utils}.ts` | 用户/工作区 MCP 配置 | 通过（raw 读-改-写单键子树 + `writeTextAtomic`；legacy `enable`→`enabled` 就地迁移幂等、无残留不写） | `mcpUserDirectory/index.ts:254-282,296-311`、`utils.ts:37-52` |
| W13 | `packages/services/src/onboarding/onboardingRecordService.ts` | onboarding 记录（独立文件） | 通过（独立 schema 文件，非设置写路径） | `onboardingRecordService.ts:46` |

只读侧（约束修复设计）：直接 raw 读 `setting.json` 的消费者只有 desktop 两个启动引导，均**自带缺键默认**，与「只写显式键」兼容：
- `desktopChromiumHardwareAccelerationBootstrap.ts:13-24`（缺键 → `true`）；
- `desktopDataBaseDirBootstrap.ts:10-22`（缺键 → `null`）。
其余消费者一律经 `settingService.get()` → `appSettingsSchema` 解析，缺键由 schema 默认补齐（W1 修复不改变任何读取结果）。

---

## 2. W1 缺口确认：settingService 全量固化（修复前）

### 2.1 静态证据（修复前代码，git HEAD）

- 默认值来源：`packages/shared/src/validationAppSettings.ts:439-499` —— `appSettingsObjectSchema` 含约 30 个 `.default(...)` 键（`recentProjects`、`locale`、`computerUseComposerEntryHidden`、`taskAutoArchiveOlderThanDays`、`botPermissionLocalApprovalEnabled`、`memoryEnabled`、`skippedElectronUpdateVersions` 等）。
- 写路径：修复前 `settingService.update()` 为 `readSettings()`（schema 全量解析，缺键已物化为默认）→ `appSettingsSchema.parse({...current, ...validatedPatch})` → `writeSettings(merged)` → `JSON.stringify(persisted)` **整份写回**。任何一次单键 update 都会把当时代码里的全部 schema 默认值冻结进用户文件。
- **本仓库已两次被同一模式咬伤的自证**：
  - `validationAppSettings.ts:201-216`（`migrateCloseToTrayOnWindowsDefault`）与 `:218-233`（`migrateMessageStreamShowReasoningDefault`）注释原文：「旧版会把默认 false 和用户手动关闭都保存成同一个值，无法可靠区分」——只能靠一次性迁移标记强行翻转，即 jcode 事故的逐字段补丁版；
  - `validationAppSettings.ts:455-457`（`computerUseComposerEntryHidden`）注释：「default 只对缺省字段生效，显式存过 false 的用户仍保持展示」——在全量物化模式下，任何做过一次 update 的用户都会「显式存过」旧默认值，翻转默认值对存量用户失效。

### 2.2 运行时实证（修复前，本机复现）

命令（临时 HOME，`node --input-type=module --import tsx -e …`，调用真实 `createSettingService()`）：
单键 `update({ locale: "en-US" })` 后读回 `setting.json`：

```
PERSISTED_KEY_COUNT=33
PERSISTED_KEYS=recentProjects,locale,localePreference,…,computerUseComposerEntryHidden,taskAutoArchiveOlderThanDays,…,skippedElectronUpdateVersions
SAMPLE computerUseComposerEntryHidden=true
SAMPLE taskAutoArchiveOlderThanDays=7
```

一次只改 `locale` 的保存把 33 个键（含约 30 个用户从未设置的 schema 默认值）固化落盘。**缺口实锤。**

---

## 3. 修复（已实施）：普通保存只写显式键

### 3.1 产品规则

- R1 普通偏好保存（`update()`）不得把「用户从未显式设置、磁盘上也不存在」的键写入 `setting.json`；这类键保持缺席，读取时随 schema 默认值演进（翻转默认值对新装用户与未固化键即刻生效）。
- R2 磁盘已有键在写回时保留在场，值取合并结果（patch 优先，其余为磁盘值的 schema 规范化）。
- R3 显式清空（`normalizeSettingsPatch` 归一为 `undefined` 的键：`terminalFontFamily`、`httpProxy`、`httpProxyNoProxy`、`httpProxyCaCertPath`、`acodeEndpointOrigin`、`providerFamilyDomain`、`integratedTerminalShell`，见 `normalizeSettingsPatch.ts:16-90`）必须把键从磁盘删除，而不是残留旧值。
- R4 迁移标记键（`closeToTrayOnWindows(+MigrationInitialized)`、`messageStreamShowReasoning(+MigrationInitialized)`）始终随普通保存落盘：`shouldPersistSettingsMigrations`（`settingService.ts:109-118`）以 raw 文件标记判定收敛，缺了会导致 `get()` 每次重复触发迁移写。
- R5 一次性迁移提交路径（`get()` 的 needsMigrationPersist 写、legacy account 迁移写）保持**全量写盘**既有语义：迁移结果有意固化，且这两个路径每文件至多触发一次。
- R6 读取路径完全不变：`get()` 永远返回 schema 补全后的完整 `AppSettings`；raw 直读消费者必须自带缺键默认（现有两个 bootstrap 已满足）。

### 3.2 状态所有者

- `setting.json` 唯一所有者：Host 内 `settingService`（`updateQueue`/`commitQueue` 串行化 + `writeSettings` 唯一写漏斗，`settingService.ts:251-282`）。本修复不新增写入路径。
- 「显式键集合」的事实源：`Object.keys(normalizeSettingsPatch(patch))`（zod parse **之前**取值，保证 R3 的 undefined 值键仍在集合内）→ 经 `writeSettings(…, explicitKeys)` 传入（`settingService.ts:317-321,351-358`）。
- 键过滤纯函数：`buildExplicitKeyPersistedSettings(settings, raw, explicitKeys)` + `MIGRATION_MARKER_KEYS`，位于 `packages/services/src/setting/explicitSettingsPersist.ts`（写回键集合 = `keys(raw磁盘) ∪ explicitKeys ∪ MIGRATION_MARKER_KEYS`，值取 schema 合并产物；不在产物中的键跳过 = 从磁盘删除）。
- `rollbackFields`（legacy 账号连接字段保留）与「旧 Team 未决时删除 `providerFamilyConnectionSelections`」的既有保护逻辑不变（`settingService.ts:212-227`）。

### 3.3 修复后运行时实证

同一命令重跑（修复后）：

```
POST_FIX_PERSISTED_KEY_COUNT=6
POST_FIX_KEYS=locale,localePreference,closeToTrayOnWindows,closeToTrayOnWindowsMigrationInitialized,messageStreamShowReasoning,messageStreamShowReasoningMigrationInitialized
GET_STILL_DEFAULTS computerUse=true archiveDays=7   ← get() 读取侧默认补齐不变
```

### 3.4 验收场景（全部由测试覆盖，见 §5）

- S1 首次安装单键 update：只落显式键 + 迁移标记键；`computerUseComposerEntryHidden` 等默认键缺席；`get()` 仍返回完整默认。
- S2 磁盘已有键保留、未在磁盘未在 patch 的键不被物化。
- S3 清空语义：`update({httpProxy:""})` 后键从磁盘消失。
- S4 官方服务开关随显式 patch 持久化并可跨 `get()` 读回（进程级投影另由 desktop 回归覆盖）。
- S5 一次性迁移提交仍全量写盘，且标记落盘后 `get()` 幂等不再重写（收敛）。

---

## 4. 残留风险与后续决策（不擅动，交人决策）

1. **存量固化键不可追溯区分（产品决策）**：修复是前瞻性的。已经发生过 update 的存量 `setting.json` 里，旧默认值与用户显式选择不可区分（jcode 同款困境）。可选后续：一次性「去物化」迁移——把值恰等于当时 schema 默认的键从磁盘剥离（语义上「显式选了默认值」退化为「跟随默认」，对偏好类键通常正是期望行为；对 `computerUseComposerEntryHidden` 这类已翻转过的默认值，能救回被冻结的存量用户）。需要独立迁移标记与逐键白名单评审，超出本小项，**列入 blockers**。
2. **迁移提交路径的一次性全量物化（观察项）**：R5 保留的两个迁移路径触发时（仅 legacy 文件/标记缺席时各一次）仍会把当时全部默认物化落盘。改为「只写迁移输出键」需要计算 preprocess 迁移前后键差集，回归面大（legacy team OAuth 收敛逻辑同路），不在本项实施。
3. **W3 `settingsSyncService.writeJsonFile` 非原子写（观察项，另一类缺陷）**：`settingsSyncService.ts:1133-1136` 直接 `writeFile`，进程崩溃可产生半截 `~/.acode/cli/config.json`；同库 `pluginSyncService.writeJsonFileAtomic`（`:1107-1119`）与 `mcpUserDirectory/utils.writeTextAtomic` 已有现成范式。非 jcode 默认固化模式，未越界修改。
4. **W11 `desktopDeviceMid` 同步 fs（观察项）**：`writeFileSync/renameSync` 违反异步 IO 约定，但处于 main 启动早期同步链路，改造涉及启动时序，记录不动。

---

## 5. 验证记录（本机实跑，2026-09-30）

| 检查 | 命令 | 结果 |
|------|------|------|
| 新增回归测试（5 场景 S1-S5） | `node --import tsx --test packages/services/tests/settingsExplicitKeyPersistence.test.mjs` | **5/5 通过** |
| 既有 settingService 真实持久化回归 | `node --import tsx --test packages/desktop/tests/official-service-switches.test.mjs` | **5/5 通过** |
| 设置门控相邻回归 | `node --import tsx --test packages/services/tests/botPermissionLocalApproval.test.mjs` | **9/9 通过** |
| 逐包类型检查 | `node node_modules/typescript/bin/tsc -p packages/services/tsconfig.json --noEmit` | **exit 0** |
| Lint（改动文件） | `pnpm exec oxlint packages/services/src/setting/settingService.ts packages/services/src/setting/explicitSettingsPersist.ts packages/services/tests/settingsExplicitKeyPersistence.test.mjs` | **0 error / 0 warning**（`settingService.ts` 有效行数 390→398，max-lines 400 内；新逻辑抽到 `explicitSettingsPersist.ts` 即为守住该约束） |

改动文件：
- `packages/services/src/setting/settingService.ts`（`writeSettings` 增加 `explicitKeys` 可选参数；`update()` 传入归一化 patch 键集合）
- `packages/services/src/setting/explicitSettingsPersist.ts`（新增：键过滤纯函数 + 迁移标记键常量）
- `packages/services/tests/settingsExplicitKeyPersistence.test.mjs`（新增：5 个验收场景）
