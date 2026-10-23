# Agent 引擎外部槽位恢复：jcode（External Engine Slot Restoration）

> **文档状态**：spec（先于实现）。**本 spec 推翻** [`agent-engine-external-slots-removal.md`](agent-engine-external-slots-removal.md)（2026-10-02 实施）的「ACode 只有一个 agent 引擎」裁决。
> **实施依据**：[`apps/acode-cli/specs/jcode-agent-bridge.md`](../../../apps/acode-cli/specs/jcode-agent-bridge.md)（shim 已实现并经 L0/L1/L2 三层真实客户端栈验证）、其附录 A.9（`jcode-bridge` 已在 `acode.cjs` bundle 内）、A.10（桌面 spawn 决策实证）。

## 背景与决定

上一轮 spec 删除三个外部槽位（codex/opencode/gemini）的理由是它们**自引入起 `implemented: false`**——会话协议适配器从未实现、UI 无选择入口、不随包分发。那个理由对这三个仍然成立。

`jcode` 不同：它的会话协议适配器**已实现并验证**——`acode jcode-bridge --stdio` 子命令在 ACode CLI 内，北向复用 v4 网关、南向 spawn jcode 跑 ACP，且已经真实客户端栈端到端验证（L1 `ACodeAgentProcessManager`、L2 `createACodeAgentService`，均真 jcode + 真模型跑通一轮带工具调用的会话）。因此**恢复一个外部槽位是有实现支撑的**，不是重新引入空槽位。

**产品决定**：引擎联合恢复为 `"glm" | "jcode"`，用户可在桌面 Settings 显式选择会话引擎；缺省与旧数据仍归一 native `glm`。

## 产品规则

### R1 引擎注册表

- `ACodeProvider` = `"glm" | "jcode"`；`ACODE_AGENT_ENGINE_IDS = ["glm","jcode"]`（native 首位，作为缺省锚点）。
- jcode 描述符：`native: false`、`label: "jcode"`。
- **不复刻被删的 `implemented` / `usesApprovalPolicy` 字段**：上一轮删它们是因为空槽位需要标记「未实现」；jcode 有实现，`native:false` 已足够区分解析路径。不重新引入无人消费的字段。
- **不恢复 `externalEngineCommandResolver.ts`**：它解析的是「外部引擎二进制本身」（codex/opencode/gemini CLI 直接 spawn）。jcode 的形态是 `acode.cjs jcode-bridge --stdio`——spawn 的仍是 ACode 自己的 CLI bundle，由 shim 内部再 spawn jcode。故复用现有 bundled / Electron-runtime 候选链，只换 `spawnArgs`（见 R3）。

### R2 权限模式诚实收敛（最重要的一条）

jcode 后端**没有任何权限审批回路**：ACP 入站 dispatch 表无 permission 方法、harness API 桥源码明写 `never emits permission_request`、`jcode-config-types` 无 `approval_mode` 类配置、实测写文件零审批（见 jcode-agent-bridge.md R4-1 与 spike §3.1/§4.1 的三方印证）。

- `supportedPermissionModes: ["yolo"]`、`defaultPermissionMode: "yolo"`。
- **理由**：`yolo` 是 ACode 现有档位中唯一诚实描述「无逐动作确认、直通执行」的语义。声明 `build`/`edit`/`plan` 会让 UI 呈现「有权限治理」而实际没有——那是谎报，比不提供选择更危险。
- **连带的安全后果（有意为之，不额外加机制）**：`getBotSelectablePermissionModes("jcode")` 经 `filterBotSelectablePermissionModes` 剔除 `yolo`（`bot-remote-guard.ts:24` 的 `BOT_REMOTE_FORBIDDEN_PERMISSION_MODES`）后**得到空集**。于是远程 bot 入口自动无法选择任何 jcode 权限档——这正是 `bot-remote-guard.ts` P0-3 不变量要的（「远程聊天一条消息 → 主机任意执行」不可接受）。**bot 远程驱动 jcode 由既有天花板机制自动禁用，不需要新增守卫代码**，也不得为「让 bot 能选」而把 jcode 的模式改成 `dontAsk` 之类不被剔除的档位（那是谎报 + 破坏 P0-3）。
- 桌面本地仍可选 jcode（用户在机器前显式操作，与 P0-3 的信任边界一致）。

### R3 运行时描述符与命令解析

`getEngineRuntime(engineId)` 恢复按 engineId dispatch（当前恒返回 native）。jcode 描述符与 glm **共用同一 bundle 与同一资源目录**，只有 spawn 参数不同：

| 字段 | glm | jcode | 说明 |
| --- | --- | --- | --- |
| `spawnArgs` | `["app-server","--stdio"]` | `["jcode-bridge","--stdio"]` | **唯一实质差异** |
| `bundledResourceDir` | `glm` | `glm` | 同一 bundle（A.9：jcode-bridge 是 acode.cjs 的子命令） |
| `nodeBundleEntryFile` | `acode.cjs` | `acode.cjs` | 同上 |
| `binaryKind` / `resolveEntrySegments` | native-binary / `acode-agent(.exe)` | 同 | 打包态桌面走 node bundle 路径，原生二进制候选对 jcode 无意义但保留形状 |
| `binaryEnvVar` | `GLM_BINARY_PATH` | `JCODE_BINARY_PATH` | 见 R5：仅 dev/远端生效，打包态被 env-gate R1 忽略 |
| `nativeConfigDir`/`FileName` | `.acode/cli` / `config.json` | 同 | shim 复用 ACode CLI 的配置发现 |
| `missingBinaryMessage` | glm 文案 | jcode 文案 | 诊断可读性 |

`resolveDefaultACodeAgentCommand` 恢复 `!engine.native` 分支：jcode 走 bundled（dev `dist/acode.cjs`）→ Electron-runtime（打包 `resources/glm/acode.cjs`）候选链，args 用 `runtime.spawnArgs`。**关键**：这两条分支已带 `storagePreparationEntry` + `supportsStorageStartup`，所以 jcode 引擎天然满足桌面 Host 的 storage 准备要求（与 A.8 的 env 覆盖通道不同——那条通道不带这两个字段，已由 R6 让 storage 入口独立解析，两者互不干扰）。

### R4 engineId 贯通

`startClient`（`acodeAgentProcessManager.ts:1450-1451`）当前把 engineId 硬编码为 `"glm"`。恢复为：`params.engineId` 经 `resolveAgentEngine` 归一后使用（未知/缺省仍回退 native，保持旧数据兼容）。

贯通链路（缺哪环补哪环，不新建平行通道）：

```
Settings（新增 agentEngine 字段，持久化）
  → Host 读设置 → createACodeAgentService({ resolveAgentEngine })  ← 新增 resolver 注入（照 resolveToolSearchMode / resolveScriptWorkflowMode 的既有形状）
  → acodeAgentService.getClient / getReadOnlyClient 构造 params 时带上 engineId
  → processManager.getClient({workspacePath, workspaceIdentity, engineId})
  → startClient 用归一后的 engineId 调 commandResolver
```

`ACodeAgentProcessManagerOptions` 已有 `commandResolver` 注入点，engineId 经 `getClient` params 传入即可，**不需要改 process manager 的构造签名**。

### R5 jcode 二进制发现（自动发现为主，Settings 是可选覆盖项）

**2026-10-24 修订**：初版把 Settings 路径定为**必填**，理由是桌面 GUI 的 PATH 不可靠。实测暴露其代价：用户选 jcode 后必须手填路径才能用（真实用户反馈「为什么没法用」）。修订为**自动发现为主**——jcode 官方安装脚本的默认落点是确定性的，shim 直接按落点探测即可覆盖绝大多数安装；Settings 路径降级为**可选覆盖项**（非默认安装或发现失败时手填）。

**为什么 PATH 单独不够**（自动发现的动机）：桌面是 GUI 应用，继承的 `PATH` **不含 login shell profile / rc 的条目**；jcode 安装脚本（`install.sh:440-457`）把安装目录写进 rc 的 `export PATH=...` 行，该行对 GUI 不可见。而 `runtimeLoginShellEnvCapture` 采集的 PATH 补丁只注入**工具执行** env（`runtimeCommandEnv.ts`），**不注入 agent spawn env**（`acodeAgentProcessManager.ts` 只合入 sanitize 后的 process.env + workspace identity + lane 策略 + NODE_OPTIONS 护栏）。故打包态桌面里 shim 靠 PATH 找 `jcode` 不可靠，必须加常见安装位置一层。

**发现优先级（shim 侧 `resolve-binary.ts`）**：

1. `--jcode-binary` CLI 参数（dev/远端通道，最高）。
2. `ACODE_JCODE_BINARY_PATH` env —— Host 从 Settings.`jcodeBinaryPath` 装配注入的**可选覆盖项**。
3. **常见安装位置**（`jcodeWellKnownCandidates`，按 jcode 官方安装脚本默认落点，证据：`install.ps1:5`「installs it to %LOCALAPPDATA%\jcode\bin」、`install.sh:146-148`）：
   - win32：`%LOCALAPPDATA%\jcode\bin\jcode.exe`；
   - Unix/macOS：`$HOME/.local/bin/jcode`、`/usr/local/bin/jcode`。
   逐个 `fs access` 探测，命中即返回（短路）。
4. PATH 查找（`whichOnPath`，terminal/CI 等 PATH 可见场景）。

四层皆无 → shim 以明确错误退出（错误文案列出全部查找位置 + Settings 指引），不发半死 storage 帧，**不静默回退 glm**。

- Settings 的引擎区块在选 jcode 时显示路径输入框为**可选覆盖**：留空即走自动发现（提示文案说明发现范围与何时需手填）；填了即覆盖自动发现。空串经 `normalizeSettingsPatch` 归一为 undefined（支持 Reset 回自动发现）。
- 该路径经 spawn env 传给 shim，**不经 `ACODE_AGENT_SERVER_COMMAND`**（那个通道打包态被 env-gate R1 禁用，且 R6 已确立 storage 入口不吃它）。
- 与 `agent-command-env-gate.md` R3 的裁决一致：「接入会话时若需自定义路径，走 Settings 显式配置（用户可见动作），不恢复 env 通道」。`JCODE_BINARY_PATH` 这个 `binaryEnvVar` 只在 dev/远端非打包态生效，打包态被同一门禁忽略。
- `resolve-binary.ts` 保持**纯函数**（不碰 fs/env）：候选拼装 `jcodeWellKnownCandidates(platform, env)` 与存在性探针 `PathProbe` 都由 entry.ts（I/O 边界，`fs/promises.access`）注入，解析规则可单测、CI 常绿。

**env 契约（apps/acode-cli/AGENTS.md 要求新 env 先在 spec 定义）**：

| env | 定义 | 优先级 | 错误行为 |
| --- | --- | --- | --- |
| `ACODE_JCODE_BINARY_PATH` | jcode 可执行文件绝对路径，由 **Host 从 Settings 的 `jcodeBinaryPath` 装配后注入** agent spawn env（**可选覆盖项**，留空即不注入） | shim 侧：`--jcode-binary` CLI > 本 env > 常见安装位置 > PATH 查找 | 四层皆无 → shim 以明确错误退出（含全部查找位置 + Settings 指引），不发半死 storage 帧 |

**strip-then-inject 纪律（安全）**：`ACODE_JCODE_BINARY_PATH` 加入 `sanitizeACodeRuntimeEnv` 的剔除清单（`packages/shared/src/runtimeEnv.ts`），与 `NODE_OPTIONS`、`OTEL_*` 同款处理——**继承的用户级 env 值一律剔除，只认 Host 从 Settings 装配后注入的权威值**。理由：若 shim 直接吃继承 env，则用户级 env 注入（launchctl setenv / shell profile / Windows 用户环境变量）可把 jcode 指向攻击者二进制，与 `agent-command-env-gate.md` R1 同一威胁模型。剔除后：
- **打包态**：只有 Settings 值生效（Host 注入），env 注入无效——符合 R3「不恢复 env 通道」。
- **dev/独立 CLI/远端**：开发者仍可用 `ACODE_AGENT_SERVER_ARGS_JSON` 带 `--jcode-binary <path>`（CLI 参数优先级最高，且该通道本就受 env-gate R1 管辖：dev 生效、打包态忽略）。L1/L2 真实客户端栈测试走的正是这条，故剔除 env 不影响测试。

测试覆盖：`apps/acode-cli/tests/jcode-bridge-resolve-binary.test.mjs`（R5 四层优先级 + 候选拼装 + probe 短路，假 probe/which 全注入、CI 常绿）+ `packages/services/tests/storage-entry-env-gate.test.mjs`（R6 不变量）+ 引擎贯通链测试（见验收场景 3/7）。

### R6 持久化与归一

- `acodeAgentProviderSchema`（`acode-agent-policy.ts:17-20`）当前 transform 是 `value === "glm" ? "glm" : undefined`——会把 `"jcode"` 静默归一成 undefined。改为 `isAgentEngineId(value) ? value : undefined`，与 `normalizeAgentProviderToACodeAgent` 同口径。
- `taskIndexRepo.ts:248` 的 `mapRowToTaskMeta` 同款归一，同改。
- **写入侧本轮不改（重要，与起草时的判断相反）**：`acodeTaskServiceAdapter.ts:215` 的 `GLM_PROVIDER` 与 11 处 `provider: GLM_PROVIDER` **保持不动**。核实后发现写入侧与过滤侧是**同一个常量口径**（`listTasks` 等 10 处过滤点传的就是 `GLM_PROVIDER`，`taskIndexRepo.ts:50` 注释自陈「列表按当前 runtime provider 过滤」），故当前状态自洽：jcode 会话的 task 以 `provider="glm"` 落库、也按 glm 过滤 → **task 列表可见、不会消失**，只是 provider 列未记录真实引擎。
  - **为什么不能只改写入侧**：改成写真实引擎而不改 10 处过滤点，jcode task 会以 `provider="jcode"` 落库但被 `provider="glm"` 过滤掉——**在侧栏列表里直接消失**，比现状更糟。
  - **为什么不同时改两侧**：`snapshotToMeta`（`:1287`）是同步函数、3 个调用点中 `snapshotToACode`（`:1508`）也是同步，改成 await 设置读取会扩散异步化；且用「全局当前引擎」近似仍有语义裂缝（建 jcode 会话 → 切回 glm → 归档时历史 jcode task 被错标）。**正确解是 per-session engineId 落进 session record**，属 DB schema 改动，按 AGENTS.md「修改数据库结构前应与模块维护者确认」，本轮不做。
  - **后果登记**：jcode 会话的 task 在索引里标为 glm。影响面限于 provider 列的记录精度，不影响 task 列表可见性、恢复或执行。若后续要精确记录，需连带 session record 加字段 + 写入/过滤两侧同步改 + 数据迁移裁决。
- 旧数据（`provider:"codex"/"opencode"/"gemini"`）**不受影响**：它们不在新 IDS 里，继续归一为 undefined → 消费方回退 native。`packages/ui/test/nonCliAcpRetirement.test.ts:33-39` 的断言仍成立（**切勿把这三个值加回 IDS**，否则该守护测试判红）。
- Settings 的 `agentEngine` 字段是**净新增**（`validationAppSettings.ts` 当前无任何 engine 键）；缺省 `glm`，缺失即回退 native。

### R7 UI 与文案

- 恢复设置页「Agent 引擎」区块（挂载点：被删的 `EngineSection.tsx` 原属 `agentCapabilities` group，见 `settings/settingsPageConfig.ts:89-124`），但**从只读展示改为可选择**：引擎单选 + jcode 选中时的二进制路径输入 + 该引擎的权限模式说明（明示 jcode 无权限弹窗）。
- locales：补 `engine.jcode.name` / `engine.jcode.description`，**并补回 `engine.glm.name` / `.description`**——这两个键在上一轮被删，而 `BotEngineCard`（`packages/ui/src/BotsDialog/BotSummaryCard.tsx:239`）经 `botsUi.ts:69-70` 按 `engine.${id}.name` 拼 key 消费，**当前是死键**（现状既有缺陷，本次一并修）。
- jcode 的权限模式文案复用已保留的 `engine.permissionMode.yolo`，无需新增。
- Partial Record 消费点（`display-help.ts:5/19`、`PermissionDialog.tsx:171`、`botsService.ts:1542`）加成员后不编译失败，但 jcode 缺键会回退到直出 id；按需补 jcode 键或确认回退可接受。

## 接口变化

| 接口 | 变化 |
| --- | --- |
| `ACodeProvider`（acode-task-types-core:40） | `"glm"` → `"glm" \| "jcode"` |
| `ACODE_AGENT_ENGINE_IDS` / `ACODE_AGENT_ENGINE_REGISTRY` | 加 `"jcode"` 与对应描述符（`native:false`，模式集 `["yolo"]`） |
| `getEngineRuntime`（acode-agent-runtime:57） | 恒返回 native → 按 engineId dispatch（恢复引擎作用域 runtime 表） |
| `acodeAgentProviderSchema` / `taskIndexRepo.mapRowToTaskMeta` | `=== "glm"` 归一 → `isAgentEngineId` 归一 |
| `getACodeAgentAvailableModes`（acode-agent-model-state:65） | `void engineId` 恒 native → 引擎作用域（jcode 返回 `["yolo"]` 对应档位） |
| `resolveDefaultACodeAgentCommand`（acodeAgentProcessManager:598） | 恢复 `!engine.native` 分支，jcode 走 bundled/Electron 候选链 + `runtime.spawnArgs` |
| `startClient`（:1450-1451） | engineId 硬编码 `"glm"` → 用归一后的 `params.engineId` |
| `CreateACodeAgentServiceOptions` | 新增 `resolveAgentEngine?`（照 `resolveToolSearchMode` 形状） |
| `ACodeAgentCommandResolverContext.engineId` | 已存在（形状保留），本次真正被消费 |
| Settings schema | 新增 `agentEngine`（枚举，缺省 glm）+ jcode 二进制路径字段 |
| locales | 补 `engine.jcode.*`；**补回 `engine.glm.*`**（当前死键） |

**不恢复**：`externalEngineCommandResolver.ts`、`implemented`/`usesApprovalPolicy` 字段、bot `/engine` 聊天命令（UI 的 `BotEngineCard` 已是选择入口，`BOT_ACODE_PROVIDER_OPTIONS` 派生自注册表会自动含 jcode）。

## 验收场景

1. 类型双向绑定：`ACodeProvider` 与 `ACODE_AGENT_ENGINE_IDS` 任一侧漏 jcode 即编译失败。
2. `resolveAgentEngine("jcode")` 返回 `native:false` 描述符；`resolveAgentEngine("codex")`/`undefined`/`null` 仍回退 glm（旧数据兼容）。
3. `isNativeAgentEngine("jcode") === false`；命令解析走 `!engine.native` 分支，args 为 `["jcode-bridge","--stdio"]`（dev）/ `[bundle, "jcode-bridge","--stdio"]`（打包态），且**带 `storagePreparationEntry`**（桌面 storage 准备不受影响，R6 的正交性保持）。
4. `acodeAgentProviderSchema.parse("jcode") === "jcode"`；`parse("codex") === undefined`；`parse("glm") === "glm"`。
5. `getBotSelectablePermissionModes("jcode")` 返回**空集**（yolo 被 bot 天花板剔除）→ bot 远程入口无法选 jcode 权限档；`getBotSelectablePermissionModes("glm")` 行为不变。
6. **task 索引口径自洽**（本轮范围，见 R6「写入侧不改」）：jcode 会话产生的 task 仍以 `provider="glm"` 落库、也按 glm 过滤，故 **task 列表可见、不消失**；`taskIndexRepo.mapRowToTaskMeta` 的归一改用 `isAgentEngineId`（已改），使未来若写入真实引擎也能正确读回。provider 列暂不记录真实引擎，此限制已在 R6 登记（正确解需 per-session engineId + DB schema 改动，另行立项）。
7. 自动发现：jcode 装在默认位置（`%LOCALAPPDATA%\jcode\bin` / `~/.local/bin`）且 Settings 路径留空 → 会话正常创建（shim 按落点探测命中，无需手填）。Settings 填了非默认路径 → 覆盖自动发现。四层全落空 → 会话创建明确报错（含全部查找位置与 Settings 指引），**不静默回退 glm**。
8. 真实 Electron 端到端（**已实测通过**，`packages/desktop/scripts/e2e-jcode-engine.mjs`，2026-10-24 Windows dev 态）：隔离 profile seed 真实 provider 登录态 + `setting.json{agentEngine:"jcode", jcodeBinaryPath}` → 断言 Host spawn preflight args 含 `jcode-bridge`（注册表路径，**不设** `ACODE_AGENT_SERVER_COMMAND` env 覆盖）→ `ACode agent warmup ready`（agent init 越过 legacy -32601 降级链）→ storage 准备不受阻（R6）→ provider 就绪门禁放行。5/5 核心断言 PASS；shim stderr 的 `telemetryOff`/`southbound ready` 在生产日志面结构性不可见（Host 对子进程 stderr 走 debugLog 不落盘），记 SKIP，由 L2 承担。
   - **会话轮次的完整投影**（turnHeader/userInput/toolCall/assistantText + 真模型收口 `completedSuccess`）在 **service 层** L2（`packages/services/tests/jcode-bridge-service-layer.test.mjs`，真 jcode + 真模型，20.6s 实测通过）验证；Electron e2e 未驱动 renderer UI 渲染，该子项如实标注为 service fan-out 层覆盖，非 renderer 层。
   - **本轮真实 Electron e2e 暴露并修复的 Host 侧缺陷**：`enqueueInteractionPreferenceSync` 第一条 push（`workspace/updateInteractionPreferences`）缺 method-not-found 降级守卫（同函数第二条 modelIo push、offPeak、dynamicWorkflow 三处都有），shim 对 legacy 方法回的 -32601 直接 reject 整条 `interactionPreferencesReady` → 杀死 getClient → init 失败。同款缺口在 `syncAccountProviderConfigToClient`（`provider/updateAccountConfig`，createSession 前置）。修复：两处补齐与既有三处同款的 `isProtocolMethodNotFoundError` 降级；shim 侧不改（-32601 是诚实的「不支持」，spec「legacy 不做」）。CI 常绿守卫：`packages/services/tests/agent-engine-legacy-degradation.test.mjs`（spawn 真 shim + 假 jcode 二进制，北向先于南向启动故不依赖真 jcode；mutation 验证过：删守卫即判红）。
9. 守护测试不判红：`packages/ui/test/nonCliAcpRetirement.test.ts`、`packages/services/test/nonCliAcpRetirement.test.ts`、`agent-command-env-gate.test.mjs`、`storage-entry-env-gate.test.mjs`（R6 不变量：storage 入口仍不吃 env）。
10. jcode 引擎会话的 `capabilitiesQuery` 返回 `independentPlanState: false`（shim dispatch 既有行为），UI 据此降级 plan 模式而非报错。

## 不在本项范围

- jcode 后端的权限审批（**不可能做**，见 jcode-agent-bridge.md R4-1）；三域 checkpoint / 手机远控 snapshot-replay / workflow / swarm / artifact 面板（jcode 无对等物，相关 v4 命令显式 `failed`）。
- ACode 凭据桥（OS 钥匙串 → jcode）：依赖 jcode harness API 的 `set_api_key`，Windows 受阻，独立立项。
- 恢复 codex/opencode/gemini 三个空槽位（它们仍无实现，恢复即重新引入 `implemented:false` 的谎言）。
- Unix 侧桌面验证（本轮实测环境为 Windows）。

## 已知边界与回滚

- jcode 引擎的会话在 ACode 侧**无权限治理**（仅 jcode 自己的 bash 反射门 + catastrophic 绝对拒绝提供部分保护，文件写操作零门控）。这是产品级限制，必须由 Settings 文案明示，不得让用户误以为选了 jcode 还有 ACode 的权限弹窗。
- jcode 的共享 daemon 生命周期不受 ACode 控制（`acp.rs` 硬编码 `ServerLifetime::Shared`，setsid 脱离父进程，靠自身 300s idle 超时回收）——「kill agent 即重置会话」在 jcode 后端不成立，见 jcode-agent-bridge.md A.6。
- 回滚 = revert 对应提交；`agentEngine` 设置字段缺失即回退 native，旧持久化数据无需迁移（与上一轮 spec 的归一口径一致）。
