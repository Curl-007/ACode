# 内置技能包新增：verify 与 run（批次三）

提示词优化批次三（2026-10-03，Claude Code CLI 2.1.283 还原件结构性对照批）。
给 `apps/acode-cli/packages/bundled-skills` 增加两个操作学技能：

1. **verify**：把「验证 = 运行时观察」操作化——构建、启动、驱动到改动代码真正
   执行的位置、捕获所见作为唯一证据；四态判定（PASS/FAIL/BLOCKED/SKIP）。
2. **run**：把「跑起来」操作化——启动并**驱动**项目应用（不是只证明入口能解析）；
   项目技能优先，项目类型回退表兜底。

对照来源为第三方产品还原件的 bundled 技能（仅本地、只读、结构性分析）；
文本全部自撰英文（`prompt-language-policy.md` R1/R7），原文不进仓库。

## 背景

### ACode 现状（已核实）

- **学说已有、操作学缺位**：`behavior.dynamic` 自验证段（
  `verification-doctrine-prompt.md` R1）说了「验证 = 证明改动生效、先跑检查再声称
  完成」，但没有回答**跨表面怎么做**——CLI 改动看什么、GUI 改动怎么驱动、
  提示词改动拿什么当表面。实操中（本仓库自身历史）这类验证靠会话内临时发挥。
- **原语齐备**：Bash（全平台 POSIX 方言，`subagent-report-contract.md` W4 结论）、
  Read、浏览器自动化（browser-use 官方插件技能 / 工作区级 agent-browser、electron
  技能，存在性因装机而异）、headless `acode` prompt 模式（`packages/cli/src/run.ts`
  → `runPrompt`）、desktop dev 实例的 CDP 调试口。
- **项目技能根**：`.acode/skills/` 与 `.agents/skills/`（项目级与用户级双 scope，
  `adapters/src/skills/roots.ts:94-105` 合并发现）。
- **bundled 包机制**：整目录即 SkillRoot、放入即被发现、SEA 按目录遍历打包、
  完整性门 `BUNDLED_SKILL_PACK_REQUIRED_PATHS` 与 CreateWorkflow 耦合（
  `bundled-research-review-skills.md` R3 已确立「新技能不入门」的处置）。

### 对照分析发现的可移植结构（不复制文本）

参考产品 verify/run 技能的骨架：三硬纪律（verify 内不跑测试/typecheck、禁
import-and-call 捷径、证据 = 捕获的观察）；表面表（改动触达面 → 观察面 → 动作）；
「内部函数不是表面」；diff 是 ground truth、描述是 claim、不一致即 finding；
handle 优先项目技能（含 monorepo 包级技能目录探测）；冷启动限时 + BLOCKED 精确
到停点；**学到即沉淀**（把冷启动成功的配方写成项目 verify/run 技能）；
「驱动而非仅启动」；四态判定 + 无部分通过 + 存疑判 FAIL + 证据必须到达读者。

## 产品规则

### R1 verify 技能（`skills/verify/SKILL.md`，单文件）

frontmatter：name `verify`、description ≤250 字符（含触发语义：提交非平凡改动前
运行；只动测试/文档/无运行时表面的 diff 不调用）。正文要素（自撰）：

1. **定义**：验证是运行时观察——构建、运行、驱动到改动代码执行处、捕获所见；
   捕获即证据，别的都不算。
2. **三硬纪律**：verify 过程内不跑测试套件、不做 typecheck（那是 CI 的证明，
   时间花在跑应用上）；禁止 import 内部函数加 console.log 的捷径（那是自写
   单测，应用没有运行）；证据是捕获的观察（终端输出、响应体、截图），不是
   「代码看起来对」。
3. **定位变更**：先确定完整 diff 范围（分支可能是多个 commit、可能未提交）；
   **diff 是 ground truth，任何描述只是对它的 claim，两者实质不一致本身就是
   finding**；无仓库时范围以用户点名为准。
4. **表面表（ACode 化）**：CLI/TUI → 终端（敲命令、捕获输出与退出码）；
   server/API → socket（发请求、读响应体）；Web GUI → 像素（dev server +
   可用的浏览器自动化技能/插件驱动并截图，无则如实降级并声明）；桌面/Electron →
   调试协议或 OS 级自动化（存在性因装机而异，条件句表述）；library → 包边界
   （经公开导出写样例，不 import ./src）；**提示词/技能/AGENTS.md 类改动 →
   agent 本身**（用 headless `acode` prompt 模式跑代表性输入、捕获行为）；
   CI 工作流 → 触发并读 run 结果。
5. **内部函数不是表面**：顺调用方走到上表某行为止；完全没有运行时表面
   （纯文档/纯类型/纯测试）→ 一行 **SKIP + 理由**，不拿跑测试填版面。
   diff 里的测试是作者的证据不是表面：tests-only → SKIP；混合 → 验证 src
   忽略测试文件；读测试当 spec 可以，读完去跑应用。
6. **handle 纪律**：先查项目技能根（`.agents/skills/`、`.acode/skills/`，
   monorepo 同时查仓库根与 diff 触及的包目录两级）里有无 run/verify 类项目
   技能——那是仓库已验证的路径，逐字照做；没有则从 README/AGENTS.md/
   package.json scripts 冷启动，限时约 15 分钟；卡住 → **BLOCKED + 精确停点**，
   不硬猜。**学到即沉淀**：冷启动成功后把 build/launch/drive 配方写成项目级
   verify 技能（放探测过的层级），保持简短；项目技能已存在时只在它**带错路**
   时修它（文档命令失效、缺必要步骤），日常心得不改写、不为风格重组。
7. **驱动**：找让改动代码执行的最短路径（改了 flag 就带 flag 跑；改了 handler
   就打那条路由；改了错误处理就触发那个错误）；**执行前把计划读一遍**——
   每一步都是 build/typecheck/跑测试 = 计划的是 CI 重跑不是验证。
8. **判定与证据**：PASS = 应用跑了且改动在其表面做了该做的事；FAIL = 跑了但
   没做到/弄坏了别的/claim 与 diff 实质不符；BLOCKED = 到不了可观察状态
   （不是对改动本身的判定）；SKIP = 无运行时表面。**无部分通过**（4 项过 3 项
   = FAIL，除非逐项解释清楚）；**存疑判 FAIL**（假 PASS 放行坏代码，假 FAIL
   只多一次人工复核）；输出含糊 → FAIL 并附原始捕获，不替它解释。
   证据必须到达读者：捕获的关键输出/响应体内联进报告，路径只在读者可达时引用。
   观察即信号：判定之外，把「让你停顿/绕路/觉得奇怪」的点写进报告——你是
   唯一真跑过它的人。
9. **端到端走真实界面**：分段各自通过不等于链路通（缝里藏 bug）；用户点按钮
   的改动就点按钮验证，不 curl 底层 API 代替。

### R2 run 技能（`skills/run/SKILL.md`，单文件）

frontmatter：name `run`、description ≤250 字符（触发语义：被要求运行/启动/
截图应用、或在真实应用里确认改动生效时）。正文要素：

1. **定义**：跑起来 = 启动真实应用并**与它交互**——不是测试套件、不是 import
   内部函数打日志；以用户（人或程序）遇见它的方式遇见它。
2. **项目技能优先**：先扫两级技能根的项目技能描述找 launch/run 覆盖——命中则
   逐字照做（不转述、不跳补丁步骤）；多个候选分不清 → 问用户跑哪个单元；
   技能过期（在与任务无关的机制上失败）→ 告知用户并提议刷新它，不默默绕开。
3. **回退表（按项目形态）**：CLI（直接调用 + 退出码 + stdin/stdout）；
   web server/API（后台启动 + curl 冒烟）；TUI（终端驱动/捕获，工具存在性
   条件句）；Electron/桌面（调试协议驱动，条件句）；浏览器型 web 应用
   （dev server + 浏览器自动化技能/插件）；library/SDK（包边界冒烟脚本）。
   先读 AGENTS.md 与 package.json scripts——仓库通常已写明命令。
4. **驱动而非仅启动**：启动不交互只证明入口能解析；每类表面给驱动动作
   （CLI 敲代表性命令、server 打 diff 触及的路由、GUI 点按钮并**看截图**——
   空白帧就是没起来）。
5. **沉淀建议**：回退路径若额外做了工（装包、配 env、打补丁、写驱动脚本），
   在报告里建议把这套配方沉淀为项目 run 技能（下次免冷启动）；开箱即用则
   不建议。完整 generator 元技能不在 v0（见「不在本项范围」）。

### R3 打包与发现

- 与 `bundled-research-review-skills.md` R3 同一处置：放入 bundled 包即被发现/
  打包，零运行时接线；**不加入** `BUNDLED_SKILL_PACK_REQUIRED_PATHS`
  （完整性门保持与 CreateWorkflow 工具门耦合）；`$` 引用面板排除为既有
  已知限制（同 spec 登记，不重复展开）。
- 两技能互相引用限一句话级（verify 的 handle 节可提及 run 技能的启动模式），
  不互相复述判据。
- 描述 ≤250 字符；两技能合计 listing 增量 < 600 字符（20K 预算内）。
- 命名 `verify` / `run` 为通用词：用户/插件同名技能压过内置属**预期行为**
  （bundled priority 最低的既有设计），登记不阻塞。

### R4 分层与去重

| 承载层 | 装什么 |
| --- | --- |
| `behavior.dynamic` 自验证段 | 学说（验证=证明生效、先跑再声称）——每请求在场的一句话原则 |
| verify 技能 | 操作学（表面表、handle、判定、证据）——按需加载的完整流程 |
| run 技能 | 启动与驱动的操作学 |
| 项目 AGENTS.md / 项目技能 | 本仓库的具体命令与已验证配方（事实源） |

技能不复述自验证段的原则句，自验证段不引用技能名（技能存在性因装机形态
而异—— bundled 恒在，但段文本不得依赖技能清单）。code-review 技能（读 diff
出发现）与 verify（跑应用出证据）边界清晰，互不复述。

### R5 语言与合规

英文自撰（`prompt-language-policy.md` R1/R7）；表面表里的工具存在性一律条件句
（「if available / when present」），不指向不存在的工具（`dispatch-discipline-prompt.md`
R5 同方向）；无第三方产品原文。

## 状态所有者

| 事实 | 所有者 |
| --- | --- |
| verify 操作学文本 | `packages/bundled-skills/skills/verify/SKILL.md`（新增） |
| run 操作学文本 | `packages/bundled-skills/skills/run/SKILL.md`（新增） |
| 验证学说（原则句） | `context/dynamic-sections.ts` behavior.dynamic（不动） |
| 发现/优先级/打包 | `bootstrap/src/app/bundled-skills.ts` 与 SEA 脚本（不动） |

## 接口

零代码接口变更：纯内容目录新增。

## 验收场景

1. **目录与 frontmatter**：`skills/verify/SKILL.md`、`skills/run/SKILL.md` 在场；
   name 与目录一致；description ≤250 字符且含各自触发语义。
2. **verify 内容要素**：三硬纪律、diff/claim 关系句、表面表七行（CLI/server/
   Web GUI/桌面/library/提示词-agent/CI）、内部函数非表面、SKIP 一行制、
   handle 先查两级技能根 + 15 分钟限时 + 沉淀条款、计划读回判据、四态判定 +
   无部分通过 + 存疑 FAIL + 证据到达读者、端到端真实界面句——逐条可定位。
3. **run 内容要素**：交互定义句、项目技能优先三分支（命中照做/多候选问/过期
   告知）、回退表六形态、驱动动作四例（含「看截图/空白帧」句）、沉淀建议
   触发条件——逐条可定位。
4. **条件句纪律**：浏览器/桌面自动化相关行均为存在性条件句（无「必须使用
   X 工具」的硬指向）。
5. **完整性门不连坐**：`BUNDLED_SKILL_PACK_REQUIRED_PATHS` 仍只含
   dynamic-workflows 三文件（复用既有断言方向）。
6. **发现链路**：bundled skills 目录扫出**五个**技能（dynamic-workflows、
   research-report、code-review、verify、run）；既有
   `bundled-research-review-skills.test.mjs` 的三技能断言同批更新为五技能。
7. **语言合规**：两技能正文无 CJK。
8. **验证命令**（仓库根执行，如实记录）：`pnpm typecheck`、`pnpm lint`、
   `node --import tsx --test apps/acode-cli/tests/*.test.mjs`。

## 不在本项范围

- **examples/ 分文件**（参考产品每表面一个示例文件）：v0 内联短例，语料长大
  再拆（progressive disclosure 的拆分点在 SKILL.md 超长时，不在 v0）。
- **run-skill-generator 元技能**：v0 以 run 技能内的「沉淀建议」条款承载意图；
  独立 generator（自动采访 + 生成 + 校验项目技能）另立项。
- **verifier-* 录制/回放协议**（参考产品的证据录制会话包装）：依赖录屏/回放
  基建，ACode 无对应物。
- **`$` 引用面板暴露 bundled 技能**：沿 `bundled-research-review-skills.md` R3
  登记，结转同一后续 owner。
