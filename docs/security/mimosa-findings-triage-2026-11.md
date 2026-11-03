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

### 6.2 2026-11-03 复扫与 22 条具体项源码复核（AI 辅助会话增补，非原台账作者裁决）

> 本节由 2026-11-03 一次 AI 辅助复核会话追加，**与 §1-§6.1 的作者裁决分开署名**。
> 数据源：`scan-2026-11-03T05-54-54.981Z-a02e99b81cc6`（deep，attempt 1，一次跑完未 resume）。
> seal `sha256:e0ff255c20143b91d6ac048fd5ea29d11462fcdabe190182aee48cd19f582c51`；
> 三份语义文档摘要经本地重算与 `seal.json` 逐字一致。
> **coverage 仍为 `completeness: partial` / `runStatus: inconclusive`**（`threatModel` 与
> `findingDiscovery` 两个 phase 为 partial，`validation`/`pathAnalysis`/`reporting` completed；
> source 侧完整：selected 5909 / parsed 5909 / truncated false / readFailures 0）。
> 按 §7.3 与密封契约，partial 排除任何全项目安全声明；本节所有「误报」的含义是
> **在逐处读过源码并核实证据的范围内**成立，不是扫描器的判定。

**identity 集合比对（按 §7.1 口径）**：与基线扫描 `scan-2026-11-02T07-13-15.785Z-fbeb171a9f17`
按 `identity.publicClass|anchor|instance` 三元组比对，结果 **persistent 287 / new 0 / absent 0**。
即 287 这个数字相同不是巧合而是同一集合，§1-§6.1 的分档可 1:1 沿用，无需重新分诊。
非 vendored 计数 143 与 §2 增补口径（误报 9 + 可接受设计 2 + 待跟进 132）精确吻合。
`absent` 为 0，故不涉及 §7 所述「partial 下消失只能记 unknown」的情形。

**落在本次改动文件上的 finding：0 条**（改动为本地验证门禁一批，22 文件）。

**severity/class 分布（全量 287）**：high 199 / medium 76 / low 12；`other-security` 126、
`xxe` 72、`path-traversal` 55、`insecure-randomness` 12、`command-injection` 10、
`hardcoded-credential` 8、`code-injection` 2、`weak-crypto` 1、`business-logic-risk` 1。
其中 **120 条落在 gitignored 目录**（已实测确认 `packages/desktop/bundled-agents` 与
`packages/desktop/mock-cdn` 均被忽略）——不在版本控制内，源码层无法修，CI 侧扫描亦不可见。

#### 6.2.1 本次复核的 22 条具体项（`other-security` 120 条未纳入，见 6.2.4）

**误报 8 条**（另 8 条 `hardcoded-credential` 已由 §4 裁决，位置逐一吻合，本次只复核其依据
具体性——键名常量 / 错误原因枚举 / mock 占位串 / UI 测试选择器常量，且遵守「不复制字面量」
红线，成立）：

| 路径:行 | 类别 | 依据（当前检出可复核） |
| --- | --- | --- |
| `packages/desktop/native/windows-browser-import-helper/Program.cs:140` | command-injection | `Process.Start` 的 `Arguments` 全部由进程内值构成：`GetSelfPath()`（自身映像绝对路径）、GUID-N 管道名（32 位十六进制）、`CreateToken()` 的 64 位十六进制 CSPRNG、int PID。外部输入（stdin 导入请求含 chromePath）经 `ValidateImportRequest`/`ParseImportRequest`（3 段 tab 分割、base64、密钥长度 32..65536、扩展名必须 `.exe`）后**只经命名管道转发**，从不进命令行；chromePath 仅用于与 DPAPI app-bound blob 内嵌路径做归一化等值比较（`NormalizeProgramFilesPath`，OrdinalIgnoreCase 全等）。GUID-N/hex/int 字符集内不含 shell 元字符。 |
| `packages/server/src/remote/backend.ts:44` | command-injection | 该行是 `exec(command: string): Promise<StdioStream>;`——`IRemoteBackend` 的**接口类型声明**。全文 49 行只有 `import type` 与接口定义，无 `node:child_process` 导入、无执行点。与 §6.1 `server.ts:75` 误报同型（声明处无 sink）。实际执行体是 docker/ssh/wsl 三个实现，各自单列。 |
| `packages/server/src/remote/sshBackendUpload.ts:198` | command-injection | 命令为 `mkdir -p <quoted> && cat > <quoted>`，两个路径均经 `quotePosixShellArg`（单引号包裹 + `'"'"'` 转义）；**上传的文件内容走 stdin 字节流**（`readStream.pipe(stdin)`），不进命令字符串。`resolvedRemotePath` 来自部署层常量（`REMOTE_BASE="~/.acode/server"` + 常量文件名）或 `Date.now()+randomUUID()` 临时后缀。本地无进程 spawn，经 ssh2 channel 由远端 `/bin/sh -c` 解释。 |
| `packages/server/src/remote/wslBackendUpload.ts:30` | command-injection | 与上条同一模板、同一 `quotePosixShellArg`；且优先路径是 UNC 文件复制（`copyFileToAnyPath`，不经 shell），`cat` 流仅用于带进度/取消或 UNC 失败回退。 |
| `apps/acode-cli/packages/cli-workflow/src/script-workflow-child-source.ts:274` | code-injection | `vm.runInContext(SANDBOX_BOOTSTRAP, context, …)` 中 `SANDBOX_BOOTSTRAP` 是同文件 48-107 行的**编译期静态常量**（自述「纯 JS、不含反引号与 `${}`」），生成时经 `JSON.stringify` 内嵌（:316）。**274 行不含任何动态插值**；与动态数据的交互走 vm sandbox 对象属性（`__host`/`__argsJson`，:265-268），不走字符串拼接。判为对 `vm.runInContext` 调用形态的模式匹配。 |
| `apps/acode-cli/packages/core/src/tool/handlers/workflow-drafts.ts:91` | path-traversal | 扫描器称「未见根目录边界或文件名白名单校验」——边界存在，只是形态不是 `resolve`+前缀比较，而是 `path.join` **之前**的字符白名单：`WORKFLOW_DRAFT_SLUG_DROP_PATTERN = /[^\p{L}\p{N}_.-]/gu`（:36）丢掉 Unicode 字母/数字与 `_ . -` 之外的一切，路径分隔符与 Windows 保留字符（`/ \ : * ? " < > |`）、空白、控制字符因此都进不来；随后按码点截 64、剥首尾 `[.-]+`、全点或空则回退 `workflow`（:128-140）。**已门禁化**：新增 `packages/core/tests/workflow-draft-path-containment.test.ts`，以 15 组敌意名字（含 `../../`、`..\..\`、绝对路径、盘符、NUL、`....//`、换行夹带）断言落点必在草稿目录内，并全量扫描沙箱确认无越界文件；敌意输入只用有限层 `..` 且 cwd 埋在临时目录深层，故白名单若回归，逃逸落点仍在沙箱内、不会先写到真实系统路径。 |
| `packages/server/src/remote/sshKnownHosts.ts:29` | weak-crypto | `createHmac("sha1", salt)` **只用于解析 OpenSSH hashed known_hosts 的 `\|1\|salt\|hash` 既有格式**（`ssh-keygen -H` / `HashKnownHosts` 写出），本项目是该格式的**读取兼容方**而非定义方：代码硬校验版本字段 `parts[1]==="1"`、salt 与 hash 均 20 字节，比较用 `timingSafeEqual`。该 HMAC 的输出只回答「这行的主机字段是否为目标主机」，**不做密钥摘要、不做签名、不用于展示**；参与信任决策的**主机密钥指纹走 SHA256**（同文件 :19），裁决 fail-closed（仅 `trusted` 放行，缺席/抛错一律 `unavailable` 拒绝，`sshAuth.ts:219,224-238`，`hostHash:"sha256"`）。格式所有权见 `packages/server/specs/ssh-host-key-trust.md:46`；测试 `packages/server/tests/ssh-known-hosts.test.mjs:34,42` 构造真实 `\|1\|` 行断言接受。补充（属外部密码学常识，非仓库证据）：HMAC-SHA1 与裸 SHA1 在碰撞意义上不等价，HMAC 构造未受 SHA1 碰撞攻击影响。**「修掉」它是功能回归**：拒绝 `\|1\|` 行会使全部 hashed known_hosts 条目不匹配 → `unknown` → 认证前拒绝连接。 |
| `packages/acode-server-cli/src/server-core/http.ts:285` | business-logic-risk | 扫描器**框架前提错误**：该 server 是 **Hono** + `@hono/node-server`（`http.ts:3-5`），仓库内不存在任何 Nest guard/decorator，「未观察到 Nest guard」检查的对象不存在。且其描述对应 commit `a782a913`（批次 M1）**修复前的历史状态**。当前实现：配置 token 时全局 `app.use("*")` 中间件注册在所有路由之前，经共享 `resolveServerTokenAuth` + `isTokenProtectedPathname`（`/ws*` ∪ `/api/**`）覆盖本端点；handler 第一条语句即 Origin/Host 裁决，**先于 `issue()`**（spec 明文要求并附 DoS 推理：先校验则恶意网页连槽位都占不到）；body 全程不解析。启动侧 fail-closed 不变量：「非 loopback 绑定且无 token 一律拒绝启动」；默认 `host = 127.0.0.1`、`port = 0`（随机）。**运行时证据**：取证时实跑 `packages/server/tests/server-auth.test.mjs` → 46 pass / 0 fail，含「token 下无凭据铸票 → 401」「恶意 Origin 洪泛 300 次后无 Origin 原生铸造仍 200」「票据单次兑换」，直接回应扫描器「静态路径不能证明运行时 guard 执行顺序」的 proofGap。另注：本 server 无 RBAC 概念，授权模型 = 单 lite token（单 token=单主体）+ loopback + Origin 裁决 + 一次性票据，故「未观察到角色或权限检查」在字面上对无 token 姿态成立，但该姿态是 `packages/server/specs/server-auth.md` 明文裁决的设计而非遗漏。 |

**可接受设计（在案）3 条**：

| 路径:行 | 依据 |
| --- | --- |
| `packages/server/src/remote/ssh-backend.ts:341` | 本地**无进程 spawn**：经 ssh2 `client.exec(buildPosixShellExecCommand(command))`，由**远端主机 `/bin/sh`** 解释（统一进 `/bin/sh` 是为规避 fish 等默认 shell 的 POSIX 语法差异）。在用户自己配置的 SSH 主机上、以该 SSH 账号身份执行部署脚本即产品功能本身；连接参数全部来自用户自己的 `RemoteTarget`；host key fail-closed（默认只读本机 known_hosts，`hostKeyDecision !== "trusted"` 时即使 ready 也拒绝并 end）。 |
| `packages/services/src/acode-agent/acodeAgentProcessManager.ts:1545` | argv 数组 `spawn`、无 shell 选项。程序路径决定链有明确加固：打包态忽略 `ACODE_AGENT_SERVER_COMMAND`（`isPackagedACodeDesktopRuntime()` 读 `ACODE_APP_IS_PACKAGED==="1"`，该键由 desktop main 在 `...inheritedEnv` **之后** spread 写入，`desktopRuntimeEnv.ts:542` vs `:559`，故继承环境无法覆盖）；候选链全部 `resolvePath` 绝对化 + `existsSync` 门；字节码 loader 只认「已解析 bundle 的同目录兄弟」；`providerRuntimeResolver.ts:111-114` 注释明确排除了会下沉到用户可写目录、可被同用户进程劫持的独立候选链。规格 `packages/services/specs/agent-command-env-gate.md` R1/R2。 |
| `apps/acode-cli/packages/cli-workflow/src/script-workflow-child-source.ts:278` | `payload.scriptBody` **被有意作为代码求值**（:276 注释：包成 async 函数以支持顶层 await 与末尾 return）。作者是把 `RunWorkflow` 的 inline `script` / `scriptPath` 交给它的模型或用户自己保存的工作流文件，非网络静默输入。控制面：技能门（本会话未加载 `script-workflows` 技能即拒绝带 `script`/`scriptPath` 的调用）+ `alwaysAsk` 确认门 + vm realm `codeGeneration:{strings:false,wasm:false}` + 未提供 `importModuleDynamically` + realm 内无 `process`/`Buffer`/`require`。生成层 `JSON.stringify(payload)` 内嵌，脚本体是字符串字面量的一部分、不会被再解析一次。spec R4 有明文裁决，验收项 5a 要求残余逸出面（`agent.constructor.constructor("return process")()` 原型链上溯）**如实记录而非假装关闭**。 |

**待跟进 7 条**（其中 3 条本次已处置，见 6.2.2）：

| # | 位置 / 事项 | 状态 |
| --- | --- | --- |
| 1 | `runtimeLoginShellEnvCapture.ts:95,236`：`accessSync` 按 cwd 解析相对名、`spawn` 裸名按子进程 PATH 解析，**校验的文件与执行的文件可能不是同一个** | **本次已修**（见 6.2.2） |
| 2 | `run-workflow.ts:138` 注释与 spec R17.1 矛盾，且矛盾点正在 R4 安全论证的支点上 | **本次已修**（见 6.2.2） |
| 3 | `workflowDraftSlug` 无专门测试，白名单行为只有代码注释作证 | **本次已门禁化**（见 6.2.2） |
| 4 | `tool-port-launch.ts:71`：`scriptPath` 的绝对路径**原样接受、无工作区 containment**，模型可指定进程可读的任意文件作为脚本源；控制只有 meta 头校验 + 确认门。spec 未逐字讨论该任意文件读取面 → **spec 缺口**，非代码缺陷 | **本次已补 spec**（见 6.2.2 第 4 项）：复核后确认暴露面比原判**窄**——校验先于拷贝，非工作流文件被读入后即拒绝、不落盘不回模型，实际是「内容盲的解析 oracle」而非任意内容外泄；但它不经 Read 工具权限层，且 yolo 下 `alwaysAsk` 放行（R17.1）使技能门成为唯一控制。未加 containment（`name` 入参本就读工作区外的 `~/.acode/workflows/`，只收 `scriptPath` 会不一致），两条收口候选已写入 spec 待产品裁决 |
| 5 | `docker-detect.ts:76-107`：PATH 逐目录 join 解析 docker 可执行，**无 cwd/相对条目排除、不强制绝对路径**，兜底为裸名 `"docker"`；`wslBackendSupport.ts:19` 的 `wsl.exe` 同为裸名常量。与 §6.1 对 `run_checks` 要求的「归一为绝对路径、排除工作目录二进制种植」标准不一致 | **本次已修**（见 6.2.2 第 5 项）：复核确认严重度**高于原判**——Windows `CreateProcess` 解析裸名时把「当前目录」排在 System32 **之前**，故 `wsl.exe` 裸名是真实的 cwd 种植面，不只是「没绝对化」 |
| 6 | `wsl-backend.ts:268`：`options.distro` 仅 `z.string().optional()` **无字符校验**，而 `options.user` 有专用 `wslUserSchema`（≤64、拒控制字符与 `:`/`/`/`\`）——两个 schema 严格度不对称；且 `safeListDistros` 失败时吞错返回 `[]`，用户原始字符串可不经枚举比对直达 `-d`。有 `--` 终止符与 argv 隔离，不构成 shell 注入 | **本次已修**（见 6.2.2 第 6 项）：抽出共享叶子 `wslIdentityChars.ts`，distro 与 user 同强度同来源，两处 schema 站点（连接入口 + AppSettings）同步；测试以**对称性**为核心断言，任一方被单独放宽即红 |
| 7 | server-core 无 token 姿态下的多用户主机暴露（代码 `http.ts:159-163` 自陈）：未配置 `ACODE_SERVER_AUTH_TOKEN` 时，同机任意**非浏览器**进程（不带 Origin）可铸票并升级为 `desktop-continuous`，获得含全量凭据的完整 RPC；Origin 门只防浏览器上下文。spec 明文接受（边界 = loopback 绑定 + fail-closed + 启动告警），但**仓库既不生成也不强制该 token**，实际安全性取决于 operator | 待跟进（设计取舍，需产品裁决） |

另记两条不属于 finding 但本次发现的**依赖面事实**，见 6.2.3。

#### 6.2.2 本次落地的六处修复

1. **`SHELL` 必须是绝对路径才进候选**（`runtimeLoginShellEnvCapture.ts` `resolveShellPathForLoginEnv`）。
   相对值一律跳过，落到 `/bin/zsh → /bin/bash → /bin/sh`。**不推翻** `agent-command-env-gate.md`
   R3 的既有裁决（R3 接受的是「SHELL 指向同用户 planted 的可执行文件」，属同用户植入面、
   攻击者已有用户级代码执行；此处消除的是另一件事——「检查的不是将要执行的那个文件」）。
   正常登录 shell 的 `SHELL` 来自 passwd 条目、恒为绝对路径，fish/自定义 shell 用户不受影响。
   R3 已加追记写明这一区分。回归测试 `packages/services/test/login-shell-env-capture.test.ts`
   4 例，**已验证鉴别力**：临时撤掉绝对路径门禁则该用例红、装回则绿；另含「绝对路径的自定义
   shell 仍被采用」正向用例，防止收口过度。
2. **纠正 `run-workflow.ts:138` 注释**：原文「任何权限模式（含 yolo / plan）都要先问」在 yolo
   上是错的。实测 `permission/service.ts` `checkAlwaysAsk`：项目 deny → **yolo 直通 allow
   （`mode.yolo.alwaysAsk`）** → 项目 ask → 会话 allow → TTL → owner-Amend → ask；yolo 分支
   条件与 `checkPermissionByMode` 逐字同档（`planEnabled` 不放行、策略地板
   `disableBypassPermissionsMode` 不放行）。同时把「持久确认永不减免」拆成独立理由
   （它讲的是 `allowAlways` 只给会话作用域，与「谁要问」无关）。
3. **在 spec R4 里写明其支点被 R17.1 局部抽掉**：R4 称 `alwaysAsk` 是「真正的控制」，但
   R17.1（批次 C11）之后 yolo 放行该门，故 yolo 下残余逸出面之前只剩技能门与「必须刻意构造
   原型链攻击」这一成本，**没有逐脚本的用户批准**。追记只负责写明白，**不重新裁决**——
   是否在 yolo 下为工作流族恢复确认门属 R17.1 范围，需用户裁决。

4. **`scriptPath` 暴露面写进 spec**（`apps/acode-cli/specs/script-workflow-revival.md`
   「已知边界」第 8 条）。复核把原判收窄了：`validateScriptPath` 的实现就是
   `readWorkflowScriptDocument` + 取消检查，**不含 containment**，但校验发生在
   `persistScriptCopy` **之前**，且文件必须带合法 `export const meta = {…}` 头才继续，
   错误信息只带路径不回显内容——所以实际能力是「读任意可读文件（有 `SCRIPT_READ_MAX_BYTES`
   上界）并得知它是否解析为工作流脚本」，即**内容盲的解析 oracle**，不是任意内容外泄。
   真正值得注意的是它**不经 Read 工具的权限层**，而 yolo 下 `alwaysAsk` 放行（R17.1）使技能门
   成为唯一控制。**未加 containment**：`name` 入参的候选目录本就含工作区外的
   `~/.acode/workflows/`（`tool-port-launch.ts:144-149`），只收 `scriptPath` 会与既有设计意图
   不一致；两条收口候选（经文件读取权限层 / 对两个入参同时引入允许根白名单）已写入 spec 待裁决。
5. **宿主侧可执行解析归一为绝对路径**（`packages/server/specs/remote-deploy-hardening.md` 新增 R4）。
   复核确认严重度**高于原判**：Windows `CreateProcess` 解析裸名的顺序是「调用方 exe 目录 →
   **当前目录** → System32 → …」，当前目录排在 System32 之前，故 `WSL_COMMAND = "wsl.exe"`
   不只是「没绝对化」，而是真实的 cwd 种植面。改动：新增 `resolveWslCommand()` 作为唯一解析入口
   （返回 `<SystemRoot>\System32\wsl.exe`，经 `access(X_OK)` 确认；解析不出才回退裸名，保持既有
   行为不变砖；结果 memoized），三个 spawn/execFile 站点全部改为先 await 它；`docker-detect.ts`
   遍历 PATH 时跳过非绝对条目（含 `.` 与空串）。**并消除了 `WSL_COMMAND` /
   `WSL_EXEC_MAX_BUFFER` 在 `wsl-detect.ts` 的第二份声明**——「用哪个 wsl.exe」此前有两处写入
   路径，加固只会改到其中一处。R4.4 如实登记残余：都找不到时仍返回裸名 `"docker"`（改为抛错会
   改变全部调用方的错误语义，且该分支只在 docker 本就不可用时到达）。
   回归测试 `packages/server/tests/remote-executable-resolution.test.mjs` 7 例：docker 侧用
   `resolveDockerCommand` 既有的 platform/env/isExecutable 注入做确定性断言（`isExecutable` 恒真
   时若解析器仍考虑相对条目就会命中 `.`，故用例具备鉴别力）；wsl 侧断言可观察契约（绝对路径或
   文档化回退 + memoized）并以静态扫描守住「无裸名 spawn 站点」「`WSL_COMMAND` 只有一处声明」。
6. **WSL distro 与 user 同强度校验**（新增 `packages/shared/src/wslIdentityChars.ts` 共享叶子 +
   `wslDistroValidation.ts`）。约束抽成独立叶子而非各写一份：两个字段的合法字符集相同且**必须
   同步演进**，放宽一个忘了另一个就会重现本次的不对称。两处 schema 站点（`validation.ts` 的
   `wslConnectOptionsSchema` 与 `validationAppSettings.ts` 的 WSL 分支）同步改用
   `wslDistroSchema`——远程历史重连会直接使用 settings 里的值，只改连接入口等于留了绕过 UI 的
   第二条路。`WSL_USER_MAX_LENGTH` 保留原导出名（它是 `@acode/shared` 公开 barrel 的一部分，
   删名属破坏性变更），值与 distro 共享同一常量。回归测试
   `packages/shared/test/wsl-identity-validation.test.ts` 5 例，**核心断言是对称性**：逐个输入
   比较 `isValidWslDistro` 与 `isValidWslUser` 的判定，任一方被单独放宽即红；另钉住真实 distro 名
   （`Ubuntu-22.04`、`docker-desktop`、`Alpine.WSL` 等）不被误伤、空串仍代表「未指定」而非报错。

#### 6.2.3 依赖通告：扫描器严重低估（本次新发现，与 findings 无关）

本次扫描 `dependencySummary` 报 `packagesScanned: 1413`、`matchedPackages: 1`、
`matchedAdvisories: 1`、`unknown: 0`，但 **`packages` 数组为空，且 287 条 finding 中无任何一条
携带 `advisory` 字段**，`report.md` 只有「静态 advisory 需要人工确认真实数据流和可利用性」
一类通用注记——**密封产物无法确定那 1 个匹配包与那 1 条通告是什么**。

改用实时库独立核对（`pnpm audit --json` / `--prod --json`，并与 `pnpm-lock.yaml` 的实际解析
版本逐一比对，确认不是版本范围误匹配）：

- 全量（含 dev）**82 条**：critical 4 / high 34 / moderate 39 / low 18。
- 仅生产依赖 **40 条**：critical 1 / high 19 / moderate 16 / low 8。

已确证解析版本落在漏洞区间内的高优先项：

| 包 | 解析版本 | 修复版本 | 既有 override | 备注 |
| --- | --- | --- | --- | --- |
| `dompurify` | 3.4.16 | ≥3.4.17 | `dompurify@3: ^3.4.16` | **唯一生产 critical**（SAFE_FOR_TEMPLATES 绕过）；范围本就允许修复版 → 属**锁文件陈旧** |
| `node-forge` | 1.4.0 | ≥1.4.1 | 无 | 6 high + 3 moderate + 3 low（含 X.509 basicConstraints 绕过、PKCS#12 MAC 伪造） |
| `undici` | 6.29.0 / 7.30.0 | ≥6.29.1 / ≥7.30.1 | `^6.28.0` / `^7.28.0` | 3 high（TLS 校验绕过、跨源重定向缓存投毒）；差一个补丁位 |
| `follow-redirects` | 1.16.0 | ≥1.16.2 | 无 | 3 high（凭据头跨域泄漏） |
| `basic-ftp` | 5.3.1 | ≥6.2.1 | `basic-ftp@5: ^5.3.1` | **override 钉死在 5.x，永远到不了 6.2.1——该 override 主动挡住修复**，需跨大版本决策 |
| `@modelcontextprotocol/server` | 2.0.0 | ≥2.3.0 | 无 | 3 high；`client`/`core` 已是 2.3.1，**只有 server 落后** |
| `@modelcontextprotocol/sdk` | 1.29.0 | ≥1.32.0 | 无 | high：OAuth 凭据可能发给 MCP server 指定的授权服务器 |
| `zod` | 4.6.5 | ≥4.6.6 | 无 | high（超大受约束集合可耗尽内存） |
| `@hono/node-server` | 1.19.14 | ≥1.19.15 / ≥2.1.3 | 无 | 2 moderate，其一为 **Windows `serve-static` 编码反斜杠路径穿越**，与本项目平台相关 |
| `qs` / `moment` / `uuid` / `ip-address` / `katex` | 6.15.1 / 2.30.1 / 11.1.0 / 10.7.2 / 0.16.47 | 见通告 | `ip-address@10: ^10.5.1` | moderate~low |

三点口径必须一并记住，否则会误判紧急度：

1. 另 3 条 critical（`handlebars` ×2、`proxy-addr`）**只出现在含 dev 的全量列表**，不在 `--prod`
   → 开发依赖，不随产品分发。
2. **`--prod` 对 Electron 应用会漏算发货面**：`electron` 自身有 7 条通告（含 1 条 high
   「eMudhra 中间证书被攻破的缓解」），按惯例记为 devDependency，但它确实打包进安装包。
   故「生产依赖 40 条」是**下界**，不是发货面全貌。
3. **修复受本仓纪律约束**：改 `pnpm-lock.yaml` 会触发 third-party 台账 `full` 模式，按
   `docs/specs/local-verify-gates.md` R7.24，依赖树有变时必须在 CI Linux 上全量重生成后下载
   artifact 提交，**不得在 Windows 上跑 `licenses.mjs notices`**（`packages`/`noticesSha256`
   等派生字段依赖平台相关 optional deps，本机会算错）。故这是一次独立变更，未在本次处理。

#### 6.2.4 本次未覆盖的范围（如实登记）

- `other-security` **120 条（57 high + 63 medium）未复核**——该类别笼统，需先按 §3.1 规则聚合
  再定抽样策略。`xxe` 72、`path-traversal` 其余 54、`insecure-randomness` 12 同样未逐条复核
  （其中大部分按 §5 属 vendored）。
- 未验证 `permission/service.ts` 之外 yolo 放行的端到端运行行为（本次只读了 `checkAlwaysAsk`
  实现并据其纠正注释，未跑 yolo 模式的真实工具调用）。
- 未验证 `getRunDetail` 服务端 `scriptPath` 的完整性（§6.2.1 待跟进第 4 条的上游）。
- 未验证 `resolveSpawnEnv` 在 `acodeAgentService.ts` 的装配内容。
- 依赖通告只核了「解析版本落在漏洞区间」，**未验证任一漏洞在本项目的调用形态下可利用**。
- Supervisor 的 control socket / IPC 通道（`packages/acode-server-cli/src/ipc/`）是 HTTP 之外的
  另一控制面，未纳入。


#### 6.2.5 待跟进第 7 条的决策简报（server-core 无 token 姿态；**需产品裁决，本次未改行为**）

**暴露面的精确形态**（取证已闭环，非推测）：`acode-server-cli` 的 server-core 恒绑定
`127.0.0.1` + 随机端口（`core.ts:45` 不传 host/port，`http.ts:158/313`），且「非 loopback 绑定
且无 token 一律拒绝启动」是 fail-closed 启动不变量（`serverAuth.ts:59-66`）。**未配置
`ACODE_SERVER_AUTH_TOKEN` 时**：全局 token 中间件不挂载，同机任意进程可
`POST /api/rpc-host-capability` 铸票，再经 `/ws/host` 兑换升级为
`clientMode: "desktop-continuous"` / `role: "trusted-host-relay"`，而该模式**保留全量 Credential
通道**（`http.ts:124-132` 只对其他连接收窄凭据）。Origin 门只拦浏览器上下文（跨源 simple POST），
**拦不住不带 Origin 的原生进程**。

**为什么现在是这个姿态**：`packages/server/specs/server-auth.md` 明文裁决「loopback 无 token 是
受支持的默认姿态」，边界 = loopback 绑定 + fail-closed 不变量 + 启动告警。代码自己也自陈威胁
（`http.ts:159-163` M1 注释：「多用户主机上任意本地用户可获完整 file/terminal/credential RPC」）。
所以这**不是遗漏，是已知取舍**；问题在于取舍的前提（loopback ≈ 单一信任域）在**多用户远端主机**
上不成立，而 server-core 的主要部署形态恰恰是远端 Linux 服务器（`verify-remote-ssh.mjs:207`：
「Core 只监听远端回环地址；ssh -L 隧道是到达它的唯一路径」）。

**一条降低处置成本的关键事实**：取证发现**仓库内没有生产的铸票消费方**——非测试的唯一
铸造+兑换调用点是验证脚本 `verify-remote-ssh.mjs:254-278`；desktop 的
`serverRemoteConnection.ts` 只连 `/ws`（Bearer 头）、不铸票，desktop 的 SSH 远程工作区走 stdio
socket（`connect.ts`/`stdio-socket.ts` 无任何 HTTP fetch）。`packages/server/src/http.ts:98` 的注释
自称「唯一消费链 serverRemoteConnection.ts」与该文件实际代码不吻合。**故收紧 mint 端点的仓内
破坏面可能为零**；但无法从本仓证实或证伪是否存在仓外/未来消费方，这正是需要裁决的地方。

**四个选项与代价**：

| 选项 | 做法 | 收益 | 代价 / 风险 |
| --- | --- | --- | --- |
| A 现状 | 由 operator 自行设置 `ACODE_SERVER_AUTH_TOKEN`；仓库不生成、不强制 | 0 | 多用户主机上任何本机用户可取得含凭据的完整 RPC；实际是否安全完全取决于部署者是否知道要设这个变量 |
| B 首启自动生成 token（**推荐**） | Supervisor 首次启动生成随机 token，写入 `status.json` 并限 `0600`；desktop 经 SSH 隧道读取后带 Bearer 连接 | **真正关掉多用户洞**：其他用户读不到 token 文件即无法鉴权；loopback 边界从「同机所有人」收窄到「同用户」 | 中。需改 Supervisor 启动、status.json 权限与写入时序、desktop 连接流程；且要为既有无 token 部署设计迁移（否则升级即断连） |
| C 多用户主机强制 token | 检测到多用户主机时拒绝无 token 启动 | 精准命中风险场景，单机用户零影响 | 「多用户主机」的可靠检测本身不易（存在即视为多用户会误伤单用户 Linux 桌面）；拒启动是硬失败，可能砖掉现有部署 |
| D 无 token 时拒绝铸票（**廉价的部分收口**） | `mint` 端点在「未配置 token」时直接 403，其余 `/api` 面不变 | 关掉提权门票这一条最严重的路径（拿不到 `desktop-continuous` 即拿不到全量凭据通道），改动只有一处判断 | 低——**但前提是「仓内无生产铸票消费方」这条事实成立**（见上）。若存在仓外消费方则会断掉它；且它不解决 `/ws` 与其余 `/api` 在无 token 时对同机所有用户开放的问题 |

**建议**：以 B 为目标（它是唯一真正消除多用户暴露的方案），D 作为 B 落地前的过渡（改动一处、
风险可控、且能立刻移除最严重的提权路径）。C 的检测可靠性不足，不建议单独采用。A 等于把安全性
寄托在部署者读过文档。

**本节不做的事**：不改任何行为。B/C/D 都改变 server-core 的鉴权姿态与升级兼容性，属产品与发布
决策；且 D 的前提（无仓外消费方）本仓无法自证。需 owner 选定后再实施，实施时按 AGENTS.md
先改 `packages/server/specs/server-auth.md` 的「loopback 无 token 是受支持的默认姿态」这条裁决。

#### 6.2.6 依赖升级批次的执行结果（2026-11-03，承 §6.2.3）

**结果：生产依赖 advisory 40 → 7；critical 1 → 0、high 19 → 2、moderate 16 → 3、low 8 → 4。**

采取的手段（按优先级）：

1. **抬既有 override 的地板**（范围本就允许修复版，属锁文件陈旧）：`dompurify@3` ^3.4.16→^3.4.17、
   `undici@6` ^6.28.0→^6.29.1、`undici@7` ^7.28.0→^7.30.1、`ip-address@10` ^10.5.1→^10.7.4、
   `fast-uri@3` ^3.1.6→^3.1.9。
2. **新增同大版本内的 override**（minor/patch，semver 兼容）：`node-forge@1` ^1.4.1（→1.4.2）、
   `follow-redirects@1` ^1.16.2、`@modelcontextprotocol/{server@2,client@2,core@2}` ^2.3.0
   （server 2.0.0→2.4.0；client/core 已是 2.3.1，此举同时消除了 MCP 包族的版本错配）、
   `@modelcontextprotocol/sdk@1` ^1.32.0（→1.32.2）、`qs@6` ^6.16.1（→6.17.1）、
   `uuid@11` ^11.1.1、`@hono/node-server@1` ^1.19.15（→1.19.18）、`body-parser@2` ^2.4.0、
   `handlebars@4` ^4.7.10（dev）、`postcss-selector-parser@{6,7}`。
3. **改我们自己的声明**（zod）：12 个入库 `package.json` 精确钉版 `"zod": "4.6.5"` → `"4.6.7"`，
   另 `apps/acode-cli/packages/node-repl-host` 的 `"^4.4.3"` → `"^4.6.7"`（它是 `dependencies`
   而非 peer，抬地板安全）。zod 由此从 3.25.76 / 4.6.5 / 4.6.7 三版并存收敛为 3.25.76 / 4.6.7 两版。

**两次踩坑与其教训（记录以免重犯）**：

- **`moment` 的 override 会破坏第三方包的 peer 声明，已撤销。** 加 `"moment@2": "^2.31.0"` 后，
  锁文件里 `vis-timeline@8.5.1` 的 `peerDependencies.moment` 被改写成 `^2.31.0`，而实际解析仍是
  `2.30.1`——声明与实解自相矛盾。改成无选择器的 `"moment": "^2.31.0"` 同样无效。根因：moment 在
  全树里**只是 vis-timeline 的 peer**（`pnpm view vis-timeline@8.5.1 peerDependencies` 确认真实范围
  是 `^2.24.0`），没有任何包把它当真实依赖，override 改不到 peer 的实际解析版本。撤销后
  vis-timeline 的声明还原为 `^2.24.0`。**教训：override 会改写 peerDependencies 声明，
  对「仅作为 peer 存在」的包无效且会制造矛盾，此类项不能用 override 修。**
- **`zod@4` 的 override 造成 unmet peer，已改用直接抬声明。** 加 `"zod@4": "^4.6.6"` 后 install
  出现 `✕ unmet peer zod@^4.6.6: found 3.25.76`（在 `shadcn` 里，两条）：override 把 shadcn 的
  peer 声明收窄成 `^4.6.6`，而它实际拿到的是 zod 3.25.76（本在其原始范围内）。撤掉 override、
  改为直接抬我们自己的 13 处声明后，警告消失（只剩既有的 `unmet peer typescript@^5: found 6.0.2`，
  与本次无关）。**教训：能改自己声明就不要用 override；override 是 blunt instrument，
  会连带改写第三方的 peer 契约并产生假警告，而假警告会让人开始忽略真警告。**

**剩余 7 条（全部需要跨大版本或不同机制，本批未做，逐项理由）**：

| 包 | 严重度 | 现状 | 为何未做 |
| --- | --- | --- | --- |
| `basic-ftp` | high | 5.3.1，修复需 ≥6.2.1 | **跨大版本**。它不是任何包的直接依赖，只经 override `basic-ftp@5: ^5.3.1` 钉住；改 6.x 等于强制上游依赖跨 major，需先确认其 API 兼容性与上游是否已适配 |
| `zod` | high | 4.6.7 已修；剩余是 **zod@3.25.76** 那个实例（通告范围 `<4.6.6` 字面涵盖 3.x） | **跨大版本** 3→4，涉及 6 处依赖方（含 `zod-to-json-schema@3.25.2` 的 peer 绑定），是独立迁移项目 |
| `uuid` | moderate | 11.1.1 已修；剩余是 **uuid@9.0.1** 那个实例 | 跨大版本 9→11 |
| `moment` | moderate | 2.30.1 | 仅作为 vis-timeline 的 peer 存在，override 无效（见上）。可行路径是等 vis-timeline 自身抬 peer，或改用非 override 机制 |
| `@hono/node-server` | moderate | 1.19.18（`<1.19.15` 那条**已修**）；剩余那条需 ≥2.1.3 | 跨大版本 1→2 |
| `katex` | low | 0.16.45 / 0.16.47 | 0.x 的次版本即破坏性，需 ≥0.18.2 |
| `@ai-sdk/provider-utils` | low | 未处理 | patch 级可修（≥4.0.33），本批为控制 diff 规模未纳入 |

另：`electron` 41.10.7 有 7 条通告（含 1 条 high「eMudhra 中间证书被攻破的缓解」）。它按惯例记为
devDependency 故不出现在 `--prod` 列表，但**确实打包进安装包**——`--prod` 的 40→7 不含它，
升级 Electron 属独立的平台级变更。

**必须知道的后续动作（本批无法在本地完成）**：依赖树已实质变化（本轮 install 净移除 200+ 个包、
MCP 包族跨小版本），台账的 `packages` / `noticesSha256` / `notInstalled` 等**派生字段已过期**。
这些字段依赖平台相关的 optional deps，按 R7.24 **不得在 Windows 上重生成**。
本批只把 `inputs` 的 15 条源文件哈希（14 个 `package.json` + `pnpm-lock.yaml`）按台账自己的口径
（`hashBytes`，CRLF→LF）重算并做了纯文本替换，故 `ci.yml` 的 `--inputs-only` 开发期信号为绿
（2904/2904，diff 恰好 15 行、无格式漂移）；但 `licenses-notices.yml` 的 **`full` 模式会红**，
这是设计内的两段式回路：该 workflow 的 `pull_request` 触发路径已包含 `pnpm-lock.yaml` /
`**/package.json` / `third-party/**`，推送后它会在 CI Linux 上全量重生成并上传 artifact，
需下载该 artifact 提交后才收敛。按 `docs/git-collaboration.md`，release 分支上
「licenses-notices 等专项闸门全部 success」是发布前置，**故本批在 artifact 回填前不可发布**。

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
