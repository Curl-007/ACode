# CLI git 调用硬化（acode-cli 自有 git spawn 面）

交叉引用：`packages/services/specs/git-invocation-hardening.md`（机制来源、威胁模型、
R1–R7 完整语义、两条有据偏差）与 `packages/services/specs/git-hardening-presets.md`
（2026-10 硬化预设增量：默认拒协议面 + 完整性三件套 + P4 预设——本 spec R4 是其
CLI 面镜像，落地即销账该 spec P2 节登记的「孪生漏斗接线需求」）。services 侧消费面盘点把本面登记为「接线需求，
另立项」——本 spec 即该立项：把同一硬化预设矩阵补到 apps/acode-cli 自有 git spawn 点
（这些不走 services 的 `getGitCommandEnv()` 漏斗）。**矩阵语义与 services 对齐**，
包括照搬其两条有据偏差：`credential.helper` 不清空（封死会废掉 https 静默取凭据）、
LFS 只取 `filter.lfs.required=false`（清空 clean/smudge/process 会写坏 LFS 仓库的
工作区/入库语义）。本 spec 只记录 CLI 面增量：漏斗落点裁决、协议白名单内容、
消费点清单。

## R1 漏斗落点：`packages/shared/src/git-invocation-env.ts`（对任务预案的偏差，登记）

任务预案是「落 core 或 adapters」。盘点实证两者都到不了全部消费方：

- core 与 adapters 是**兄弟包**：adapters 的 package.json 未声明 `@acode/core`
  （pnpm 严格 node_modules 下解析不到），core 亦未声明 `@acode/adapters`；
  package.json/pnpm-lock 冻结，不能补依赖；
- core 的公共 barrel（`core/src/index.ts`）在禁改面内，core 内新模块无法对外导出；
  contracts barrel 与 contracts/package.json 同禁改，不能加子路径入口；
- 消费方横跨 core / adapters / cli-workflow / cli / bootstrap 五个包，它们**唯一**
  已共同声明的运行时依赖是 `@acode/shared`，且 shared 已有运行时 env 工具先例
  （`runtimeEnv.ts`，本身是注册公开入口）。

故漏斗落 `packages/shared/src/git-invocation-env.ts`，经 shared 根 barrel 导出
（`packages/shared/src/index.ts` 加一行）。**单一漏斗纪律**：硬化矩阵只写在该文件，
任何 CLI git spawn 点禁止手写单键。与 services 侧矩阵是**两份实现、一份语义**
（services/* 为波 1 冻结面，不得反向抽取）；两侧键值漂移由各自的闭集测试守护。

## R2 两种消费形态（跟随 CLI 既有执行面，不改参数组装语义）

- **直接 spawn**（execFile/spawn 点）：`getCliGitInvocationEnv(baseEnv?, platform?,
  options?)` 返回完整 env（`options.allowedProtocols` 见 R3 修订）——先剥离 GIT
  local env（GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE 等，防串仓，
  清单与 services 同款）与继承的 `GIT_CONFIG_*` 编号键（先删净再写，继承值不能
  覆盖矩阵、不能借残留编号夹带配置），再写入 env 层矩阵 + config 层
  （`GIT_CONFIG_COUNT/KEY_<n>/VALUE_<n>` 注入，git ≥ 2.31 命令行作用域；
  git < 2.31 时 config 层静默失效、env 层仍生效——同 services 登记的残余）+
  `GIT_OPTIONAL_LOCKS=0` + pager/TERM/LC 固定。`baseEnv` 可注入：marketplace 以
  其 `buildMarketplaceGitEnv()`（sanitize + 网络出口 proxy/CA 恢复）为基底叠加，
  既有代理语义不动。
- **ExecutionPort argv**（`port.run({command:{mode:"argv",file:"git"}})` 点）：
  `getCliGitInvocationEnvOverlay()` 返回 `{set, unset}`，走 `ExecutionRequest.env`
  既有契约字段（contracts 零改动）。`buildExecutionEnv` 先应用 unset 后应用 set，
  矩阵不被继承值覆盖。**只叠加在 file:"git" 的命令上**；`world.run` 的任意命令面
  不是 git 漏斗消费方，不叠加（模型/脚本自主命令属命令白名单策略域，同 services
  spec 消费面盘点的排除项；bash 工具的 git 治理面 bash-git-runtime-safety 同排除）。

config 层矩阵键值 = services R2 表逐项同款（hooksPath 空设备 win32 `\\.\NUL` /
POSIX `/dev/null`、fsmonitor 空、askPass 空、excludesFile/attributesFile 空、
gc.auto=0、maintenance.auto=false、commitGraph/gc.writeCommitGraph 关、
log.showSignature 关、logAllRefUpdates 关、submodule.recurse=false、
filter.lfs.required=false）；env 层 = GIT_TERMINAL_PROMPT=0、GIT_ASKPASS 空、
GIT_NO_LAZY_FETCH=1、GIT_OPTIONAL_LOCKS=0、GIT_ALLOW_PROTOCOL（见 R3）。

## R3 协议面（2026-10 修订：全局白名单废除 → 默认全拒 + 按调用点显式放行）

**修订块（镜像 services git-hardening-presets.md P1，git 2.46.1 实测裁决表见彼处）**：
`CLI_GIT_ALLOW_PROTOCOL_WHITELIST = "file:http:https:ssh"` 全局白名单**已废除**。
全局白名单对漏斗内全部 8 个消费点生效——7 个纯本地命令面（worktree/merge/status/
只读 snapshot）无谓继承 file/http/https/ssh 放行，任何被仓库配置/参数间接触发的
传输都走白名单。收紧为：

- **默认（无 opt-in）**：per-call `GIT_ALLOW_PROTOCOL=""`（空串 = 拒绝一切传输）+
  config 层 `protocol.allow=never` 与七协议逐个 `protocol.<p>.allow=never`；两层
  永远由同一 `allowedProtocols` 参数同源构建（env 是生效通道、config 是「env 单独
  丢失」第二层防御，实测优先级裁决同 services P1）。
- **opt-in（当前唯一放行点）**：消费点 #2 marketplace `execGitCommand` 显式声明
  `CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST = ["file","http","https","ssh"]`——内容与
  原全局白名单等值（marketplace clone 行为不变），但**范围收窄到该调用点**。
  声明通道是 `getCliGitInvocationEnv(baseEnv, platform, { allowedProtocols })` /
  `getCliGitInvocationEnvOverlay(sourceEnv, platform, { allowedProtocols })` 参数，
  禁止调用点手写 `GIT_ALLOW_PROTOCOL` env 键。
- 其余 7 个消费点全部是本地命令（盘点见消费点表协议列），不声明、默认全拒，
  对其零功能影响（本地 transport 不经过 GIT_ALLOW_PROTOCOL 的**命令**不受限；
  实测 `file` 传输在空串下被拒的只有 ls-remote/push/clone/fetch 一类显式远端命令）。
- 未来 CLI 面新增远端 git 能力的调用点**必须**显式传最小 `allowedProtocols` 集并
  在本表登记；禁止放宽默认值、禁止绕过漏斗覆盖协议 env。

原白名单**内容**的调查结论仍有效（放行集为何是这四项），保留如下：

- **marketplace 级 git clone**（`parseMarketplaceSourceInput`，marketplace.ts:231）
  显式接受 `http://` 前缀的 `*.git` 源；且 marketplace 级源**不经**插件级
  host/protocol 门（`git-source-pinning.ts` 的门只覆盖插件仓库源），http clone 是
  存量可用安装面——封掉即破坏既有功能（services 封 http 成立是因其唯一网络命令是
  用户显式 push，面不同）。
- **https**：GitHub archive 失败回退的 git clone、`https://...git` 源、
  `owner/repo` 简写归一（normalizeGitUrl → https://github.com/…）。
- **ssh**：scp-like `git@host:path`（isGitSshUrl）与插件级门放行的 `ssh:`。
- **file**：本地仓库/worktree/临时仓语义与测试 fixture。
- `git+https:`/`git+ssh:`（插件级门放行）**不纳入**：非 git 原生 transport，
  git clone 本就无法处理，纳入无意义。
- **封死 `ext`**（remote-helper 任意命令执行，RCE 主向量）、`git`（无认证守护）、
  `fd`。ext:: 在 CLI 有真实攻击面：marketplace 级 source 可来自持久化配置/协议
  输入，`loadMarketplace` case "git" 不再校验 URL scheme，spawn 层白名单是唯一收口。

## R4 硬化预设增量（2026-10，镜像 services git-hardening-presets.md P2–P4）

威胁模型、git 2.46.1 实测裁决表与逐项依据见 services 侧 presets spec（单一事实源，
本节只登记 CLI 面落地形态与差异）：

- **P2 入站消毒增量**：`GIT_LOCAL_ENV_VARS` 剥离清单新增 `GIT_CONFIG_GLOBAL`、
  `GIT_CONFIG_SYSTEM`（防全局/系统配置重定向到攻击者文件——等效任意 config 注入，
  可覆盖 hooksPath 等矩阵外键）与 `GIT_NO_REPLACE_OBJECTS`（继承值不得弱化完整性
  三件套）；`GIT_ALLOW_PROTOCOL` 在消毒段**显式 delete**（完整 env 形态）/进
  `unset`（overlay 形态），随后由 per-call 值统一写入——不依赖对象 spread 顺序兜底。
  残余照搬：`GIT_SSH`/`GIT_SSH_COMMAND` 不剥离（用户自定义 ssh 是 marketplace 私有
  仓 clone 的合法工作流；敌意父环境能设它时同样能改 PATH，不构成实质边界）、
  `GIT_CONFIG_NOSYSTEM` 不剥离（继承只会收紧）。
- **P3 replace-ref/graft 完整性三件套**：env `GIT_NO_REPLACE_OBJECTS=1` +
  `GIT_GRAFT_FILE=<execPath>/no-grafts`（稳定不存在路径，`getCliGitGraftNullFilePath()`）
  + config `core.useReplaceRefs=false`。语义不变量：CLI 从仓库读到的每个对象都是
  仓库真实存储内容——git-snapshot 上下文、workflow world-read 的 git.log/git.diff、
  checkpoint 类判断不受 `refs/replace/*` 与 `.git/info/grafts` 伪冒影响（git 2.46
  实测 grafts 仍被读取，是活的攻击面）。
- **P4 kill switch 与副作用收口**（config 矩阵新增 9 键，与 services 逐项同款）：
  `alias.remote-denied_by_acode.command=`（哨兵置空）、`help.autocorrect=0`、
  `safe.bareRepository=explicit`、`rerere.enabled=false`、
  `merge.directoryRenames=false`、`merge.renameLimit=7000`、`diff.renameLimit=7000`、
  `core.splitIndex=false`、`core.useReplaceRefs=false`（P3 第三件）。
  splitIndex 无条件注入（不按 rev-parse 判别）——CLI 漏斗按 env 注入、不感知 argv，
  且 CLI 面 rev-parse 用途不读写 index，与 services P4 偏差登记同款。
- **P5 注入通道**：维持 `GIT_CONFIG_COUNT/KEY_<n>/VALUE_<n>` env 注入，不改 `-c`
  argv（理由同 services P5：漏斗单点、继承编号键先剥后写、调用点 args 零触碰）。
  git < 2.31 config 层静默失效、env 层（含协议默认全拒）仍生效——既有残余不变。

## R5 所有权边界与防再分叉（双漏斗核心不变量）

- **CLI 漏斗唯一所有者**：`packages/shared/src/git-invocation-env.ts`。矩阵与协议
  策略只写在该文件；acode-cli 五包（core/adapters/cli-workflow/cli/bootstrap）的
  全部 git spawn 点只准经 `getCliGitInvocationEnv` / `getCliGitInvocationEnvOverlay`
  取 env，禁止手写任何硬化单键（含 `GIT_ALLOW_PROTOCOL`）。
- **services 漏斗唯一所有者**：`packages/services/src/git/config.ts`（desktop/server
  面）。两漏斗是**两份实现、一份语义**：矩阵键值集必须保持语义一致（R1 既有裁决，
  services/* 为波 1 冻结面、不做反向抽取）。
- **防再分叉纪律**（本轮 WI-2/WI-2b 分叉事故的制度化）：任何一侧的硬化增量
  **必须同批**落到另一侧，或在另一侧 spec 显式登记「接线需求」（WI-2 即此模式：
  services presets spec P2 登记 → 本 spec R4 落地销账）。两侧键闭集各由本包测试
  守护（shared：`packages/shared/test/gitHardeningPresets.test.ts` 全闭集；
  services：`test/gitHardeningPresets.test.ts` 全闭集），漂移即红。
- **允许的差异集（闭集，超出即违规）**：
  1. marketplace 调用点放行 `http`（CLI 存量安装面，services 无对应消费点）；
  2. CLI 漏斗可注入 `baseEnv`（marketplace sanitize/proxy 基底）与 `platform`
     （测试双平台分支），services 漏斗固定 `process.env`/`process.platform`；
  3. overlay 形态（ExecutionPort 契约）仅 CLI 面存在；
  4. `GIT_OPTIONAL_LOCKS` 在 CLI 位于 env 矩阵内、在 services 位于漏斗尾部——
     键值相同，仅代码位置不同。
- **收敛评估（2026-10，登记不收敛理由）**：曾评估把矩阵抽到 shared 单点、services
  委托复用。不采纳：(a) 违反 R1「services/* 冻结面不做反向抽取」既有裁决；
  (b) services config.ts 刚在硬化预设批次改动且未提交，重写为委托层会让同批交付
  的 services 测试面（513 项）全部重新暴露在协调风险下；(c) 两侧 API 形态差异
  （注入通道/overlay/返回类型 `Record<string,string>` vs `NodeJS.ProcessEnv`）
  意味着"单一实现"仍需一层适配包装，去重收益有限。防再分叉改由上节纪律 +
  双侧闭集测试保障。

## R6 argv posture 网关孪生侧接线跟进（2026-10-21 登记，转达自 services git-posture-gateway.md）

services 侧 E3a 已落地 9 档 posture 网关（`packages/services/src/git/providers/
gitPostureGateway.ts`，纯函数判定器）；孪生漏斗现状只有 env 层对齐（R1/R5），
**argv 形状层未接线**。CLI 消费点盘点与建议档位（接线时裁决，逐文件）：

| 文件                                                     | git 面                                                           | 建议档位                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| `packages/core/src/worktree/session-worktree-git.ts`     | worktree add/list、branch、status、diff、rev-parse、symbolic-ref | infra（worktree add 需 `--no-checkout`）+ read  |
| `packages/core/src/worktree/base-branch-merge.ts`        | merge、diff、status、rev-parse、symbolic-ref                     | merge + read                                    |
| `packages/cli-workflow/src/workflow-worktree-manager.ts` | worktree、add、branch、status、rev-parse                         | infra + read                                    |
| `packages/cli-workflow/src/workflow-world-read.ts`       | log/diff（world.run overlay）                                    | read                                            |
| `packages/adapters/src/plugins/marketplace.ts`           | clone、sparse-checkout、checkout                                 | infra/populate（**clone 无对应档：网络+写复合面，接线时裁决扩档或 infra+协议 opt-in**） |
| `packages/adapters/src/context/git-snapshot.ts`          | status、log、rev-parse、config、clean、symbolic-ref              | read（clean 需 scrub 或 infra）                 |
| `packages/bootstrap/src/app/overnight-controller.ts`     | status                                                           | read                                            |
| `packages/cli/src/tui-workspace-git.ts`                  | symbolic-ref                                                     | read                                            |

接线纪律（沿用 R5 防再分叉）：判定器纯函数可平移 shared 供两漏斗共用；接线前孪生侧
新增 git 调用点须先在本表登记档位；marketplace clone 的档位裁决是接线的前置条件。

## 消费点清单（盘点结论，2026-10；协议列 = R3 修订后）

| # | 消费点 | 形态 | 命令面 | 协议（R3 修订后） |
| --- | --- | --- | --- | --- |
| 1 | `packages/adapters/src/context/git-snapshot.ts`（execGitNoThrow） | 完整 env | 只读：rev-parse/status/log/symbolic-ref/show-ref/config | 默认全拒 |
| 2 | `packages/adapters/src/plugins/marketplace.ts`（execGitCommand） | 完整 env（叠在 buildMarketplaceGitEnv 上） | clone/sparse-checkout/checkout（唯一网络面） | **opt-in**：`CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST`（file/http/https/ssh） |
| 3 | `packages/core/src/worktree/session-worktree-git.ts`（defaultSessionGitRunner） | 完整 env | 会话 worktree 生命周期 + merge 前置只读 | 默认全拒 |
| 4 | `packages/cli-workflow/src/workflow-worktree-manager.ts`（defaultGitRunner） | 完整 env | workflow worktree ensure/release/prune | 默认全拒 |
| 5 | `packages/cli/src/tui-workspace-git.ts`（runGitCommand spawn） | 完整 env | 只读：symbolic-ref（TUI 分支徽标） | 默认全拒 |
| 6 | `packages/core/src/worktree/base-branch-merge.ts`（createHostGitRunnerFromExecutionPort） | env overlay | merge/--abort/rev-parse/show-ref/status/diff | 默认全拒 |
| 7 | `packages/cli-workflow/src/workflow-world-read.ts`（runGit） | env overlay | 只读：rev-parse/status --porcelain=v2/diff/log | 默认全拒 |
| 8 | `packages/bootstrap/src/app/overnight-controller.ts`（collectGitStatus） | env overlay | 只读：status --porcelain=v1 --branch | 默认全拒 |

注入替身（deps.git / runCommand 注入点）的测试不受影响；走**默认 runner** 的既有
功能测试（session-worktree-*、workflow-worktree-isolation）即接线后的真实回归面。

## 行为变化（用户可见，登记）

- 上表全部命令面**不再执行仓库 hooks**（post-checkout/post-merge/pre-commit 等）：
  worktree enter/merge/reap、workflow 隔离、marketplace clone 同理（同 services R7，
  硬化目标而非回归）；用户需要 hooks 校验时在终端自行操作。
- `core.logAllRefUpdates=false`：agent 侧 merge/worktree 分支操作不写 reflog；
  用户终端操作不受影响。
- `GIT_NO_LAZY_FETCH=1`：promisor（partial clone）仓库上 merge/diff 缺对象时快速
  失败，不静默打网络。
- `GIT_TERMINAL_PROMPT=0` + askpass 双清：marketplace clone 私有仓凭据缺失时
  **立即报错**而非挂死等输入（此前 stdio 未接管时表现为卡到 10 分钟超时）。
- （R3 修订）协议放行面从全部 8 个消费点收窄到 marketplace 一个调用点；其余
  消费点均为本地命令，功能零影响。
- （R4/P4）bare workspace：git-snapshot/TUI 分支徽标一类自动只读面在 bare 仓库
  祖先发现下从既有 fatal（"must be run in a work tree"）变为 explicit 拒绝文案
  （"cannot use bare repository"）——现状本就按失败降级，UX 等价（同 services P4
  实测裁决）。
- （R4/P4）CLI 面写 index 的命令（worktree add/remove、merge）会把用户 split
  index 合并为单文件——git 双向兼容无损坏，用户侧 git 按其配置自行恢复（同
  services P4 登记）。
- （R4/P4）用户全局 gitconfig 的 rerere/directoryRenames/renameLimit/autocorrect/
  alias 设置对 CLI 发起的 git 命令不再生效（矩阵 command scope 压制）。

## 验收场景

`apps/acode-cli/tests/git-invocation-hardening.test.mjs`（既有守护，按 R3/R4 修订）：

1. env 层矩阵 + 协议默认全拒（`GIT_ALLOW_PROTOCOL=""`；marketplace opt-in 白名单
   内容与旧全局白名单等值，ext/git/fd 必须缺席）。
2. config 层：GIT_CONFIG_COUNT 与矩阵一致、逐项对应、win32/POSIX hooksPath 双分支、
   基础 13 键前缀守护与 services R2 表一致（防漂移；全闭集守护移至 shared 侧新
   测试）、LFS 三键与 credential.helper 有意缺席。
3. 防串仓 + P2 入站消毒：污染 process.env（含 `GIT_CONFIG_GLOBAL/SYSTEM`、
   `GIT_ALLOW_PROTOCOL`、`GIT_GRAFT_FILE`、`GIT_NO_REPLACE_OBJECTS`）→ local env
   剥离、矩阵不被继承值覆盖、残留编号键删净、协议值为 per-call 计算值。
4. overlay 形态：set 含全部矩阵键与 per-call 协议值；unset 含 local env 清单、
   继承编号键与 `GIT_ALLOW_PROTOCOL`。
5. 功能实证（真实 git 临时仓，不可用则 skip）：硬化 env 下 commit 成功且仓库
   pre-commit hook 不执行（对照组执行）；`ext::` 传输被拒且 remote-helper 不执行；
   WorkflowWorktreeManager 默认 runner ensure/release 冒烟（worktree add/remove/prune
   在硬化 env 下功能不受损）。
6. 既有回归：session-worktree-enter/merge/lifecycle、workflow-worktree-isolation、
   plugin-git-source-pinning 测试全绿。

`packages/shared/test/gitHardeningPresets.test.ts`（R4 新增，镜像 services
test/gitHardeningPresets.test.ts 测试面）：

1. P2 入站消毒纯函数断言（GLOBAL/SYSTEM 剥离、协议不透传、完整性 env 不被弱化、
   编号键夹带封死）。
2. P3/P4 预设矩阵键值 + 全闭集守护（32 键：基础 13 + P3/P4 增量 9 + 协议 1+7）。
3. P1 协议默认全拒 + marketplace opt-in 同源构建（env 串与 config always/never
   一致、无重复键、编号键与条目一一对应）。
4. 功能实证（真实 git）：默认硬化 env 下 `ls-remote <file 远端>` 被拒；opt-in
   `CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST` 后同命令成功且 `ext::` 仍被拒；
   replace-ref 伪冒下硬化 env 读到真实内容（对照组伪冒、config 层独立生效）；
   bare 仓库内命令被 explicit 拒绝。
