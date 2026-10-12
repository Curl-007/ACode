# AgentTeams 使用手册

> 插件：`agent-teams@zcode-plugins-official` v0.1.0
> 设计文档：仓库根 `specs/agent-teams.md`；工具语义参考：插件包 `docs/protocol.md`

AgentTeams 把当前会话升级为**队长（captain）**，在 ZCode 的 subagent 基座上组建团队：
成员是可续跑的子代理，任务带依赖（DAG），成员间经邮箱直连，调度由 `next_actions`
指令推进。适合「一个目标能拆成多个可并行/有依赖的任务、需要不同角色协作」的规模。

---

## 1. 启用插件

插件默认不启用（会拉起独立 MCP 进程）。启用一次即可，全局生效：

```bash
# 从仓库的 cli 工作区跑（dev 源码模式；生产安装的 zcode 直接跑 zcode plugins enable agent-teams）
cd apps/zcode-cli
npx tsx packages/cli/src/main.ts plugins list            # 确认列表里有 agent-teams
npx tsx packages/cli/src/main.ts plugins enable agent-teams
```

启用后再次 `plugins list` 应看到：

```text
- agent-teams@zcode-plugins-official [enabled]
  skills: 1, commands: 1, hooks: 0, mcp: plugin:agent-teams:team
```

**验证成员已注册**（headless 一句话即可）：

```bash
npx tsx packages/cli/src/main.ts -p "列出你可用的 subagent 类型名字"
# 清单中应出现 agent-teams:member（以及裸名 member）
```

> dev 源码模式注意：seed 只在 CLI 进程的 cwd 能解析到 `packages/agent-teams-plugin`
> 时生效（从 `apps/zcode-cli` 根目录跑）。若列表里没有 agent-teams，先
> `cd apps/zcode-cli/packages/bootstrap && pnpm build` 重建 bootstrap dist，再回
> `apps/zcode-cli` 根目录跑一次 `plugins list` 触发 seed。

## 2. 一次完整使用（推荐入口）

在目标项目的工作区里打开 ZCode 会话，然后：

```text
/agent-teams:team 把 src/legacy 下的 12 个回调式模块迁移成 async/await，迁移后补单测并交叉评审
```

或者自然语言（skill 触发，效果相同）：

```text
用 AgentTeams 组建团队审查最近两个提交并修复问题
```

之后你会看到会话按固定节奏走：

1. **建队（draft）**：`agent_teams_create` 创建团队，此时成员未 spawn、任务不调度。
2. **组名册**：队长 `agent_teams_add_member` 登记成员（如 implementer、test-writer、
   reviewer），每次登记后队长会用原生 `Agent` 工具后台 spawn 一个
   `agent-teams:member` 子代理，再 `agent_teams_bind_member` 回填 agentId。
3. **拆 DAG**：`agent_teams_create_task` 建任务（目标/验收标准/依赖/指派），review、
   test 这类质量任务会做成下游任务的依赖。
4. **等你批准**：队长呈现名册 + 任务 DAG + 面板 URL，等你明确说「批准/开始」。
   想改就说改哪里（队长在 draft 内原子修订）；想放弃就让它 `agent_teams_delete` 清理。
5. **批准后自动推进**：`agent_teams_approve_plan` 启动调度。之后每次成员完成/回报，
   队长被自动唤醒、按 `next_actions` 派工（你不需要做任何事）。
6. **收尾**：全部任务 done 后队长汇总交付并归档团队。

## 3. 运行中你要看什么

- **团队面板**：建队工具的返回值里有 `panel_url`（如
  `http://127.0.0.1:5xxxx/`），浏览器打开即见进度条、名册（谁在干什么）、任务
  DAG 表、邮箱未读数，2 秒自动刷新。团队归档后 `/history/<teamId>` 仍可读。
- **磁盘状态**：`<workspace>/.agent-teams/`（`team.json` + `tasks/` + `mailbox/` +
  `archives/`）。冷启动续跑、事后审计都以它为准。建议把 `.agent-teams/` 加进
  仓库 `.gitignore`（插件不自动写）。

## 4. 中途干预（直接对话即可）

| 你说                         | 队长会做                                                  |
| ---------------------------- | --------------------------------------------------------- |
| 「先停一下」                 | 停止执行派工指令（状态保持 active，恢复无需操作）         |
| 「t-2 改成只做 X」           | `agent_teams_amend_task` 修订任务                         |
| 「t-3 换人/我自己来」        | `agent_teams_reassign_task(assignee: 成员名或 "captain")` |
| 「加一个测试任务，依赖 t-2」 | `agent_teams_create_task`                                 |
| 「某某成员没用好，移掉」     | `agent_teams_remove_member`（其任务回收为无主）           |
| 「彻底解散」                 | `agent_teams_delete(archive: true)` 归档收尾              |

## 5. 断点续跑

会话中断/进程重启后，状态全在磁盘。回到同一个 workspace 打开会话说「继续 AgentTeams」：
队长 `agent_teams_status` 读到团队仍 active，直接按 `next_actions` 继续派工。
悬空任务（in_progress 长期无更新）status 会标记出来，队长按指令 reassign 或接管。

## 6. 规则速查（队长/成员会自动遵守，供你核对行为）

- 依赖未完成的任务不能被认领（工具层拒绝，`task_not_ready`）。
- 一个成员同时最多持有一个进行中任务；成员间消息直达对方邮箱，不经过队长转述。
- `done` 必须带 `verify`（自验命令与结果）——验收标准非空时强制。
- review/test 失败不解锁下游：队长会创建 repair 任务（依赖被检任务而非失败的评审）。
- 每个任务尝试持有 attempt_id，重派/接管会失效旧 attempt（防陈旧写）。
- 成员不能再派生子代理；队长专属工具对成员返回 `forbidden_for_caller`。
- 同一 workspace 同时只有一个活跃团队。

## 7. 配置项（可选）

`zcode plugins` 的 userConfig（或 `~/.zcode/cli/config.json` 的插件配置）：

| 键                  | 默认                            | 说明                                             |
| ------------------- | ------------------------------- | ------------------------------------------------ |
| `stateDir`          | 空 = `<workspace>/.agent-teams` | 状态根目录覆盖                                   |
| `maxMembers`        | 8                               | 名册上限（队长除外）                             |
| `maxReassignRounds` | 3                               | 同一任务最大重派轮次（1~10，越界夹到边界）       |
| `panelEnabled`      | true                            | 是否起 localhost 面板                            |

## 8. 故障排查

| 症状                                 | 原因与处理                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `plugins list` 里没有 agent-teams    | seed 未触发：从 `apps/zcode-cli` 根目录跑；仍无则重建 bootstrap dist（见 §1 注）      |
| 会话里看不到 14 个工具               | 插件未启用或 MCP 连接失败：`plugins list` 看 `mcp: plugin:agent-teams:team`；重启会话 |
| spawn 成员后没动静                   | 成员未 bind：队长日志里 `agent_teams_bind_member` 是否执行；未 bind 的成员不会被派工  |
| 队长不派工                           | 它没执行 `next_actions.wake` 指令：说「按 status 里的 next_actions 派工」把它拉回协议 |
| 面板打不开                           | 端口重启后变化：读 `.agent-teams/panel.json` 里的当前 URL                             |
| 报 `another_process_holds_team_lock` | 另一个进程在写同一团队：关掉旧会话，或等 5 秒（锁过期自动接管）                       |
| 队长在轮询                           | 它在反复调 `agent_teams_status` 看进度。说「不要轮询，被唤醒后再调 status，派完就停」把它拉回协议 |
| 驳回后成员从零开始                   | 它用了 `reassign_task` 而不是 `send_message`。说「驳回走追加指令，保留原成员上下文」 |
| 报 `reassign_limit_exceeded`         | 同一任务已重派到上限（默认 3）：这是防无限重试的闸门。让队长向你汇报卡点，或调大 `maxReassignRounds` |

## 9. 已知边界（与 dsh 原版的差异）

- 唤醒由队长执行（模型按 `next_actions` 机械调用 SendMessage），不是调度器直连——
  漏执行只延迟派工，不破坏状态一致性。
- 插件设置里的「Inherit captain model for members」默认关闭：成员优先使用「子智能体」
  中 `agent-teams:member` 的单独模型设置，未设置时使用 `general-purpose` 已配置的模型。
  两者都没设时成员启动会报错，**不会悄悄用队长模型**。开关打开后，没有单独设置模型的
  团队成员才继承队长模型。切换设置需新建或重开会话，已在运行的成员不会换模型。
- 队长仍通过 ZCode 原生 `Agent` 工具启动 `agent-teams:member`，不会自动改用你已创建
  的其他子智能体类型；模型选择可以复用，团队 MCP 工具与权限仍来自插件成员 profile。
  如需不同成员使用不同模型，可把插件目录 `agents/member.md` 复制到用户级 agents
  目录并改名、加入 `model`/`thoughtLevel`/`speed` frontmatter，队长手动选择该类型。
- 质量门失败后的 repair 任务由队长手动创建（自动修复环在 M3 规划，见 PRD §21）。
- 面板只读、绑定 localhost，不做鉴权（不含凭据；如需收紧再加 token）。
