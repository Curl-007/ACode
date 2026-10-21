# Git posture 意图网关：档位闭集 + argv 精确形状白名单（git posture gateway）

机制来源：Claude Desktop 2.37337 `main` 的 git posture 治理模块
（还原工程原文 `src/beautified/main/index.chunk-CHbrg8it.js:76-687` 网关全函数、
`index.chunk-B4Dgt0a4.js:881-893`（漏斗 `posture ?? "read"` 缺省接线）、
`:4805`（调用点显式传档样例 `posture: "populate"`）。台账：第三轮残余评估 A1/E3。
本项是 E3 的网关半区（WI-E3a）；shadow git 私有 index 管线加固（A2/E3b）另项，
`gitCheckpointRepo.ts`/`gitCheckpointHelpers.ts` 归 E3b 所有权。

与既有 spec 的分层关系（三层叠加，互不替代）：

| 层                           | 所有权                                                                                    | 作用面                                                                                                 | spec                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| env/config 硬化矩阵          | `config.ts` `getGitCommandEnv()`                                                          | 进程环境：协议默认全拒、hooks 废、replace/graft 防御、GIT*CONFIG*\* 消毒                               | `git-invocation-hardening.md` R1–R7、`git-hardening-presets.md` P1–P6（E1 已落地，本项不重复） |
| **posture 意图网关（本项）** | **`packages/shared/src/git-posture/`（纯函数判定器单一所有者，2026-10-21 平移）** + `gitCommandProvider.run()`（services 接线） | **argv 形状**：每次 spawn 前按声明档位做精确形状白名单，可拒绝、可重写（注入防御旗标/重建 fetch argv） | 本文件                                                                                         |
| 调用点档位声明               | `repo/gitCliRepo.ts` 全部 `commandProvider.run` 调用点                                    | 意图表达：显式 `posture`；未声明 = `read`（写形状 fail-closed 拒绝）                                   | 本文件 R2/覆盖矩阵                                                                             |

**判定器平移登记（2026-10-21，WI-T）**：判定器四文件自
`packages/services/src/git/providers/gitPostureGateway*.ts` 平移至
`packages/shared/src/git-posture/`（`index.ts`/`shapes.ts`/`applyWrite.ts`/`applyRead.ts`），
经 shared 根 barrel（`packages/shared/src/index.ts`）导出；services
`gitCommandProvider.ts` 与 acode-cli 孪生漏斗 8 消费点同从此面导入（R5/R6 授权的
「判定器纯函数平移 shared 供两漏斗共用」落地）。env 层矩阵**不**平移——两漏斗各自
实现的裁决不变（`git-invocation-hardening.md` R5「两份实现、一份语义」仅限 env 层；
argv 判定器是单一实现）。判定器纯函数测试同批迁至 `packages/shared/test/
gitPostureGateway.test.ts`；services 侧保留 `gitPostureGatewayWiring.test.ts`
（provider 漏斗接线集成）。

## 威胁模型增量（相对 E1 矩阵）

E1 矩阵管住了 env/config 注入面，但**不感知 argv**：漏斗内一条被放行的命令，其
子命令与旗标形状不受约束。本项封堵的增量面：

1. **裸 push 武器化**：`.git/config` 可设 `push.default=mirror|matching`，把
   `git push`（无参数）变成全分支/全 ref 推送；`follow-tags`/`--mirror`/`--all`
   等形状同理。push 档强制**具体 refspec**（`src:dst` 冒号形态），push 内容与
   仓库配置彻底解耦。
2. **恶意 `.git/config` 的 fetch 武器化面**：`remote.<r>.mirror=true`（fetch 变
   全量镜像+剪枝）、`fetch.prune/pruneTags`（删本地 ref）、`followRemoteHEAD`
   （自动改本地 HEAD 指向）、shallow 系（截断历史）。fetch 档在 argv 重建时逐项
   `-c` 钉死 `mirror=false`、`prune=false`、`pruneTags=false`、
   `followRemoteHEAD=never`，并强制 refspec 目标落在 `refs/remotes/<remote>/`
   命名空间（拒 `refs/remotes/<r>/HEAD` 劫持）。
3. **位置劫持**：`-C <dir>`/`--git-dir=`/`--work-tree=`/`--namespace`/
   `--super-prefix` 可把命令重定向到攻击者选择的仓库/目录。infra 档在子命令位
   拒绝这五个旗标（含 `=` 形态）；其余档位由形状白名单天然排除。
4. **意图漂移/未声明调用点**：新增 git 调用点若忘记声明档位，缺省 read 档拒绝
   一切写形状与网络形状（fail-closed），把"忘记声明"从静默放行变成显式失败。
5. **子模块递归走私**：仓库配置 `submodule.recurse=true` 时，checkout/fetch/
   ls-files/pull/push/read-tree/reset/restore/switch/grep 的 `--recurse-submodules`
   系旗标可顺带触发子模块网络操作——全档位在形状层拒绝（只放行
   `--no-recurse-submodules`/`--recurse-submodules=no`）。

## 产品规则

### R1 档位闭集（类型层封闭）

```ts
type GitPosture =
  | "read"
  | "push"
  | "pushProbe"
  | "fetch"
  | "scrub"
  | "populate"
  | "hydrate"
  | "merge"
  | "infra"
  | "clone";
```

10 值闭集（`GIT_POSTURES` 常量数组 + 字面量联合，判定器对闭集外值拒绝执行）。
与台账"8 档"（read/push/fetch/scrub/populate/hydrate/merge/infra）及证据原文的
差异裁决：

- **`pushProbe` 保留**：证据 `ae` 集（CHbrg8it:76）含它，网关内与 push 同形
  （:391 同分支处理，dry-run 探测语义）。ACode 当前零消费点，保留为闭集成员，
  供未来 push 前置探测使用；台账"8 档"把它折进 push 计数。
- **`infraHooks` 不设**（对证据的裁剪，登记）：证据中 infra/infraHooks 在网关内
  完全同形（:365 同分支），差异只在证据的 hooksPath 预设常量（允许真 hooks 路径）。
  ACode E1 矩阵无条件废 hooks（`git-invocation-hardening.md` R7：服务进程永不执行
  仓库 hooks），"允许 hooks 的 infra 变体"与既有硬化直接冲突，且无消费点——裁剪。
- **`clone` 第 10 档（2026-10-21，ACode 新增）**：证据无对应档（Claude 面无 clone
  消费点）。孪生侧 marketplace clone 是**网络+写复合面**，既非纯 plumbing（infra
  透传过宽）、也非工作区物化（populate 形状不符），按 R6 前置裁决单独立档——
  形状表见 R3 clone 行，设计与两层关系见 R4-9。

各档位意图语义（声明纪律，spec 审查执行）：

| 档位             | 意图                                                                                               | 网络                                              | 写                   |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------- |
| read             | 只读检查（含 ACode 登记增补：config 读、check-ref-format、remote 列表）                            | 否                                                | 否                   |
| push / pushProbe | 推送具体 refspec / 推送探测                                                                        | 是（协议面仍由 E1 envOptions 单独放行，两层独立） | 远端                 |
| fetch            | 拉取（含 ls-remote），argv 重建钉死武器化键                                                        | 是                                                | 本地 refs/remotes/\* |
| scrub            | 私有管线清理/整备（clean、read-tree 重置、maintenance、受限 update-ref/symbolic-ref/update-index） | 否                                                | 私有仓库             |
| populate         | 工作区/索引物化（受限 checkout、单参 read-tree）                                                   | 否                                                | 工作区               |
| hydrate          | LFS 水合 + 索引刷新（update-index -q --refresh、lfs checkout/ls-files）                            | 否                                                | 工作区文件内容       |
| merge            | 合并流程（merge 三形、checkout <sha> -- paths、rm、commit -m --quiet --no-verify）                 | 否                                                | 仓库                 |
| infra            | app 自有 plumbing：argv 透传 + 位置劫持守卫 + `worktree add` 强制 `--no-checkout`                  | 否（协议面缺省全拒兜底）                          | app 控制的仓库面     |
| clone            | 克隆新仓库（网络+写复合面；位置参 url[+dest]、旗标精确闭集、执行/配置注入与子模块扇出收口）        | 是（协议面仍由 E1 env opt-in 逐调用点放行，两层独立） | 新仓库               |

### R2 网关接线与缺省档（fail-closed）

- 接线点：`gitCommandProvider.run()`（services 漏斗 spawn 单点，
  `git-hardening-presets.md` P6 不变量维持）。`GitCommandExecutionOptions` 新增
  `posture?: GitPosture`；**未声明 = `read`**（证据同款缺省，B4Dgt0a4:884
  `i.posture ?? "read"`）。
- 判定器是纯函数 `applyGitPostureGateway(posture, args): string[]`：
  通过时返回**可能被重写**的 argv（spawn 与 `result.args` 都用重写后形态——
  结果如实反映实际执行的命令）；拒绝时抛 `GitPostureError`（`code:
"EGITPOSTURE"`，消息 `git <detail> is not permitted under the "<posture>"
posture`，证据 :206/:254 同款）。网关在解析 git binary 之前执行，零副作用。
- 档位拒绝是**编程错误**（调用点声明与形状不符），以异常形态冒泡到 RPC/服务层，
  不降级成"命令失败结果"——与 spawn 环境竞态（provider 内既有 error 事件降级，
  见 gitCommandProvider.ts 注释）语义区分：后者是环境瞬态，前者必须修代码。
- 非网关面的固定 argv spawn（登记）：`gitEnvironmentProvider` 的 `git --version`
  探测（常量 argv，无仓库上下文，无劫持面）与 `forceKillChildProcess` 的
  taskkill（非 git）。

### R3 argv 形状白名单（判定器规则）

通用解析（证据 :196-205 `G()`）：子命令位 = 跳过 `-c <k> <v>` 成对参数与全局
透传旗标 `--literal-pathspecs`/`--no-optional-locks`/`--no-pager`（:195）后的第一个
token；`--` 前后分段分别判定。旗标缩写匹配（:292 `Z()`）：`--x`/`--no-x`/`--x=v`
按去 `no-` 前缀、去 `=值` 后的名字做**前缀缩写捕获**（`--mir` 命中 `mirror`）。

档位形状表（证据行号 = `index.chunk-CHbrg8it.js` 实读复核）：

| 档位                      | 形状（精确白名单）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 通过时重写                                                                                                                                                                                                                                                                         | 证据行号                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| infra                     | 子命令位拒 `-C`/`--git-dir`/`--work-tree`/`--namespace`/`--super-prefix`（含 `=` 形态）；`worktree add` 必须含 `--no-checkout`；其余透传                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 无                                                                                                                                                                                                                                                                                 | :194、:365-372           |
| push/pushProbe            | 子命令必须 `push`；拒一切单横线旗标与 `-`；拒 all/mirror/tags/prune/delete/branches/follow-tags/receive-pack/exec/push-option/repo 及其缩写；位置参数 ≥2（remote + ≥1 refspec），每个 refspec 匹配 `^\+?(refs/…\|短名):refs/…$` 且不以 `:refs/heads/HEAD` 结尾；`--` 形态要求其后 ≥2 且首 token 非旗标                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 追加 `--no-recurse-submodules --no-follow-tags`                                                                                                                                                                                                                                    | :391-421                 |
| fetch（子命令 fetch）     | 拒 shallow 系（depth/deepen/unshallow/update-shallow/shallow-since/shallow-exclude/refetch）；必须有显式 remote；拒 `--`；旗标只允许精确 `--refmap=`/`--no-prune`/`--no-tags`/`--no-prune-tags`，拒 tags/prune/prune-tags/refmap/multiple/all/upload-pack/exec/**mirror（ACode 收紧，R4-7）** 及缩写与单横线；refspec 必须 `^\+?refs/…:refs/remotes/<remote>/…$` 且拒 `refs/remotes/<r>/HEAD`                                                                                                                                                                                                                                                                                                                                                                                                                                   | **argv 重建**：前缀 + `-c fetch.prune=false -c remote.<r>.prune=false -c fetch.pruneTags=false -c remote.<r>.pruneTags=false -c remote.<r>.mirror=false -c remote.<r>.followRemoteHEAD=never` + `fetch --no-recurse-submodules --no-tags --refmap=` + 保留旗标 + remote + refspecs | :422-483                 |
| fetch（子命令 ls-remote） | 拒单横线旗标与 upload-pack/exec 及缩写；其余透传                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 无                                                                                                                                                                                                                                                                                 | :484-491                 |
| merge                     | `merge --abort`（独参）；或 `merge <旗标集> <sha40/64>`：ff-only 形（必含 `--ff-only --no-overwrite-ignore`）或 no-ff 形（必含 `--no-ff --no-commit --no-overwrite-ignore` + `-m <msg>`），可选旗标仅 `--quiet`，禁重复旗标、禁 `--`，恰 1 个 sha 位置参；`checkout`：前缀含 `--literal-pathspecs` + `--` 在第 1 位 + 首位置参为 sha + `--` 后全非空；`rm`：前缀含 `--literal-pathspecs` + `--` 第 2 位 + 前段恰 `--quiet --force`；`commit`：`-m <msg>`（msg 非旗标）+ 其余恰 `--quiet --no-verify`                                                                                                                                                                                                                                                                                                                            | merge/checkout 追加既定防御旗标（`--no-recurse-submodules` 等按证据 s() 注入）                                                                                                                                                                                                     | :303-363、:495           |
| populate                  | `checkout`：旗标 ⊆ {`--quiet`,`-q`,`--no-track`,`-B`,`--no-recurse-submodules`} 且 ≥1 位置参；`read-tree`：恰 1 个 token（位置参）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | checkout 追加 `--quiet --no-recurse-submodules`                                                                                                                                                                                                                                    | :290、:496-509           |
| scrub                     | `clean`：透传；`read-tree`：`--reset -u <非零sha>` 或 `-m -u <非零sha> <非零sha>`（无 `--`）；`maintenance`：`run` + 旗标 ⊆ {`--auto`,`--quiet`,`--task=loose-objects`,`--task=incremental-repack`} 且至少一个 `--task=`；`update-ref`：stash 形（`--create-reflog -m <msg> refs/stash <非零sha>`，msg 无控制字符，强制 `--no-deref`）/ `-d` 删除形（refs/bisect/_ 或 refs/heads/_+旧值sha）/ 更新形（refs/heads/_、HEAD（旧=新）、refs/remotes/_ 的 sha 旧新值组合，可选 `-m <msg>`）；`symbolic-ref`：`HEAD refs/heads/<合法分支>` 或 `refs/remotes/<r>/HEAD` 指向 `refs/remotes/<r>/…`（拒非法 ref 字符/`..`/`.lock` 等）；`update-index`：恰 `-q --ignore-submodules --refresh` 或 skip-worktree 旗标 + `-z --stdin`                                                                                                        | update-ref 强制注入 `--no-deref`；read-tree -m 形追加 `--no-recurse-submodules`                                                                                                                                                                                                    | :257、:510-633           |
| hydrate                   | `update-index -q --refresh`；`lfs checkout [-- <paths>…]`（`--` 前必须为空）；`lfs ls-files` 旗标 ⊆ {`--json`,`-n`,`--name-only`}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 无                                                                                                                                                                                                                                                                                 | :166、:634-641           |
| read                      | 子命令 ⊆ W 集（branch/cat-file/check-attr/check-ignore/diff/for-each-ref/hash-object/log/ls-files/ls-tree/merge-base/remote/rev-list/rev-parse/show/status/symbolic-ref）**∪ ACode 登记增补 {config, check-ref-format, show-ref, worktree}**；`diff/log/show` 旗标拒 ignore-submodules 非 dirty/all 值与 submodule 非 short 值；`remote` 仅 `get-url` 或**无参列表（ACode 增补）**；`branch` 仅列表形（旗标 ⊆ X 集或 `--format=` 前缀，且至少一个列表旗标）；`symbolic-ref` 恰 1 位置参 + 旗标 ⊆ {`--short`,`--no-short`,`--quiet`,`-q`,`--no-recurse`}；`hash-object` 拒 `-w`；`cat-file` 仅 `--batch-check` 或 `commit\|tree <sha40/64>`；`config`（ACode 增补）仅读形：旗标 ⊆ {`--get`,`--show-scope`,`--show-origin`} 且必含 `--get`、恰 1 个键位置参、无 `--`；`check-ref-format`（ACode 增补）旗标 ⊆ {`--branch`}、恰 1 位置参；`show-ref`（ACode 增补 R4-8）仅 verify 存在性检查形：必含 `--verify`、旗标 ⊆ {`--verify`,`--quiet`,`-q`}、位置参 ≥1、无 `--`；`worktree`（ACode 增补 R4-8）仅 `worktree list [--porcelain]` 读形（add/remove/prune 等写形归 infra）；其余 W 集透传 | diff/log/show 注入 `--ignore-submodules=dirty --submodule=short`；status 注入 `--ignore-submodules=dirty`                                                                                                                                                                          | :175-193、:291、:642-687 |
| clone                     | 子命令必须 `clone`；位置参 = url[+dest]（1–2 个）；旗标 ⊆ 精确闭集 {`--quiet`,`-q`,`--no-checkout`,`--sparse`,`--single-branch`,`--no-tags`} ∪ 名值旗标 {`--origin`/`--branch`/`--depth`（空格或 `=` 形态；`--depth` 值必须正整数、名值非空非旗标）} ∪ `--filter=` 前缀闭集 {`blob:none`,`blob:limit=`,`tree:0`}；禁 `-c`/`--config`（含子命令位之前的 `-c` 对——对完整 argv 显式扫描）、禁 `--`、闭集外一律拒（`--upload-pack`/`--exec`/`--mirror`（含缩写）/`--recurse-submodules`/`--shallow-since`/`--shallow-exclude` 等自然落集外）（ACode 第 10 档，R4-9） | 无（子模块扇出由 E1 config 层 `submodule.recurse=false` 钉死，R4-9 两层关系） | —（证据无对应档） |
| 全档位（infra 除外）      | 子命令 ∈ {checkout,fetch,grep,ls-files,pull,push,read-tree,reset,restore,switch} 时，`--` 前旗标拒 `recurse-submodules` 前缀缩写（放行 `--no-recurse-submodules`/`--recurse-submodules=no`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                                                                  | :278-289、:379-390       |

### R4 ACode 面裁决与对蓝本偏差（登记）

1. **push 拒裸 push/隐式上游推断（按证据裁决，行为变更）**：`gitCliRepo.push`
   原形状 `["push"]`（有 upstream 时）与 `["push","--set-upstream",r,b]` 都被
   push 档拒绝（无具体 refspec）。裁决：调用点重写为显式 refspec——有 upstream
   时 `push <remote> refs/heads/<local>:refs/heads/<upstreamBranch>`（upstream
   语义），无 upstream 时 `push --set-upstream <remote> refs/heads/<b>:refs/heads/<b>`。
   行为变化：a) 仓库 `push.default=mirror|matching` 不再能把 ACode push 放大成
   多分支推送（威胁 1 收口）；b) 本地/上游分支名不一致时从"simple 拒绝报错"变为
   "按 upstream 推送成功"（`push.default=upstream` 语义，与 UI Push 按钮意图一致）。
2. **read 档增补三个只读形状**（证据 W 集按 Claude 面裁剪，ACode 面必需）：
   `config --get` 读形（getIdentity/readOptionalGitConfig）、`check-ref-format
--branch`（分支名预校验，纯语法验证不触仓库）、`remote` 无参列表（listRemotes）。
   全部只读、无网络、精确形状；`config` 的写形（set/unset/-f 等）仍拒。
3. **Git 面板用户写操作宿主档位 = infra（ACode 面裁决）**：stage(`add --`)、
   unstage/discard(`restore …`)、switch/switch -c、commit（含 scoped-commit 临时
   index 管线的 `read-tree`/`update-index --force-remove|--add --cacheinfo`/
   `commit -m`/`reset --quiet HEAD --`）在证据 8 档中**无对应形状**（Claude 面无
   Git 面板；scrub/populate/hydrate/merge 按任务裁决保持证据形状，供 E3b 私有
   管线消费，不塞入面板形状避免档位语义漂移与 WI 间形状耦合）。裁决：这些调用点
   声明 `infra`——argv 100% 由 ACode 构造（路径经 `normalizeInputPath` 仓库内
   收敛 + `--` 分隔、分支名经 `check-ref-format` 预校验、消息为单一 argv 元素），
   infra 的位置劫持守卫仍然生效；协议面缺省全拒兜底网络。**治理纪律：新增 infra
   调用点必须在本 spec 覆盖矩阵登记**，防止 infra 演化成绕过形状验证的万能档。
4. **read 档注入 `--ignore-submodules=dirty`/`--submodule=short`（行为变更，
   登记）**：status/diff/log/show 的子模块"脏内容"条目不再显示（子模块指针变更
   仍显示），输出确定化并与既有 `submodule.recurse=false` 矩阵方向一致。
5. **`core.splitIndex` rev-parse 例外不移植**：证据 :109-116 对 rev-parse 跳过
   splitIndex 注入；ACode 矩阵走 env 注入不感知 argv，E1 P4 已登记同等偏差，本项
   不重复处理。
6. **fetch/scrub/populate/hydrate/merge/pushProbe 当前零消费点**：机制就位。
   E3b checkpoint 管线实接线为统一 `infra`（其 R8 裁决：避免 read 档 diff 重写
   改变解析口径）；scrub/populate/hydrate/merge 留作未来 shadow-git 阶段管线与
   合并流程的闭集档位，零消费不裁剪——形状表按证据保全，防未来接线时再考古。
7. **fetch 档 CLI `--mirror` 拒绝（对蓝本的收紧偏差）**：证据禁用名单
   （:448-459）不含 `mirror`——CLI `--mirror` 隐含全量 refmap（`+refs/*:refs/*`）
   与 prune，会压过重建注入的 `-c remote.<r>.mirror=false`/`--refmap=` 钉死项，
   属蓝本缺口（其 fetch 调用点全为 app 构造，未暴露该面）。台账 A1 点名 mirror
   属"钉死恶意 `.git/config` 武器化面"范围，ACode 将其加入 fetch 禁用名单
   （`FETCH_BANNED_FLAG_NAMES` 含 mirror，缩写 `--mir` 同捕获）；ACode fetch 面
   零消费点，无合法 mirror 需求。
8. **read 档再增补两个只读形状（2026-10-21，孪生侧接线驱动）**：`show-ref` 仅
   verify 存在性检查形（必含 `--verify`、旗标 ⊆ {`--verify`,`--quiet`,`-q`}、
   位置参 ≥1、无 `--`；列表/删除形不纳入）与 `worktree` 仅 `list [--porcelain]`
   读形。驱动面：acode-cli 会话/workflow worktree 域的登记读取
   （`show-ref --verify --quiet <ref>` 与 `worktree list --porcelain` 是其既有
   argv），全部只读、无网络、精确形状，与 R4-2 同判据。services 面无这两个
   子命令的消费点（gitCliRepo 零命中），形状扩容不改 services 侧任何行为。
9. **`clone` 第 10 档设计（2026-10-21，R6 前置裁决落地）**：证据无对应档
   （Claude 面无 clone 消费点）。裁决要点：
   a) **单独立档而非 infra 透传**：clone 是网络+写复合面，`--upload-pack`/
   `--exec`（任意命令执行）、`-c`/`--config`（配置注入，可载 hooksPath/filter
   驱动）、`--mirror`（全 ref 抓取）、`--recurse-submodules`（子模块网络扇出）、
   `--shallow-since`/`--shallow-exclude`（历史截断）都必须显式收口；infra 的
   透传语义无法表达该闭集。
   b) **旗标白名单即禁用面**：不设单独禁用名单——精确闭集 ∪ 名值旗标 ∪
   `--filter=` 前缀闭集之外一律拒，上述禁用族自然落集外（缩写形态同样被拒：
   白名单只收精确旗标，git 的旗标缩写解析面被整体关闭）。
   c) **`-c` 对完整 argv 显式扫描**：通用解析会跳过子命令位之前的 `-c <k> <v>`
   对（全局透传语义），clone 档在判定前对整条 argv 扫描 `-c`/`--config`，
   前置配置注入也在拒绝面内。
   d) **与 E1 协议层的两层关系（独立正交）**：argv 档（本层）只管命令形状；
   传输协议由 env 层 per-call opt-in 放行（services `envOptions` / CLI
   `getCliGitInvocationEnv` 的 `allowedProtocols`，CLI 侧唯一放行点 =
   marketplace 调用点 `CLI_MARKETPLACE_GIT_PROTOCOL_ALLOWLIST`）。一次网络
   clone 必须两层同时声明：只有 argv 形状声明而协议缺省全拒时传输被拒；
   只有协议放行而 argv 越形时 spawn 前被拒。
   e) **通过时不重写 argv**：`--recurse-submodules` 已在形状层禁绝，"默认不
   递归"另由 E1 config 层 `submodule.recurse=false` 钉死（防仓库/全局配置把
   默认翻成递归）——再注入 `--no-recurse-submodules` 与之重复，不注入以保持
   argv 忠实于调用点声明。
   f) **`--filter=` 前缀闭集**：{`blob:none`,`blob:limit=`,`tree:0`}——部分 clone
   的存量消费形状（marketplace sparse 安装面）；`combine:` 复合过滤器与
   `object:type`/`sparse:oid` 无消费点，不纳入。

### R5 失败语义

- 拒绝：`GitPostureError`（`code === "EGITPOSTURE"`，含 `posture` 与 `detail`
  字段），在 spawn 前抛出，零副作用；上层按异常处理（RPC error），日志按
  `createServiceLogger` 惯例由捕获方决定级别。
- 重写：通过判定的 argv 可能被注入防御旗标或整体重建（fetch），spawn 与
  `GitCommandExecutionResult.args` 一律使用重写后 argv。

## 两漏斗覆盖矩阵（R5 防再分叉纪律的网关维度）

### services 漏斗（本项接线）

| 调用面                                                                                                  | 文件                                  | 档位接线                                                             | 状态                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 仓库解析/status/diff/log/graph/branch 列表/ignored/identity/push 前置读                                 | `repo/gitCliRepo.ts`                  | 全部调用点显式 `read`（除下表）                                      | ✅ 本项                                                                                                                                                                                                                                                                                                                                                  |
| push                                                                                                    | `repo/gitCliRepo.ts` `push()`         | `push` + 显式 refspec 重写（R4-1）                                   | ✅ 本项                                                                                                                                                                                                                                                                                                                                                  |
| Git 面板写（switch/add/restore/commit/scoped-commit 管线/reset）                                        | `repo/gitCliRepo.ts`                  | `infra`（R4-3 裁决 + 登记）                                          | ✅ 本项                                                                                                                                                                                                                                                                                                                                                  |
| 命令 spawn 单点                                                                                         | `providers/gitCommandProvider.ts`     | 网关执行点；`posture ?? "read"`                                      | ✅ 本项                                                                                                                                                                                                                                                                                                                                                  |
| `git --version` 探测                                                                                    | `providers/gitEnvironmentProvider.ts` | 固定 argv，非网关面（R2 登记）                                       | ➖ 不适用                                                                                                                                                                                                                                                                                                                                                |
| checkpoint 私有管线（read-tree/add/write-tree/commit-tree/update-ref/restore/ls-tree/hash-object/diff） | `repo/gitCheckpointRepo.ts`           | 全部 12 个 `run` 调用点声明 `infra`（`CHECKPOINT_GIT_POSTURE` 常量） | ✅ **WI-E3b 同批在飞接线**（2026-10-21 实读核对：12/12 调用点已声明，argv 无 `-C/--git-dir`，与 infra 守卫兼容）。E3b 裁决：纯读调用（diff/ls-tree/hash-object/rev-parse）也统一 `infra` 而非 `read`——避免 read 档对 diff 注入 `--ignore-submodules=dirty --submodule=short` 重写改变 commit 区间 diff 的解析口径（登记于 specs/shadow-git-index.md R8） |
| commit-message 生成链/gitService                                                                        | 经 `GitCliRepo`                       | 随 gitCliRepo 档位                                                   | ✅ 本项                                                                                                                                                                                                                                                                                                                                                  |

### acode-cli 孪生漏斗（✅ 2026-10-21 WI-T 已接线）

判定器已平移 `packages/shared/src/git-posture/`（单一所有者，见文首分层表
「判定器平移登记」），8 消费点逐点接线形态、clone 档位裁决（R4-9 落地）、
merge 两步裁决与 `-C` 消除清单全部闭合于 **apps/acode-cli/specs/
git-invocation-hardening.md R6**（该节是本节原「接线需求跟进项」的销账）。
原盘点表保留如下备查（档位以 CLI spec R6 闭合表为最终裁决）：

| 文件                                                     | git 面                                                           | 建议档位（接线时裁决）                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/core/src/worktree/session-worktree-git.ts`     | worktree add/list、branch、status、diff、rev-parse、symbolic-ref | infra（worktree add 需 `--no-checkout`）+ read                      |
| `packages/core/src/worktree/base-branch-merge.ts`        | merge、diff、status、rev-parse、symbolic-ref                     | merge + read                                                        |
| `packages/cli-workflow/src/workflow-worktree-manager.ts` | worktree、add、branch、status、rev-parse                         | infra + read                                                        |
| `packages/cli-workflow/src/workflow-world-read.ts`       | log/diff（world.run overlay）                                    | read                                                                |
| `packages/adapters/src/plugins/marketplace.ts`           | clone、sparse-checkout、checkout                                 | infra/populate（clone 无对应档，接线时裁决：clone 是网络+写复合面） |
| `packages/adapters/src/context/git-snapshot.ts`          | status、log、rev-parse、config、clean、symbolic-ref              | read（clean 需 scrub 或 infra）                                     |
| `packages/bootstrap/src/app/overnight-controller.ts`     | status                                                           | read                                                                |
| `packages/cli/src/tui-workspace-git.ts`                  | symbolic-ref                                                     | read                                                                |

## 接口

`packages/shared/src/git-posture/`（2026-10-21 平移后单一所有者；经
`packages/shared/src/index.ts` 根 barrel 导出）：

- `index.ts`：`applyGitPostureGateway(posture: GitPosture, args: readonly
string[]): string[]`——纯函数判定器：通过返回（可能重写的）argv 新数组；拒绝抛
  `GitPostureError`；公共面再导出下行全部符号。
- `shapes.ts`：`GIT_POSTURES: readonly GitPosture[]`、`type GitPosture`
  （R1 十值闭集）、`DEFAULT_GIT_POSTURE = "read"`、`GIT_POSTURE_ERROR_CODE =
"EGITPOSTURE"`、`class GitPostureError extends Error`（`code`/`posture`/`detail`
  只读字段）、形状常量与 argv 解析助手。
- `applyWrite.ts`：infra/push/fetch/merge/populate/clone 按档应用器。
- `applyRead.ts`：scrub/hydrate/read 按档应用器。
- （400 行 max-lines 棘轮拆分先例 platformIpcRegistry；barrel 只导出
  `applyGitPostureGateway`/`GIT_POSTURES`/`GitPosture`/`DEFAULT_GIT_POSTURE`/
  `GIT_POSTURE_ERROR_CODE`/`GitPostureError` 六符号，内部形状常量不进公共面。）

`providers/gitCommandProvider.ts`（services）：`GitCommandExecutionOptions.posture?:
GitPosture`；`run()` 入口执行网关（binary 解析之前），spawn 与 `result.args`
使用网关输出。

`repo/gitCliRepo.ts`：全部 `commandProvider.run` 调用点显式 `posture`；`push()`
重写为显式 refspec（R4-1）。

acode-cli 孪生侧 8 消费点接线接口：见 apps/acode-cli/specs/
git-invocation-hardening.md R6 闭合表。

见 `packages/shared/test/gitPostureGateway.test.ts`（判定器全档正反例 + clone 档
正反例 + read 增补 show-ref/worktree 形；2026-10-21 随判定器平移迁入）与
`packages/services/test/gitPostureGatewayWiring.test.ts`（接线集成，stub binary +
真实 git 双段）：

1. **闭集与缺省**：`GIT_POSTURES` 恰为 R1 十值（含 clone）；provider 未声明档位时写形状
   （`add`/`commit`/`update-ref`）抛 `EGITPOSTURE`，读形状放行。
2. **read 正反例**：W 集 + ACode 增补通过（含重写注入断言：diff/log/show 双旗标、
   status 单旗标；R4-8 增补 `show-ref --verify --quiet <ref>` 与
   `worktree list [--porcelain]` 放行、`show-ref` 列表/删除形与 `worktree add/
remove/prune` 拒绝）；`add`/`push`/`fetch`/`config --get` 之外的 config 写形/
   `symbolic-ref HEAD refs/heads/x`（双位置参写形）/`hash-object -w`/
   `remote add` 拒绝。
3. **push 正反例**：裸 `push`、`push origin main`（无冒号 refspec）、
   `push --mirror origin`、`push --all origin`、`push -f origin r:r`、
   `push origin x:refs/heads/HEAD` 拒绝；`push origin refs/heads/a:refs/heads/a`
   通过且追加 `--no-recurse-submodules --no-follow-tags`；`--set-upstream` 通过。
4. **fetch 正反例**：`fetch --depth=1 origin`、`fetch --prune origin`、
   `fetch origin`（无 refspec 合法——refspec 可选，但 mirror/prune 键仍被钉死：
   重建后 argv 含六个 `-c` 钉死项 + `--no-tags --refmap=`）、refspec 目标越界
   （`refs/heads/x`）或 `refs/remotes/o/HEAD` 拒绝；重建 argv 逐项断言。
   `ls-remote` 透传、`ls-remote --upload-pack=x` 拒绝。
5. **infra 正反例**：`-C`/`--git-dir`（含 `=` 形态）子命令位拒绝、
   `worktree add`（无 `--no-checkout`）拒绝、`worktree add --no-checkout …` 与
   任意普通 argv 透传。
6. **scrub/populate/hydrate/merge 正反例**：各档证据形状逐条（正例含重写：
   update-ref 注入 `--no-deref`、populate checkout 注入 `--quiet
--no-recurse-submodules`；反例含 update-ref 越界 ref、read-tree 多参、
   lfs 非白名单子命令、commit 缺 `--no-verify`、merge 无 sha 等）。
7. **全档 recurse-submodules 守卫**：read `ls-files --recurse-submodules` 拒、
   `ls-files --no-recurse-submodules` 放行。
8. **clone 正反例（R4-9）**：marketplace 存量形状放行（`clone --depth 1 [--branch
<r>] <url> <dir>`、`clone --depth 1 --filter=blob:none --sparse <url> <dir>`、
   无旗标 `clone <url>`、名值旗标 `=` 形态、`--filter` 前缀闭集其余两形）；
   `--upload-pack`/`--exec`（含缩写与 `=` 形态）/`-c`（含子命令位之前）/`--config`/
   `--mirror`（含缩写）/`--recurse-submodules`/`--shallow-since`/`--shallow-exclude`/
   `--depth` 非正整数或缺值/未知旗标/`--` 分隔/位置参超两个/非 clone 子命令拒绝；
   通过时 argv 不重写。
9. **接线级（真实 git，不可用则 skip）**：临时 repo 上 `status` 未声明档位成功
   且 `result.args` 含注入旗标；`add` 未声明档位抛 `EGITPOSTURE` 且工作区无副作用；
   `add` 声明 infra 成功；file 远端 `push origin refs/heads/main:refs/heads/main`
   声明 push + E1 envOptions 成功（与 `gitHardeningPresets.test.ts` 协议层断言共存）。
10. **既有 E1 验收不回归**：`gitHardeningPresets.test.ts`/`gitInvocationHardening
.test.ts` 全绿（前者 push/ls-remote 链路用例按本 spec 补档位声明与 refspec 形状）。
11. **孪生侧 8 消费点接线**：`apps/acode-cli/tests/
git-posture-gateway-wiring.test.mjs` 逐点断言（接线形态见 CLI spec R6 闭合表）。

## 不在本项范围

- `gitCheckpointRepo.ts`/`gitCheckpointHelpers.ts` 档位声明——WI-E3b（覆盖矩阵
  已登记精确调用面与建议档位）；
- shadow git 私有 index 管线（A2）本体加固；
- fetch 档的实际网络消费点（ACode services 面无 fetch；未来新增远端能力时按
  `git-hardening-presets.md` P1 纪律同时声明 envOptions 协议放行与 fetch 档位）。
