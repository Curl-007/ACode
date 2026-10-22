# Shadow Git 私有 index 加固管线（shadow index pipeline）

机制来源：Claude Desktop 2.37337 `main/index.chunk-PMGadqIZ.js:166-336`（beautified，
zoode 树下 `Claude-2.37337/src/beautified/main/`）与 `index.chunk-CHbrg8it.js:207-253`
（EGITSHADOW 错误码 + 20 值 stage 闭集 + EGITINDEXCOPY/EGITINDEXINSTALL）。
台账：`ACode-价值提取-Claude-2.37337-第三轮残余评估.md` A2。

ACode 对照落点：

- `packages/services/src/git/repo/gitShadowIndex.ts`（本 spec 的管线实现，新模块）；
- `packages/services/src/git/repo/gitCheckpointRepo.ts` `createCheckpoint`——原临时
  `GIT_INDEX_FILE` 预热复制（裸 `copyFile`）改为走本管线；
- `packages/services/src/git/repo/gitCheckpointHelpers.ts` `buildCheckpointEnv`——
  `GIT_INDEX_FILE` 单键覆盖入口不变（providers 的单键 env 覆盖机制是
  `specs/git-invocation-hardening.md`/`git-hardening-presets.md` 已登记例外，本项不改
  config.ts / providers/\*\*，所有权归 WI-E3a）。

## 背景与威胁模型

checkpoint 的 `createCheckpoint` 用临时 `GIT_INDEX_FILE` 把 workspace live 状态固化成
隐藏 commit。为走 stat-cache 快速路径，会先把**用户仓库的真实 index**（`.git/index` 或
worktree/submodule 的 `rev-parse --git-path index` 解析结果）复制进私有目录再交给
`git add`。真实 index 属于半可信输入，裸复制存在四类风险：

1. **符号链接/非常规文件**：`.git/index` 被替换成 symlink 或设备文件时，裸 `copyFile`
   会跟随链接把仓库外任意文件内容拉进私有目录（读取面被劫持）；
2. **损坏/超大 index**：非 git index 内容（无 `DIRC` 魔数）喂给 `git add` 会产生难以
   诊断的解析错误；超大 index 复制放大 IO 与内存；
3. **并发撕裂读**：同 workspace 并发 checkpoint、或用户 git 进程正在重写 index
   （lockfile+rename 交换）时，多个复制同时读同一文件造成重复 IO 突发；
4. **临时副本被踩/写坏**：目标文件非独占创建时，重试或并发路径可能写坏半成品，
   后续 `git add` 读到截断 index。

蓝本（Claude Desktop）用一条加固管线解决：DIRC 魔数验签 + symlink/size 拒 +
wx 独占复制 + mtime 保留 + 只读 lock 预占 + per-path singleflight + 全局并发预算 +
EGITSHADOW stage 闭集错误分类。本 spec 将该管线移植到 ACode checkpoint 的预热复制，
**对外语义不变**：priming 仍是 best-effort 优化，失败降级 `read-tree HEAD`/空 index，
不失败 checkpoint 本身；用户真实 index 保持零写入。

## 产品规则

### R1 管线阶段（顺序闭集）

`createShadowIndex(options)` 依序执行：

| #   | 阶段            | 内容                                                                                                                                                                                                                            | 失败姿态                                                                |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | shadow-root     | `mkdir(rootDir, {recursive})` + `mkdtemp(rootDir/"read-index-")` 建私有目录                                                                                                                                                     | **抛出** `EGITSHADOW` stage `shadow-root`（无私有目录则调用方无法继续） |
| 2   | slot 获取       | per-path singleflight + 全局并发预算（R3）                                                                                                                                                                                      | 等待超时/abort → `prime.kind="rejected"`，code `EGITINDEXCOPY`          |
| 3   | beforeCopy 钩子 | 测试/扩展接缝，接收 `{dir, indexFile}`                                                                                                                                                                                          | 抛错 → `rejected`（`EGITINDEXCOPY` 包裹）                               |
| 4   | 源检查          | `lstat(source, {bigint})`：symlink/ELOOP/非常规文件拒（stage `real-index`）；ENOENT/ENOTDIR → `prime.kind="source-missing"`（合法：刚 init 的空仓）                                                                             | `rejected`（`EGITSHADOW`）                                              |
| 5   | fd 锚定校验     | `open(source,"r")` 后经**同一 fd** `stat({bigint})` + 读满前 4 字节：非 `DIRC` 魔数拒；size > maxBytes（默认 512 MiB）拒；stage `private-index`。fd 锚定保证 stat/魔数/复制读的是同一 inode，git lockfile+rename 交换不产生跨读 | `rejected`（`EGITSHADOW`）                                              |
| 6   | 只读 lock 预占  | `writable !== true` 时 `writeFile(dir/"index.lock", "", {flag:"wx"})` 预占，防他进程对该私有副本发起 index 写；`writable: true`（checkpoint 形态）跳过——`git add` 需要自己创建 `index.lock`                                     | `rejected`（`EGITINDEXCOPY`）                                           |
| 7   | wx 独占复制     | `pipeline(handle.createReadStream({start:0, end:size-1, highWaterMark:1MiB, autoClose:false}), createWriteStream(indexFile, {flags:"wx"}))`。wx 保证目标不存在才创建，任何并发/重试路径撞名即 EEXIST 失败而不是写坏             | `rejected`（`EGITINDEXCOPY`）                                           |
| 8   | mtime 保留      | `utimes(indexFile, sec, sec)`，`sec = Number(fdStat.mtimeNs / 1_000_000_000n)`（R4）                                                                                                                                            | `rejected`（`EGITINDEXCOPY`）                                           |
| 9   | 释放            | finally：关 fd、释放 slot（计数-1、清 per-path gate、settle 预算 gate）                                                                                                                                                         | —                                                                       |

返回 `ShadowIndexHandle { dir, indexFile, lockFile, prime, dispose() }`。
除阶段 1 外管线**不抛错**，失败以 `prime: {kind:"rejected", error}` 分类返回，由
调用方裁决（checkpoint = fail-soft 降级，见 R2）。

`dispose()`：`rm(dir, {recursive, force, maxRetries:3, retryDelay:100})`，best-effort
不抛——清理失败不得掩盖主链路错误（对现状 finally 裸 `rm` 的改进，登记于偏差表）。

### R2 失败姿态与错误分类

错误码沿用蓝本闭集（`CHbrg8it.js:207,251-253`）：

- **`EGITSHADOW`**（带 stage）：校验拒绝与源检查失败——symlink、非常规文件、size 超限、
  DIRC 魔数不符、源不可读、shadow-root 建目录失败。语义：_拒绝读取/建立私有副本，
  源与目的地都未被污染_。stage 取值限于 R6 闭集。
- **`EGITINDEXCOPY`**（无 stage，与蓝本一致）：排队等待超时/abort、复制/lock/utimes
  等基础设施失败。语义：_私有副本制作中途失败_。
- **不采用** `EGITINDEXINSTALL`：蓝本用它覆盖"把 git 写出的 index 安装回真实
  `.git/index`"（`PMGadqIZ.js:337-456` real-index lock 安装器）。ACode checkpoint
  **从不写用户真实 index**，该阶段无消费面，登记差集不实现。

失败姿态硬规则：

1. **fail-closed 清理**：复制阶段任何失败必须删除目的地半成品（`rm(indexFile)`），
   handle 里的 index 路径保持"不存在"，后续 `git add`/`read-tree` 从零建 index，
   绝不读到截断内容；
2. **checkpoint fail-soft 裁决**：`prime.kind !== "copied"` 时降级 `read-tree HEAD`
   （HEAD 不存在再落空 index），checkpoint 对外语义不变；`rejected` 必须经
   `createServiceLogger("git-checkpoint")` warn 留痕（code/stage/message）；
3. **shadow-root 是唯一硬失败**：私有目录都建不出来时 checkpoint 直接失败（与现状
   mkdir/mkdtemp 抛错一致）。

### R3 并发语义（singleflight + 预算）

- **per-path singleflight**：以 `resolve()` 后的源 index 路径为 key 的模块级互斥。
  同 key 并发调用**串行化**（后者等前者释放后自己再复制一份，各自拿到独立私有
  副本）——不是结果合并/共享。目的：同一 workspace 并发 checkpoint 不同时读同一
  真实 index，压平 IO 突发并缩小与用户 git 重写 index 的碰撞窗口。
  登记残余：key 用 verbatim 路径，不做 realpath/大小写归一（Windows 大小写别名、
  8.3 短名会绕开互斥；与蓝本一致的接受残余）。
- **全局并发预算**：模块级计数，默认 **2**（蓝本 `D=2`，`PMGadqIZ.js:168`）。
  超限者排队等待共享 gate；任一复制释放时 settle gate 唤醒等待者重新竞争。
- **等待超时**：singleflight 等待与预算等待共用默认 **5000ms**（蓝本 `ee=5e3`），
  可被 `AbortSignal` 提前终止；超时/abort → `EGITINDEXCOPY` 分类错误
  （"still waiting for an earlier copy of it to finish" /
  "still waiting for N other index copies to finish"，文案沿蓝本）。
- **裁决**：超时走 fail-soft（R2-2），不无限排队也不失败 checkpoint。理由：priming
  是纯优化，降级路径（read-tree HEAD）功能完备；用超时掩盖同步问题是禁止的，这里
  超时只终止"等待优化资源"，不掩盖任何状态不一致。
- 参数可注入（`copyBudget`/`waitTimeoutMs`/`maxBytes`）供测试与调优；默认值常量
  导出，测试断言与 spec 数值一致（防漂移）。

### R4 mtime 保留口径

复制完成后把私有 index 的 atime/mtime 都设为源 index 的 mtime，口径
**`floor(mtimeNs / 1e9)` 整秒截断**（BigInt 除法，蓝本同款 `PMGadqIZ.js:293`）。

理由：git index 的 racily-clean 判定以 index 文件自身 mtime 为界——mtime ≥ index
mtime 的条目视为"可能竞态"，git 会重验内容而非信任 stat 匹配。若副本 mtime 变成
"现在"（远晚于源），源 index 里本该重验的条目在副本里会被 stat 快速路径放过，
产生陈旧命中。向下取整保证副本 mtime ≤ 源 mtime，racily-clean 集合只增不减，
偏差方向是"多重验"（安全）。亚秒精度有意丢弃。

### R5 只读 lock 预占

`writable !== true`（默认，蓝本同款）时在私有目录预占空 `index.lock`（`wx` 独占
创建，`PMGadqIZ.js:283-284`）：任何试图写该私有 index 的他进程 git 会立即撞锁
失败，声明"此副本只读"。`writable: true` 跳过预占——checkpoint 的临时 index 由
`git add`/`read-tree` 写入，git 需要自己创建 lock。当前唯一生产消费面
（checkpoint priming）是 writable 形态；只读形态为后续"读 shadow 副本跑
status/diff"类消费预留，行为有测试覆盖。

### R6 stage 闭集（EGITSHADOW 20 值映射）

蓝本闭集：`CHbrg8it.js:208-228`（`pe` 数组，20 值），成员判定 `q()`（:229-231），
遥测映射 `me()`（:238-250，code=EGITSHADOW 时仅放行闭集内 stage + errno 链）。
ACode 取**交集 3 值**，其余 17 值登记差集（机制未移植，禁止在 ACode 侧新增闭集外
stage 值）：

| #   | 蓝本 stage                     | ACode 裁决 | 说明                                                                                                                   |
| --- | ------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | `shadow-root`                  | **采用**   | 私有 index 根目录（`getGitCheckpointIndexRootDir()`）mkdir/mkdtemp 失败                                                |
| 2   | `common-dir`                   | 差集       | 蓝本 shadow 布局解析 GIT_COMMON_DIR；ACode 直接 `rev-parse --git-path index`，无 shadow root 布局                      |
| 3   | `owned-dir`                    | 差集       | 目录所有权校验（`PMGadqIZ.js:1351`）未移植，另项候选                                                                   |
| 4   | `global-config`                | 差集       | git 全局配置治理，属 WI-E3a（git-invocation-hardening / git-hardening-presets）                                        |
| 5   | `self-check-common-dir`        | 差集       | shadow 布局自检（`PMGadqIZ.js:1160-1230`）依赖蓝本 GIT_DIR/GIT_COMMON_DIR 双目录布局，ACode 无                         |
| 6   | `self-check-git-dir`           | 差集       | 同上                                                                                                                   |
| 7   | `self-check-refs`              | 差集       | 同上                                                                                                                   |
| 8   | `self-check-dubious-ownership` | 差集       | 同上                                                                                                                   |
| 9   | `self-check-not-a-repository`  | 差集       | 同上                                                                                                                   |
| 10  | `self-check-no-answer`         | 差集       | 同上                                                                                                                   |
| 11  | `reflog-guard`                 | 差集       | reflog 写入守护（`PMGadqIZ.js:1369-1429`）；checkpoint 的 `update-ref` 走既有 providers 硬化矩阵                       |
| 12  | `reftable`                     | 差集       | reftable 后端检测；ACode 假定 files 后端                                                                               |
| 13  | `fetch-heads`                  | 差集       | fetch 治理；checkpoint 面无 fetch                                                                                      |
| 14  | `merge-switched-off`           | 差集       | merge 治理；checkpoint 面无 merge                                                                                      |
| 15  | `private-index`                | **采用**   | size/DIRC 魔数/fd 校验拒绝 + 源不可读                                                                                  |
| 16  | `real-index`                   | **采用**   | 源 index lstat 拒绝：symlink（"the repository's index is a link"）/非常规文件（蓝本 `De`/`Oe`，`PMGadqIZ.js:497-516`） |
| 17  | `session-repository`           | 差集       | 蓝本会话仓库生命周期，无对应物                                                                                         |
| 18  | `anchor-missing`               | 差集       | 蓝本 workspace anchor 机制，无对应物                                                                                   |
| 19  | `anchor-mismatch`              | 差集       | 同上                                                                                                                   |
| 20  | `anchor-hook-workspace`        | 差集       | 同上                                                                                                                   |

导出 `SHADOW_INDEX_STAGES = ["shadow-root", "private-index", "real-index"] as const`
与 `isShadowIndexStage()` 判定；错误对象的 `stage` 字段类型收敛到该闭集。

### R7 checkpoint git 子命令面登记（闭集映射核对基准）

现状 checkpoint 链路实际执行的 git 子命令（2026-10 复核 `gitCheckpointRepo.ts` /
`gitCliRepo.resolveRepository`），用于核对 R6 差集裁决"机制无消费面"成立：

| 子命令                                                                        | 调用点                                         | 与 stage 闭集关系                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| `rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir` | resolveRepository                              | 仓库解析；蓝本 self-check-\* 的同名探测在 ACode 无 shadow 布局可校验 |
| `rev-parse --git-path index`                                                  | createCheckpoint（源 index 解析）              | 管线的 sourceIndexPath 输入                                          |
| `read-tree HEAD`                                                              | createCheckpoint（降级 priming，走临时 index） | R2-2 fail-soft 路径                                                  |
| `add -A -- <pathspec>`                                                        | createCheckpoint（live 收集，走临时 index）    | writable 形态依据（R5）                                              |
| `write-tree` / `commit-tree <tree> -m ...`                                    | createCheckpoint                               | 隐藏 commit 固化                                                     |
| `update-ref <ref> <oid>` / `update-ref -d <ref>`                              | create/deleteCheckpoint                        | reflog-guard 差集依据                                                |
| `diff --name-status/--numstat --find-renames -z`                              | diffCheckpoints                                | 纯读                                                                 |
| `ls-tree -r -z` / `hash-object --no-filters`                                  | 冲突检测                                       | 纯读                                                                 |
| `restore --source=<oid> --worktree -- <paths>`                                | restoreBetweenCheckpoints                      | 只写 worktree，不写 index（real-index 安装器差集依据）               |

### R8 边界与所有权

- 管线模块只依赖 `node:fs`/`node:path`/`node:stream`，不 spawn git、不 import
  providers/config（WI-E3a 所有权面）；env 注入仍由 `buildCheckpointEnv` 单键覆盖
  经 `gitCommandProvider.run({env})` 既有机制完成。
- **posture 接线（跨 WI 契约）**：`gitCheckpointRepo.ts` 全部 12 处
  `commandProvider.run` 声明 `posture: "infra"`——这是 `specs/git-posture-gateway.md`
  接线表（:171）显式移交 WI-E3b 的项。裁决：checkpoint 私有管线统一 infra
  （argv 原样透传、仅拒 `-C/--git-dir` 位置劫持）；纯读调用不用 read 档——read 档
  会给 diff 注入 `--ignore-submodules=dirty --submodule=short` 重写，改变 commit
  区间 diff 的输出形状，而 `parseNameStatus/parseNumstat` 的解析口径必须与网关
  引入前逐字节一致。infra 的位置劫持守卫与 checkpoint 面兼容（R7 登记表的 argv
  均无 `-C/--git-dir` 形状）。
- 实现拆分为三个文件（`gitShadowIndexErrors.ts` 错误分类 / `gitShadowIndexSlot.ts`
  并发闸门 / `gitShadowIndex.ts` 管线主体），对外以 `gitShadowIndex.ts` 为唯一
  入口（re-export）；拆分动因是 400 行架构上限（`pnpm architecture:check`）。
- 模块级并发状态（singleflight map / 预算计数 / gate）为**进程内**语义；跨进程
  互斥不在本项范围（蓝本同样进程内）。
- 日志：调用方（gitCheckpointRepo）用 `createServiceLogger("git-checkpoint")`；
  管线模块自身不打日志，分类信息全部随 `prime` 结果返回（单一事实源，避免双份
  状态）。

## 验收场景

1. **魔数坏拒**：源 index 非 `DIRC` 开头 → `rejected`，code `EGITSHADOW`，stage
   `private-index`，目的地无半成品；checkpoint 降级 read-tree 仍成功。
2. **symlink 拒**：源 index 是 symlink → stage `real-index`；ELOOP（链接环）同样拒。
3. **非常规文件拒**：源 index 是目录/FIFO → stage `real-index`。
4. **size 拒**：超过 maxBytes（可注入）→ stage `private-index`，message 含 MiB 上限。
5. **源缺失合法**：ENOENT/ENOTDIR → `source-missing`（非错误），checkpoint 走
   read-tree/空 index 降级。
6. **happy copy**：字节一致；mtime 按 R4 整秒保留；`copied` 携带 bytes/mtimeSeconds。
7. **wx 独占**：目的地已存在同名文件（beforeCopy 预置）→ 复制 EEXIST 失败，
   `EGITINDEXCOPY`，半成品清理。
8. **只读 lock 预占**：默认（read-only）形态私有目录含空 `index.lock`；
   `writable: true` 不含。
9. **singleflight 串行**：同源并发两调用，后者在前者释放前不进入复制；两者各自
   得到独立副本；结束后模块并发计数归零。
10. **singleflight 超时**：前者被钩子挂住，后者 `waitTimeoutMs` 到期 →
    `EGITINDEXCOPY`"still waiting for an earlier copy"；前者不受影响完成。
11. **预算排队/超时**：`copyBudget=1` 时异源第二路等待；超时 → `EGITINDEXCOPY`
    "still waiting for 1 other index copies"。
12. **abort**：等待期间 AbortSignal 触发 → 同超时分类。
13. **shadow-root 硬失败**：rootDir 不可建（指向既有文件）→ `createShadowIndex`
    抛 `EGITSHADOW` stage `shadow-root`。
14. **checkpoint 零污染回归**（集成，git 可用时）：createCheckpoint 后用户真实
    index 字节与 mtime 不变；隐藏 ref/commit tree 内容 = live 状态；私有临时目录
    清空（dispose 生效）。
15. **checkpoint 坏 index fail-soft**（集成）：真实 index 写成垃圾字节 →
    createCheckpoint 仍成功且 tree 正确（read-tree 降级），真实 index 保持零写入。
16. **常量防漂移**：默认 maxBytes=536870912、budget=2、timeout=5000ms、stage 闭集
    三值，测试断言与本 spec 一致。

## 与蓝本偏差登记

| #   | 偏差                                                                                                          | 理由                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | 私有目录创建（shadow-root）先于 slot 获取与源校验（蓝本：slot → 校验 → mkdtemp）                              | ACode 的 `rejected` 结果也要返回可用 handle（空 index 路径）供 fail-soft 降级，目录必须先存在  |
| 2   | 校验拒绝不抛错，以 `prime` 分类结果返回；仅 shadow-root 抛                                                    | checkpoint 的 priming 是 best-effort，调用方需要结构化裁决而非 catch 字符串                    |
| 3   | 失败时统一删半成品 `indexFile`；`dispose` best-effort 不抛                                                    | 蓝本失败即 rm 整个临时目录并抛错；ACode 目录要继续服务降级路径，故只删 index 文件              |
| 4   | `beforeCopy` 钩子携带 `{dir, indexFile}` 参数（蓝本无参）                                                     | 测试接缝：wx 独占冲突等场景需要预置目的地                                                      |
| 5   | symlink 拒绝用 lstat 前置层（stage `real-index`），比蓝本 copy 路径的 ELOOP-only（stage `private-index`）更严 | 蓝本靠 spawn 前 `De` lstat 层兜底；ACode 无独立 spawn 检查层，直接在管线内合并两层，取更严语义 |
| 6   | 无 UNC allowUnc 重试（蓝本 `ae` 的 `t.tH(e,{allowUnc})`）                                                     | Node `fs.open` 原生支持 UNC 路径，无需蓝本的宿主特化封装                                       |
| 7   | `EGITINDEXINSTALL` / real-index lock 安装器（蓝本 `me`）不移植                                                | ACode 从不写用户真实 index（R2/R7）                                                            |
| 8   | singleflight key 不做 realpath 归一                                                                           | 与蓝本一致的接受残余（R3 登记）                                                                |
