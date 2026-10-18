# Spec：官方插件市场清单别名容忍（official marketplace alias）

## 背景

- 官方市场 canonical id 为 `acode-plugins-official`（`packages/shared/src/plugin-marketplaces.ts`
  `ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID`），官方 CDN 目录
  `https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json` 返回的顶层 `name`
  却是历史别名 `zcode-plugins-official`。
- `apps/acode-cli/packages/adapters/src/plugins/marketplace.ts` `addMarketplace` 的
  trustedId 守卫（现行 374-381 行）要求「刷新目标为官方 id 时 manifest name 必须等于
  canonical id」，否则抛
  `Official marketplace source must provide acode-plugins-official, received zcode-plugins-official`。
- 后果（.agent-teams/reports/t3-plugin-management.md 缺口 1）：官方市场远程刷新持续失败，
  `known_marketplaces.json` 的 `lastRefreshFailure` 常驻，CDN 新增/更新插件无法进入
  `availablePlugins`；本地 builtin seed 兜底所以运行时功能不中断。
- 用户裁决（2026-10-17）：官方源接受已知别名 `zcode-plugins-official` 并映射回 canonical id；
  其他市场校验一律不放宽。

## 产品规则

### R1 容忍范围（闭集）

别名容忍当且仅当同时满足：

1. 本次刷新是官方市场的**受信任内部刷新**：`addMarketplace({ trustedId })` 的
   `trustedId === ACODE_OFFICIAL_PLUGIN_MARKETPLACE`（受信任内部刷新链：trustedId===
   official 的全部调用方，实测为懒加载 `ensureMarketplaceManifestAvailable`（marketplace.ts
   `:334`）与 `updateMarketplace`（`:529`）两处，均传 known record 自身的 id；命中按
   trustedId 值判定，故两处天然同语义）；
2. manifest 顶层 `name` 命中已知别名表（唯一成员 `zcode-plugins-official`）。

命中时在 `loadMarketplaceFromSource` 返回之后、三道守卫（reserved / expectedId / trustedId）
之前把 `loaded.manifest` 改写为 canonical：

- `manifest.name` → `acode-plugins-official`；
- `manifest.raw` 浅拷贝后同步替换 `raw.name`（`writeCdnOfficialMarketplacePartitionSync`
  的 `assertOfficialManifest` 读的是 raw）；
- 不修改源对象（`raw` 换新对象，避免污染 fetch 结果）。

改写后全部既有守卫按 canonical 语义照常执行；后续 record.id/record.name、CDN 分片写入、
merged `marketplace.json` 重建均为 canonical id，不产生双条目。

### R2 不放宽清单（负向边界）

以下路径**全部维持现状**，别名不生效：

| 路径 | 现行守卫 | 不放宽理由 |
| --- | --- | --- |
| 用户侧新增市场（`trustedId` 缺失） | reserved 守卫（364 行）+ `expectedId` 校验 | reserved 守卫防官方 id 冒用，是安全边界；别名只属于受信任刷新链 |
| 配置声明同步（`expectedId` 路径，bootstrap/plugins.ts:547-556） | `Marketplace declaration id mismatch` | 同上；官方 record 缺席时的补种必须走用户显式动作 |
| 非官方市场刷新（`trustedId` ≠ official） | trustedId 守卫不适用，name 校验照旧 | 「其他市场校验一律不放宽」 |
| 未知 name（官方刷新但 name 既非 canonical 也非别名） | trustedId 守卫照抛 | 别名表是闭集；CDN 再改名按故障处理 |
| `parseMarketplaceManifest` 的 name 格式校验（`MARKETPLACE_NAME_PATTERN`） | 不变 | 别名本身合法通过，无需放宽格式 |

### R3 别名表归属（位置论证）

别名表落在 `packages/shared/src/plugin-marketplaces.ts`，与 `ACODE_OFFICIAL_PLUGIN_MARKETPLACE_ID`
同文件：

- **它是市场身份数据，不是实现细节**：与 `DEFAULT_PLUGIN_MARKETPLACES` 的 source/id 事实
  同层。放 `marketplace.ts` 本地常量会把产品身份埋进实现文件，shared 侧单测与 CLI 诊断
  无法引用，且第三处出现该事实（文档/测试）时无从对照。
- **依赖方向合法**：adapters 已 import `@acode/shared`（marketplace.ts 头部
  `resolveDefaultPluginMarketplaces`），bootstrap 与 contracts 均不反向依赖 shared。
- **不放 contracts**：contracts 只放运行时判定（`isOfficialMarketplaceId`），别名是
  数据事实；且 shared 已承载全部市场 id 常量，单一事实源。

导出面：

```ts
/** 官方 CDN 目录的历史顶层 name；仅官方受信任刷新链接受（specs/plugin-official-marketplace-alias.md R1）。 */
export const ACODE_OFFICIAL_PLUGIN_MARKETPLACE_MANIFEST_ALIASES: readonly string[] = [
  "zcode-plugins-official",
];
export function resolveOfficialMarketplaceAliasCanonicalId(name: string): string | undefined;
```

### R4 lastRefreshFailure 自愈（不留脏状态）

- 写入方：`updateMarketplace` 刷新失败时 `persistMarketplaceRefreshFailure` 落
  `lastRefreshFailure`（marketplace.ts 1896-1906）。
- 清除方：刷新**成功**时 `upsertKnownMarketplace` 用解构显式剥离上一条记录的
  `lastRefreshFailure`（marketplace.ts 1852-1861），成功记录不含该字段。
- 因此本修复上线后**无需任何人工清理或迁移**：下一次官方市场刷新（商店页 Catalog
  Auto-Refresh / Manual Refresh / 启动声明同步）成功即覆盖记录，`lastRefreshFailure`
  自然消失。现存失败字段在修复前继续如实展示故障，不属于脏状态。
- 本地 `marketplaces/acode-plugins-official/` 的 bundled 分片与 merged manifest 的
  name 本来就是 canonical，不受影响。

## 状态所有者

| 状态 | 所有者 |
| --- | --- |
| 别名表（数据事实） | `packages/shared/src/plugin-marketplaces.ts`（唯一） |
| known_marketplaces.json（含 lastRefreshFailure 生命周期） | adapters `marketplace.ts`（唯一读写） |
| 官方市场分片（bundled/cdn/merged） | adapters `official-marketplace.ts` |

## 接口

- shared 导出 R3 的别名表与解析函数；adapters `addMarketplace` 是唯一消费方。
- 协议面无新增：`plugins/marketplaceUpdate` 等既有命令的成功/失败语义不变，仅官方刷新
  从持续失败恢复为成功。

## 验收场景

1. **别名接受**：trustedId=official，来源 manifest name=`zcode-plugins-official` →
   刷新成功；known record id/name=`acode-plugins-official`；CDN 分片与 merged
   marketplace 落盘；`lastRefreshFailure` 从记录中消失。
2. **非官方市场仍拒绝**：trustedId=`wasp-nest`，manifest name 与 record id 不一致 →
   仍报既有错误；别名 name 出现在非官方刷新 → 不归一、按原名走守卫。
3. **未知 name 仍拒绝**：trustedId=official，manifest name=`some-other-market` →
   仍抛 `Official marketplace source must provide ...`。
4. **用户侧新增不放宽**：`trustedId` 缺失 + manifest name=别名或官方 id → reserved /
   mismatch 守卫行为与现状逐字节一致。
5. **幂等自愈**：连续两次成功刷新之间无失败写入时，known_marketplaces.json 不产生
   diff；人为预置 `lastRefreshFailure` 后一次成功刷新即清除。

## 测试

`apps/acode-cli/tests/plugin-official-marketplace-alias.test.mjs`（临时 storageRoot +
本地目录/文件 source，沿用既有 marketplace 测试的加载方式；不依赖真实 CDN）：

- 场景 1-5 逐条断言；
- 附断言：shared 别名表与 contracts `ACODE_OFFICIAL_PLUGIN_MARKETPLACE` 的映射关系
  （每个别名解析出的 canonical 必须等于官方 id，防别名表写错目标）。
