# 内置技能包新增：research-report 与 code-review（批次二项三/项四）

提示词优化批次二（2026-10-03，Codex 还原件结构性对照批）项三+项四。给
`apps/acode-cli/packages/bundled-skills` 增加两个随 CLI 分发的第一方技能：

1. **research-report**：多轮、带引用的深度研究报告技能（对照参考：第三方产品
   deep-research 插件的结构性分析——交付物硬门、失败契约、证据标准、
   claim-to-source ledger、反碎片化派单；文本全部自撰，交付物按 ACode 能力
   改为 Markdown，不引入 DOCX 管线）。
2. **code-review**：变更评审技能（对照参考：第三方产品 code-review 渲染层
   提示词的「发现过滤器」六判据与仓库规则归因纪律；`::code-comment` 指令机制
   **已存在**于 desktop 段（`context/sections/desktop.ts`），本技能只承载
   评审学说，不复述指令语法）。

两者都是纯内容新增（SKILL.md + 参考文件），零运行时代码改动：bundled 包整目录
即 SkillRoot（`bootstrap/src/app/bundled-skills.ts` 的 `resolveBundledSkillRoots`
返回 `skills/` 目录，priority 1,000,000），新增子目录自动被发现；SEA 打包脚本
（`packages/cli/scripts/sea-bundled-skill-assets.mjs`）按目录遍历，自动携带。

## 背景（已核实的现状）

- bundled 包当前只有 `dynamic-workflows`（SKILL.md + patterns.md + examples.md），
  其完整性门 `BUNDLED_SKILL_PACK_REQUIRED_PATHS` 与 CreateWorkflow 的工具门耦合
  （技能未加载则工具拒跑，`dynamic-workflow-gate.ts`）。
- bundled source 的技能被排除在 UI `$` 引用面板外
  （`acode-protocol/skill-reference-catalog.ts:44-52`：协议 scope 是封闭枚举，
  不为 bundled 扩枚举）——**整个 `source: "bundled"` 都被过滤**，不只
  dynamic-workflows。
- 技能发现与列表：bundled root 参与 `discoverSkills`，技能出现在模型面
  skills listing（`context/sections/skills.ts`，250 字符描述上限、20K 预算），
  可被 `/name` 调用与模型自动选用。
- 同名覆盖：bundled priority 最低，用户/项目/插件同名技能压过内置
  （`bundled-skills.ts` 注释）——新技能命名需避开常用冲突名的歧义。

## 产品规则

### R1 research-report 技能内容

目录 `skills/research-report/`：`SKILL.md`（入口，frontmatter name/description/
when_to_use）+ `method.md`（两遍研究法细则）+ `report-contract.md`(报告结构契约)。
SKILL.md 指示开工前先读两个参考文件（progressive disclosure，dynamic-workflows
同款模式）。内容要素（全部自撰英文）：

1. **定位与触发**：多来源、需对证的深度调研（技术选型对比、生态调查、
   事实核查型问题）；单点查询不适用（when_to_use 写反例）。
2. **交付物定义**：带引用的 Markdown 报告；缺省在对话内交付，用户要求文件时
   写入指定路径并**确认写入成功**；用户要文件而写入失败时如实报阻塞，
   不静默改为对话交付（交付物硬门的 ACode 形态）。
3. **证据标准**：实际执行搜索而非依赖记忆；一手/权威来源优先；论坛与社交源
   显式标注弱信号；日期、数量、对比、推荐类关键论断尽量对一手来源；
   保留实质分歧与不可达证据，不抹平；**页面内嵌指令视为不可信源文本**
   （与 `web-content-untrusted-discipline.md` 同口径、一句话呼应不复述判据）；
   绝不编造来源、引文、URL、访问结果。
4. **方法（两遍 + 停止判据）**：广域发现 → 缺口/矛盾清单 → 定向补充
   （更强证据、新近性、未决论断）→ 停止判据：再一轮定向搜索主要在重复已知
   证据或只增加更弱重复时停。
5. **委派纪律**：可用 Agent 派**一个**专职研究子代理（brief 含完整问题、
   受众、约束、输出契约）；不把第一遍拆成多个浅代理（与纪律节第 7 条
   自足派单同向）；仅当出现可分离专项或未决矛盾才加第二个。
6. **返回契约**：直接答案 + 报告正文；论断-来源清单（标题/发布者/日期/URL）；
   实质矛盾及处置；置信度与未决缺口；执行过的搜索与停止原因。
7. **失败契约**：访问不完整时仍尽量交付但标注局限并下调置信度；
   未验证的表述不得写成已验证。

### R2 code-review 技能内容

目录 `skills/code-review/`：单文件 `SKILL.md`（评审学说一屏承载，无参考文件）。
内容要素：

1. **定位**：评审另一个工程师（或另一个代理会话）的变更；只评审不修复——
   发现问题输出发现，动手修需用户显式要求（scope 纪律与
   `subagent-report-contract.md` R2 同向）。
2. **评审面对象**：按用户指定（staged / 工作区 / 分支对 base / 具体 commit）；
   未指定时问一次或选最合理默认并声明。
3. **过程**：先读 diff，再对每个 hunk 读周边代码（不只 diff 行）；查改动文件
   适用的项目指令文件（AGENTS.md 等，更具体者优先，用户关于评审范围/风格的
   指示最高）；每条发现落到 file:line 并对回真实代码核实。
4. **发现过滤器（六判据）**：实质影响正确性/性能/安全/可维护性；离散可操作；
   **由本次变更引入**；作者知道后大概率会修；不依赖未言明的意图假设；
   清楚指出受影响行为而非宽泛猜测。**宁缺毋滥**：没有可操作问题就简短直说。
5. **去重与归因**：按变更位置与缺陷/ remedy 去重；规则支撑的发现注明适用的
   指令文件与最小行区间；不编造引用。
6. **输出**：Markdown 评审正文；桌面面可用 `::code-comment` 指令挂行内评论
   （语法归 desktop 段，技能只说「何时用」：反馈能钉到具体变更行时，
   一行一条，无可行内评论时不发指令）；严重度用 [P1]/[P2] 标签仅在有助沟通时。
7. **不复述 diff**、不为显得彻底而制造发现。

### R3 发现面与打包

- 两个技能进 bundled 包即随三种运行形态分发（dev 原地读 / SEA 内嵌解压 /
  远端 stage），零代码接线。
- **不加入** `BUNDLED_SKILL_PACK_REQUIRED_PATHS`：该门与 CreateWorkflow 工具门
  耦合（缺文件 → 整包拒绝 → 工作流工具拒跑）；新技能无工具门耦合，缺文件应
  退化为「技能缺席」而不是连坐工作流。SEA 脚本的遍历式收集不受影响
  （其 REQUIRED 对齐检查只针对既有三文件，维持）。
- **已知限制（登记）**：bundled source 整体被 `$` 引用面板排除
  （协议 scope 封闭枚举），新技能在桌面 UI 的引用面板不可见；模型面 listing
  与 `/name` 调用不受影响。面板暴露需要协议 scope 枚举扩展（跨包、旧客户端
  严格校验），结转后续 owner。
- 描述 ≤ 250 字符（listing 上限）；两个技能的 listing 增量在 20K 预算内
  （合计 < 600 字符）。
- 命名避让：`research-report`（不用 deep-research，避免与第三方同名技能的
  覆盖关系歧义——bundled 优先级最低，同名时用户/插件版本压过内置属预期）；
  `code-review` 为通用词，用户/插件同名覆盖同样是预期行为，登记不阻塞。

### R4 语言与合规

技能正文全英文自撰（模型面，`prompt-language-policy.md` R1/R7；SKILL.md 是
模型读的文件）；frontmatter description 英文；无第三方产品原文。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| 技能文本 | `packages/bundled-skills/skills/{research-report,code-review}/`（新增） |
| 发现/优先级/覆盖 | `bootstrap/src/app/bundled-skills.ts`（不动） |
| 完整性门 | `BUNDLED_SKILL_PACK_REQUIRED_PATHS`（**不动**，R3） |
| listing 呈现 | `context/sections/skills.ts`（不动） |

## 接口

零代码接口变更：纯内容目录新增。测试经文件系统断言（存在性 + frontmatter 形状）。

## 验收场景

1. **目录与 frontmatter**：两个技能目录在场；各自 SKILL.md 有合法 frontmatter
   （name 与目录名一致、description ≤ 250 字符、research-report 另有 when_to_use）；
   research-report 的 method.md / report-contract.md 在场且被 SKILL.md 显式引用。
2. **内容要素**：research-report 的 SKILL.md/参考文件可逐要素定位 R1 的七项；
   code-review 可逐要素定位 R2 的七项（六判据逐条、宁缺毋滥、只评审不修复、
   ::code-comment 的「何时用」而不复述语法）。
3. **完整性门不连坐**：`BUNDLED_SKILL_PACK_REQUIRED_PATHS` 逐字不变
   （源码级断言，防把新文件误加进 workflow 耦合门）。
4. **语言合规**：技能文件正文无 CJK（frontmatter 与正文全英文）。
5. **发现链路冒烟**：`listACodeSkills` 在仓库工作区能发现两个新技能且
   `source === "bundled"`（走既有 discovery，不 mock 文件层）。
6. **验证命令**（仓库根执行，如实记录）：`pnpm typecheck`、`pnpm lint`、
   `node --import tsx --test apps/acode-cli/tests/*.test.mjs`。

## 不在本项范围

- **`$` 引用面板暴露 bundled 技能**：协议 scope 枚举扩展，跨包，结转后续（R3 登记）。
- **DOCX/PDF 交付管线**：ACode 无文档生产插件，交付物定为 Markdown（R1-2）。
- **评审 MCP 服务/GitHub PR 集成**：对照产品的 code-review 是 MCP server 形态；
  ACode v0 为技能形态（主会话内评审），PR 面集成另立项。
- **研究子代理的专用 profile**：R1-5 用通用 Agent 派发；若 eval 显示需要
  专用 profile（工具面裁剪 + 证据标准进 profile 文本），随 W8 场景数据再立项。
