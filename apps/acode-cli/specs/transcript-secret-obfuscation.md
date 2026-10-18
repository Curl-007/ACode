# 转录密钥混淆（WI-17：凭据不进模型上下文的最后防线）

价值提取波 3（omp T1#6）交付。语义移植自 oh-my-pi（MIT）`packages/coding-agent/src/secrets/`
与 `docs/secrets.md`；移植文件头带 MIT 署名，Bun API 一律降解为 `node:crypto` / `node:fs`。

## 背景（已核实的现状，基线：feature/omp-value-extraction 当前检出）

ACode 凭据**存储**侧已完善（credentialKeychain：macOS Keychain / Windows DPAPI /
Linux libsecret），但**发送方向零防线**：agent 读 `.env`、跑 `env`、看日志时，
API key / 密码 / 连接串会原样进入消息转录并发给模型 provider。抽验证实全仓
`obfuscat|redact|scrub` 在 core/agent+runtime 仅命中 compact-summary-model-request.ts
（与密钥无关）。omp 的对应防线：env 名字模式 + 内置凭据正则 → `$$HASH(:U/L/C/M)$$`
可逆占位符，per-install HMAC 私钥防字典还原，工具参数执行前还原。

### 已核实的 ACode 结构事实（插点选型依据）

| 事实 | 证据 |
| --- | --- |
| 所有 runtime 侧 Model 句柄唯一诞生于 `createRuntimeModel` | `core/src/runtime/methods/runtime-model.ts:14-30`；grep 全 core：turn-model.ts:25、compact-active.ts:201、steering.ts:1078、title/risk sidecar、target-completion-verification、workspace-generate-text、project-memory-agent.ts:44 全部经它；`runtime.modelFactory` 的唯一直接调用点就是 runtime-model.ts:28（subagent.ts 的 childModelFactory 只是包装 this.modelFactory，仍由子 runtime 的 createRuntimeModel 消费） |
| bootstrap 无绕过 runtime 的一次性模型调用 | `providerModelRuntime` 仅在 create-app.ts:861-869 构造并把 modelFactory 交给 runtime deps，其余只有 dispose |
| 工具内部模型调用（WebSearch/WebFetch/ReadSessionContext）用 `context.model` = turn 句柄 | call-runner.ts:115/406/431 `options?.model ?? deps.model`；turn-tools.ts:58 `state.model`（= createTurnModel 产物） |
| 出站消息含 system prompt（role:"system" 消息），工具 schema 走独立的 `ModelRequest.tools` | contracts/src/model/model.ts:33-40、protocol-types.ts:26/108-118 |
| 工具执行参数单一入口是 call-runner，输入管线 prepare→validate→resolveInput→hooks→permission→handler | core/src/tool/executor/call-runner.ts:186-491 |
| Bash/Edit/Write **无** resolveInput（只有 workflow 工具族与 write-visualization-fragment 有） | grep resolveInput handlers/ |
| ToolCallStarted 事件不携带 input；PermissionRequested 携带 executionInput（确认窗载荷） | executor/events.ts:20-49、136-170 |
| 流式 tool_input_delta 直接来自模型流（执行器之前），UI 转录的工具参数文本以模型原样为准 | runtime/methods/model.ts:336-380 |
| workflow `world.run` 绕过工具执行器，直接 `executionPort.run`；cmd 必须命中编译期声明集 | cli-workflow/src/workflow-world-read.ts:320-345 |
| workflow 脚本只能经 CreateWorkflow/AmendWorkflow/FillWorkflowHole/EvalWorkflowSnippet 等**工具参数**进入编译面 | cli-workflow/src/dynamic-workflow-run-compile.ts、dynamic-workflow-snippet-service.ts |
| 用户配置目录约定 `ACODE_DATA_BASE_DIR || HOME || homedir()` + `.acode`，CLI 面在 `<root>/cli/` | core/src/ambient/usage-ledger.ts:42-50 |
| ACode 无项目级 secrets 配置面（无 secrets.yml 等价物） | grep 全 core/config 无命中 → 按任务纪律**不发明**，收集面只接 env + 内置正则 |

## 产品规则

### R1 收集面（会话侧候选秘密，进程级快照缓存）

服务为**进程级单例**（core/src/security/secret-redaction/service.ts）。首次使用时
收集一次并缓存快照（性能纪律：不每条消息扫全 env；CLI 进程 ≈ 会话宿主，子代理 /
workflow 子代理同进程共享同一快照与还原表——这是跨会话占位符一致还原的前提）。
进程存活期内 env 视为不变（Bash 在子进程跑，不改父 env）。

候选来源（照 omp `collectEnvSecrets` / `builtinCredentialSecretEntries` 裁剪）：

1. **环境变量按名字模式**：`/(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i`
   且值长度 ≥8；按值去重。
2. **连接串密码**：任意 env 值形如 `scheme://user:password@host`（如 DATABASE_URL）
   时提取 password（无视变量名），长度 ≥8 收集；percent-decoded 形态若不同且 ≥8 也收集。
3. **内置凭据正则族**（patterns.ts，MIT 移植，裁剪到真实有效集，全部带
   literalPrefixes 快速跳过）：GitHub/GitLab/OpenAI 系 token（gh[opusr]_ / github_pat_ /
   glpat- / sk-proj- / sk-ant- / sk-）、AWS access key（AKIA/ASIA）、Google API key（AIza）、
   Slack（xox[abprs]-）、npm（npm_）、Stripe（sk|rk_(live|test)_ / whsec_）、HuggingFace（hf_）、
   SendGrid（SG.）、JWT（eyJ…三段）、Bearer 头 token、PEM 私钥块。
   **不含** omp 的通用关键词/熵规则（编码代理必须还能读 `token_expiry_seconds` 这类标识符）。
4. **HMAC 私钥自保护**：key 文件内容（若已存在或本进程创建）注册为 plain 秘密——
   模型用 Read 读到 key 文件时，出站投影把它替换成占位符，可复用的 HMAC 私钥永不进转录。
5. **不发明项目级 secrets 配置面**（ACode 无此面，见背景表末行）。

已知过度收集（omp 同款，接受）：`SSH_AUTH_SOCK` 之类名字命中 AUTH_ 的变量会被收集；
混淆可逆，代价只是转录里多一个占位符。

### R2 混淆面（出站投影，单一收口）

**唯一插点：`createRuntimeModel`**（core/src/runtime/methods/runtime-model.ts）。
为什么这里是唯一收口：

- 上表已证全部 runtime Model 句柄诞生于此（含 compact、steering、sidecar、memory、
  子代理、工具内部调用）；消息构造点分散（turn context builder / compact /
  sidecar 各自拼 messages），但**全部汇流进经此包装的 generateText/streamText 的
  ModelRequest**。
- 它比 runModelTextRequest 的 providerMessages 投影链更完整（后者只覆盖主 turn 路径，
  compact/sidecar/工具内部调用绕过它），又比 adapters 的 runner-generate/runner-stream
  更上游——adapters/src/model 发送路径是另一在飞代理的领地，本项按任务纪律选更上游
  的 core runtime 投影层，零文件冲突。
- 包装器只做 `request.messages` 投影；`tools`（schema）、`responseJsonSchema`、
  `options`、`abortSignal` 一律不动（红线：混淆绝不动工具 schema 等非用户数据面）。

投影语义：

- 深遍历 `ModelInputMessage`：content string / text block / reasoning block /
  file block 的 `text` 字段做替换；assistant 消息的 `toolCalls[].input` 深遍历字符串
  （历史回放里的工具参数同样混淆）；image/video/file 的 dataUrl 二进制载荷不动；
  resource_link 的 uri/name/title 不动（路由标识符，omp 同款边界）。
- 占位符形态 `$$HASH$$` / `$$HASH:U|L|C|M$$` / `$$FRIENDLY_HASH(:hint)$$`：
  HASH = HMAC-SHA256(per-install 私钥, 秘密原文) 前 8 字节 → 12 位 base36
  （~62 bit，防不同秘密共基碰撞）；FRIENDLY = 内置正则族名净化（[A-Za-z0-9]→大写，≤32）；
  大小写提示位照 omp `inferCaseHint`（U 全大写 / L 全小写 / C 首字母大写 / M 混合），
  帮模型保留原值形态语义（如 Edit old_string 的大小写形状）。仅大小写不同的秘密获得
  独立基（HMAC 输入是精确原文），provider 无法靠改 hint 合成另一秘密的占位符。
- 可逆混淆只对长度 ≥8 的匹配生效（omp `MIN_OBFUSCATE_SECRET_LEN`，避免吞掉普通短词）。
- **幂等**：已混淆文本再投影 = 恒等（占位符字符集与内置正则的前缀/边界锚定互斥，
  测试断言）；无秘密命中时返回**原引用**（identity，不复制消息数组——不破坏
  runModelTextRequest 等处的 `===` 恒等判断，也省分配）。
- 性能：plain 秘密合并成单个 literal 探测正则做「全文无命中」快速跳过（omp
  buildLiteralDetector 同款）；每个内置正则先做 literalPrefixes `includes` 门再跑
  regex（omp patterns.ts 注明 includes 比 lookbehind 快一个量级，整个 provider
  上下文每请求都要扫）；秘密→占位符逐条 memoize（HMAC 每秘密只算一次/进程）。

### R3 还原面（执行前还原，单一收口 + fail-loud）

**唯一插点：call-runner.ts 权限判定之后、handler 之前**
（`executionInput = permissionResult.executionInput` 之后立刻还原）。选这里的理由：

- 覆盖全部工具参数执行路径：内置工具、MCP 工具（同 registry/executor）、node_repl
  代码、workflow 脚本（CreateWorkflow 等的 script 参数在此还原后才落 draft/编译）。
- **后置**（而非入口前置）刻意保住「UI 转录保持混淆态」：PermissionRequested（确认窗）、
  PreToolUse hook 输入、PermissionDenied inputSummary 都在还原点之前，看到的都是占位符；
  ToolCallStarted 不携带 input；流式 tool_input_delta 在执行器之前就是模型原样（占位符）。
- 「确认与执行同字节」的存量不变量在此**刻意收窄**为「确认与执行同**秘密投影**字节」：
  确认窗展示的是脱敏投影，差值恰是用户自己注册的秘密原文，模型从未见过原文、无从注入
  新值——不存在确认面与执行面的语义分叉攻击面（还原表只含本进程收集的秘密，模型不可写）。
- resolveInput 顺序安全性：Bash/Edit/Write（秘密的主要载体）无 resolveInput；
  workflow 族的 resolveInput 解析 run-id/脚本 AST/路径，占位符是字符串字面量内的
  惰性 token，不影响解析；还原发生在 resolveInput 之后不会破坏其产物（不做引号/转义
  重排的变换）。

还原语义：

- 深遍历 input（对象/数组/字符串），`PLACEHOLDER_RE` 命中且**在还原表内**→ 替换为原文；
  不在表内的 `$$…$$` 形态文本**原样放行**（omp placeholder-scan 同款：无法区分
  「跨进程陈旧占位符」与「用户文本里恰好像占位符的字面量」，误杀合法编辑比放行更坏）。
- **fail-loud**：严格铸造形态（`$$[FRIENDLY_]<12位base36>(:hint)?$$`）且还原表查不到的
  候选计入 `unresolvedPlaceholders`；当该工具调用随后**失败**时，执行器在回给模型的
  modelContent 追加可纠错提示（占位符指向的秘密已不在本会话注册表——可能轮换/移除，
  请让用户重新提供或重读来源）。成功调用不追加（避免噪音）。还原函数自身抛错不静默
  吞——沿执行器既有 catch 变成结构化 ToolCallError 回模型。
- 快速路径：文本不含 `$$` 直接恒等返回（不跑正则）。

### R4 展示面（用户可见语义，spec 明示）

三个面，刻意**不做展示侧还原**（omp 有 deobfuscate-for-display，ACode 明确不搬）：

| 面 | 内容 | 语义 |
| --- | --- | --- |
| 模型创作面（assistant 文本/推理、工具参数、workflow 脚本、确认窗、hook 输入） | 占位符态 | 用户自己的秘密不回显原值是特性：转录/确认/事件流全链一致脱敏 |
| 本地事实面（用户输入原文、工具执行结果原文、会话 JSONL 落盘、本地日志） | 原样（与今天一致） | 混淆是**出站投影**，不改本地状态；磁盘上的秘密属存储面（credentialKeychain/磁盘加密的既有威胁模型），本项不扩大也不缩小 |
| provider 出站面 | 全占位符态 | 本项的防线本体 |

### R5 HMAC 私钥生命周期

- 路径 `<dataRoot>/cli/security/secret-placeholder.key`（dataRoot 镜像 usage-ledger 的
  `ACODE_DATA_BASE_DIR || HOME || homedir()` + `.acode` 约定）。
- 内容 43 字符 base64url（crypto.randomBytes(32)），`/^[A-Za-z0-9_-]{43}$/` 校验。
- **惰性创建**：只有第一次真正铸造占位符时才落盘（omp secretEntryNeedsPlaceholderKey
  纪律——无活跃秘密的会话不写 key 文件，避免留下可被工具读取的空转密钥）。
- 创建用 `wx`（O_EXCL）+ mode 0600；EEXIST 竞态读赢家并校验。**win32 语义如实**：
  NTFS 忽略 POSIX mode 位，0600 在 Windows 上不产生 ACL 收紧（用户目录继承 ACL 是
  既有事实面）；单测只在非 win32 断言 mode，win32 断言文件存在与内容合法并记录差异。
- 不可持久化（只读目录等）→ warn（不含 key 值）+ 进程级 ephemeral key 降级：
  本进程内仍可逆，占位符跨重启不稳定（omp 同款降级语义）。
- **永不发送、永不进日志**：key 值只出现在 HMAC 计算与自身文件的读写里；服务日志
  只含布尔/计数/路径。key 文件内容按 R1-4 注册为 plain 秘密（读到它的外发文本也被占位）。
- 同步 IO 说明：key 读取用 sync fs（一次/进程，43 字节）。偏离「异步文件 IO」通则的
  理由：`Model.streamText` 契约要求**同步返回** AsyncIterable（异步惰性初始化会把内层
  调用推迟到首次 next()，脱离 runWithModelInvocationContext 的 ALS 作用域，破坏调用上下文
  传播）；omp 的 getSecretPlaceholderKeySync 是同型先例。除这一次 43 字节读取外无同步 IO。

### R6 开关矩阵

| ACODE_SECRET_REDACTION | 行为 |
| --- | --- |
| 未设置（默认） | **启用**（最后防线默认在场） |
| `0` / `false` / `off`（大小写不敏感） | 禁用：投影恒等、还原仍执行（存量占位符照常还原——开关只关「新混淆」，不关「已混淆文本的还原」，防止关掉开关后历史里的占位符坏掉工具执行） |
| 其他任意值 | 启用（宽松失败方向：安全特性不因脏值静默关闭） |

开关在单例初始化读一次（进程级），不做运行中翻转（避免半混淆状态）。

### R7 红线：占位符回流执行的路径枚举（全量）

占位符唯一来源是**模型创作**（模型只在出站投影后见过占位符）。逐路径给出还原点或
「不收混淆文本」论证：

| # | 路径 | 处置 |
| --- | --- | --- |
| 1 | 工具调用参数（Bash/Edit/Write/Read/Task/SendToSession/agent_teams_*/node_repl code/浏览器脚本…） | **还原点**：call-runner 权限后（R3）。MCP 工具同 executor，同点覆盖 |
| 2 | workflow 脚本参数（CreateWorkflow script / AmendWorkflow / FillWorkflowHole fill / EvalWorkflowSnippet code） | **还原点**：同 #1（脚本是工具参数；还原后才落 draft、编译、执行）——world.run 的 cmd/argv 是已还原脚本的字面量 |
| 3 | workflow `world.run`（cli-workflow 直接 executionPort.run，绕过 executor） | **论证**：脚本仅经 #2 的工具参数进入编译面，占位符已在 executor 还原；world 门面只有 glob/read/grep/git-*/run（无 write），不新增模型文本→执行的旁路。残余风险见 R8-3 |
| 4 | PreToolUse/PostToolUse hook 输入 | **论证**：hook 收到的是占位符（惰性数据，非执行体）；hook 的 updatedInput 回流 executor 管线，在 #1 还原点之后进 handler。限制见 R8-4 |
| 5 | hook additionalContexts / PostToolUse 注入文本 → 模型 | **论证**：进的是转录（模型侧），下次出站投影幂等放行占位符；不回执行面 |
| 6 | 权限确认窗 modifiedInput（用户编辑） | **论证**：用户看到并编辑的是占位符文本；回流 executor 后同 #1 还原 |
| 7 | steering / CommandInbox / 用户消息 | **论证**：用户创作，不含占位符（用户键入原文；出站投影负责混淆） |
| 8 | compact 摘要 / 投机压缩产物（模型创作，含占位符）→ 替换历史 → 回放 | **论证**：回放进出站投影幂等放行；模型再引用其中占位符时经 #1 还原（同进程还原表存活；跨重启见 R8-2） |
| 9 | 子代理/舰队/teams 消息（Task prompt、SendToSession、mailbox、hand-back 报告） | **论证**：发送侧是工具参数（#1 还原，子代理拿到原文）或模型创作文本（进转录，出站幂等）；子代理同进程共享还原表，其自身工具调用走子 runtime 的同一 executor 还原点 |
| 10 | memory 写入（memory agent 产物落盘）/ 记忆召回注入 reminder | **论证**：召回文本进消息 → 出站投影混淆（原文）或幂等放行（占位符）；memory 落盘文本含占位符时是惰性数据，再入模型上下文仍走出站投影，再执行仍走 #1 |
| 11 | ReadSessionContext / SessionSearch（读其他会话持久化转录，含原文+占位符） | **论证**：结果进当前转录 → 出站投影统一处置；不直达执行面 |
| 12 | 工具执行结果（Bash 输出等）→ 事件流/JSONL/UI | **论证**：本地事实面（R4），从未被本地混淆，无占位符回流问题；出站时经投影混淆 |
| 13 | providerExecuted 工具调用（provider 原生执行） | **论证**：参数不经本地执行面 |
| 14 | 遥测/日志 | **论证**：telemetry 拿 canonicalToolCall（占位符形态）；执行器日志不含 executionInput 原文；服务自身日志只含计数/布尔（R5） |

### R8 已知限制（如实登记）

1. **收集面边界 = env + 内置正则**（omp 同款）：文件里的应用秘密（.env 内容、配置里
   的随机串）若既不在 env 也不匹配内置正则族，不进转录防线。ACode 无项目级 secrets
   配置面，按任务纪律不发明。
2. **跨进程重启 + 秘密轮换**：还原表是进程态。历史里的占位符若在重启后对应秘密已不在
   env/正则面，无法再还原（放行 + 失败时 fail-loud 提示）。历史中的**工具结果原文**
   不受影响（本地从未混淆，重启后出站重新混淆）。
3. **world.run 残余风险**：脚本若 `files.read` 到含占位符的磁盘文本（如会话 JSONL）并
   拼进 world.run argv，占位符按字面执行（命令坏，fail-loud 于命令退出码）。不加
   cli-workflow 插点（所有权纪律 + 路径极contrived）；如未来实测出现，再在 worldRun
   加一行还原。
4. **hook 内容匹配限制**：PreToolUse hook 看到占位符而非秘密原文，按原文内容匹配的
   守卫规则失效；按占位符形态（`$$…$$`）匹配仍然可行。
5. **schema 前置校验边界**：还原在 validateInput/schema 校验之后；若某工具 schema 对
   字符串加了「必须是真实凭据前缀」类 pattern 约束，占位符会被 schema 拒（现注册工具
   无此约束）。
6. **win32 key 文件权限**：见 R5（NTFS 无 POSIX mode 语义）。
7. **进程 env 快照**：会话中途 export 的新秘密不被收集（进程 env 事实不变；omp 同为
   session-startup 快照）。

## 状态与路径图（所有者及事件顺序）

```text
收集（一次/进程，快照缓存）                       还原表（进程级，唯一所有者=服务单例）
  env 名字模式 + 连接串密码 ─┐                      ┌──────────────────────────┐
  内置凭据正则族（惰性铸造）─┼→ SecretRedactor ────→ │ placeholder → secret     │
  key 文件内容自保护 ────────┘   （HMAC 占位符铸造）  │ （铸造即登记，幂等）      │
                              key: <dataRoot>/cli/  └──────────────────────────┘
                              security/secret-       ↑ 还原（查表）      ↓ 混淆（替换）
                              placeholder.key        │                  │
                                                     │                  │
出站（每请求）：                                     │                  │
  各消息构造点(turn/compact/sidecar/memory/工具内)    │                  │
        └→ ModelRequest.messages                     │                  │
             └→ [唯一收口] createRuntimeModel 包装的 generateText/streamText
                  ├─ tools/schema/二进制载荷：不动 ──┼──────────────────┘
                  └─ messages 深遍历文本 → 占位符 ───┘（provider 只见占位符）

回流（模型创作占位符）：
  模型流 → tool_input_delta(占位符,UI 原样) → toolCalls
    └→ call-runner: prepare→validate→resolveInput→hooks(占位符)→permission/确认窗(占位符)
         └→ [唯一还原点] 权限后 executionInput 深遍历还原 → capability/timeout/handler(原文)
              └→ 失败且存在严格形态未解析占位符 → modelContent 追加 fail-loud 纠错提示
  workflow 脚本参数：同还原点（脚本先还原后编译）→ world.run 收原文
  UI 转录/事件流/JSONL：模型创作面保持占位符态（R4，无展示侧还原）
```

## 所有权与插点（最小 diff）

| 文件 | 角色 |
| --- | --- |
| `core/src/security/secret-redaction/{patterns,placeholder,collect,key,redactor,service,index}.ts` | 新模块（收集/混淆/还原/密钥），MIT 署名头，每文件 ≤400 行 |
| `core/src/runtime/methods/runtime-model.ts` | 出站唯一插点：createRuntimeModel 返回值加脱敏包装（bind 透传） |
| `core/src/tool/executor/call-runner.ts` | 还原唯一插点：权限后还原 executionInput；失败路径追加 fail-loud 提示 |
| `apps/acode-cli/specs/transcript-secret-obfuscation.md` | 本 spec |
| `core/tests/secret-redaction-*.test.ts` | 测试 |

不改：adapters/src/model/**（另一在飞代理领地）、packages/shared、contracts、
package.json、knip、baseline、i18n、cli-workflow（R7-3 走论证）。core barrel
（index.ts）不加导出（插点都在 core 包内，相对路径引用）。

## 验收场景

1. **patterns 匹配矩阵**：每个内置正则真阳性命中、近邻假阳性拒绝（`token_expiry_seconds`、
   短于 8 的匹配、边界粘连）；env 名字模式与连接串密码提取（含 percent-decoded）矩阵。
2. **可逆性**：混淆→还原逐字节相等（plain / 正则族 / 深结构 / U-L-C-M 四 hint /
   PEM 多行块）；幂等（二次混淆恒等）；干净文本 identity（同引用）。
3. **key 生命周期**：首铸落盘、非 win32 断言 0600、win32 如实记录；EEXIST 复用；
   损坏文件 → ephemeral 降级不抛；key 值不出现在任何日志/输出；key 文件内容被 Read
   时出站文本无原值。
4. **还原路径**：深遍历对象/数组还原；未知 `$$…$$` 放行；严格形态未解析计数；
   禁用开关下还原仍工作（R6）。
5. **零泄漏断言**：构造含秘密转录（user/tool/assistant/toolCalls input 四态），
   出站投影后 JSON 全文不含任何秘密原值；UI 面（流式 delta / 确认窗载荷同源的
   executionInput 投影前形态）不回显原值；tools schema 原样。
6. **存量零回归**：core 包全部测试通过；`pnpm typecheck`（core）真实通过；
   architecture:check --changed 无新违例。
