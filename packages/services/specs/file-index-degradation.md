# 文件索引降级栈（git 主源 + 冷却表 + 成本比例 TTL）

机制来源：Claude Desktop 2.37337 `main/file-index-worker/fileIndexWorker.js`
`:38177-38246`（ls-files 流式采集 + 超大仓冷却 + 警告文案）、`:38248-38298`
（成本比例 TTL 缓存 + singleflight + 权重 LRU）、`:38641-38661`（清单组装与换行
过滤）。ACode 对照落点：`packages/services/src/file/fileService.ts` 的
`ensureWorkspaceFileIndex()`（全量扫描 + 60s 固定 TTL + `.acodeignore` 指纹 +
singleflight + 4 条缓存）与新文件 `workspaceGitFileListing.ts`。

## 背景

workspace 文件清单（@ 文件候选、Command Center、renderer 分块清单）目前唯一来源是
Host 全量目录扫描：37 万文件实测数秒。git 仓库的 tracked+untracked 清单
（`git ls-files`）通常快一个数量级，可作主源；但超大仓/慢盘上 ls-files 本身可能
超时或产出巨量输出，必须有明确的降级栈而不是静默变慢。同时 60s 固定 TTL 对
"清单 20ms 就能重建"的小仓是白白吃陈旧数据，对"扫一次 3s"的大仓又太短——TTL 应
与重建成本成比例。

## 产品规则

### R1 降级栈（唯一决策顺序）

```
ensureWorkspaceFileIndex(rootPath, identity?, refresh?)
  ├─ singleflight / 指纹校验 / 缓存命中判断（既有语义保留）
  └─ 构建（单一写入路径）:
      1) git 主源: git ls-files --cached --others --exclude-standard -z
         （cwd=rootPath，硬化 env，流式采集，R2 限额）
         ├─ listing        → 按 R5 组装 entries
         ├─ oversized      → 记入冷却表（R3）+ 一次性警告 → 落到 2)
         ├─ cooling-down   → 直接落到 2)（不再 spawn，不重复警告）
         ├─ not-a-repository / git-unavailable → 静默落到 2)（现状不变）
         └─ failed         → 一次性警告 → 落到 2)
      2) 既有全量并发扫描（原逻辑原样保留）
      → 排序（目录优先 + localeCompare，两源共用）→ pack → R4 缓存决策
```

git 不可用、非 git 目录：**静默**走现有扫描路径，无警告无行为差异（现有行为不变）。

### R2 git 主源采集限额（超限即中止）

- 命令：`git -c core.quotepath=false ls-files --cached --others --exclude-standard -z`，
  cwd=rootPath（workspace 是仓库子目录时 ls-files 天然按 prefix 输出相对 cwd 路径，
  与清单的 rootPath 相对语义一致）。`--recurse-submodules` 与 `--others` 互斥
  （git 实测 "unsupported mode"），故不递归子模块：gitlink 以路径条目出现，
  子模块内部文件不进清单（登记为与全量扫描的已知差异；把子模块作为 workspace
  打开不受影响）。
- 软超时 10s（SIGTERM）→ 硬超时 15s（SIGKILL + 销毁 stdio 兜底）；
- 输出总量 64MB（stdout+stderr 计），超限即杀；
- 单条记录（NUL 分隔）64KB，超限即杀；
- 二进制解析复用 `gitEnvironmentProvider`（ACODE_GIT_BINARY 覆盖、Windows 候选链、
  `--version` 探测缓存），env 走 `getGitCommandEnv()` 硬化漏斗
  （`git-invocation-hardening.md`）。
- 结果语义：exit 0 → 清单；stderr 含 "not a git repository" → not-a-repository；
  其余非零/异常 → failed（警告一次，含 stderr 摘要，截断 400 字符）。

### R3 超大仓冷却表

- 任一限额触发（超时/输出/单记录）→ key=`${gitBinary}\0${rootPath}` 写入冷却表，
  10 分钟内该 key 不再尝试 git 主源（直接降级扫描，不 spawn）；
- 容量 64 条，LRU（Map 插入序 + 命中不续期，满员逐最旧）；
- 冷却表是**负缓存**（只存"别再试"标记与时间戳，不存清单内容），与 R4 的清单
  缓存不构成双缓存并存；
- 冷却表、警告去重集合归 fileService 实例所有（与既有"索引归服务实例"一致，
  不同 Host/注入过滤器不共享）。

### R4 成本比例 TTL（替换 60s 固定 TTL）

构建完成时计时 `elapsedMs`（从开始构建到 pack 完成，含 git 采集或全量扫描）：

- **仅当** `elapsedMs ≥ 250` **且** 清单条目数 `≥ 50_000` 才写入缓存；
- `TTL = clamp(elapsedMs × 20, 30s, 120s)`，随条目存 `reuseMs`，过期判定
  `now - at ≥ reuseMs`（替代全局 60s 常量）；
- 不满足门槛 → **不缓存**（并删除该 key 旧条目），下次请求重建。小仓重建成本
  低于陈旧收益，这是有意取舍；
- 既有语义全部保留并融合进同一条写入路径：`.acodeignore` mtime/size 指纹失配即
  重建、singleflight（同 key 并发等待同一构建、refresh 期间不命中旧缓存）、
  缓存 4 条上限逐最旧、显式 refresh 旁路缓存、构建结果只在"仍是当前在途构建"时
  落缓存（旧构建不覆盖新索引）。**禁止**在 git 采集层另设清单缓存。

### R5 git 清单 → entries 组装（与扫描语义对齐）

- 逐路径过 `.acodeignore` 规则（`isWorkspaceFileSearchPathIgnored`）与注入过滤器
  （`workspaceFileSearchFilter.evaluate`，`ignoreRulesActive: true`）；
- 目录条目由文件路径祖先合成：祖先被规则 ignore 或 filter 判 `traverse=false` →
  整枝剪掉（与扫描"不进被忽略目录"一致）；`include=false, traverse=true`（隐藏
  目录）→ 目录条目不进清单但子文件保留（与扫描一致）；
- 根级 `.acodeignore` 自身剔除（与扫描一致）；
- **换行注入过滤**：路径含 `\n` 或 `\r` 的记录剔除并计数，计数 > 0 时一次性警告
  （防止病态文件名注入任何按行拼接的下游清单；packed 编解码虽已转义 \t\n\\，
  此为纵深防御）。

### R6 语义边界（git 主源 vs 全量扫描，spec 写清）

- **`.gitignore` 忽略的文件不再进清单**（`--exclude-standard`），全量扫描路径则
  只看 `.acodeignore`。默认 `.acodeignore` 从仓库 `.gitignore` 拷贝初始化，两源
  在默认配置下高度一致；用户在 `.acodeignore` 里显式放行某条 `.gitignore` 规则
  （`!` 反选）时，git 主源仍不含该文件——放行语义以扫描路径为准，git 主源是
  性能优先的近似。用户全局 gitignore 两源都不吃（R6 of git-invocation-hardening）。
- **已删除但未 stage 的 tracked 文件**会出现在 git 主源清单（索引为事实源），
  扫描路径不会出现。接受：条目自愈（提交删除后消失），不做逐文件 stat。
- untracked 文件两源都含；git 主源不含未跟踪的**空目录**（git 不跟踪目录）与
  被 .gitignore 盖住的目录——扫描路径含（若过滤器放行）。

### R7 用户可见警告（服务日志，文案自撰）

无 toast 通道（清单 RPC 返回裸 string，shared 协议不动），警告走
`createServiceLogger("workspace-file-index").warn`，每 workspace 每原因一次：

- 超限降级：`Git 文件清单超限中止（原因：超时/输出超限/单条路径超限；已采集 N 条）。
  该 workspace 改用目录扫描构建索引（构建更慢，结果完整）；约 10 分钟后自动重试
  Git 清单。`
- git 失败降级：`git ls-files 失败（exit=N），改用目录扫描构建索引：<stderr 摘要>`
- 换行剔除：`Git 清单中 N 条路径含换行/回车字符，已剔除（防清单注入）；这些文件
  不会出现在文件搜索结果中。`

## 登记不做

- **渐进索引 typed-array 位并行模糊匹配器**（证据 `:25206+`，256 条/4ms 时间片、
  代数取消、构建中途可查）：本项登记不做。ACode 现有
  `searchHostFileCandidates` 分批 top-K 已让出事件循环，收益面不同，另立项评估。
- 清单 sha1 版本协商（证据 `:38655-38661`，客户端已知版本回 null）：不动 shared
  协议，不做。
- rg 预算箱 / patternRefused / git grep 兜底：属内容搜索面，非本项（清单）范围。

## 接口

- 新文件 `packages/services/src/file/workspaceGitFileListing.ts`（采集与冷却）：
  - `createWorkspaceGitFileListingSource(options?) → WorkspaceGitFileListingSource`
    （`collect(rootPath)`；options 注入 limits/logger/now/environmentProvider 供测试）；
  - 限额常量 `WORKSPACE_GIT_LISTING_LIMITS` 与 outcome 闭集类型。
- 新文件 `packages/services/src/file/workspaceGitListingEntries.ts`（纯函数层）：
  - `buildWorkspaceFileEntriesFromGitListing(paths, context)`（R5 组装）；
  - `filterGitListingNewlinePaths(records)`（R5 换行注入过滤）；
  - `computeWorkspaceFileIndexReuseMs(elapsedMs, entryCount)`（R4）与 TTL 常量。
- `fileService.ts`：`CreateFileServiceOptions` 增可选 `gitFileListing`（缺省创建真实
  source；`node.ts` 接线零改动）；`WorkspaceFileIndex` 增 `reuseMs`；
  `ensureWorkspaceFileIndex` 按 R1 编排。`listWorkspaceFilesLength/Range`、
  `searchWorkspaceFiles` 对外契约不变。

## 验收场景

见 `packages/services/test/workspaceGitFileListing.test.ts`（真实 git 临时 repo
fixture，git 不可用整体 skip；换行文件名子用例创建失败即 skip）与
`packages/services/test/fileServiceIndexCache.test.ts`（注入 fake source，无 git
依赖）：

1. git 主源：tracked + untracked 均在清单；`.gitignore` 忽略文件不在；目录条目合成；
   `.acodeignore` 规则叠加生效（如 dist/ 被 .acodeignore 排除时 git 源也不含）。
2. 换行注入：含 `\n` 路径的文件被剔除且计数（平台不允许创建则 skip）。
3. 非 git 目录 → not-a-repository（静默）；git 二进制缺失 → git-unavailable。
4. 冷却：注入微小限额触发 oversized → 冷却表生效（二次 collect 返回 cooling-down
   且不 spawn）；注入时钟前进 10 分钟 → 恢复尝试。
5. TTL：`computeWorkspaceFileIndexReuseMs` 边界（249ms/250ms、49999/50000、×20、
   clamp 30s/120s、门槛不满足返回 0）。
6. 融合：fake source ≥50k 路径 + ≥250ms 构建 → 第二次请求命中缓存（collect 计 1 次）；
   小清单 → 每次重建（collect 计数递增）；`.acodeignore` 改动 → 指纹失配重建；
   并发请求 singleflight（collect 计 1 次）；refresh=true 旁路缓存；
   oversized/cooling-down → 扫描路径接管（磁盘文件仍可搜到）。
