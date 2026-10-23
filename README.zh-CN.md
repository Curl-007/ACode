# ACode

<div align="center">
  <img src="public/logo/acode.svg" alt="ACode" width="96" height="96" />
  <p><strong>AI 编码工作台：桌面 · 浏览器 · 终端</strong></p>
</div>
<p align="center">
  简体中文 | <a href="README.md">English</a>
</p>

ACode 是一个 AI 编码工作台，同一个 agent 贯穿三种界面——桌面应用、浏览器和终端。一套代码驱动三端：客户端、后端服务、共享 UI，以及 Agent CLI 与 runtime，由仓库维护者独立维护。它面向长程、复杂的编码任务，并在设计上保证你的代码与凭据不出本机。

## ACode 是什么

- **一个 agent，三种界面。** 同一个 Agent runtime 驱动 Electron 桌面应用、浏览器 Web 工作台与终端 TUI / `acode` CLI。按任务选择合适的一端，没有任何能力被锁死在单一界面。
- **为长程任务而生。** 长程 agent loop 配合三域 checkpoint（恢复 / fork / rewind）、子代理编排与自动上下文压缩——大任务可以暂停、分叉、回滚或续跑而不丢进度。
- **安全是设计出来的，不是打补丁。** 分层的命令治理——bash 爆炸半径分级、旁路免疫的熔断器、confirm 反射门、托管策略地板，以及连最宽松模式都无法绕过的子代理权限天花板。
- **代码与密钥留在本地。** 无监控、无遥测，厂商服务默认关闭，凭据经 OS 钥匙串加密，任何非 loopback 绑定都走 fail-closed 认证。见[隐私与安全](#隐私与安全)。
- **开放且可扩展。** 插件商店、多厂商清单兼容（除自有清单外，还能读取 `.claude-plugin` / `.codex-plugin` / `.cursor-plugin`）、MCP server 与生命周期 hooks。见 [apps/acode-cli/README.md](apps/acode-cli/README.md)。

## 隐私与安全

ACode 派生自一个自带客户端监控与遥测的开源基线。本仓库将其全部移除，并防止回流。

- **无监控、无遥测**：客户端监控 SDK、使用/网络遥测、资源与性能采样、崩溃采集、CLI 遥测以及 UI 埋点被整体移除，并有回归检查防止这些出口重新出现。
- **厂商服务默认关闭**：账号登录、反馈、coding plan、官方 MCP 与插件市场全部默认关闭，各自在设置中有独立开关。
- **无未经同意的数据外发**：快照打包、加密与直传路径已在仓库范围内审查；当前版本不存在未经同意的数据外发实现。
- **构建透明**：桌面客户端与 CLI 发行包均由 GitHub Actions 从本仓库源码构建，产物发布到 Releases。

**有意保留**：本地日志（用于排障）、用户主动发起的反馈，以及正常业务请求（模型调用、更新检查）。设备标识仅用于业务身份与本地锁。

下表记录了被移除的内容，供透明核查。**验证**：改动通过 `pnpm typecheck`、`pnpm lint`（0 error）与各模块回归测试。完整清单与验证边界见移除报告：[desktop](packages/desktop/specs/telemetry-removal-report.md)、[CLI](apps/acode-cli/specs/telemetry-removal-report.md)、[UI](packages/ui/specs/telemetry-removal-report.md)。

| 领域           | 已移除                                                                            |
| -------------- | --------------------------------------------------------------------------------- |
| 客户端监控 SDK | 阿里云 ARMS RUM（`@arms/rum-electron`）及其补丁、初始化、路由埋点与 renderer 桥   |
| 使用与网络遥测 | 网络指标聚合与上报、API 事件采集、host/scheduler 转发、远程会话使用采样           |
| 资源与性能     | 周期资源采样、内存诊断、数据量统计、TTFT 导出、MCP 遥测                           |
| 崩溃采集       | 崩溃转储上报、OOM 标注、稳定性遥测                                                |
| CLI 遥测       | 整个 `@acode/telemetry` 包（OTLP 导出、模型 API 记录、agent 指标与 trace）        |
| UI 埋点        | 全部会话打开、订阅错误、自动化、提示模板与用户操作埋点，以及平台上报方法与 IPC 桥 |
| 协议与配置     | 遥测事件协议与上报路径；新增过滤，使 legacy 遥测环境变量无法重新进入 agent        |

### 本地凭据保护

登录令牌与付费 API key 存储在 `~/.acode/v2/credentials.json`，用 AES-256-GCM 加密（`enc:v2:` 格式）。加密主密钥**不再**从机器属性（平台 / home 目录 / 用户名）离线派生——此前任何能读到该文件的进程都能纯离线还原全部凭据。密钥材料现在按优先级存放：

1. 显式的 `ACODE_CREDENTIAL_SECRET` 环境变量（仅当既无钥匙串条目、也无密钥文件时才生效）；
2. **OS 钥匙串**——macOS Keychain、Windows DPAPI（凭据旁的每用户受保护 blob）或 Linux libsecret（GNOME Keyring / KDE Wallet）。密钥与密文分离：被盗的 `.acode` 目录无法在另一台机器或另一个用户账户下解密；
3. 回退用的每安装密钥文件 `~/.acode/v2/credential-key.json`（32 字节，`0600`）——在 OS 钥匙串不可用时使用（如无 secret service 的无头 Linux、容器、CI），生成时给一次性告警。

已有安装在本次更新后首次启动时自动迁移：密钥文件的材料被搬入 OS 钥匙串（字节一致——现有凭据**不会**被重新加密），读回验证通过后，密钥文件才被删除。任一迁移步骤失败都会回滚该条目、密钥文件保持权威，迁移会在后续启动重试。

**你必须知道的数据丢失与备份语义：**

- **钥匙串条目现在是单点故障。** 丢失它（未做钥匙串迁移就重装系统、手动删除条目、清空 Linux secret service）会使每个 `enc:v2:` 凭据**永久不可恢复**——你需要重新登录 / 重填 API key。把 `~/.acode` 拷到新机器**不会带上钥匙串条目**；在新机器上 ACode 会生成全新密钥，因此仅靠拷贝的迁移会使旧凭据不可读。换机时应在新机器上重新认证，而不是拷贝密文。
- **回滚到旧版本会静默破坏你的登录。** 旧构建只认 `enc:v1:` 前缀；遇到 `enc:v2:` 值时会把**密文原样当明文返回**——表现为莫名登录失败（401）或 API key 无效，而非清晰报错。此外，钥匙串迁移之前的构建期望一个已不存在的密钥文件，会生成**新**密钥，使你的凭据成为孤儿。升级后不要回滚；如必须回滚，先在桌面端退出登录，再在旧版本上重新登录。
- 在回退密钥文件模式下（无 OS 钥匙串），密钥文件与密文在同一块磁盘上：把 `credential-key.json` 与 `credentials.json` 当作一个整体一起备份。应用内置的数据目录迁移（切换 `ACODE_DATA_BASE_DIR`）会自动带上密钥文件。

完整规则、优先级链、竞态/迁移语义与如实的边界说明：[`packages/services/specs/credential-storage.md`](packages/services/specs/credential-storage.md)；设计原理：[`docs/credential-os-keychain-design.md`](docs/credential-os-keychain-design.md)。

## 下载与安装

[Releases](https://github.com/Curl-007/ACode/releases) 页面提供桌面客户端（macOS / Windows / Linux）与 CLI 发行包。

**关于签名**：构建产物**未做代码签名**，因此操作系统会拦截首次启动。这是预期行为——按下文各平台放行一次即可。放行前，你可以用 release 页面上的校验文件核对下载：桌面安装包对应 `ACode-<version>-checksums.txt`，CLI tarball 对应 `sha256.txt`。

### macOS（.dmg / .zip）

1. 下载 `ACode-*-mac-arm64.dmg`（Apple Silicon）或 `ACode-*-mac-x64.dmg`（Intel），打开后把 ACode 拖入「应用程序」。同一应用也发布了 `.zip`，如果你更愿意解压而非挂载磁盘镜像。
2. 应用未签名，Gatekeeper 会提示无法验证开发者（或应用已损坏）。**把应用拖入「应用程序」之后**，运行下面的命令（提示时输入登录密码；输入时不显示任何字符）：

   ```bash
   # 一次性命令（放行并启动；执行后立即退出）：
   sudo /usr/bin/xattr -rd com.apple.quarantine "/Applications/ACode.app" && open -a "ACode"
   ```

   使用 `/usr/bin/xattr` 绝对路径可避免被同名工具（例如 Python 的 xattr 包）遮蔽，那些工具会报 "option -r not recognized"。也可以在 Finder 中右键（Control 单击）应用 → 打开 → 在弹窗中再次点「打开」。之后双击即可正常启动。

### Windows（.exe / .zip）

1. **安装版**：下载 `ACode-*-win-x64.exe` 并双击。安装器未签名，SmartScreen 会显示「Windows 已保护你的电脑」警告——点**更多信息** → **仍要运行**，完成安装。这是预期提示，不代表文件损坏。
2. **免安装版（zip）**：下载 `ACode-*-win-x64.zip`，解压到任意位置，运行其中的 `ACode.exe`。zip 版无需安装器，不写注册表或开始菜单项。但它并非完全自包含：默认与安装版共享 `%APPDATA%\ACode` 下的用户数据。设置 `ACODE_DESKTOP_USER_DATA_DIR` 可把这些数据放进随 zip 一起携带的文件夹。

两种下载都可以先用 release 页面上的 `ACode-<version>-checksums.txt` 核对。

### Linux（.AppImage）

选择与 CPU 架构匹配的构建：`ACode-*-linux-x86_64.AppImage`（Intel / AMD）或 `ACode-*-linux-arm64.AppImage`（arm64 / aarch64）。

```bash
# x86_64（Intel / AMD）
chmod +x ACode-*-linux-x86_64.AppImage
./ACode-*-linux-x86_64.AppImage

# arm64（aarch64）
chmod +x ACode-*-linux-arm64.AppImage
./ACode-*-linux-arm64.AppImage
```

### CLI 发行包（.tar.gz）

CLI 发行包是自包含 bundle（TUI + Web + Agent），需要 Node.js 24；安装脚本与运行时代码都可在本仓库中审阅：

```bash
tar -xzf acode-*.tar.gz
cd acode
./install.sh        # 安装 acode 命令（默认 ~/.acode/runtime，入口在 ~/.local/bin）
acode --help        # 或直接运行：node bin/acode.mjs --help
```

## 构建与发布

- **GitHub 构建**：本仓库用 GitHub Actions 从源码构建，CLI 发行包发布到 [Releases](https://github.com/Curl-007/ACode/releases)。每个产物都来自本仓库源码。
- **发布门禁**：任何产物发布前，[Release](.github/workflows/release.yml) 工作流会先跑 `verify`（typecheck / lint / 架构检查 / knip / 全量测试），再跑一个 `desktop-smoke` 门禁，在 Windows 上启动 Electron 并走通启动链路——该处失败会阻断发布。
- **发布流程**：在 Actions 中手动触发 [Release](.github/workflows/release.yml) 工作流。输入 `0.0.1` 并勾选预发布，得到 `0.0.1-audit.<日期>`（同日重复构建追加 `.2`、`.3`……；也接受完整形式 `0.0.1-audit.20260922[.2]`）。不勾选预发布则发布正式版 `v0.0.1`（干净 tag、GitHub Latest，`/releases/latest` 可用）。`keep_draft` 输入项可让一次本应成功的构建保持 draft（用于审计测试版）。Release 说明始终以「相对基线的变化」开头，接着是安装步骤——英文块在前、下方是精确的中文镜像——最后是下载列表。每个产物先上传进 **draft** release；只有在 CLI 与全部桌面平台产物都上传并验证通过后，release 才公开，构建失败则保持 draft，因此下载页永远不会解析到仍在构建的版本。

分支模型、提交规范与完整的合并-发布流程定义在 [docs/git-collaboration.md](docs/git-collaboration.md)：`main` 是发布分支，功能经 squash 合入 `dev`，发布走 `release/*` 分支。

---

## 开发

一套代码服务三种界面：

| 界面                   | 用途                                                            | 开发命令                       |
| ---------------------- | --------------------------------------------------------------- | ------------------------------ |
| Desktop                | Electron 桌面应用                                               | `pnpm dev:desktop`             |
| Web / ACode CLI 发行包 | 终端与浏览器工作台；把 TUI、Web 客户端、后端与 Agent 打包在一起 | `pnpm dev:web`                 |
| Agent CLI              | `acode` 终端界面，同时为 Desktop 与 Web 提供 Agent runtime      | `pnpm --filter @acode/cli dev` |

## 初始化

安装 Git、Node.js **24.14.0** 与 pnpm **10.33.2**。工具版本以 [mise.toml](mise.toml) 为准。下文所有开发与打包命令都从仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备本地 desktop runtime 资产，并运行 `build:bootstrap`。

Agent CLI 与 runtime 源码位于 [apps/acode-cli/](apps/acode-cli/)，是克隆本仓库时即包含的普通目录。无需单独 checkout 或初始化 Git submodule。

其余初始化与构建命令：

| 命令                           | 用途                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `pnpm install`                 | 安装依赖                                                          |
| `pnpm prepare:desktop-runtime` | 准备 desktop runtime 资产，默认包含远程资产                       |
| `pnpm prepare:remote-assets`   | 单独准备远程 runtime 资产                                         |
| `pnpm bootstrap:with-remote`   | 准备依赖与本地及远程资产，随后按序构建相关包；跳过桌面应用 bundle |
| `pnpm build`                   | 递归运行每个 workspace 包的 build 脚本，含各自的资产准备步骤      |

默认的 `bootstrap` 跳过远程资产准备，适用于本地桌面开发。处理远程 workspace 或验证远程分发资产时，运行对应的准备命令。

## 开发与运行

### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test

# 以编译后的 V8 字节码运行桌面 agent（生产形态）
pnpm dev:desktop:bytecode
```

`pnpm dev:desktop` 默认等同 `pnpm dev:desktop:prod`，使用生产服务配置。启动脚本准备本地 runtime 资产、构建桌面 Agent，然后启动 Electron 与源码 watcher。

设置 `ACODE_DATA_BASE_DIR` 可使用独立的开发数据目录。例如在 macOS / Linux 上：

```bash
ACODE_DATA_BASE_DIR="$HOME/.acode-dev-home" pnpm dev:desktop:test
```

### 远程能力（SSH/WSL）

先运行 `pnpm bootstrap:with-remote` 准备远程资产（mock-cdn），再 `pnpm dev:desktop`；连接远程项目时，资产选择「下载到本地再上传」。开发环境下，资产来自本地 `packages/desktop/mock-cdn`（由 `prepare:remote-assets` 生成、被 gitignore 的目录，而非已提交目录）与本地构建产物，经 SFTP 上传到远程主机，不经过 CDN。

### Web 开发

编辑 Web 或后端源码时使用开发模式：

```bash
pnpm dev:web

# 设置后端 workspace（macOS / Linux）
ACODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

这会同时启动 Web 开发服务器（默认 `http://localhost:5173`）与后端（默认 `http://localhost:3030`）。在浏览器打开 Web 开发服务器。`/ws` 与一般 `/api` 请求代理到本地后端；`/api/v1/oauth/token` 单独代理到配置的产品服务。

改动 Agent 源码后，运行 `pnpm --filter @acode/cli... build` 并重启服务。要验证完整发行包，按下文「打包 → ACode CLI 发行包」解压运行。

### ACode CLI 发行包

命令行发行包把 TUI、Web 客户端与 Agent 收在一个 `acode` 命令后。无参数时启动 TUI；以 `--web` 开头启动 Web 模式；其余参数交给既有的 Agent CLI。两种模式都在本地运行，无需 Electron。

```bash
# 默认启动终端 UI
acode

# 启动 Web 界面
acode --web

# 设置项目与端口，且不自动打开浏览器
acode --web --workspace /path/to/project --port 3030 --no-open

# 显示 CLI 或 Web 选项
acode --help
acode --web --help
```

Web 模式下，它以当前目录为 workspace，默认监听 `127.0.0.1` 且不带 token 认证，选择一个可用端口并打开浏览器。使用终端打印的 URL，按 `Ctrl+C` 停止服务。要局域网访问，用 `--host 0.0.0.0`；监听非本地地址默认生成 access token，使用终端打印的带 token 的 URL。用 `--token` 设置 token，或用 `--no-token` 关闭 token 认证。

认证是 fail-closed 的：当服务将绑定非 loopback 地址（例如 `--host 0.0.0.0`）却没有 token 时，服务器拒绝启动，因此 `--no-token` 只对 loopback 绑定有效。当它确实在 loopback 上无 token 启动时，会在启动时打印醒目的「无认证、仅 loopback」告警，因为此时任何本地进程或浏览器页面都能访问它。

直接启动通用 Web 服务的 HTTP 入口时，用 `ACODE_SERVER_AUTH_TOKEN` 配置 API/WebSocket 认证。以编程方式创建服务时，使用 `authToken` 选项。在 `Authorization: Bearer <token>` 头中发送 token；`?token=` URL query 仍可用于向后兼容，但已弃用（会泄露进日志、浏览器历史与 `Referer`）并打印弃用告警。`acode_lite_token` cookie 作为浏览器兼容路径继续支持。要允许受信任的反向代理或局域网 origin 兑换受信任主机的 `/ws/host` 升级，在 `ACODE_SERVER_ALLOWED_ORIGINS`（逗号分隔）中列出完整 origin；携带其他 `Origin` 的浏览器升级会被拒绝。

构建说明见下文「打包」。`pnpm build:acode` 只创建发行包，不会替换 `PATH` 上已有的 `acode`。如果命令仍指向旧安装或另一个 checkout，用 macOS / Linux 上的 `command -v acode` 或 Windows 上的 `where.exe acode` 检查。

### CLI 源码开发

开发 TUI 或 Agent 时使用源码入口：

```bash
pnpm --filter @acode/cli dev --help
pnpm --filter @acode/cli dev

# 构建 CLI 及其 workspace 依赖
pnpm --filter @acode/cli... build
node apps/acode-cli/packages/cli/dist/acode.cjs --help
```

此入口直接运行 Agent CLI，不处理发行包的 `--web` 开关。Web 开发用 `pnpm dev:web`，或用下面展示的解压后 `bin/acode.mjs` 测试统一命令。

`acode` CLI 的插件、MCP server 与 hooks 配置见 [apps/acode-cli/README.md](apps/acode-cli/README.md)。

## 质量门禁

从仓库根目录运行；推送前的最低门禁是 `pnpm verify:pre-push`。全量测试从根目录用 `pnpm test` 运行（它串行执行每个包的 `test` 脚本，经 `node --import tsx --test`——TypeScript / MJS 测试文件直接运行，无需预构建）；这与 CI 运行的命令一致。没有单独的统一 E2E 命令——端到端场景随各包自己的测试。

| 命令                                    | 用途                                   |
| --------------------------------------- | -------------------------------------- |
| `pnpm typecheck`                        | TypeScript project-references 类型检查 |
| `pnpm lint` / `pnpm lint:fix`           | Lint 与自动修复（oxlint）              |
| `pnpm fmt:check` / `pnpm fmt`           | 格式检查与格式化（oxfmt）              |
| `pnpm test`                             | 全部包的全量测试（CI 运行的命令）      |
| `pnpm --filter <包名> test`             | 运行单个包的测试                       |
| `pnpm verify:pre-push`                  | Lint + 架构检查（推送前门禁）          |
| `pnpm architecture:check -- --changed`  | 对改动文件做架构边界检查               |
| `pnpm architecture:context <module-id>` | 某模块的受控阅读上下文                 |
| `pnpm knip`                             | 未使用依赖与导出报告                   |
| `pnpm dep:refs --list-exports <file>`   | 列出某文件的导出及其引用               |

## 配置

根目录 [.env.example](.env.example) 提供服务 URL 与构建配置样例。按需复制为 `.env`，本地覆盖放进 `.env.local`。用 `dev:desktop:test` 或 `dev:desktop:prod` 选择桌面开发环境。最常引用的变量：

| 设置项                               | 用途                                               |
| ------------------------------------ | -------------------------------------------------- |
| `ACODE_DATA_BASE_DIR`                | 应用数据的基础目录，存于其 `.acode/` 子目录下      |
| `ACODE_SERVER_WORKSPACE`             | Web 后端的 workspace 路径                          |
| `ACODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 provider 配置文件路径；未设置时用内置配置     |
| `ACODE_DIST_BASE_URL`                | CLI 发行包安装器使用的下载基础 URL                 |
| `ACODE_REMOTE_ASSET_CDN_BASE_URL`    | 远程 runtime 资产的基础 URL（远程 workspace 分发） |
| `ACODE_DEPS_BASE_URL`                | 下载的运行时依赖的基础 URL                         |

`.env.example` 还列出更多服务与 CDN URL。运行时变量可在启动命令的环境中显式设置。客户端随附的默认配置见 [config/README.md](config/README.md)。

## 打包

notice 生成、分发检查，以及各发行包中 notice 的包含位置，见 [third-party/README.md](third-party/README.md)。

### 桌面版

```bash
pnpm bundle:desktop

# 设置目标平台与 CPU 架构
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

默认目标是 macOS arm64，默认输出目录是 `packages/desktop/dist/`。`--os` 接受 `mac`、`win` 或 `linux`；`--arch` 接受 `x64` 或 `arm64`。打包与签名需要目标平台的工具与配置。

桌面 bundle 在构建主机上把 agent 编译为 V8 字节码以加快启动；跨平台构建（主机平台 ≠ 目标平台）与 E2E 覆盖构建会自动回退到纯 JS bundle。见 [`packages/desktop/specs/agent-bytecode-production.md`](packages/desktop/specs/agent-bytecode-production.md)。

安装：打开生成的 DMG，把 ACode 拖入「应用程序」。本地构建未签名；如果 macOS 拦截首次启动，运行：

```bash
sudo /usr/bin/xattr -rd com.apple.quarantine /Applications/ACode.app && open -a "ACode"
```

### ACode CLI 发行包

运行 `pnpm build:acode` 构建 CLI/TUI、后端与 Web 客户端，收集 TUI 原生库、worker 与运行时依赖，然后组装发行包。运行发行包仍需 Node.js；使用 `mise.toml` 指定的版本。

打包前，用 `.env`、`.env.local` 或进程环境中的 `ACODE_DIST_BASE_URL` 设置下载基础 URL，或通过 `--base-url` 传入。下面的 URL 是占位符；发布时替换为你的托管 URL：

```bash
pnpm build:acode --base-url https://downloads.example.com/acode/

# 当 ACODE_DIST_BASE_URL 已配置时
pnpm build:acode

# 复用既有的 Agent、后端与 Web 构建产物重新打包
pnpm build:acode --skip-build

# 显示版本、输出目录等选项
pnpm build:acode --help
```

版本默认取根 `package.json` 的 version。输出写入 `dist/acode/`：

- `releases/<version>/acode-<version>.tar.gz`：runtime 包。
- `releases/<version>/sha256.txt`：校验文件。
- `latest.json` 与 `install.sh`：版本索引与安装器。

把整个目录上传到配置的下载基础 URL。安装器从该 URL 下载 runtime 包，默认安装到 `~/.acode/runtime`，并在 `~/.local/bin` 创建 `acode` 命令。分别用 `ACODE_DIST_HOME` 与 `ACODE_DIST_BIN_DIR` 覆盖这些目录。

要在本地测试打包结果，直接解压运行，无需上传或安装：

```bash
acode_version=$(node -p "require('./dist/acode/latest.json').version")
mkdir -p dist/acode/debug
tar -xzf "dist/acode/releases/$acode_version/acode-$acode_version.tar.gz" \
  -C dist/acode/debug
# 默认启动 TUI
node dist/acode/debug/acode/bin/acode.mjs

# 启动 Web 模式
node dist/acode/debug/acode/bin/acode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

打开 `http://127.0.0.1:3030` 验证完整流程，一个后端同时服务 Web 页面并运行 Agent。端口必须可用；如果 `pnpm dev:web` 已在运行，换一个 `--port`。

## 仓库结构

| 目录                               | 职责                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop`                 | Electron Main、Host、Renderer 与桌面打包                                                                                                                         |
| `packages/web`                     | Web 客户端                                                                                                                                                       |
| `packages/server`                  | HTTP / WebSocket 服务与远程连接                                                                                                                                  |
| `packages/acode-server-cli`        | 远程服务器侧 CLI 与 supervisor                                                                                                                                   |
| `packages/ui`                      | 共享 React 组件、hooks 与 Zustand 状态                                                                                                                           |
| `packages/services`                | 业务服务与持久化                                                                                                                                                 |
| `packages/shared`                  | 共享协议与类型（含 Desktop–Agent 协议）                                                                                                                          |
| `packages/rpc`                     | RPC 框架                                                                                                                                                         |
| `packages/client`                  | Agent 客户端 SDK                                                                                                                                                 |
| `packages/harness-sdk`             | ACode Harness API v1 TypeScript SDK（connect / launch 双模式）                                                                                                   |
| `packages/provider`                | Provider 账号与配置服务                                                                                                                                          |
| `packages/provider-node`           | Node 端 builtin provider 配置物化                                                                                                                                |
| `packages/model-option-map`        | 模型选项映射的解析、编译与求值                                                                                                                                   |
| `packages/acode-cua`               | Computer Use 包。Server / Helper 面为惰性 fail-closed；client wire 面是完整实现，但默认 gated off（无 broker socket path、插件关闭）                             |
| `packages/formal-proof`            | 形式化证明模型与 UI（内部产品行为验证器，非面向用户的功能）                                                                                                      |
| `apps/acode-cli`                   | Agent CLI、TUI、runtime 与工具——一个嵌套 workspace，其各包（`core`、`adapters`、`contracts`、`cli`、`tui`、`dynamic-workflow`……）位于 `apps/acode-cli/packages/` |
| `scripts`、`config`、`third-party` | 构建与维护脚本、内置配置、第三方 notice 材料                                                                                                                     |
| `docs`                             | 跨模块的计划、审查、治理与设计记录（索引见 [docs/README.md](docs/README.md)）                                                                                    |

## 文档

从 [docs/README.md](docs/README.md) 开始查看完整索引。顶层指南：

- [AGENTS.md](AGENTS.md)——贡献者与 AI 会话的工作约定：spec-first 流程、验证要求、模块边界与日志规则。
- [CONTEXT.md](CONTEXT.md)——插件商店相关界面的领域词汇；改相关 UI 前阅读。
- [DESIGN.md](DESIGN.md)——UI 设计规范；改 UI 前阅读。
- [docs/git-collaboration.md](docs/git-collaboration.md)——分支模型、提交规范与合并-发布流程。

活跃治理与规范——日常工作反复引用的规则：

| 文档                                                                                 | 内容                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [docs/specs/engineering-invariants.md](docs/specs/engineering-invariants.md)         | 跨切面工程不变量（失败降级、生命周期、并发、持久化、性能、UI、协作派工、API 设计） |
| [docs/legacy-protocol-convergence-plan.md](docs/legacy-protocol-convergence-plan.md) | 退役 legacy 协议面的里程碑（只删不增）                                             |
| [docs/tech-debt-backlog.md](docs/tech-debt-backlog.md)                               | 技术债台账（被 CI 引用）                                                           |
| [docs/specs/cli-validation-gates.md](docs/specs/cli-validation-gates.md)             | CLI 验证门禁（被 ci.yml / release.yml / typecheck 门禁引用）                       |
| [docs/specs/ci-platform-matrix.md](docs/specs/ci-platform-matrix.md)                 | CI 平台矩阵规格                                                                    |

历史主线记录——已完成的计划、交接与带日期的验证记录，覆盖主要的加固与升级主线（保留作实现状态与证据；完整清单见 [docs/README.md](docs/README.md)）：

| 文档                                                                                                  | 内容                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [security-hardening-plan.md](docs/security-hardening-plan.md)                                         | 基于逐行源码审查的 P0–P3 安全加固路线图                                                          |
| [security-hardening-handoff.md](docs/security-hardening-handoff.md)                                   | 安全加固各批次的实现状态、验证命令与交接说明                                                     |
| [security-scan-triage-2026-09-29.md](docs/security-scan-triage-2026-09-29.md)                         | 封存深度安全扫描全部 118 项发现的分级处置：误报 / 设计如此 / 已缓解 / 残留                       |
| [j5-performance-baseline.md](docs/j5-performance-baseline.md)                                         | Agent CLI 四种运行形态的性能与资源基线，以及已实现的杠杆（生产 V8 字节码、token 估算）           |
| [jcode-inspired-upgrade-plan.md](docs/jcode-inspired-upgrade-plan.md)                                 | 防御机制升级路线图：bash 目标爆炸半径门控、confirm 反射门、类型化 workflow 产物、provider doctor |
| [jcode-upgrade-handoff.md](docs/jcode-upgrade-handoff.md)                                             | 上述升级的逐项实现状态、审查发现与后续                                                           |
| [cli-dispatch-and-system-prompt-upgrade-plan.md](docs/cli-dispatch-and-system-prompt-upgrade-plan.md) | Agent dispatch 与系统提示升级路线图，含逐项实现状态                                              |
| [renderer-memory-soak-2026-10-01.md](docs/renderer-memory-soak-2026-10-01.md)                         | Renderer 内存泄漏根因、修复与真机验证                                                            |

最新的全项目 review 是 [docs/project-review-2026-10-22.md](docs/project-review-2026-10-22.md)，其各专项发现位于 [docs/reviews/2026-10-22/](docs/reviews/2026-10-22/)。

行为改动遵循 spec-first 约定：产品规则、状态所有者、接口与验收场景先于代码写下，位于 `packages/*/specs/` 与 `apps/acode-cli/specs/` 下的各模块 spec——例如[遥测移除报告](packages/desktop/specs/telemetry-removal-report.md)与[凭据存储 spec](packages/services/specs/credential-storage.md)。

## 开源协议

第一方代码以 **MIT** 授权（见 [LICENSE](LICENSE)）。仓库包含派生自 ACode 开源基线的代码，该部分仍为 **Apache-2.0**（全文见 [LICENSE-APACHE](LICENSE-APACHE)），并保留原始版权与署名声明。第三方组件授权见 [NOTICE.zh-CN.md](NOTICE.zh-CN.md)。

## 项目声明

功能与推广范围、维护策略、执行与数据风险、授权及第三方版权信息见 [NOTICE.zh-CN.md](NOTICE.zh-CN.md)。
