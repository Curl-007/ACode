# Mimosa 存量 findings 分诊台账（2026-11）

> 一次性只读分诊产物，用于后续扫描告警对照。**不修改任何代码**，不代表已修复或已确认漏洞。

## 1. 扫描对象与覆盖率声明

| 项 | 值 |
| --- | --- |
| 扫描根目录 | `~/.mimosa/security-scans/project-be90e3780897dfef1a4bc8a2/` |
| 分诊对象（最新一次扫描） | `scan-2026-11-02T07-13-15.785Z-fbeb171a9f17` |
| 扫描产品/版本 | mimosa 0.1.0（depth: deep） |
| findings 总数 | 287 |
| runStatus | `inconclusive`（coverage.completeness=`partial`） |
| 运行级 verdictEffect | `none` |
| 源文件 | 选中 5899 / 解析 5899，truncated=false，read/parseFailures=0/0 |
| 阶段状态 | threatModel=partial，findingDiscovery=partial，validation=completed |
| 覆盖缺口 | 部分分析阶段未能完整覆盖 |

**覆盖状态说明（self-reported completeness）**：本次扫描自报为 `partial` / `inconclusive`，validation 阶段仅判定 1 条（即 287 条中仅 1 条进入判定），findingDiscovery 为 `partial`。因此绝大多数 findings 是**未经验证的静态启发式候选**，而非已确认漏洞。所有 287 条 finding 的 `verdictEffect` 均为 `none`（`investigationVerdict` 除 1 条业务逻辑为 `inconclusive` 外均未定义）。

扫描根目录完整清单（按目录名排序，最新在末）：

- `scan-2026-10-31T20-20-43.829Z-a1eea1e6aba4`（167 findings）
- `scan-2026-11-02T02-13-05.115Z-5d3ec130db00`（167 findings）
- `scan-2026-11-02T05-55-47.721Z-af298a2703cd`（167 findings）
- `scan-2026-11-02T06-16-38.353Z-90d6368e9ed8`（167 findings）
- `scan-2026-11-02T06-35-19.903Z-bc0775b7495c`（167 findings）（运行级比对基线）
- `scan-2026-11-02T07-13-15.785Z-fbeb171a9f17`（287 findings） ← 本次分诊对象（最新）

## 2. 分档汇总表（档位 × 数量 × 归属区域）

口径说明：v1 扫描的 `verdictEffect` **全量为 none**，无法单独用于区分处置档位；本台账按**路径归属 + 内容可核实性**分档：

1. **vendored/第三方**：路径落在未维护/生成区域（`packages/desktop/bundled-agents/`、`packages/desktop/mock-cdn/`，均为 `.gitignore` 忽略的构建产物）或随产品分发的官方插件技能脚本（`apps/acode-cli/packages/*-plugin/skills/**`）。处置=上游/不修。
2. **误报**：直接读取源码核实内容为凭据存储键名、错误原因枚举、mock 占位串或 UI 测试选择器常量——不存在真实凭据。处置=标记误报。
3. **待跟进**：ACode 自维护源码中其余 findings（静态注入/穿越类规则 + 跨文件污点启发式候选）。处置=人工跟进。

| 档位 | 归属区域 | 数量 |
| --- | --- | ---: |
| vendored/第三方 | packages/desktop/bundled-agents（gitignored 构建产物） | 24 |
| vendored/第三方 | packages/desktop/mock-cdn（gitignored 构建产物） | 96 |
| vendored/第三方 | apps/acode-cli/packages/*-plugin/skills（官方插件技能脚本，随产品分发） | 24 |
| **vendored 小计** | — | **144** |
| 误报 | ACode 自维护源码 | 8 |
| **误报 小计** | — | **8** |
| 待跟进 | ACode 自维护源码 | 135 |
| **待跟进 小计** | — | **135** |
| **合计** | — | **287** |

严重度分布（全量）：high 199、medium 76、low 12。

> **增补（同日复核裁决，见 §6.1）**：本分支改动文件上的 4 条「待跟进」经逐处源码复核后改档——
> 1 条改判**误报**（无命令执行 sink）、2 条改判**可接受设计（在案）**（冻结契约的有界执行面）、
> 1 条**重归存量 backlog**（本分支 diff 未触及该路径）。调整后全量口径：误报 9、
> 可接受设计（在案）2、待跟进 132（其中含重归存量的 1 条）、vendored 144。

## 3. 待跟进清单（needs-review，共 135 条）

> 均为 ACode 自维护源码、未经验证的静态/跨文件候选。列 `建议` 为分诊建议，需人工确认后决定是否修复。

### 3.1 规则聚合

| kind | 规则 | 数量 |
| --- | --- | ---: |
| cross-file | 疑似跨文件污点 | 47 |
| static | 命令注入 | 7 |
| cross-file | getSession 经 1 跳到达 sql-injection | 5 |
| cross-file | fetch 是 ssrf 入口 | 4 |
| cross-file | cuaHelperBundleFingerprintUnchanged 经 1 跳到达 mongo-sort-injection | 4 |
| cross-file | hasExactKeys 是 mongo-sort-injection 入口 | 4 |
| static | 不可信程序选择 | 3 |
| cross-file | readApiJson 是 ssrf 入口 | 3 |
| static | 代码注入 | 2 |
| cross-file | download 经 1 跳到达 ssrf | 2 |
| cross-file | captureCuaHelperBundleFingerprint 是 mongo-sort-injection 入口 | 2 |
| cross-file | verifyHelperPermissionIdentityUnchanged 经 1 跳到达 mongo-sort-injection | 2 |
| static | 不可信命令参数向量 | 2 |
| cross-file | readRequiredArtifact 经 1 跳到达 path-traversal | 2 |
| cross-file | readFile 是 path-traversal 入口 | 2 |
| business-logic | 敏感操作未观察到角色或权限检查 | 1 |
| cross-file | request 是 ssrf 入口 | 1 |
| cross-file | connect 是 command-injection 入口 | 1 |
| cross-file | rememberLegacy 经 1 跳到达 mongo-sort-injection | 1 |
| cross-file | buildCollectionState 经 1 跳到达 mongo-sort-injection | 1 |
| cross-file | validateZipDownloadUrl 经 2 跳到达 command-injection | 1 |
| cross-file | startPanelAsync 经 2 跳到达 command-injection | 1 |
| cross-file | plans 经 1 跳到达 ssrf | 1 |
| cross-file | fileChanges 经 1 跳到达 ssrf | 1 |
| cross-file | fileRewindPreview 经 1 跳到达 ssrf | 1 |
| cross-file | workflowRunEvents 经 1 跳到达 ssrf | 1 |
| cross-file | workflowRuns 经 1 跳到达 ssrf | 1 |
| cross-file | workflowRunArtifacts 经 1 跳到达 ssrf | 1 |
| cross-file | workflowRunArtifactData 经 1 跳到达 ssrf | 1 |
| cross-file | workflowRunArtifactRead 经 1 跳到达 ssrf | 1 |
| cross-file | visualizationRead 经 1 跳到达 ssrf | 1 |
| cross-file | workflowRunWorkspace 经 1 跳到达 ssrf | 1 |
| cross-file | workflowRunNodeResult 经 1 跳到达 ssrf | 1 |
| cross-file | queryCommands 是 sql-injection 入口 | 1 |
| cross-file | resolveACodeCustomCommandPrompt 经 1 跳到达 command-injection | 1 |
| cross-file | exists 经 2 跳到达 command-injection | 1 |
| cross-file | execute 是 sql-injection 入口 | 1 |
| cross-file | recordPromptTrajectoryFromFixture 经 2 跳到达 ssrf | 1 |
| cross-file | downloadFile 是 ssrf 入口 | 1 |
| cross-file | ensureNodeBinary 经 1 跳到达 ssrf | 1 |
| cross-file | fetchReleaseCatalog 经 1 跳到达 ssrf | 1 |
| cross-file | prepareComponentUpdate 经 1 跳到达 ssrf | 1 |
| cross-file | installArchive 经 2 跳到达 mongo-sort-injection | 1 |
| cross-file | materializeRemotePromptAttachments 经 2 跳到达 command-injection | 1 |
| cross-file | createRemotePromptAttachmentTransferService 经 2 跳到达 command-injection | 1 |
| cross-file | handleRequest 是 ssrf 入口 | 1 |
| cross-file | handleSetEnabled 经 1 跳到达 ssrf | 1 |
| cross-file | connectRemote 经 1 跳到达 command-injection | 1 |
| cross-file | resolveUpdaterPendingDir 经 1 跳到达 command-injection | 1 |
| cross-file | resolveDevelopmentRuntime 经 2 跳到达 path-traversal | 1 |
| cross-file | requireExpectedPackage 经 1 跳到达 path-traversal | 1 |
| cross-file | readRuntimeManifest 经 1 跳到达 path-traversal | 1 |
| cross-file | validateRuntimeManifest 经 1 跳到达 mongo-sort-injection | 1 |
| cross-file | createLegacyTeamOrganizationResolver 是 ssrf 入口 | 1 |
| cross-file | fetchACodeBuiltinRemoteRelease 是 ssrf 入口 | 1 |
| cross-file | generateWorkspaceText 是 ssrf 入口 | 1 |
| cross-file | createClientConfigService 是 ssrf 入口 | 1 |
| static | 路径穿越 | 1 |
| static | 弱加密算法 | 1 |

### 3.2 逐条明细

| 路径:行 | kind | severity | 风险 | 建议 |
| --- | --- | --- | --- | --- |
| `apps/acode-cli/packages/adapters/src/doctor/defaults.ts:71` | cross-file | high | request 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/adapters/src/http/index.ts:186` | cross-file | medium | 疑似跨文件污点 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/adapters/src/http/index.ts:186` | cross-file | high | fetch 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/adapters/src/mcp/index.ts:1746` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/adapters/src/mcp/index.ts:1746` | cross-file | high | connect 是 command-injection 入口 | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `apps/acode-cli/packages/adapters/src/mcp/index.ts:1829` | cross-file | medium | rememberLegacy 经 1 跳到达 mongo-sort-injection | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `apps/acode-cli/packages/adapters/src/model/runner-debug.ts:796` | cross-file | medium | buildCollectionState 经 1 跳到达 mongo-sort-injection | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `apps/acode-cli/packages/adapters/src/plugins/zip-source.ts:183` | cross-file | high | validateZipDownloadUrl 经 2 跳到达 command-injection | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `apps/acode-cli/packages/agent-teams-plugin/src/server.ts:134` | cross-file | medium | 疑似跨文件污点 | 核实路径是否受根目录边界约束或文件名白名单限制。 |
| `apps/acode-cli/packages/agent-teams-plugin/src/server.ts:148` | cross-file | medium | 疑似跨文件污点 | 核实路径是否受根目录边界约束或文件名白名单限制。 |
| `apps/acode-cli/packages/agent-teams-plugin/src/server.ts:75` | cross-file | high | startPanelAsync 经 2 跳到达 command-injection | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:541` | cross-file | high | plans 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:545` | cross-file | high | fileChanges 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:547` | cross-file | high | fileRewindPreview 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:550` | cross-file | high | workflowRunEvents 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:553` | cross-file | high | workflowRuns 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:557` | cross-file | high | workflowRunArtifacts 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:559` | cross-file | high | workflowRunArtifactData 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:561` | cross-file | high | workflowRunArtifactRead 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:564` | cross-file | high | visualizationRead 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:570` | cross-file | high | workflowRunWorkspace 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:572` | cross-file | high | workflowRunNodeResult 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:719` | cross-file | medium | 疑似跨文件污点 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:729` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:729` | cross-file | high | queryCommands 是 sql-injection 入口 | 核实查询是否参数化，避免字符串拼接。 |
| `apps/acode-cli/packages/bootstrap/src/acode-protocol-v4/server.ts:747` | cross-file | medium | 疑似跨文件污点 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/bootstrap/src/app/create-app.ts:1367` | cross-file | high | resolveACodeCustomCommandPrompt 经 1 跳到达 command-injection | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `apps/acode-cli/packages/browser-use-plugin/src/relay/websocket.ts:204` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli-workflow/src/script-workflow-child-source.ts:274` | static | high | 代码注入 | 核实是否仅在沙箱 vm 内求值，确认 codeGeneration 已关闭、脚本来接受控。 |
| `apps/acode-cli/packages/cli-workflow/src/script-workflow-child-source.ts:278` | static | high | 代码注入 | 核实是否仅在沙箱 vm 内求值，确认 codeGeneration 已关闭、脚本来接受控。 |
| `apps/acode-cli/packages/cli/src/commands-command.ts:71` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/commands-command.ts:98` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/login-command.ts:109` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/login-command.ts:119` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/login-command.ts:48` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/login-command.ts:67` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/prompt-command.ts:384` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/prompt-command.ts:407` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/prompt-command.ts:460` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/prompt-command.ts:464` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/prompt-command.ts:580` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/prompt-command.ts:592` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/prompt-command.ts:602` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/prompt-command.ts:718` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/provider-doctor-command.ts:105` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/provider-doctor-command.ts:135` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/provider-doctor-command.ts:138` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/provider-doctor-command.ts:302` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/provider-doctor-command.ts:304` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/provider-doctor-command.ts:96` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/provider-runtime-env.ts:32` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/run.ts:225` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/run.ts:257` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/skills-command.ts:70` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/cli/src/skills-command.ts:99` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/core/src/tool/handlers/powershell-launch.ts:35` | cross-file | high | exists 经 2 跳到达 command-injection | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `apps/acode-cli/packages/core/src/tool/handlers/workflow-drafts.ts:91` | static | high | 路径穿越 | 核实路径是否受根目录边界约束或文件名白名单限制。 |
| `apps/acode-cli/packages/dynamic-workflow-runtime/src/harness.ts:520` | cross-file | medium | 疑似跨文件污点 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/packages/node-repl-host/src/browser-bridge.ts:155` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/packages/node-repl-host/src/server.ts:353` | cross-file | high | execute 是 sql-injection 入口 | 核实查询是否参数化，避免字符串拼接。 |
| `apps/acode-cli/packages/node-repl-host/src/server.ts:390` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `apps/acode-cli/tools/prompt-trajectory/src/cli.ts:43` | cross-file | high | recordPromptTrajectoryFromFixture 经 2 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/tools/prompt-trajectory/src/openai-provider-proxy.ts:73` | cross-file | medium | 疑似跨文件污点 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `apps/acode-cli/tools/prompt-trajectory/src/openai-provider-proxy.ts:73` | cross-file | high | fetch 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `cua-producer/src/wire-server.ts:192` | cross-file | medium | 疑似跨文件污点 | 核实路径是否受根目录边界约束或文件名白名单限制。 |
| `packages/acode-server-cli/src/packaging/stageCli.ts:104` | cross-file | high | downloadFile 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/acode-server-cli/src/packaging/stageCli.ts:241` | cross-file | high | ensureNodeBinary 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/acode-server-cli/src/packaging/stageCli.ts:54` | cross-file | medium | 疑似跨文件污点 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/acode-server-cli/src/packaging/stageCli.ts:54` | cross-file | high | fetch 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/acode-server-cli/src/runtime/updatePreparation.ts:117` | cross-file | high | download 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/acode-server-cli/src/runtime/updatePreparation.ts:130` | cross-file | medium | installArchive 经 2 跳到达 mongo-sort-injection | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/acode-server-cli/src/runtime/updatePreparation.ts:264` | cross-file | high | download 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/acode-server-cli/src/runtime/updatePreparation.ts:78` | cross-file | high | fetchReleaseCatalog 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/acode-server-cli/src/runtime/updatePreparation.ts:96` | cross-file | high | prepareComponentUpdate 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/acode-server-cli/src/server-core/http.ts:285` | business-logic | medium | 敏感操作未观察到角色或权限检查 | 核实该路由是否被全局鉴权中间件/guard 覆盖。 |
| `packages/desktop/native/windows-browser-import-helper/Program.cs:140` | static | high | 命令注入 | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `packages/desktop/src/host/index.ts:1074` | cross-file | high | materializeRemotePromptAttachments 经 2 跳到达 command-injection | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `packages/desktop/src/host/index.ts:1080` | cross-file | high | createRemotePromptAttachmentTransferService 经 2 跳到达 command-injection | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `packages/desktop/src/host/index.ts:1455` | cross-file | high | getSession 经 1 跳到达 sql-injection | 核实查询是否参数化，避免字符串拼接。 |
| `packages/desktop/src/host/index.ts:1685` | cross-file | medium | 疑似跨文件污点 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/desktop/src/host/index.ts:1685` | cross-file | high | handleRequest 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/desktop/src/host/index.ts:1693` | cross-file | high | handleSetEnabled 经 1 跳到达 ssrf | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/desktop/src/host/index.ts:1889` | cross-file | high | getSession 经 1 跳到达 sql-injection | 核实查询是否参数化，避免字符串拼接。 |
| `packages/desktop/src/host/index.ts:1962` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `packages/desktop/src/host/index.ts:2046` | cross-file | high | getSession 经 1 跳到达 sql-injection | 核实查询是否参数化，避免字符串拼接。 |
| `packages/desktop/src/host/index.ts:2061` | cross-file | high | getSession 经 1 跳到达 sql-injection | 核实查询是否参数化，避免字符串拼接。 |
| `packages/desktop/src/host/index.ts:2090` | cross-file | high | getSession 经 1 跳到达 sql-injection | 核实查询是否参数化，避免字符串拼接。 |
| `packages/desktop/src/host/index.ts:2170` | cross-file | medium | 疑似跨文件污点 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/desktop/src/host/index.ts:2381` | cross-file | high | connectRemote 经 1 跳到达 command-injection | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `packages/desktop/src/host/remoteMediaPreviewProxy.ts:349` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |
| `packages/desktop/src/main/autoUpdater.ts:1228` | cross-file | high | resolveUpdaterPendingDir 经 1 跳到达 command-injection | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `packages/desktop/src/main/cuaAccessibilitySettings.ts:188` | cross-file | medium | captureCuaHelperBundleFingerprint 是 mongo-sort-injection 入口 | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/desktop/src/main/cuaAccessibilitySettings.ts:190` | cross-file | medium | cuaHelperBundleFingerprintUnchanged 经 1 跳到达 mongo-sort-injection | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/desktop/src/main/cuaAccessibilitySettings.ts:203` | cross-file | medium | cuaHelperBundleFingerprintUnchanged 经 1 跳到达 mongo-sort-injection | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/desktop/src/main/cuaAccessibilitySettings.ts:439` | cross-file | medium | verifyHelperPermissionIdentityUnchanged 经 1 跳到达 mongo-sort-injection | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/desktop/src/main/cuaAccessibilitySettings.ts:480` | cross-file | medium | verifyHelperPermissionIdentityUnchanged 经 1 跳到达 mongo-sort-injection | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/desktop/src/main/cuaAccessibilitySettings.ts:628` | cross-file | medium | captureCuaHelperBundleFingerprint 是 mongo-sort-injection 入口 | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/desktop/src/main/cuaAccessibilitySettings.ts:630` | cross-file | medium | cuaHelperBundleFingerprintUnchanged 经 1 跳到达 mongo-sort-injection | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/desktop/src/main/cuaAccessibilitySettings.ts:638` | cross-file | medium | cuaHelperBundleFingerprintUnchanged 经 1 跳到达 mongo-sort-injection | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/server/src/remote/backend.ts:44` | static | high | 命令注入 | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `packages/server/src/remote/docker-backend.ts:169` | static | high | 命令注入 | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `packages/server/src/remote/ssh-backend.ts:341` | static | high | 命令注入 | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `packages/server/src/remote/sshBackendUpload.ts:198` | static | high | 命令注入 | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `packages/server/src/remote/sshKnownHosts.ts:29` | static | high | 弱加密算法 | 核实是否协议强制（OpenSSH known_hosts 规定 HMAC-SHA1）；否则替换为强算法。 |
| `packages/server/src/remote/wsl-backend.ts:166` | static | high | 命令注入 | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `packages/server/src/remote/wslBackendUpload.ts:30` | static | high | 命令注入 | 核实 shell 命令拼接来源与转义（如 quotePosixShellArg／改用参数数组 API），确认不可信输入是否可达。 |
| `packages/services/src/acode-agent/acodeAgentProcessManager.ts:1545` | static | high | 不可信程序选择 | 核实可执行路径是否来自不可信 env；必要时改为固定可执行名并校验。 |
| `packages/services/src/acode-agent/acodeAgentProcessManager.ts:1545` | static | high | 不可信命令参数向量 | 核实参数数组是否含外部输入，避免选项注入（使用 -- 终止符/固定参数）。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevHelperHost.ts:318` | cross-file | medium | 疑似跨文件污点 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:118` | cross-file | high | requireExpectedPackage 经 1 跳到达 path-traversal | 核实路径是否受根目录边界约束或文件名白名单限制。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:191` | cross-file | high | readRuntimeManifest 经 1 跳到达 path-traversal | 核实路径是否受根目录边界约束或文件名白名单限制。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:192` | cross-file | medium | validateRuntimeManifest 经 1 跳到达 mongo-sort-injection | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:218` | cross-file | high | readRequiredArtifact 经 1 跳到达 path-traversal | 核实路径是否受根目录边界约束或文件名白名单限制。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:219` | cross-file | high | readRequiredArtifact 经 1 跳到达 path-traversal | 核实路径是否受根目录边界约束或文件名白名单限制。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:249` | cross-file | high | readFile 是 path-traversal 入口 | 核实路径是否受根目录边界约束或文件名白名单限制。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:293` | cross-file | medium | hasExactKeys 是 mongo-sort-injection 入口 | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:307` | cross-file | medium | hasExactKeys 是 mongo-sort-injection 入口 | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:494` | cross-file | high | readFile 是 path-traversal 入口 | 核实路径是否受根目录边界约束或文件名白名单限制。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:549` | cross-file | medium | hasExactKeys 是 mongo-sort-injection 入口 | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:552` | cross-file | medium | hasExactKeys 是 mongo-sort-injection 入口 | 核实是否将外部对象直接用作查询/排序运算符，做键名白名单。 |
| `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:95` | cross-file | high | resolveDevelopmentRuntime 经 2 跳到达 path-traversal | 核实路径是否受根目录边界约束或文件名白名单限制。 |
| `packages/services/src/model-provider/accountProviderTeamPlanRequestKey.ts:64` | cross-file | high | readApiJson 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/services/src/model-provider/codingPlanProviderAvailability.ts:262` | cross-file | high | readApiJson 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/services/src/model-provider/zaiStartPlanBilling.ts:108` | cross-file | high | readApiJson 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/services/src/node.ts:1498` | cross-file | high | createLegacyTeamOrganizationResolver 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/services/src/node.ts:1558` | cross-file | high | fetchACodeBuiltinRemoteRelease 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/services/src/node.ts:2428` | cross-file | medium | 疑似跨文件污点 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/services/src/node.ts:2428` | cross-file | high | generateWorkspaceText 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/services/src/node.ts:2576` | cross-file | high | createClientConfigService 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/services/src/runtime-tools/runtimeLoginShellEnvCapture.ts:236` | static | high | 不可信程序选择 | 核实可执行路径是否来自不可信 env；必要时改为固定可执行名并校验。 |
| `packages/services/src/runtime-tools/runtimeLoginShellEnvCapture.ts:236` | static | high | 不可信命令参数向量 | 核实参数数组是否含外部输入，避免选项注入（使用 -- 终止符/固定参数）。 |
| `packages/services/src/runtime-tools/runtimeLoginShellEnvCapture.ts:95` | static | high | 不可信程序选择 | 核实可执行路径是否来自不可信 env；必要时改为固定可执行名并校验。 |
| `packages/services/src/session/off-peak/offPeakMockMessages.ts:131` | cross-file | medium | 疑似跨文件污点 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/services/src/session/off-peak/offPeakMockMessages.ts:131` | cross-file | high | fetch 是 ssrf 入口 | 核实出站 URL 来源与目标限制（白名单/禁内网/禁 metadata 地址）。 |
| `packages/services/src/session/off-peak/offPeakMockMessages.ts:161` | cross-file | medium | 疑似跨文件污点 | 沿污点链核实对应 sink 的输入校验；属启发式候选，优先级低于同位置的具体规则项。 |

## 4. 误报判定依据（按规则类聚合，共 8 条，均为「硬编码凭据」规则）

全部命中的是 `硬编码凭据` 启发式规则。逐处核实源码后，命中位置都不是凭据值。为遵守安全红线，此处**只写常量名与文件:行，不复制字面量**（`test-ids.ts` 的测试选择器占位串除外，其值本身明显非凭据）。

| 文件:行 | 命中常量/上下文 | 判定依据 |
| --- | --- | --- |
| `apps/acode-cli/packages/adapters/src/auth/shared-credentials.ts:17,18,20,21` | `SHARED_ACODE_CREDENTIAL_KEYS` 的 `bigmodelAccessToken`/`bigmodelRefreshToken`/`zaiAccessToken`/`zaiRefreshToken` | 命中的是凭据存储的键名常量（键名字符串，形如 oauth:<provider>:<kind>），不是凭据值本身；值为源码中直接写的索引键。 |
| `apps/acode-cli/packages/adapters/src/mcp/oauth-provider.ts:60` | 错误原因枚举 `reason` 字段 | 命中值是错误原因枚举字符串（no_refresh_token），用于 createInteractiveAuthorizationRequiredError 的 reason 字段，非凭据。 |
| `packages/services/src/session/offPeakRuntimeModel.ts:149` | `codingPlanApiKey`（mock 分支） | 命中值位于 mock 分支（env.ACODE_OFFPEAK_MOCK === "1" 时才返回）的占位串，注释明确其为 mock 网关不校验的确定性 metadata。 |
| `packages/shared/src/test-ids.ts:175,177` | `TID_SSH_AUTH_PASSWORD`（值 `"ssh-auth-password"`）、`TID_SSH_AUTH_PRIVATE_KEY` | 命中值是 UI 测试选择器常量（data-testid），如 TID_SSH_AUTH_PASSWORD 的值为 "ssh-auth-password" 这类占位串，非凭据。 |

结论：本规则类在本次扫描中 **0 真实凭据**，8 条全部为误报。

## 5. vendored 归属说明（共 144 条）

### 5.1 `packages/desktop/bundled-agents/` 与 `packages/desktop/mock-cdn/`（120 条）

这两个目录在 `.gitignore` 中被忽略（`git ls-files` 计数为 0），是**随产品分发的构建产物/离线样例**：

- `bundled-agents/`：桌面端打包的 agent 侧技能与插件（win32-x64/glm 等）。
- `mock-cdn/releases/`：多平台（darwin-arm64/x64、linux-arm64/x64）发布样例副本。

它们与 `apps/acode-cli/packages/bigmodel-skills-data-plugin/skills/**`、`apps/acode-cli/packages/documents-plugin/skills/**`、`apps/acode-cli/packages/pdf-plugin/skills/**`、`apps/acode-cli/packages/spreadsheets-plugin/skills/**` 中的源脚本**逐字节相同**（已用 sha256 抽样核对 4 个脚本，均 IDENTICAL）。因此这些 finding 是同一份上游技能脚本在多个分发位置的重复计数。

### 5.2 `apps/acode-cli/packages/*-plugin/skills/**` 技能脚本（24 条）

这些脚本在 git 中**被跟踪**，但仍属第三方归属：由 commit `469024ef feat: 引入 14 个官方插件 + web-remote-relay` 引入的官方插件技能负载（docx/pdf/xlsx/pdf-extractor 等）。命中规则集中在 `XML 实体扩展`/`XXE`、`路径穿越`、`不安全的随机数`。

**归属与处置**：属上游官方插件技能脚本，修复应经上游同步，不在本仓库内单独改。建议在后续扫描中按路径前缀 `*/skills/` 自动归入 vendored 档，避免重复告警。

## 6. 复核结论（本分支改动文件交集）

以 `git diff --name-only dev/1.0.4..HEAD`（195 个文件）为集合复核：

- 最新扫描（scan-2026-11-02T07-13-15.785Z-fbeb171a9f17）落在改动文件上的 findings：**6 条**。
- 相对上一次扫描（`scan-2026-11-02T06-35-19.903Z-bc0775b7495c`，167 findings）：本次 287 条，**identity-new = 120 条，全部落在 vendored 区域**（bundled-agents/mock-cdn 的技能脚本副本）；**落在本分支改动文件上的 identity-new = 0**。
- 改动文件上的 6 条：**全部 `verdictEffect:none`**，与先前结论一致。

逐条（改动文件上）：

| 路径:行 | kind | severity | 档位 |
| --- | --- | --- | --- |
| `apps/acode-cli/packages/agent-teams-plugin/src/server.ts:134` | cross-file | medium | 待跟进 |
| `apps/acode-cli/packages/agent-teams-plugin/src/server.ts:148` | cross-file | medium | 待跟进 |
| `apps/acode-cli/packages/agent-teams-plugin/src/server.ts:75` | cross-file | high | 待跟进 |
| `apps/acode-cli/packages/bootstrap/src/app/create-app.ts:1367` | cross-file | high | 待跟进 |
| `packages/shared/src/test-ids.ts:175` | static | high | 误报 |
| `packages/shared/src/test-ids.ts:177` | static | high | 误报 |

**复核修正**：先前「改动文件上的 findings 均为误报」的说法**不完全成立**——其中仅 `packages/shared/src/test-ids.ts:175,177`（2 条，测试选择器常量）为已核实误报；其余 4 条是 `疑似跨文件污点`/`...到达 command-injection` 的**跨文件启发式候选**（`agent-teams-plugin/src/server.ts:75,134,148`、`bootstrap/src/app/create-app.ts:1367`），归入**待跟进**。它们同属 `verdictEffect:none`，但「none」在本次扫描中为全量默认值，不构成误报证据。

### 6.1 分支改动文件 4 条待跟进项的复核裁决（2026-11-02 增补）

对上述 4 条逐处读源码复核后的裁决（本节为 §6 表格的**改档依据**；原表保留作分诊时点记录）：

| 路径:行 | 原判 | 裁决 | 依据（当前检出可复核） |
| --- | --- | --- | --- |
| `agent-teams-plugin/src/server.ts:75`（startPanelAsync 经 2 跳到达 command-injection） | 待跟进 | **误报** | `src/panel.ts` 全文无任何 `node:child_process` 调用（grep 零命中）；面板是**进程内 HTTP 服务**（绑定端口后由 server.ts 写 panel-info），该调用链上不存在命令执行 sink，「到达 command-injection」无事实基础。 |
| `agent-teams-plugin/src/server.ts:134,148`（toolArguments → tool.handler 疑似跨文件污点） | 待跟进 | **可接受设计（在案）** | 污点面内唯一的命令执行 handler 是 `run_checks`，其执行面为冻结契约（`apps/acode-cli/specs/agent-teams-acceptance-loop.md` R1.2/R1.3，方案裁决点 1）：① 命令必须与任务 `verify` 字段的 `$ ` 声明行**逐 token 精确匹配**（大小写敏感、无通配，`worktree/exec.ts` `argvEquals`），不匹配即 `verify_required` 拒绝且**不执行**；② token 含 shell 元字符/引号/通配/控制空白一律拒绝（`FORBIDDEN_TOKEN_CHARS`，exec.ts:53，fail-closed）；③ `execFile` 无 shell 字符串拼接（exec.ts:234），唯一 `cmd.exe /d /s /c` hop 仅限 Windows `.cmd`/`.bat` shim 且 argv 作为独立元素传递（exec.ts:160-167）；④ 命令解析只走 PATH 搜索并归一为**绝对路径**（不含 cwd，排除工作目录二进制种植，exec.ts:113-135）；⑤ cwd 钉在成员 worktree、480s 超时、256KiB/流上限、超限整段丢弃。调用方只能在**已声明行中选择**，不能注入新 argv；声明行由成员写入自己任务，执行已声明的验收命令即产品功能本身，权限边界由宿主权限层承担（`rule.coordinator.readonly` 等）。 |
| `bootstrap/src/app/create-app.ts:1367`（resolveACodeCustomCommandPrompt 经 1 跳到达 command-injection） | 待跟进 | **重归存量 backlog** | 本分支对 `create-app.ts` 的全部 diff hunk 位于旧文件坐标 127/417/679/720/748/879（`git diff dev/1.0.4..HEAD` 可复核），**均未触及** 1367 行的自定义命令解析路径；该 finding 是文件被本分支修改导致的连带扫描，属存量代码。自定义命令解析读用户/项目自有配置（同信任域），其执行面是否权限门覆盖完整，归存量 backlog 按 §3.2 流程跟进，不计入本分支引入。 |

裁决后口径：本分支改动文件上的 6 条 = 误报 3（test-ids.ts×2 + server.ts:75）、可接受设计（在案）2（server.ts:134/148）、存量 backlog 1（create-app.ts:1367）。**本分支引入且未裁决的 finding 为 0。**


## 7. 复扫指引

后续扫描对照本台账时：

1. **按 `identity.instance` 比对**（本台账基线扫描：`scan-2026-11-02T07-13-15.785Z-fbeb171a9f17`）。忽略已在账的存量项，只处理新增项。
2. **只关注 identity-new 且落在自维护路径的项**。落在以下路径的 identity-new 直接归入 vendored 档，不再逐条处置：
   - `packages/desktop/bundled-agents/**`、`packages/desktop/mock-cdn/**`（gitignored 构建产物）
   - `apps/acode-cli/packages/*-plugin/skills/**`（官方插件技能脚本）
3. **注意 coverage 自报状态**：若新扫描仍为 `partial`/`inconclusive`，其 `verdictEffect` 可能仍全量为 `none`，不能据此判定误报；误报需按内容逐处核实。
4. **误报集中规则类**：`硬编码凭据` 在本仓库已重复误报（键名/枚举/mock/测试选择器），后续对该规则类新增项应优先按内容核实再决定处置。
5. 本台账的处置为**分诊建议**，不是修复承诺；待跟进项需人工确认后再进入修复流程。

---

生成时间：2026-11-02。数据源：`scan-2026-11-02T07-13-15.785Z-fbeb171a9f17/findings.json`（seal 校验摘要见同目录 `seal.json`）。
