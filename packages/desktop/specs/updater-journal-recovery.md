# Spec：桌面更新交接账本（journal）、启动后验证、残留清扫

> 状态：**已实施**（omp 价值提取波 1 · WI-9 / 台账 T1#14「更新器备份-验证-回滚-残留清扫闭环」）。
> 机制来源：oh-my-pi (MIT) `packages/coding-agent/src/cli/update-cli.ts`
> （Copyright (c) 2025 Mario Zechner & Stencil Labs）——`replaceBinaryForUpdate`
> 的「备份→换入→验证→失败回滚」、`sweepStaleUpdateArtifacts` 的「模式匹配 +
> mtime 年龄窗 + best-effort 删除」、Windows 运行中镜像 `.bak` 延迟回收
> （被占用文件本轮跳过留待下次）、`omp.dist` 的未知值保守兜底契约。按
> electron-updater 现实能力转译为 ACode 自有代码，不搬代码文本。
> 与 `specs/shutdown-keepawake-containment.md` **R19**（更新交接豁免，提交 b1b3f1e）
> 强协同：本 spec 的账本写入点必须位于既有流程内 R19 `disableExitSweep` 之前，
> 且不得改变「sweep → disableExitSweep → quitAndInstall」豁免时序。

## R0 能力判决：主进程侧闭环的诚实边界

- electron-updater 的 Windows 链路是 `quitAndInstall()` → NSIS 安装器接管 →
  **主进程退出**。安装器层的真实「安装失败回滚」发生在安装器/OS 层，主进程
  已不存在，**不伪造主进程侧回滚**（对照 omp：omp 的 replaceBinaryForUpdate
  是主进程存活下的 rename 备份→换入→验证→回滚，electron-updater 模型下没有
  对应的主进程窗口期）。
- 主进程能做且本 spec 承担的四件事：①交接前状态快照（账本）；②下次启动
  验证（版本是否真的变了 + 关键资源探针）；③失败/事故的恢复指引（清理失效
  pending、恢复可重试入口）；④残留清扫（pending 目录过期/不匹配 lineage 的
  包 + 账本代数截断）。
- 本月事故指纹（R19 实证）：交接后安装器被 exit 钩子 SIGKILL → 「版本不变、
  按钮像没反应」→ pending 就绪态下次启动被恢复形成死循环。账本让该形态在
  下次启动**可诊断**（warn + 结构化指纹），而不是靠用户感知静默重试。

## R1 账本存储与 schema（updaterJournal.ts）

- 文件：`userData/update-journal.json`，`{version: 1, entries: [...]}`，
  temp（`<file>.<pid>.tmp`）+ rename 原子写；rename 被占用/杀软拦截时退化为
  直写（尽力落盘优先于原子性，参照 shutdownEvidence 的降级路径）。**异步 IO**：
  交接写入点虽然贴近退出路径，但每次写都 `await` 完成后才继续执行
  quitAndInstall，不存在「异步写被退出竞态打断」的窗口，故不登记同步例外。
- entry 闭集字段：`generation`（代数，单调递增）、`fromVersion`（交接时运行
  版本）、`toVersion`（期望安装后版本）、`outcome`
  ∈ {`handed-off`, `verified`, `failed`, `install-not-effective`, `handoff-aborted`}、
  `handedOffAt`（epoch ms）、`exitSweepHandoff`（R19 豁免链标记）
  ∈ {`pending`, `completed`, `failed`, `absent`}；可选：`installerPath` /
  `installerFileName`（pending 目录内已 stage 的安装器）、`sha512`、`size`
  （交接点 stat 实测）、`pendingReleaseName`、`channel`、`platform`、`outcomeAt`。
- **谁写谁读**：唯一写入方 = main 的 autoUpdater 模块（交接写入/改判/标记）；
  唯一读取方 = 启动期恢复与低峰清扫（读盘最新值做决策，不信任内存跨代缓存）。
- 代数上限 `UPDATE_JOURNAL_MAX_ENTRIES = 8`：append 超限裁最旧（generation
  保留原值，不重排），journal 自身按代数截断。
- **幂等边界**：`markOutcome` / `setExitSweepHandoff` 只对 `outcome=handed-off`
  的条目生效（二次调用 no-op）；`appendHandoff` 遇到上一条仍是 `handed-off`
  （上次交接未收口）先改判 `install-not-effective` 再追加新代，不产生双
  handed-off 悬案。
- 崩溃一致性：`handed-off` 落账严格先于安装器 spawn——进程在落账后任意点
  死亡（含安装器被杀），下次启动都能看到未收口条目；落账前死亡（交接准备
  抛错）无条目，不产生误报。`exitSweepHandoff=pending` 残留 = 死亡点在
  onBeforeQuitAndInstall 内部（R19 豁免链未走完），比 `completed` 更精确地
  指向事故窗口。

## R2 交接写入点与 R19 协同

```text
quitAndInstallUpdate()
  ├─ cap 门 / restage / 状态检查（既有，不变）
  ├─ [新增] dev-relaunch 判定：dev 路径无真实安装器接管，不落账（否则伪造指纹）
  ├─ [新增] await appendHandoff({from, to, installer*, sha512, size, exitSweepHandoff:"pending"})
  ├─ runShutdown("update-install")（既有，不变）
  ├─ await onBeforeQuitAndInstall()                ← index.ts 内部：
  │      prepareAppQuit → 资源锁扫描 → containment sweep("update-install")
  │      → disableExitSweep("update-install-handoff")   [R19 豁免链，末步]
  │   catch → [新增] 改判 {exitSweepHandoff:"failed", outcome:"handoff-aborted"}
  │            再走既有失败处理（安装不会发生，防止下次启动误判事故指纹）
  ├─ [新增] await setExitSweepHandoff(gen, hook存在 ? "completed" : "absent")
  ├─ autoUpdater.quitAndInstall()                  ← 安装器 spawn（时序终点，不变）
```

- 两次账本写都 `await` 完成后才调用 `quitAndInstall()`，R19 豁免时序
  （disableExitSweep 先于安装器 spawn）不变，只在既有间隙里插入了带界面的
  落账等待。
- `exitSweepHandoff` 语义：autoUpdater 无法读取 containment 控制器内部状态
  （实例在 index.ts，且本 WI 不改 index.ts/processContainment.ts），以
  「onBeforeQuitAndInstall 是否成功 resolve」表达豁免链完成度——index.ts
  接线中该钩子成功路径的末步就是 R19 的 disableExitSweep。`completed` =
  豁免链已走完；`pending` 残留 = 死在豁免链之前；`failed` = 豁免链中途抛错；
  `absent` = 无钩子注入（测试/特殊 flavor）。

## R3 启动恢复（initAutoUpdater 内，先于后台检查）

```text
load journal（解析失败/文件缺失 → null → 无账本路径，仅 debug 留痕，不阻断）
  ▼ deriveStartupRecoveryPlan(lastEntry, currentVersion)
  │  lastEntry.outcome ≠ "handed-off"（含 unknown/无账本）→ none（unknown 不行动 + warn：
  │    未来版本的新枚举值保守不解读，残留交给清扫按年龄兜底）
  ├─ currentVersion === toVersion ──▶ first-launch-after-update → R4 验证
  ├─ currentVersion === fromVersion ▶ install-not-effective（fingerprint=version-unchanged，
  │    即本月事故指纹）：warn 结构化（from/to/exitSweepHandoff/handedOffAt）→
  │    校验 pending 安装器（sha512→size 逐级）：
  │      完整 → info「可重试」；既有 hydratePendingPostUpdateReleaseNotes 已恢复的
  │             ready 保留；无说明可恢复时用账本数据补齐 restage-ready
  │             （readyUpdateRestoredFromPendingReleaseNotes=true，点击后重新下载安装，
  │              不拿被证明未生效的安装上下文直接 quitAndInstall——诚实重试）；
  │      失效 → 清掉可能被 hydrate 恢复的伪 ready + 持久化说明 → idle
  │             （不展示「重启以更新」指向损坏包；UI 回到可重新发现更新的诚实状态）
  │    最后 markOutcome("install-not-effective")
  └─ 其余版本 ──▶ install-not-effective（fingerprint=version-diverged，info 留痕）
```

- 恢复逻辑整体 try/catch 包裹：任何异常降级为无账本继续启动，**不因账本
  问题阻断更新检查**。
- UI 呈现走既有 `UpdateStatePayload` 闭集通道（ready 恢复 = update-downloaded；
  失效清理 = idle）；更丰富的「更新恢复诊断」渲染面超出本 WI 所有权，记入
  共享桶申请。

## R4 启动后验证（first-launch-after-update）

- 版本一致性已由 plan 判定（electron-updater 模型下「版本真的变了」= 安装器
  确实跑完的最强信号）；资源探针（可注入，测试可替换）：
  1. `process.execPath` 可 stat（主程序镜像存在）；
  2. 打包构建下 `resources/app-update.yml` 可 stat（resources 树整体替换的
     下限信号；bundled agent 深度完整性由 index.ts 既有启动诊断覆盖，不在
     本模块重复建设）。
- 通过 → `outcome=verified` + info；不通过 → `outcome=failed` + error 结构化
  （用户可见的诚实状态 = 不伪造成 ready/success；深度呈现记共享桶）。

## R5 残留清扫（updaterSweep.ts，启动低峰定时 5min unref）

- pending 目录解析复刻 electron-updater 算法：baseCachePath（win32=
  `%LOCALAPPDATA%`、darwin=`~/Library/Caches`、linux=`$XDG_CACHE_HOME|~/.cache`）
  + `updaterCacheDirName`（app-update.yml 单行正则解析，dev 读
  dev-app-update.yml；读取失败兜底 `${app.name}-updater`）+ `pending`。
- 逐文件决策（best-effort，任何单文件失败不影响其余，绝不抛出）：

| 文件 | 规则 |
| --- | --- |
| 任一文件 mtime 超过 `staleRetentionMs`（7 天） | 无条件过期 → 删 |
| 当前代 installer 且 `preserve=true`（outcome ∈ handed-off / install-not-effective / handoff-aborted / unknown） | sha512 校验通过 → **完整可留**（cache-hit 重试可用）；sha512/size 失配 → **部分/损坏必清** |
| 当前代 installer 且 `preserve=false`（verified / failed：代已收口，不再服务重试） | 删 |
| 非当前代 lineage 的其它文件 | 超过 `minKeepAgeMs`（1h 新鲜保护窗）→ 删；新鲜 → 留 |
| `update-info.json` | preserve=true → 留（保 cache-hit 重试）；否则按新鲜窗/过期规则处理 |
| unlink 失败（Windows 被占用 EPERM/EBUSY/EACCES 等） | **跳过留待下次**（`.bak` 延迟回收语义；POSIX 语义下 open 文件 unlink 本就成功，同一代码路径天然覆盖两平台差异，无平台分支） |

- 目录不存在（ENOENT）→ 空清扫；readdir 失败 → 空清扫留痕。
- 全部 IO 走 fs.promises；摘要 info（removed/kept/skipped 计数与名单，路径
  只记 basename）。

## R6 前向兼容契约（omp omp.dist 教训）

- journal 解析：entry 未知字段一律忽略不报错；`outcome` / `exitSweepHandoff`
  出现未知枚举值 → 归一为 `unknown`，决策按保守路径（R3：unknown 不行动；
  R5：unknown 按 preserve=true 保留有效包，清理交给年龄窗兜底）；entry 缺
  闭集必填字段 → 整条丢弃 + warn；JSON 解析失败 / entries 结构缺失 → null
  journal（无账本路径），**永不抛出阻断**。
- pending 元数据：本机制不解析 electron-updater 的 update-info.json（避免
  把第三方内部格式变成前向兼容负担），只依赖自有账本 + 实测 stat/sha512。
- 顶层 `version` 大于当前 schema 版本：仍按宽松规则尝试读 entries（字段
  闭集读不到就丢弃对应条目），不因未来版本号整体拒绝。

## 验收场景（对应 tests/updater-journal-recovery.test.mjs）

1. journal 原子写：temp+rename 落盘可读；rename 失败退化直写仍可读；代数
   截断（>8 代裁最旧）。
2. 幂等：markOutcome 二次调用 no-op；appendHandoff 收口悬案 handed-off。
3. 交接账本（autoUpdater 集成）：update-downloaded → QuitAndInstall →
   账本含 {from,to,sha512,exitSweepHandoff:"completed"}；onBeforeQuitAndInstall
   抛错 → outcome=handoff-aborted + 既有失败路径不变。
4. 事故指纹恢复：handed-off + 版本没变 + pending 完整 → warn + ready 重试
   入口 + outcome=install-not-effective + 完整包保留；pending 损坏 → idle +
   伪 ready/持久化说明清理。
5. 启动验证双路径：版本推进 + 探针通过 → verified；探针失败 → failed +
   error。
6. 清扫：完整保留 / 损坏清除 / 占用跳过（unlink EPERM）/ 新鲜保护窗 /
   7 天无条件过期 / preserve=false 收口清除 / 目录缺失空清扫。
7. 前向兼容：未知字段/未知枚举/畸形 JSON/缺字段条目全部不阻断且按 R6 决策。
8. 既有 R19 豁免单测（process-containment.test.mjs）与 desktop 全量套件不回归。
