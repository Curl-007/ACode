# plugin-marketplace-defaults：预置插件市场种子集

> 产品决定（2026-10-17，用户指令「把插件市场链接上……从源码方面接」）：
> 第三方市场 The Wasp Nest 以**链接引用**形态预置进 ACode 源码种子集。

## 产品规则

1. **种子集**：`packages/shared/src/plugin-marketplaces.ts` 的
   `DEFAULT_PLUGIN_MARKETPLACES` 是默认市场唯一事实源，启动/插件面访问时由
   adapters `ensureDefaultPluginMarketplaces` 幂等落库（`known_marketplaces.json`，
   已存在的 id 跳过）。当前两项：
   - `acode-plugins-official`（官方 CDN manifest，canonical id 约束不变）；
   - `wasp-nest`（第三方，GitHub 简写源 `legioncodeinc/vibe-coding-tools`，21 插件；
     种子解析器只把 owner/repo 简写归为 github 源，完整 URL 会被误当直指 JSON 的
     url 源而拉取失败——字段形态由单测钉住）。
2. **id 正字性**：种子条目的 `id`/`name` 必须与目标 manifest 的 `name` 一致
   （wasp-nest 的 `.claude-plugin/marketplace.json` name="wasp-nest"）——不一致会让
   注册表出现同来源双条目（seed 一条、update/add 再解析一条）。
3. **统一开关门控**：种子表全部是远程市场来源，一律受 marketplace 官方服务开关
   （`ACODE_ENABLE_OFFICIAL_MARKETPLACE` / 设置页「官方服务」）约束——审计构建默认
   断连时不 seed 任何远程市场。本地内置插件与用户个人来源不在种子表，不受影响。
4. **AGPL link-only 纪律**：wasp-nest 仓库为 AGPL-3.0-or-later（Copyright 2026
   Mario Aldayuz；其内第三方快照另循各自许可）。ACode 只预置**市场来源链接与
   manifest 事实字段**（id/名称/描述/数量），**绝不复制其任何插件内容、文案或代码
   进本仓库**——避免 copyleft 传染。插件获取与安装始终由用户显式动作触发
   （marketplace 注册本身不下载插件正文、不执行任何插件代码）。
5. **商店分段不变**：`PUBLIC_STORE_MARKETPLACE_IDS`（商店「公开」分段=ACode 官方
   身份）不收录第三方市场；wasp-nest 只在插件管理「市场」列表呈现。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 种子集定义与开关过滤 | `packages/shared/src/plugin-marketplaces.ts`（单一事实源） |
| 注册表落库/幂等/源解析 | adapters `plugins/marketplace.ts`（ensureDefaultPluginMarketplaces） |
| 开关状态 | `officialPlatformPolicy.ts` 模块态（env/Desktop 投影写入） |

## 验收场景

1. shared 单测钉住：wasp-nest 条目字段（canonical id/GitHub 源/数量）；开关关→
   resolve 为空；开关开→官方+wasp-nest 两项按序；官方条目原样。
2. 已有注册表幂等：本地经 CLI `plugins marketplace add` 注册过同 id 后，seed 跳过
   不产生双条目（ensureDefaultPluginMarketplaces 既有行为，回归由 adapters 层保障）。
