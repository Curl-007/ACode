# CLI 与运行时专项审查

审查日期：2026-10-08。源码基线：`f4da4b0e1e3b1c35a805b95f6c1061a09317b38b`。本报告保留原始源码审查、manifest、spec 和实际复现证据；2026-10-09 已完成一轮 CLI 修复复核。审查范围为 `apps/acode-cli` 的 CLI、bootstrap、core、contracts、adapters、TUI，以及 `packages/acode-server-cli` 的服务进程生命周期。两套 workflow 引擎的具体结论见同目录专项报告。

2026-10-09 补充完成 CLI-04 的真实双 App + 双 JSONL 日志复现，并已落地配置并发、ACP cwd 和 session 审计路由修复。

**CLI-01..05 的关键执行边界已修复；CLI-06 继续收窄结构边界。** CI/release 覆盖 CLI entry、真实源码 lint 和 Renderer 类型检查。reservation/drain/branch generation、restart reminder、session title、session-start hook、MCP registration、subagent background notification seal 和 session model selection 有私有 owner 与有限写端口，通知、恢复、模型和 goal continuation 均受 generation fence 约束；Workflow wiring/facade 已从 create-app 提取，W1-R2 命令上下文和 W1-R3a-1 artifact/workspace 读面已迁移到受管包。Supervisor 健康与 restart/stop 有真实 IPC 回归；W2 物理拆包与其他状态簇写权限仍未整体完成；自动重启从未 ready 的 deadline 已补齐。最终门禁见 [修复记录](fix-status-2026-10-09.md)，后文为历史缺陷证据。

### 修复状态

| 编号      | 状态           | 说明                                                                                                                                                                                                                                                            |
| --------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI-01    | 已修复         | CI/release 覆盖 CLI entry、Renderer 和实际选择源码的 CLI lint；配置进入 Turbo 缓存输入。                                                                                                                                                                        |
| CLI-02    | 已修复         | 文件锁 + 原子写入，并有并发回归测试。                                                                                                                                                                                                                           |
| CLI-03    | 已修复         | realpath/stat 边界校验和结构化 `invalid_cwd` 错误。                                                                                                                                                                                                             |
| CLI-04    | 已修复         | audit sink 按 session 注册/释放。                                                                                                                                                                                                                               |
| CLI-05/06 | 关键边界已实现 | runtime 生命周期旗标、reservation/drain/branch owner、subagent notification seal、session model selection 与 generation fence 已覆盖；Workflow wiring/facade 分离，W1-R1 读模型、W1-R2 命令上下文和 W1-R3a-1 读面已落地。全状态封装与 W2 写面物理拆包仍待后续。 |
| CLI-07    | 健康闭环已验证 | 本地时间 freshness、代际、restart/stop 与原子 status 有真实 IPC 测试；普通 CLI 原本已有 ready deadline。                                                                                                                                                        |

## 结果索引

| 编号   | 优先级 | 确认程度                          | 问题                                                                         |
| ------ | ------ | --------------------------------- | ---------------------------------------------------------------------------- |
| CLI-01 | P2     | 命令和配置实证                    | 根 CI 漏掉 CLI 入口类型检查和全部 CLI lint；独立 CLI lint 当前失败           |
| CLI-02 | P2     | 临时目录真实复现                  | 配置 read-modify-write 无并发控制，原子 rename 仍会丢失更新                  |
| CLI-03 | P2     | 真实 ACP adapter、桩 harness 复现 | ACP cwd 检查拒绝合法 `..cache` 目录，接受指向根外的 junction                 |
| CLI-04 | P2     | 真实双 App + 双 JSONL 集成复现    | 进程级审计 sink 被后创建 App 覆盖，A 的权限审计写入 B 日志并使用 B trace     |
| CLI-05 | P2     | 已确认结构风险；不等同新 bug      | AgentRuntime 的状态分簇仍是类型分簇，102 个方法文件共享完整可变状态          |
| CLI-06 | P2     | 已确认结构风险；已有收敛 spec     | bootstrap 已成为应用服务层；拆成文件并未形成职责隔离                         |
| CLI-07 | P3     | 待验证运维风险                    | 原基线缺少心跳 freshness；普通 CLI 实际已有 15 秒 ready deadline（审查勘误） |

优先级含义：P1 为可能造成数据破坏或关键权限边界失守且需要优先修复的确定问题；P2 为正常并发、客户端或交付场景下的缺陷，或应纳入近期收敛的结构风险；P3 为产品和运维行为需要明确后再实施的改善项。

## CLI-01：根 CI 漏掉 CLI 静态检查，独立 lint 当前失败

**P2，已确认。**

**位置与证据。** 根 `package.json:29` 的 `typecheck` 是显式 `tsc -b packages/...` 清单，不含 `apps/acode-cli`；`.oxlintrc.json:70` 明确忽略 `apps/acode-cli`。`.github/workflows/ci.yml:43` 和 `:46` 只执行根命令。该 workflow `:61` 构建 CLI 兄弟包时使用 `--filter='!@acode/cli'`，这是让源码测试能解析兄弟包 `dist` 的正确措施，但不检查 `@acode/cli` 入口包，也不执行 CLI lint。CLI 入口包的类型检查脚本在 `apps/acode-cli/packages/cli/package.json:22`，为 `tsc --noEmit`。

独立执行 `pnpm --dir apps/acode-cli lint --force` 后，`@acode/bootstrap` 报错：

```text
eslint(max-lines): File has too many lines (414).
src/app/script-workflow-tool-port.ts:480:2
Maximum allowed is 400.
Found 22 warnings and 1 error.
Failed: @acode/bootstrap#lint
EXIT_CODE=1
```

这里的 414 是 lint 按其规则计算的行数，并非文件的物理总行数。本报告没有把现有 lint 失败记为通过。

**触发与影响。** 对 CLI 入口引入类型错误，或在 CLI 内引入 lint 错误，根 `typecheck/lint` 可以继续绿；当前 CLI lint 已红，但现行 CI 没有对应失败步骤。会造成“全仓检查绿”与“CLI 可交付”之间的差异。

**原因。** CLI 有独立的 Turbo workspace，根验证只补充了构建和测试依赖；根和 CLI 的静态门禁仍是两份独立入口。

**建议。** CI 明确执行 `pnpm --dir apps/acode-cli typecheck` 与 `pnpm --dir apps/acode-cli lint`；在接入 lint 前按现有 spec 拆分 `script-workflow-tool-port.ts`，不要用新增豁免掩盖已知超限。保留当前预构建步骤，它解决的是另一条真实依赖。Windows/macOS 的执行、取消与路径场景应有平台矩阵或独立验收，现行 CI 仅在 `ubuntu-latest` 运行。

**验收。** 干净检出无 CLI `dist` 时 CI 仍可运行；在临时检出中给 CLI 入口插入类型错误、给任一 CLI 包插入 lint 错误，两者分别使 CI 失败；恢复后 CLI 独立 typecheck、lint、测试通过。CI 的通过说明应列清根门禁与 CLI 门禁。

## CLI-02：共享 JSON 配置并发修改会丢失更新

**P2，已确认且可复现。**

**位置。** `apps/acode-cli/packages/adapters/src/config/file-config.adapter.ts:223` 的 `updateUiLocaleInFileConfig`，`:241` 的 `updatePluginEnabledInFileConfig`，`:299` 的 `updatePluginOptionsInFileConfig` 均先异步读全文件，再独立修改字段，最后调用 `:599` 的 `atomicWriteJson`。`:612` 的 rename 保证单次文件替换，未保护读取到写入的整个事务。相关调用在 `bootstrap/src/app/session-facade.ts:551`、`bootstrap/src/plugins.ts:459`、`:737`、`:931`。

**触发。** 多个 CLI、协议 App 或窗口共用一个用户配置文件，同时执行语言切换与插件启停；两个插件各自写 options 也有相同问题。单进程两个公共 adapter 函数并发已经能触发，跨进程无需更特殊条件。

**影响。** 两个操作均返回成功时，后写的完整快照覆盖前写的不同字段，重启后看不到已确认保存的设置。Windows 上并发替换还可出现 `rename EPERM`，导致其中一次保存直接失败。

**原因。** 文件内容原子替换不等于 read-modify-write 的事务原子性。各函数都读取同一旧快照，没有路径队列、锁、版本或冲突重试。

**实际复现。** 仅使用系统临时目录和虚构插件 ID，未读取用户 `.acode` 数据。20 轮并发调用结果为：

```json
{ "attempts": 20, "lostUpdates": 20, "rejectedWrites": 5 }
```

第一轮最终内容只有 `plugins.enabledPlugins.example-alpha=true`，没有本轮同时设置的 `ui.locale`。其中多轮两个 Promise 都成功，因此缺陷不依赖 Windows 的 rename 错误。

从仓库根创建临时 `.mjs` 并以 `node --import tsx <script>` 运行如下探针即可复核；import 的相对位置应按探针放置位置调整：

```js
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  updatePluginEnabledInFileConfig,
  updateUiLocaleInFileConfig,
} from "./apps/acode-cli/packages/adapters/src/config/file-config.adapter.ts";

const root = await mkdtemp(join(tmpdir(), "acode-config-probe-"));
const file = join(root, "config.json");
await writeFile(file, JSON.stringify({ custom: "retained" }));
const calls = await Promise.allSettled([
  updatePluginEnabledInFileConfig(file, "example-alpha", true),
  updateUiLocaleInFileConfig(file, "en-US"),
]);
console.log(calls.map((result) => result.status));
console.log(JSON.parse(await readFile(file, "utf8")));
```

**建议。** adapter 提供一个统一的、按规范化文件路径串行的 `mutateConfig`，将读取、schema/migration、patch、临时写入、rename 包在同一事务。多进程共享文件还需要跨进程锁或版本 CAS；只有进程内 Promise 队列不能完成跨 CLI 隔离。把所有写入者迁到这一入口，包括加载时的 migration。Windows 的有限 rename 重试只处理短暂文件占用，不解决丢失更新。

**验收。** 同进程并发更新不同字段和同一插件不同 option 后都保留两者；两进程竞争时亦保留两者或返回显式冲突而非静默成功；已有配置未知字段保留；无效 JSON 不被覆盖；写入异常不破坏旧文件；Windows 路径和并发替换通过。

## CLI-03：ACP cwd 边界的词法检查不等于物理目录边界

**P2，已确认且可复现。**

**位置。** `apps/acode-cli/packages/cli/src/acp/session-registry.ts:474` 的 `#validateCwd`；`:485` 只 `resolve(cwd)`，`:486` 用 `relative(allowedRoot, resolved)`，`:487` 使用 `rel.startsWith("..") || isAbsolute(rel)`。`#handleNewSession` 在 `:524` 调用它，`:537` 起把结果传给 harness `create_session`。`acp-command.ts:54` 附近把进程启动 cwd 作为 `allowedRoot`，注释和 `specs/acp-host-adapter.md` 把该根视为 cwd 边界。

**触发与实际结果。** 真实 `AcpHostAdapter` 接收 initialize 与两个 session/new 请求，harness 仅用桩记录调用；临时目录结构如下：

```text
probe/
  allowed/
    ..cache/       普通真实子目录
    link/          junction -> probe/external/
  external/
```

`cwd=allowed/..cache` 返回 `-32602`，消息为 `outside the agent workspace`；`cwd=allowed/link` 返回成功的 sessionId，harness 观察到 `create_session(workspacePath=allowed/link)`；该路径的 `realpath` 位于 sibling `external`。Windows junction 复现无需创建或修改任何真实工作区。

**影响。** 合法以 `..` 开头的目录被误拒；根内链接指向根外时，ACP 声明的工作目录边界未被兑现。这里确认的是 ACP cwd 边界缺口，不把它扩大描述为整个 Bash/file permission 系统被绕过。

**原因。** `startsWith("..")` 混淆了目录名与父目录段；`resolve/relative` 都是词法运算，不解析 symlink/junction。

**建议。** 先明确产品边界是物理目录还是词法路径。本 spec 声称根内边界时应异步规范化 root 与 cwd 的 `realpath`，再按完整目录段检查：`rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)`。目录不存在、无法访问、跨盘、链接解析失败应返回稳定的结构化参数错误，避免错误落成普通内部异常。若有意允许外部链接，应在 spec 和 capability 中说明例外，而非以词法检查声称完全隔离。

**验收。** root 本身、普通子目录、`..cache` 成功；真实 sibling、跨盘根、symlink/junction 指向根外失败；根内链接指向根内成功；Windows/macOS/Linux 分别覆盖；输入仅含字符串但目录不存在时返回明确错误。当前 `tests/acp-host-adapter.test.mjs:793` 起的越界测试只覆盖普通父路径，未覆盖上述链接和点前缀。

## CLI-04：进程级审计 sink 与多 App 生命周期冲突

**P2，已用真实双 App + 双 JSONL 日志集成确认。**

**位置。** `apps/acode-cli/packages/bootstrap/src/app/create-app.ts:223` 创建带当前 `traceContext` 的 `permissionAuditLogger`，`:229` 设置 Bash 审计 sink，`:242` 设置 auto classifier 审计 sink。`core/src/permission/bash-confirm-reflex-gate.ts:436` 的 `auditSink` 和 `auto-risk-classifier.ts:409` 的 `autoClassifierAuditSink` 是模块级单例，setter 无 owner/session 参数，每次装配都替换。

相反，协议运行时确实持有多个 App：`bootstrap/src/acode-protocol/runtime-resources.ts:7` 为 `Set<ACodeApp>`，`:12` 每次调用 factory 再 `:27` 登记；`server-operations.ts:1201`、`:1411`、`:2214` 分别登记创建、恢复、fork 的 session。常驻池 `session-resident-pool.ts:7`、`:8` 的目标/高水位为 8/16。它不是“一进程只有一个 App”的运行模型。

**触发。** 同一 worker 创建 App A，再创建/恢复 App B，之后 A 执行一次需要 Bash reflex 审计或 auto classifier 审计的操作。

**实际复现。** 在临时 workspace、storage、SQLite 和两个独立日志目录中，用真实 `createACodeApp` / `PermissionService`，仅将 ProviderRegistry/ModelAdapter 替换为最小桩。A（`session-A`, `trace-A`）首次检查得到 deny；创建 B（`session-B`, `trace-B`）后，A 再以合法 justification 触发 auditedAllow。唯一的审计 JSONL 写入 B 的 `acode-2026-10-08.jsonl`，entry 为 `bash_reflex_gate_audited_allow`，`traceId=trace-session-B`、`sessionId=session-B`；A 的日志没有该审计事件。说明 A 的 PermissionService 仍触发了被 B 覆盖的进程级 sink。没有调用真实模型或执行 shell。

**影响。** 最后注册的 B sink 处理 A 的审计事件，使用 B logger 所带的 trace。auto entry 的 `sessionId` 可能是 A，而 trace 仍来自 B；Bash 审计 entry 和该 sink 的写出字段没有补充实际来源 sessionId，因此更难恢复正确归属。若两个 App 的日志环境不同，还可能写入错误日志位置。所有权限操作本身仍可正常判定，缺陷主要是审计真实性和故障定位。

**原因。** 将本应实例所有的 logger/context 注册到可覆盖的进程单例。相邻 `core/src/permission/process-policy-floor.ts:10` 明写“一进程一个 createACodeApp 一份配置”的前提，该前提与当前协议多会话事实不一致。本报告未据此宣称托管策略被绕过：多数生产 session 使用同一进程 floor；不同 floor 的弱化风险需要另行对抗验证。

**建议。** 审计 sink 随 PermissionService/classifier 或执行上下文注入，entry 必须携带实际 traceId/sessionId/turnId；如果保留进程级 sink，该 sink 应是只注册一次的路由器，不能捕获某个 App 的根 trace。托管地板若确为进程级事实，应在进程入口解析和冻结，App 不重复覆盖；需要会话差异时应显式传递依赖。

**验收。** 双 App A/B 交错执行审计，日志均关联各自 trace/session；B 关闭后 A 仍写正确位置；临时 workspace App 不更改其他 session 的 sink；subagent 与 memory agent 继承正确 floor，审计在其父 trace 下；重新装配不会残留旧 logger。

## CLI-05：状态所有权分簇尚未限制跨模块写入

**P2，结构风险，已登记债务；没有把它当作新竞态缺陷。**

**位置。** `core/src/runtime/internal.ts:65` 起的分簇说明，`:175` 的 `RuntimeTurnState`，`:234` 的 `AgentRuntimeInternal` 仍 extends 全部分簇；`runtime/methods/index.ts:200` 的 `installAgentRuntimeMethods` 把各方法装到同一原型。当前 methods 目录为 102 个 TS 文件，而 `specs/runtime-state-ownership.md` 和登记册仍引用 95。`agent-runtime.ts` 687 物理行，`methods/turn.ts` 856 物理行。

**触发和风险。** 新增 turn、cancel、queue、rewind、background、resume 行为时，任意 methods 文件仍能写任意 `AgentRuntimeInternal` 字段。状态分簇改善阅读，却没有收窄消费方的写能力。多条异步路径仍需共同理解 reservation、branchGeneration、autoDrain、foreground lease 等全部时序。

**良好基础。** `methods/prompt-admission.ts:15` 明确 runtime 为唯一 admission owner，`:99` 起先 reserve 再 enqueue，避免 bootstrap 的异步窗口引出双 turn；现有 spec 登记 I1-I4，已经识别真正的状态不变量。

**建议。** 优先把写者收窄为有限 coordinator/port：admission、turn execution、branch restore、background notification 各持有自己的 state view，调用方只见必要方法。可先对共享 this 参数按职责 `Pick`，再逐步封装 setter/coordinator，不必一次推倒全部 runtime。同步更新 spec 中的 95/110 等估计值，避免将“类型分簇已实施”误读成运行时隔离已完成。

**验收。** 非 owner 模块无法直接写 reservation、branchGeneration 和 drain 授权位；I1-I4 具备真实 runtime + 桩端口行为测试；同时 submit、cancel/complete、rewind/background 等交错仍可恢复，旧 branch 不能写入新分支；新增 coordinator 只提供受控接口。

## CLI-06：bootstrap 装配与应用服务职责仍混杂

**P2，结构风险，已有 spec，建议沿既有计划推进。**

**位置。** `apps/acode-cli/packages/bootstrap/src/app/create-app.ts:186` 起的 `createACodeApp` 当前长 1593 物理行；`specs/bootstrap-app-boundary.md` 已把 `src/app` 的 workflow/application 服务迁移列为 W1。当前 `bootstrap/src` 为 243 个 TS/TSX 文件、68,692 物理行；`core/src` 为 588 个文件、118,650 物理行。这些是源码规模测量，包含注释/空行，不等于 lint 的行数定义。

**风险。** create-app 负责配置、provider、日志、安全单例、存储、插件、模型、runtime、子代理、workflow、resume、facade 等接线。一个“装配”包又承载协议 server 和应用服务，模块的生命周期及调用顺序很难由包级依赖图说明。横向拆为文件只降低单文件体积，没有自然阻止协议层 reach-in 或多个 owner 的隐式 coupling。

**现有约束。** `tests/bootstrap-boundary.test.mjs` 冻结跨包深导入，且 `specs/bootstrap-app-boundary.md` 正确记录了物理拆包前缺少装配 E2E 的限制；这比直接大迁移更稳健。当前 CLI packages 中匹配 max-lines 文件头豁免的源文件为 109 个，说明行数限制并非已完成的结构治理，不应把 lint 通过解释为文件都在 400 行内。

**建议。** 按 W1 提取 workflow 应用服务所有者，再将 session/application facade 与进程装配分离；保留 CLI/adapters/core/contracts 的公共入口。create-app 最终只建依赖和资源 owner，把状态服务构建变成返回明确生命周期对象的 factory。扩展边界测试保护包内 reach-in 规则，并增加不依赖真实 provider 的装配和关闭 E2E。

**验收。** workflow application service 能独立 typecheck/lint/test；bootstrap 明显缩小且只保存装配与协议职责；单独构造/关闭 app、创建/冷恢复 session、stdin EOF、取消、插件失败都能通过实际入口验证；不增加循环依赖，不恢复已移除模块。两套 workflow 迁移顺序应服从同目录专项报告中的所有者约束。

## CLI-07：Supervisor 有心跳消息，但没有失联判定

**P3，原始运维风险；2026-10-09 已补健康监控与真实 IPC 验证。**

**位置。** `packages/acode-server-cli/src/server-core/core.ts:89` 附近每 10 秒发送 heartbeat；`supervisor/supervisor.ts:439` 仅将其当作 runningTaskCount 快照。`:81` 的普通 start 设置 starting、launchCore 后返回；`:349` 的 launchCore 仅监听 message/error/exit/close。ready timeout 目前用于 `:282` 的更新和 `:317` 的回滚等待，不作用于普通 start 或崩溃后自动重启。

**触发假设。** Core 的 Node 进程仍存活，但初始化永久挂起，或已 ready 后事件循环/网络服务停止进展而不 exit。当前 Supervisor 不记录最近心跳时间，也不作超时裁决。

**影响边界（原基线）。** Supervisor 本体与自动重启可能长期显示 starting；普通 CLI 的 waitForSupervisorReady 已在 cli.ts 提供 15 秒 deadline，本次原审查漏读该调用方。运行后可能长期显示 ready 和陈旧任务计数。此项没有启动真实故障 Core 复现，因此不列作已确认用户故障；没有证据表明 spec 已承诺自动杀死“失联但存活”的 Core。

**建议。** 先定义 ready deadline、心跳 freshness、健康状态和重启策略；不要仅凭未收到一次心跳强杀长任务。将失联状态暴露为 degraded/unresponsive，自动重启必须遵守现有 data-root lock、generation 和运行任务保护。测试用可控 fake child + fake clock，避免依赖真实长时间等待。

**验收。** 从未 ready 的 Core 和 ready 后不再心跳的 Core 有明确可观察状态；旧 generation 心跳不能恢复健康；stop 保留锁直到 OS 终态；自动重启/更新/回滚的失败路径不遗留双 Core。

## 值得保留的设计

| 设计                                  | 当前证据                                                                                                                                                      | 审查评价                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| contracts + adapters + core 分层      | core 大量依赖显式 Model/Execution/FileSystem/SessionStore/Permission ports，`runtime/deps.ts` 和 `runtime/types.ts`                                           | 提供可替换边界和测试注入；继续收口少数 core 直接 I/O，避免用一次大重构替换已有稳定接口                                        |
| CommandInbox 三类事实与串行 admission | `bootstrap/src/acode-protocol-v4/command-inbox.ts:107` 的 inFlight/liveInputs/settled，`:139` 的 key→session 固定锁序，`:183` 的幂等 settle                   | in-flight/live input pinned，settled LRU 不误淘汰执行中命令；duplicate 等待同一 final，设计理由明确，不建议重写               |
| CAS 拒绝不缓存与 noop 缓存            | 同文件 `:154`、`:315` 起的约定与 `:429` 附近 noop 分支                                                                                                        | stale 不 remembered 是让同 commandId 修正 baseRevision 后能重试，并非“拒绝终态丢失”；不能仅为 query 返回 known 而破坏修正重试 |
| 权限 restrictive floor                | `adapters/src/config/project-config.adapter.ts:35` 剥离项目放宽字段；`core/src/permission/service.ts:202` 起执行策略 deny/ask、硬禁用和 bypass immune breaker | 清晰区分用户授权与仓库配置，策略只收紧；应保持最严格者胜及执行前 input recheck                                                |
| 服务生命周期防护                      | server-cli `runtime/lock.ts` owner token/quarantine，Supervisor `:194` 起 stop 等待 exit/close，`:417` 起 child+generation fencing                            | 保留单实例锁、旧代际防护与失败停止状态；发布 update 的 immutable release、hash 校验、transaction/rollback 分工合理            |

TUI 的 mode/model/todo/permission 大多经 handler 或 session event 与 runtime 交互，而非直接操作 adapter，这也是正确方向。乐观交互缓存可以保留，但不能成为执行模式的权威；`tui/src/app-mode.ts:35` 起的乐观切换需要后续交互 E2E覆盖连续键击和失败回滚。

## 验证记录与限制

| 检查             | 实际执行及结果                                                                                                           | 限制                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| CLI typecheck    | Node `24.14.0`、pnpm `10.33.2`；`pnpm --dir apps/acode-cli typecheck --force`，退出 0；25/25 任务成功，0 缓存，58.827 秒 | 使用固定版本 runtime 直接调用；环境无 mise                                        |
| CLI lint         | 同版本，`pnpm --dir apps/acode-cli lint --force`，退出 1                                                                 | bootstrap 有 1 个 max-lines error；Turbo 默认遇失败中止，不声称所有余下任务都完成 |
| 配置并发探针     | 20 轮，20 轮丢失至少一个更新；5 次写入拒绝                                                                               | 临时文件、虚构 ID；Windows 实测，不推广 EPERM 比例到其他系统                      |
| ACP cwd 探针     | 真实 adapter 拒绝 `..cache`、接受越界 junction                                                                           | harness 是桩；未在 macOS/Linux 实测 symlink，但源码词法检查相同                   |
| 全仓测试和根门禁 | 由本次总审查统一执行，见索引/架构报告                                                                                    | 不在本专项重复记作自己运行；未进行真实 provider 调用和完整桌面/手机 E2E           |

首次 CLI 检查发现工具路径不完整，顶层固定 pnpm 10.33.2 的 Turbo 子任务可能解析全局 pnpm 9.10.0；最终检查将固定版本的 `.bin` 和 Node 加入 PATH 前端并 `--force` 重跑，避免用缓存或不同子进程版本伪称固定工具链验证。本报告不包含真实用户配置、凭据、内部服务地址或个人绝对路径。

原始审查建议的 CLI-01..04 已实施；CLI-05/06 按已有 spec 推进关键边界，当前 I5 已封口 subagent background notification 的唯一写入方，CLI-07 健康规则已有实现与测试。尚未完成的产品/结构边界见修复记录，不把历史审查结论当作当前失败。
