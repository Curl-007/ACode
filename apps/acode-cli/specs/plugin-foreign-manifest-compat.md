# Spec：跨厂商插件清单兼容（foreign manifest compat）

## 背景

- 插件生态套利：让 ACode 直接消费按其他 agent 约定打包的插件（Claude Code /
  Codex / Cursor），而不是要求作者为 ACode 重新打包。zoode 对 Codex 的逆向研究
  确认其接受 `.claude-plugin` / `.cursor-plugin` 等外来清单目录约定（机制借鉴，
  非代码复制，见 `docs/capability-uplift-plan.md` 批次 0 C3）。
- **既有不一致（本 spec 要修的核心问题）**：技能发现层
  `apps/acode-cli/packages/adapters/src/skills/index.ts` 自初始提交（85c7bb6，
  ZCode fork 基线）起就接受 `.cursor-plugin/plugin.json`，但插件发现/市场/zip
  安装与桌面 services 各层只认 `.acode-plugin` / `.claude-plugin` /
  `.codex-plugin`。后果：一个按 Cursor 约定打包的插件，其 skills 能被发现，
  插件本体却无法被发现/安装/同步——同一目录约定在不同层判定不一致。

## 行为规则

### R1 统一候选集与稳定优先级

所有「插件清单发现点」必须接受同一候选集，回退优先级固定为：

```
.acode-plugin/plugin.json  >  .claude-plugin/plugin.json  >  .codex-plugin/plugin.json  >  .cursor-plugin/plugin.json
```

- 首个存在的清单生效；同一插件根不叠加多份清单。
- `marketplace.json`（市场目录文件，不是插件清单）**不**新增 cursor 约定：
  保持 根目录 `marketplace.json` 与 `.claude-plugin/marketplace.json` 两个候选
  （无已知的 Cursor marketplace 目录约定，不发明）。
- 市场严格条目缺清单时的合成路径（`ensureMarketplaceEntryManifest`）继续写
  `.claude-plugin/plugin.json`，不改。

### R2 发现点清单（唯一事实源）

新增发现点或新增外来约定时，必须同步更新本清单与两包的守护测试：

| # | 文件 | 符号 | 层 |
|---|---|---|---|
| 1 | `apps/acode-cli/packages/adapters/src/plugins/index.ts` | `CURSOR_MANIFEST_PATH` / `findManifest` | CLI 插件发现 |
| 2 | `apps/acode-cli/packages/adapters/src/plugins/marketplace.ts` | `CURSOR_MANIFEST_PATH` / `findPluginManifestPath` | CLI 市场安装 |
| 3 | `apps/acode-cli/packages/adapters/src/plugins/zip-source.ts` | `hasPluginManifest` | CLI zip 安装根判定 |
| 4 | `apps/acode-cli/packages/adapters/src/skills/index.ts` | `PLUGIN_MANIFEST_RELATIVE_PATHS` | CLI 技能归属插件名反查（已符合，先例） |
| 5 | `packages/services/src/plugin-sync/pluginSyncService.ts` | `PLUGIN_MANIFEST_RELATIVE_PATHS` | 桌面插件同步 |
| 6 | `packages/services/src/commands/commandsService.ts` | `CURSOR_PLUGIN_MANIFEST_PATH` / `findPluginManifestPath` | 桌面插件命令发现 |
| 7 | `packages/services/src/settings-sync/settingsSyncService.ts` | `CURSOR_PLUGIN_MANIFEST_PATH` / `findPluginManifestPath` | 桌面设置同步 |
| 8 | `packages/services/src/skills/skillsService.ts` | `CURSOR_PLUGIN_MANIFEST_PATH` / `findPluginManifestPath` | 桌面技能发现 |
| 9 | `packages/services/src/subagents/subagentsService.ts` | `PLUGIN_MANIFEST_PATHS` | 桌面子代理发现 |

### R3 守护测试（防再分叉）

- CLI 侧：`apps/acode-cli/tests/plugin-foreign-manifest-compat.test.mjs`
- 桌面侧：`packages/services/tests/plugin-foreign-manifest-compat.test.mjs`
- 断言：R2 清单内每个文件都包含 `.cursor-plugin` 候选，且列表型定义中四个约定
  的出现顺序符合 R1 优先级。任一发现点漏掉 cursor（或顺序被改）即测试失败。

## 非目标

- **不做跨 workspace 常量集中**：`apps/acode-cli` 是嵌套 workspace，与外层
  `packages/*` 不共享模块；两个 workspace 内各自保持列表一致，跨包漂移由 R3
  守护测试兜住。若未来出现第三个消费方，再评估把候选集收敛进各自包内的单一
  常量模块。
- 不改变清单**内容** schema（`plugin.json` 字段校验、`UNSUPPORTED_*` 字段集
  不变）；只扩目录约定。
- 不动 marketplace.json 候选（见 R1）。

## 验收

1. 含 `.cursor-plugin/plugin.json` 的插件目录可被 CLI 发现层识别为插件根；
   zip 安装根判定通过；市场 `findPluginManifestPath` 命中。
2. 桌面 services 五个发现点同样识别（命令/技能/子代理/同步）。
3. 既有 `.acode-plugin` / `.claude-plugin` / `.codex-plugin` 优先级不变：
   同时存在多份清单时仍取更高优先级者。
4. 两包守护测试通过；`pnpm typecheck`、`pnpm lint`、
   `pnpm architecture:check --changed` 无新增违规。
