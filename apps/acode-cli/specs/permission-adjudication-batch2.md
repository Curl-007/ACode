# Spec：权限裁决批 2——dontAsk 模式 + 决策日志 + ask 写作纪律 + 闭集词表增补

> 来源：价值提取第二轮 T2-c1（权限模式闭集 dontAsk 档 + 决策日志）、T2-p1（ask
> 写作规范）、T2-c6/T3-C（启动拒绝词表第四组 + 审批参数绑定失效 token）。
> 纪律：只搬机制结构，裁决语料/提示词/文案一律自撰；无厂商代号进入代码与本 spec。
> 红线沿用第一批：no-telemetry（决策日志是本地文件，零网络出口）、地板只收紧、
> fail-safe=更严者胜。

## 背景（已核实，feature/value-extract-23737-r2）

- 模式闭集现状：`CollaborationMode = plan|build|edit|yolo|auto`
  （`contracts/src/interfaces/session-shared.ts:17`，contracts 叶子文件——本批
  **所有权外**，联合类型扩展登记为接线项）。权限判定入口
  `PermissionService.checkPermission`（`core/src/permission/service.ts`）：
  policy floor → disallowedTools → 模式分支 → breakers/反射门收口；全部 ask
  决策经**单一漏斗** `private ask()` 构造（`result("ask", …)`）。
- ask 的消费面：executor 接缝（`permission-flow.ts`）emitPermissionRequested +
  broker/hook 竞速；headless 无审批 UI 时由 DenyPermissionBroker 拒绝——
  「无人可问」今天以 broker 拒绝的形态存在，但那是**链路末端兜底**，不是模式语义：
  决策仍按有人可问的档位产生，拒绝理由不携带模式归因。
- unattended 语义现状（service.ts:167 起）：`grantSessionPermission` 的
  `origin:"unattended"` 把 cron/off-peak 派发轮的持久批准一律限期（TTL）——
  「无人值守的批准要更保守」已是既有裁决，dontAsk 是同一哲学在**模式档位**上的
  显式化：无人可问时不弹、不挂起、直接拒。
- 决策可观测现状：接缝日志 `tool.permission.evaluated/resolved`（debug/info）+
  auto 分类器审计 sink（本地 JSONL，specs/auto-mode-risk-classifier.md R6）。
  **缺**逐决策的本地审计面（每次 checkPermission 终局一条、env 门控）。
- 闭集词表现状：`contracts/src/errors/reasons.ts` 三组（agent 启动失败 /
  权限拒绝 / 会话错误分类）。**缺** org/gateway/provider 类「启动拒绝」组
  （第二轮 T3-C 词表增补证据：参考面 16+ token 链
  managed_settings_refused/gateway_signin_required/gateway_access_denied/
  org_credential_not_allowed/org_pin_mismatch/org_config_refused/
  bypass_permissions_root_blocked/worktree_unverified 等）与「审批参数绑定失效」
  token（参考面文案语义：批准绑定到弹卡时呈现的参数，参数变了批准不可复用）。

## 产品规则

### R1 dontAsk 裁决姿态（权限层扩展模式）

- **词汇与类型**：`core/src/permission/dont-ask-mode.ts`（新）定义
  `DONT_ASK_MODE = "dontAsk"` 与
  `PermissionAdjudicationMode = CollaborationMode | "dontAsk"`（权限层裁决模式
  闭集，含既有五档共六值；`PERMISSION_ADJUDICATION_MODES` 常量数组）。
  `PermissionContext.mode` / `PermissionDecisionResult.mode` /
  plan-mode-policy 的上下文类型同步放宽——放宽是向后兼容的（既有调用方传
  CollaborationMode 值照常编译）；contracts 层联合类型、CLI `--mode` 白名单、
  TUI `/mode`、桌面 picker、runtime config 的接入是**接线项**（见「接线需求」）。
- **语义**：无人可问——任何会产生审批弹窗（ask）的决策一律收敛为**不弹窗的
  deny**；allow/deny 原样通过。「白名单」= 既有全部 allow 来源：只读直通、
  项目/会话/TTL allow 规则、allowedTools、WebFetch 预批、workflow 草稿免确认、
  低风险 session 态更新。deny 来源（policy floor、disallowedTools、plan 拒写、
  breakers deny 档、反射门 deny）不变。
- **收敛点 = `PermissionService.ask()` 单一漏斗**：所有 ask 路径（policy ask
  托底、userInteraction、alwaysAsk、模式分支、breakers ask 级、反射门 ask lane）
  都经此构造，一处收敛全谱生效。deny 的 ruleId 恒 `mode.dontAsk`（对应参考面
  decisionReason{type:"mode"}），原 ruleId/reason 进拒绝文案做归因（审计与
  模型面都能看到「本来会因为什么弹卡」）。
- **正交组合不变量**（与既有收紧层逐个对照）：
  - policy floor deny → 不变（deny 不经 ask 漏斗）；policy ask → dontAsk deny
    （deny 严于 ask，「地板只收紧」时序成立，归因保留 rule.policy.ask）。
  - disallowedTools deny → 不变。
  - breakers：ask 级命中把 allow 降 ask → 再收敛为 deny（更严，不变量保持）；
    deny 档命中 → 不变。dontAsk 下 ask 已提前变 deny，`decision !== "deny"`
    的熔断块对之不重复评估——deny 不可能更严也不可能被放宽，语义闭合。
  - 反射门：allow lane 照常（首调 deny + 四问 → deny 原样）；ask lane 收敛为
    deny。挑战登记不发生（deny 终局无后续 re-issue 语义损失：重发带
    justification 的调用会重新走门）。
  - PreToolUse hook 的整体 allow **不能**翻转 dontAsk deny（hook-flow 首行
    「deny 原样返回」既有语义）——dontAsk 的 deny 与 policy deny 同级免疫。
  - `autoGrayZone` 标记只在 `mode === "auto"` 分支产生（既有守护测试钉住），
    dontAsk 不进灰区、不调分类器。
- **按工具文案**（`buildDontAskDenialReason`，自撰英文=模型面文本，
  prompt-language-policy）：两变体——`requiresUserInteraction` 工具（「需要交互
  批准而本会话没有批准面，没有人能应答」）与通用工具（「don't-ask 模式下未被
  规则放行的一律拒绝且不弹卡」）；共同尾段：动作**未执行**、不得声称成功、
  本会话内不要重试、向用户报告被拦的是什么与为什么需要它，或改做不需要批准的
  部分。全文控制在 deny 投影截断界（500 字符）内。
- `requiresApproval()` 在 dontAsk 下恒 false（诚实语义：不会发起审批请求）。

### R2 权限决策日志（env 门控，本地 JSONL）

- 开关：环境变量 `ACODE_PERMISSION_DECISION_LOG=1`（其它值/缺席 = 关闭，
  关闭态近零开销：模块级缓存判定，不做任何 IO）。
- 落点：`<workingDirectory ?? process.cwd()>/.acode_permission_decisions.jsonl`
  （点前缀本地文件，随项目目录；对齐参考面 `.automode_decisions.jsonl` 的
  「本地、无遥测冲突」形态）。
- 写入：`core/src/permission/decision-log.ts`（新）；**失败静默**
  （`appendFile(...).catch(() => {})`——日志故障绝不阻断权限决策链路）；
  **顺序化写队列**：并发 fire-and-forget 的 appendFile 不保证完成序，审计面
  承诺「决策顺序 = 落盘顺序」（promise 链串行追加，队列自身永不拒绝）。
- 挂点：`checkPermission` 的**终局单漏斗**——公开方法变为薄包装（内部
  `evaluatePermission` 保持既有流程原样），每个终局决策恰一条记录；中间被
  丢弃的候选决策（如 policy ask 托底时被覆盖的模式层 allow）不落。
- 条目形态（自撰字段集）：
  `{ts, tool, decision, ruleId, mode, riskLevel?, sideEffectScope?, sessionId?, reason?}`
  ——reason 截断 200 字符（自由文本只做诊断，不进任何判定）。
- 与 auto 分类器审计 sink（R6，第一批）互不干涉：那个记「分类器裁决」，这个记
  「权限决策终局」；两个都是本地 JSONL，可同时开。

### R3 ask 写作纪律（AskUserQuestion 工具描述增补）

`core/src/tool/handlers/ask-user-question.ts` 的描述文本增补（自撰英文，与既有
段落并存不删改）：

1. 仅当**下一步是用户的决定**才调用（选择权在用户的approach 取舍、提交/推送/
   发布/发送的放行、批准）——有惯例默认值或能自己查证的事实一律不问（既有段落
   已含，增补句强化「无事即省略整个调用」）。
2. 一问一决策：问题文本一句话，**禁止用 "and" 复合两个决策**。
3. 问题文本只承载决策本身：不给理由、不给推荐、不复述按钮已经呈现的选项。
4. 首选即主按钮：你把倾向的选项放在第一位，UI 把第一位渲染为主按钮——推荐用
   顺序表达，不用文字表达。
5. 没有等待用户的事项时省略整个调用（不问「还要继续吗」类空转问题）。

注记字段（agent 为审批人写 note=、批量全或无、dry_run——参考面人审卡配套⑦）
本批**不实施**：说服风险对冲（注记措辞必须取自被改对象自身描述）需要与审批卡
UI 面同批设计，登记后续。

### R4 闭集词表增补（contracts/src/errors/reasons.ts，本批独占）

- **第四组「启动拒绝」**`LaunchRefusalReason`（org/gateway/provider/托管设置类
  启动失败 token；证据=第二轮 T3-C 词表增补，参考面 16+ token 链）：
  `managed_settings_refused / org_config_refused / org_config_unavailable /
  org_pin_mismatch / org_credential_not_allowed / org_policy_denied /
  gateway_signin_required / gateway_access_denied / gateway_session_expired /
  provider_not_allowed / bypass_permissions_root_blocked / worktree_unverified`。
  同构纪律：`isLaunchRefusalReason` 成员判定 + 并入
  `isClosedErrorReasonToken` / `narrowExternalClosedReasonToken`（外部字符串
  先过形态白名单再查成员，永不直接透传）。文本分类器规则**暂不配**：本组是
  前瞻词表（org/gateway 启动链路在 ACode 尚无抛错点），分类器只映射仓库自有
  文案——抛错点落地时同批补规则（登记）。
- **审批参数绑定失效**：`PermissionDenialReason.ApprovalArgumentsMismatch =
  "approval_arguments_mismatch"`——语义：批准绑定到弹卡时呈现的那份参数；
  应答回来时参数已不同（hook 改写等），批准不可复用，调用不执行。文本分类
  规则收编规范文案（「approval … came back with different arguments」句式，
  自撰）；ACode 现行复核路径（permission-input-recheck：改写后重新弹卡）在
  结构上已保证不复用旧批准，本 token 供该语义进入上报面时收窄使用。

## 状态所有者

```
PermissionService（同步内核，唯一决策所有者）
  ├─ checkPermission = 终局单漏斗（薄包装）
  │    ├─ evaluatePermission（既有全流程原样：floor→disallow→模式→breakers→门）
  │    │     └─ ask() 漏斗：mode==="dontAsk" → deny(mode.dontAsk, 归因文案)
  │    └─ 终局决策 → decision-log（env 门控 JSONL，失败静默）
  │                → file-provenance 台账喂入（allow + 写族工具，见分类器 spec 批 2）
  dont-ask-mode.ts：词汇/类型/文案（纯层，零 IO）
  decision-log.ts：env 判定缓存 + 路径解析 + fire-and-forget 追加（唯一写入者）
  reasons.ts（contracts）：四组闭集词表 + 收窄工具（唯一 token 所有者）
```

## 接口

- `core/src/permission/dont-ask-mode.ts`（新）：`DONT_ASK_MODE`、
  `DONT_ASK_RULE_ID`、`PermissionAdjudicationMode`、
  `PERMISSION_ADJUDICATION_MODES`、`isDontAskMode`、
  `buildDontAskDenialReason`。
- `core/src/permission/decision-log.ts`（新）：
  `PERMISSION_DECISION_LOG_ENV`、`PERMISSION_DECISION_LOG_FILE`、
  `appendPermissionDecisionLogEntry`、`resetPermissionDecisionLogForTest`。
- `core/src/permission/service.ts`：`PermissionContext.mode` /
  `PermissionDecisionResult.mode` 放宽为 `PermissionAdjudicationMode`；
  `ask()` 漏斗收敛；`checkPermission` 薄包装（日志 + 台账喂入）。
- `core/src/permission/plan-mode-policy.ts`：上下文 mode 类型同步放宽。
- `core/src/permission/index.ts`：新增导出（dont-ask / decision-log /
  分类器批 2 的 corpus 与台账，见 auto-mode-risk-classifier.md 批 2）。
- `contracts/src/errors/reasons.ts`：R4 词表增补（barrel `export *` 自动透传，
  零 barrel 改动）。
- `core/src/tool/handlers/ask-user-question.ts`：描述常量增补（R3）。

## 验收场景

1. **dontAsk 收敛全谱**：build 语义下会 ask 的调用（副作用工具、critical、
   high、alwaysAsk、userInteraction、policy ask 托底、breakers ask 级、反射门
   ask lane）在 dontAsk 下全部 deny + ruleId `mode.dontAsk` + 文案含原 ruleId
   归因；不弹卡（decision 非 ask、escalated=false）。
2. **白名单照常放行**：只读工具、项目/会话/TTL allow、allowedTools、WebFetch
   预批在 dontAsk 下 allow；既有 deny（policy/disallowed/plan 拒写/breaker deny）
   原样。
3. **正交不变量**：yolo 直通谓词对 dontAsk 恒 false；autoGrayZone 不产生；
   PreToolUse hook allow 不翻转 dontAsk deny（hook-flow 首行语义，源码不变量
   测试钉住）；requiresApproval 恒 false。
4. **按工具文案**：requiresUserInteraction 工具与通用工具文案可区分；全文
   ≤500 字符（deny 投影不截断丢语义）；含「NOT performed / 不重试 / 报告用户」
   三要素。
5. **决策日志**：env=1 时每次 checkPermission 终局恰一条 JSONL（allow/ask/deny
   全谱；中间候选不落）；env 缺席/其它值零写入零 IO；写入失败（不可写目录）
   静默且决策结果不受影响；条目字段齐、reason 截断 200。
6. **词表**：`LaunchRefusalReason` 全 token 过形态白名单、成员判定、外部收窄
   （大小写归一 + 非法形态拒绝）；`approval_arguments_mismatch` 进
   PermissionDenialReason 且规范文案可分类；三组既有词表零回归。
7. **ask 写作纪律**：AUQ 描述含五要素关键句（一句话一决策 / 禁 and 复合 /
   不复述按钮选项 / 首位=主按钮 / 无事省略）；既有描述段落不删改。
8. **验证命令**：`node --import tsx --test
   apps/acode-cli/tests/permission-adjudication-batch2.test.mjs`（新）+
   既有权限测试全套（managed-policy-floor / bypass-immune-breakers /
   auto-risk-classifier / subagent-policy-floor）+ `pnpm typecheck` +
   `pnpm lint`。

## 接线需求与登记项（本批所有权外，报告精确移交）

1. **contracts 模式联合**：`session-shared.ts` 的 `CollaborationMode` 增
   `"dontAsk"`（一行）——之后 runtime config / executor 接缝的类型自动贯通
   （PermissionContext 已放宽，传参兼容）。
2. **可达表面**：CLI `--mode` 白名单（run.ts normalizePromptMode）、TUI
   `/mode` 菜单、桌面 NATIVE_PERMISSION_MODES picker、
   `CliPermissionMode`/`CliRuntimeMode` 词汇（cli-types.ts）——dontAsk 对
   cron/off-peak/`-p` 无头场景是安全默认位候选（与 bypass-immune-breakers
   正交组合已验证）。
3. **子代理面**：`resolveSubagentPermissionMode`（subagent/nesting-policy，
   W2-SKILL-B 独占）对 dontAsk 的严苛度排位建议：plan 与 edit 之间（比 plan
   宽——允许白名单写？不：建议 **plan 同档或更严**，dontAsk 的白名单由规则
   而非档位决定；裁决归所有者）。
4. **审批参数绑定失效的抛错点**：现行 permission-input-recheck 用「重新弹卡」
   替代「拒绝复用」，无需新抛错点；若未来引入批准后参数改写直通面，token 已备。
5. **决策日志的桌面/远程面**：`.acode_permission_decisions.jsonl` 落
   workingDirectory——远程 workspace 场景落远端文件系统（与 reflex 审计 sink
   同一边界哲学），桌面设置页开关登记后续。
6. **AUQ 注记字段**（agent-authored note 进 PermissionRequestedPayload +
   说服风险对冲）：与 T1-p1⑦ 人审卡配套同批评估，登记。

## 非目标

- bubble（决策冒泡给宿主）档：ACode 无宿主决策冒泡通道，登记不进本批。
- autoDenyAfterMs/deadlineEpochMs 倒计时自动拒：auto 档增强，与 dontAsk 正交，
  登记 v2。
- 决策日志的轮转/清理策略：单文件追加，体量由 env 门控自律；轮转登记后续。
