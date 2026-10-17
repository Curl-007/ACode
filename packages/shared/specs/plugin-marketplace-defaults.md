# plugin-marketplace-defaults：预置插件市场种子集

> 产品决定（2026-10-17，用户指令「把插件市场链接上……从源码方面接」；同日追加
> 「把这两个插件市场也做进去」）：第三方市场 The Wasp Nest、ZcodePro、
> zcode-marketplace-zh（中文镜像，三份 dist 清单）以**链接引用**形态预置进
> ACode 源码种子集。

## 产品规则

1. **种子集**：`packages/shared/src/plugin-marketplaces.ts` 的
   `DEFAULT_PLUGIN_MARKETPLACES` 是默认市场唯一事实源，启动/插件面访问时由
   adapters `ensureDefaultPluginMarketplaces` 幂等落库（`known_marketplaces.json`，
   已存在的 id 跳过）。当前六项：
   - `acode-plugins-official`（官方 CDN manifest，canonical id 约束不变）；
   - `wasp-nest`（GitHub 简写源 `legioncodeinc/vibe-coding-tools`，21 插件）；
   - `zcode-plugins`（ZcodePro，GitHub 简写源 `luxi233/ZcodePro`，13 插件）；
   - `claude-plugins-official` / `claude-code-plugins` / `codex-official`
     （zcode-marketplace-zh 中文镜像的三份 dist 清单，raw URL 直指 JSON，
     315 / 13 / 65 插件）。
2. **id 正字性**：种子条目的 `id`/`name` 必须与目标 manifest 的 `name` 一致
   （wasp-nest 的 `.claude-plugin/marketplace.json`、ZcodePro 的根目录
   `marketplace.json` name="zcode-plugins"、zh 镜像 dist JSON 的顶层 name）——
   不一致会让注册表出现同来源双条目（seed 一条、update/add 再解析一条）。
3. **源形态判定**：种子解析器只把 `owner/repo` 简写归为 github 源（clone 仓库找
   manifest，探测路径含仓库根 `marketplace.json` 与 `.claude-plugin/marketplace.json`
   两处）；完整 URL 归为 url 源（要求直指 manifest JSON）。因此仓库型市场必须写
   简写（写仓库页 URL 会拉取失败），zh 镜像必须写 `dist/*.json` 的 raw URL
   （写仓库页同理失败；jsDelivr 备用地址不预置，用户可自行添加）。字段形态由
   单测钉住。
4. **统一开关门控**：种子表全部是远程市场来源，一律受 marketplace 官方服务开关
   （`ACODE_ENABLE_OFFICIAL_MARKETPLACE` / 设置页「官方服务」）约束——审计构建默认
   断连时不 seed 任何远程市场。本地内置插件与用户个人来源不在种子表，不受影响。
5. **link-only 纪律（按仓库许可分级）**：预置只写**市场来源链接与 manifest 事实
   字段**（id/名称/数量），插件获取与安装始终由用户显式动作触发（marketplace
   注册本身不下载插件正文、不执行任何插件代码）。
   - wasp-nest：AGPL-3.0-or-later（Copyright 2026 Mario Aldayuz；其内第三方快照
     另循各自许可）——绝不复制其任何插件内容、文案或代码进本仓库，避免 copyleft
     传染；
   - zcode-marketplace-zh：仓库**无 LICENSE**（默认保留所有权利）——纪律更紧：
     `description` 一律本仓库自撰，不摘录其文案；`name`/`pluginCount` 是 manifest
     事实字段，照录；
   - ZcodePro：MIT（Copyright 2025 zcode-plugin contributors）——同样只链不拷，
     description 自撰以免与 ACode 官方市场混淆（其 manifest 自称 "Official
     ZCode"，与 ACode 无关）。
6. **git 锚定门现实（fail-closed，不代为绕过）**：插件级仓库源在物化前过
   commit 锚定与 host 白名单判定（`apps/acode-cli/specs/plugin-git-source-pinning.md`）。
   对本次预置的影响按清单实测（2026-10-17）：
   - zcode-plugins：插件是市场仓库内相对目录源，随市场 clone 本地物化，不过
     锚定门——列表与安装全通；
   - claude-plugins-official（zh 镜像）：上游 anthropics/claude-plugins-official
     自带 commit sha 锚定（dist 内 262 处），镜像保留——可安装；
   - claude-code-plugins / codex-official（zh 镜像）：插件源全部为 git-subdir
     浮动 ref（`ref:"main"`，无 sha、无 `allowFloatingRef`）——列表可浏览，安装被
     策略门拒绝，错误消息面向清单作者给出修复方式。**不**为其加 sha、**不**代为
     声明 `allowFloatingRef`、**不**放宽策略门；上游补锚后自然恢复。
7. **pluginCount 是快照事实**：zh 镜像每日自动同步，其 README 表格滞后于 dist
   实测（如 claude-plugins-official README 写 294、实测 315）；种子只记预置当日
   实测值，展示层以刷新后的 manifest 为准。
8. **商店分段不变**：`PUBLIC_STORE_MARKETPLACE_IDS`（商店「公开」分段=ACode 官方
   身份）不收录第三方市场；第三方条目只在插件管理「市场」列表呈现。
9. **description 语言与刷新现实**：种子条目 description 一律**自撰中文**（产品
   主语言，2026-10-17 用户指令「要做中文翻译」；无 LICENSE / AGPL 仓库连短语也
   不摘录）。已知边界（同日实测 adapters 行为）：刷新（`updateMarketplace` →
   `addMarketplace`）用上游 manifest 的 description **重建**注册记录——zh 镜像
   三条目上游即中文，刷新后不漂移；zcode-plugins / wasp-nest 上游是英文，首刷后
   回落英文。市场级 `description_i18n` 目前不被 ACode 消费（插件级已消费；官方
   CDN manifest 市场级自带 zh-CN 同样被丢弃），「市场级描述按 locale 解析」登记
   为后续项，不在本 spec 范围内实现。官方条目 description 不动：官方市场走独立
   合并层（manifest 必须 name=acode-plugins-official），展示语言由官方 CDN
   manifest 事实所有。

## 状态所有者

| 事实                     | 所有者                                                               |
| ------------------------ | -------------------------------------------------------------------- |
| 种子集定义与开关过滤     | `packages/shared/src/plugin-marketplaces.ts`（单一事实源）           |
| 注册表落库/幂等/源解析   | adapters `plugins/marketplace.ts`（ensureDefaultPluginMarketplaces） |
| 插件源锚定与 host 白名单 | adapters `plugins/git-source-pinning.ts`（策略门单一事实源）         |
| 开关状态                 | `officialPlatformPolicy.ts` 模块态（env/Desktop 投影写入）           |

## 验收场景

1. shared 单测钉住：wasp-nest / zcode-plugins / zh 镜像三条目字段（canonical id、
   源形态、数量）；开关关→resolve 为空；开关开→官方+四组第三方共六项按序；
   官方条目原样。
2. 已有注册表幂等：本地经 CLI `plugins marketplace add` 注册过同 id 后，seed 跳过
   不产生双条目（ensureDefaultPluginMarketplaces 既有行为，回归由 adapters 层保障）。
3. 种子路径隔离验证（temp storageRoot 走 ensureDefaultPluginMarketplaces 全链）：
   六条目全部落库、github 简写解析为 `{source:"github",repo}`、raw URL 解析为
   `{source:"url",url}`。
4. shared 单测钉住：五个第三方条目 description 均为自撰中文（含 CJK；防回退英文
   或误摘上游文案）。
