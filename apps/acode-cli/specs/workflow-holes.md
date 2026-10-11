# ACode：动态工作流 hole（挖洞-填充）机制

## 背景与目标

脚本形状不能预先写死时，作者（主 agent）把未知段留成 `hole<T>(stage, prompt)`：
运行停靠等待，作者事后提交该处函数体的**语句**，工具把语句 splice 进脚本重编译，
run 沿 amend/supersede 链继续。子代理返回**值**，hole 返回**代码**——缺数据用 ask，
缺拓扑用 hole。

上游对照：zcode 3.15.1 FillWorkflowHole（契约见 zoode 还原树
`plugins/bundled-skills/skills/dynamic-workflows/SKILL.md` §15/§16.7），机制参考、
文案自研。

## facade 与编译（dynamic-workflow 包）

- `facade/dts.ts` 新段 `FACADE_HOLE_SEGMENT`：
  `declare function hole<T>(stage: string, prompt: string): Promise<T>`；
  只进 `FACADE_DTS`，**不进** `SNIPPET_FACADE_DTS`（snippet 里 hole 编译期拒绝，
  同 agent()）。
- `facade/registry.ts`：hole 登记 site-producing（停靠需 journal 键）。
- `analysis/sites.ts`：裸 callee 收集 `HoleSite { id: "hole#N", stage, prompt }`，
  独立 per-kind 计数器（site-id stability 规则不动既有 id）。
- 编译期诊断（沿用 9004 形态，新码 9005）：hole 必须处于可替换语句位——`await` 的
  ExpressionStatement、`return await hole(...)`（尾洞惯用法）或 `const v = await hole(...)`
  （中段取值惯用法）三者之一，stage/prompt 字面量；**禁止出现在 fan-out 回调内**
  （funcDepth 判定；就地立即调用的 IIFE 对 funcDepth 透明，因嵌套生长的 splice 产物正是
  该形态）。
- `lowering/lower.ts`：打桩 `__host.hole(siteId, stage, prompt)`（泛型实参丢弃，
  ask 先例）。
- **线协议三处镜像同步**：`dynamic-workflow-runtime/src/protocol.ts`、
  `child-source.ts` BOOTSTRAP、`generated/child-main-text.ts`（`pnpm child-main:generate`）。

## 停靠与继续（cli-workflow + engine）

- child 侧 `__hole` shim：request/response 通道（与 ask 同形——需 await 外部输入），
  request 后 Park。
- 引擎 `RunEvent` 新增 `hole-reached { siteId, ordinal, stage, prompt }`（身份进
  nextOrdinal 体系，journal 双轨经 `record()`）；run 状态投影为 waiting-at-hole。
- **继续 = amend/supersede 链**（scriptHash 逐字节 resume 校验使原地改脚本不可行）：
  1. `FillWorkflowHole { run_id, hole_ref, script | path }`（XOR；hole_ref = 站点 id
     `hole#N` + 首达 ordinal）；
  2. 读 run 草稿，把 hole 调用表达式替换为 `await (async () => { <语句> })()`——
     splice 用 AST 节点身份定位 hole 调用的精确源区间，fill 语句以**自身上下文**重打印
     （TypeScript printer 按节点位置从源文件取字面量，跨源文件嵌入节点会打印错位文本，
     实测定论），完整表达式换完整表达式，产物全量重编译；不用字符串拼接；
     语句里允许再留 tail hole（嵌套生长）；
  3. 重编译：诊断 → 拒绝（`hole_still_waiting`，不 splice，报 fill 文件路径）；
     与上次被拒字节相同 → `fill_unchanged`；
  4. 确认窗：**必须重算**（splice 后脚本是新可执行代码；新 world.run 命令集必须
     重新展示授权，防 fill 绕过授权面）；同会话减免规则照 amend；
  5. supersede：旧 run 停止（撤下停靠）、新 run import 既有 cache（amend 全链复用），
     记 `hole-filled`（含 splice 摘要与新旧 scriptHash）。
- fill 文件：与 run 草稿同目录（`.acode` 会话 workflows 目录族），被拒后可 Edit 再
  以 `path` 重提。
- `hole_not_waiting`：run 不在飞或不在该洞等待（已填/未到达/未知 id）。
- 停靠超时/撤销：run 停止（stop/失败）时撤下 pendingHoles（同
  `withdrawSessionEscalations` 先例）；resume 已停 run 后洞重新询问。

## 语义钉死（循环与多次到达）

filled-once-run-per-reach：splice 后 IIFE 位于原洞位置，循环每轮直接执行 body，
只有**首次到达**停靠；每 run 每洞至多一次 fill。同一脚本多洞独立停靠可并行等待，
fill 顺序任意（ splice 按洞位置独立替换）。

## 工具面与登记（7 处注册点）

contracts `tools/fill-workflow-hole.ts`；core `tool/handlers/fill-workflow-hole.ts`；
`handlers/index.ts` builtInTools；`workflow-tool-names.ts` GATED_WORKFLOW_TOOL_NAMES
（includeDynamicWorkflow=false 时下架）；`dynamicWorkflowRunPort.fillHole`（run service
实现，照 resolveQuestion）；actor 会话禁用名单（子代理不得填洞）；技能文档联动。
技能门：会话须已加载 `dynamic-workflows` 技能（428 族）。

## 观测链（shared + ui）

- `packages/shared/src/acode-protocol-v4/workflow-runs.ts`：run 条目新 **optional**
  `pendingHoles: [{ holeId, stage, prompt, askedAt, ordinal }]`（上限 8，照
  pendingQuestions 32/8 档裁剪；run-settled 清空）；`workflow-runs-reducer.ts` 新
  case（hole-reached upsert / hole-filled 划掉 / run-settled 清空）。
- UI：`app-shell/WorkflowRunHoleRow.tsx`（waiting / filled 两态，照
  WorkflowRunQuestionRow）；打开链复用 `onOpenWorkflowRun`；i18n
  `chat.toolCall.workflow.hole.*`（waiting/open/writing/revising/title）与
  `chat.permission.workflow.hole.*`（title/label/note）。
- **设置项**：设置页新增「动态工作流」三档（禁用/按需/始终），**对齐既有
  `dynamicWorkflowAvailabilityStore` 与 `packages/shared/specs/dynamic-workflow-availability.md`
  的 Host 决策链**（设置是该链的用户输入，不另造状态）；i18n
  `settings.dynamicWorkflow.*`。

## 验收场景

1. seed 脚本尾洞 → run 停靠（journal 有 hole-reached，UI 出 waiting 行）→ fill 一步
   语句 → 重编译过 → 确认窗 → supersede 续跑 → 终态正确；`reduce(transcript) ≡
   reduce(events)` 黄金测试覆盖 hole 事件。
2. fill 带语法错误 → 拒绝且原洞仍等待、草稿未变；重提同字节 → `fill_unchanged`。
3. fill 引入新 `world.run` 命令 → 确认窗展示新命令集；不确认 → 不 splice。
4. 循环内洞：首轮停靠 fill 后，后续轮次不再停靠，body 每轮执行。
5. fan-out 回调内 hole → 编译期 9005 拒绝。
6. snippet 含 hole → 编译期拒绝（SNIPPET_FACADE_DTS 不含）。
7. 子代理调用 FillWorkflowHole → 工具不在其工具面。
8. 测试：`apps/acode-cli/tests/workflow-holes.test.mjs`（编译/停靠/splice/supersede/
   循环/拒绝路径）+ shared reducer 单测。

## 最大风险（实现时盯住）

scriptHash/supersede 模型下「世界已被改」的 run 填洞后 importedCache 失效重跑
（importClosed 规则）——语义可接受（安全优先），但在 fill 响应里如实告知
`cacheImported: false` 原因。

## 实机验证与已知缺口（2026-10-11 桌面实机）

已实证：hole() 编译通过 → run 停靠（journal `hole-reached` 含 holeId/ordinal/stage/
prompt）→ UI run 卡 digest「N 个洞等待中」chip 与 v4 `pendingHoles` 同步 → GetWorkflowRun
detail 的 pendingHoles 发现面（introspection 与 shared reducer 同投影）→ FillWorkflowHole
工具面（alwaysAsk 确认门、hole_ref 形态校验、同步 splice 不可取消声明、结构化拒绝路径）。

**缺口（立项级，2026-10-11 二次排查修正定性）**：orchestrator 的 hole 中途唤醒通知
不存在。终态通知（run-settled → background-tasks 的 workflowNotification）只覆盖结算；
hole-reached 是中途态，没有等价 wake。初版实机笔记曾写成「同源会话死锁」，二次排查
修正：发起 turn **正常结束**（composer 回 placeholder，run 卡 stop 图标造成的 running
误读）；真正的摩擦是两条——① 没有 push wake，orchestrator 不会自己醒来填洞，需要用户
新 turn 介入（UX 缺口）；② FillWorkflowHole 是 alwaysAsk 确认门，自动化驱动必须点批准
卡，且批准卡挂起时再发新输入会打断该 tool call（同步 splice 以「cannot be cancelled」
拒绝——初版笔记里的那次拒绝正是 harness 自己打断自己，不是产品死锁）。
另实证：fill 的等价闭环可走 Amend/Resume 链（停驻 run 被 resume 成新 run、填充内容直接
烘进脚本，journal 见 `resumed_from` 链）；owner 进程退出后的 run 标
`possibly_interrupted`，ResumeWorkflowRun 可接管（既有引擎语义，非新缺陷）。
跟进方向：hole-reached 铸造一条中途 wake 通知（与终态通知同族，注入新 turn 或保持在飞
turn），动 turn/queue 不变量，需独立 spec，不在本批次范围。
