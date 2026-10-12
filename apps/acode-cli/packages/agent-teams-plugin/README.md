# @acode/agent-teams-plugin

AgentTeams 多智能体协作插件：把当前会话升级为**队长**，在 ZCode 的 subagent 基座上补
一层团队协议——共享任务 DAG、成员邮箱、成员间直连与只读团队面板。

- **协议入口**：`/agent-teams:team <goal>`（命令）或自然语言（skill）。
- **协调工具**：14 个 `agent_teams_*` 工具（`plugin:agent-teams:team` stdio MCP server）。
- **成员**：`agent-teams:member` subagent profile（mcpServers 作用域，禁再派生）；模型默认取已配置的插件成员模型、其次 `general-purpose` 子智能体模型，均未配置则拒绝隐式继承。插件设置可显式开启队长模型继承。
- **状态**：`<workspace>/.agent-teams/` 磁盘真相（team.json + tasks/ + mailbox/ + archives/）。
- **面板**：localhost 只读看板（工具返回 `panel_url`）。

## 开发

```bash
pnpm build        # tsc 声明 + esbuild 单文件 dist/mcp/server.js
pnpm typecheck
pnpm lint
pnpm test         # node --import tsx --test tests/*.test.ts
```

冒烟（裸 JSON-RPC，同 example-plugin hello-server 法）：

```bash
node dist/mcp/server.js
# tools/list → tools/call（无 _meta 时传 caller: {name, role} 降级）
```

设计文档：仓库根 `specs/agent-teams.md`（PRD，含与 dsh-agent-teams 的差异对照）。
工具语义参考：`docs/protocol.md`。
**使用手册：`docs/usage.md`（启用、入口、面板、干预、续跑、故障排查）。**
