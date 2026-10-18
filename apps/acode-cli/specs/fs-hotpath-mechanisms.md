# fs 热路径机制五件套（omp 价值提取波 1 · WI-2）

来源：`C:\Users\ZhuanZ\Desktop\zoode\ACode-价值提取-oh-my-pi.md` T1#7；机制语义参照
oh-my-pi (MIT) `crates/pi-walker/src/cache.rs`、`crates/pi-edit/src/fuzzy.rs`、
`docs/natives-shell-pty-process.md`、`docs/fs-scan-cache-architecture.md`、
`crates/pi-builtins/src/rg.rs`。全部 TS 重写吸收，不引 Rust。

## 范围与所有权

- `apps/acode-cli/packages/adapters/src/fs/**`（扫描缓存、gitignore、grep 预算）
- `apps/acode-cli/packages/adapters/src/exec/**`（取消波次、输出背压）
- `apps/acode-cli/packages/core/src/tool/edit-matchers.ts`（模糊匹配层）
- 测试：`apps/acode-cli/tests/fs-*.test.mjs`、`tests/edit-fuzzy-block.test.mjs`、`tests/exec-cancellation-wave.test.mjs`

不改：任何 package.json、contracts（`packages/shared`）、core handlers、registry、i18n。

---

## R1 目录项扫描缓存

**所有者**：`adapters/src/fs/scan-cache.ts` 模块级单例（进程共享，与 omp `static SCAN_CACHE`
一致）。**存目录项（文件路径列表）而非最终工具结果**；glob/grep 的高层过滤、排序、限额
留在调用方。

### 键与分区

- key = `root（绝对路径，win32 下比较统一为大小写折叠 + 反斜杠归一）` + `respectGitignore`。
- 高层过滤（glob 匹配器、headLimit、offset、排序）不进键（同 omp：高层过滤不分区扫描）。

### 容量与过期

| 参数 | 默认 | 环境变量 |
| --- | --- | --- |
| TTL | 1000ms | `FS_SCAN_CACHE_TTL_MS` |
| 条数上限 | 16 | `FS_SCAN_CACHE_MAX_ENTRIES` |
| 字节预算 | 64MiB | `FS_SCAN_CACHE_MAX_BYTES` |
| 空结果重检年龄 | 200ms | `FS_SCAN_EMPTY_RECHECK_MS` |

- 任一上限为 `0` → 完全旁路缓存，每次新鲜扫描，`cacheAgeMs = 0`。
- 字节按内容实际计量：`Σ(path UTF-16 长度 × 2) + 每项固定 64B 对象头开销`。
- 每次 get/insert 顺手清理全部 TTL 过期项；无后台过期线程。
- 插入时按 `createdAt` 最老先淘汰，直到条数与字节双达标；超预算的单次扫描返回但不缓存。

### 并发与失效（generation 语义）

1. miss 时捕获 `generation`；扫描为异步，`insert` 仅当 generation 未变、条目仍新于 TTL、
   同键无更新条目时才写入——**写/删之后的失效会 bump generation，阻止在途扫描回填旧目录
   布局**。
2. `invalidateFsScanCache(path)`：bump generation；删除「root 是 path 祖先（前缀语义）」的
   缓存项，同时顺手丢弃全部 TTL 过期项。
3. `invalidateFsScanCache()`（无参）：等价 `invalidateAll`。
4. 挂钩点：`NodeFileSystemAdapter` 的 `writeTextFile`、`removeFile`、`createDirectory` 成功后
   显式失效目标路径。外部进程（Bash 等）的写不在本钩子覆盖内，由 TTL 与空结果重检兜底。
5. 并发同键去重：miss 后的扫描 promise 按键共享，避免同键重复遍历。

### 空结果重检（empty-result revalidation）

命中缓存且「过滤后结果为空」且 `cacheAgeMs ≥ 200`（阈值为 0 时禁用）→ 重扫一次（旁路缓存）。
重扫结果**不回填、不驱逐**既有缓存项。理由：外部进程新建文件不触发本进程失效钩子，空结果
+ 老快照是「可能漏」的最可疑组合。

### 接入面

`walkFiles`（原 :1709-1731 无缓存逐目录 readdir + 逐文件 stat）重构为：
扫描层产出缓存文件列表（跳过 VCS 目录；respectGitignore 时跳过 gitignore 命中的文件与子树），
过滤层对每个命中调用方 glob/type 过滤的文件才 `stat` 取 mtime。调用方为 `searchFiles`
（glob 工具）与 `collectTextSearchCandidates`（grep JS 兜底）。两者均为空结果重检的观察点。

**验收**：缓存命中返回同列表且 `cacheAgeMs > 0`；TTL 过期后重扫；写入文件后立即失效（不等
TTL）；失效后在途扫描结果被拒之门外；空结果重检触发且不污染缓存；并发同键只扫一次。

---

## R2 gitignore 遍历

**所有者**：`adapters/src/fs/gitignore-matcher.ts`。用 `ignore` npm 包（已在依赖清单）实现
`.gitignore` / `.ignore` 规则语义（negation、目录规则 `dir/`、`**` 通配、锚定 `/` 前缀）。

- walkFiles 默认尊重 gitignore：命中文件不产出，命中目录整子树剪枝。
- VCS 目录（`.git/.svn/.hg/.bzr/.jj/.sl`）维持无条件剪枝（与旧行为一致，git 自身也隐式排除
  `.git`）。`node_modules` 不再硬编码：有 .gitignore 的仓库被自然排除；无 .gitignore 的目录
  由「默认排除 node_modules」的固定规则兜底（与 omp `should_skip_path` 的 mentions_node_modules
  语义对齐——本仓默认 mentions=false）。该兜底可用 no-ignore 逃生口一并关闭。
- 规则集按目录层级构建并缓存（Map<dir, {rules, mtimeMs}>），跨请求复用；以 `.gitignore` /
  `.ignore` 的 mtime 复验，变更即重建。
- 根目录没有仓库标记也生效（沿 root 向上的 `.gitignore` 不上溯——只看 root 及其子目录，
  与旧 rg 行为对齐，见下）。
- **ripgrep 参数面**：rg 默认本就尊重 .gitignore（未传 `--no-ignore`），JS 兜底补齐后两引擎
  语义对齐；`VCS_DIRECTORIES_TO_EXCLUDE` 手工 `--glob` 排除保留（行为等价或更严）。
  新增 `--glob !node_modules` 与 JS 兜底一致。
- **逃生口**：环境变量 `ACODE_FS_NO_IGNORE=1`（或 `true`）→ 全部搜索路径不读 gitignore、
  不做 node_modules 兜底排除，恢复旧行为；适配器构造参数 `respectGitignore: false` 同义
  （供装配与测试）。

**验收**：`.gitignore` 规则排除文件；`!negation` 恢复；`build/` 目录规则剪子树；无
.gitignore 时 node_modules 被兜底排除；`ACODE_FS_NO_IGNORE=1` 恢复包含 node_modules。

---

## R3 编辑模糊匹配契约强化

**所有者**：`core/src/tool/edit-matchers.ts`。在现有 8 策略链（exact → quote_normalized →
line_number_prefix_stripped → escape_normalized → unicode_escape_normalized → line_trimmed →
indentation_flexible → block_anchor@0.8）之后**增量追加**第 9 层 `fuzzy_block`。

### 语义（照抄 omp find_match 阈值分级）

- 仅整块匹配：窗口 = search 行数，逐行 Levenshtein 相似度取平均得 confidence。
- 分级阈值先严后宽：0.95 → 0.92 → 0.8（omp DEFAULT/SEQUENCE/FALLBACK 三档）；每级收集
  全部 ≥ 阈值的候选，高级命中非唯一则看下一级；三级耗尽 → 维持 not_found。
- **唯一候选才替换**：某级恰好 1 个候选 → matched（actualString 取自文件真实文本）。
- **多候选拒绝并回报计数**：>1 候选 → `status: "ambiguous"`、`candidateCount` 为候选数；
  edit handler 现有 `createAmbiguousEditMessage(count, …)` 错误措辞不变（models are trained
  on them）。
- `replaceAll: true` 时跳过本层（与 line_trimmed/indentation_flexible/block_anchor 同列
  BROAD_MATCHERS——宽模糊替换全部出现风险不可控）。
- 现有 8 策略代码路径、返回结构与错误字符串零改动；`normalizeReplacementForMatch` 对
  fuzzy_block 走默认分支（原样返回）；`preserveQuoteStyle` 继续适用。
- 性能护栏：`similarity` 上界剪枝（omp fuzzy_score_at 的 upper_bound 提前退出）+
  大文件行数上限保护（搜索行数 > 内容行数直接无候选）。

**验收**：单处轻微笔误（如空白漂移、单词拼写差 1-2 字符）唯一候选 → 替换；两处同等相似
候选 → ambiguous 且 candidateCount=2；阈值分级：0.9 级拒绝时 0.8 级仍可救；replaceAll 不进
模糊层；既有 edit 匹配测试全绿。

---

## R4 bash 取消语义

**所有者**：`adapters/src/exec/cancellation-wave.ts`（新）+ `node-execution-adapter-process.ts`。

### 取消原因契约（结构化 {cancelled, timedOut}）

| 原因 | StopReason | 结果标记 |
| --- | --- | --- |
| 超时到期（Timeout） | `timeout` | `timedOut=true, cancelled=false` |
| 用户停止 / abort 信号（User/Signal） | `cancelled` | `timedOut=false, cancelled=true` |
| 输出限额（output limit） | `output_limit` | `cancelled=true` + output_limit failure |

契约字段已存在于 `ExecutionResult`，本工作只补齐因果可区分的内部归因，不改对外字段。

### TERM→KILL 波次（替代一次性 taskkill /F）

- **Windows**：wave1 = `taskkill /pid X /T`（不带 /F，优雅关闭尝试）→ 宽限 **5000ms** →
  wave2 = `taskkill /pid X /T /F`。替代现状一次性 `taskkill /T /F`（:160）。
- **POSIX bash**：wave1 = SIGTERM（组 + PPID 快照后代）→ 宽限 **2000ms**（原 1500ms 对齐
  omp）→ wave2 = SIGKILL 组 + 树。
- **POSIX 通用（argv/hook/shell）**：保留既有 `terminateGenericPosixProcessGroup` 的
  SIGTERM→750ms→SIGKILL 双波（能力不扩散，见该函数注释）。
- 波次控制器 per-run 实例化；run 层既有 `FORCE_EXIT_AFTER_KILL_MS`（5s）兜底 timer 与
  pendingBashProcessTreeKills 语义保留。
- 可注入 stub（spawn/kill 函数）供进程树波次单测。

### 输出有界队列（64-chunk）背压 + coalesce

- `adapters/src/exec/output-pump.ts`：per-stream 有界队列，容量 64 chunk；队列将满时新
  chunk **合并（coalesce）进队尾同流条目**（Buffer concat），不丢弃、不阻塞读端。
- flush 以微任务批量派发：每次 flush 至多 1 个 stdout + 1 个 stderr 合成事件，事件形状
  （`{type:"stdout"|"stderr", chunk, text}`）不变。消费方现状：core bash handler 只消费
  `progress` 事件，原始 chunk 事件无 core 内消费方（已 grep 验证），合并安全。
- progress 事件、collector 落盘路径不经 pump，时序不变。

**验收**：注入 stub 下 wave1→宽限→wave2 的信号序列正确；Windows 分支宽限 5s、POSIX bash
2s；队列 64 满时 coalesce 合并且文本无损；run 层取消后结果仍带正确 timedOut/cancelled。

---

## R5 grep 预算细节

**所有者**：`adapters/src/fs/index.ts`（rg 计划 + JS 兜底搜索）。

1. **maxCountPerFile**：默认 250（= DEFAULT_GREP_HEAD_LIMIT，内容模式下被 headLimit 切片
   后结果不变；count 模式的每文件计数与 numMatches 变为封顶值——预算语义，spec 声明）。
   - rg 路径：目录目标加 `--max-count 250`；单文件显式目标不加（omp SINGLE_FILE 语义：显式
     指名的文件给更高预算）。
   - JS 兜底：逐文件计数达上限即停读该文件（防单热文件吃光预算）。
2. **坏 brace pattern 容错**：
   - rg glob 参数：花括号不配对（如 `*.{ts,js`）时转义 `{`/`}` 为字面量后再下发，避免 rg
     exit 2 整次搜索失败。
   - 搜索正则：rg/JS 侧因 pattern 抛 invalid_pattern 且 pattern 含 `{` 时，做一次
     brace 转义重试；仍失败则维持原错误。
3. **超 4MiB 文件只读前缀**：JS 兜底对 `size > 4MiB` 的文件只读前 4MiB 参与匹配（omp
   NATIVE_GREP_MAX_FILE_BYTES 语义）；rg 路径保持全流式读取（rg 本身增量流式无内存风险，
   且无法表达「只读前缀」，强行 --max-filesize 会整文件缺席，两引擎差异更大——记录为已知
   限制）。

**验收**：热文件（>250 命中）在 count 模式返回封顶计数；`*.{ts,js` glob 不再炸整次搜索；
>4MiB 文件在 JS 引擎只搜前缀（构造 5MiB 文件，命中点置于 4MiB 后不被报告、置于前缀内被
报告）；brace 转义重试在 JS 侧可救回 `a{2` 类 pattern。

---

## 事件顺序（取消波次）

```
requestStop(reason) ──► wave controller（per-run 实例）
  ├─ t0    wave1: TERM 等价（win: taskkill /T 无 /F；posix: SIGTERM 组+树）
  ├─ t0+grace（win 5000 / posix-bash 2000） wave2: KILL（taskkill /T /F；SIGKILL 组+树）
  └─ run 层 FORCE_EXIT_AFTER_KILL_MS=5000 兜底：强制结算结果 + 销毁输出流
输出：stdout/stderr chunk ──► 64-chunk 有界队列（满则 coalesce 进队尾）──► 微任务批量 emit
```

## 已知限制

- 外部进程写文件（Bash、git）不触发本进程缓存失效，由 TTL 1000ms + 空结果重检兜底——与
  omp 相同的取舍。
- rg 引擎对 >4MiB 文件仍全文匹配；JS 引擎只搜前 4MiB。引擎差异由 spec 显式声明。
- `--max-count` 使 rg 的 count 模式返回封顶计数；内容模式因 headLimit=250 切片无可见变化。
- 模糊层不处理跨行重排（omp 同样只在行对齐窗口内打分）。
