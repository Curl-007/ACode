# PowerShell 一等工具 + 双 shell 联动警告（W2-PS）

> 需求形态参照 Claude Code 2.31226/2.37337 的 Windows 平台面证据（还原工程
> prompts/0078 PowerShell 工具描述、0030 Bash=Git Bash 锚定、0095 启动拒绝原因
> shell_tool_missing、0576/1697 edition 差异注记、24846/36362 bare Bash 权限键
> 连带 PowerShell、17269 CLAUDE_CODE_USE_POWERSHELL_TOOL 门、37892 hooks shell
> form 的 Windows PowerShell fallback）。描述与实现全部自撰，未拷贝上游文本。

## 背景与证据

- ACode 现状：Bash 工具在 Windows 经 `adapters/src/exec/bash-shell-provider.ts`
  解析 Git Bash（缺席时 cmd/legacy fallback）；`core/src/tool/handlers/bash.ts`
  的 `commandShellKind`（:422-432）仅按 displayName 把 powershell 归类进 telemetry
  （:426），无独立 PowerShell 工具、无双 shell 联动警告。
- Windows 原生面（注册表 HKLM:/HKCU: PSDrive、服务、ACL、事件日志、WMI、
  .NET 互操作）在 Git Bash 中不可达或别扭；Git Bash 是安装面负担，PowerShell
  是 Windows 自带面。分工：POSIX/git/跨平台工作流走 Bash（Git Bash），Windows
  原生面走 PowerShell。
- Claude 形态复核（描述要点，非文本搬运）：工作目录跨命令保持而 shell 状态
  （变量/函数/env）不保持；创建文件/目录前先验证父目录；含空格路径双引号纪律；
  -NonInteractive + stdin 空设备（交互 cmdlet 直接失败）；here-string 关闭符必须
  顶格；edition 注记按 5.1（无 `&&`/`||`/三元，`A; if ($?) { B }` 替代）与
  pwsh 7+（有）分别注入；`-ErrorAction SilentlyContinue` 不改变 exit 1 语义；
  启动拒绝原因 shell_tool_missing =「Git Bash 缺席且 PowerShell 缺席/被关」。

## 产品规则

文件落点（handlers/ 目录 max-lines ratchet 下的拆分形态，先例 bash-* 族）：
`powershell.ts`（handler/entry/公开引用点）、`powershell-prompt.ts`（描述）、
`powershell-launch.ts`（可执行解析）、`powershell-cwd.ts`（命令包裹与 cwd 捕获）、
`powershell-risk.ts`（关键词面与 capability）、`powershell-shell-availability.ts`
（联动警告 detector）。

### R1 工具面

- 工具名 `PowerShell`；入参/出参复用 Bash 契约形状（`BashInputSchema`/
  `BashOutput`：command 必填，timeout/description/run_in_background/
  dangerouslyDisableSandbox/justification 可选），不新增 contracts 面。
- 描述（`createPowerShellProviderDescription`，自撰）必须覆盖：定位与分工、
  持久性语义（目录保持/状态不保持）、目录先验证、路径引号纪律、语法注记
  （$ 变量、反引号转义、Verb-Noun、对象管道、注册表 PSDrive、$env:、调用
  操作符 `&`）、Unix 等价命令表、NonInteractive 纪律（禁 Read-Host/
  Get-Credential/pause/交互 git）、here-string 纪律、exit code 语义、专用工具
  优先（文件读写搜索不用 PS 复刻）、多命令编排（并行分次调用/顺序 `;`/
  不用换行分隔）、不加 cd/Set-Location 前缀、git 纪律（不 amend 优先、破坏性
  操作慎用、不跳 hooks）。edition 注记按解析到的可执行文件注入（R2）。
- 元数据与 Bash 同档：readOnly false、destructive false、concurrentSafe false、
  sideEffectScope system、riskLevel high、needsApproval true、超时/结果预算/
  取消/trace 策略与 bashToolEntry 同值。

### R2 执行形态与可执行文件解析

- 每次调用 spawn 全新进程：`mode:"argv"`，args 固定
  `[-NoProfile, -NonInteractive, -Command, <wrapped>]`，stdin 缺省（=null
  设备）。不用 shell mode（Node 对自定义 shell 字符串按 cmd `/d /s /c` 传参，
  与 PowerShell 不兼容），不改 execution port 契约。
- 解析顺序：`pwsh`（PATH，edition=PowerShell 7+）→ `powershell.exe`
  （`%SystemRoot%\System32\WindowsPowerShell\v1.0\` 与 PATH，edition=Windows
  PowerShell 5.1）。解析不到 → `ConfigurationError` fail-closed（绝不静默换
  shell）。解析函数接受注入 env/exists 以便测试。
- 一期注册面 win32（接线建议见 R8）；跨平台 pwsh 登记后置。

### R3 工作目录持久 / shell 状态不持久

- wrapped = 用户命令 + 状态捕获尾：读 `$?`/`$LASTEXITCODE` → 成功时把
  `(Get-Location).Path` 写入临时文件 → 失败时以原语义退出（native 非零透传
  原 exit code；cmdlet 失败 exit 1）。用户命令内 `exit N`/解析错误跳过尾部
  （无捕获、退出码即事实）。
- handler 读回临时文件（读完即删，finally best-effort）→ `decideBashCwdPolicy`
  （项目内保留；越界 reset 回 workspaceRoot 且把 reset 文案并入 stderr）→
  `context.setWorkingDirectory`。工作目录唯一所有者是 session 状态，handler
  只提议、不持有。
- 变量/函数/env/别名不跨调用（-NoProfile 全新进程），与 Bash 工具同一哲学。
- 后台：显式 `run_in_background` 复用 `runBashWithBackgroundLifecycle`（端口
  泛型）；闲时 turn 拒绝显式后台（与 bash 同款）；超时自动转后台一期不提供
  （eligibility 判定是 bash 语法面），登记后置。

### R4 权限与风险分类（bash 同款面 + 一期关键词面对齐）

- 权限标识沿用 `permission:"bash"` 能力族；patternSources/alwaysAllow
  `["command"]`；denyPriority `beforeAsk`。规则域按 toolName 精确匹配
  （`PowerShell(...)` 独立于 `Bash(...)`；executor 默认建议规则携带正确
  toolName + 精确 command 内容）。无自定义 rulePolicy（PS 语法的前缀通配
  规则生成后置登记）。
- capability 解析（`resolvePowerShellPermissionCapability`）：
  1. `assessBashCommandTargetRisk` 复用——现有 grammar 对 PS 文本已覆盖
     `WINDOWS_DESTRUCTIVE_PROGRAMS`（del/erase/rd/format/remove-item）与
     `$env:VAR` 目标展开；confirm/catastrophic → critical + needsApproval +
     destructive（autoApproveHighRisk 不可自动批准）。
  2. PowerShell 专属 confirm 关键词面（一期 deny/ask 对齐的最小集）：
     `-EncodedCommand`/`-e`+base64、`-File` 脚本载荷、`Invoke-Expression`/
     `iex`、点源动态路径、`Invoke-Item`、`Stop-Computer`/`Restart-Computer`/
     `Stop-Process -Force` 系统面、`Format-Volume`/`Clear-Disk`/`diskpart`、
     `Set-ExecutionPolicy`、注册表 PSDrive（HKLM:/HKCU:）写删、引擎钩子
     （`Register-EngineEvent`/`Set-PSBreakpoint`/`Update-TypeData`/
     `Update-FormatData`）、profile/PSReadLine 历史写入 → confirm 档
     （critical capability）。
  3. **无 readonly 快径**：PS 只读语法一期不分类，所有未命中命令回落 entry
     默认（high + needsApproval）——fail-closed，方向与 Claude「pyright 不再
     视为只读、ps 更多形态转询问」的收紧一致。
- telemetry：`shellKind:"powershell"`（结构事实，不走 displayName 启发）。

### R5 双 shell 联动警告

- 纯函数 `detectNoShellToolWarning(facts)`（powershell-shell-availability.ts，
  经 powershell.ts re-export）：当 **Bash 与
  PowerShell 同时被 bare deny**（`disallowedTools` 含名，或策略地板/项目 deny
  规则集中存在无 ruleContent 的同名规则）→ 返回
  `{code:"no_shell_tools", message}`（模型面英文文案：无任何 shell 工具可用，
  终端命令能力全灭；UI 可按 code 本地化）。单边 deny 不告警。
- 落点调查结论：启动诊断面在 `bootstrap/src/app/create-app.ts`
  （permissionAuditLogger，:544-557 构造 PermissionService 处事实齐备：
  config.permission.disallowedTools + policy.deny + 项目规则），**不在本条目
  所有权内** → 接线需求（R8）。

### R6 Bash 工具对齐（bash.ts / bash-prompt.ts）

- `commandShellKind`（bash.ts:426）补 `pwsh` displayName 归类（现状只认
  "powershell"，pwsh 选择会误落 other/cmd），并注释指向独立 PowerShell 工具。
- Bash 描述（bash-prompt.ts）在 win32 追加 Git Bash 锚定行：本工具在 Windows
  运行 Git Bash（POSIX sh），非 cmd.exe/PowerShell；用 POSIX 语法（/dev/null
  非 NUL、正斜杠、$VAR 非 %VAR%/$env:VAR）；Windows 原生面（注册表/服务）
  改用 PowerShell 工具。

### R7 TUI 面

- transcript 详情（app-tool-transcript.ts）：`powershell` 分派到与 bash 同款
  行面（command/timeout/background 行）；未分派工具已有 genericInputDetails
  自动兜底，标题兜底 `Tool <name> <status>`。
- 审批 scope 面（app-approval.ts:98）：规则 toolName 过滤从仅 "bash" 扩为
  bash|powershell（精确/前缀命令行展示同款）。
- 其余 TUI 面（审批标题、状态行）按 toolName 泛型渲染，自动兜底。

### R8 接线需求（非本条目所有权，报告同步）

1. `core/src/tool/handlers/index.ts`：builtInTools/分支工厂注册
   `createPowerShellToolEntry`（建议 win32 且可解析到 PowerShell 时注册；
   timeout policy 与 Bash 同源传入）。
2. `core/src/permission/bypass-immune-breakers.ts` :86/:146/:318 三处
   `toolName !== "Bash"` 门补 "PowerShell"——否则 catastrophic PS 命令在
   yolo 下无 deny 级熔断兜底（capability 无 deny 通道）。
3. `packages/ui/src/PermissionDialog.tsx` :104 同款 scope 过滤补 powershell
   （桌面/Web 审批面）。

## 登记项（缺口与后置）

- **PS 语法级风险文法后置**：bash-target-risk grammar（4743 行）是 bash 词法
  面；PS 完整语法（Verb-Noun 全集、反引号转义、here-string、PSDrive、对象
  管道、`--%` stop-parsing）文法过大，一期以 R4.2 关键词面 + 无 readonly
  快径 + 复用 grammar 已覆盖形态兜底；语法级文法登记后置。
- **bare Bash 规则不连带 PowerShell**：`matchesRuleToolName` 精确匹配
  （service.ts），与 Claude「bare Bash 键连带治理 PowerShell 工具」不同。
  一期取独立规则域（联动警告 R5 正以「两边都被 deny」为前提）；连带语义
  若要做属 permission/service.ts 面，登记。
- **ps/pyright 收紧方向**：Claude changelog 287/290 证据在还原工程不可文本
  得（仅 exe），登记方向：ACode bash readonly 面已有
  `pyrightCommandIsDangerous` 回调（bash-readonly-policy-callbacks.ts:108），
  `ps` 未入 readonly 白名单——现状已偏紧，无需动作。
- **SKILL-A 交叉记录**：技能 frontmatter `shell:` 键（选 `!` 块 shell；Claude
  证据 37892：hooks shell form bash on POSIX / PowerShell on Windows without
  Git Bash）。ACode `adapters/src/skills` 现无 shell: 键（SKILL-A 独占面，
  本条目不改）；SKILL-A 落地 `shell: powershell` 时应复用本条目执行纪律
  （NoProfile/NonInteractive、cwd 语义、超时面），`!` 块展开现走
  `bootstrap/custom-command-shell-expansion.ts`（win32 缺省 ComSpec）。
- **启动拒绝 vs 警告**：Claude 的 shell_tool_missing 是拒绝启动（可执行文件
  缺席面）；ACode 一期只做「双 deny 配置」警告（R5），可执行文件缺席由
  handler fail-closed（R2），启动拒绝面登记后置。

## 状态所有权

- 工作目录：session 状态唯一所有（setWorkingDirectory 唯一写入口）；handler
  经 decideBashCwdPolicy 提议。临时捕获文件 handler 建/删。
- 权限事实：config/permission 面所有；detector 纯函数只读事实投影。
- edition/可执行文件解析：handler 侧惰性解析 + 进程内缓存，无跨会话状态。

## 验收场景

1. Windows 真机：基本执行返回 stdout 与 exitCode 0；描述含分工/持久性/
   引号纪律要点。
2. 目录保持：项目内 `Set-Location` 成功后 setWorkingDirectory 收到子目录，
   下一条命令在新目录执行；越界目录 reset 回 workspaceRoot + stderr 文案。
3. 状态不保持：第一次 `$x=1`，第二次 `$x` 为空。
4. 失败语义：cmdlet 非终止错误 exit 1；native 非零透传；失败不捕获 cwd。
5. capability：`Remove-Item -Recurse $env:USERPROFILE` 与
   `-EncodedCommand` → critical + needsApproval + destructive。
6. detector：双 bare deny → no_shell_tools 警告；单 deny/带 ruleContent 的
   deny → 无警告。
7. 非 Windows：真机用例平台守卫 skip；纯函数用例平台无关可跑。
