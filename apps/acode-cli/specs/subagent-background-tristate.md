# 子代理 background 三态语义与一次性会话前台策略（BG1）

修复两个实测缺陷（`builtin-subagent-catalog.md` 实现决定回写第 11 条登记的 E2E 发现）：
① `run_in_background` 在 handler 被折叠成二态，显式 `false` 压不过 profile 的
`background: true` 默认——deny 通道（闲时任务）下此类 profile 变成**不可派发成员**
（错误提示让改前台，重试仍命中 deny，死循环）；② `-p` 一次性会话按 profile 默认
把子代理转入后台后，父进程随最终消息退出，后台子代理消亡、结果静默丢失
（metadata 滞留 running、无 output）。

修法两层：**三态语义**（根本修复，undefined=跟随 profile / true=强制后台 /
false=强制前台）+ **一次性会话前台策略**（`-p` 装配期声明 backgroundPolicy，
port 层单点强制前台）。交互式会话（TUI/desktop/stdio）与闲时 deny 语义不变。

## 背景

### 已核实的现状（基线：当前检出，行号实施前需复核）

| 事实 | 位置 |
| --- | --- |
| handler 折叠三态：`runInBackground: parsed.run_in_background === true`（undefined 与 false 同归 false） | `core/src/tool/handlers/agent.ts:219` |
| runner 判定：`rawRequest.runInBackground === true \|\| profile.background === true`——显式 false 无法压过 profile 默认 | `core/src/subagent/runner.ts:147-148` |
| port 契约的 `runInBackground?: boolean` 本就是可选三态承载，无需改类型 | `contracts/src/interfaces/subagent.port.ts:37` |
| deny 通道：`launchOptions.modelOverride.background === "deny"` 时抛 `BACKGROUND_UNAVAILABLE`（recoverable），消息文案 "Run this agent in the foreground"——二态折叠下该指令不可执行 | `core/src/subagent/runner.ts:150-163` |
| deny 的唯一生产链：off-peak 提交轮的 `ModelExecutionContext.subagents`（要求 `intent.modelSelection` 在场）→ loopState `subagentModelOverride` → 工具上下文 → handler → launchOptions | `runtime/types.ts:476-485`、`runtime/methods/turn.ts:546-554`、`tool/handlers/agent.ts:224` |
| 前台超时自动转后台由 `autoBackgroundMs` 门控（`!== undefined` 才建 timer）；**当前全仓无生产方**，机制休眠 | `core/src/subagent/runner.ts:294,655-661`、`runtime/methods/subagent.ts:70` |
| `runtimeConfig.subagents` 是既有配置面（enabled/inactivityTimeoutMs/autoBackgroundMs/profiles/builtInModelSelectionOverrides…） | `core/src/runtime/types.ts:140-153` |
| `-p` 模式在进程内直接 `createApp`（非协议转发），已有 headless 策略适配先例（CreateWorkflow 最小 permission broker）；`app.runtime` 直连 | `cli/src/prompt-command.ts:200-232` 及其注释 |
| bundled 目录 Verify/Review 默认 `background: true`（catalog spec R2 表）——缺陷②的现实暴露面 | `bundled-skills/agents/{Verify,Review}.md` |

### 为什么不是「-p 复用 deny 通道」

deny 挂在 `modelOverride` 上且生产条件耦合 `intent.modelSelection`（off-peak 提交轮
专有语义）；给 `-p` 复用需要解耦该条件或伪造 modelSelection，改动面更大且污染
闲时语义。会话形态（一次性 vs 常驻）是**会话事实**，不是模型覆盖事实，故新增
独立的 `subagents.backgroundPolicy` 配置位，在 port 层单点强制。

## 产品规则

### R1 三态语义：显式 false 是强制前台

- handler 透传 `run_in_background` 三态（undefined / false / true），不再 `=== true`
  折叠；runner 判定改为 `rawRequest.runInBackground ?? (profile.background === true)`。
- 语义表：undefined = 跟随 profile 默认（现状语义，交互式会话零变化）；
  true = 强制后台；false = 强制前台（**新增能力**：调用方明确需要结果立等可取时
  压过 profile 默认）。
- `AgentOutput` 两形态（completed / async_launched）与 Don't-peek、完成通知、
  SendMessage 转向等下游语义**零改动**——三态只影响「走 port.run 还是 port.start」
  这一个分叉点。

### R2 deny 通道行为不变，指令变为可执行

- deny 的触发条件、错误码（`BACKGROUND_UNAVAILABLE`）、recoverable 属性不变；
  文案补精确指令：重派时带 `run_in_background: false` 即前台执行（R1 使该指令
  真实可达，闲时任务的死循环随之解除）。文案仍为自撰英文。

### R3 一次性会话前台策略（backgroundPolicy）

- `runtimeConfig.subagents` 新增 `backgroundPolicy?: "honor" | "foreground"`
  （缺省 `"honor"`，全部既有会话形态语义不变）。
- `"foreground"` 的强制点在 **port 层单点**（`runtime/methods/subagent.ts` 的
  dispatch 包装）：请求进入 runner 前重写 `runInBackground = false`（同时压过
  profile 默认与显式 true），并把传给 runner 的 `autoBackgroundMs` 强制为
  undefined（防御钉住：未来任何生产方开启前台超时转后台时，一次性会话不得
  经该路径重新引入「后台消亡丢结果」）。
- `-p`（prompt-command）装配时传 `"foreground"`；TUI / stdio / desktop / server /
  闲时轮**不传**（维持 honor）。
- 产品语义陈述：一次性会话没有「稍后通知你」这回事——父进程在最终消息后退出，
  任何后台化都等于丢结果；因此该形态下 background 不是被禁止，而是**被改写为
  前台**（静默降级，不报错：父模型的 "You will be notified" 预期以 completed
  结果形态兑现，比 deny+重试少烧一轮）。

### R4 工具描述不随会话形态分叉

Agent 工具描述（含 `run_in_background` 说明）维持单份文本：`"foreground"` 策略下
描述里的后台语义对父模型轻微失真，但结果是 completed 形态原样返回，父模型无需
感知差异；按会话形态分叉描述会引入第二份描述装配面（`dispatch-discipline-prompt.md`
R4/R5 的同源纪律），代价大于收益。登记为已知取舍。

## 状态所有者

```
cli/src/prompt-command.ts:200   createApp({ subagentBackgroundPolicy: "foreground" })（-p 唯一声明点）
   │
   └─► bootstrap create-app      ACodeAppOptions.subagentBackgroundPolicy → runtimeConfig.subagents.backgroundPolicy
          │
          └─► core runtime/methods/subagent.ts   port 层单点强制（R3）：
                 │                                 runInBackground→false、autoBackgroundMs→undefined
                 └─► core subagent/runner.ts:147  三态判定（R1）→ port.run（前台）/ port.start（后台）
                        └─ deny 分支（R2，闲时轮经 modelOverride 进入，条件不变）

tool/handlers/agent.ts:219       三态透传（R1，唯一折叠点修复）
runtime/types.ts subagents       backgroundPolicy 配置位（R3 类型事实源）
```

- 「会话形态 → 策略」的所有者是各装配入口（本批仅 -p 声明 foreground）；
  runner 不感知会话形态，只消费 request 三态与 launchOptions——形态判断不得
  下沉进 runner（避免第二份形态推断）。
- profile.background 的所有权仍在 profile（catalog spec R2）；策略层是重写不是
  改 profile：装配后的 profiles 数组不被修改。

## 接口

- `core/src/tool/handlers/agent.ts`：请求构造处三态透传（受 `exactOptionalPropertyTypes`
  约束时用条件展开，不引入 `runInBackground: undefined` 显式键）。
- `core/src/subagent/runner.ts`：判定改 `??`；deny 文案补指令（R2）。
- `core/src/runtime/types.ts`：`subagents.backgroundPolicy?: "honor" | "foreground"`。
- `core/src/runtime/methods/subagent.ts`：port dispatch 包装内实施 R3 两点强制。
- `bootstrap/src/app/types.ts` + `create-app.ts`：`ACodeAppOptions.subagentBackgroundPolicy`
  透传进 runtimeConfig.subagents（与既有 subagents 配置合流处同款展开）。
- `cli/src/prompt-command.ts`：createApp 调用加一个字段。
- contracts 零改动（`runInBackground?: boolean` 已承载三态；schema `z.boolean().optional()`
  本就区分缺省）。

## 验收场景

1. **三态矩阵**（runner 级，假 port 记录 run/start 调用）：profile.background=true ×
   request.runInBackground ∈ {undefined, false, true} → {后台, 前台, 后台}；
   profile.background=false/缺省 × {undefined, false, true} → {前台, 前台, 后台}。
2. **deny 死循环解除**：deny + profile.background=true + undefined → 抛
   BACKGROUND_UNAVAILABLE（现状不变）；deny + 显式 false → 前台执行不抛错
   （R2 指令可执行性）。
3. **foreground 策略强制**：backgroundPolicy="foreground" 时，profile.background=true +
   undefined、以及显式 true，都走前台（port.run）；传给 runner 的 autoBackgroundMs
   为 undefined（即使 config 显式配置了数值）。
4. **honor 缺省不回退**：不传 backgroundPolicy 时行为与现状逐字节一致（既有
   subagent-* 测试套件全绿即为证据，不新增快照）。
5. **handler 透传**：input 缺省 → 请求无 runInBackground 键或值为 undefined；
   input false → 请求携带 false（不被折叠为缺省）。
6. **E2E（真实模型，-p 形态）**：派发 Verify（profile background:true）不传任何
   run_in_background——子代理前台执行、父代理在同一进程生命周期内转述完整报告、
   进程退出后无滞留 running 的 metadata。
7. **验证命令**（仓库根执行，如实记录）：`pnpm typecheck`、`pnpm lint`、
   `pnpm architecture:check -- --changed`、
   `node --import tsx --test apps/acode-cli/tests/subagent-background-tristate.test.mjs`（新）、
   既有 `apps/acode-cli/tests/subagent-*.test.mjs` 与 `builtin-subagent-catalog.test.mjs` 全量。

## 不在本项范围

- **交互式会话的任何行为变化**：TUI/desktop/stdio 维持 honor 缺省。
- **闲时任务 deny 语义重构**（如 deny 改自动降级前台）：本批只让其指令可执行。
- **一次性会话的 drain 安全网**（退出前等待遗留后台任务）：R3 使 -p 不再产生
  后台子代理，drain 失去必要性；若未来 -p 出现其他后台任务形态再立项。
- **Agent 工具描述按会话形态分叉**：R4 登记为已知取舍，不做。

## 实现决定回写（2026-10-06 实施批次）

1. **bootstrap 零改动**（「接口」节第 5 行未落地，属实现优化）：核实
   `ACodeAppRuntimeConfigInput = AgentRuntimeConfig`（`bootstrap/src/app/types.ts:122`）
   且 `runtime-config.ts:167` 对 `options.runtimeConfig?.subagents` 整体展开透传、
   后续键不覆盖 `backgroundPolicy`——prompt-command 直接经既有 runtimeConfig 入参
   声明即可，无需新增 `ACodeAppOptions.subagentBackgroundPolicy` 字段与 create-app
   透传代码。类型事实源仍唯一（core `runtime/types.ts` 的 subagents 配置位）。
2. **强制点落地形态**：`createDefaultSubagentPort`（`runtime/methods/subagent.ts`）
   读 `config.subagents.backgroundPolicy`——`"foreground"` 时构造参数压制
   `autoBackgroundMs`（防御钉住）并用新纯函数模块 `subagent/foreground-policy.ts`
   的 `wrapSubagentPortWithForegroundPolicy(port)` 包装返回（launch 重写
   `runInBackground=false`，其余方法同引用保留）。wrapper 独立成纯函数模块以
   满足可单测性；runner 不感知会话形态（「状态所有者」节约束成立）。
3. **E2E 实测记录（场景 6，真实模型 -p 形态）**：派发 bundled Verify
   （profile `background: true`）、不传任何 run_in_background——工具结果为
   同步 completed，父代理同进程转述完整报告（子代理实跑测试两次 4/4、exit 0、
   零文件修改）；任务 metadata 终态 `status: "completed"`、output.txt 完整，
   无滞留 running。对照组（修复前同形态派发）：async_launched 后进程退出、
   metadata 永久滞留 running、无 output——缺陷②闭环。
4. **既有警告不顺手修**：`prompt-command.ts:31` 的 `CliPermissionMode` 未使用
   import 为 HEAD 存量（oxlint warning），与本批无关，未动。
5. **Review 子代理对本批的 E2E 首评三 finding 的处置**（2026-10-06 第二轮实测，
   Review 以前台同步形态评审本批 diff + 新文件全文，判决「合并前须修 finding 1」）：
   - **finding 1（P2，已修）**：三态语义变化后模型可见文档未同步——`false` 不再
     等价于「省略」，但工具描述 bullet 与 schema `.describe` 仍只讲 true；交互式
     会话里模型习惯性填 false 会把默认后台的 Verify/Review 静默变成阻塞前台。
     修复：`tool/handlers/agent.ts` bullet 与 `contracts/tools/agent.ts` describe
     各补一句「省略=跟随该 agent 默认；false=强制前台（即使默认后台）」。
     仍是单一文本，不构成 R4 禁止的按会话形态分叉。
   - **finding 2（P3，已收紧）**：wrapper 泛型签名 `<T extends SubagentPort>(port: T): T`
     对原型方法形态的 port 过度承诺（展开只保留自有可枚举属性）；收紧为
     `SubagentPort → SubagentPort` 并在 doc 注释写明适用边界。
   - **finding 3（P3，登记取舍，不改代码）**：`-p` 前台改写使子代理从「无
     watchdog 的后台路径」进入「`inactivityTimeoutMs`（缺省
     DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS=600s）静默即中止」的前台路径——超过
     该窗口且中途无子事件的长命令（如全量测试套件）在 -p 下会被 recoverable
     中止。净效果仍优于修复前（修复前是结果整体丢失），且刻意不关闭 watchdog
     （会让 -p 可能永久挂起）。-p 长任务的可接受上限即该静默窗口；未来需要
     更长任务时在 -p 装配处显式配置 inactivityTimeoutMs，另行立项。

## 修订记录

（首版，2026-10-06；同日实施批次完成并回写。）
