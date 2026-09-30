# Bash Confirm 级反射门（J1-2）

> 机制参照 jcode (MIT) `crates/jcode-command-risk/src/gate.rs`，全部为自撰
> TypeScript 实现，未拷贝任何源文件。

J1-1（`bash-target-blast-radius.md`）把「破坏目标无法静态确定」的命令判为 confirm
级。本条目在 confirm 级之上加一道**反射门（reflection gate）**：拒绝一次并把结构化
四问回喂给模型，强迫**生成命令的模型自己**补上它跳过的思考；重提必须携带有效
`justification`，盲目重试不解锁。

## 为什么不是第二个模型

jcode 的原话与 ACode 的取舍一致：LLM judge 贵、给每个边界调用加延迟、而且能被
**产生该命令的同一套推理**绕过去，还多出一个要对齐的东西。反射门把 test-time
compute 花在对齐上，但花在动作发生点、不引入额外模型。
`security-hardening-plan.md` P3 登记过的「auto 模式 LLM 风险分类器」仍然后置：
反射门是它的确定性前置，未来 auto 模式可在反射门之上叠加，不冲突。

## 产品规则

### R1 触发面与决策 lane

- 只作用于 **Bash 工具**且 J1-1 目标分级为 **confirm** 的命令；safe/low 完全不进
  门（日常命令零额外开销），catastrophic 永远走 J1-1 的 deny 级熔断（反射门不碰）。
- 门在 `PermissionService.checkPermission` 收口处运行，且**仅在无熔断器命中时**：
  既有三类 ask 级熔断与 catastrophic deny 级熔断优先（`rm -rf "$OUT"/` 这类已被
  类 1 覆盖的形态不叠加反射轮次）；decision 已是 deny（plan 模式、策略地板、
  disallowedTools）时不进门——门只收紧 allow/ask，不放宽任何 deny。
- 两条 lane 按门前 decision 区分，不按模式名硬编码：
  - **allow lane**：门前 decision = allow（yolo 直通、项目 allow 规则、allowedTools）。
    对抗复审 N5 更正：~~会话规则免确认~~不是 Bash 的 allow lane 入口——sessionRules
    只被 `checkAlwaysAsk` 消费，而 Bash 从不声明 alwaysAsk，该入口对 Bash **不可达**
    （仅适用于自报 alwaysAsk 的工具）；
  - **ask lane**：门前 decision = ask（build/edit 模式的 high/critical ask、策略地板
    ask 收敛后的 ask 等，见 R7 的收敛顺序）。
- executor 与 permission-input-recheck 两个调用方经同一收口自动同语义；
  门状态是 PermissionService 实例私有（一个实例 = 一个 app = 一个会话，与
  sessionRules 同一生命周期哲学）。
- hook 改写输入的 recheck 路径：挑战以**命令文本哈希**为 key——hook 改写了命令
  文本 → 新命令无挑战 → 门 deny（recheck 既有 deny 分支处理，改写后危险性不沿用
  改写前批准，与 breaker 复核同一哲学）；命令文本未变 → 门按既有挑战判定，ask
  结果沿用用户刚做出的批准（`gate.*` ruleId 不在 recheck 的重新弹窗名单里，语义
  等同「同一命令已通过门」）。

### R2 决策矩阵（核心语义）

| 挑战状态 | justification | allow lane | ask lane |
|---|---|---|---|
| 无挑战（首次调用） | 无 | **deny** `gate.bashConfirmReflex.reflect` + 记录挑战 | 同左 |
| 无挑战（首次调用） | 有（预填） | **deny** reflect + 记录挑战（预填不计为应答，见 R4） | 同左 |
| 已挑战 | 无（盲目重试） | **deny** reflect（重试文案：相同调用重发不解锁） | 同左 |
| 已挑战 | 无效（过短/纯确认词） | **ask** `gate.bashConfirmReflex.breakerAsk`（收敛到用户裁决） | **deny** `gate.bashConfirmReflex.insufficientJustification` |
| 已挑战 | 有效 | **allow** `gate.bashConfirmReflex.auditedAllow` + 审计日志（R6） | **ask** `gate.bashConfirmReflex.ask`（reason 携带 justification 原文） |

- 「相同调用重发再次失败」：挑战按命令文本哈希记录，无 justification 的重发永远
  拿不到放行或 ask。
- ask lane 的无效 justification 走 deny 而不是直接 ask：jcode 同款（Reflect 直到
  论证有效），deny 文案带明确的下一步指引（补论证或问用户），不是静默拒绝。
- allow lane 的无效 justification 收敛到 ask（「无效 → 仍走熔断器 ask」）：模型
  尝试过论证但不到位时，把裁决交给用户而不是继续循环 deny。

### R3 justification 校验与 schema 契约

- `contracts` 的 `BashInputSchema` 新增**可选** `justification: string`（max 4000），
  JSON schema 派生自动带上；schema description 明确「仅在上一轮被拒后重提时携带，
  首轮预填会被忽略」。`.strict()` 输入校验因此接受该字段。
- 校验规则（gate 内执行，不在 zod 层——被拒时要回喂结构化指引而不是一条 schema
  报错）。判定顺序（对抗复审 N7/N4 起有明确先后）：
  1. **长度上限先行（对抗复审 N7）**：justification 原始长度 **> 4000 字符 → 直接按
     无效处理**，与 contracts `BashInputSchema` 的 `max 4000` 契约对齐。executor 的
     `.strict()+max` 校验只拦得住主路径；PermissionService 可被不经 executor 的调用方
     直达（agent-runtime / project-memory-agent 自建实例），gate 内重复把关是纵深防御。
  2. **不可见字符剥离（对抗复审 N4；对抗复核 F1 修正机制）**：先剥离不可见与视觉空白
     字符，再做 trim 与长度/确认词判定。第一轮修复用的是**枚举清单**（U+00AD 软连字符、
     U+180E、U+200B–U+200F、U+202A–U+202E、U+2028/2029、U+2060–U+2064、U+FEFF），
     对抗复核 F1 证明枚举可被清单外字符族原样绕过：`"ok"+25×U+061C`（ARABIC LETTER
     MARK）/U+0600/U+E0020（TAG SPACE）/U+110BD/U+3164（谚文填充符）/U+2800（盲文
     空白）/U+FFA0 七族当时全部通过——审计与弹窗里 justification 视觉空白，「所见非
     所验」以字符族形式复活。机制改为 **Unicode 属性类 `\p{Cf}`**（一次覆盖通用类别
     Cf 的全部格式字符：U+0600–0605、U+061C、U+06DD、U+070F、U+110BD、U+E0001、
     U+E0020–E007F、U+FEFF、U+200B–200F、U+202A–202E、U+2060–2064、U+00AD、U+180E
     等），再**显式追加非 Cf 的视觉空白字符**：U+2028/U+2029（Zl/Zp 行/段分隔符）与
     U+2800、U+3164、U+FFA0（字形是空白、类别不是 Cf 的三个成员）。NBSP/普通空格保持
     既有 trim 语义（ECMAScript WhiteSpace 集合）。剥后不足 25 字符或成纯确认词 →
     无效；正常文本中的偶发格式字符按剥后内容判定，不受影响。
  3. **长度下限先于确认词黑名单（对抗复审 L-3 登记的事实）**：短确认句（`"proceed."`）
     先被「≥ 25 字符」规则拦截，走不到黑名单——黑名单只对长度达标但无实义的文本生效。
  4. trim 后 **≥ 25 字符**，且**非纯确认词**：归一化（小写、剥首尾标点）后整体命中
     黑名单，或按分隔符切分后**每个词都在黑名单**（防 "ok, proceed with it" 组合形态）。
  5. **拼接确认词判定（对抗复核 F1 变体 1）**：归一化（小写、剥去**全部**标点/符号/
     数字/空白）后，判定整串是否可由黑名单确认词**重复拼接而成**——`"y".repeat(25)`、
     `"确认".repeat(13)`、`"ok".repeat(13)`、`"yes".repeat(9)` 此前因「单一 token 不在
     集合」全部通过 allow lane 拿到 auditedAllow。实现用**子串可达 DP**（reachable[i]
     = 前缀 [0..i) 可分解，逐位尝试黑名单词），不用 `^(?:词1|词2|…)+$` 正则：这类正则
     在近失配串（如 `"yes".repeat(n)+"x"`）上有指数回溯，justification 上限 4000 字符
     会构成 ReDoS 面。数字同样从拼接判定剥去（`"ok"+"1".repeat(23)` 是同族无语义填充）。
     任何含黑名单外词的真实论证（The user explicitly asked to… 类）不可全串分解，
     不受影响。
- **对抗复核 F1 处置决定（登记）**：两类绕过——拼接确认词与清单外不可见字符族——在
  yolo allow lane 上 11/11 形态拿到 auditedAllow（confirm 级破坏命令在 yolo 下静默
  放行，P1；ask lane 同形被当作有效论证）。处置：不可见剥离机制从枚举清单升级为
  `\p{Cf}` + 视觉空白显式清单（第 2 步），纯确认判定从「按分隔符切分」扩展为「整串
  拼接分解判定」（第 5 步）；11 个绕过形态的修复前后对照实测入回归
  （`tests/bash-reflex-gate-adversarial.test.mjs` F1 节）。
- **确认词黑名单实况登记（对抗复审 L-3）**：gate 内常量是既有 spec 枚举的**超集**，
  此处登记完整清单——英文确认词 yes/y/yep/yeah/ok/okay/k/sure/confirmed/confirm/
  proceed/continue/approved/approve/do/it/go/ahead/run/execute，中文确认词
  是/好/好的/确认/继续/执行/可以/行；另有**无语义填充词** and/then/now/please/just/
  really/certainly/definitely/of/course/again/请/直接/现在（含 k/execute 两个扩展确认
  词）。填充词单独无任何语义，只用于识破「ok, go ahead and do it now」这类组合形态的
  纯确认句——任何提及用户请求/目标/命令实体的真实论证都必然含有集合外的词。
- 这是刻意放低的门槛（jcode：「目标是强迫一个反思轮次，不是给文采打分」）：
  任何表明模型真的重读了用户请求的文字都通过。
- **措辞不披露阈值**：所有 deny/ask 文案不出现「25 字符」「黑名单」「confirm 级」
  等内部分级细节——披露会让模型瞄准边界而不是诚实论证（jcode 经验）。

### R4 防预填（挑战登记）

- justification 只在**反射 prompt 已对该命令发出之后**才被计入：首次调用即携带
  justification → 照常 deny + 记录挑战（预填文本被丢弃，不作为应答）。
- 实现为挑战登记表：key = **调用方身份 + 命令文本** 的 SHA-256，value 含 nonce
  （randomUUID）、签发时间、尝试计数；Map 上限 256 条（插入序淘汰），随
  PermissionService 实例生灭（`/new`、重启、冷恢复都自然清零——与 sessionRules 同一
  哲学）。
- **挑战键含调用方身份（对抗复审 N3）**：~~一个实例 = 一个会话，不存在跨会话的预填
  绕过~~的说法被实跑证伪——general-purpose/自定义子代理**继承父实例**
  （`runtime/methods/subagent.ts`），bootstrap 的单实例也在多处复用，同一实例可能
  同时服务父会话与子会话；仅按命令文本哈希时，会话 A 触发的反射挑战会被会话 B 的
  首调「继承」，B 携带预填 justification 即可拿到 auditedAllow，而 B 从未收到反射
  prompt。修复：`PermissionContext.sessionId?`（由 executor 与 hook 改写复核链路从
  `deps.sessionId` 传入，子代理 runtime 的 sessionId 是子会话 id）并入挑战键哈希
  （NUL 分隔拼接后 SHA-256）——**挑战不跨身份生效**：会话 A 登记的挑战对会话 B 不可见，
  B 首调带 justification 仍是预填 → deny reflect。身份缺失的 legacy 调用方（既有单测、
  不经 executor 的直连调用）按仅命令文本哈希的现行为处理，该边界在此登记。
- **挑战键不含协作模式（对抗复核 F4 登记）**：挑战键 = 调用方身份 + 命令文本，
  **不含 mode**——build 模式登记的挑战在切换到 yolo 后，可被带有效 justification 的
  重提消费（→ auditedAllow）。这是有意设计、不构成绕过：模式切换只能由用户/宿主驱动，
  模型无法自升 yolo；同一调用方切换模式时「该命令的反射 prompt 已被读过」这一事实
  仍然成立，重提的 justification 依旧发生在反射 prompt 之后。mode 若进键，反而会让
  模式切换把已完成的反射轮作废（对同一命令重复拒绝已反思过的调用方）。
- nonce 不回显给模型：顺序保证由登记表提供，模型的 justification 是给用户看的
  自然语言，不掺机器 token。（对抗复审 N3 备选的「prompt 内嵌一次性 challenge token +
  重提回填」方案**未采用**：它要求重提的 input 携带机器 token，与「justification 是
  给用户看的自然语言」冲突，且会推翻本条 nonce 不回显条款、牵连 UI 展示；身份维度
  已在生产链路上可用，取最小诚实方案。）

### R5 反射 prompt（四问，deny 文案）

首次拒绝（作为工具错误回喂模型，经 `createPermissionErrorResult` 既有通道）：

```
This command was not run. Its full effect could not be verified before execution,
so it requires an explicit account of why it is needed.

What could not be verified:
- <J1-1 finding reason (target: …)>   ← 逐条列出，只含事实描述

Before it can proceed, stop and check it against the user's actual request:
1. Which specific thing the user asked for requires this exact action?
2. Is the target of this command something the user explicitly named, or something you inferred?
3. If you inferred it, would a narrower target accomplish the same goal?
4. If this command turns out to be wrong, can its effects be recovered?

If it is genuinely what the user asked for, re-issue the same command with a
`justification` field explaining which request it serves. If you are not sure,
ask the user instead: that costs one message, and being wrong costs their data.
```

盲目重试与无效论证的文案是其变体（重申「相同调用重发不解锁」/「确认词不算论证」，
同样不披露阈值）。**盲目重试文案不误导（对抗复审 N9）**：用户 ask 批准后同命令重发
仍会撞上门——决策语义不变（R7 有意收紧），但措辞必须说明「即使同一命令先前已获批准，
重提仍需要一条读过本 prompt 之后新写的 justification」，避免把「已获批的合法重跑」
误读成文案失实。ask 文案（有效论证）与 breakerAsk 文案（allow lane 无效论证）
都把 justification **原文**放进 reason，供审批弹窗与协议侧展示。

**投递必须完整（不被展示摘要器截断）**：首轮文案约 1000 字符，而缺省工具错误通道会
经 `projectExecutionErrorPayload` → `sanitizeText` 把空白压平并截到 500 字符
（`core/src/errors/error-payload.ts`）——四问的后三问与「re-issue with a
`justification` field」解锁指令会全部丢失，模型在最该反思的那一轮拿不到协议，只能
盲目重试再撞一次 deny。因此 `gate.bashConfirmReflex.*` 的 deny 在
`tool/executor/permission-flow.ts` 两个 deny 出口（首次判定与 hook 改写后的复核）都
走 `createPermissionErrorResult(..., { preserveReasonFormatting: true })`，原样投递。
判定归属由 gate 模块导出的 `isBashReflexGateRuleId(ruleId)` 提供（ruleId 命名空间的
唯一所有者），**其余 deny 文案维持既有投影**（压平 + 500 字符上限），避免顺手关掉
provider 错误摘要的保护。

### R6 审计日志（allow lane 有效论证放行）

- 放行时必须落一条结构化审计：`{ event: "bash_reflex_gate_audited_allow", ruleId,
  command（截断 2000 字符）, justification 全文, assessmentReasons, timestamp }`。
- **值级脱敏（对抗复审 N2）**：审计 entry 组装处对 command 与 justification 先做
  凭据形态脱敏再落盘。core 不能 import adapters（依赖方向禁止），脱敏器在 gate 模块
  内自撰轻量实现（形态设计只读参照 `adapters/src/doctor/redaction.ts` 的
  SECRET_PATTERNS，未拷贝代码）。覆盖形态与替换类别：
  - `Bearer|Basic` 方案头 → `[REDACTED:auth-scheme]`：值取「整段引号字符串（含两侧
    引号一起吃掉）| 裸 token（到空白/引号断）」——对抗复核 F2：旧 `\S+` 在空格断，
    `Bearer "quoted secret value"` 的多词值吃不全（残留 `secret value"`）；已被
    REDACTED 标记占位的值不再二次吃（`[REDACTED:` 开头跳过，保住前一层类别标记）；
  - `sk-`/`sk_`/`pk-`/`pk_`/`rk-`/`rk_` 同族 Key 字面量，**大小写不敏感** →
    `[REDACTED:api-key]`（对抗复核 F2：`sk_UNDERSCOREKEY123456`、`SK-UPPERCASE12345678`
    此前泄漏）；
  - JWT（`eyJ….…` 两/三段式）→ `[REDACTED:jwt]`；
  - GitHub PAT：`ghp_/gho_/ghs_/ghr_/github_pat_` 形态 → `[REDACTED:gh-token]`
    （对抗复核 F2：`ghp_GITHUBPAT1234567890` 此前泄漏）；
  - AWS Access Key：`AKIA` + 16 位大写字母/数字 → `[REDACTED:aws-key]`
    （对抗复核 F2：`AKIAIOSFODNN7EXAMPLE` 此前泄漏）；
  - PEM 私钥块：`-----BEGIN … PRIVATE KEY-----` 到 `-----END …-----` **整块（含
    base64 体）替换**，无 END 时吃到文本结尾（单独的 BEGIN 头同样要灭）→
    `[REDACTED:private-key]`（对抗复核 F2：PEM 块此前泄漏）；
  - `api-key`/`access-token`/`refresh-token`/`id-token`/`token`/`secret`/`password`/
    `credential` 等赋值形态（JSON 引号键与裸 `key=value`/`key: value`，JSON 引号键另含
    `authorization`/`x-api-key`/`anthropic-auth-token`）→ `[REDACTED:credential-field]`
    （对抗复核 F2：JSON 引号键列表独缺 `token` 而裸键列表有——清单内部不一致，
    `"token": "…"` 曾整值泄漏；裸键值分支认「整段引号字符串 | 裸 token」，
    `TOKEN="sk-…"` 这类 shell 引号值不再在引号处断开）；
  - `x-api-key`/`anthropic-auth-token` 头形态 → `[REDACTED:auth-header]`。
  **先脱敏后截断**（先截断会把凭据切碎成模式匹配不到的残片）。取舍依据：审计完整性
  vs「凭据不落盘」（AGENTS.md 日志红线）——凭据命中处只替换真值、保留句法结构与其余
  上下文，保证「为什么放行」仍然可读；非凭据内容逐字保留。
- **句法保真（对抗复核 F3）**：方案头/赋值形态的值匹配不得吞掉命令语法需要的闭合
  引号——`curl -H "Authorization: Bearer sk-…"` 脱敏后引号必须仍然配对、非凭据段
  逐字保留（修复前方案头 `\S+` 与赋值形态级联把闭合引号吃掉，脱敏结果引号不配对）。
- **两处清单同步（对抗复核 F2）**：core 的 `AUDIT_REDACTION_PATTERNS` 与
  `adapters/src/doctor/redaction.ts` 的 `SECRET_PATTERNS` 是同一份形态清单的两处落地
  （core 不能 import adapters，依赖方向禁止，故各持一份），此前已发生漂移（doctor 侧
  同样缺 JSON `token` 键、api-key 无大小写/下划线变体）。两处注释互相指向；**任一侧
  新增/修正形态必须同步另一侧**（见 provider-doctor.md R5 同款条款）。
- **sink 是可替换的进程级注册点**：gate 模块导出 `setBashReflexAuditSink(sink)`
  （与 `setProcessManagedPolicyFloor` 同一「bootstrap 装配期注册 hook」形态），
  `bootstrap/src/app/create-app.ts` 在应用装配期把它接到 info 级 Logger
  （`loggerFactory.createLogger("acode").child({ module: "core.permission" })`）——
  `NodeFileLogger` 以 `appendFileSync` 写 JSONL 日志文件（`@acode/adapters/logging`），
  于是 plan 验收项「yolo 下审计日志落盘」成立。allow lane 的入口包含项目 allow 规则/
  allowedTools（不只是 yolo；对抗复审 N5 更正：会话规则入口对 Bash 不可达，见 R1），
  confirm 级破坏命令不能在只留一行易失记录的情况下执行。
- **缺省 sink（未接线时的兜底）**：`console.warn` 输出单行 `[bash-reflex-audit] {json}`
  到 stderr——core 既有 console.warn 先例（tool/registry.ts），stderr 不占用 stdio
  协议通道；单测与独立调用 core 的场景仍留痕。`setBashReflexAuditSink(undefined)`
  复位为缺省（测试隔离用）。替换后同一条审计只有一个所有者，不重复输出。
- **gate 决策的观测（对抗复审 N6，选定方案 a）**：
  - allow lane 无效论证收敛的 breakerAsk 同样落一条审计：`event =
    "bash_reflex_gate_breaker_ask"`，字段与 auditedAllow 同构（同一脱敏与 sink），靠
    event 名区分——此前 breakerAsk 决策无任何专门留痕；
  - executor 的 `tool.permission.resolved` info 日志（生产落盘）补 `ruleId` 字段——
    此前 ruleId 只在 debug 级日志（生产不落盘），ask 归因在生产日志断线；
  - 未选方案 b（`permission_requested`/`permission_denied` 事件 payload 与
    acode-protocol 增补可选 ruleId）：additive 协议改动面大、消费方目前只有排障用途，
    日志方案已闭合缺口；若 UI 侧将来需要按 ruleId 渲染，再走协议增补。
- 审计 sink 故障不影响权限决策（try/catch 静默）：放行仍然放行，绝不因 transport
  故障反向收紧或放宽。
- 计划文本中的 `createServiceLogger(scope)` 属于外层 monorepo 的 packages/services，
  CLI 工作区不可达（`grep -rn createServiceLogger apps/acode-cli/packages` 零命中），
  CLI 侧的等价物就是 `@acode/contracts` 的 `Logger.info`。

### R7 不成为绕过路径（用户永远是最后裁决者）

- 反射门的任何失败形态都不是静默的：deny 全部携带结构化指引文案，executor 既有
  `tool.permission.denied` warn 日志与 UI denied 事件照常可见。
- 收敛性：ask lane 有效论证 → ask（用户裁决）；allow lane 无效论证 → ask（用户
  裁决）；allow lane 有效论证 → allow 但**留审计**。模型无法用反射门把 ask 变
  allow（ask lane 的终点仍是 ask），也无法绕过 catastrophic（J1-1 deny 级熔断
  永远先行）。
- 与 `bypass-immune-breakers.ts`「保留用户最终决定权」约定一致：反射门是熔断器
  ask 语义的**前置反思轮次**，不是新的永久拒绝层。
- **hook 例外（对抗复核 F6 登记）**：gate 的 `ask`/`breakerAsk` 是普通 ask（未声明
  alwaysAsk），PreToolUse hook 的整体 allow 可以翻转它们
  （`tool/executor/hook-flow.ts` `applyPreToolPermissionDecision`：非 alwaysAsk 的
  ask 可被 `hook.PreToolUse.allow` 翻转）；gate 的 **deny（reflect/insufficient）在
  同一函数里永不翻转**（decision === "deny" 直通返回），门拒仍是绝对的。「ask lane
  的终点仍是 ask」描述的是权限收口处的决策语义；hook 是用户配置的显式裁决通道，
  与既有 ask 决策的 hook 覆盖语义一致，不构成新的绕过路径。
- **与策略地板的收敛顺序（对抗复审 N1）：deny 级熔断先于策略 ask 收敛，最严者胜**。
  此前 `checkPermission` 里 policy ask 命中即提前返回（`rule.policy.ask`），绕过了
  其后的 deny 级熔断与反射门——把 catastrophic 的绝对 deny 降级成可批准的 ask。修复后：
  - policy **deny** 仍是绝对最高：先行返回，不进熔断不进门（不变）；
  - policy **ask** 只是地板不是天花板：命中后不再提前返回，而是把门前 decision 托底为
    ask（压过 yolo 直通/项目 allow/allowedTools 的放行，覆盖模式层自身的 ask），**但
    压不过既有 deny**——模式层给出 deny（plan nonReadOnly、auto unimplemented、项目
    deny 等）时保留 deny，policy ask 不得把任何 deny 放宽成 ask；
  - 门前 decision 托底为 ask 后**照常走熔断器与反射门收口**：catastrophic → deny
    `breaker.bashTargetCatastrophic`（deny 级熔断先于策略 ask 收敛）；ask 级熔断命中
    不覆写 `rule.policy.ask`（与「已是 ask 保留原 ruleId」同一哲学），门不叠加；confirm
    级且无熔断命中 → 首调 deny `gate.bashConfirmReflex.reflect`，二调带有效
    justification → **ask，ruleId 保留 `rule.policy.ask`**，reason 同时携带策略地板与
    门语义（托管策略要求批准 + justification 原文 + 不可静态验证的事实）；
  - 不回归：无 catastrophic/confirm 命中的普通命令在 policy ask 下仍 ask
    `rule.policy.ask`；policy deny 绝对最高；`disableBypassPermissionsMode` 语义不变；
    无策略地板时全链路行为不变。
- 既有 allow 规则（项目规则/allowedTools/会话规则）对 confirm 级命令因此多一轮
  反射：这是有意收紧（规则授权的是命令形态，不是「跳过对不可静态验证目标的
  论证」）。

### R8 UI 与协议

- `PermissionRequested` 协议 payload 的 `input` 是 `z.unknown()` 透传
  （`packages/shared/src/acode-protocol/index.ts` acodePermissionRequestParamsSchema），
  justification 随工具入参自然到达 UI，**无需协议改动**。
- `packages/ui/src/PermissionDialog.tsx`：请求 input 含非空 `justification` 时，
  在理由区与工具预览块之间渲染独立「模型论证」段（i18n：
  `chat.permission.justification.label`，en/zh 两份 locale），复用既有
  text-ui-base/foreground-subtle/border-border token 与圆角容器样式（DESIGN.md），
  长文本 max-h 内滚动；不新增 store 状态（justification 是请求 payload 的一部分，
  非 UI 局部状态）。
- **投影逻辑有唯一所有者且可测**：取数在
  `packages/ui/src/lib/permissionJustification.ts`（`getPermissionJustification` +
  i18n key 常量），弹窗只消费不重复实现——`PermissionDialog.tsx` 带 React/`@/` 别名
  依赖图，`node --import tsx --test` 加载不了，把纯投影放在无别名依赖的 lib 里，
  这一段才有了可执行验收（`packages/ui/test/permissionJustification.test.ts`：
  协议 `input` 与兼容 `rawInput` 两种取数、trim、缺失/空/非字符串 → 不渲染、
  en/zh 双份 locale、以及渲染处 `data-permission-justification="true"` 稳定定位点
  与 pre-wrap/段内滚动样式仍然存在）。
  依赖的 `isPlainRecord`/`readRawToolCallInput` 两个纯读取原语同步移到
  `packages/ui/src/lib/rawToolCallPayload.ts`（`fileSummaryTypes.ts` 原样再导出，
  既有消费者不变）。
- **含不可见字符的 justification 展示警示（对抗复审 N4，本轮登记不实施）**：gate 层
  剥离校验（R3 第 2 步）已在**裁决侧**闭合「零宽填充过校验、视觉空白论证」——无效
  justification 不会到达弹窗。展示侧的纵深防御（弹窗对残余不可见字符加警示注记）
  需要新增 i18n key（en-US/zh-CN locale），不在本轮修复的所有权边界内；待 i18n key
  就位后在 `PermissionDialog.tsx` 理由区渲染（检测逻辑放
  `packages/ui/src/lib/permissionJustification.ts` 投影层并补
  `packages/ui/test/permissionJustification.test.ts` 用例）。

## 状态所有者与接口

- **门状态唯一所有者**：`PermissionService` 实例私有字段
  `bashReflexGate: BashConfirmReflexGate`（新模块
  `core/src/permission/bash-confirm-reflex-gate.ts`，除审计 sink 外纯函数、
  无文件 IO；homedir/platform 与 J1-1 同款注入语义）。
- **挑战登记表**：gate 实例内 Map（会话生命周期，cap 256）。
- **审计 sink**：gate 模块级可替换单例（进程级）。缺省 console.warn(stderr)；
  装配期由 `bootstrap/src/app/create-app.ts` 经 `setBashReflexAuditSink` 接到
  info 级 Logger（JSONL 落盘）。
- **ruleId 命名空间**：gate 模块（`isBashReflexGateRuleId` 是投递层判断「这条 deny
  文案要原样保留」的唯一依据）。
- 消费点：仅 `permission/service.ts` 收口处一处；contracts schema 一处；UI 一处；
  投递层 `tool/executor/permission-flow.ts` 两个 deny 出口（R5）；
  审计接线 `bootstrap/src/app/create-app.ts` 一处（R6）。

## 验收场景（测试矩阵）

`tests/bash-confirm-reflexive-gate.test.mjs`（node:test + assert）：

1. build（ask lane）首次 confirm 级调用 → deny `gate.bashConfirmReflex.reflect`，
   reason 含四问关键词与 `justification` 指引，不含「25」「confirm」等阈值字样；
2. 盲目重试（相同调用、无 justification）→ 仍 deny（相同 ruleId）；
3. 短 justification（<25 字符）与纯确认词（"yes"、"ok, proceed with it"）→ ask lane
   deny `insufficientJustification`；
4. nonce 防预填：**新会话**（新 service 实例）首次调用即带有效 justification →
   仍 deny reflect（预填无效），重提同一 justification → 进入 ask；
5. 有效 justification（ask lane）→ ask `gate.bashConfirmReflex.ask` 且 reason 携带
   justification 原文；
6. yolo（allow lane）：首次 → deny；无效 justification → ask breakerAsk；
   有效 justification → allow `auditedAllow` 且审计条目产生（捕获缺省 sink），
   字段含 command/justification/ruleId；
7. 优先级：catastrophic（`rm -rf ~`）在 yolo 下仍是 `breaker.bashTargetCatastrophic`
   deny（门不介入）；类 1 命中（`rm -rf "$OUT"/`）仍是 `breaker.bashRootDelete`
   ask（门不叠加）；safe/low 命令（`ls -la`、`rm -rf node_modules`）零门开销直通；
8. 非 Bash 工具与无 command 入参不受门影响。
9. **投递完整（R5）**：走真实投递路径（`resolveToolPermission` →
   `createPermissionErrorResult`）时，首轮 reflect / 盲目重试 / 无效论证三种 deny 的
   `error.message` 与 `decision.reason` **等长且逐字相同**（含换行、四问、
   `` `justification` `` 指引，不以 `...` 结尾）；对照断言：非 gate ruleId 的长 deny
   文案仍被投影截到 500 字符（没有顺手关掉既有保护）；`permission_denied` 事件照常发出。
10. **审计落盘（R6）**：`setBashReflexAuditSink` 替换后 auditedAllow 条目送达替换 sink
    且缺省 stderr 不再重复输出；sink 抛错不改变 allow 决策；用真实
    `createNodeLoggerFactory({ logDir })` 按 create-app 的接线形态跑一次 →
    logDir 下的 JSONL 文件里能读到 `event=bash_reflex_gate_audited_allow`、
    `level=info`、`module=core.permission` 且 context 含 command/justification/ruleId/
    timestamp 的那一行；另有源码守卫断言 `create-app.ts` 确实调用了
    `setBashReflexAuditSink` 且把 `entry.command`/`entry.justification` 交给
    `permissionAuditLogger.info`。
11. **UI 投影（R8）**：见 `packages/ui/test/permissionJustification.test.ts`
    （取数、trim、不渲染条件、en/zh locale、渲染处稳定定位点与滚动样式守卫）。

对抗性复审修复轮 2（N1–N7/N9/L-3）的闭合与不回归用例见
`tests/bash-reflex-gate-adversarial.test.mjs`（分节注释标编号）：N1 策略地板收敛
（catastrophic deny 压过 policy ask、policy ask 下门首拒/二调收敛、policy ask 不放宽
既有 deny、普通命令/policy deny/disableBypass/无地板四个不回归）；N2 审计脱敏（凭据
不落盘、REDACTED 标记、非凭据内容逐字保留）；N3 挑战不跨身份（共享实例上 A 的挑战对
B 不可见、同身份两轮流程不变、legacy 无身份行为不变）；N4 零宽填充拒/偶发零宽按剥后
内容判；N6 breakerAsk 审计条目与 resolved 日志 ruleId；N7 超长 justification 无效。

对抗复核修复轮 3（F1–F4/F6）的闭合与不回归用例同在该文件（分节注释标编号）：F1 拼接
确认词四形态 + 清单外不可见字符七族在 allow/ask 双 lane 全灭（修复前 11/11 拿到
auditedAllow/ask），真实论证句含偶发格式字符仍有效、数字填充确认句拒；F2/F3 审计脱敏
七类泄漏形态（JSON `token` 引号键、`sk_`/`SK-` 变体、`ghp_`、`AKIA`、PEM 块、引号
Bearer 多词值）不落盘、多凭据并存全灭、非凭据段逐字保留、脱敏后引号配对；F4 与 F6 是
spec 登记项（R4 挑战键不含 mode、R7 hook 例外），无代码改动；doctor 侧同款脱敏用例见
`tests/provider-doctor.test.mjs`（3e）。
