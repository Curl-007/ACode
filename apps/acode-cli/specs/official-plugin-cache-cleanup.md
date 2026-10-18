# Spec：官方插件 cache 旧版本残留清理（official plugin cache cleanup）

## 背景

- 官方插件 seed 升级保留旧版本缓存目录（`cache/acode-plugins-official/<name>/<version>/`），
  现无任何清理机制。实机存在 acode-guide/0.2.0（含已废弃的 dynamic-workflows skill 副本）
  与 0.3.0 并存（.agent-teams/reports/t4-cross-verification.md R5/R6）。
- 残留的风险随 M1 统一解析被放大：权威分片损坏回退 readdir 全扫时，字典序先到先得会
  加载旧版本（t3 缺口 7 影响段）；即便 M1 引入 semver 择优，旧版本仍占磁盘并携带
  已删除资产（如 dynamic-workflows 副本）与版本混淆风险。
- 用户裁决（2026-10-17）：设计**保守**清理规则；cache 清理是删除性操作，规则宁可漏删
  不可误删，失败不得阻断启动。

## 产品规则

### R1 清理对象闭集

只清理 `<pluginStorageRoot>/cache/acode-plugins-official/<name>/<version>/` 形态的
目录，且**全部**条件满足才删：

1. `<name>/<version>` **不在权威引用集**（§R2）；
2. 同 `<name>` 存在**被引用且在场完整**的版本目录（`.acode-plugin/plugin.json` 存在，
   与 seed fallback 的 `isSeedUsable` 同判据）——即「同名插件存在被引用的更新版本」；
3. `<version>` 是被引用版本的**更旧**版本：`compareOfficialPluginVersionDirNames(ref, v) > 0`
   （§R4 判据单点）。不可解析的版本名不参与比较，也就**永不删除**；
4. 目录名为纯版本形状（可被 §R4 解析）。`.backup*`、`.tmp-*`、`.seed-lock*` 等事务
   过渡目录归 seed 事务所有，形状上即不满足本条，**双重排除**。

### R2 权威引用集（删除的对偶面）

被引用 = 以下三类之一定位到 `<name>@<version>`：

| # | 来源 | 说明 |
| --- | --- | --- |
| 1 | bundled 分片 `marketplaces/acode-plugins-official/bundled-marketplace.json` 的 `plugins[].cachePath` + `version` | 当前 seed 权威（M1 同一解析单点） |
| 2 | cdn 分片 `cdn-marketplace.json` 条目的 `name`/`version` 对 | CDN 目录已列出的版本；其 cache 目录可能已存在（CDN 安装产物），绝不能当残留删 |
| 3 | `installed_plugins.json` 中 `marketplace === "acode-plugins-official"` 记录的 `name`/`version` | 市场显式安装（含 CDN 安装），只读消费该文件（所有者是 adapters 安装流） |

bundled/cdn 分片解析失败（文件缺失/损坏）→ 该来源贡献空引用集，**不抛错**；
`installed_plugins.json` 解析失败（缺失/损坏）→ **跳过本次清理整体**（该文件是 R3 第一条
「installed 记录永不动」保护的唯一事实源，失效即不删——比贡献空集更保守）。三类全空 →
清理退化为空集（fail-safe：权威不明时绝不删）。

### R3 绝不动清单（负向边界）

- `installed_plugins.json` 记录的任何安装路径（即使版本比 bundled 旧——用户显式安装
  的回滚版本是合法状态）；
- 非官方市场 cache（`cache/<其他市场>/` 整体不进入扫描）；
- 被引用版本目录本身（含 bundled 指向的当前版本与 CDN/installed 记录版本）；
- 被引用版本**不在场或残缺**时的旧版本目录——此时旧版本可能正承担 seed fallback
  （`findUsableOfficialPluginFallback`），删除会摧毁降级退路（对应 §R1 条件 2）；
- bundled **回滚**场景：bundled 引用 0.2.0、磁盘有 0.3.0 → 0.3.0 比 0.2.0 新，
  不满足「更旧」条件（§R1 条件 3），保留；
- 不可解析名目录（§R1 条件 3/4）。

### R4 版本判据单点（与 M1 择优共享）

- shared 新增纯函数（与 specs/plugin-official-cache-authority-m1.md 规则 V3 同一函数）：
  数值三元组、semver.coerce 兼容语义，不给 shared 引入 semver 依赖；
- 消费方三处：本清理线的「更旧」判定、M1 回退分支的 semver 择优、以及表驱动一致性
  测试。adapters `version-compare.ts`（更新状态 UX）保持 semver 不动，其与判据单点的
  一致性由测试钉住（同输入样本下「被引用版本更新」的结论一致）。
- **与 M1 的矛盾消解**（评审锚点）：M1 分片分支不做择优（权威已单点选定），残留目录
  由本线删除；M1 回退分支做组内 semver 择优，即使本线因权威分片损坏而 fail-safe
  空转（§R2），回退分支也不会加载旧版本。两条规则共享同一比较函数，对同一磁盘状态
  永远指向同一版本。

### R5 时机与调用点

- 每次**启动 seed 成功后**执行一次（进程内至多一次）：`seedBundledOfficialPlugins`
  内、`writeOfficialMarketplace` 已执行且 seed 锁循环完成后调用。此时权威分片刚落盘，
  引用集最新；`resolveSeedSource()` 返回 undefined（无 seed 源）时跳过清理——分片
  未被本次刷新，保守不动。
- 实现落位（依赖方向 bootstrap → adapters 合法）：
  - adapters `official-marketplace.ts` 新增只读导出：读取 bundled/cdn 两个分片的
    引用对集合（分片读取归 adapters 所有）；
  - bootstrap `src/app/` 新增 `official-plugin-cache-cleanup.ts`：组装引用集
    （分片引用对 + `listInstalledPluginRecords`（@acode/adapters 既有导出）），
    扫描目录、判定删除集、执行删除（复用 `official-plugin-cache-fs.ts` 的
    `removeOfficialPluginCacheDirectory` 重试预算）。

### R6 幂等与失败安全

- **幂等**：删除集在第二次运行必为空集（无引用旧目录已删）。测试断言二次运行零删除。
- **失败安全**：单目录删除失败（Windows EBUSY/EPERM 杀软占用常见）→ 记 warn 跳过
  该目录，继续其余，绝不向上抛；清理整体 try/catch 包裹，任何异常只告警不阻断启动。
  删除重试用既有 retry 预算（与 seed 同款），预算耗尽按失败跳过处理。

### R7 日志

- 复用 contracts `Logger` 注入（与 `seed_summary` 同一 seam：
  `module: "bootstrap.official_plugin_cache"`），**info 级**一条汇总：
  `operation: "stale_version_cleanup"`、`removed: [{ pluginId, version }]`、
  失败跳过清单。
- `removed` 为空时不打 info（避免每次启动噪音）；有删除动作才 info；删除失败 warn。
- **关于 createServiceLogger 的偏离说明**：AGENTS.md 的 createServiceLogger 约定适用
  packages/services 层；apps/acode-cli 不依赖 services，且本模块既有日志全部走
  Logger 注入 seam。沿用既有 seam，不为此新增跨包依赖。

## 状态所有者

| 状态 | 唯一所有者 |
| --- | --- |
| cache 当前版本目录（seed 事务） | bootstrap seed 链 |
| cache 无引用旧版本目录（删除权） | 本清理器 |
| installed_plugins.json | adapters 安装流（清理器只读） |
| 权威引用集（bundled/cdn 分片读取） | adapters `official-marketplace.ts` |
| 版本比较判据 | shared 纯函数（§R4 单点） |

## 验收场景

1. acode-guide/0.3.0（bundled 引用）在场且完整时，0.2.0 被删除，0.3.0 保留。
2. 0.3.0 目录缺失/残缺（seed degraded）→ 0.2.0 保留（fallback 退路不摧毁）。
3. 预置 installed_plugins.json 记录 acode-guide@0.2.0 → 0.2.0 永不删除。
4. 预置 cdn 分片含 acode-guide@0.2.0 → 不删（引用集含 CDN 条目）。
5. bundled 回滚引用 0.2.0、磁盘有 0.3.0 → 0.3.0 保留（「更旧」条件不满足）。
6. 非官方市场 cache 目录（如 `cache/wasp-nest/...`）零接触。
7. `.backup-*`/`.tmp-*`/`.seed-lock*`/不可解析名目录零接触。
8. 模拟删除失败（目录占用）→ warn 一条、其余目录继续、启动不中断。
9. 幂等：同一存储二次运行为空集、无日志动作。
10. 分片全损坏 → 清理空转（无删除），无异常抛出。
11. `installed_plugins.json` 损坏（非法 JSON）+ bundled 引用 acode-guide@0.3.0 在场完整 +
    磁盘有 0.2.0 → **0.2.0 保留**（installed 事实源失效即整体跳过，必改项 5）。

## 测试

`apps/acode-cli/tests/official-plugin-cache-cleanup.test.mjs`：临时 storageRoot 构造
分片文件 + cache 目录 + installed_plugins.json，场景 1-11 表驱动；版本判据单点测试
（shared 纯函数表）与 M1 择优测试共用同一组样本（防判据漂移）。
