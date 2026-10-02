# 子进程 env 凭据白名单化（sensitive credential allowlist）

安全加固 P2 项。把 Bash 工具与 MCP stdio 子进程的 env 继承从「全量继承 + 固定黑名单」
改为「**敏感凭据键默认不继承，显式 allowlist 才透传**」。

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

### R2 全局 opt-in：ACODE_TOOL_ENV_INHERIT_ALLOWLIST

- 用户在**自己的 shell / 桌面启动环境**设 `ACODE_TOOL_ENV_INHERIT_ALLOWLIST="SSH_AUTH_SOCK,GH_TOKEN,AWS_*"`
  （逗号分隔；条目为精确键名或 `PREFIX*` 通配；大小写不敏感）即可让命中键恢复继承。
- 该变量本身不是敏感键，正常穿透到 agent 进程；Bash 子进程内 `export` 改不了 agent 的
  process.env，MCP server 也无从修改——**被 prompt-injection 的命令无法自我放行**。
- **项目配置不能设置该 allowlist**（P1-6 同一哲学：仓库携带的配置只能收紧）；本骨架
  不提供项目/仓库级入口，唯一来源是进程启动 env。

### R3 边界不变量

- 桌面 main→host、host→agent worker 的 env 传递**不剥离**凭据键（第一方可信进程；且
  保留源值是 R2 在工具边界恢复的前提）。`sanitizeACodeRuntimeEnv` 默认参数行为与改动前
  完全一致（`stripSensitiveCredentials` 缺省 false），既有调用方（desktopRuntimeEnv、
  acodeAgentProcessManager、initializeRuntimeProcessEnv）零行为变化。
- 敏感键**不进入** `ACODE_TOOL_ENV_PASSTHROUGH_JSON` 侧信道（该机制只捕获既有黑名单键，
  敏感键不在 `shouldSanitizeACodeRuntimeEnvKey` 集合内，结构上无法被捕获）。
- KUBECONFIG / GOOGLE_APPLICATION_CREDENTIALS 这类「指向凭据文件的指针」同样剥离
  （移除指针即移除默认发现路径；文件本身的用户级保护不在本项范围）。

## 状态所有者与调用链

```
用户 shell / 桌面启动 env（含 allowlist 变量）
  └─ desktop main → host → agent worker        （第一方，凭据键保留）
       ├─ Bash 工具: buildExecutionEnv ──────── 剥离点①（+ overlay.set 后置注入）
       └─ MCP stdio: buildMcpStdioEnv ───────── 剥离点②（+ per-server env 后置注入）
```

- 判定单一事实源：`packages/shared/src/sensitive-env-guard.ts`（纯函数、无 import，
  与 bot-remote-guard 同风格，可被 node --test 直接加载）。
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

## 不在本项范围

- host/agent 进程自身 env 的凭据剥离（第一方可信进程；node-repl 等进程内工具的
  process.env 可见性属另一攻击面，随 P2「agent 命令 env 门禁」项处理）。
- 凭据文件本体的保护（~/.aws/credentials 等文件的读取属 sensitiveRead 熔断器 +
  文件系统权限的范畴）。
- 桌面 Settings UI 的 allowlist 管理界面（当前唯一入口是启动 env；UI 化是后续 UX 项）。
