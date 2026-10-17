# 技能 frontmatter 治理（键全集扩展批①：工具规则 · 激活期作用域 · paths 触发 · 双向门）

需求源：价值提取第二轮 T1-c4「技能/代理声明式 frontmatter 全 schema」的**技能侧**条目
（代理侧 isolation/observer/mcpServers 等属后续批次，不在本 spec）。只搬机制不搬内容：
外部技能正文、描述文案、内部遥测事件名一律不进 ACode；占位符沿用 ACode 既有的
`${ACODE_SKILL_DIR}` 与兼容位 `${CLAUDE_SKILL_DIR}`（`core/src/tool/handlers/skill.ts`
正文展开已收两者），本批新增 `${SKILL_DIR}` 拼写归一到同一目录值。

还原工程证据（只读复核）：技能/命令 frontmatter schema（zod `.describe()` 自文档）
`beautified-claude-code/chunk-9h4eq2mz.js:21800-21920`；frontmatter 解析助手
`chunk-z9xtzw2s.js:383-640`（YAML 解析防御、列表归一 `wRt`、布尔词集、shell 闭集）；
规则串解析 `chunk-v4cg890f.js:107-137`（`jue`/`Un`/`Sn`/`Ku`：`Tool(content)` 调用形、
转义括号、逗号/空格分裂尊重括号深度）；加载期占位符替换与 fail-closed 丢弃
`chunk-9h4eq2mz.js:142955-143010`（无技能目录 → 含占位符的 allow 条目**丢弃+warn**，
不留未解析字面量）；paths 条件技能机制 `chunk-9h4eq2mz.js:143680-143700,143950-144010`
（声明 paths 的技能不进清单，Read/Edit/Write 触碰匹配文件才激活并入清单）；双向门消费
`chunk-9h4eq2mz.js:151795-151810`（`disable-model-invocation` 拒绝模型调用并附
「reserved for explicit user invocation」文案）与 `:143040`（`user-invocable:false` →
`isHidden`，slash 面隐藏）；when_to_use 拼进清单描述 `:83226`
（`${description} - ${whenToUse}`）；实参级规则实例 `SKILL-9eb4e8d2.md:5-20`
（`Bash(node ${…}/scripts/ct.mjs status)`、`Read(/${…}/**)`、`Edit(dir/runs/*/proposed/*.md)`、
`Skill(plugin:skill *)`、`Agent(plugin:agent)`、`mcp__server__tool`）、
`SKILL-2427898d.md:1-30`（`user-invocable:false` + `context:fork` + allow/deny 叠用）。

## 背景：已核实的现状（基线 5cf6db6）

| 事实 | 位置 |
| --- | --- |
| `SAFE_FRONTMATTER_KEYS` 仅 name/description/when_to_use/license/metadata 五键；未知键**忽略且无 warn**，唯一后果是 `safeToAutoLoad=false` | `adapters/src/skills/index.ts:22-28,218-219,232` |
| `safeToAutoLoad` 消费面仅 CLI `acode skills inspect` 展示（human+json），不参与加载决策 | `cli/src/skills-command.ts:160,228` |
| `parseFlatYaml` 只收平铺 `key: value` 与块标量（`>`/`|`）；**缩进行整行丢弃**——YAML 列表项（`- item`）现状解析不到 | `adapters/src/skills/index.ts:300-341`（312 行 `/^\s/` continue） |
| `when_to_use` 已解析进 `SkillMetadata.whenToUse`，且已按 `${description} - ${whenToUse}` 拼进模型可见技能清单（250 字符截断）——与参考「成为工具描述一部分」语义一致（ACode 的“工具描述”即 available-skills 清单段） | `adapters/src/skills/index.ts:225`、`core/src/context/sections/skills.ts:60-69`、CLI 清单同构拼接 `cli/src/command-center/handlers/skill.ts:49-51` |
| Skill 工具调用面：`loadSkill` 直载，**无任何门判定**；正文 `${ACODE_SKILL_DIR\|CLAUDE_SKILL_DIR}` 在 handler 展开 | `core/src/tool/handlers/skill.ts:18-76` |
| 用户 slash 面：`/skill <name> [task]` → `buildManualSkillPrompt`（指示模型调 Skill 工具）；`/skill` 无参 → 列表；两面最终收敛同一 Skill 工具与 adapter 发现链，**工具层无法区分「用户敲的」与「模型自选的」** | `cli/src/command-center/slash-commands.ts:223-265`、`cli/src/command-center/handlers/skill.ts`、`bootstrap/src/skills.ts:28-71` |
| 权限规则形状 `PermissionRuleValue {toolName, ruleContent?}` 与参考同构；`matchesRuleContent`：`:*` 后缀=前缀匹配、含 `*`=通配正则、否则全等；subject 取 input 的 command/url/file_path/path/pattern/patch_text 键——**Skill/Agent 的输入键（skill/args/subagent 名）不在 subject 提取表** | `contracts/src/interfaces/permission.port.ts:25-28`、`core/src/permission/service.ts:674-704` |
| 「技能已加载」判据已存在且刻意取自 provider 可见历史（不另立会话级 Set）：成功=有对应非错误 tool 结果 | `core/src/agent/loaded-skills.ts` |
| MCP 工具命名 `mcp__<server>__<tool>` / `mcp__plugin_<plugin>_<server>__<tool>` 与参考一致 | `core/src/tool/executor/result-display.ts:238-239` |
| SKILL.md 100KB 上限（发现/加载两处同值），超限截断加载 | `adapters/src/skills/index.ts:29`、`core/src/tool/handlers/skill.ts:16` |
| `!` 块执行面在自定义命令链（inline `` !`cmd` `` + fenced ```! 块）经 executionPort，变量面已含 ACODE/CLAUDE_SKILL_DIR；**无 shell 选择键**，与 `specs/powershell-tool.md`（W2-PS）交叉 | `bootstrap/src/custom-command-shell-expansion.ts` |
| 架构 ratchet：`adapters/src/skills/index.ts` 483 行 legacy 超限**只减不增**；新文件 ≤400 行 | `.architecture-baseline.json` |

## 裁决总览

| 项 | 裁决 | 理由 |
| --- | --- | --- |
| allowed-tools / disallowed-tools 实参级规则解析 | **做**（adapter 解析期，产物挂 `SkillMetadata.governance`） | 规则形状与 ACode `PermissionRuleValue` 同构，解析即接通 |
| 激活期作用域（登记模块 + 查询接口） | **做**（core 纯函数 + per-session store）；权限面消费**接线**（W2-P1 独占 `core/src/permission/*`，本批不进） | 「文件激活期间生效、失活即清」是最小权限的直接细化；消费点属权限独占面 |
| 解析失败 fail-closed | **做**（allow 侧丢弃、deny 侧降级工具级，均 warn 诊断；技能本体照常可加载） | 宁紧勿松：解析失败永不放宽 |
| paths 声明解析 + 触发判定纯函数 | **做**（声明解析在 adapter、glob 触发判定在 core）；文件触碰事件源消费**接线** | 消费点跨 Read/Edit/Write/ApplyPatch 执行链与清单重建，超出本批所有权 |
| disable-model-invocation（仅用户可敲） | 解析**做** + 模型清单过滤**做**；Skill 调用面硬门**接线**（需「用户本回合敲的」信号，工具层现状不可得） | 清单过滤已使模型不可发现；硬门需 CLI→runtime→ToolContext 插管 |
| user-invocable: false（仅模型可调） | 解析**做**；用户清单过滤**接线**（cli/bootstrap/TUI 完成面不在本批所有权） | 消费点全在所有权外 |
| when_to_use 语义 | **确认已实现**（清单拼接与参考同构），无代码改动 | 调查项收口 |
| shell: bash\|powershell | 解析**做**（闭集+warn 回落 bash）；`!` 块执行面 shell 选择**登记**（W2-PS 交叉） | 本批不实现执行面 |
| argument-hint / arguments / effort | 解析**做**，消费**登记**（ACode 无对应消费面：slash 占位提示、$name 替换、技能级 effort 均缺席） | 先收口解析，消费面出现即接 |
| hooks / context / agent / background / model | **登记不解析**（进 SAFE 键集避免误标 unknown；语义实现属后续批次） | T1-c4 代理侧与技能执行面另批 |
| 未知键策略 | **保持现状**（忽略、无 warn、`safeToAutoLoad=false` 保守），SAFE 键集扩为文档化键全集 | 现状即参考的 `declaredFields` 宽松哲学；不惊扰第三方技能 |
| 100KB 上限 | **登记不改**（外部存在 ~103KB 官方技能，互通时被截断加载；上限调整涉及 token 预算，另批裁决） | 互通注意项 |

## 产品规则

### R1 frontmatter 键全集（本批文档化闭集）

治理键（本批解析，产物进 `SkillMetadata.governance`，类型在 contracts 新叶子
`skills/frontmatter.ts`）：

| 键 | 形态 | 缺省 | 本批消费面 |
| --- | --- | --- | --- |
| `allowed-tools` | 逗号/空格分隔串或 YAML 列表；条目=实参级规则（R2） | 无 | 激活期作用域登记（消费接线） |
| `disallowed-tools`（别名 `disallowedTools`） | 同上 | 无 | 同上（deny 侧） |
| `paths` | glob 列表（R5） | 无=不启用路径触发 | 触发判定纯函数（消费接线） |
| `disable-model-invocation` | 布尔词（R6） | false | 模型清单过滤（已接） |
| `user-invocable` | 布尔词（R6） | true | 解析+登记（用户面接线） |
| `shell` | 闭集 `bash`\|`powershell`，大小写不敏感 | bash | 解析+登记（W2-PS 交叉） |
| `argument-hint` | 字符串 | 无 | 登记 |
| `arguments` | 数组或空白分隔串（过滤纯数字项） | 无 | 登记（argumentNames） |
| `effort` | 闭集 `low\|medium\|high\|xhigh\|max`（别名 `med`→medium）或任意整数 | 无 | 登记（ACode 技能面无 effort 概念） |

登记键（进 SAFE 键集、不解析、语义留待后续批次）：`hooks`、`context`（inline|fork）、
`agent`、`background`、`model`、`version`、`fallback`、`compatibility`、`tags`、`title`、
`author`、`homepage`、`repository`、`keywords`、`displayName`、`created_by`、`improved_by`、
`experimental`。插件组件键（`mcpServers`/`agents`/`themes`/`workflows` 等 manifest 面）
**不进** SAFE 键集——SKILL.md 里出现仍按未知键保守处理。

既有键不变：`name`/`description`（必填与长度校验现状）、`when_to_use`（R9）、
`license`/`metadata`（SAFE 集既有）。

### R2 实参级工具规则语法（自撰解析器，语义对齐参考）

条目文法（与参考 `jue`/`Un` 同构，`adapters/src/skills/frontmatter-governance.ts`）：

- **裸工具名**：`Read`、`mcp__server__tool`——不含未转义括号 → `{toolName}` 工具级规则。
  工具名过既有别名归一（如参考 Task→Agent 族；ACode 侧直接透传，权限面按工具名匹配）。
- **调用形** `Tool(content)`：首个未转义 `(`（反斜杠转义计数）之后必须跟串尾的未转义
  `)`，且工具名段不含括号；`content` 为空或 `*` → 工具级规则；否则 `content` 内
  `\(` `\)` 反转义后作 `ruleContent`（**verbatim 透传**——Bash 命令前缀、Read/Edit 路径
  glob、`Skill(名 *)`、`Agent(名)`、`mcp__` 前缀全按原文进规则，匹配语义由权限面决定，
  见 R4 接线注记）。
- **畸形**（括号不配对/未闭合/工具名段含括号）→ R3 fail-closed。
- **列表归一**：值为字符串时按逗号/空格分裂，**尊重括号与引号深度**（括号内的逗号/空格
  不分裂——`Skill(plugin:skill *)` 的空格、`Bash(cmd a, b)` 的逗号都是内容）；值为 YAML
  块列表时逐项收；`[a, b]` 流式列表去括号后同逗号分裂。`*` 单独成项 → 保留
  `{toolName:"*"}` 原样登记（全工具通配的匹配语义属权限面，接线注记）。
- **占位符替换**（解析期完成，产物即终值）：`${ACODE_SKILL_DIR}`、`${CLAUDE_SKILL_DIR}`
  （既有兼容位）、`${SKILL_DIR}`（新收拼写）→ 技能目录（`dirname(SKILL.md)`，分隔符
  正斜杠归一）。替换后仍含 `${…}` → 视为不可解析占位符，走 R3。

### R3 fail-closed 纪律（解析失败永不放宽）

- **allow 侧**（allowed-tools）：畸形条目、不可解析占位符条目 → **丢弃该条目** +
  `skill_tool_rule_dropped` warning 诊断（携技能名与条目原文截断）。丢弃=不授予，
  方向天然 fail-closed；技能本体照常加载（与参考 unloadableGuard「加载但无授权」一致）。
- **deny 侧**（disallowed-tools）：畸形条目**不得静默丢弃**（丢 deny=放宽）。降级序：
  1. 能提取工具名 token（首个未转义 `(` 前、或首个空白前的 `[A-Za-z_][A-Za-z0-9_]*` /
     `mcp__` 形）→ 降级为**工具级 deny**（整个工具在激活期禁）+ warning 诊断；
  2. 提取不出 → 丢弃 + warning 诊断（`skill_tool_rule_dropped`，message 注明 deny 条目
     不可解析已忽略）。
  与参考的偏差（参考对 deny 畸形条目同样惰性化）**刻意从严**：deny 表达作者的安全意图，
  宁过度禁止一个工具，不静默放行作者想禁的操作。
- **整键不可用**（值既非字符串也非列表，如嵌套对象）→ 该键整体不生效 + 同款 warning。
- 诊断码新增两枚（contracts 闭集扩展）：`skill_tool_rule_dropped`（R3 条目级）、
  `skill_frontmatter_value_invalid`（shell/effort/布尔词/paths 值非法）。均 severity
  warning，不阻断加载。

### R4 激活期作用域（生效期=技能文件在 provider 可见历史中处于已加载态）

- **激活判据单一来源**：复用 `core/src/agent/loaded-skills.ts` 的历史判据（成功的
  `Skill` 调用+非错误结果=已加载），新增 `collectLoadedSkillNames(entries)` 一次遍历
  收集全部已加载技能名（按首次加载序去重）；`sessionHasLoadedSkill` 语义不变。
  **不另立第二套激活状态事实源**——compaction 把 Skill 调用挤出历史、resume/rewind
  重建历史，作用域随之自然重算（与该文件头注的哲学一致）。
- **构建**（纯函数 `buildSkillActivationScope`，`core/src/agent/skill-activation-scope.ts`）：
  已加载名 → 技能目录（按 name/qualifiedName 解析，同 `loadSkill` 的 find 语义）→
  `governance.allowedTools/disallowedTools` 并集 → `{allow, deny}`（`PermissionRuleValue[]`，
  按 toolName+ruleContent 去重）。无 governance 的技能贡献空集。
- **登记模块 + 查询接口**（同文件 `createSkillActivationScopeStore()`）：per-sessionId
  的 Map 缓存，`refresh(sessionId, scope)` / `clear(sessionId)` / `snapshot(sessionId)`
  （返回只读 `{allow, deny, skills}`，未登记会话返回空 scope）。store 是**缓存不是事实
  源**：写路径只应有「历史变化后重算 refresh」一条（回合边界 / Skill 调用成功后 /
  compaction / resume），避免多条写入路径。
- **权限面消费=接线项**（`core/src/permission/*` W2-P1 独占，本批不进）：建议
  ① `PermissionContext` 增可选 `skillActivationRules`（或经 store 注入 sessionId 查询）；
  ② deny 并入 session 级 deny 同位次；allow 并入 session 级 allow 位次、**仍受策略地板/
  硬阻断/plan 结构性压制**（技能自声明授权永不穿透 policy floor——与参考
  allowManagedPermissionRulesOnly 压制 frontmatter 授权同构）；
  ③ 匹配语义注记：现状 `matchesRuleContent` 为 `:*` 前缀/`*` 通配/全等，Bash 实参级
  规则（参考为命令前缀+子命令切分）与 `Skill(名 *)`/`Agent(名)` 的 subject 提取
  （`ruleSubjects` 未收 skill/args/subagent 输入键）、`mcp__server` 服务器级前缀覆盖、
  `toolName:"*"` 全工具通配、Windows 路径分隔符归一（rule 侧已正斜杠化，subject 侧
  `file_path` 未归一）——全部属权限面裁决，本批解析产物 verbatim 可用。
- **失活即清**：技能从历史消失（compaction）→ 下次重算自然出局；会话终结 →
  `clear(sessionId)`。参考中 disallowed-tools「用户下一条消息即清」的每回合语义**不收**
  ——ACode 判据锚历史存在性（正文还在上下文里，约束就还在），语义更一致且无第二计时器。

### R5 paths：路径触发式渐进披露（声明解析 + 触发判定纯函数）

- **声明解析**（adapter，进 `governance.pathTriggers`）：列表归一同 R2（逗号分裂尊重
  `{}` 深度）；`{a,b}` 花括号展开（预算：结果 ≤512 项且累计 ≤64KB，超限不展开原样
  保留 + `skill_frontmatter_value_invalid` warning）；各项剥尾部 `/**`；空项丢弃；
  结果为空或全为 `**` → 视为未声明（`pathTriggers` 缺席，不做无意义的全命中触发）。
- **触发判定**（纯函数 `matchesSkillPathTrigger`，`core/src/agent/skill-path-triggers.ts`）：
  输入 `{patterns, touchedPath, workingDirectory}`；touchedPath 先相对化（对 cwd），
  绝对路径逃逸或 `..` 上跳 → 不触发（fail-closed：宁可不动作）；glob 语义：`**` 跨
  `/`、`*` 不跨 `/`、`?` 单字符、`{a,b}` 择一（与声明侧展开冗余兼容）、其余字面；
  目录形（尾 `/`）匹配其下全部。分隔符两侧归一为正斜杠再匹配（Windows 兼容）。
- **消费点=接线项**（文件触碰事件源，调查结论）：ACode 的文件触碰汇聚点有二——
  ① Read/Edit/Write/ApplyPatch handler 的 `readFileState` 记录路径
  （`core/src/tool/read-file-state.ts`，executor 注入）；② executor 的工具结果后置链
  （`tool/executor/call-runner.ts`）。参考实现即在 Read/Edit/Write 三工具执行入口调
  触发检查（remoteCall 排除）。建议接线：executor 后置钩子取本次 input 的
  file_path/path 绝对路径 → 对条件技能集（`governance.pathTriggers` 非空且未激活）跑
  `matchesSkillPathTrigger` → 命中则把技能并入本会话可见清单（skills 段重建 +
  system-reminder 通知模型新技能可用），激活集与 R4 store 同生命周期。
  **未接线前的行为**：声明 paths 的技能照常进清单（与现状一致，不回归）；本批只保证
  解析产物与判定函数就位、被测试锁定。

### R6 双向门（disable-model-invocation × user-invocable）

- 布尔词解析（参考同构）：`true/yes/on/1` → true，`false/no/off/0` → false（大小写
  不敏感、trim）；原生布尔直接收；其他值 → `skill_frontmatter_value_invalid` warning +
  按缺省（disable-model-invocation=false、user-invocable=true）。
- `governance` 只在**偏离缺省**时落字段（`disableModelInvocation:true` /
  `userInvocable:false`），消费端判 undefined=缺省，metadata 保持瘦身。
- **disable-model-invocation=true（仅用户可敲）**：
  - 已实施：模型可见技能清单（`core/src/context/sections/skills.ts`，主/子代理共享
    descriptor）过滤掉该技能——模型不可发现即不会自选；用户 `/skill <name>` 手动 prompt
    指名调用仍通（handler 直载，不经清单）。
  - 接线：Skill 工具硬门。参考在调用面拒绝并附「reserved for explicit user invocation」
    文案（含 `userTypedThisTurn` 信号）。ACode 工具层拿不到「用户本回合敲的」信号——
    需 CLI `buildManualSkillPrompt` 路径落回合级标记（如 ToolContext 可选
    `userInvokedSkillName`），handler 对 `disableModelInvocation && 标记不匹配` 拒绝
    （业务失败+指位文案）。落点 `cli/src/command-center/*` + `core/src/tool/types.ts` +
    skill handler，均在本批所有权外或并行批冲突面（skill.ts 正被 W2-GUIDE 修改），
    **登记接线**。
- **user-invocable=false（仅模型可调）**：解析+登记完成。消费点=用户可见面隐藏：
  `/skill` 列表（`cli/src/command-center/handlers/skill.ts`）、`acode skills list|inspect`
  （`cli/src/skills-command.ts` + `bootstrap/src/skills.ts`）、TUI slash 完成
  （`cli/src/tui-command-data.ts` listSkillsForTui）——全在本批所有权外，**登记接线**
  （过滤条件：`governance?.userInvocable === false`；inspect 建议保留但标注 hidden，
  与参考 isHidden 语义一致）。
- 两标志正交可叠加；同时 true/false 组合=两面都不可发现（仅剩显式路径加载），合法不
  warn（参考同构：hidden 技能被 `Skill(...)` 规则显式引用是既有用法）。

### R7 shell 键（与 W2-PS PowerShell 工具交叉，本批只落解析）

闭集 `bash|powershell`（trim+小写）；空值→缺席；非法值→
`skill_frontmatter_value_invalid` warning + 缺席（缺省 bash，跨平台一致——参考
「Defaults to bash regardless of platform」同构）。产物
`governance.shell?: "bash"|"powershell"`。
**交叉登记**：`!` 块执行面（`bootstrap/src/custom-command-shell-expansion.ts` 经
executionPort）现状无 shell 选择；`specs/powershell-tool.md`（W2-PS）落地独立
PowerShell 工具后，`!` 块按本键选 shell（缺席=bash）为接线项，两 spec 互认不改对方
裁决。技能正文的 `!` 块是否进技能面（现状仅自定义命令链支持）同属该接线。

### R8 argument-hint / arguments / effort（解析+登记，无消费面）

- `argument-hint`：字符串透传 `governance.argumentHint`（参考语义=slash 名后的占位提示；
  ACode 用户面现状无占位提示位，接线落点 `/skill` 列表与 TUI 完成，登记）。
- `arguments`：数组或空白分隔串 → 过滤空白项与纯数字项 → `governance.argumentNames`
  （参考语义=模板内 `$name` 具名替换的形参表；ACode 技能正文替换面只有
  `$ARGUMENTS`/`$n` 在自定义命令链，技能链无——登记）。
- `effort`：闭集+`med` 别名+整数（`Number.isInteger` 即收，参考同构）→
  `governance.effort`；非法值 warning + 缺席。**ACode 技能面无 effort/思考预算概念**
  （core 无对应字段，模型选项在 provider 层），仅登记；将来若接，语义=该技能激活回合
  的思考档，与 `model-option-map` 的会话档位正交。

### R9 when_to_use（确认已实现，语义钉住）

现状即参考语义：解析进 `SkillMetadata.whenToUse`，模型可见清单按
`${description} - ${whenToUse}` 拼接（250 字符截断预算内），CLI 用户列表同构拼接。
ACode 的「工具描述」=available-skills 清单段（Skill 工具本体描述是静态的，技能级
描述全在清单段），故「成为工具描述一部分」已由清单拼接满足。本批无代码改动；
`when_to_use` 继续留在 SAFE 键集。

### R10 未知键策略与 SAFE_FRONTMATTER_KEYS 扩展

- 未知键策略**保持现状**：忽略、无 warn、`safeToAutoLoad=false`（保守标记）。第三方
  技能带扩展字段不惊扰（`index.ts:218-219` 既有裁决继续有效）。
- `SAFE_FRONTMATTER_KEYS` 扩为 R1 两个表的并集（治理键+登记键+既有五键）：文档化键
  不再把技能标成 unsafe；插件组件键与真正未知键仍保守。键集定义迁至
  `adapters/src/skills/frontmatter-governance.ts`（`index.ts` 只减不增的 ratchet 约束，
  见 R11 行数纪律）。
- 列表值收集：`parseFlatYaml` 维持现状（缩进行丢弃），治理键的 YAML 块列表由
  governance 解析器**对 frontmatter 原文自行扫描**（`key:` 行后连续的 `^\s*-\s*` 行），
  不动 `index.ts` 的既有解析函数——两处扫描判据（顶层 `key:` 识别）在 governance 文件
  内自持，块标量键（`>`/`|`）不参与列表收集。

### R11 行数与边界纪律

- `adapters/src/skills/index.ts` legacy ratchet（483 行只减不增）：本批对该文件净变更
  ≤0 行（SAFE 键集外迁 -7/+1 导入、parseSkill 内 governance 接线 ≤+3）。
- 新文件全部 ≤400 行；解析器零新增依赖（不引 yaml 包进 adapters——adapters 现无该
  依赖，core 的 yaml 不跨包借用；自撰扫描器语义对齐参考的防御子集：frontmatter 解析
  失败已有 `skill_invalid_frontmatter` 诊断面，本批不重复建 YAML 防御）。
- frontmatter 体积防御登记：参考对 untrusted 源有 64KB frontmatter 上限+嵌套/锚拒绝；
  ACode 现状整体 100KB 文件上限已覆盖最坏面（frontmatter 撑不满即文件超限截断），
  独立 frontmatter 上限**登记不做**。

## 验收场景（测试锁定，`tests/skill-frontmatter-governance.test.mjs` 等三支）

1. **实参级规则解析**：`Bash(node ${ACODE_SKILL_DIR}/scripts/x.mjs status)` →
   `{toolName:"Bash", ruleContent:"node <目录正斜杠>/scripts/x.mjs status"}`；
   `Read(/${CLAUDE_SKILL_DIR}/**)`、`Edit(.runs/*/proposed/*.md)`、`Skill(plugin:skill *)`
   （括号内空格不分裂）、`Agent(plugin:agent)`、`mcp__s__t` 裸名、`Bash(a, b)` 逗号入
   content、`Bash(x:y)` 空 content→工具级、`\(` 转义、`*` 项、CSV 串与 YAML 块列表
   两形态同产物。
2. **fail-closed**：allow 畸形条目丢弃+warning 诊断、技能仍可加载；deny 畸形条目降级
   工具级 deny+warning；不可解析占位符 allow 丢弃 / deny 降级；整键非串非列表 → 键整体
   不生效+warning。
3. **激活期作用域**：历史含成功 Skill 调用 → collect 命中、scope 含该技能 allow/deny；
   tool 结果 isError → 不算加载；compaction 移出历史 → 重算后出局；store refresh/
   snapshot/clear 行为；多技能并集去重。
4. **paths**：声明归一（剥尾 `/**`、花括号展开、预算超限不展开+warning、全 `**` →
   缺席）；触发判定（相对命中/绝对逃逸不触发/`..` 不触发/`**` 跨段/`*` 不跨段/目录形/
   Windows 反斜杠归一）。
5. **双向门**：`disable-model-invocation: true` → governance 落 true 且模型清单段过滤；
   词形 `yes/on/1` 同判；非法值 warning+缺省；`user-invocable: false` → governance 落
   false、模型清单**不**过滤（仅模型可调）。
6. **其余键**：shell 闭集+非法回落、argument-hint 透传、arguments 过滤纯数字、effort
   闭集/别名/整数/非法 warning；when_to_use 拼接现状回归（清单段 `description - whenToUse`）。
7. **未知键策略**：未知键仍 `safeToAutoLoad=false`；R1 文档化键全声明的技能
   `safeToAutoLoad=true`；插件组件键（如 `mcpServers`）仍 false。

## 边界与登记

- **接线清单**（所有权外/并行批冲突，逐项含建议落点）：
  1. 权限面消费激活期规则（W2-P1）：R4 注记①-③。
  2. paths 触发源接线：R5 executor 后置钩子 + 清单重建 + system-reminder。
  3. disable-model-invocation 硬门：R6 用户回合标记插管（CLI→ToolContext→handler）。
  4. user-invocable:false 用户面隐藏：R6 cli/bootstrap/TUI 三处列表过滤。
  5. contracts barrel：新叶子 `skills/frontmatter.ts` 经 `skills/index.ts` 一行再导出，
     根 barrel `export * from "./skills/index.js"` 既有行自动携带——**根 barrel 无需
     改动**；若治理侧要求根 barrel 显式行，属禁触面，另行裁决。
  6. `!` 块 shell 选择（W2-PS 交叉）：R7。
  7. argument-hint 用户面占位提示、arguments 具名替换、effort 消费面：R8。
- **登记项**：hooks/context/agent/background/model 键语义（后续批次）；独立
  frontmatter 体积上限（R11）；100KB 文件上限与外部大技能（~103KB 官方技能被截断）
  互通注意（本批不改值，改值需连带 token 预算评估）；`toolName:"*"` 全工具通配与
  `mcp__server` 服务器级覆盖的权限面语义（R4③）。
- **未尽事项**：Skill 调用面遥测/日志在门拒绝时的词表（依赖硬门接线）；条件技能激活
  后的 system-reminder 文案（依赖触发源接线）；subagent 技能面（`runtime/methods/
  subagent.ts` 的 qualifiedName 解析链）与 governance 的交互验证——governance 随
  metadata 透传应自动可得，留待 W2-SKILL-B 批次联合验证。

## 接线落点记录（2026-10-15，波 2 接线波 WI2-A）

R4/R5/R6/R7 的消费接线全部落地，形态与裁决如下（代码注释同点位互指）：

### ① 权限消费（R4）

- **快照桥**：`agent/skill-activation-scope.ts` 增进程级共享 store（唯一登记点）；
  写路径收敛在 `refreshSessionSkillActivationScope`（重算语义），触发点二处——
  回合边界（`runtime/methods/turn.ts` executeTurnCommand 顶部，compaction/resume/
  rewind 的历史变化随之自然收敛）与 Skill 调用成功后（`runtime/methods/tools.ts`
  batch_complete，本批成功名以 extraLoadedSkillNames 并入重算——历史此刻尚未入账）。
  会话终结 `beginShutdown` 清理。
- **消费点**：executor `permission-flow.ts` 每次裁决前取快照进
  `PermissionContext.skillActivationRules`；`permission/service.ts` 两处收口——
  deny 与 disallowedTools 同位次（模式分支之前，yolo 不复活；策略地板 deny 仍在
  其前），allow 与 allowedTools 同位次（策略地板/硬阻断/项目 deny/ask/plan 拒写
  之后——frontmatter 授权永不穿透地板）。ruleId：`rule.skillActivation.deny` /
  `rule.skillActivation.allow`。
- **匹配语义裁决清单（R4③ 逐项落定）**，实现在 `permission/skill-activation-rules.ts`：
  1. ruleContent 沿用权限面既有语义（`:*` 前缀 / `*` 通配 / 全等）——**落**；
     不引入参考面 Bash 子命令切分（与项目规则域一致，不造第二套匹配器）。
  2. `Skill(名 *)`/`Agent(名)` subject 提取——**暂不收（登记）**：ruleSubjects 未收
     skill/args/subagent 输入键，项目规则域同款缺口；带 content 的此类规则 allow 侧
     不授予（fail-closed）、deny 侧不禁（已知缺口，随 ruleSubjects 扩展统一收编）。
  3. `mcp__server` 服务器级前缀覆盖——**落**（双侧）。
  4. `toolName:"*"` 全工具通配——deny 侧**落**（作者全域禁意图必须生效）；allow 侧
     **不匹配**（frontmatter 自声明全工具授予过宽，参考压制语义同构，fail-closed）。
  5. Windows 路径分隔符归一——**落**：ruleContent 含 `/` 时 subject 额外按反斜杠→
     正斜杠归一重试（仅含 `/` 的规则生效，防命令文本误归一）。
- 验收：tests/skill-governance-wiring.test.mjs ①组 10 例（yolo deny 不复活/实参级
  前缀/裁决 3·4·5/floor·plan·disallowedTools 三重压制/并集去重）。

### ② paths 触发源（R5）

- 登记面 `agent/skill-path-activation.ts`（会话键控激活集，生命周期与 ① store 同
  哲学）；事件源 = executor `call-runner.ts` 工具成功后置点（file_path/path/
  ApplyPatch 目标集 → `matchedSkillPathPatterns` 同款判定纯函数），命中并入激活集
  且经既有 additionalContexts 通道回喂 system-reminder（文案自撰，模块内
  `buildSkillPathActivationReminder`）。
- 清单过滤：`context/sections/skills.ts` 按激活集过滤声明 paths 的技能（渐进披露
  成立：未触发不进模型清单）；**sessionId 缺席 = 不过滤**（子代理 builder/测试/
  旧调用方零回归）。sessionId 经 `ContextBuilderConfig` 由 runtime 注入。
- 验收：同测试文件 ②组 3 例（一次性激活/逃逸 fail-closed/清单过滤与缺席零回归）。

### ③ disable-model-invocation 硬门（R6）

- 回合级标记以**会话键控一次性标记桥**落地（`agent/skill-user-invocation.ts`）：
  单一写者 = CLI 手动 /skill 提交路径（`command-center/create.ts` 与
  `prompt-command.ts` 在 submitPrompt 之前落标记，覆盖 TUI 与 headless 两面）；
  单一读者 = Skill handler（`tool/handlers/skill.ts`），受门技能按名匹配一次性
  消费；拒绝为业务失败（result:false）+ 指位文案（自撰，含 NOT loaded 与
  /skill 活路）。未采用 ToolContext 插管方案：CLI→runtime→executor 的全链插管
  跨 6+ 文件且 turn 铸造在提交之后（CLI 拿不到 turnId），标记桥以最小面达成
  同款语义；边界（标记不带 turnId、名字匹配才消费、残余窗口方向 fail-closed）
  在模块头注如实登记。
- 验收：同测试文件 ③组 3 例（一次性消费/不匹配不吞标记/handler 拒绝与放行/
  缺省语义零回归）。

### ④ user-invocable:false 用户面隐藏（R6）

- 三个用户可见面（/skill 列表、acode skills list、TUI slash 完成）都以
  `bootstrap/src/skills.ts listACodeSkills` 为清单单一来源——过滤在该单点收口
  （不在三处各抄一份判定）；`inspectACodeSkill` 保留，cli `skills-command.ts`
  的 human/JSON 两呈现面标注 hidden（与参考 isHidden 语义一致）。模型面清单不受
  影响（runtime 走自己的 discoverSkills）。Composer 引用面板（bootstrap
  skill-reference-catalog 的 workspace 路径）随单点过滤同步收敛。

### ⑥ shell 键 ×! 块（R7 × powershell-tool 交叉）

- 自定义命令 frontmatter 收 `shell` 键（`adapters/src/commands/frontmatter.ts` 闭集
  解析，非法值 warning 回落 bash；`CustomCommandMetadata.shell` 契约位新增）；
  执行面 `bootstrap/custom-command-shell-expansion.ts` 按键选 shell：powershell 走
  PowerShell 工具同款解析序（pwsh→System32→PATH）+ 执行纪律（NoProfile/
  NonInteractive、argv 直发——Windows 下 Node 的 shell 字符串是 cmd.exe 专属
  /d /s /c 语义，不可用），解析不到 fail-closed 抛错绝不静默回落 bash；缺省 bash
  逐字节不变。技能正文 `!` 块进技能面：**维持登记不实施**（现状仅自定义命令链
  支持，扩面是新产品语义）。
