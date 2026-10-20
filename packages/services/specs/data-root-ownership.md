# 桌面数据根归属文件与初始化器四态判定

状态：已实施（2026-10-20，对照上游 ZCodium `417c961`（PR #19）`docs/specs/zcodium-data-root.md`
的裁剪版；上游完整链含决策窗口/诊断根重定向/再次导入，本仓只落地归属文件 + 四态非交互判定）。
实现：`packages/services/src/data-root/{types,ownership,initializer}.ts`。
守护测试：`packages/services/test/dataRootOwnership.test.ts`、`packages/services/test/dataRootInitializer.test.ts`。

## 背景与目标

数据根 = `{base}/.acode`（`base` 默认 homedir，跟随 setting.json `dataBaseDir` 与
`ACODE_DATA_BASE_DIR`）。历史上「目录存在」被当作可复用的依据，无法区分本产品数据、
他产品残留和损坏现场。本机制以归属文件作为数据根合法性的**唯一依据**，满足：

1. **归属识别**：`.acode` 是否属于 ACode，凭归属文件判定，不凭目录存在；
2. **升级安全**：存量 ACode 用户（归属文件机制之前就有 `v2/` 数据）零改动接管，绝不备份让路；
3. **冲突不互踩**：他产品数据或损坏现场整体备份让路，不删除、不合并、可手动恢复；
4. **零污染**：备份让路与归属落盘发生在消费方 `setDataBaseDir` 之前，判定前正式根零写入。

## 归属文件契约

- 路径：`{dataRoot}/.acode-root.json`。放数据根目录而非 `v2/`：清除所有数据只删 `v2`，
  归属保留，避免清数据后被误判为首次运行。
- 内容：

```json
{
  "product": "acode",
  "schemaVersion": 1,
  "createdBy": "desktop",
  "createdAt": "2026-10-20T00:00:00.000Z",
  "migrations": [
    { "at": "2026-10-20T00:00:00.000Z", "kind": "user-migration", "from": "/old/base", "to": "/new/base" },
    { "at": "2026-10-20T00:00:00.000Z", "kind": "conflict-backup", "backupPath": "/base/.acode.backup-2026-10-20T00-00-00.000Z" }
  ],
  "adoptedFrom": "v2/setting.json"
}
```

- 字段规则：
  - `product`：固定 `"acode"`；不匹配 → corrupt（product-mismatch）；
  - `schemaVersion`：当前 `1`；读到更高版本 → corrupt（schema-unsupported，禁止降级读取）；
  - `createdBy`：`desktop | cli | server | adoption`（adoption 仅由 unowned-adopt 分支写入）；
  - `migrations`：追加式记录。`kind=user-migration`（用户在设置页迁移数据目录，
    `from`/`to` 为 base 绝对路径，仅诊断用）；`kind=conflict-backup`（初始化器备份让路，
    `backupPath` 为让路落点，供手动恢复）；
  - `adoptedFrom`：接管时命中的 ACode 数据特征标记（`v2/setting.json` 或 `v2/`）；
  - 不写入用户名、机器名等敏感信息（迁移记录中的绝对路径除外，属用户自选目录）。
- 写入纪律：`data-root/ownership.ts` 是**唯一**直接读写归属文件的位置；采用
  「同目录临时文件 + rename」原子写，失败不留半截 JSON。

## 四态判定（初始化器，唯一所有者）

`initializeDataRoot({ baseDir?, createdBy })`（同步，启动早期例外，见「IO 形态」）：

| 状态 | 条件 | 处置 | 返回 |
| --- | --- | --- | --- |
| `normal` | 归属文件存在、可解析、product=acode、schemaVersion 支持 | 放行，零写入 | `ready` |
| `absent` | 数据根目录不存在，或存在但为空目录 | 创建（POSIX 0700）+ 写归属文件 | `initialized` |
| `unowned-adopt` | 无归属文件，但目录含 ACode 数据特征（`v2/setting.json` 或 `v2/` 子目录） | **接管**：补写归属文件（`createdBy:"adoption"`、`adoptedFrom:marker`），数据零改动 | `adopted` |
| `unowned-foreign` | 无归属文件、无 ACode 特征的非空目录 | 备份让路 + 全新初始化 | `initialized` + `backupPath` |
| `corrupt` | 归属文件不可解析 / product≠acode / schemaVersion 过新 | 同 unowned-foreign | `initialized` + `backupPath` |

- **adopt 裁决理由（ACode 特有，上游没有）**：ACode 存量用户的 `.acode/v2` 早于归属文件
  机制存在，若按上游 unowned 一律备份让路，老用户升级会「丢」全部数据到备份目录并被迫
  重新引导。特征判定（`v2/setting.json` 或 `v2/`）足以区分 ACode 存量数据与他产品残留；
  接管只新增归属文件一个文件，不移动、不复制、不改权限。
- **备份让路纪律**：整体 `rename` 为 `{dataRoot}.backup-<ISO时间戳>`（ISO 冒号替换为
  `-`，Windows 文件名安全）；重名时追加序号；不删除、不合并、不读取内容；warn 日志一次；
  新归属文件 `migrations` 记录 `backupPath`。
- **权限纪律**：POSIX 上新建数据根目录 0700（数据根含凭据类文件，仅当前用户可访问；
  mkdir mode 受 umask 削减，需显式 chmod 兜底）。Windows 无 POSIX 权限位，mkdir/chmod 的
  mode 参数被忽略，访问控制由 NTFS ACL（父目录继承）管理——代码中以平台守卫注释说明。
  adopt 分支不改既有目录权限（数据零改动）。

## 消费点

1. **桌面启动早期**（`packages/desktop/src/main/desktopDataBaseDirBootstrap.ts`）：
   `applyEarlyDataBaseDirBootstrap` 解析 `dataBaseDir`（缺省 `getDataBaseDir()`，即
   `ACODE_DATA_BASE_DIR` 或 HOME）→ `initializeDataRoot` → 再 `setDataBaseDir`。
   备份让路发生在 `setDataBaseDir` 之前，正式根判定前零写入。初始化器异常不阻断启动
   （console.error 记录，下次启动重试判定）；早期阶段不用 main/logger（其落盘路径依赖
   尚未确定的数据根）。
2. **用户决策迁移**（`settingService.updateDataBaseDir`）：`copyDataDirectory` 成功后
   `recordUserMigrationInDataRoot` 在目标根归属文件追加 `kind:"user-migration"` 记录；
   目标根尚无合法归属时直接补写完整归属文件。登记为 best-effort：失败在 data-root
   scope 记 warn、不向调用方抛出——数据已复制完成，归属缺失时下次启动仍会被 adopt
   判定接管，不应让登记失败反过来让迁移失败。
3. **迁移权限补强**（`paths.copyDataDirectory`）：复制后 POSIX 上遍历源树，目标条目
   mode 与源不一致时 chmod 回源值（凭据类 0600 不被放宽；`fs.cp` 通常已保留 mode，
   此为保障性兜底，mode 一致时零 syscall 开销）；Windows 不适用（无 POSIX 权限位）。
   跳过 `setting.json*`（bootstrap 状态不迁移）与符号链接，与 cp filter 一致。

## IO 形态

初始化/判定/让路使用**同步 fs**：消费点是 desktop main 模块加载期（app ready 之前），
必须同步完成才能保证后续任何模块解析到的数据根都已判定——与既有
`desktopDataBaseDirBootstrap` 的 `readFileSync` 同属「启动早期例外」（AGENTS 异步 IO
原则的既定豁免）。运行期路径（settingService 迁移记录追加）使用异步 fs。

## 裁剪登记（上游有、本波不做）

| 上游能力 | 裁决 |
| --- | --- |
| 独立决策窗口（renderer html/preload/DataRootDecisionApp 全链） | 不做：ACode 四态全部可非交互处置（adopt/备份让路），无需用户决策 |
| pending 态 + 诊断根路径重定向（`setDataRootPathOverride`、tmp 诊断根） | 不做：无 pending 态；判定同步完成后才 `setDataBaseDir` |
| 旧根候选发现与复制迁移（`migration.ts`、`.zcode`→`.zcodium`） | 不做：ACode 无新旧命名空间迁移需求；用户迁移由 `updateDataBaseDir` 承担 |
| 设置页「再次导入」入口 | 不做：`DataBaseDirControl` 已有迁移入口 |
| `ZCODIUM_DATA_ROOT_ACTION` 类 env 非交互策略 | 不做：唯一策略即四态判定本身 |
| 根目录锁（`O_EXCL` 并发保护） | 不做：桌面单进程消费；server-cli 已有独立 `DataRootLock` |
| CLI / server 侧接入 | 本波不接：server-cli 已有 `installationOwnership`（安装目录归属，独立机制、不共用文件）；CLI 接入为后续项 |

## 与现有机制的关系

- `acode-server-cli/src/runtime/installationOwnership.ts`：server **安装目录**归属 +
  DataRootLock，命名/结构风格与本模块对齐，但对象不同（安装目录 vs 用户数据根），
  互不共用文件。
- `paths.getACodeDataRootDir` 与 `data-root/types.ACODE_DATA_ROOT_DIR_NAME` 共用同一
  常量，禁止其它模块自行拼 `.acode` 字面量作为数据根。

## 验收场景

1. 全新机器（无 `.acode`）→ 创建 0700 目录 + 归属文件 `createdBy:"desktop"`，返回 initialized。
2. 空 `.acode` 目录 → 同场景 1（absent 含空目录）。
3. 存量用户升级（`.acode/v2/setting.json` 存在、无归属文件）→ adopted；`v2` 数据
   内容与 mtime 零改动；归属文件 `createdBy:"adoption"`、`adoptedFrom:"v2/setting.json"`。
4. 已有合法根二次启动 → ready，归属文件字节不变。
5. 他产品残留（非空、无归属、无 `v2`）→ 原目录整体改名 `.acode.backup-<ts>`（内容保留、
   名字无冒号），新根归属 `migrations[0]` 含 `kind:"conflict-backup"` 与 `backupPath`。
6. 归属文件损坏（不可解析 JSON / product≠acode / schemaVersion 过新）→ 同场景 5。
7. 用户迁移数据目录 → 目标根归属文件追加 `kind:"user-migration"` 记录（含 from/to）；
   目标根原无归属时补写完整归属文件。
8. POSIX 迁移后凭据文件 0600 不被放宽；Windows 跳过权限补强不报错。
9. 归属文件原子写：无 `.tmp` 残留。
10. E2E/dev 隔离 base（`ACODE_DATA_BASE_DIR`）→ 判定与初始化发生在隔离 base 内。
