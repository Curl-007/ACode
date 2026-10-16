# CLI git 调用硬化（acode-cli 自有 git spawn 面）

交叉引用：`packages/services/specs/git-invocation-hardening.md`（机制来源、威胁模型、
R1–R7 完整语义、两条有据偏差）。services 侧消费面盘点把本面登记为「接线需求，
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

- **直接 spawn**（execFile/spawn 点）：`getCliGitInvocationEnv(baseEnv?)` 返回完整
  env——先剥离 GIT local env（GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE 等，防串仓，
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

## R3 协议白名单（CLI 面差异，调查结论）

`CLI_GIT_ALLOW_PROTOCOL_WHITELIST = "file:http:https:ssh"`——比 services 的
`file:https:ssh` **多一项 `http`**，按 CLI 实际协议面调查定案：

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

## 消费点清单（盘点结论，2026-10）

| # | 消费点 | 形态 | 命令面 |
| --- | --- | --- | --- |
| 1 | `packages/adapters/src/context/git-snapshot.ts`（execGitNoThrow） | 完整 env | 只读：rev-parse/status/log/symbolic-ref/show-ref/config |
| 2 | `packages/adapters/src/plugins/marketplace.ts`（execGitCommand） | 完整 env（叠在 buildMarketplaceGitEnv 上） | clone/sparse-checkout/checkout（唯一网络面） |
| 3 | `packages/core/src/worktree/session-worktree-git.ts`（defaultSessionGitRunner） | 完整 env | 会话 worktree 生命周期 + merge 前置只读 |
| 4 | `packages/cli-workflow/src/workflow-worktree-manager.ts`（defaultGitRunner） | 完整 env | workflow worktree ensure/release/prune |
| 5 | `packages/cli/src/tui-workspace-git.ts`（runGitCommand spawn） | 完整 env | 只读：symbolic-ref（TUI 分支徽标） |
| 6 | `packages/core/src/worktree/base-branch-merge.ts`（createHostGitRunnerFromExecutionPort） | env overlay | merge/--abort/rev-parse/show-ref/status/diff |
| 7 | `packages/cli-workflow/src/workflow-world-read.ts`（runGit） | env overlay | 只读：rev-parse/status --porcelain=v2/diff/log |
| 8 | `packages/bootstrap/src/app/overnight-controller.ts`（collectGitStatus） | env overlay | 只读：status --porcelain=v1 --branch |

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

## 验收场景

`tests/git-invocation-hardening.test.mjs`：

1. env 层矩阵 + 白名单精确值（file:http:https:ssh；ext/git/fd 必须缺席）。
2. config 层：GIT_CONFIG_COUNT 与矩阵一致、逐项对应、win32/POSIX hooksPath 双分支、
   键闭集与 services R2 表一致（防漂移）、LFS 三键与 credential.helper 有意缺席。
3. 防串仓：污染 process.env → local env 剥离、矩阵不被继承值覆盖、残留编号键删净。
4. overlay 形态：set 含全部矩阵键；unset 含 local env 清单与继承编号键。
5. 功能实证（真实 git 临时仓，不可用则 skip）：硬化 env 下 commit 成功且仓库
   pre-commit hook 不执行（对照组执行）；`ext::` 传输被拒且 remote-helper 不执行；
   WorkflowWorktreeManager 默认 runner ensure/release 冒烟（worktree add/remove/prune
   在硬化 env 下功能不受损）。
6. 既有回归：session-worktree-enter/merge/lifecycle、workflow-worktree-isolation、
   plugin-git-source-pinning 测试全绿。
