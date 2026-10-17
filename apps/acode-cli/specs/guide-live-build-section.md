# guide 技能「Current Build」实时自知节 + 反陈旧学说（T2-c2）

方案条目：`ACode-价值提取-Claude-2.37337-第二轮.md` T2-c2（外部范式仅作**机制**参照，
全部文本与实现自撰，未拷贝任何对方技能正文）。

本 spec 做三件事：

1. 把「技能被调用时注入由运行中 CLI 生成的 Current Build 快照节」钉成 Skill 工具装配点的
   通用机制（任何技能正文含占位符即启用，guide 技能是首个消费者）；
2. 定义快照的事实面、来源分层、降级语义与会话缓存策略；
3. 定义 guide 技能（zcode-configuration-guide）的反陈旧学说与答案风格纪律，作为 SKILL.md
   重写的验收依据。

裁剪边界：**不做** /skill-doctor 类技能使用与上下文成本报告（本轮登记不做）；**不做**
kill-switch 语义（该外部范式的前提在本机制不适用：占位符缺席即天然关闭，无独立开关）；
**不改** `adapters/src/skills/*`（技能发现/加载面为 W2-SKILL-A 所有权，本机制只消费其
既有 `SkillPort` 输出）；**不改** ToolExecutionContext 端口链（version、内置 slash 命令表、
MCP 连接态、plugin/bundled agents 的宿主接线以接线报告形式登记，见「宿主接线登记」节）。

---

## 背景：已核实的现状

- guide 技能是纯静态文档：`packages/acode-guide-plugin/skills/zcode-configuration-guide/SKILL.md`
  全文手写事实，Skill 工具装配点（`packages/core/src/tool/handlers/skill.ts:58-70`）把
  `loaded.content` 原样包进 `<skill_content>` 返回，没有任何运行时事实注入。
- 静态文档已经漂移（陈旧问题的实证，也是本轮重写的直接依据）：
  - 旧 SKILL.md 声称配置文件在 `~/.zcode/cli/config.json` / `<repo>/.zcode/config.json`；
    本构建实际是 `~/.acode/cli/config.json`（`packages/adapters/src/config/file-config.adapter.ts:58`
    `DEFAULT_BASE_DIR = "~/.acode/cli"`）与 `acode.json` / `.acode/config.json`
    （`packages/adapters/src/config/project-config.adapter.ts:107`），`.agents/mcp.json`
    为项目层最低优先级 fallback（同文件 `:110-116`）。
  - 旧 SKILL.md 声称「恰好七个 hook 事件」且不区分面：本构建 contracts 的运行时事件词表是
    17 个（`packages/contracts/src/hooks/hook-event-names.ts:6-24`），而**配置文件** hooks
    接线面（strict schema）只接受 7 个事件键（`packages/adapters/src/config/schema.ts:271-289`，
    含 `hooks.enabled` 开关）——静态文档不区分「哪个面」正是陈旧答案的温床。
- 快照各事实面的可达性（装配点 = Skill handler，`ToolExecutionContext`
  `packages/core/src/tool/types.ts:133-207`）：
  - 工具清单：`context.providerVisibleToolNames`（`call-runner.ts` 装配时已过滤 providerVisible）。
  - 技能清单：`context.skillPort.discoverSkills`（`packages/contracts/src/skills/index.ts:108-114`）。
  - 自定义 slash 命令 / agents / MCP 配置 / 设置键：磁盘只读扫描可得（命令根
    `~/.acode/commands`、`~/.agents/commands`、`<ws>/.acode/commands`、`<ws>/.agents/commands`，
    与 `packages/adapters/src/commands/roots.ts:10-11` 的目录常量一致；agents 根
    `<storageRoot>/agents`（默认 `~/.acode/cli/agents`）与 `<ws>/.acode/agents`，
    见 `packages/bootstrap/src/subagents.ts:66-70`）。
  - CLI 版本：`__CLI_VERSION__` 只在 cli 包构建期 define（`packages/cli/src/run.ts:48`），
    core 装配点不可达 → 本版降级 + 接线报告。
  - 内置 slash 命令表：注册在 cli 侧 command-center（`packages/cli/src/command-center/slash-commands.ts`），
    core 不可达 → 本版降级 + 接线报告。
  - MCP「已连接」状态与 plugin/bundled agents：运行时态在 runtime/bootstrap 层，
    handler 上下文不可达（分层纪律：runtime 本体不进 deps，`runtime/helpers/runtime-tools.ts`
    注释）→ 快照只报「已配置」，连接态降级 + 接线报告。

---

## 规则

### R1 占位符是唯一 opt-in 面

技能正文含 `{{ACODE_CURRENT_BUILD}}` 占位符时，Skill 工具装配点在返回前把它替换为运行时
生成的 Current Build 节；不含占位符的技能**零成本透传**（不做任何采集）。占位符可出现多次，
全部替换为同一节。注入发生在 frontmatter 剥离与 `${ACODE_SKILL_DIR}` 变量展开之后，
只作用于进入模型上下文的正文。

### R2 快照事实面与来源分层

节内子节固定七个，逐一标注来源层级：

| 子节 | 来源 | 层级 |
|---|---|---|
| Version | 宿主接线（缺省降级） | runtime truth（接线后） |
| Tools | `providerVisibleToolNames` | runtime truth |
| Slash commands（自定义） | 磁盘扫描四个命令根 | best-effort |
| Slash commands（内置） | 宿主接线（缺省降级） | runtime truth（接线后） |
| Skills | `skillPort.discoverSkills` | runtime truth |
| Agents | 磁盘扫描 user/project agents 根 | best-effort |
| MCP servers（已配置） | 解析 user/project 配置文件 | best-effort |
| Settings keys（已配置） | 解析 user/project 配置文件顶层键 | best-effort |

磁盘扫描是对 adapters 发现逻辑的**只读近似**（单一事实源仍在 adapters；本模块不复用其
代码是因为 core 不依赖 adapters 包），节内明示 best-effort 语义。

### R3 降级：标注「本次不可用」，绝不缺失

- 子节级：任一子节采集失败或来源未接线 → 该子节仍在，正文标注
  `unavailable this time` 与原因；其余子节不受影响。
- 节级：采集/渲染整体失败 → 占位符仍被替换为降级节（说明失败原因 + 指引回退
  references 并显式声明训练数据用法），**不得**让 Skill 调用失败，也不得把占位符
  原样漏给模型。
- 秘密纪律：settings 子节只列**键名**；MCP 子节只列**服务器名 + scope + transport 类别**；
  配置文件的任何**值**（可能含 token/env/命令行秘密）一律不进快照。

### R4 会话缓存与版本失效

成功渲染的节按 `sessionId` 缓存（进程内 Map，LRU 上限 16 个会话）：同一会话内占位符
第二次及以后命中缓存，不重复采集；宿主提供 version 时，缓存条目 version 与当前输入
不一致即失效重采；version 缺席时缓存退化为会话级（仍满足「会话内一次性生成」）。
**降级结果不进缓存**（瞬态失败可在会话内自愈重试）。

### R5 guide SKILL.md 反陈旧学说与答案风格纪律

重写后的 `zcode-configuration-guide/SKILL.md` 必须包含：

1. 自述「你对本产品的知识默认陈旧」：产品迭代快于训练数据，静态文档本身也会漂移；
2. 信源优先级：**实时 Current Build 节 > 随包 references（`references/recent-changes.md`
   记录改名/移除的键与命令）> 训练数据**；使用训练数据必须显式声明并附「可能过期」警示；
   实时节与记忆冲突时实时节获胜；实时节标注不可用时如实说明并降级到 references；
3. 答案风格纪律：给出的 JSON 必须可直接粘贴（无注释、无尾逗号、无省略号占位）；
   每个推荐设置必须注明**落点文件与键路径**；不发明键名/命令名——以 Current Build 节
   与 references 为准；
4. 结构性事实（scope 双轨、发现顺序、资源形态）保留为地图，但一切**易变枚举**
   （事件名全集、路径拼写、命令清单）改为指向实时节或 references，不再硬编码。

### R6 recent-changes.md 首版内容

`references/recent-changes.md` 从本轮已核实的变更起记（新→旧）：`.zcode` 路径拼写为
文档陈旧错误（实际 `.acode`）；hook 事件必须区分「配置文件接线面（7 键，strict）」与
「contracts 运行时词表（17 个）」，旧文档的单面「恰好七个」表述作废；
`dynamic-workflows` 技能已单源化到 bundled-skills（acode-guide-plugin 副本已删，
`tests/plugin-registration-description-parity.test.mjs` 钉住防复活）。

---

## 宿主接线登记（本轮不改，接线报告输出）

全保真快照需要宿主经 ToolExecutionContext 提供以下事实（涉及
`tool/types.ts`、`tool/executor/*`、`runtime/helpers/runtime-tools.ts`、bootstrap 链，
均在本任务所有权之外）：

1. `version`：cli 构建期 `__CLI_VERSION__` 透传至 runtime deps → tool context；
2. 内置 slash 命令表：cli command-center 注册表只读投影；
3. MCP 连接态：runtime MCP client 管理器的 name→state 只读投影（「已配置」升级为「已连」）；
4. plugin/bundled agents 清单：bootstrap `loadSubagentProfiles` 结果只读投影。

接线落点建议：`ToolExecutionContext` 增可选 `liveBuildSnapshotPort`，本模块
`LiveBuildInjectionInput` 已预留 `version` 字段，其余字段按同形扩展。

---

## 验收场景

1. **透传**：正文不含占位符 → 返回值与输入逐字相同，且未触发任何采集（skillPort 未被调用）。
2. **全量渲染**：临时家目录/工作区造 config.json（mcp.servers + 顶层键 + 秘密值）、
   `.agents/commands/foo.md`、agents/*.md → 节含服务器名、键名、`/foo`、agent 名、
   工具与技能清单；**秘密值不出现在输出任何位置**。
3. **子节降级**：version 缺席 + skillPort.discoverSkills 抛错 → 两个子节标注
   `unavailable this time`，其余子节正常，节整体存在。
4. **节级降级**：采集整体抛错 → 占位符被替换为降级节（含原因），Skill 调用不失败。
5. **缓存**：同 sessionId 二次调用命中缓存（首采后改盘上配置，二次输出不变）；
   version 变化后重采（输出反映新值）；降级结果不被缓存（失败后重试可成功）。
6. **静态件**：SKILL.md 含占位符与 R5 四要素；`references/recent-changes.md` 存在且含
   R6 三条；frontmatter 仅用安全键（name/description），description ≤ 1024 字符。
