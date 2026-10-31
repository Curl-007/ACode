# 托管策略地板 + 旁路免疫熔断器（P2 骨架）

安全加固 P2 骨架项。给 ACode 的权限决策补两层此前完全缺失的机制：

1. **托管策略地板（managed policy floor, strictest-wins）**：管理员可下发一份只能收紧、
   不能放宽的策略，任何用户/项目/CLI 配置都无法放松它。
2. **旁路免疫熔断器（bypass-immune circuit breakers）**：一组内置的危险动作检查，
   **即使 yolo/bypass 也强制弹窗**——把「yolo = 无条件放行」改成「yolo = 放行除熔断器外的一切」。
   （R6 校准，2026-10-14：pathEscapeWrite 类退出 yolo 兜底面。R8 再校准，2026-10-30
   用户裁决「完全访问 不弹」：sensitiveRead/bashRootDelete 两类 ask 级也退出 yolo 兜底面
   ——「yolo = 放行除 **deny 级熔断与托管策略地板**外的一切」，ask 级豁免留 warn 审计；
   catastrophic deny 级与策略地板不变。）

P1-6 的项目 restrictive floor 是本骨架的特例（见 `project-permission-restrictive-floor.md`
末段）；本骨架落地后，项目层、用户层、策略层共用同一套「只能收紧」的表达。

## 背景

`core/src/permission/service.ts` 的 `checkPermission` 在 yolo 模式下**第一步就 allow**
（`mode === "yolo" && !planEnabled → allow`），且先于 `disallowedTools` 硬禁用检查——
即当前 yolo 下连用户自己禁用的工具也会被放行。没有任何机制能在 yolo 直通之前插入
不可绕过的检查，也没有任何配置层能表达「无论用户怎么配都不能放松」的基线。

## 产品规则

### R1 托管策略地板

- **来源**：OS 托管路径的单一 JSON 文件（管理员权限才能写入，普通用户/项目不可达）：
  - Windows: `C:\ProgramData\ACode\managed-settings.json`
  - macOS: `/Library/Application Support/ACode/managed-settings.json`
  - Linux: `/etc/acode/managed-settings.json`
  - 测试/开发可用 `ACODE_MANAGED_POLICY_FILE` 覆盖路径（打包态忽略该 env，与 P1-7
    更新源门禁同一哲学：打包版不吃 env 注入）。
- **只能表达收紧**：schema 只接受 `permissions.deny` / `permissions.ask`（规则数组）、
  `permissions.disallowedTools`（字符串数组）、`permissions.disableBypassPermissionsMode`
  （布尔）。**出现 `allow` 类字段或未知键 → 解析拒绝**（strict schema），防止策略文件
  被误用成放宽通道。
- **`permissions.requireLocalPermissionApproval`（布尔，可选）**：schema 接受该键但 CLI
  权限判定**忽略**它（不进 floor 数据、不影响 deny/ask/yolo 语义）。它的语义由 host
  botsService 消费——强制 bot 任务权限只能在桌面本机确认（见
  `packages/services/specs/bot-permission-local-approval.md` R2）。**必须让 CLI 严格 schema
  接受该键**，否则管理员一部署它，CLI 就会因未知键把整份策略降级成 MINIMAL_LOCKDOWN、
  丢掉 deny 规则。canonical schema 已单一来源化到 `packages/shared/src/node/managedPolicy.ts`
  （见该 spec R3），CLI 加载器是其薄包装。
- **strictest-wins**：策略层参与合并时只并集、不替换——`disallowedTools` 与用户/项目层
  取并集；deny/ask 规则作为独立规则集参与判定，压过所有放行分支。任何低层配置
  （System<User<Project<Session<Env<Cli）都不能移除或弱化策略条目。
- **disableBypassPermissionsMode=true** 时：yolo 直通失效，yolo 会话按 build 模式判定
  （副作用动作 ask）；显式请求切换 yolo 被拒（见 R4）。
- **解析失败 fail-closed 降级**：文件存在但解析失败 → 发 `config_managed_policy_invalid`
  诊断（error），并按最小封锁 `{ disableBypassPermissionsMode: true }` 生效（不附加
  deny/ask 规则）。理由：静默忽略一份管理员明确部署过的策略文件比误锁更危险；
  但不因一个 typo 把整机 deny-all。
- **文件不存在**：零行为变化（回归守护：无策略文件的安装与改动前完全一致）。

### R2 旁路免疫熔断器

- 熔断器是**内置不变量**，不依赖任何配置（策略地板可以额外收紧，但不能放松熔断器）。
- 判定位置：`checkPermission` 内、**yolo 直通之前**、策略 deny/ask 之后。命中即返回
  ask（`ruleId = breaker.<class>`），**不**返回 deny——保留用户「我知道我在做什么」的
  最终决定权，与既有 ask 语义一致。
- 熔断器**只降级 allow**：已是 deny 的保持 deny；已是 ask 的保持原 ruleId（不覆写，
  避免丢失原始原因）；plan 模式的 deny 也不受影响。
- 骨架实现三类（第四类「跨机隔离」留作扩展点，见「不在本骨架范围」）：

| 类 | ruleId | 触发条件 |
|---|---|---|
| 空变量根删除 | `breaker.bashRootDelete` | Bash 命令经 `analyzeBashCommand` AST 解析后，存在删除类命令（`rm`/`rmdir`/`del`/`Remove-Item`）携带递归/强制旗标，且其路径参数满足任一：① 含未解析展开（ParameterExpansion/SimpleExpansion/CommandExpansion，即 `rm -rf "$DIR"` 形态——变量为空时等价于删根）；② 解析后等于文件系统根或用户 home；③ 参数为空字符串。**yolo 直通见 R8**（同 sensitiveRead） |
| 路径逃逸写 | `breaker.pathEscapeWrite` | Write/Edit/ApplyPatch 的目标路径（经 `resolveWorkspacePath` 以 workingDirectory 解析）落在 workspaceRoot 之外（workspaceRoot 已知时）。**ask 而非 deny**：与 `path-policy.ts:36-38` 的既有产品决定一致（子代理可能需要查看用户指定的兄弟仓库），但 yolo 下不再静默放行。**豁免面见 R5**（系统临时目录 + 产品 scratch 区，2026-10-14 用户裁决）；**yolo 直通见 R6**（2026-10-14 用户二次裁决：yolo 下本类不再降级 allow，非 yolo 的 allow 来源照旧） |
| 敏感位置读 | `breaker.sensitiveRead` | Read/Glob/Grep/Bash 的目标命中**封闭清单**的凭据位置模式（ssh 私钥、系统/用户凭据库、浏览器 profile、云 CLI 凭据目录）。清单是代码内常量，不接受配置扩展（扩展走策略地板的 deny/ask）。**yolo 直通见 R8**（2026-10-30 用户裁决「完全访问 不弹」：yolo 下本类静默放行 + warn 审计，非 yolo 照旧） |

- Bash 解析失败/超长（`hasParseErrors`）时，删除类命令按「含未解析展开」同等对待
  （fail-closed 到 ask）；非删除类命令不受影响。

### R3 判定优先级（决策顺序即安全边界）

```
checkPermission(context, capability, projectRules, rulePolicy)
  │
  ├─ 0. policyFloor.deny 命中            → deny   （绝对最高，压过一切分支）
  ├─ 1. policyFloor.ask 命中             → 托底 ask（压过 yolo / plan-readonly / allow；
  │        │                                      对抗复审 N1：不提前返回——托底后仍要过
  │        │                                      第 6 步熔断与反射门，最严者胜，见下）
  │        └─ 模式层给出 deny 时保留 deny（policy ask 不得把任何 deny 放宽成 ask）
  ├─ 2. disallowedTools（含策略并集）     → deny
  ├─ 3. plan-mode transition（既有）
  ├─ 4. requiresUserInteraction（既有）
  ├─ 5. alwaysAsk（既有，含 session/workflow-owner 免确认）
  ├─ 6. bypass-immune breakers 命中      → ask    （在 yolo 直通之前；只降级 allow。
  │        R6/R8：YOLO_SILENCED_ASK_BREAKERS 集合内（pathEscapeWrite/sensitiveRead/
  │        bashRootDelete）的 ask 级命中在 yolo 直通条件成立时不降级——静默放行 +
  │        warn 审计，判定分层见 R6.2/R8.4；deny 级（catastrophic）永不豁免）
  ├─ 7. yolo fast-path（policyFloor.disableBypassPermissionsMode=true 时跳过，
  │        落入 build 判定）
  └─ 8. auto / project rules / plan / allowedTools / edit / build（既有顺序不变）
```

**与反射门的交互（对抗复审 N1，详见 `bash-confirm-reflexive-gate.md` R7）**：
第 1 步的 policy ask 不再是提前出口——门前 decision 托底为 ask 后，第 6 步的
**deny 级熔断（`breaker.bashTargetCatastrophic`）先于策略 ask 收敛**（policy ask +
`rm -rf ~` + yolo → deny，而非可批准的 ask）；confirm 级命令仍要过反射门（首调 deny
`gate.bashConfirmReflex.reflect`，二调带有效 justification → ask，ruleId 保留
`rule.policy.ask`，reason 同时携带策略地板与门语义）。策略地板只能收紧、不能放松
任何既有判定（含模式层 deny）的本节总原则，在「policy ask × 熔断/门」交界处同样成立。

状态所有者：策略地板的**唯一读取点**是 `adapters/src/config/managed-policy.ts`（新模块），
由 `createConfig` 在 System 之前读入、以 `ConfigScope.Policy`（priority 60，高于 Cli 50）
参与合并；合并后进入 `RuntimeConfig.permission.policy`，由 `create-app.ts` 构造
`PermissionService` 时注入 `PermissionConfig.policyFloor`。熔断器的**唯一判定点**是
`core/src/permission/bypass-immune-breakers.ts`（新模块，纯函数），由 `PermissionService`
在第 6 步调用——不在 permission-flow 做 post-decision override，保证两个调用方
（executor 与 input-recheck）自动同语义。

### R4 模式切换边界

`disableBypassPermissionsMode=true` 时，显式请求 yolo/bypassPermissions 被拒
（复用 P0-3 的 `modeRemoteForbidden` 同款拒绝语义，本地来源回 `modePolicyForbidden`）。
决策层（R3 第 7 步）的跳过是安全底线；模式切换拒绝是 UX 一致性，两者都必须有。

### R5 pathEscapeWrite 豁免面 + 熔断弹窗诚实性（2026-10-14 用户裁决）

**背景（用户反馈「yolo 会话子智能体依旧上报权限审批」的四个已核实事实）**：

1. 子代理写工作区外临时目录是真实高频需求（path-policy.ts:36-38 的既有产品判断
   「子代理可能需要访问兄弟仓库/外部文件」在写方向的延伸）；pathEscapeWrite 对
   此类写入在任何模式（含 yolo）弹 ask，用户感知为「完全访问不生效」。
2. **弹窗上的「总是允许」对熔断器 ask 结构性无效**：熔断判定位于 checkPermission
   收口处（R3 第 6 步语义的实现位），把任何 allow 无条件降级 ask、从不咨询项目/
   会话规则；yolo 更是在规则匹配之前提前返回。用户点「本项目总是允许」持久化的
   allow 规则永远不被消费 → 下次照弹（2026-10-11 本机日志实证：同会话
   「Approved once」→「Approved for this project」→ 38 分钟后同熔断器第三次弹窗）。
   这是暗黑模式：UI 提供了不起作用的选项。
3. **不对称性**：pathEscapeWrite 只覆盖 Write/Edit/ApplyPatch/MultiEdit；Bash 重定向
   写工作区外在 yolo 下静默通过（Bash 面只有灾难目标 deny 与 sensitiveRead 文本
   匹配）。熔断器的真实安全增量是「防工具族无意识越界写」，不是硬边界——豁免
   临时目录的边际安全成本≈0。
4. **上游对照实测**：ZCode 3.15.x（yolo 会话）写系统临时目录零弹窗——上游没有
   pathEscapeWrite；本熔断器是 ACode 自研加固，比上游严。

**裁决（用户选定：豁免系统临时目录 + 修无效授权暗黑模式 + 产品管理暂存区与提示词
引导；未选「让授权真正生效」重方案）**：

- **R5.1 tmpdir 豁免**：checkPathEscapeWrite 的 resolved 目标路径位于 `os.tmpdir()`
  内时不触发。豁免是**纯静态前缀判定**（normalize 后 isPathInside），不做 realpath/
  fs 探测——熔断器模块「从不执行任何外部程序、只做静态判定」的既有纯度不变。
  已知边界（接受）：macOS 上模型显式写 `/tmp/...` 而 `os.tmpdir()` 返回
  `/var/folders/...` 时不豁免（照旧 ask）；豁免跟着 tmpdir 的精确值走。
- **R5.2 产品 scratch 暂存区**：`<storage.dir>/cli/scratch`（`storage.dir` 为既有
  配置字段，与 `cli/exec`、`cli/log` 同根；create-app 处 `storageRoot` 已在作用域）。
  经 `AgentRuntimeDeps.scratchRoot` 接线，四个 AgentRuntime 构造点（create-app 主
  会话、subagent child、workflow-facade child、script-workflow child）一致透传——
  子代理与父同一 scratch 根（产品管理目录，非会话身份，无需按会话分根；模型可
  自行建子目录）。checkPathEscapeWrite 对 scratchRoot 内的 resolved 路径不触发；
  **scratchRoot 缺席 → 该豁免不生效**（与 workspaceRoot 缺席同一容错哲学，宁可
  多弹不误放）。
- **R5.3 提示词引导**：env-info 段（`core/src/context/sections/env-info.ts`）在
  scratchDir 事实在场时渲染一行目录 + 一句指引（自撰英文，prompt-language-policy
  R7）：临时/中间文件写 scratch 目录，不要写工作区外任意路径。缺席时零渲染
  （不猜路径、不渲染空行）。
- **R5.4 熔断弹窗授权诚实性**：permission-flow 的 `suggestedPermissionUpdates` 在
  最终 `permissionDecision.ruleId` 以 `breaker.` 开头时恒置空（事件与 broker 请求
  两个消费点同源）——弹窗不再提供永远无法生效的「总是允许」；「允许一次」语义
  不变。`rule.policy.ask` 存在同构问题（策略地板压过一切 allow 规则），**登记为
  后续项不在本次裁决范围**（托管策略场景罕见，且涉及管理员语义需单独裁决）。
- **不变量**：豁免面封闭为两个根（tmpdir + scratchRoot），**不加配置开关**（R2
  「清单是代码内常量」哲学延续；托管策略仍可用 deny/ask 规则对任何路径收紧，
  策略地板压过豁免——豁免只存在于熔断器触发判定内，位于 R3 第 0/1 步之后）。
  sensitiveRead、bashRootDelete、bashTargetCatastrophic、反射门全部不受影响；
  tmpdir/scratch 内的路径若命中 sensitiveRead 清单（如 scratch 里放 id_rsa 副本）
  照旧触发。熔断器「只收紧、永不放宽」的语义在豁免后仍成立：豁免是**触发面
  定义**的一部分（什么算「逃逸」），不是对命中的放行。

### R6 yolo 直通 pathEscapeWrite（2026-10-14 用户二次裁决 A）

**裁决背景**：R5 落地后复盘「完全访问」语义——用户裁决：yolo（完全访问）下
写工作区外任意路径**不应弹窗**。三个支撑事实：① 不对称性——Bash 重定向写工作区
外在 yolo 下本就静默通过（pathEscapeWrite 只覆盖 Write/Edit/ApplyPatch/MultiEdit），
熔断防得住「无意识越界」防不住「被注入后有意越界」，安全增量只剩防事故；
② 上游对照——ZCode 无此熔断器，yolo 越界写零弹窗（实测）；③ R5.4 已把熔断
弹窗的「总是允许」置空（结构性无效），剩余弹窗是纯一次性摩擦，无记忆效应。

**规则**：

- **R6.1 yolo 直通**：`breaker.pathEscapeWrite` 命中在 yolo 下**不再把 allow 降级
  ask**。直通条件与 C11（checkAlwaysAsk）及 R3 第 7 步 yolo fast-path **逐字同档**：
  `mode === "yolo"` ∧ plan 未生效 ∧ 策略地板未 `disableBypassPermissionsMode`。
  三处判定单一来源化为 `PermissionService` 私有谓词 `isYoloTrustBypassActive(context)`
  （消除三份内联拷贝的漂移面）。
- **R6.2 判定位分层**：熔断器模块**保持模式无关**（纯函数、无 mode 入参——R5 的
  触发面收窄在模块内，R6 的模式裁决在 service 收口层叠加）。非 yolo 模式的 allow
  来源（build/edit 下的项目 allow 规则、allowedTools、workflow 草稿免确认等）命中
  pathEscapeWrite **照旧降级 ask**——熔断器在非 yolo 面完整保留。
- **R6.3 其余熔断类不受影响**：sensitiveRead（读/命令文本凭据位置）、bashRootDelete、
  bashTargetCatastrophic（deny 级）、反射门在 yolo 下行为不变——「yolo = 放行除
  熔断器外的一切」收窄为「yolo = 放行除**其余**熔断类外的一切（pathEscapeWrite
  除外）」。R2 开篇的总语义按此校准。（**R8 再校准**：sensitiveRead/bashRootDelete
  两类 ask 级的 yolo 兜底亦废止，见 R8；deny 级与反射门维持本条结论。）
- **R6.4 与 R5 的关系**：R5 豁免面（tmpdir/scratch）保留且继续服务非 yolo 的 allow
  来源（build 下项目 allow 规则写 tmpdir 不再被熔断降级）；yolo 下两者叠加后
  pathEscapeWrite 实际不可达（R6 直通先生效）。
- **已知交互登记**：workflow-worktree-isolation.md R4 曾把「隔离 actor 写主 checkout
  被 pathEscapeWrite 判逃逸 ask」记为期望语义——dwf/workflow child 硬编码
  `mode:"yolo"`，R6 后该 ask 不再出现。该特性仍是 fail-loud 桩（未实现），且其
  spec 自证「worktree 隔离是状态隔离，不是权限收敛手段」；实现时如需越界确认，
  须另行设计（不依赖本熔断器），已在该 spec 加过时注记。

**验收场景（19-22）**：见下节；场景 9 的 yolo ask 断言由本裁决废止（改写为非 yolo
allow 来源形态）。

### R8 yolo 下 ask 级熔断静默放行 + warn 审计（2026-10-30 用户裁决「完全访问 不弹」）

**裁决背景**：R7（subagent-parent-inheritance.md）落地后复盘「完全访问」的剩余弹窗面：
yolo 档下 sensitiveRead（凭据位置读）与 bashRootDelete（空变量根删除）两类 ask 级熔断
仍逐次弹窗，而 R5.4 已把熔断弹窗的「总是允许」结构性置空——剩余弹窗是纯一次性摩擦，
无记忆效应。用户裁决：**完全访问 = 不弹**。

**规则**：

- **R8.1 豁免集合**：模块级常量 `YOLO_SILENCED_ASK_BREAKERS =
  { breaker.pathEscapeWrite, breaker.sensitiveRead, breaker.bashRootDelete }`——R6 的
  单条豁免收口进本集合（语义不变，只扩面）。条件三合一：yolo 直通条件成立
  （`isYoloTrustBypassActive`，与 R6.1/C11/R3 第 7 步同一谓词）∧ 命中 ruleId 在集合内
  ∧ 命中非 deny 级 → **先记 warn 审计再置未命中**（静默放行）。
- **R8.2 warn 审计留痕**：逐条审计，event `permission.breaker.silenced_under_yolo`，
  字段 ruleId / toolName / 目标摘要。**路径可记、内容绝不记**：Write/Edit 面记目标
  路径；Bash/PowerShell 面记命令文本前 120 字符截断；ApplyPatch 目标内嵌于 patch
  文本（文本即内容），宁缺不记。通道为 `PermissionConfig.logger`（装配层注入
  permissionAuditLogger，NodeFileLogger 落盘，与反射门 auditedAllow 同一通道）；缺省
  不留痕——审计缺席绝不阻断放行（与决策日志「失败静默」同哲学）。已知边界（登记
  接受）：`defaultPermissionConfig` 自建实例（Explore 子代理、memory agent）未注入
  logger，其豁免不留痕——与 R6 的 yolo 直通同边界。
- **R8.3 deny 级永不豁免**：`breaker.bashTargetCatastrophic`（behavior `"deny"`）在 yolo
  下照旧硬堵——**deny 是拒绝不是弹窗**，不在「不弹」裁决范围。托管策略地板
  （rule.policy.deny/ask）与 requiresUserInteraction 不动。
- **R8.4 判定位分层**：与 R6 同架构——熔断器模块（bypass-immune-breakers.ts）保持
  模式无关**一字不动**，模式裁决在 service 收口层叠加；executor 与 input-recheck 两个
  调用方自动同语义。PowerShell 面经同一 evaluator 自动同语义（cross-ref
  `powershell-tool.md` R8② 的三道命令文本门——豁免发生在 service 收口层，与 shell
  种类无关）。
- **R8.5 与反射门的交互**：被豁免的命中视同「熔断器仍在覆盖」——反射门的「不重复
  反射」边界（`bash-confirm-reflexive-gate.md` R1/R2：confirm 级形态已被类 1 覆盖的
  不进门）对豁免面同样成立。否则 `rm -rf "$DIR"` 族在 yolo 下会从「熔断 ask」退化成
  「门首轮 reflect deny」，「不弹」裁决落空。门对**未命中熔断器**的 confirm 级命令
  （`cat list | xargs rm -rf`、`npm run $X` 族）在 yolo 下的既有收口不变。
- **威胁模型登记（用户知情裁决）**：yolo 下 prompt-injection 驱动的凭据外传
  （读 `~/.ssh`、`~/.aws/credentials` 等）不再有任何人工作战拦截点，仅剩事后审计
  （warn 落盘 + 决策日志）——这是「完全访问 不弹」接受的残余风险。catastrophic
  目标档（deny 级）与托管策略地板作为最后防线保留。

**验收场景（24-28）**：见下节；场景 8/10/23 的 yolo ask 断言由本裁决废止。

## 接口

- `adapters/src/config/managed-policy.ts`：
  `loadManagedPolicyFloor(options?: { filePath?: string; env?: Record<string,string|undefined>; isPackaged?: boolean }): { floor: ManagedPolicyFloor | undefined; diagnostics: ConfigDiagnostic[] }`
- `contracts/src/config`：`ConfigScope.Policy = "policy"`（priority 60）；
  `RuntimeConfig.permission.policy?: ManagedPolicyFloorData`（deny/ask/disallowedTools/
  disableBypassPermissionsMode 的 wire 形态）。
- `core/src/permission/service.ts`：`PermissionConfig.policyFloor?: ManagedPolicyFloor`；
  `PermissionContext.workspaceRoot?: string`（熔断器路径判定用，缺省时路径类熔断器不触发，
  与既有「拿不到工作目录照常判定」同一容错哲学）；`PermissionContext.scratchRoot?: string`
  （R5.2 豁免根，缺省时该豁免不生效）；私有谓词 `isYoloTrustBypassActive(context)`
  （R6.1：三处 yolo 直通条件的单一来源——R3 第 7 步 fast-path、C11 checkAlwaysAsk、
  R6 熔断降级豁免共用，防三份内联拷贝漂移）；模块级常量 `YOLO_SILENCED_ASK_BREAKERS`
  与 `PermissionConfig.logger`（R8：yolo 静默豁免集合与 warn 审计通道，
  `bootstrap/src/app/create-app.ts` 注入 permissionAuditLogger 落盘）。
- `core/src/permission/bypass-immune-breakers.ts`：
  `evaluateBypassImmuneBreakers(context, capability): { ruleId: string; reason: string } | undefined`；
  `BypassImmuneBreakerContext.scratchRoot?: string`（R5.2，经
  `breakerContextFromPermissionContext` 从 PermissionContext 透传）。
- `core/src/runtime/types.ts`：`AgentRuntimeDeps.scratchRoot?: string`（R5.2，与
  `memoryRoot` 同位）；`core/src/runtime/helpers/runtime-tools.ts` 以
  `getScratchRoot: () => deps.scratchRoot` 下传；`core/src/tool/executor/types.ts`：
  `ToolExecutorDeps.getScratchRoot?: () => string | undefined`（与 `getMemoryRoot`
  同型接缝）；permission-flow 与 permission-input-recheck 两个 PermissionContext
  构造点同源填充。
- `bootstrap/src/app/create-app.ts`：`scratchRoot = join(storageRoot, "cli", "scratch")`
  注入主会话 deps；`core/src/runtime/methods/subagent.ts`、
  `bootstrap/src/app/workflow-facade.ts`、`cli-workflow/src/script-workflow-child-runtime.ts`
  三个 child 构造点透传。
- `core/src/context/sections/env-info.ts`：`buildEnvInfoSection(envInfo, model?, scratchDir?)`
  第三参可选；在场渲染 `Scratch directory (temporary files)` 行 + 一句指引，缺席零渲染。

## 验收场景

见 `apps/acode-cli/tests/managed-policy-floor.test.mjs` 与
`apps/acode-cli/tests/bypass-immune-breakers.test.mjs`（mkdtemp fixture，不触碰真实
工作区/托管路径）：

**策略地板**
1. 无策略文件 → 行为与改动前逐项一致（yolo 仍直通、build 仍按既有判定）。
2. 策略 deny 规则压过 yolo、session allow、project allow、allowedTools。
3. 策略 ask 规则在 yolo 下仍 ask。
4. `disableBypassPermissionsMode=true` → yolo 会话的副作用动作 ask（不再直通）；
   显式请求 yolo 被拒（modePolicyForbidden）。
5. 策略含 `allow` 字段或未知键 → 解析拒绝 + 诊断；解析失败 → 最小封锁生效。
6. `disallowedTools` 策略∪用户∪项目三层并集，任何一层都不能清空其它层。
7. 打包态忽略 `ACODE_MANAGED_POLICY_FILE` env（isPackaged=true 时只读 OS 托管路径）。

**熔断器**
8. ~~yolo 下 `rm -rf "$UNSET_VAR"` / `rm -rf /` / `rm -rf ~` → ask~~（两次修订：J1-1 起
   `rm -rf /`、`rm -rf ~` 为 catastrophic **deny**；**R8 废止** `rm -rf "$UNSET_VAR"` 的
   yolo ask 形态，改为 allow + warn 审计，见 24-28）；`rm -rf ./build` → 不触发
   （既有 yolo 直通）。
9. ~~yolo 下 Write 到 workspaceRoot 之外 → ask~~（**R6 废止 yolo 形态**，见 19-22）；
   熔断器模块纯函数面不变：workspaceRoot 外的 Write/Edit/ApplyPatch 目标仍判命中
   （模式无关），workspace 内不触发。
10. ~~yolo 下 Read `~/.ssh/id_rsa` → ask~~（**R8 废止 yolo 形态**，见 25）；非 yolo
    照旧 ask；workspace 内文件 → 不触发。
11. 熔断器不覆写已有 deny / ask 的 ruleId；alwaysAsk 工具照常走 alwaysAsk。
12. Bash 解析失败时删除类命令 fail-closed 到 ask；非删除类不受影响。

**R5 豁免面与弹窗诚实性**
13. yolo 下 Write 到 `os.tmpdir()` 内路径 → 不触发 pathEscapeWrite（allow 直通）；
    Write 到 tmpdir 与 scratchRoot 之外的工作区外路径 → 照旧 ask。
14. yolo 下 Write 到 scratchRoot 内路径 → 不触发；scratchRoot 缺席（undefined）时
    同一路径 → 照旧 ask（容错方向 = 宁可多弹）。
15. 豁免只作用于 pathEscapeWrite：tmpdir/scratch 内路径命中 sensitiveRead 清单
    （如 scratch 内 `id_rsa` 文件名）→ 照旧触发；bashRootDelete/灾难目标/反射门不受影响。
16. 熔断 ask（ruleId 以 `breaker.` 开头）的 permission-requested 事件与 broker 请求
    `suggestedPermissionUpdates` 恒为空数组；非熔断 ask（如 `rule.project.ask`、
    `tool.alwaysAsk`）的建议规则照常携带。
17. 子代理 child runtime 继承父 `scratchRoot`（subagent spawn 构造点透传）：yolo 父
    派生的子代理写 scratch 内路径不弹窗。
18. env-info 段：scratchDir 在场 → 渲染目录行与指引各一；缺席 → 段内容与改动前
    逐字节一致（零渲染，不猜路径）。

**R6 yolo 直通 pathEscapeWrite**
19. yolo 下 Write 到工作区外（非豁免根）→ allow（`mode.yolo`），零弹窗零 broker 请求；
    子代理同语义（child 模式继承 yolo → 同一直通谓词）。
20. **非 yolo 的 allow 来源照旧降级**：build 模式 + 项目 allow 规则（或 allowedTools）
    放行的工作区外 Write → ask（`breaker.pathEscapeWrite`）——R6 只豁免 yolo 直通面。
21. yolo + 策略地板 `disableBypassPermissionsMode=true` → 直通失效，工作区外写回落
    build 判定（副作用 ask）；yolo + plan 生效 → 写入本就被 plan deny（熔断不放宽 deny）。
22. 三处 yolo 直通谓词（R3 第 7 步 fast-path / C11 checkAlwaysAsk / R6 熔断降级豁免）
    单一来源 `isYoloTrustBypassActive`：任一处条件被单独改松都会使三处同红（回归钉）。
23. ~~其余熔断类在 yolo 不直通~~（**R8 废止**：sensitiveRead/bashRootDelete 的 yolo
    ask 形态改为静默放行 + warn 审计，见 24-28；灾难目标 deny 不变）。

**R8 yolo 静默豁免（2026-10-30 用户裁决「完全访问 不弹」）**
24. yolo 下 `rm -rf "$X"/` → allow（`mode.yolo`）+ warn 审计一条：event
    `permission.breaker.silenced_under_yolo`、ruleId `breaker.bashRootDelete`、
    toolName、命令摘要（前 120 字符截断）；**反射门不接管**（首轮无 reflect deny，
    R8.5 不重复反射）。
25. yolo 下 Read `~/.ssh/id_rsa` → allow + warn 审计（ruleId `breaker.sensitiveRead`、
    target 为目标路径）；build 下同一路径 → ask（`breaker.sensitiveRead`）保留。
26. yolo 下 catastrophic 目标（`rm -rf ~`）→ deny（`breaker.bashTargetCatastrophic`）
    且**零静默审计**——豁免集合不误吞 deny 级（behavior=deny 结构性守门）。
27. R6 回归：yolo 下越界写 → allow + warn 审计（pathEscapeWrite 并入集合后审计同格）；
    非 yolo allow 来源照旧降级（场景 20 不回归）；审计内容纪律——写工具的
    content 绝不进审计字段。
28. PowerShell 面自动同语义：yolo 下 PS 命令文本命中 sensitiveRead/bashRootDelete
    静默放行 + 审计（豁免在 service 收口层，与 shell 种类无关）。

## 不在本骨架范围

- **跨机隔离熔断器**：远程/手机 attachment 场景的「动作落在错误主机」检查需要与
  owner/lease 路由（AGENTS.md「进程、协议与远程控制」）联合设计，留作扩展点
  （`evaluateBypassImmuneBreakers` 的检查列表可追加）。
- **策略地板的分发/更新通道**（MDM、远程策略服务）：本骨架只定义本地托管文件形态。
- **auto 模式 LLM 分类器**：P3 backlog，与本骨架正交（auto 目前仍是 unimplemented deny）。
- 桌面 Settings UI 的策略展示（只读视图）：后续 UX 项。
