# Git 调用硬化预设矩阵（git invocation hardening）

机制来源：Claude Desktop 2.37337 `main/file-index-worker/fileIndexWorker.js:38094-38162`
（预设矩阵常量区）。ACode 对照落点：`packages/services/src/git/config.ts` 的
`getGitCommandEnv()`——services 侧全部 git 调用的**单一 env 漏斗**。

## 背景与威胁模型

services 的 git 面（`gitCommandProvider.run()`，经 `gitEnvironmentProvider` →
`getGitCommandEnv()`）承载两类命令：

1. **只读/自动触发**：status、diff、ls-files、rev-parse、commit graph、check-ignore……
   由 UI 刷新、workspace 打开、文件索引等自动触发，属**无人值守**路径；
2. **本地写**：add/commit/switch/update-ref/update-index（checkpoint 与 UI Git 面板）；
3. **网络写（唯一）**：`push`（`gitCliRepo.push`，用户显式动作，`IGitService.push` RPC）。

仓库是半可信输入：`.git/config`、全局配置、仓库 hooks、LFS 驱动、fsmonitor 守护、
凭据 helper 都能让一条"只读" git 命令执行任意代码、打网络、弹窗挂死或写仓库。
既有漏斗已做：GIT_* local env 清理（防 pre-push hook 注入串仓）、GIT_OPTIONAL_LOCKS=0、
pager/TERM/LC 固定。本项在同一漏斗上增量补齐硬化预设，**不改变防串仓语义**。

### 消费面盘点（2026-10）

- **本漏斗覆盖**：`packages/services/src/git/**` 全部命令（gitCliRepo、
  gitCheckpointRepo、gitService、commitMessage 生成链）——services 内 git spawn
  仅 `gitCommandProvider.ts`（命令）与 `gitEnvironmentProvider.ts`（`--version` 探测）两处，
  都消费 `getGitCommandEnv()`。
- **不覆盖（登记为接线需求，另立项）**：
  - `apps/acode-cli/packages/core/src/worktree/session-worktree-git.ts`、
    `apps/acode-cli/packages/cli-workflow/src/workflow-worktree-manager.ts`、
    `apps/acode-cli/packages/adapters/src/plugins/marketplace.ts`（git clone）、
    `apps/acode-cli/packages/adapters/src/context/git-snapshot.ts` 等 CLI 自有 git spawn 点；
  - Agent bash 工具里用户/模型自主运行的 git（属命令白名单策略域，不是本漏斗）。

## 产品规则

### R1 单一漏斗、双层注入

硬化矩阵只写在 `config.ts`，经 `getGitCommandEnv()` 生效；禁止任何调用点手写单键。
两层分工跟随 git 语义：

- **env 层**（进程级、天然继承给 git 子进程）：GIT_TERMINAL_PROMPT、GIT_ASKPASS、
  GIT_NO_LAZY_FETCH、GIT_ALLOW_PROTOCOL、GIT_OPTIONAL_LOCKS（既有）；
- **config 层**（`-c` 等价物）：通过 `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_<n>` /
  `GIT_CONFIG_VALUE_<n>`（git ≥ 2.31，命令行作用域，优先级压过 system/global/local）注入。
  选择 env 注入而非改写各调用点 args 的原因：漏斗只有 env 一处可改（providers/repo
  层不在本项所有权内），且既有代码已先剥离继承来的 `GIT_CONFIG_COUNT/GIT_CONFIG_PARAMETERS/
  GIT_CONFIG`（防串仓），我们随后写入自己的值——继承值不可能覆盖本矩阵。
  git < 2.31 时 config 层静默失效、env 层仍生效（接受的残余，登记）。

### R2 config 层矩阵（GIT_CONFIG_* 注入键）

| 键 | 值 | 目的 |
| --- | --- | --- |
| `core.hooksPath` | win32 `\\.\NUL`，POSIX `/dev/null` | 废仓库 hooks：pre-commit/pre-push/post-checkout 等不能从服务进程执行仓库内任意代码 |
| `core.fsmonitor` | 空 | 不吃仓库配置的 fsmonitor 守护（防后台进程与仓库写） |
| `gc.auto` | `0` | 只读命令不触发 auto-gc（防后台重写仓库/长时间持锁） |
| `maintenance.auto` | `false` | 不触发后台维护任务 |
| `core.commitGraph` | `false` | 不读/不写 commit-graph（任务清单中的 commitGraph.write=false 按真实 git 键名落地为本键 + 下一键；证据 `f9` 同款） |
| `gc.writeCommitGraph` | `false` | gc 顺带写 commit-graph 的老键一并关死 |
| `log.showSignature` | `false` | log/commit graph 不自动 spawn gpg 验签（防挂死） |
| `core.logAllRefUpdates` | `false` | ref 更新不写 reflog（服务进程少写仓库；用户自己终端操作不受影响） |
| `core.excludesFile` | 空 | 不吃用户全局 gitignore（见 R6 边界） |
| `core.attributesFile` | 空 | 不吃用户全局 attributes（filter/eol 行为只由仓库内 `.gitattributes` 决定，可复现） |
| `core.askPass` | 空 | 与 GIT_ASKPASS 空双保险，封 GUI askpass（见 R3） |
| `submodule.recurse` | `false` | 仓库配置 submodule.recurse=true 时，status/switch 等不得自动递归子模块（防顺带网络 fetch） |
| `filter.lfs.required` | `false` | git-lfs 二进制缺失时降级为原始内容而非整条命令失败 |

**LFS 四键判定（任务要求"语义调查后定"）**：证据把 `filter.lfs.clean/smudge/process`
全清空，适用于 Claude 的纯只读面。ACode 漏斗还承载 `switch`（smudge 决定工作区落
真实内容还是指针文本）与 `add/commit`（clean 决定入库是内容还是指针）——全局清空会把
LFS 仓库的工作区/入库语义写坏。故**只取 `filter.lfs.required=false`**；`lfs.fetchexclude`
不设（LFS 的网络入口是 pre-push/post-checkout hooks，已被 hooksPath 空设备封死，
fetchexclude 只会让 switch 静默落下指针文本）。偏差已登记。

### R3 防弹窗挂死三保险（无人值守关键项）

- `GIT_TERMINAL_PROMPT=0`：任何凭据/确认的终端提示直接失败，不等待 stdin
  （stdio 本就 ignore，此前是"静默挂到超时"，现在是"立即报错"）。
- `GIT_ASKPASS=`（空字符串）：遮蔽继承自宿主环境（编辑器/SSH 会话注入）的 askpass
  GUI 程序；git 对空值按未设置处理，随后落到 core.askPass——
- `core.askPass=`（空）：config 层同步清空，两条 askpass 解析路径全封。
- **`credential.helper` 不清空（对任务清单的偏差，登记）**：清空会连"从系统凭据库
  静默取已存凭据"一起废掉，`IGitService.push`（显式用户功能，https 远端为主）将
  全体认证失败——违反"别封死自身功能"。helper 保留后残余风险：push 凭据缺失时
  GCM 可能弹自己的 GUI；该场景是用户前台显式 push，弹窗即登录 UX，可接受。
  只读命令面不会触发凭据流（R4 封网络后无认证请求）。

### R4 网络传输面收口

> **2026-10 修订（增量见 `git-hardening-presets.md` P1）**：协议面从"全局白名单
> `GIT_ALLOW_PROTOCOL=file:https:ssh`"收紧为**默认全拒（空串）+ 按调用点显式放行**——
> 唯一放行点是 `gitCliRepo.push`（`envOptions.allowedProtocols = GIT_PUSH_PROTOCOL_ALLOWLIST`，
> 仍为 file/https/ssh 等值语义）；config 层同步注入 `protocol.allow=never` + 七协议
> 逐个 never 作为 env 丢失时的第二层。全局常量 `GIT_ALLOW_PROTOCOL_WHITELIST` 废除，
> 由 `GIT_PUSH_PROTOCOL_ALLOWLIST`（调用点白名单）取代。

- `GIT_NO_LAZY_FETCH=1`：partial clone（promisor）仓库的只读命令缺对象时不得
  懒取打网络，直接报错。
- 协议白名单判定（push 调用点）：远端可为 https 或 ssh，本地 bare 远端走 file；
  封死 `ext`（remote-helper 任意命令执行，RCE 主向量）、`git`（无认证守护协议）、
  `fd`、`http`（明文凭据）。
  证据用 `denied_by_claude_desktop` 哨兵封全协议，因其面纯只读；ACode 全封会
  封死自身 push，按任务授权改为白名单形态（现为按调用点 opt-in）。`http` 被有意
  封死（远端为 http 的用户 push 会快速失败并报协议错误，登记为接受的偏差）。

### R5 既有防串仓语义不变

`GIT_LOCAL_ENV_VARS` 剥离清单、剥离先于叠加的顺序、`GIT_OPTIONAL_LOCKS=0`、
`GIT_PAGER/PAGER=cat`、`TERM=dumb`、`LC_ALL/LANG=C` 全部保留。硬化项叠加在清理
之后，继承的同名变量（含 `GIT_CONFIG_KEY_<n>` 等矩阵编号键）一律先删后写，
用户环境不能篡改矩阵。

### R6 与 `.acodeignore`/`.gitignore` 的边界

`core.excludesFile=`（空）只封**用户全局** gitignore；仓库内 `.gitignore` 与
`.git/info/exclude` 照常生效——这是文件索引 git 主源（`--exclude-standard`）与
`.acodeignore`（默认从仓库 `.gitignore` 初始化）语义对齐的前提，详见
`file-index-degradation.md`。`check-ignore` 结果随之只反映仓库级规则（全局规则
不再出现），属预期收紧。

### R7 hooks 停用的行为变化（用户可见，登记）

`core.hooksPath` 指向空设备后，ACode 发起的 commit/switch/push **不再执行仓库
hooks**。既有 push 超时注释（"pre-push hook 可能跑测试"）描述的场景从此不发生；
10 分钟 push 超时保留为纯网络余量，不回收。用户需要 hooks 校验时在终端自行 push。
这是任务明示的硬化目标（防仓库 hooks 从服务进程执行任意代码），不是回归。

## 接口

> 2026-10 增量修订：`getGitCommandEnv(options?: GitCommandEnvOptions)` 与
> `getGitHardenedConfigEntries(platform?, allowedProtocols?)` 签名扩展（默认协议
> 全拒）、`GIT_PUSH_PROTOCOL_ALLOWLIST`/`getGitGraftNullFilePath()` 新增、
> `GIT_ALLOW_PROTOCOL_WHITELIST` 废除——详见 `git-hardening-presets.md` 接口节。

- `packages/services/src/git/config.ts`
  - `getGitCommandEnv(options?): NodeJS.ProcessEnv`（输出叠加硬化矩阵）；
  - `getGitHardenedConfigEntries(platform?, allowedProtocols?): ReadonlyArray<readonly [string, string]>`
    ——config 层矩阵数据（纯函数，platform 可注入供测试断言双平台分支）；
  - `getGitHooksNullDevicePath(platform?: NodeJS.Platform): string`
    ——win32 `\\.\NUL`，POSIX `/dev/null`（与既有 `getGitNullDevicePath()`（diff
    --no-index 用的 `NUL` 形态）分设，不改动后者语义）；
  - 导出常量：`GIT_HARDENING_ENV`（env 层矩阵）、`GIT_PUSH_PROTOCOL_ALLOWLIST`。

## 验收场景

见 `packages/services/test/gitInvocationHardening.test.ts` 与
`gitHardeningPresets.test.ts`（增量预设）：

1. env 层：`getGitCommandEnv()` 含 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=""`、
   `GIT_NO_LAZY_FETCH=1`、`GIT_OPTIONAL_LOCKS=0`（既有）；`GIT_ALLOW_PROTOCOL`
   默认空串（全拒），push opt-in 时为 `file:https:ssh`（R4 修订）。
2. config 层：`GIT_CONFIG_COUNT` 与矩阵长度一致，`GIT_CONFIG_KEY_<n>/VALUE_<n>`
   逐项对应；win32/POSIX 的 `core.hooksPath` 分支值正确（platform 注入双分支断言，
   无需 skip）。
3. 防串仓保留：预先污染 `process.env`（GIT_DIR、GIT_CONFIG_COUNT、GIT_CONFIG_KEY_0、
   GIT_TERMINAL_PROMPT、GIT_ASKPASS）→ 输出中 local env 被剥离、矩阵值不被继承值覆盖、
   污染的多余 GIT_CONFIG_* 编号键不残留。
4. 功能回归（真实 git，临时 repo fixture；git 不可用则 skip）：硬化 env 下
   `git status/ls-files/commit` 正常；带 pre-commit hook 的仓库 commit 成功且 hook
   不执行（hook-proof 文件不出现）；无硬化时同 fixture hook 执行（对照组）。
5. 矩阵键闭集：`getGitHardenedConfigEntries` 输出的键集合与 R2 表一致（防漂移）。

## 不在本项范围

- acode-cli 自有 git spawn 点的同等硬化（接线需求，见消费面盘点）；
- `safe.directory=*`（放宽信任面，登记为可选后续）、`fetch.bundleURI=`、
  `credential.helper=` 清空（ACode 无 fetch 命令面/会废掉 push 认证，维持 R3 判定）；
  ~~`core.useReplaceRefs=false`、`help.autocorrect=0`、`alias.remote-<sentinel>.command=`~~
  ——2026-10 已随 `git-hardening-presets.md` P3/P4 落地；
- git < 2.31 的 config 层兜底（改用 `-c` 旗标需触碰 providers/repo 层 args 组装，
  超出本项所有权；env 层仍生效）。
