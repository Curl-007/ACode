# Script Workflow 复活为 RunWorkflow 工具 + 沙箱升级（S2）

路线图 S2（承接 S1 `workflow-worktree-isolation.md`）：把仓库里**已完整实现但工具入口被摘掉**的
脚本工作流（Claude-Code 风格 JS DSL）复活为模型可调用的 `RunWorkflow` 工具，与现役 dwf
（`CreateWorkflow` 家族）并列成为**两套各自独立、都可用**的工作流系统；同时把它的脚本执行面
从 `--eval` + `AsyncFunction`（同 realm）升级为 `vm.createContext` 独立 realm，对齐 dwf 已有姿态。

所有者拍板（2026-10-06）：复活休眠实现，**不**给 dwf 引擎加方言参数；工具另起新名 `RunWorkflow`；
沙箱一并升级。

红线（本 spec 范围内绝不做）：

- **不动 dwf 包一个字节**。`dynamic-workflow` / `dynamic-workflow-runtime` 的 facade、registry、
  compiler、analysis、lowering、engine 全部不改。S1 R1 已把「给灰度门后引擎加 facade 参数」裁为
  投机新表面，commit `f3e8142` 登记了触发条件；本 spec 不触发它。
- **不回收死工具名 `Workflow`**。`provider-visible-order-hygiene.test.mjs` 的「死名永不回收」纪律
  不动，`LEGACY_TOLERATED` 继续容忍它。新工具用新名。
- **不合并两套的存储、事件或 run 序列**。它们各自的表、事件前缀、runId 前缀保持分离（见 R6）。
- **不把 `RunWorkflow` 变成 dwf 的第二个写入路径**。两套各有唯一所有者，互不写对方的状态。

## 背景

以下均已按 `文件:行` 核实（行号实施前需复核）。

### 已存在且完整的部分（休眠实现的主体）

| 面 | 位置 | 状态 |
| --- | --- | --- |
| 工具契约 | `contracts/src/tools/workflow.ts:12-66` | 完整。`script`/`scriptPath`/`name`/`resumeFromRunId`/`args` 五入参 `.strict()` + superRefine；`scriptPath` 优先；脚本上限 `WORKFLOW_SCRIPT_MAX_LENGTH = 524_288`（:9）；runId 正则 `/^wf_[a-z0-9-]{6,}$/`（:10） |
| 契约文案 | `contracts/src/tools/workflow.ts:45` | 逐字要求 `export const meta = { name, description, phases }`（纯字面量）+ `agent()/parallel()/pipeline()/phase()` |
| meta / opts schema | `contracts/src/workflow/script.ts:8-39, 44-59` | 完整。phase 带 `title/detail?/model?` 且标题去重；agent opts 含 `agentType/instructions/isolation/label/model/phase/schema/skills/systemPrompt/timeoutMs/tools` |
| 运行记录与存储端口 | `contracts/src/workflow/script.ts:150-171, 306-343` | 完整。`ScriptWorkflowRunRecord.kind: "script"` 是判别字段；`findCachedScriptWorkflowActivity({callPath, inputHash, runId})` 是 resume 缓存查询 |
| 存储实现 | `adapters/src/storage/session-store/repositories/script-workflow-{activities,codecs,runs}.ts` | 完整，独立 `workflow_activity` 表 |
| 八个 DSL 全局 | `bootstrap/src/app/script-workflow-child-source.ts:66-138` | 完整。`agent/parallel/pipeline/log/phase/workflow/args/budget`，`budget` 含 `total/spent()/remaining()` |
| 确定性禁令 | `script-workflow-child-source.ts:140-159` | 完整。`Date.now()` / 无参 `new Date()` / `Math.random()` 三者抛错，`Date.parse`/`Date.UTC`/`new Date(ms)` 刻意保留 |
| meta 提取 | `script-workflow-meta.ts:70-190` | 完整且鲁棒：`findObjectLiteralEnd` + `scanString`/`scanLineComment`/`scanBlockComment` 正确处理字符串与注释里的假 `}` |
| 进程与 NDJSON 协议 | `script-workflow-process.ts:25-183` | 完整。stdio 行协议 `request/response/event/complete`，与 dwf 的 harness 同构 |
| resume 缓存 | `script-workflow-runtime.ts:277-295` | 完整。键 = `(runId, callPath, inputHash)`，`inputHash = stableHash({opts, phase, prompt})`；`callPath` 由 `AsyncLocalStorage` 铸造（`child-source.ts:52-64`） |
| worktree 隔离 | `workflow-worktree-manager.ts` | S1 已落地，10 个测试绿 |
| app 方法与端口 | `create-app.ts:653, 920, 1336`；`script-workflow-methods.ts:44-53`；`script-workflow-tool-port.ts` | 全部接线完成 |

### 已确认的缺口

1. **工具入口不存在**。`core/src/tool/handlers/index.ts:86-150` 的 `builtInTools` 没有任何脚本工作流
   条目（已核实：无 `name: "Workflow"`，也无 `workflowToolEntry`）。`:282-284` 的
   `if (entry.metadata.name === "Workflow" && options.includeWorkflow !== true) continue;` 永不命中；
   `runtime-tools.ts:67` 的 `includeWorkflow: Boolean(deps.workflowPort)` 给一个不存在的门传值。
   五个 app 方法（`runWorkflowScript` / `listScriptWorkflows` / `validateWorkflowScript` /
   `scriptWorkflowStatus` / `resumeWorkflowScript`）接线完整但**零调用点**（已核实
   `grep -rn "\.runWorkflowScript("` 无命中）。
2. **沙箱是同 realm 的，可逸出**。`script-workflow-process.ts:43-49` 用
   `spawn(node, ["--input-type=module", "--eval", CHILD_SOURCE, "--", payload])`，
   `child-source.ts:168-179` 在**模块 realm 内**用 `new AsyncFunction(...)` 编译脚本体。
   该 realm 是 ESM 模块作用域，`child-source.ts:2-4` 已 import 了 `node:async_hooks`/`node:readline`/
   `node:console`，且 `:6` 的 `const nodeProcess = process` 在 `:161` 把 `process` 定义成 undefined
   **之前**就捕获了真值。因此脚本体可以经动态 `import("node:fs")`、或经任何可达函数的
   `.constructor.constructor` 拿到完整 Node 面。dwf 那边是 `vm.createContext` 独立 realm
   （`dynamic-workflow-runtime/src/child-source.ts:263-282`），只含 ES intrinsics + 注入的 `__host`。
3. **脚本正文经 argv 传递，与契约上限矛盾**。`script-workflow-process.ts:34-45` 把含 `scriptBody`
   的 payload base64url 后作为 `argv.at(-1)` 传入（`child-source.ts:7` 读取）。契约允许 512KB 脚本
   （`WORKFLOW_SCRIPT_MAX_LENGTH`），而 Windows 命令行上限是 32767 字符 —— 大脚本必然 spawn 失败。
   dwf 正是为此改用落盘入口文件（`dynamic-workflow-runtime/src/harness.ts:259-269`，
   `child-entry-file.ts:46-52`，注释明写 `ENAMETOOLONG`）。
4. **`workflow()` 嵌套是桩**。`script-workflow-runtime.ts:253`
   `throw new Error("Nested workflow() is reserved for a later workflow runtime version.")`。
5. **无名字常量**。contracts 里有 23 个 `*_TOOL_NAME`，但没有 `WORKFLOW_TOOL_NAME`；
   名字只以字面量散落在 7 处（见 R3 表）。house pattern 要求名字常量住
   `contracts/src/tools/<name>.ts` 并从 `contracts/src/tools/index.ts` export。
6. **无技能，无技能门**。dwf 侧有 `dynamic-workflows` 技能 + `workflow-skill-gate.ts`（错误码 428，
   未加载技能即拒绝接受脚本）；脚本工作流侧两者都没有。
7. **UI 未登记**。`packages/shared/src/tool-identity.ts` 的 `ACODE_KNOWN_TOOL_NAMES` 与
   `TOOL_FAMILY_BY_NAME` 都不含脚本工作流的工具名 → identity 回 `unknown` → 落 raw JSON 兜底卡
   （`packages/ui/src/ToolCallBlocks/resolveRenderer.ts:130-170`）。
   **这一条实施时被推翻**：登记进 `workflow` family 反而会渲染成 dwf 的创建卡，详见 R3 补注。
8. **没有任何通道能停掉一个已 backgrounded 的 run**（实施时发现）。
   `script-workflow-tool-port.ts:77` 为 run 自建 `AbortController` 并刻意让它脱离发起 turn
   （父 turn 取消不该连带杀掉已交出去的任务），但那个 controller **从不外露**：
   `WorkflowPort` 只有 `start`/`getTask`/`waitForTask`，没有 `cancel`；
   `background-tasks.ts:781-792` 因此把 `cancellable` 写死成 `false`。
   而契约 `workflow.ts:38` 明文要求「resume 前先 TaskStop」——那句话当时是假的。
9. **resume 无并发守卫**（实施时发现）。`start` 拿到 `resumeFromRunId` 就直接起 run，
   不检查那个 runId 上是否还有在飞的 run。两份 run 会写同一批 activity 行、抢同一组缓存键
   （`(runId, callPath, inputHash)`），于是「(prompt, opts) 未变即命中」命中的可能是
   另一份 run 刚写下的结果。缺口 8 与 9 是一对：正因为停不掉，才更容易撞上双跑。
10. **agent 调用上限的计数作用域错了**（实施时发现，休眠期不可达）。
    `MAX_WORKFLOW_AGENT_CALLS = 1000` 是**每 run** 的语义，但计数器 `callIndex` 曾是
    `ScriptWorkflowRuntime` 的实例字段，而 runtime 实例按**会话** memoize
    （`script-workflow-methods.ts` 的 `runtime ??= new ScriptWorkflowRuntime(...)`）。
    后果：一个会话里累计跑满 1000 次 agent 之后，此后每次 `agent()` 都抛
    `Workflow agent call limit exceeded`，脚本工作流在该会话里**永久失效直到重启**；
    并发的两个 run 还会互相吃对方的额度。另一半是 `validate()` 里的 `this.callIndex = 0`
    ——validate 根本不派生 agent，它去归零只会清掉某个**在飞** run 的计数，让那个 run 的
    上限形同不存在。修法：计数器改为 `Map<runId, number>`，run 结算即删项，
    `validate()` 不再碰它。守护测试 `tests/script-workflow-agent-cap.test.mjs`（源码级，
    理由在测试文件头如实写明：行为级复现要桩掉 11 个 store 方法 + 真 spawn 子进程，
    为钉一个作用域错误付这个代价不成比例）。
    连带修正：技能 §5 原本写「没有总量上限」，与真实的 1000 上限矛盾——技能是模型唯一的
    读者，那句话会让它放心地写无界循环，然后在第 1001 次调用上把整个 run 连同已积累的
    结果一起炸掉。§5 与 §8 均已改为写出真实上限与「超限 = 整 run 失败」的后果。

### 命名裁决的依据

`Workflow` 这个名字当前空闲，但**不用它**，改用 `RunWorkflow`：

- `RunWorkflow` 是该 DSL 来源产品自己的官方 alias，迁移其提示词/技能时零改写；
- 与 dwf 的 `CreateWorkflow` 字面不相近，模型不会在两者之间选错（`Workflow` 与 `CreateWorkflow`
  只差一个前缀，正是最容易混的一对）；
- 符合仓库既有的动词开头命名（`CreateWorkflow` / `AmendWorkflow` / `SaveWorkflow` /
  `ResumeWorkflowRun` / `ResolveWorkflowQuestion`）；
- 不占用死名，`LEGACY_TOLERATED` 与「死名永不回收」纪律原样保留。

## 产品规则

### R1 范围裁决（复活休眠实现；dwf 引擎面仍是非目标）

- 落地面 = `contracts/src/tools/workflow.ts` + `contracts/src/workflow/script.ts` +
  `bootstrap/src/app/script-workflow-*.ts` 这条**已存在**的链路。本 spec 是**兑现既有契约**，
  不是发明新表面——与 S1 同款定性。
- **dwf 面不做**：不给 `dynamic-workflow` 加方言参数、不动它的 facade/registry/compiler/analysis/
  lowering/engine。S1 R1 的触发条件（dwf 出灰度 **且** 出现真实并行 actor 互踩需求信号）未被本项满足。
- 本项与「dwf 灰度缺省反转」（`packages/shared/specs/dynamic-workflow-availability.md`）是两件独立的事，
  但共享同一个可用性开关（见 R5）。

### R2 工具命名与名字常量（唯一所有者）

- 新增 `RUN_WORKFLOW_TOOL_NAME = "RunWorkflow"`，住 `contracts/src/tools/workflow.ts`
  （与该工具其余契约同文件），并从 `contracts/src/tools/index.ts` export —— 照该文件既有的
  「漏掉这行谁会静默失效」注释先例。
- 契约文案里的自指（`workflow.ts:38, 52, 64` 的 "a prior Workflow invocation" /
  "re-invoke Workflow" / "Workflow requires…"）随改名同步为 `RunWorkflow`，否则模型读到的
  工具名与它实际能调的名字不一致。
- 死名 `Workflow` **保留原样**，不清理、不回收。

### R3 七处遗留面按新名接线

| # | 位置 | 改动 |
| --- | --- | --- |
| 1 | `core/src/tool/provider-visible-order.ts:27` | 按字母序补 `RunWorkflow`；`Workflow` 那行**不动**（仍由 `LEGACY_TOLERATED` 容忍） |
| 2 | `core/src/runtime/methods/background.ts:436, 452` | 正向映射补 `case "RunWorkflow": return "local_workflow"`，**保留** `case "Workflow"`（旧会话 rollout 里仍有该名字）；反向 `local_workflow → "RunWorkflow"`（活名优先） |
| 3 | `core/src/tool/executor/background-task-registry.ts:207, 222` | 同 #2 |
| 4 | `core/src/tool/executor/background-tasks.ts:612, 781` | 通知格式器与 `cancellable` 分支补新名；`:610-611` 的注释同步（它现在只提 legacy `"Workflow"`） |
| 5 | `OFF_PEAK_MUTATION_TOOL_NAMES` 三份同值副本：`core/src/runtime/methods/turn-loop-state.ts:34`、`bootstrap/src/acode-protocol-v4/commands/prompt-turn.ts:292`、`bootstrap/src/acode-protocol/server-operations.ts:2412`（**内联字面量，不是具名常量**） | 三处都补 `RunWorkflow`；随后**把副本消掉**（见 R9 的实现决定回写）：core 的 turn-loop-state 是唯一所有者，经 `core/src/index.ts` 导出，两个 bootstrap 消费方改为 import。同款处理 `AUTOMATION_MUTATION_TOOL_NAMES`（同样是 core 一份、prompt-turn 一份手抄） |
| 6 | `packages/shared/src/tool-identity.ts` | **刻意不登记**（原方案写错，实施时纠正，见下面「R3 补注」） |
| 7 | `apps/acode-cli/tests/provider-visible-order-hygiene.test.mjs:29` | `LEGACY_TOLERATED` 保持 `new Set(["Workflow"])` 不变（新名是**真实注册**的，走 `registered.has(name)` 分支） |

#### R3 补注：为什么 RunWorkflow 不进 `tool-identity.ts`

原方案第 6 项要求把新工具登记进 `ACODE_KNOWN_TOOL_NAMES` 与 `TOOL_FAMILY_BY_NAME`，
理由是「否则 UI 落 raw JSON 兜底卡」。实施时核实：这个理由是错的，登记会造成更坏的结果。

- `packages/ui/src/ToolCallBlocks/resolveRenderer.ts` 的 `case "workflow":` 分支只有两种结果：
  `submit_result` → `SubmitResultToolCallBlock`，**其余一律** → `CreateWorkflowToolCallBlock`。
- 也就是说把 `RunWorkflow` 放进 `workflow` family，它会渲染成 dwf 的创建卡：因果图、
  dwf run 投影、确认窗的 Refine 选项——这些 RunWorkflow 一个都没有（它没有静态分析，
  见「已知边界 1」，run 也不在 `workflowRuns` 投影里）。
- `packages/ui/src/lib/workflowToolNames.ts:11-16` 的文件头正是为此写的：
  「一旦有人把这些名字登记进 workflow family，保存与列举就会静默渲染成『创建工作流』——
  保存确认窗甚至会长出因果图与 Refine 选项」。dwf 自己的另外八个工具也因此**都不在**
  `ACODE_KNOWN_TOOL_NAMES` 里，而是走按名判定。

裁决：本项**不动** `tool-identity.ts`。RunWorkflow 暂时落 `FallbackToolCallBlock`
（raw JSON），诚实但难看；专用渲染器与按名判定属于批次 C 的「两套共存的显示」范围。
宁可暂时难看，也不要一张说谎的卡。

### R4 沙箱升级为 vm 独立 realm（本项的核心安全改动）

- 脚本体必须在 `vm.createContext` 建的独立 realm 里求值。参照实现就在本仓库：
  `dynamic-workflow-runtime/src/child-source.ts:263-282`（含 `codeGeneration: {strings: false, wasm: false}`
  禁掉 realm 内的 `eval`/`new Function`/WASM）。
- **升级后确实被关闭的逸出面**（今天全都开着）：realm 内没有 `process` / `Buffer` / `require` /
  模块系统，也拿不到子进程模块作用域的任何绑定（今天 `child-source.ts:6` 的
  `const nodeProcess = process` 与脚本同处一个 realm，`import("node:fs")` 直接可用）；
  动态 `import()` 在 vm Script 里不可用（未提供 `importModuleDynamically` 回调）；
  realm 内的 `Function` 构造器只看得到 realm 自己的全局，`Function("return process")()`
  是 ReferenceError。
- **仍未关闭、且刻意不假装关闭的一条**：注入进 realm 的宿主函数是**外层 realm 的对象**，
  于是 `agent.constructor.constructor("return process")()` 这类原型链上溯仍能拿到外层
  `Function`。dwf 是同一姿态——它只注入一个 `__send`，而其
  `tests/workflow-script-determinism.test.mjs:8-24` 的证据清单 C 项明写「禁令可经原型链
  上溯绕过、绕过后 run 照常 completed」。要彻底堵住得给每个注入函数套 `get`/`getPrototypeOf`
  双陷阱的 Proxy，代价是脆弱、且与 dwf 姿态分叉。
  **裁决：与 dwf 对齐，不单独加固。** 依据是子进程本来就不是安全边界
  （`dynamic-workflow-runtime/src/script-error.ts` 同款表述），真正的控制是 `RunWorkflow` 的
  `alwaysAsk` 确认门——脚本是模型写的、用户逐个批准过的。本项的实际收益是把「随手就能拿到
  Node」降级成「必须刻意构造原型链攻击」，并让两套系统姿态一致；不声称更多。
- **八个全局由外层 realm 构造后注入**，不在 realm 内定义。理由：`agent`/`parallel`/`pipeline` 依赖
  `AsyncLocalStorage`（`callPath` 铸造）与 `callParent`（stdio 请求），这些都是 Node 能力，
  必须留在外层；realm 内只拿到闭包句柄。这与 dwf 的 `__host` 注入是同一形状。
- 确定性禁令移进 realm 内施加（realm 有自己的 `Date`/`Math`，改外层的无效）。
  `Date.parse` / `Date.UTC` / `new Date(ms)` 继续保留——现有实现已刻意如此
  （`child-source.ts:149-154`），语义不变。
- `args` 必须在 realm **内**用 `JSON.parse` 构造，不能把外层对象直接塞进去：跨 realm 的
  intrinsics 不收敛会让 `args instanceof Object`、`Array.isArray` 之外的原型判定失效。
  dwf 侧同一约束见 `dynamic-workflow-runtime/src/child-source.ts:19-22, 156-161`。
- `child-source.ts:250-256` 那条自包含约束继续适用（内层函数一律不许有名字，因为 esbuild
  `minify + keepNames` 会给它们套模块作用域的 `__name` helper，只在压缩后的发布产物里
  ReferenceError）。这条**只能在真实打包形态下验证**，源码测试抓不到。

### R5 脚本投递改为落盘入口文件（修 Windows 命令行长度的硬矛盾）

- 不再把 `scriptBody` 经 argv 传递。改为把自包含入口写到磁盘再让子进程跑它，
  照 `dynamic-workflow-runtime/src/child-entry-file.ts:46-52` 的先例：落点
  `<cwd>/.acode/workflow-runs/<runId>.mjs`（目录自带 `.gitignore: *`），失败回落
  `os.tmpdir()/acode-workflow-runs/` 并经 `onWarning` 报一声。
- payload 里只留**小**字段（`args` / `budgetTotal` / `scriptUrl`），脚本正文由入口文件自持。
- 现有 `.acode/workflow-runs/` 目录已被 dwf 使用；两套共用同一目录但文件名不冲突
  （dwf 用 `<runId>.mjs`，其 runId 前缀是 `dwfrun_`，脚本工作流是 `wf_`）。共用是有意的：
  该目录已是 machine-owned + git-ignored，再开第二个目录只会多一处要清理的残骸。

### R6 与 dwf 的边界（两套独立，互不写对方状态）

| 维度 | dwf（现役） | 脚本工作流（本项复活） |
| --- | --- | --- |
| 工具 | `CreateWorkflow` 等十个 | `RunWorkflow` 一个 |
| 脚本语言 | TypeScript，编译期类型检查 | 纯 JavaScript，无类型检查 |
| 头部 | 禁止 `export`（脚本被包进函数体） | 必须以 `export const meta = {...}` 开头 |
| DSL | `agent(name,persona).ask<T>()` / `world.*` / `artifact.*` / `report()` | `agent(prompt,opts)` / `pipeline()` / `parallel()` / `budget` |
| 站点身份 | 编译期静态 site id × ordinal | 运行期 `callPath`（AsyncLocalStorage）+ `inputHash` |
| 执行面 | 子进程 + `vm.createContext` | 子进程 + `vm.createContext`（R4 之后一致） |
| 存储 | `dwf_run` / `dwf_actor` / `dwf_node` / `dwf_event` | `workflow_activity` + `ScriptWorkflowRunRecord`（`kind:"script"`） |
| 事件 | `dynamic_workflow_run_progress` | `script_*` 前缀 |
| runId | `dwfrun_*` | `wf_*` |

- 事件命名早已为共存做过隔离：`contracts/src/events/session.events.ts:141-142` 明写
  「命名刻意带 `dynamic_`：legacy `Workflow` 工具的 script run 事件（`workflow_started` /
  `workflow_completed`）是另一套日志，同名会真的混淆」。本项不改这条边界。
- **路由必须在工具描述与技能里写清两者的分工**，否则模型会在 `CreateWorkflow` 与 `RunWorkflow`
  之间乱选。判据用**用户措辞**而不是任务形状：`/workflow` 或「用工作流」→ dwf；
  `/ultracode` 或「ultracode」关键词 → 脚本工作流。这与 dwf 技能既有的
  「只有显式请求才启动工作流」规则同构。

### R7 灰度与注册门（与 dwf 共用同一道可用性开关）

- `RunWorkflow` 受**同一个** `includeDynamicWorkflow` 门控：该选项的语义是「这个客户端有没有
  动态工作流能力」，不是「有没有 dwf 那十个工具」。两套系统一开一关会让 UI 入口、
  命令目录与工具面出现不一致。
- 极性必须与 dwf 一致：**只有显式 `false` 才下架**（缺席 = 调用方不参与灰度，保留工具面）。
  `embedded-search-branch.ts:31-38` 记录了极性搞反的事故——那个入口省略选项会把首次装配
  剃掉的工具原样加回来，且 `silentDuplicateWarnings` 吞掉告警。
- 门控名单从 `core/src/tool/handlers/index.ts` 抽出到同目录新文件
  （如 `workflow-tool-names.ts`）。理由不只是整洁：该文件当前 **400 行**，正卡在
  `architecture-policy.yaml` 的 `maxFileLines: 400` 上，任何新增都是「只减不增」ratchet 的
  逆行。抽出后 `index.ts` 降回上限内。
- `DYNAMIC_WORKFLOW_TOOL_NAMES` 的名字与语义**保持不变**（它就是 dwf 那十个）；新文件里另设
  一个包含两者的门控集合，注释写清「十个是 dwf 的，一个是脚本工作流的，共用一道开关」。
- headless `-p` 的既有策略不变（`cli/src/prompt-command.ts:221` 按 `--enable-workflow` 显式开关），
  两套一致。

### R8 技能与技能门

- 新增内置技能（`bundled-skills/skills/<name>/SKILL.md`）承载编写契约：`export const meta`
  纯字面量规则、八个全局的签名与语义、`pipeline()` 默认 / barrier 需论证、并发与总量上限、
  确定性禁令、resume 的 `(prompt, opts)` 缓存语义、worktree 隔离的成本提示、
  以及**与 dwf 的分工判据**（R6）。
  内容按契约语义**重写**，不逐字复制外部逆向语料（仓库有 `NOTICE.md` /
  `THIRD-PARTY-NOTICES.md` 合规约束）。
- 技能门照 `core/src/tool/handlers/workflow-skill-gate.ts` 的既有形状：会话内未成功加载该技能前，
  带 `script`/`scriptPath` 的调用被拒（错误码沿用 428，与入参级 400 分开）；
  按 `name` 跑已保存的工作流**免技能**（与 dwf 的例外同构，`workflow-skill-gate.ts:43-49`）。
- `bootstrap/src/app/dynamic-workflow-gate.ts` 的 `collectDynamicWorkflowDisabledSkillPaths`
  要把新技能一并纳入剔除，否则灰度关时技能仍在目录里指向不存在的工具
  （该文件 `:6-8` 的分工注释与 `create-app.ts:902-903` 的理由注释说的就是这件事）。
- 技能包完整性门（`bootstrap/src/app/bundled-skills.ts:30-38` 的
  `BUNDLED_SKILL_PACK_REQUIRED_PATHS`）按「不连坐」纪律**不**加入新技能路径——
  既有测试 `bundled-research-review-skills.test.mjs:137,170` 与
  `bundled-verify-run-skills.test.mjs:153` 钉住了这一点。

### R9 失败语义（fail-loud，绝不静默降级）

- 脚本解析失败、meta 非纯字面量、meta 缺失 → 结构化错误回给模型，**不启动 run**。
- 沙箱内逸出尝试（realm 里没有的东西被引用）就是普通 `ReferenceError`，照常 fail-loud；
  **不**加白名单兜底。
- 子进程非零退出且无 `complete` 消息 → 抛错并带 stderr 尾部（现有
  `script-workflow-process.ts:101-111` 已如此，保持）。
- `workflow()` 嵌套继续抛「reserved for a later version」（`:253`）。本项**不**实现嵌套；
  技能里必须写明不支持，不留模糊。
- 名单副本已消掉（实现决定回写 2026-10-07）：`OFF_PEAK_MUTATION_TOOL_NAMES` 与
  `AUTOMATION_MUTATION_TOOL_NAMES` 都以 `core/src/runtime/methods/turn-loop-state.ts` 为
  唯一所有者，经 `core/src/index.ts` 导出，bootstrap 的两个消费方改为 import。
  原来 R3 表格第 5 项写的是「本项不顺手合并」，实施时改了主意：为 `RunWorkflow` 同时改三处
  的过程本身就是「下次一定有人漏一处」的证据，而合并只是一次常量搬家 + 两处 import，
  风险低于继续留着。`tests/run-workflow-tool.test.mjs` 的 R3#5 现在断言的是**单一所有者**
  （bootstrap 两个文件不得再出现名单字面量），而不是「三份同值」。

### R10 ultracode 关键词触发（批次 C2）

> 实施顺序说明：本条是**先实现后补写**的（`runtime/helpers/ultracode-keyword.ts` 与
> `tests/ultracode-keyword.test.mjs` 先落地）。记在这里是为了让规格与代码一致，
> 不是假装它先于实现存在。

- **触发面**：用户在**普通 prompt** 里打出整词 `ultracode`（大小写不敏感），即视为本轮显式
  选择脚本工作流编排。harness 判定并注入一条 system-reminder 明确告知模型，模型不必自行
  揣测「这算不算显式要求」——`RunWorkflow` 的工具描述要求显式 opt-in，而模型判断显式与否
  的唯一依据就是用户措辞，把这件事从揣测变成 harness 的事实陈述。
- **整词而非子串**：`ultracode` 会作为子串出现在别的词里（如某项目自己的 `ultracodegen`）。
  误判方向是不对称的——多起一次编排是真实的钱与时间，漏起一次只是用户再说一遍。
- **排除斜杠命令形态**（`/ultracode`）：`expandCustomCommandPrompt` 生成的前言里有一行
  `Run custom command /ultracode.`，那是 **harness 写的**，不是用户措辞。不排除的话，
  一次 `/ultracode <任务>` 会额外注入一条声称「用户在自己的消息里打了这个词」的 reminder
  ——既重复（展开正文已指示工具与技能），又对来源说谎。匹配规则用负向后顾只吃掉紧跟
  斜杠的那一次出现；用户在参数里自己打的词照常命中（那次确实是他打的）。
- **生命周期 = per-request 动态段，不落 session**。source `ultracode_keyword` 进
  `SYSTEM_REMINDER_PER_REQUEST_SOURCES`、**不进** `SYSTEM_REMINDER_PERSISTED_SOURCES`，
  与 `memory_semantic_recall` 同款：正文完全由当轮用户文本派生，冷恢复后下一 turn 重新判定
  即可。持久化会把「某轮的措辞」伪装成「会话事实」。
- **注入点**：`runtime/methods/turn-loop.ts`，与语义召回同一处、同一条件
  （`!outputTokenRecoveryActive && state.modelStepCount === 0`）。turn 内后续 step 是工具
  循环、用户文本不变，重复判定只会重复注入同一条。
- **与灰度门同结论**：`dynamicWorkflowEnabled === false` 时不注入。此时十个 dwf 工具与
  RunWorkflow 都不注册，注入等于把模型指向一个不存在的工具——技能面与命令面做的是同一件事。
- **正文三件必需的事**：说清是用户的措辞触发的（不是 harness 自作主张）；点名 `RunWorkflow`
  并劝退 `CreateWorkflow`（两套系统，说「用工作流」等于让模型掷骰子）；提醒先加载
  `script-workflows` 技能（否则白跑一次被技能门拒掉的调用）。另外必须声明**只限本轮**——
  不说清，模型会把一次关键词当成整个会话的授权。
- **未做：会话级常开**。参考产品用一个 10 分钟 sticky 窗口把「打一次关键词」升级成
  「接下来一段时间每轮默认起编排」。本项不实现：那需要一份带过期时间的会话态，而它的
  所有者、与 compact/rewind/冷恢复的交互、以及退出路径都得先定清楚。一份没人拥有、
  恢复语义不明的计时器比没有这个功能更糟。若要做，`/ultracode on|off` 的显式开关
  （照 `/goal pause|resume|clear` 的先例）比计时器更可控。

### R11 聊天卡渲染（批次 C3）

- `RunWorkflow` 有自己的渲染器（`packages/ui/src/ToolCallBlocks/renderers/run-workflow.tsx`），
  经 `lib/workflowToolNames.ts` 的 `isRunWorkflowToolCall` **按名**在 family 分流之前认领。
- 只从工具的入参与出参渲染，**不新增协议面**：dwf 那些卡靠 `ToolResultDisplayPayload` 与
  run 投影驱动，而给这套系统加 display kind 等于往闭集枚举里塞值——那是破坏性偏斜，需要
  capability 握手，不值得为一张卡付。入参 + 出参已足够回答用户真正会问的四件事：
  跑了哪个工作流、run 什么状态、脚本在哪、启动回执说了什么。
- 卡上额外区分**脚本来源四态**（内联 `script` / 文件 `scriptPath` / 预定义 `name` /
  续跑 `resumeFromRunId`），优先级与契约的「scriptPath takes precedence」一致。
  用户批准的是「跑这段脚本」还是「跑那个存好的工作流」是两件不同的事，卡上必须看得出来。
- i18n 用独立命名空间 `chat.toolCall.scriptWorkflow.*`（13 键，zh-CN 与 en-US 键集逐字对齐）。
  不复用 `chat.toolCall.workflow.*`：那些键描述的是 dwf 的因果图 / run 投影 / 产物，
  这套系统一个都没有，共用前缀会让键名承诺渲染不出来的东西。
- 守护测试 `packages/ui/test/runWorkflowRenderer.test.ts`：按名判定认得几种 wire 写法、
  不误认另一套系统的工具与死名 `Workflow`、**不**登记进 tool-identity、
  以及 resolveRenderer 里按名分流排在 family 分流之前（顺序就是这条不变量的全部）。
- **确认窗也必须有专用块**（`packages/ui/src/ScriptWorkflowPermissionBlock.tsx`），
  这一条比聊天卡更要紧：`RunWorkflow` 是 `alwaysAsk`，而 R4 把「沙箱没有全关、真正的控制
  是确认门」写成了安全论证的落点。落到通用 fallback 的话，fallback 会把整包 toolCall JSON
  摊开（`PermissionDialog.tsx` 里 MCP 与 WebFetch 两条注释记录的就是同一个坏法，两处都专门
  修过），脚本变成 JSON 转义串——一个读不了脚本的确认窗等于那道控制形同虚设。
- 确认块的分流必须**早于文件摘要启发式**：RunWorkflow 的入参带 `scriptPath`（一个路径）
  与完整 `script`，「看起来像写文件」的启发式会把它吸进 edit 块，而 edit 块讲的是改哪几个
  文件、diff 长什么样，对「批准运行这段编排脚本」是错的语言。`SaveWorkflow` 早已因此排在
  最前，同款理由。
- 与聊天卡的一处刻意差别：聊天卡把脚本放可折叠的 `<details>`（历史留档，折叠合理），
  确认块**不折叠**，长脚本走段内滚动。确认窗的既有纪律是「不提供收起/展开交互，避免用户
  把关键内容藏起来」，而脚本是这个请求里唯一关键的内容。
- 按 `scriptPath` 批准时必须说明「批的是文件当前内容、之后仍可能被改（手改 / git pull /
  别人提交），而每次运行都会重读」——与 dwf 的 `alwaysAsk` 注释里那条论证同源：
  「上次批准过这个名字」推不出「这次要跑的还是那段代码」。
- 确认块 i18n 用 `chat.permission.scriptWorkflow.*`（12 键）。两个命名空间合计 25 键，
  zh-CN 与 en-US 键集逐字对齐（已核）。

### R12 实时进度：翻译进 dwf 投影，而不是另建一套（批次 C4）

- **裁决：翻译，不新建。** dwf 的 `workflowRuns` 投影、共享 reducer、时间线卡与状态面板是
  一整套已经打磨过的东西，而 TUI 与桌面**共用同一个 reducer**（两端不可能算出不同状态）。
  脚本工作流的十二种事件里十一种能干净映射到 dwf 的 eventType 词表，于是翻译一遍就白拿
  这批渲染。另建一套投影等于第二份状态与第二组渲染组件，正是 AGENTS.md 反对的
  「重复状态和多条写入路径」。
  ⚠ 但**不是整套都能白拿**：详情侧栏的主体与 run 目录各有脚本 run 拿不到的前提，
  见下方「R12 的已知边界」。
- 映射表（`bootstrap/src/app/script-workflow-progress-adapter.ts` 文件头有同一份）：
  `workflow_started→run-started`、`script_phase→phase-entered`、`script_log→log`、
  `activity_started→actor-created + node-dispatched`、`activity_completed→node-settled{ok}`、
  `activity_failed→node-settled{failed}`、`activity_cached→node-settled{ok,cached}`、
  `workflow_usage→usage-updated`、`workflow_completed→run-settled{completed}`、
  `workflow_cancelled→run-settled{stopped,user}`、`workflow_failed→run-settled{errored}`。
  只有 `entry_file_fallback` 真无对应物（它是宿主环境告警，走 `onWarning` 落 warn 日志）。
- **`script_log` 有对应物**（此前记错了，已修）。`log` 不在 reducer 的 switch 里——它不改
  任何表——但它是**信封**词表的一员，被两端各自消费：TUI 的 `appendWorkflowLogTail`
  （`app-workflow-mirror.ts`）截一条尾巴挂在卡上，桌面 `workflowRunPanel.ts` 的 `case "log"`
  渲染成一行时间线。丢弃它的后果是卡片的日志区对脚本 run 永远空着，而 `log()` 是技能里
  写明的八个全局之一。空白消息在适配器就丢掉：两端都会把折叠后为空的行扔掉，发过去只是
  白吃一个序号，而序号必须与实际发出的信封一一对应。
- **三条终态词必须分开**：reducer 的终态闭集是 `completed / errored / stopped`，而
  `stopReason` 只在 `stopped` 时搬运，渲染侧按这两个字段决定颜色与文案。
  用户取消（TaskStop / Esc）走 `workflow_cancelled → stopped + stopReason:"user"`，
  与 dwf 的 `settleStopped(state, "user")` 同一笔语义；折进 `errored` 会让用户看到
  「脚本崩了」而不是「你停的」。存储侧同步写 `cancelled`——这个词本来就在
  `SCRIPT_WORKFLOW_RUN_STATUSES` 里，tool port 的 `workflowTaskStatus` 与终态判定也早就认它，
  只是从来没被写过。判据只认 **run 级** signal：`runAgent` 里 per-agent 超时用的是
  `mergedSignal` 合出来的另一个 signal，那种情况是货真价实的失败，不能算用户取消。
  这条判据成立的**前提**是「run 级 signal 被中止」就等于「用户主动停止」——它确实成立：
  tool port 为每个 run 自己铸一个 `AbortController`（`script-workflow-tool-port.ts:102`），
  交给 runtime 的是 `runAbortController.signal` 而**不是**工具的 `context.abortSignal`；
  那个控制器只被 `cancel(taskId)` 中止（TaskStop / `/dwf cancel` / 桌面 Cancel 三个入口
  同一条路）。这也正是技能 §11「取消你这一轮不会取消 run」的实现依据。
  若哪天把 run 接到轮信号上，每次轮结束都会被记成用户取消——这条前提必须与判据一起改。
  取消不记 `failure`（abort reason 恒为「被取消」，记下来只会把主动停止报成带错误的失败）。
  取消**不带 `resumable`**：脚本工作流确实能按 `resumeFromRunId` 续跑，但那是模型经
  RunWorkflow 走的路，用户面前没有对应命令，亮一个按不动的 Resume 比不亮更糟。
- **`usage-updated` 携带累计总量而不是增量**（reducer 直接覆写 `usage.spentTokens`）。
  发信点是 `writeRunStats`——那笔「读 run → 加 delta → 写回」原先是裸的，中间夹两个 await，
  而 `parallel()` / `pipeline()` 下多个 agent 会并发走到这里：两次调用读到同一个旧值，
  后写的把先写的增量整个覆盖掉，`budgetSpent` 与 `stats` 双双少计。少计本身已是错，
  投影上去用户还会看见 token 数**往回跳**。修法是按 runId 串一条 promise 链
  （`statsWrites`，与 `agentCallCounts` 同一个结算点清项），链上存吞掉失败的版本，
  一次写失败不堵死后续。
- **终态词必须对齐**：dwf 用 `errored`，脚本工作流自己的表用 `failed`。翻译时换词，
  否则闭集校验会把整帧丢掉——那是静默失败，UI 只会永远停在 running。
- **节点身份用 `callPath` 当 `siteId`、`ordinal` 恒 0**：callPath 本身就是这次调用的唯一
  身份，且与 resume 缓存键同源，于是不会出现「缓存认得、投影认不得」的裂缝。ordinal 恒 0
  是因为一次 `agent()` 就是一个子会话一条活动，没有 dwf 那种「同一 actor 上多次 ask」。
- **子代理会话 id 挂信封顶层，不是 payload 里。** reducer 只从 `envelope.actorSessionId`
  取（→ `derived.actorSessionId` → `workflowActorEntry`），契约注释也明写它是「payload
  **之外**的派生字段」，dwf 侧同样挂在顶层。挂错的后果很隐蔽：名册上有名字、点进去没有
  转写（侧栏 `handleOpenActor` 读 `instance.sessionId`）。`node-dispatched` 也要带一份——
  reducer 在派发那一刻会用它重铸 actor 条目（`dispatchActor`），于是 `actor-created`
  因表满被拒时，派活仍能连人带活回到表上。
- **结算事件只在「从没 started 过」时补一条 `actor-created`**。两种情况需要补：
  cached（缓存命中直接返回，`activity_started` 根本不会发）与 failed（失败可能发生在
  子会话铸造之前，例如 worktree 建不起来）。不补的后果是节点坐上了表、名册上却没有这个人
  ——时间线出现「有活没人干」。
  **已经 started 过的绝不能再补**：reducer 的 actor upsert 是**整条替换**而不是字段合并
  （`workflowActorEntry` 每次造一个全新对象，`sessionId` 缺席就是键缺席），而补发那条不带
  `actorSessionId`（子会话 id 只在 `activity_started` 的载荷里），于是它会把 started 带来的
  sessionId **抹掉**。每个正常起跑又结算的 agent 都会中招——名册上一个能点开转写的都没有。
  实现按实例身份去重（`RunProjectionContext.announcedActors`，随 `forgetRun` 清）。
  这条是端到端测试跑出来的：手写夹具把 started 与结算分成两个用例，各自都绿，
  合起来才暴露——所以 `script-workflow-projection-e2e.test.mjs` 必须存在。
- **事件载荷必须自带投影所需的事实**（`callPath` / `label` / `phase` / `childSessionId`）。
  原来只带 `activityId`，而按 id 回查 store 是每条事件一次异步读，既有开销又有竞态。
  追加键对既有消费者无害（它们只读 activityId）。
  实现上有一处坑：`activity_started` 等三处在 `runLiveAgent` 里，而 `callPath`/`phase`
  的局部绑定属于调用方 `runAgent` 的作用域，必须取 `activity.callPath` / `activity.phase`
  （记录才是持久化的真值）。
- **`dialect` 判别字段**随 `run-started` 载荷到达，落在 `workflowRunSchema` 上，
  **缺席即 `"dwf"`**（所有既有 run——老 CLI 发的、journal 冷回放的——都没有这个键，
  而它们全是 dwf 的）。追加可选字段是本 schema 既定的偏斜安全做法（lineage 两端同款理由），
  不是往闭集枚举里加值，后者才是破坏性偏斜。闭集之外的值一律当没说，免得一个拼错的
  字符串让侧栏按未知方言门掉全部动作。
- **方言门住在两个谓词里，不住在调用方**（`isWorkflowRunConfigurable` /
  `isWorkflowRunResumable`）。`resumeWorkflowRun` 与 `amendWorkflowRunSettings` 打到脚本
  工作流的 run 上必然失败（两套各有自己的存储、端口与 run 语义），摆出点了报错的按钮比
  不显示更坏——它读起来像「这里能恢复」。
  这条是**修一个真实缺陷**得来的：门原先只叠在 `WorkflowRunSidePane` 一个调用方里，而会话
  里的轮尾摘要卡（`ConversationWorkflowDigests`）走的是裸的 `isWorkflowRunConfigurable(run)`
  ——一条正在跑的脚本 run 于是拿到「配置」按钮，点下去发 dwf 命令必然被拒。摘要卡是内联在
  对话里的那一面，比侧栏更常被看见。搬进谓词之后调用方无从漏叠。
  对 Resume 而言方言门是**另一根轴**，不是对可恢复性的二次推导：`resumable` 答「这条 run
  能不能续」，方言答「这个按钮发出去的那条命令能不能续它」。
  **Cancel 不门**：它走 `cancelBackgroundWork`（workId ≡ runId），对两套都成立；
  门掉它等于把缺口 8 修好的东西再弄坏一次。
- **两端都要能看出跑的是哪套系统**（方言徽标）。共用一张卡之后，不标出来用户既无从分辨，
  也无从理解为什么某些动作缺席。徽标只挂在 `dialect === "script"` 上：dwf 是缺省方言，
  给每条既有 run 都挂一枚只是噪音，还会让老 journal 冷回放出来的卡凭空变样。
  桌面挂在状态头题名旁（`WorkflowRunSidePaneSections.tsx`，tooltip 说明「配置」与 Resume
  为什么缺席）；TUI 经 `TuiWorkflowCard.dialect` 透到 `collapsed` 文案——`cardFromRun` 是
  **逐字段**搬运而不是展开 run，投影里新增的键会被它静默丢掉，`dialect` 正是这么丢过一次。
- **进度汇只造一份**：dwf run service 与本适配器共用同一个
  `createDynamicWorkflowRunProgressSink` 实例。两份就有两条 append 路径，而身份闸门 /
  runtime 未就绪 / append 失败这三条降级语义（连同单测）都住在那个汇里。
- **观察面绝不影响 run**：适配器的调用点包 try/catch，失败只记一条 warn。这与 dwf 进度汇
  「永不抛异常、永不返回 rejected promise」是同一条纪律。
- **序号每 run 各自单调递增**，run 结算即清项。这与 agent 计数同款道理（R9 缺口 10 记的
  就是把它做错的下场）。丢弃的事件**不消耗序号**。

#### R12 的已知边界（诚实声明）

**1. 只有运行期实时可见，冷恢复后从投影里消失。** dwf 的投影有两条来源：实时事件，以及冷启动
时从 dwf journal 回放（`dynamic-workflow-run-introspection.ts` 的 replay + TUI 的
`app-workflow-seed.ts`）。脚本工作流的 run 不在那份 journal 里——它有自己的 `workflow_activity`
与事件表。所以进程重启后，历史脚本工作流 run 不会出现在这套投影中；它们的真相仍在自己的表里，
`scriptWorkflowStatus` / `listScriptWorkflows` 照旧能查。要补冷恢复需要给回放路径加第二个来源。

**2. run 目录里没有脚本 run。** `WorkflowRunDirectorySidePane` 的清单来自
`useWorkflowRunJournalSummaries`——一条查 dwf journal 的 RPC，不是 `workflowRuns` 投影。
脚本 run 不在那份 journal 里，所以目录页看不见它们。（批次 C4 的报告曾把 run 目录列为
已白拿的渲染面，那是过度声称，此处更正。）

**3. 详情侧栏的主体渲染不出来。** 侧栏的阶段清单与摘要行走的是
`buildWorkflowTimeline(graph, run)`，而 `graph` 是**静态因果图**，按发起 toolCallId 从
`CreateWorkflow` 工具行的元数据里取（`resolveWorkflowRunGraph`）。脚本工作流不编译、
不做静态分析，`RunWorkflow` 的工具行上没有图，于是 `graph === undefined` → 主体退化成
「当前会话的可见历史里没有这张工作流图」。状态头（含方言徽标）、结果区与产物区照常渲染。
会话里的轮尾摘要卡同源同症（`WorkflowRunDigest` 也吃 `digest.graph`）。
要补需要一个**动态**时间线渲染路径（从投影的 `nodes[]` / `actors[]` 直接出），
或给脚本工作流做静态分析——两者都超出「只做实时进度」这一档。

**4. 实际拿到的渲染面**（与上面三条对照，说清楚到底有什么）：会话状态面板
（`ConversationStatusPanel` 的在飞工作流行，读投影、不要图）、TUI 的实时工作流卡
（状态 / 步数 / 名册 / 日志尾巴 / 用量 / 结果 / 错误，全部不要图）、以及
`workflowRuns` 投影本身。

## 状态所有者

```
用户 / 模型
   │  RunWorkflow({script | scriptPath | name, args?, resumeFromRunId?})
   ▼
core/tool/handlers/run-workflow.ts      ← 唯一工具入口；技能门在此
   │  port.start(request)
   ▼
bootstrap/app/script-workflow-tool-port.ts  ← WorkflowPort 唯一实现
   │
   ├─ script-workflow-meta.ts        meta 提取 + scriptHash（唯一所有者）
   ├─ script-workflow-runtime.ts     run 生命周期 + resume 缓存裁决（唯一所有者）
   │     │
   │     ├─ script-workflow-process.ts   子进程 + NDJSON（唯一所有者）
   │     │     └─ 入口文件落盘（R5）
   │     │           └─ vm realm（R4）  ← 脚本体唯一执行处
   │     └─ workflow-worktree-manager.ts  worktree 生命周期（S1，唯一所有者）
   │
   └─ ScriptWorkflowStorePort → adapters/.../script-workflow-*.ts
                                    （workflow_activity 表唯一写入方）

dwf 一侧完全独立：CreateWorkflow → dynamic-workflow-run-* → dwf_* 表
两套之间**没有任何共享可变状态**；共享的只有「可用性开关」这一个只读判定（R7）。
```

- `callPath` 的唯一铸造点：子进程内的 `AsyncLocalStorage`（`child-source.ts:52-64`）。
  父进程只消费，不重新推导。
- `inputHash` 的唯一算法：`script-workflow-meta.ts:51` 的 `stableHash`。
- run 状态机的唯一写入方：`script-workflow-runtime.ts`。

## 接口

新增：

```ts
// contracts/src/tools/workflow.ts
export const RUN_WORKFLOW_TOOL_NAME = "RunWorkflow";

// core/src/tool/handlers/run-workflow.ts
export const runWorkflowToolEntry: ToolEntry;

// core/src/tool/handlers/workflow-tool-names.ts（从 index.ts 抽出）
export const DYNAMIC_WORKFLOW_TOOL_NAMES: ReadonlySet<string>;  // dwf 十个，语义不变
export const GATED_WORKFLOW_TOOL_NAMES: ReadonlySet<string>;    // 十个 + RunWorkflow
```

改动（签名不变，只改实现）：

```ts
// bootstrap/src/app/script-workflow-process.ts
// spawn 参数从 ["--input-type=module","--eval",CHILD_SOURCE,"--",payload]
// 改为落盘入口文件路径；payload 不再含 scriptBody
export async function runScriptWorkflowChild(input: {...}): Promise<ScriptWorkflowChildRunResult>;
```

`WorkflowPort` / `WorkflowInputSchema` / `WorkflowOutputSchema` / `ScriptWorkflowStorePort`
的形状**不变**（R1：兑现既有契约）。`WorkflowInput` 等无前缀类型名继续由 legacy 契约占用，
新代码不得再引入同名的第二份定义。

## 已知边界（诚实声明）

1. **无静态分析**。dwf 有 50 个文件的 AST 分析（因果图、taint、fan-out 基数、facade 误用）；
   脚本工作流没有。后果：确认窗无法展示因果图，`parallel()` 里的具名冲突只能在运行期发现。
   本项不补。
2. **无 typed schema 合成**。`agent(prompt, {schema})` 的 schema 是模型手写的 JSON Schema，
   运行期校验；dwf 那边是从 TS 类型合成 + `submit_result` 强制。
3. **resume 缓存只在同一 runId 内**。`findCachedScriptWorkflowActivity` 的 where 子句带
   `run_id = ?`，跨 run 的「最长未改前缀」要靠 `resumeFromRunId` 复用同一行
   （`script-workflow-prepare.ts`）。dwf 的 amend-resume（新 runId + 导入缓存）语义更强，
   本项不对齐。
4. **`workflow()` 嵌套仍是桩**（R9）。
5. **死名 `Workflow` 继续留在 `provider-visible-order.ts:27`**，由 `LEGACY_TOLERATED` 容忍。
   按「死名永不回收」纪律不清理。
6. **`budgetTotal` 的来源未定义**。契约与子进程都支持它，但没有「用户 +500k 式指令 → budgetTotal」
   的解析路径，因此 `budget.total` 实际恒为 `null`、`remaining()` 恒为 `Infinity`。
   技能里必须写明这一点，否则模型会写出永不终止的 `while (budget.remaining() > N)` 循环。
7. **`budget.remaining()` 的 `Infinity` 过不了线**。run 的返回值经 JSON 序列化过 stdio，
   而 `Infinity` 不是 JSON 字面量，`return { left: budget.remaining() }` 到达调用方是
   `{ left: null }`。realm **内**的比较运算照常工作，受影响的只是交回的值。技能 §8 已写明。
8. **工具输出的 `status` 枚举仍是三值**（`backgrounded | completed | failed`）。它与 dwf 的
   `CreateWorkflow` / `AmendWorkflow` / `ResumeWorkflowRun` 以及 `BashOutput` 共用同一个
   `WorkflowOutputStatusSchema`，为一次取消往这个共享枚举里加 `cancelled` 不成比例。
   于是取消的 run 在**枚举位**上仍报 `failed`，而模型真正读的那段 `response` 文本来自
   `formatScriptWorkflowRun`，它印的是存储里的真词（`workflow cancelled · <name>`）。
   存储与投影两处都是 `cancelled` / `stopped`，只有这一枚粗粒度枚举位不对齐。
9. **详情侧栏与轮尾摘要卡的主体渲染不出来**（静态因果图是前提，脚本工作流没有）。
   详见 R12 已知边界第 3 条。
10. **run 目录里没有脚本 run**（清单来自 dwf journal 的 RPC，不是投影）。
    详见 R12 已知边界第 2 条。

## 验收场景

1. `RunWorkflow({script})` 提交一段合法脚本（含 `export const meta`）→ 编译/解析通过 →
   后台启动 → 返回 `{status:"backgrounded", runId: /^wf_/, backgroundTaskId, scriptPath, traceId}`。
2. 缺 meta 头 / meta 非纯字面量 / meta 不是第一条语句 → 结构化错误，**不启动 run**，
   错误文案指明是哪一条。
3. 五个入参全缺 → superRefine 报错（契约 `:60-66` 既有行为）。
4. `scriptPath` 与 `script` 同时给 → `scriptPath` 优先（契约 `:52` 既有语义）。
5. **沙箱：已关闭的逸出面确实关闭**（R4）：脚本体里分别尝试 `typeof process`、
   `globalThis.Buffer`、`require("node:child_process")`、`await import("node:fs")`、
   `Function("return process")()` → 全部拿不到 Node 能力（`undefined` 或
   `ReferenceError`/`TypeError`），run 以错误结算。
5a. **沙箱：已知的残余逸出面如实记录，不假装关闭**（R4）：
   `agent.constructor.constructor("return process")()` 这类经注入函数的原型链上溯**仍能**拿到
   外层 realm 的 Node 全局。测试把这条钉成「已知且与 dwf 同姿态」，而不是钉成失败——
   否则下一个人会以为它被堵住了。真正的控制是 `alwaysAsk` 确认门。
5b. 上述两条必须在真实打包/压缩形态下也跑一次（R4 的 `__name` 约束只有压缩产物能暴露）。
   （编号用 5/5a/5b 而不顺延，是为了不打乱下面既有场景的编号引用。）
6. 确定性禁令在 realm 内生效：`Date.now()` / 无参 `new Date()` / `Math.random()` 抛错；
   `Date.parse(x)` / `Date.UTC(...)` / `new Date(ms)` 正常。
7. **512KB 脚本能跑**（R5 的核心断言）：提交一个接近 `WORKFLOW_SCRIPT_MAX_LENGTH` 的脚本，
   在 Windows 上 spawn 成功。改动前这条必然失败（argv 32767 上限）。
8. `parallel([...])` 的 N 个 agent 各自拿到唯一 `callPath`（`root/parallel0/item<k>/agent<j>`），
   resume 时同 `callPath` + 同 `inputHash` 命中缓存、`status` 记为 `cached`。
9. `pipeline(items, s1, s2)` 无 barrier：慢 item 的 s1 不阻塞快 item 的 s2
   （以事件到达顺序断言）。
10. `budget.total` 为 `null` 时 `remaining()` 返回 `Infinity`；`spent()` 随 agent 结算递增。
11. `workflow()` 抛「reserved for a later version」（R9，桩语义不变）。
12. `isolation: "worktree"` 的 agent 在独立 worktree 里跑，S1 的 10 个测试继续绿。
13. 灰度关（`includeDynamicWorkflow === false`）→ `RunWorkflow` 与 dwf 十个工具**一起**下架；
    缺席 → 一起保留（R7 极性）。
14. 未加载技能时带 `script` 的调用被拒（428）；按 `name` 跑已保存工作流免技能（R8）。
15. 后台任务面：`RunWorkflow` 的 run 被映射成 `local_workflow`；旧会话 rollout 里的
    `"Workflow"` 名字**仍能**正确映射（R3 #2 的向后兼容）。
16. UI：`RunWorkflow` 的工具调用落 `FallbackToolCallBlock`（raw JSON），**不**落 dwf 的
    CreateWorkflow 卡（R3 补注）。这条断言的是「不说谎」，不是「好看」；专用渲染器在批次 C。
17. **TaskStop 能真的停掉一个在飞的 run**：`WorkflowPort.cancel(taskId)` 对在飞的 run 返回
    `true` 并触发其 AbortController；对未知/已结算的 taskId 返回 `false`。
    `background-tasks.ts` 的 `cancellable` 按端口实况报（`typeof port?.cancel === "function"`），
    端口没有 cancel 时必须是 `false`——否则 TaskStop 会答应一件做不到的事。
18. **resume 并发守卫**：对一个尚未结算的 `resumeFromRunId` 再次 `start` → 抛错，文案点名
    「has not exited yet」与「先 TaskStop 或等它结束」，**不启动第二份 run**。
    判据复用 `completionSnapshots`（run promise 未结算即在飞），不另立第二份运行态。
19. 启动返回的 `response` 只点名真实存在的通道（完成通知 / TaskOutput / TaskStop /
    编辑 scriptPath 后重调），**不含** `/workflows`——ACode 没有这个命令。
20. **dwf 零回归**：`dynamic-workflow` / `dynamic-workflow-runtime` 两个包的源码 diff 为空；
    `workflow-script-determinism.test.mjs`（18）与 `workflow-budget-fuses.test.mjs`（24）继续绿。
21. `provider-visible-order-hygiene.test.mjs` 继续绿：`RunWorkflow` 走 `registered.has(name)`，
    `Workflow` 走 `LEGACY_TOLERATED`。
22. 架构：`core/src/tool/handlers/index.ts` 行数**下降**（R7 抽出名单），
    `pnpm architecture:check --changed` 新违规 0。
23. **验证命令**（从仓库根执行，如实记录结果）：`pnpm typecheck`、`pnpm lint`（期望 0 error）、
    `pnpm architecture:check --changed`（期望 new 0）、
    `pnpm --filter acode-cli test`（当前 981，新增后应更多且 0 fail）、
    `pnpm registry:check`（动了工具描述/schema）、
    `pnpm prompt-manifest:check`（动了技能与工具描述）。

### 批次 C5（R12 的缺陷修复）

24. **子代理会话 id 落到投影里**：`activity_started` 带 `childSessionId` 时，信封的
    **顶层** `actorSessionId` 在场（payload 里那份必须缺席——reducer 读不到它），
    且经真 reducer 归约后 `run.actors[0].sessionId === childSessionId`。
    `node-dispatched` 也带一份（reducer 的 `dispatchActor` 会在派发时重铸 actor 条目）。
25. **用户取消不是脚本故障**：`workflow_cancelled → run-settled{status:"stopped",
    stopReason:"user"}`，归约后 `run.status === "stopped"`、`run.stopReason === "user"`、
    `run.resumable !== true`。runtime 侧写存储 `status: "cancelled"`、**不写** `failure`，
    且判据只认 run 级 `options?.abortSignal?.aborted`（per-agent 超时的 `mergedSignal`
    中止不算取消）。
26. **`script_log` 进投影**：非空消息 → `log` 信封、payload 只有 `message`（phase 不搬，
    dwf 的 log 行不带相位）；空白与缺席的消息**不发信封也不吃序号**。
27. **用量是累计总量**：两条 `workflow_usage`（1200、5000）→ 两条 `usage-updated`，
    归约后 `run.usage.spentTokens === 5000`（不是 6200——reducer 覆写而非累加）。
    非数字 / 缺席 / `Infinity` 一律不发信封。runtime 侧那笔读改写按 runId 串行
    （`statsWrites` promise 链），且落库排在投影之前，结算点清项。
28. **方言门只有一个所有者**：`isWorkflowRunConfigurable` 与 `isWorkflowRunResumable`
    对 `dialect === "script"` 的 run 一律 false——**哪怕它正在跑、哪怕 `resumable` 位在场**；
    对 `dialect` 缺席与 `"dwf"` 照旧（翻错这一位会让全仓库既有 run 一起失去「配置」）。
    `isWorkflowRunCancellable` 对两套都 true（缺口 8）。`WorkflowRunSidePane` 不再自己
    重推导一遍方言。
29. **两端都看得出跑的是哪套系统**：桌面状态头在 `run.dialect === "script"` 时挂徽标
    （tooltip 解释「配置」与 Resume 为什么缺席），TUI 卡经 `TuiWorkflowCard.dialect`
    透到 `collapsed` 文案；两处的徽标词都走 i18n，且**只在 script 上挂**（dwf 是缺省方言，
    给每条既有 run 都挂一枚只是噪音）。两个 locale 的键必须在场。
30. **端到端：真子进程 → 真适配器 → 真 reducer**（`script-workflow-projection-e2e.test.mjs`）。
    上面 24–29 全部是手写载荷，而子进程的事件形状住在一份**字符串模板**里
    （`script-workflow-child-source.ts`）：改了模板的键名，手写夹具照样绿、投影却静默变空。
    这一段必须真跑：`phase()` 的 `{title}`、`log()` 的 `{message,phase}`、`parallel()` 送来的
    真 `callPath`（`root/parallel0/item<k>/agent0`）各自到达投影；三个并发 agent 各有身份
    **且 sessionId 走完 started→completed 仍在场**；agent 失败 → `errored` 而不是停在 running。
    只有 agent 的执行是桩（真跑要模型凭据），事件形状与身份全是真的。
    这条测试查出过 24 的修复并不充分（见上一条「结算事件」裁决）。

## 不在本项范围

- ~~`/ultracode` 斜杠命令、ultracode 关键词触发、两套并存的 UI 展示与 i18n~~ → **已做**
  （批次 C1/C2/C3，见 R10 / R11）。仍在范围外的是其中的**会话级常开**（R10 末条）。
- 给脚本工作流补静态分析 / 因果图 / typed schema 合成 / 确认窗展示。
- `budgetTotal` 的「用户指令 → 预算」解析路径（已知边界 6）。
- `workflow()` 嵌套实现。
- 跨 run 的 amend-resume（对齐 dwf 的导入缓存语义）。
- 回收死名 `Workflow` 及其遗留引用（`provider-visible-order.ts` 的那一行与
  `LEGACY_TOLERATED` 按「死名永不回收」纪律保留）。
- dwf 引擎的任何改动。

## 第三方归属

`RunWorkflow` 的 DSL 形状（`export const meta` + `agent/parallel/pipeline/phase/log/args/budget/workflow`、
`pipeline` 无 barrier 而 `parallel` 是 barrier、确定性禁令、`(prompt, opts)` 缓存键）参照了
外部产品的公开行为契约。**本仓库的实现在此之前就已存在**（`contracts/src/tools/workflow.ts`
与 `bootstrap/src/app/script-workflow-*.ts` 均为本仓库存量代码），本项是复活与加固，
未拷贝任何外部文件；技能文档按语义重写。
