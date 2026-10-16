# 子进程 env 凭据白名单化（sensitive credential allowlist）

安全加固 P2 项。把 Bash 工具与 MCP stdio 子进程的 env 继承从「全量继承 + 固定黑名单」
改为「**敏感凭据键默认不继承，显式 allowlist 才透传**」。

价值提取第二轮波次（2026-10-15）W2-SEC5 增补：同一剥离点挂第二类封闭键集——
**执行劫持向量**（R4）。两类键集共用一个漏斗、一个 opt-in 通道，威胁模型不同
（R4 首段）。R2 按 `settings-doc-style.md` 三段式改写，作为该规范的示范面①。

## 背景

`buildExecutionEnv`（adapters/exec/execution-command.ts）与 `buildMcpStdioEnv`
（adapters/mcp/network.ts）都以 `process.env` 全量为底、只经 `sanitizeACodeRuntimeEnv*`
删一个固定黑名单（NODE_ENV/代理/证书/CUA broker/遥测/历史身份键）。用户 shell 里的
云厂商凭据（AWS_*/AZURE_*/GOOGLE_APPLICATION_CREDENTIALS）、SCM token（GITHUB_TOKEN/
GH_TOKEN/GITLAB_*）、SSH agent socket（SSH_AUTH_SOCK——持有它即持有签名能力）、包管理
registry token（NPM_TOKEN 等）、数据库口令（DATABASE_URL/PGPASSWORD）全部原样流入：

- 任意 Bash 命令（模型生成；prompt-injection 可诱导 `env | curl …` 外带）；
- 任意第三方 MCP stdio server（插件市场/用户配置引入，供应链面）。

host/agent 进程自身是第一方可信代码，不在本次剥离范围；**剥离点是「不可信子进程」边界**。

## 产品规则

### R1 默认剥离敏感凭据键（两个工具边界）

- `buildExecutionEnv`（Bash/工具子进程）与 `buildMcpStdioEnv`（MCP stdio server）在既有
  sanitize 之上追加剥离 `isSensitiveCredentialEnvKey` 命中的键。
- 判定是封闭规则集（代码常量，见 `packages/shared/src/sensitive-env-guard.ts`）：
  精确键名单 + 前缀（AWS_/AZURE_/GOOGLE_/GCLOUD_/GITHUB_/GH_/TF_VAR_/NPM_CONFIG_ 含
  auth·token·password 者）+ 后缀（_API_KEY/_ACCESS_TOKEN/_SECRET_KEY/_SECRET/_TOKEN/
  _PASSWORD/_PRIVATE_KEY/_AUTH）。大小写不敏感（Windows env 语义）。
- **不误伤显式注入**：剥离只作用于「继承的 env」。工具 overlay（`overlay.set`）与
  MCP per-server `env` 配置在 sanitize **之后** spread，用户/插件显式给单个子进程注入的
  值照常生效——这是 per-destination 的 opt-in 通道，与全局 allowlist 互补。

### R2 全局 opt-in：ACODE_TOOL_ENV_INHERIT_ALLOWLIST（三段式示范面①）

**动机**：默认剥离会打断依赖继承凭据的合法工作流——ssh-agent 签名（SSH_AUTH_SOCK）、
CI 里已导出的 registry token、云 CLI 的 profile 变量。这些键的「该不该给子进程」只有
用户能裁决，所以给一个显式恢复通道，而不是为每种工作流开特例。在自己的 shell /
桌面启动环境设 `ACODE_TOOL_ENV_INHERIT_ALLOWLIST="SSH_AUTH_SOCK,GH_TOKEN,AWS_*"`
（逗号分隔；条目为精确键名或 `PREFIX*` 通配；大小写不敏感）即可让命中键恢复继承。

**失败模式推理**：放行请求为什么必须来自启动 env——该变量本身不是敏感键，正常穿透
到 agent 进程；Bash 子进程内 `export` 改不了 agent 的 process.env，MCP server 也无从
修改，**被 prompt-injection 的命令无法自我放行**。反过来，如果忘配：子进程里的工具
以认证失败告终（ssh 报无 agent、registry 报 401），错误在子进程侧、根因在启动 env
侧——这是本设置最常见的排查断层，报错文案应指向本变量。通配过宽（`AWS_*`）会把
整个家族（含用不到的长期 secret）一并放给所有工具子进程；按键逐个放行更可审计。

**边界与替代**：**项目配置不能设置该 allowlist**（P1-6 同一哲学：仓库携带的配置只能
收紧）；唯一来源是进程启动 env，冲突不存在（没有第二个入口）。allowlist 只作用于
R1/R4 的「继承剥离」层：`SANITIZED_RUNTIME_ENV_KEYS` 固定黑名单（NODE_ENV/
NODE_OPTIONS/ELECTRON_RUN_AS_NODE/代理/证书等）**无条件剥离、不可经本变量恢复**
（两层语义见 R4）。更精细的替代通道是 per-destination 显式注入（工具 overlay.set /
MCP per-server env，R1 第三条）：只给单个子进程、不进全局继承面。

### R3 边界不变量

- 桌面 main→host、host→agent worker 的 env 传递**不剥离**凭据键（第一方可信进程；且
  保留源值是 R2 在工具边界恢复的前提）。`sanitizeACodeRuntimeEnv` 默认参数行为与改动前
  完全一致（`stripSensitiveCredentials` 缺省 false），既有调用方（desktopRuntimeEnv、
  acodeAgentProcessManager、initializeRuntimeProcessEnv）零行为变化。
- 敏感键**不进入** `ACODE_TOOL_ENV_PASSTHROUGH_JSON` 侧信道（该机制只捕获既有黑名单键，
  敏感键不在 `shouldSanitizeACodeRuntimeEnvKey` 集合内，结构上无法被捕获）。
- KUBECONFIG / GOOGLE_APPLICATION_CREDENTIALS 这类「指向凭据文件的指针」同样剥离
  （移除指针即移除默认发现路径；文件本身的用户级保护不在本项范围）。

### R4 执行劫持向量封闭键集（同剥离点第二类，W2-SEC5）

**威胁模型差异**：R1 的威胁是**泄密**（继承的凭据被模型生成的命令或恶意 MCP server
外带）；R4 的威胁是**让子进程执行攻击者代码或降级 TLS**——`NODE_OPTIONS=--require=…`
让每个 node 子进程先加载注入代码，`BASH_ENV`/`ENV` 让每个非交互 shell 先 source
攻击者脚本，`GIT_SSH_COMMAND`/`GIT_ASKPASS` 让模型执行的每条 git 命令 spawn 任意
程序，`NODE_TLS_REJECT_UNAUTHORIZED=0`/`GODEBUG`/CA 指针把子进程的 TLS 校验静默
摘除。这些键**不含秘密**，凭据类判定（值像不像 token）永远抓不到它们；R1 的
allowlist 通道对它们同样适用（用户显式 opt-in 才恢复），但固定黑名单层无条件。

- **同剥离点**：`buildExecutionEnv` 在 `sanitizeACodeRuntimeEnvInPlace(…,
  { stripSensitiveCredentials: true })` 之后立即调用 `applyExecHijackEnvGuard`
  （`packages/adapters/src/exec/exec-hijack-env-guard.ts`）——一个漏斗，两类键集，
  执行顺序固定（先固定黑名单→再凭据闭集→再劫持闭集；后两层的 allowlist 语义一致）。
- **封闭键集三类**（代码常量，大小写不敏感；与固定黑名单重叠的键重复列出，
  双保险且键集自文档化）：
  1. **代码注入**（`EXEC_HIJACK_CODE_INJECTION_ENV_KEYS` + 前缀 `BASH_FUNC_`/`LD_`/
     `DYLD_`）：NODE_OPTIONS、NODE_PATH、BASH_ENV、ENV、ELECTRON_RUN_AS_NODE、
     GCONV_PATH、GLIBC_TUNABLES、PYTHONSTARTUP、PYTHONPATH、PYTHONHOME、
     PYTHONUSERBASE、JAVA_TOOL_OPTIONS、_JAVA_OPTIONS、JDK_JAVA_OPTIONS、CLASSPATH、
     PERL5OPT、PERL5LIB、PERL5DB、PERLLIB、RUBYOPT、RUBYLIB、RUBYGEMS_GEMDEPS、
     ZDOTDIR、DOTNET_STARTUP_HOOKS、DOTNET_ADDITIONAL_DEPS、CORECLR_PROFILER 族
     （含 COR_* 8 键）、GOFLAGS、GOENV、GOROOT、GOTOOLCHAIN、GOPATH、GOBIN、
     GOMODCACHE、GOCACHE、PSMODULEPATH。
  2. **网络重定向**（`EXEC_HIJACK_NETWORK_REDIRECT_ENV_KEYS` + 前缀 `OPENSSL_`）：
     HOSTALIASES、GIT_SSH_COMMAND、GIT_ASKPASS、CA 指针族（SSL_CERT_FILE、
     NODE_EXTRA_CA_CERTS、REQUESTS_CA_BUNDLE、CURL_CA_BUNDLE、GIT_SSL_CAINFO；
     SSL_CERT_DIR 已由固定黑名单覆盖且证据集未列，不重复入集）、
     NODE_TLS_REJECT_UNAUTHORIZED、proxy 族（HTTP_PROXY/
     HTTPS_PROXY/ALL_PROXY/NO_PROXY，含小写形态——大小写不敏感匹配天然覆盖）、
     GOPROXY、GOSUMDB、GONOSUMDB、GONOSUMCHECK、GOINSECURE、GODEBUG。
  3. **shell 行为**（`EXEC_HIJACK_SHELL_BEHAVIOR_ENV_KEYS`）：IFS、SHELLOPTS、PS4、
     COMSPEC、PERL5SHELL、RUBYSHELL。**SHELL 有意不在集内**：`resolvePosixBashShell`
     （bash-shell-provider.ts）消费构建后 env 的 SHELL 做工具 shell 选型，剥离会把
     用户 zsh 降级为 fallback 探测；且 provider envOverlay 对自己的工具 shell 显式
     重建 SHELL——它同 PATH 一样是「自有链路功能消费键」，参照证据产品也留在通行集。
- **ELECTRON_RUN_AS_NODE 边界**（调查结论）：ACode 自有 spawn 链**依赖**它——桌面
  打包态 `process.execPath` 是 Electron/Helper 二进制，agent worker
  （acodeAgentProcessManager.ts 三处）、官方插件 MCP host
  （official-plugin-runtime.ts 两处）、script-workflow 与 dynamic-workflow 子进程、
  embedded-search internal-cli backend（命令行内联赋值）都以「spawn 点显式
  `ELECTRON_RUN_AS_NODE=1`」重建（script-workflow-process.ts:66 注释即缺陷史：
  不显式带上，子进程按完整 Electron 启动）。故边界为：**agent 工具子进程剥离
  （固定黑名单 + R4 闭集双层，均不可经 allowlist 恢复）、自有受控 spawn 在各自
  spawn 点显式重建**——两侧都已是现状，本项把边界写死为规格，防止未来把重建
  「优化」回继承。
- **COMSPEC 规范重建**（win32）：COMSPEC 被剥离后，若 env 中存在 SystemRoot，则
  重建为规范值 `%SystemRoot%\System32\cmd.exe`（Windows 自身设置的恒等值）。理由：
  `resolveShell`/cmd-shim 路径与子进程内 `%COMSPEC%` 消费方（Node `shell:true`、
  批处理链）保持确定性绝对路径，同时继承值里被篡改的 COMSPEC（指向任意 exe）被
  规范值取代。allowlist 放行 COMSPEC 时保留用户值（重建只在键缺席时发生）。
- **与波 1 services git 硬化（GIT_* 面）的关系**：两面互不经过、互不冲突。
  `packages/services/src/git/config.ts` 的 `GIT_HARDENING_ENV` 管**第一方** git 调用
  （checkpoint/push 漏斗 `getGitCommandEnv`），机制是「显式重建硬化值」
  （GIT_ASKPASS=""、GIT_TERMINAL_PROMPT=0、GIT_ALLOW_PROTOCOL 白名单）；R4 管
  **不可信** Bash 工具子进程（模型生成的 git 命令），机制是「剥离继承 + allowlist
  恢复」。GIT_ASKPASS 两面都封（services 置空、exec 剥离），GIT_SSH_COMMAND 只在
  R4 面（services 漏斗不需要 ssh 自定义，exec 面它是 RCE 放大器）。用户经 Bash 工具
  跑自己的 git 工作流若依赖 GIT_SSH_COMMAND/GIT_ASKPASS，走 allowlist 显式放行。
- **overlay/注入通道**：与 R1 同哲学——剥离只作用于继承 env；`overlay.set`（第一方
  运行时 per-destination 通道，现状无生产调用点经 request.env 设置劫持键）在剥离
  之后应用、保持优先。若未来插件/hook 面获得 overlay 写入能力，必须先加拒绝门
  （见接线需求）。
- **接线需求（M1，adapters/src/mcp 独占面）**：①`buildMcpStdioEnv` 在同一
  sanitize 点之后调用同一 `applyExecHijackEnvGuard`（同包相对导入
  `../exec/exec-hijack-env-guard.js`，无需 barrel 改动）；②MCP per-server `env`
  声明面对劫持闭集键**拒绝而非剥离**（参照证据产品的「conflicts with a reserved
  environment variable」拒绝模式），但拒绝门必须放行第一方重写路径——官方插件
  的 per-server env 由 bootstrap 注入 `ELECTRON_RUN_AS_NODE=1`
  （official-plugin-runtime.ts），一刀切拒绝会打断官方插件宿主。

## 状态所有者与调用链

```
用户 shell / 桌面启动 env（含 allowlist 变量）
  └─ desktop main → host → agent worker        （第一方，凭据键保留）
       ├─ Bash 工具: buildExecutionEnv ──────── 剥离点①（+ overlay.set 后置注入）
       └─ MCP stdio: buildMcpStdioEnv ───────── 剥离点②（+ per-server env 后置注入）
```

- 判定单一事实源：`packages/shared/src/sensitive-env-guard.ts`（纯函数、无 import，
  与 bot-remote-guard 同风格，可被 node --test 直接加载）。
- 劫持键集单一事实源：`packages/adapters/src/exec/exec-hijack-env-guard.ts`
  （三类闭集常量 + `isExecHijackEnvKey` + `applyExecHijackEnvGuard`；allowlist 语义
  复用 shared 的 parse/isAllowed，不另造）。剥离点②的同源接线属 M1（R4 接线需求）。
- 开关接线：`runtimeEnv.ts` 的 `sanitizeACodeRuntimeEnv(env, options?)` /
  `sanitizeACodeRuntimeEnvInPlace(env, options?)` 新增
  `{ stripSensitiveCredentials?, sensitiveInheritAllowlist? }`；allowlist 缺省从被
  sanitize 的 env 自身解析（即用户 shell 的值）。

## 接口

- `isSensitiveCredentialEnvKey(key: string): boolean`
- `parseToolEnvInheritAllowlist(raw: string | undefined): readonly string[]`
- `isToolEnvInheritAllowed(key: string, allowlist: readonly string[]): boolean`
- `ACODE_TOOL_ENV_INHERIT_ALLOWLIST_ENV_KEY = "ACODE_TOOL_ENV_INHERIT_ALLOWLIST"`
- `SanitizeACodeRuntimeEnvOptions { stripSensitiveCredentials?: boolean; sensitiveInheritAllowlist?: readonly string[] }`
- `isExecHijackEnvKey(key: string): boolean`
- `applyExecHijackEnvGuard(env, options?: { platform?; inheritAllowlist? }): ReadonlySet<string>`
  （返回被剥离键的大写规范集；win32 的 COMSPEC 规范重建在内）
- `EXEC_HIJACK_CODE_INJECTION_ENV_KEYS` / `EXEC_HIJACK_NETWORK_REDIRECT_ENV_KEYS` /
  `EXEC_HIJACK_SHELL_BEHAVIOR_ENV_KEYS` / `EXEC_HIJACK_ENV_KEY_PREFIXES`

## 验收场景

见 `packages/shared/tests/sensitive-env-guard.test.mjs` 与
`apps/acode-cli/tests/subprocess-env-allowlist.test.mjs`：

1. 默认（无 allowlist）：AWS_SECRET_ACCESS_KEY / GITHUB_TOKEN / SSH_AUTH_SOCK /
   NPM_TOKEN / DATABASE_URL / OPENAI_API_KEY / TF_VAR_secret / 任意 *_API_KEY 后缀键
   在 buildExecutionEnv 与 buildMcpStdioEnv 产物中**不存在**；PATH/HOME/LANG/GIT_* 等
   非敏感键原样保留。
2. allowlist 精确键：`ACODE_TOOL_ENV_INHERIT_ALLOWLIST=SSH_AUTH_SOCK` → SSH_AUTH_SOCK
   恢复，其余敏感键仍剥离。
3. allowlist 通配：`AWS_*` → AWS_ 前缀键全部恢复。
4. 显式注入不受剥离影响：overlay.set / MCP per-server env 设置的敏感键照常到达子进程。
5. 默认参数零回归：`sanitizeACodeRuntimeEnv(env)`（不带 options）行为与改动前一致
   （凭据键保留、既有黑名单键剥离）——守护 main→host 边界。
6. 侧信道封闭：敏感键不出现在 ACODE_TOOL_ENV_PASSTHROUGH_JSON。
7. 大小写不敏感匹配（windows 形态 `Path`/`Github_Token`）。
8. （R4）三类代表键（BASH_ENV/GIT_SSH_COMMAND/IFS 等）与全量闭集在
   buildExecutionEnv 产物中不存在；PATH/HOME/SHELL/EDITOR 等功能键保留。
9. （R4）前缀族命中：BASH_FUNC_foo/LD_PRELOAD/DYLD_INSERT_LIBRARIES/OPENSSL_CONF
   被剥离。
10. （R4）allowlist 恢复劫持键（PYTHONPATH）生效；固定黑名单键（NODE_OPTIONS）
    不可经 allowlist 恢复（两层语义）。
11. （R4）win32：恶意 COMSPEC 被替换为 SystemRoot 规范值；allowlist 放行时保留
    用户值；非 win32 不重建。
12. （R4）overlay.set 显式注入在劫持剥离之后生效（第一方通道）。
13. （R4）劫持闭集键不进入 ACODE_TOOL_ENV_PASSTHROUGH_JSON（不在捕获集内，
    结构性封闭）。

见 `apps/acode-cli/tests/exec-hijack-env-guard.test.mjs`。

## 不在本项范围

- host/agent 进程自身 env 的凭据剥离（第一方可信进程；node-repl 等进程内工具的
  process.env 可见性属另一攻击面，随 P2「agent 命令 env 门禁」项处理）。
- 凭据文件本体的保护（~/.aws/credentials 等文件的读取属 sensitiveRead 熔断器 +
  文件系统权限的范畴）。
- 桌面 Settings UI 的 allowlist 管理界面（当前唯一入口是启动 env；UI 化是后续 UX 项）。
- agent 自身 process.env 的劫持键消费面：`readWindowsActiveCodePageEncoding`
  （exec/outputEncoding.ts:204）用 **agent env** 的 ComSpec 做 `execFileSync` 探测
  代码页——agent env 是第一方链路（desktop→host→agent 逐跳 sanitize）产物，属
  「host/agent 进程自身 env」既有除外面；登记为残余观察点，若未来 agent 启动链
  出现非第一方注入，可复用 R4 的规范重建。
- 插件/工具描述面向模型披露劫持键剥离行为（错误信息写作规范 error-message-style
  的「enforcement 披露」句式适用时随对应面落地）。
