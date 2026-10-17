# Spec：插件 hook 中间件语义 + 失败可见性 + hook-pins 三态（一期）

来源：价值提取第二轮 T1-c1①⑥（中间件 hook 模型 / 失败可见性协议，只做一期）与 T2-c3
（hook-pins 三态钉扎）。只搬机制语义，不引入任何厂商内部代号；对外文案一律用
「插件 hook 中间件」。证据（还原工程只读复核）：

- 中间件模型 `on(event, matcher?, ($, e, next))`：e 冻结纯值；`next(e)` 跑下层再跑引擎
  本体；不调 next 即自答；`next({...e,x})` 改写下游所见
  （`Claude-2.31226/src/beautified-claude-code/SKILL-55746ec0.md:24,36-38`）。
- 失败可见性：本会话 transcript 保留一行暗字 `<plugin>: <event> refused: <reason>; the
  engine drew its own`；其他会话只进 debug log；debug log 对每次被拒都有带原因的行
  （同 SKILL:48）。ACode 文案自撰：`<hook 名>: <事件> 被拒: <闭集原因>; 已用引擎默认行为`。
- hook-pins：每项目 `hook-pins-<sha256(project)前32>.jsonl`，
  `{version:1, project, pins:{64hex→{kind:"script",path,sha256}|{kind:"inline"}|{kind:"unpinnable"}}}`；
  原子写；读时 schema 校验 + project 不匹配即空集（fail-closed）
  （`chunk-9h4eq2mz.js:28925-28960` schema/读写、`:29040-29130` 分类/等价/展示）。

与 `specs/hook-event-surface.md` 的关系：事件全集、触发点漏斗与失败语义裁决仍以该 spec
为唯一事实源；本 spec 只增补「链内执行形状（中间件）」「被拒可观测行（失败可见性）」
「每钩钉扎记录（hook-pins）」三节，不改任何既有事件语义。

## 一、中间件语义（一期最小洋葱）

### 现状与取舍

现状：`InMemoryHookRunner.run` 对匹配 hook 顺序执行，callback 收 `(input, {hookIndex,
signal})`，输出经 `processHookOutput` → `mergeHookRunResult` 合并；hook 之间互不可见，
无人能改写下游所见，也没有短路（阻断类 hook block 后链仍继续跑，deny 在合并中胜出）。

全面洋葱化（next 一路包到「引擎本体动作」，hook 结果即事件结果）要求全部触发点
（tool executor / permission broker / compact / model switch / turn 生命周期）把业务动作
本身改成链内最内层环节——冲突面覆盖本波所有权外的全部触发文件，且与既有
HookRunResult 合并语义（多 hook 结果归并、deny 胜出）正面冲突。**一期落「链内输入改写
+ 短路自答」最小语义**，全面洋葱登记二期（见「四、登记项」R1）。

### 一期语义（唯一事实源：`core/src/hooks/types.ts` + `runner.ts` + `hook-middleware.ts`）

1. **opt-in**：`HookRegistration.middleware?: boolean`。仅程序化注册（内部/插件代码
   callback）可声明；配置面（process/command 外部进程 hook）不可能收到 next，
   `createConfiguredHookRunner` 生成的注册永不带 middleware。存量注册零改动零破坏。
2. **next**：middleware callback 的 `HookCallbackContext.next?: HookMiddlewareNext`，
   `next(e?) => Promise<HookRunResult>`：
   - `next()`：链以当前事件继续（后续 hook + 既有合并语义），返回下游合并结果；
   - `next(e')`：下游看到 e'（输入改写）——包括下游 legacy hook 与其进程 stdin 投影；
   - **不调用 next 即自答**：该 middleware 之后的链内 hook 全部跳过（短路），本事件
     的链结果 = 该 middleware 自身输出（阻断/替换语义与现有 block 输出对齐：
     `continue:false`/deny/`decision:"block"` 走既有 processHookOutput 裁决）。
3. **next 使用纪律**（违例 = `hook_middleware_misuse`，按失败语义 fail-open 放行 +
   失败可见性注记）：至多调用一次；只许在自己的 dispatch 期间发起；返回的 Promise
   应当被 await（未 await 时 runner 仍等链跑完再结算本环节，下游生命周期事件完整，
   另记 debug 行）。middleware dispatch 超时覆盖其整个派发（含 await 的下游）；下游
   各环节仍有自己的超时，链总时长有界。middleware 超时/抛错时：下游若在飞则等其跑完，
   **下游已产出的结果照常并入**（它们是真实完成的执行），只丢弃 middleware 自身输出。
4. **事件对象冻结纯值**：middleware 收到的事件 = 当前链上事件的浅冻结副本
   （`Object.freeze({...current})`）；`next(e')` 的 e' 必须是普通对象，且**身份字段
   不可改写**（hookEventName/sessionId/traceId/turnId 钉死为原值，改写 = misuse），
   必备基础字段（cwd/mode/timestamp）必须在场；通过后下游收到 e' 的浅冻结副本。
   取舍：一期浅冻结（顶层纯值面）——深层冻结会波及 runtime 持有的嵌套结构
   （如 PreToolUse 的 toolInput 引用），登记二期 R1 一并评估。legacy callback 收到的
   input 保持现状（不冻结），存量行为零变化；只有位于 middleware 改写下风的环节收到
   冻结副本（全部既有 callback 对 input 只读，已核 configured-runner-callback /
   session-mailbox）。
5. **合并顺序**：下游结果先并入，middleware 自身输出后并入（洋葱包裹序）；
   `mergeHookRunResult` 既有裁决不变（deny 恒胜、preventContinuation 单调）。
6. **生命周期事件**：每个真实启动的环节仍发 Started/Completed/Blocked/Failed 一套；
   被短路的 hook 从未启动、不发任何事件（hookCount 为预扫描值，短路时 invocation row
   靠既有 flush 收口——投影面适配登记为接线需求 W1）。`async:true` 与 `middleware:true`
   互斥：async 胜出（后台派发脱离链，无法参与洋葱），middleware 标志忽略 + debug 行。
7. **admission 不变**：middleware 环节同样先过 `resolveHookRunAdmission`，被拒不执行
   不自答，链继续（与既有 HookRunBlocked 语义一致）；执行边界重验授权（不缓存）纪律
   对链内每个环节保持。

## 二、失败可见性协议

**裁决**：hook「被拒」= 未执行（admission/trust 拒绝）或执行失败（超时/取消/进程
失败/输出 schema 校验失败/中间件 misuse）。hook 显式 block 是 hook 成功表达决策，
不属被拒（其 blockReason 走既有链路，不加注记）。fail-open 裁决不变
（hook-event-surface.md「失败语义」）：**每个被拒执行都必须留下带闭集原因的可观测行，
但绝不改变业务动作结果**。

1. **闭集原因**（`core/src/hooks/hook-refusal-visibility.ts`，core 自有词表，不动
   contracts）：
   - admission 拒绝：透传既有 `WorkspaceHookReasonCode`（本身已是闭集，
     如 `workspace_hooks_pending_trust` / `workspace_hooks_blocked_by_policy` /
     `workspace_hooks_revoked` / `workspace_hooks_trust_store_corrupt`…）；admission
     gate 自身抛错 = `workspace_hooks_blocked_untrusted`（既有 fail-closed 兜底）。
   - 执行失败：`hook_timeout` / `hook_cancelled` / `hook_process_failed` /
     `hook_output_invalid` / `hook_middleware_misuse` / `hook_failed`（兜底）。
     区分依据：CoreError.context.refusalKind（configured-runner-callback 在两类
     ToolExecutionFailed 上打标）+ CoreErrorType（timeout/cancelled）。
2. **注记行格式**（自撰）：`<hook 名>: <事件> 被拒: <闭集原因>; 已用引擎默认行为`。
   hook 名 = descriptor.commandDisplay ?? hook.source ?? "hook"，经
   `sanitizeHookDisplayText` 消毒截断。
3. **双通道**：
   - **本会话 transcript**：注记随该会话的生命周期事件走——HookRunBlocked
     （admission 拒绝）/ HookRunFailed 的 payload 增补运行时字段 `refusalReason` +
     `refusalAnnotation`（附加字段，不改 contracts 类型；旧投影忽略之，零破坏）。
     暗字渲染在投影/展示面（bootstrap product-projection + TUI/桌面），登记接线需求 W2。
   - **debug log（全部会话）**：每次被拒无条件 `logger.debug`，
     `event:"hook.refusal.annotation"`，携带 annotation/refusalReason/hookEventName/
     hookSource/trace 三元组——覆盖子会话、后台 runtime、无 transcript 投影的会话，
     即「其他会话只进 debug log」的 ACode 对应物。前台与 async 后台环节同规。
4. **单源纪律**：注记只在 runner 的拒绝/失败结算点生成（唯一写入路径）；触发点、
   投影面不得各自拼文案。

## 三、hook-pins 三态钉扎

**落点**：`core/src/hooks/workspace-hook-pins.ts`（记录层）+ `workspace-hook-pins-classify.ts`
（分类层）——pins 面最初并入 `workspace-hook-trust-records.ts`（trust 记录与 pin 记录
同属「授予时事实的记录层」），越过 400 行 max-lines ratchet 后按仓库拆分先例
（runtime/methods/hooks.ts → hooks-extended.ts）拆为两文件，经
`workspace-hook-trust-domain.ts` barrel 再导出，公开导入路径与 trust 记录同面。
**CLI 树（core/src/hooks）是执行面与 pins store 的
唯一写入方**；一期只落记录层 API（schema/读写/分类/等价/展示），admission/review 的
钉扎复核接线登记 W3。

1. **文件形态**：`<pinsDir>/hook-pins-<sha256(projectKey)前32hex>.jsonl`，内容为单个
   JSON 文档 `{version:1, project:projectKey, pins:{<64hex digest>→pin}}`。projectKey
   由调用方给（workspaceIdentity 或路径，遵循全局身份 key 规则
   `workspaceIdentity?.trim() || workspacePath`）。digest 键 = 该钩的
   `hookDeclarationDigest`（与 trust 记录同一 digest 谱系）。
2. **三态**：
   - `{kind:"script", path, sha256}`：声明可静态解析到项目内单一脚本文件，授予时
     内容哈希已钉住；
   - `{kind:"inline"}`：行为就在命令文本里（复合命令/管道/`-c`、`-e` 内联代码等
     不可解析为单一脚本引用）——声明 digest 本身已钉住文本，无外部文件可漂移；
   - `{kind:"unpinnable"}`：应当可解析但无法验证（路径出项目/文件缺失/非常规文件/
     硬链接 nlink>1/符号链接/读或哈希失败/变量未展开/裸 PATH 程序名）——fail-closed。
   **inline 与 unpinnable 的区分即信任粒度边界情形**：inline 是「文本即行为，可等价
   复核」；unpinnable 是「无法验证，永不等价」（见 4）。
3. **原子写 + 读时校验（fail-closed）**：写 = mkdir(0o700) + 唯一名临时文件
   （`pid-uuid8` 段，防并发写面互抢）+ rename（EPERM/EBUSY/ENOENT 瞬态有限重试，
   沿用 `core/src/ambient/queue.ts` F3 模式），文件 mode 0o600。读 = JSON.parse +
   手写形状校验（core 无 zod 依赖，先例：services hooksService 的手写局部校验）：
   version/pins 键 64hex/pin 判别联合逐字段核验，**任何形状偏差、project 不匹配、
   非 ENOENT 读错误 ⇒ invalid ⇒ 空集**；ENOENT ⇒ missing（首次授予前无记录，非错误）。
   校验用注入式 fs 面（默认 node:fs/promises），测试可全内存驱动。
4. **等价判定**（复核「授予时至今是否漂移」）：inline≡inline；script≡script 且
   sha256 相同且 path 相同（存储的 path 已是 realpath 规范化值）；**unpinnable 与任何
   pin（含 unpinnable）都不等价**——未知态永远触发重新核验/重问，这是 fail-closed 的
   三态核心。展示投影：script→sha256 前 12 hex；inline→`inline`；unpinnable→`unknown`。
5. **分类算法（一期最小，声明驱动）**：对 hook 声明 `{type, command, args?}`：
   - process：command 即脚本路径 → 验证+哈希 → script/unpinnable（argv 显式文件引用，
     永不 inline）；args 不参与 pin（脚本身份 = 路径+内容）。
   - command：先可选 `expandVariable`（插件/项目变量展开；展开抛错或未展开的 `${…}`
     残留在候选路径 ⇒ unpinnable）。含 shell 元字符（`|;&<>` 反引号 `$(` 换行）⇒
     inline。剥前导 `VAR=v` 赋值与 `env [-u VAR] [VAR=v]…` 前缀后：首 token 路径状
     （含分隔符或以 `.` 开头）→ 候选；首 token 是裸解释器名（node/python/bash/sh…）
     且首个非旗标实参路径状且无 `-c/-e/-p` 类内联代码旗标 → 该实参为候选；出现内联
     代码旗标 ⇒ inline；裸程序名（无分隔符、非解释器+脚本形）⇒ unpinnable（对齐证据：
     PATH 程序在项目可读根之外，验证不可达）。候选相对路径按 projectDir 解析 →
     realpath → 必须仍在 realpath(projectDir) 内（越界 ⇒ unpinnable）→ lstat 常规
     文件、非符号链接、nlink===1 → 开 fd 核 ino/dev 与 lstat 一致 → 从 fd 读并
     sha256 → script；任一步失败 ⇒ unpinnable。**分类函数绝不抛错**：任何异常收敛为
     unpinnable。分词取舍：引号外反斜杠按字面路径字符保留（Windows 路径是项目 hook
     声明的一等公民，bash 转义语义会吞掉 `C:\hooks\x.mjs`）；双引号内仅 `\"`/`\\`
     收敛。一期不做 O_NOFOLLOW 级 TOCTOU 硬化与 PATH 解析（登记 R4）。
6. **与波 1 services 值哈希投影的单源义务**：`packages/services/src/hooks/
   workspaceHookValueHash.ts`（波 1 G1）是对 trust 记录派生的**展示值哈希投影**
   （回答「同位置值变 vs 改名」用于 stale_digest 分类展示）；本 pins store 回答
   「声明在授予时解析到了什么、内容是否可钉」（用于执行面复核）。两者键谱系同源
   （hookDeclarationDigest），但**pins 的唯一写入方是 CLI 树执行面**；services 侧
   不得读写 pins 文件、不得重算 pin 分类，桌面展示如需 pin 信息一律经 CLI 侧投影
   通道获取（接线时另立协议面，登记 W3）。禁止出现第二写入路径或重复状态。

## 四、登记项（一期明确不做）

| # | 项 | 说明 |
| --- | --- | --- |
| R1 | 全面洋葱化 + 深层冻结 | next 包到引擎本体动作（事件结果即 hook 结果）；需全部触发点改造与 HookRunResult 语义重谈；深层冻结随同评估 |
| R2 | UI mod 面（T1-c1②③④） | 引擎生成 d.ts 类型契约（~14k 行）、`$` 沙箱、JSX/h、原子化 UI 状态——依赖 TUI 渲染架构评估，二期预研登记 |
| R3 | 热重载人同意门五态（T1-c1⑤） | 「只有人能回答」的一次性询问与闭集五态（enabled/declined/still open/off+原因）；依赖会话交互询问通道 |
| R4 | pins TOCTOU 硬化 | O_NOFOLLOW 开档、目录 symlink 复核、PATH 解析与可读根全集（launch dir 等） |
| R5 | 配置面中间件 | hooks.json/配置声明式表达 middleware（一期仅程序化注册可声明） |

## 五、接线需求（本波所有权外，报告随附）

| # | 项 | 落点 |
| --- | --- | --- |
| W1 | 短路 invocation row 收口 | bootstrap product-projection：hookCount 预扫描值与实际启动环节数在短路时不一致，row 状态按既有 flush 收口；如需精确可消费 payload 增补字段 |
| W2 | 暗字注记渲染 | bootstrap 投影 + TUI/桌面：把 `refusalAnnotation` 渲染为 transcript 一行暗字 |
| W3 | pins 复核接线 | admission/review（bootstrap workspace-hook-review-controller）：授予时写 pin、dispatch 前按等价判定复核；桌面展示经 CLI 投影通道 |

## 验收场景

1. 中间件：`next()` 续链且拿到下游合并结果；`next(e')` 下游（含进程 hook stdin）看到
   e'；不调 next 短路自答且下游零执行零事件；double-next/事后 next/身份字段改写 ⇒
   `hook_middleware_misuse` 失败 + fail-open 放行；middleware 收到冻结事件（顶层不可写）。
2. 兼容回归：无 middleware 的存量链（含全部既有测试）行为、事件序、合并结果逐一不变；
   legacy callback 收不到 next。
3. 失败可见性：admission 拒绝与各类执行失败都产出 payload `refusalReason`（闭集）+
   `refusalAnnotation`（格式行）+ debug 行；hook 显式 block 不产出 refusal 注记；
   任何被拒都不改变业务放行结果（fail-open 不回归）。
4. pins：三态 schema 校验；损坏/键不合/project 不匹配 ⇒ 空集；ENOENT ⇒ missing；
   原子写崩溃安全（临时名唯一）；分类矩阵（process/command/inline/元字符/裸名/越界/
   缺文件/未展开变量）；等价判定（unpinnable 永不等价）；展示投影三标签。
