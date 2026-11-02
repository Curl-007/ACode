# @acode/agent-teams-plugin

AgentTeams 多智能体协作插件：把当前会话升级为**队长**，在 ACode 的 subagent 基座上补
一层团队协议——共享任务 DAG、成员邮箱、成员间直连与只读团队面板。同一工作区可并行
多个团队（上限可配，默认 4），孤儿团队可被新会话接管。

- **协议入口**：`/agent-teams:team <goal>`（命令）或自然语言（skill）。
- **协调工具**：21 个 `agent_teams_*` 工具（`plugin:agent-teams:team` stdio MCP server）；团队级工具带可选 `teamId` 寻址。成员汇报落 `in_review`（待验收，非终态），验收（合并 / `agent_teams_accept_task`）才落 `done`。成员事件（邮箱/终态/汇报）由宿主经面板快照 `wakePending` 投影自动唤醒队长；队长主动等用 `agent_teams_wait_for_members`。
- **成员**：`agent-teams:member` subagent profile（mcpServers 作用域，禁再派生）；模型默认取已配置的插件成员模型、其次 `general-purpose` 子智能体模型，均未配置则拒绝隐式继承。插件设置可显式开启队长模型继承。
- **状态**：`<workspace>/.agent-teams/teams/<teamId>/` 磁盘真相（team.json + tasks/ + mailbox/；根级 archives/ 与 panel.json；旧平铺布局启动时自动迁移）。
- **面板**：localhost 只读看板（工具返回 `panel_url`；多团队时首页为团队列表，单团队直达 `/team/<teamId>/`）。

## 开发

```bash
pnpm build        # tsc 声明 + esbuild 单文件 dist/mcp/server.js
pnpm typecheck
pnpm lint
pnpm test         # node --import tsx --test tests/*.test.ts
```

端到端冒烟（真实 stdio 拉起 dist/mcp/server.js，用 @modelcontextprotocol/client 驱动；
无 _meta 时传 `caller: {name, role}` 降级身份——本仓验证用，不是生产 stdin 协议）：

```bash
pnpm smoke              # 主链路 + 多团队 + 接管 + 面板（需先 pnpm build）
pnpm smoke:acceptance   # 验收闭环：真实隔离 worktree + 真实 git 提交 + 真实 run_checks
                        # （临时目录自清理，幂等；需先 pnpm build）
```

设计文档：本仓 `apps/acode-cli/specs/agent-teams-derived-config.md`（合入与派生配置链
spec）与 `apps/acode-cli/specs/agent-teams-port-0.4.0.md`（0.4.0 移植规格）。
工具语义参考：`docs/protocol.md`。
**使用手册：`docs/usage.md`（启用、入口、面板、干预、续跑、故障排查）。**
