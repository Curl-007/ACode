# Git 硬化预设增量：默认拒绝协议面 + 完整性防御 + 入站消毒（git hardening presets）

机制来源：Claude Desktop 2.37337 `main` 的 git posture 治理模块
（`index.chunk-CHbrg8it.js` :38、:54-55、:60-75、:109-125、:143-155，预设常量区）。
本项是其**台账增量预设**子集（S 级快赢）；完整 8 档 posture 意图网关 + argv 形状
验证不在本项范围（E3 另立项）。

与既有 `git-invocation-hardening.md`（R1–R7）是**增量关系**：R1 单一漏斗/双层注入、
R2 config 矩阵、R3 防弹窗、R5 防串仓、R6/R7 边界登记全部保持；本项修订 R4
（协议面从"全局白名单"收紧为"默认拒绝 + 按调用点显式放行"）并新增 P2–P4 预设。

## 威胁模型增量

services git 漏斗（`getGitCommandEnv()` → `gitCommandProvider.run()`）承载用户仓库
上的自动只读命令与本地写命令，唯一远端命令是用户显式 push。相对既有硬化，本项封堵：

1. **入站 env 走私**：宿主/父进程环境可注入 `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`
   把 git 的全局/系统配置重定向到攻击者文件（等效任意 config 注入，可覆盖 hooksPath
   等矩阵外的键）；`GIT_ALLOW_PROTOCOL` 若依赖 spread 覆盖顺序而非显式剥离，存在
   重排回归风险。
2. **历史伪冒（replace-ref/graft）**：恶意仓库（或被写入的 `refs/replace/*`、
   `.git/info/grafts`）可让 agent 读到的 commit 树/父链与实际存储对象不一致——
   diff、log、checkpoint 固化、commit-message 生成全部基于伪冒内容做判断。
   git 2.46 实测 `info/grafts` 仍被读取（仅 deprecation hint），是活的攻击面。
3. **协议面过宽**：既有 `GIT_ALLOW_PROTOCOL=file:https:ssh` 对**漏斗内全部命令**
   生效——任何被仓库配置/参数间接触发的传输（如 submodule 递归、bundle、误配的
   remote URL）都继承 file/https/ssh 放行。收紧为"默认全拒 + push 调用点显式放行"。
4. **bare repo 发现劫持**：`safe.bareRepository=explicit` 拒绝 git 通过目录向上
   发现落入 bare 仓库（攻击者在 workspace 祖先目录放置 bare `.git` 即可让全部
   命令跑在攻击者控制的仓库上，含其 config/hooks）。
5. **合并/rerere/rename 副作用与 DoS**：仓库配置可设 `rerere.enabled=true`
   （写 `.git/rr-cache`）、`merge.directoryRenames` 推断、`renameLimit` 无上限
   （status/diff 自动路径上的 O(n²) CPU DoS）。
6. **alias 哨兵走私**：`alias.remote-<name>.command` 可把 `<name>::` 形态 URL
   变成任意命令执行入口；预留哨兵名并置空，防继承配置武器化。

## 产品规则

### P1 协议面：默认全拒 + 按调用点显式放行（核心设计决策）

**默认（无 opt-in）**：`GIT_ALLOW_PROTOCOL=""`（空串 = 拒绝一切传输，git 2.46
实测 `transport 'file' not allowed`）+ config 层 `protocol.allow=never` 与
ext/fd/file/git/ssh/http/https 七协议逐个 `protocol.<p>.allow=never`。

**opt-in（唯一例外）**：`gitCliRepo.push` 调用点显式声明
`GIT_PUSH_PROTOCOL_ALLOWLIST = ["file","https","ssh"]`（与既有 R4 白名单等值，
push 行为不变：远端可为 https/ssh/本地路径；ext/git/fd/http 仍拒绝）。声明通道是
`GitCommandExecutionOptions.envOptions`（见接口节），**不是**调用点手写 env 键。

**实测优先级裁决（git 2.46.1.windows，本项验收前置侦察）**：

| 场景 | 结果 | 结论 |
| --- | --- | --- |
| `GIT_ALLOW_PROTOCOL=file` + `-c protocol.allow=never` | 放行 file | env 设置时**严格压过** config |
| `GIT_ALLOW_PROTOCOL=https` + `-c protocol.file.allow=always` | 拒绝 file | env 名单外的协议 config 也救不回 |
| `GIT_ALLOW_PROTOCOL=`（空） | 全拒 | 空串即全拒语义成立 |
| env 未设置 + `-c protocol.allow=never` | 拒绝 file | config 层独立有效 |

因此：**env 是生效通道，config 协议矩阵是第二层防御**——防"env 单独丢失/被下游
wrapper 清掉"时退回 git 默认策略（http/https/git/ssh=always 的危险默认）。两层
永远同源构建（同一 `allowedProtocols` 参数），禁止分别手写。

未来新增远端能力（fetch/clone/ls-remote）的调用点**必须**：显式传
`envOptions.allowedProtocols` 最小集，并在本 spec 登记；禁止全局放宽默认值、
禁止绕过漏斗直接覆盖 `GIT_ALLOW_PROTOCOL`。

### P2 入站 env 消毒增量

- `GIT_LOCAL_ENV_VARS` 剥离清单新增 `GIT_CONFIG_GLOBAL`、`GIT_CONFIG_SYSTEM`
  （防全局/系统配置重定向；`GIT_CONFIG_COUNT/PARAMETERS/KEY_n/VALUE_n` 既有已剥）。
- `GIT_ALLOW_PROTOCOL` 在消毒段**显式 delete**，随后由 per-call 值统一写入——
  不再依赖对象 spread 顺序兜底（防重排回归）。
- `GIT_GRAFT_FILE`、`GIT_NO_REPLACE_OBJECTS`、`GIT_REPLACE_REF_BASE` 继承值剥离
  后由矩阵重写（GRAFT_FILE/REPLACE 在 `GIT_HARDENING_ENV`，REF_BASE 只剥不写）。
- **登记的残余**：`GIT_SSH`/`GIT_SSH_COMMAND` 不剥离——用户自定义 ssh（跳板机/
  密钥）是 push 的合法工作流，剥离即破坏存量远端；敌意父环境能设 GIT_SSH_COMMAND
  时同样能改 PATH，剥离不构成实质边界。`GIT_CONFIG_NOSYSTEM` 不剥离（继承只会
  收紧不会放宽）。acode-cli 侧孪生漏斗（`packages/shared/src/git-invocation-env.ts`）
  的同步增量不在本项所有权内，登记为接线需求（**已销账** 2026-10-20：孪生漏斗
  同步增量已独立落地，见 apps/acode-cli/specs/git-invocation-hardening.md R3 修订
  与 R4/R5——marketplace 单点 opt-in、防再分叉所有权不变量）。

### P3 replace-ref/graft 完整性三件套

- env：`GIT_NO_REPLACE_OBJECTS=1`（读取对象时完全忽略 `refs/replace/*`）；
- env：`GIT_GRAFT_FILE=<execPath>/no-grafts`——**稳定不存在路径**（可执行文件的
  子路径必然 ENOTDIR/ENOENT，无法被预先创建），git 读不到任何 grafts；execPath
  缺失的嵌入形态退化为空设备子路径（同样必然不存在）；
- config：`core.useReplaceRefs=false`（env 丢失时的第二层，git 2.46 实测独立生效）。

语义不变量：**ACode 从仓库读到的每个对象都是仓库真实存储的内容**——log/diff/
checkpoint 固化/commit-message 上下文不受 replace/graft 伪冒影响。用户自己终端里
的 replace refs 照常工作（我们只影响 ACode 发起的进程）。

### P4 kill switch 与副作用收口（config 矩阵新增键）

| 键 | 值 | 目的 |
| --- | --- | --- |
| `alias.remote-denied_by_acode.command` | 空 | 哨兵 alias 置空：`denied_by_acode::` 形态 URL 即使被继承/仓库配置定义 helper 也不执行 |
| `help.autocorrect` | `0` | 子命令拼写偏差不得被 git 自动纠正执行成另一条命令 |
| `safe.bareRepository` | `explicit` | 拒绝目录发现落入 bare 仓库（见威胁 4）。ACode 面实测无回归：bare workspace 的 `rev-parse --show-toplevel` 现状即 fatal（"must be run in a work tree"，不匹配任何降级 matcher → 抛错），explicit 只是换错误文案，UX 等价；漏斗无 `--is-inside-work-tree` 消费点 |
| `rerere.enabled` | `false` | 不写 `.git/rr-cache`（ACode 面当前无 merge 命令，防御性收口） |
| `merge.directoryRenames` | `false` | 关闭目录重命名推断（确定性，不产生推断性冲突） |
| `merge.renameLimit` / `diff.renameLimit` | `7000` | **上限钉死**：防仓库/用户配置设无上限值导致自动 status/diff 路径 CPU DoS；7000 与证据同款，为有界确定性上界 |
| `core.splitIndex` | `false` | index 写入单文件化，去掉 `sharedindex.*` 第二文件面。行为变化登记：ACode 写 index（add/switch/checkpoint）时若用户 index 原为 split 形态会被合并为单文件——git 双向兼容，用户自己的 git 下次写入按其配置自行恢复，无损坏 |

**对证据的偏差（登记）**：证据对 rev-parse 调用跳过 `core.splitIndex=false`
（CHbrg8it:109-112 的 `D()` 判别）。ACode 漏斗按 env 注入、不感知 argv；且 ACode
的 rev-parse 用途（`--show-toplevel`/`HEAD`/`--git-path`/`--verify`）均不读写
index，该键对其为惰性配置——故无条件注入，语义与证据等价。

### P5 注入通道裁决（沿用 R1，理由重申）

config 矩阵继续走 `GIT_CONFIG_COUNT/KEY_n/VALUE_n` env 注入，**不改用 `-c` argv**：

1. 漏斗单点在 `config.ts`，providers/repo 层的 argv 组装不触碰硬化矩阵（R1 既有
   裁决：矩阵只写一处，调用点禁止手写单键）；
2. 继承的 `GIT_CONFIG_*` 已先剥净再写，用户环境不能覆盖矩阵（R5 既有保证）；
3. `-c` argv 方案需要改每个调用点的 args 组装（所有权分散、易漏），且与既有
   防串仓剥离逻辑形成两套通道。

协议 per-call 差异经 `getGitCommandEnv(options)` 参数进入同一矩阵构建，仍是单点。
残余（既有登记不变）：git < 2.31 时 config 层静默失效、env 层（含协议默认全拒）
仍生效；git < 2.12 无 `GIT_ALLOW_PROTOCOL`（远古，不支持）。

### P6 所有权与不变量

- 矩阵与协议策略**只写在 `config.ts`**；`gitEnvironmentProvider` 只做透传；
  `gitCommandProvider.run()` 是 spawn 单点。
- 调用点表达协议需求的唯一通道是 `envOptions`（类型 `GitCommandEnvOptions`）；
  `command.env` 直接覆盖保留给**与矩阵不相交**的键（checkpoint 的
  `GIT_INDEX_FILE`/author 身份 env，既有语义不变）——覆盖 `GIT_CONFIG_*` 单键会
  破坏 COUNT 编号一致性，视为违规。
- `GIT_CONFIG_COUNT` 恒等于矩阵长度（含协议条目），编号键与条目一一对应（既有
  测试守护扩展到新增键）。
- 失败语义：协议拒绝表现为 git fatal `transport '<p>' not allowed`、非零退出，
  经既有 `ensureGitCommandSucceeded` 归一为命令失败——push 被拒时用户看到协议
  错误文案，不静默、不挂起。本地命令（status/diff/add/commit/switch/checkpoint/
  rev-parse）不触碰 transport，默认全拒对其零影响。

## 接口

`packages/services/src/git/config.ts`：

- `type GitProtocolName`（七协议闭集）、`GIT_PROTOCOL_NAMES`（常量数组，证据顺序）；
- `interface GitCommandEnvOptions { allowedProtocols?: readonly GitProtocolName[] }`；
- `GIT_PUSH_PROTOCOL_ALLOWLIST: readonly GitProtocolName[]`（`["file","https","ssh"]`，
  取代既有 `GIT_ALLOW_PROTOCOL_WHITELIST` 字符串常量——全局白名单语义已废除）；
- `getGitCommandEnv(options?: GitCommandEnvOptions): NodeJS.ProcessEnv`（签名扩展，
  默认全拒）；
- `getGitHardenedConfigEntries(platform?, allowedProtocols?)`（签名扩展；协议条目
  排矩阵尾部：先 `protocol.allow=never` + 未放行协议逐个 never，再放行协议 always，
  同键不重复出现）；
- `getGitGraftNullFilePath(): string`（稳定不存在路径构造）；
- `GIT_HARDENING_ENV` 增补 `GIT_NO_REPLACE_OBJECTS`/`GIT_GRAFT_FILE`，移除静态
  `GIT_ALLOW_PROTOCOL`（变为 per-call 计算值）。

`providers/gitEnvironmentProvider.ts`：`createCommandEnv(options?: GitCommandEnvOptions)`
（接口 `GitEnvironmentProvider` 同步扩展；无参 fake 仍类型兼容）。

`providers/gitCommandProvider.ts`：`GitCommandExecutionOptions.envOptions?:
GitCommandEnvOptions`，`run()` 内 `environmentProvider.createCommandEnv(command.envOptions)`
后再叠加 `command.env`（叠加顺序不变）。

`repo/gitCliRepo.ts`：`push()` 唯一调用点传
`envOptions: { allowedProtocols: GIT_PUSH_PROTOCOL_ALLOWLIST }`。

## 验收场景

见 `packages/services/test/gitHardeningPresets.test.ts`（新增）与
`gitInvocationHardening.test.ts`（同步修订）：

1. **入站消毒**：污染 `GIT_CONFIG_GLOBAL/SYSTEM/COUNT/KEY_0/GIT_ALLOW_PROTOCOL/
   GIT_GRAFT_FILE/GIT_NO_REPLACE_OBJECTS` → 输出中 GLOBAL/SYSTEM 被剥、协议值为
   per-call 计算值、完整性 env 为矩阵值、COUNT 与矩阵长度一致。
2. **预设矩阵断言**：P3/P4 全部键值正确；alias 哨兵键名含 `denied_by_acode`；
   全矩阵键闭集守护（防漂移）。
3. **协议默认拒绝 + 显式放行（纯函数）**：默认 env `GIT_ALLOW_PROTOCOL=""`、
   矩阵含 `protocol.allow=never` + 七 never；opt-in `["file","https","ssh"]` →
   env 串 `file:https:ssh`、三 always + 四 never + 全局 never、无重复键。
4. **协议功能（真实 git）**：默认硬化 env 下 `ls-remote <本地路径>` 被拒
   （stderr 含 not allowed）；`envOptions` 放行 file 后同命令成功；
   `gitCommandProvider.run` 链路级 push（file 远端）默认被拒、带 envOptions 成功。
5. **replace-ref 防御功能（真实 git）**：`git replace HEAD <other>` 伪冒后，
   硬化 env 下 `log -1 --format=%s` 显示真实内容，对照组（process.env）显示伪冒
   内容；仅 config 层（`core.useReplaceRefs=false`）独立生效同样断言。
6. **bare repo**：硬化 env 下 bare 仓库内 rev-parse 拒绝（stderr 含 bare
   repository）；与现状（plain fatal）UX 等价，登记于 P4。
7. 既有硬化验收（R1–R7）全绿，其中 R4 相关断言按本 spec 修订。

## 不在本项范围

- 完整 posture 意图网关（8 档 + argv 形状白名单验证）——E3 另立项；
- acode-cli/shared 孪生漏斗（`packages/shared/src/git-invocation-env.ts`）同步
  增量——**已销账**（2026-10-20 独立落地为 apps/acode-cli/specs/
  git-invocation-hardening.md R3 修订+R4/R5，双漏斗语义对齐并制度化防再分叉）；
- `fetch.bundleURI=`、`credential.helper=` 清空、`safe.directory=*`：维持既有
  R3/R4 判定（credential.helper 清空会废掉 push 认证；bundleURI/ACode 无 fetch
  命令面；safe.directory 放宽信任面），不随本项引入；
- git < 2.31 的 `-c` argv 兜底（P5 残余，维持既有登记）。
