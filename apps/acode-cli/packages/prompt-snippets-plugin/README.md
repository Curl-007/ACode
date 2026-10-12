# prompt-snippets（内置提示词库）

**数据型内置插件**：只提供片段数据，不注册任何模型可见组件。

## 为什么是插件而不是代码内置

- 与 `apps/zcode-cli/packages/` 下的其他内置插件同构，走 `official-plugin-definitions.ts`
  与 `plugin-marketplaces.ts` 两条既有登记位，没有新增机制。
- 内容可独立迭代：改 `snippets/builtin.json` + 升 `version`，不需要发版整个桌面端。
- 用户可以在设置页插件管理里**停用**本插件；停用后片段面板只剩用户自己的片段，
  并在设置页显示一条弱提示（不报错、不阻塞）。这是产品语义，不是技术细节。
- 约 38 条 × 双语 ≈ 30 KB 数据，走 seed 文件不进 UI bundle。

## 为什么 manifest 里没有组件字段

`docs/plugin-development/02-manifest.md` 的字段总表里**没有「片段」这一类组件**。
自造字段未来加校验时会变成 `plugin_unsupported_component` 警告，因此本插件的
`.acode-plugin/plugin.json` 只放 `name` / `version` / `description` / `author` / `license`。

片段数据放在 **约定路径** `snippets/builtin.json`，由 `packages/services/src/snippets/builtinSnippets.ts`
按「插件根 + 固定相对路径」读取。

## 数据格式

```json
{
  "version": 1,
  "entries": [
    {
      "id": "builtin:discipline:no-hands",
      "group": "discipline",
      "kind": "suffix",
      "title": { "zh-CN": "先别动手", "en-US": "Don't start yet" },
      "content": { "zh-CN": "…", "en-US": "…" },
      "requiresMcp": [],
      "localOnly": false
    }
  ]
}
```

- `id` 是稳定身份（形如 `builtin:<group>:<slug>`），**一旦发布不得修改**。
- `group` ∈ `discipline` / `general` / `automation` / `ops` / `framework`。
- `kind` ∈ `prompt` / `suffix`；`group === "discipline"` 时必须是 `suffix`（校验会拒绝）。
- `requiresMcp` 元素是 **MCP server 名**（裸名或 `plugin:<name>:<server>` 命名空间名）。
  按工具名判定不可行：`zcodeMcpServerStatusSnapshotSchema` 只有 `toolCount` 数字，没有工具名列表。
- `localOnly: true` 只在本地工作区出现（远程工作区隐藏）。
- `group === "framework"` 必须声明非空 `frameworks`，取值见
  `packages/shared/src/prompt-snippets.ts` 的白名单。

正文可用 `{{变量}}` 占位符，也可用既有 canonical 载体引用插件，例如
`[@浏览器操作](plugin://browser-use@zcode-plugins-official)`。

## 内容约束

- 数量门槛（验收）：38 条 = `discipline` 8 / `general` 12 / `automation` 6 / `ops` 6 / `framework` 6；
  其中 `requiresMcp` 非空 18 条，`localOnly: true` 2 条。
- 当前实际引用的 MCP server 名：`node_repl`（Browser Use / Computer Use 宿主）、
  `image_search`（搜图）、`team`（AgentTeams）。这些名字来自各插件 `.mcp.json` 的实际键名。
- 不写真实用户数据、凭据、内部服务地址。
