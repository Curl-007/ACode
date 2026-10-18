# 记忆语义召回三阶段管线 + 会话级召回通道（K1）

方案条目：`docs/k-series-upgrade-plan.md` §K1。机制参照 jcode (MIT)
`crates/jcode-base/src/memory.rs:567-633`（hybrid 检索 BM25+dense → RRF 融合）、
`crates/jcode-embedding`（MiniLM ONNX 本地推理）与 `jcode-base/src/embedding_backend.rs`
（后端可插拔 + 向量空间隔离不变量）、`memory_rerank.rs`（LLM listwise 重排，实测
recall@5 0.53→0.75），自撰 TypeScript 实现，未拷贝任何文件。

本 spec 是第一轮 J3-3（维持评估项）的立项版。做四件事：

1. **建会话级语义召回通道**（J3-2 R5 预留、原 J3-3 的目标形态）：每个 Main turn 开始时，
   以最新用户消息为 query 语义检索项目记忆，选出 top-K 经 J3-2 的
   capture（签名绑定）→ verify（重读验证）→ dedupe（三层去重）→ render（reference 形态）
   注入当前 turn 动态段——**注入协议一个字不改**，全部复用
   `core/src/memory/recall/pending.ts`；
2. **检索管线三阶段递进**：Phase A 纯 BM25（零新依赖）→ Phase B 本地 dense embedding
   （BM25+dense RRF 融合）→ Phase C LLM listwise 重排（默认关，度量先行）；
3. **清偿 J3-2 登记的两条前置债**：F4 单调时钟源（新鲜度闸防墙钟回拨）、F3 filename
   限速层（防微改写绕过去重的注入放大器）；
4. **召回度量账本**（J3-1 覆盖账本模式）：命中/注入/抑制/丢弃分类计数落 JSONL，
   为 Phase C 开关决策供数。

裁剪边界：**不改** J3-2 的 R1-R4/R6-R10（绑定/签名/重验证/整体丢弃/渲染防注入/所有权）；
**不动** Extraction 通道（清单仍全量注入，查重语义不变）；**不引入** LLM 记忆改写、
跨项目全局记忆合并、记忆图演化（supersede 边，登记为可选 Phase D）；
**不做**外部 embedding API 默认路径（OpenAiEmbeddingBackend 式后端只留接口位，默认本地）。

---

## 背景：已核实的现状

> 行号以 dev/0.0.2 `7798f76` 检出为准；`memory/recall/pending.ts` 全部导出面已核对
> （`pending.ts:42-176`：`MemoryRecallInjector` / `resolveMemoryIdentityKey` /
> `createMemoryRecallInjector` / 各 result 联合）。

1. **注入协议已在、检索缺位**：J3-2 落地的 `createMemoryRecallInjector` 的 `capture()`
   是「列目录 → frontmatter 解析 → mtime 倒序 → `MANIFEST_FILE_LIMIT=200` 上限」——
   **没有任何相关性排序**。全量 200 条直接渲染成清单（Extraction 通道），或走 `inject()`
   整包注入。「选哪几条值得进这个 turn」这个决策今天不存在。
2. **会话级通道不存在**：`inject()` 的 R5 三层去重账本按「注入通道实例」设计（J3-2 R5：
   会话级通道落地时账本必须挂 runtime 字段，不得模块级全局）——今天没有任何调用方
   以会话级形态调用它。
3. **零向量/embedding 依赖**：`core/src/memory/` 与全仓 package.json 对
   `onnxruntime|transformers|embedding` 零命中（已核实）。新依赖只在 Phase B 引入。
4. **存储形态**：一条事实一个 markdown 文件 + frontmatter（name/description/type/
   metadata），项目级根 `getACodeDataRootDir()/cli/memories/projects/<key>`（services
   `memoryService.ts` 与 CLI `memory/project-root.ts` 双入口同构）；`MEMORY.md` 是索引
   不算记忆条目（J3-2 R10 保留语义）。
5. **注入点候选面**：主对话的 memory context section（`context/sections/memory.ts`）是
   **冻结快照**（会话内一次载入，属 provider 前缀缓存，J3-2 通道 B 明确保留冻结语义，
   本项不改它）；动态段载体是 reminders 体系（`runtime/helpers/runtime-reminders.ts`，
   既有「记忆召回提醒」在场性判据在 `:226-238`、`:284-292`）。**语义召回注入必须走动态段**，
   每-turn 变化的内容进前缀段会击穿 prompt cache（现状证据：`context-refresh.ts` 的
   前缀重建只重放冻结索引）。
6. **时钟源**：`pending.ts` 的 `now?: () => number` 已是注入参数（默认 `Date.now()`），
   J3-2 R3 已登记回拨 fail-open 债（F4）。
7. **jcode 参照要点**（只读提炼）：
   - 混合检索 `find_similar_hybrid_scoped`：dense（仅同 `embedding_model` 条目余弦）+
     sparse（BM25）→ RRF 融合，`k=60`、候选池 `5×limit`；**无硬余弦阈值**——其 benchmark
     显示阈值会清零召回（长尾相关条目被剪掉）；
   - 向量空间不变量：**一向量空间一索引**，`embedding_model` 标签不同的条目绝不互比
     余弦（换模型 = 换索引，旧向量不迁移只重算）；跨空间条目仍可经 BM25 命中；
   - listwise 重排：focused query + 全候选**一次**调用输出排序，不用 cross-encoder
     本地模型（域外掉点弃用）；
   - embedding 惰性下载（首次用时拉 model.onnx + tokenizer.json 到数据目录）、
     进程级单例 + LRU 缓存 + 空闲卸载。

## 产品规则

### R1 检索管线形态与阶段门

```
query（最新用户消息文本）
  ├─ Phase A：BM25（永远在，是降级底线）
  ├─ Phase B：dense 向量（sidecar 索引可用时启用）→ 与 A 做 RRF 融合
  └─ Phase C：LLM listwise 重排（feature flag，默认关）→ 重排 Phase B 融合结果
  → top-K 候选（K=RECALL_TOP_K=8）
  → 交给 J3-2 injector：capture（绑定+签名，只对这 K 条）→ verify → dedupe → render
```

- **阶段独立验收**：Phase A 上线即交付「比 mtime 排序好」的基线；Phase B/C 各自独立
  开关（`config.memory.retrieval`），关掉任一阶段不改变注入协议行为；
- **检索层降级是 fail-open，注入层维持 fail-closed**：embedding 后端不可用（模型未下载/
  wasm 加载失败/sidecar 损坏）→ 退 Phase A 纯 BM25 + warn 一次（同类不刷屏）；但选中
  条目进入注入后仍全量走 J3-2 R3/R4 重验证——**检索可以降级，注入永不放松**。

### R2 分词（中文一等公民）

ACode 用户记忆中文占比高，BM25 与 query 解析共用一个分词器（`retrieval/tokenize.ts`，
零依赖）：

- 拉丁词：连续 `[A-Za-z0-9_'-]` 切词，小写归一；
- CJK：相邻 CJK 码位切 **bigram**（「凭据主密钥」→ 凭据/据主/主密/密钥——单字信噪比低，
  jcode 英文 tokenizer 无此问题，ACode 必须自做）；
- 过滤：长度 1 的非 CJK 单字符 token 丢弃；数字 token 保留（版本号/错误码是记忆里的
  强信号）；
- frontmatter `name`/`description`/`type`/tags（若存在）与正文共同进文档表示，
  `description` 权重 ×2（它就是给检索写的一句话摘要）。

### R3 Phase A · BM25

- 索引：内存构建（文档数 ≤200/项目，`MANIFEST_FILE_LIMIT` 同源上限，无需落盘索引文件）；
  每个 turn 检索时从 capture 的快照条目现算（200 文档 × 千级 token 的 BM25 打分
  <5ms，实测口径写入验收）；
- 参数：`k1=1.2`、`b=0.75`（业界缺省，不调参——没有标注集之前调参是过拟合噪声）；
- 文档长度归一用 token 数（R2 分词器计数）。

### R4 Phase B · dense embedding + RRF 融合

- **模型**：`sentence-transformers/all-MiniLM-L6-v2` 的 ONNX int8 量化版（384 维），
  **wasm 后端**（transformers.js / onnxruntime-web 线路），**明确不用原生模块**
  （onnxruntime-node 的 Electron ABI 重编译是发布链负担，J5 的 .jsc 教训同源：
  原生绑定严格随宿主版本）；
- **惰性下载**：首次启用时下载模型权重到 `getACodeDataRootDir()/models/minilm-l6-v2-int8/`
  （带 sha256 校验与大小上限），下载失败 → Phase B 关闭（fail-open，R1）；
- **sidecar 索引**：`<memoryRoot>/memory/.recall-index.json`
  `{ version, model, entries: [{ file, contentHash, vector: number[] }] }`：
  - `contentHash` 与 J3-2 R2 签名同源同算法（sha256 全文）——索引条目失效判定直接复用；
  - **不变量「一向量空间一索引」**：`model` 字段与运行后端 `modelId` 不全等 → 整个
    sidecar 判过期，后台重算（期间 Phase B 关闭，不阻塞注入）；绝不混空间比较；
  - 写时机：记忆写入/改写路径（Extraction 子代理的 Write/Edit 落 memoryRoot 后）与
    检索时的 backfill（发现无向量条目 → 补算，单次检索补算上限 20 条防长尾卡顿）；
  - 损坏（JSON 解析失败/shape 不符）→ 删除重建 + warn。
- **RRF 融合**：`score(d) = Σ_s 1/(k + rank_s(d))`，`k=60`、候选池 `5×limit`
  （jcode 同参）；**无硬余弦阈值**（jcode benchmark 教训，进注释）。

### R5 Phase C · LLM listwise 重排（默认关）

- 触发条件（全部满足）：feature flag 开 && 融合后候选 ≥8 && top1 与 top8 分差 <
  0.5（分数接近才值得花一次模型调用）；
- 一次调用：focused query + 候选（content/description/tags，**不含文件路径**——防
  路径泄漏进第三方推理面）→ 输出排序后的 id 列表；失败/超时（10s）→ 用融合序（降级
  不 fail）；
- prompt 中候选是**不可信数据**（J3-2 R6 同款声明段）；重排结果不落盘。
- **度量先行**：默认关。开启决策依据 R8 账本数据（见验收）。

### R6 会话级注入通道（接线）

- **query 采集**：turn-loop 主 turn 开始处（用户消息落定后、模型请求前），取最新用户
  消息文本（剥离图片/工具附件，纯文本投影；空 query 跳过本轮检索）；
- **通道实例**：runtime 字段持有 `MemoryRecallInjector` 的会话级实例 + R5 去重账本
  （J3-2 R5 的既有要求：挂 runtime、非模块级全局）；
- **注入形态**：`presentation: "reference"`（J3-2 R6：`memory_N` 指代，不渲染路径/
  name；不可信声明段照带）；载体是 **reminder 动态段**（`runtime-reminders.ts` 体系
  新增一种 reminder kind），不进 context section / 前缀缓存段（背景 §5）；
- **静默期**：会话首轮（无既有上下文）不检索——第一条用户消息就是任务书，检索噪声
  大于收益；从第二轮起启用。

### R7 前置债清偿（J3-2 F3/F4）

- **F4 单调时钟**：`pending.ts` 的 `now` 缺省实现换 `performance.now()` 派发（单调），
  并在 verify 增加 `capturedAtMs > now + ε` 异常检测（检出即 `stale-snapshot` 拒绝）。
  安全性论证：J3-2 R7 规定快照是进程内局部值（单次消费），单调钟不跨进程比较，
  `PENDING_FRESHNESS_MS=120s` 窗口天然进程内；`mtimeMs` 仍墙钟（签名比对同源自洽，
  不受影响）；账本 TTL（R5 去重）同步换单调钟；
- **F3 filename 限速层**：R5 去重新增**层 4**——同一 `filename`（不含 hash）距上次成功
  注入 < `FILENAME_MIN_INTERVAL_MS = 10 * 60_000` → 该条目剔除出本轮候选（条目级，
  不是整包抑制；剩余候选照常走）。微改写循环（+1 空格换 contentHash 绕 TTL）在此层
  被压到每 10 分钟最多注入一次，放大器拆除。判定顺序放层 3（entry-ttl）之后。
  **实施口径修正（2026-10-04 实现期钉住）**：剔除条件是 filename 相同**且内容已变**
  （`contentHash` 与该 filename 上次成功注入时不同）——只拦 F3 登记的「微改写换 hash」
  穿透形态；未改写条目不受层 4 影响（仍由层 3 TTL 管）。若按本条字面（仅 filename 同）
  剔除，J3-2 既有语义「未改写条目的部分集合注入」（B3 类场景：45min TTL 到期后部分
  老条目重新浮现）会被 10 分钟限速误杀——那正是设计想要的浮现，不是放大器。

### R8 度量账本

`getACodeDataRootDir()/cli/memories/metrics/recall.jsonl`（追加写、按天滚动、
`content` 字段绝不落盘——只有 id/hash/分类计数）：

| 事件 | 字段 |
| --- | --- |
| `retrieval` | `phaseMask`（A/B/C 组合）、`candidateCount`、`topK`、`durationMs` |
| `injected` | `entryCount`、`queryHash`（sha256 前 16 位） |
| `suppressed` | `reason`（J3-2 三层 + R7 层 4） |
| `discarded` | `reason`（J3-2 R4 枚举原样透传） |
| `embedding` | `model`、`backfilled`、`rebuilt`、`errorKind` |

### R9 状态所有权

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| 记忆文件 + frontmatter | 文件系统（memoryRoot） | 持久（不变） |
| 检索管线实例（BM25 内存索引 + embedding 后端单例） | runtime 级（会话） | 会话 |
| embedding 后端进程单例 | 模块级 `OnceLock` 等价（ESM 顶层 lazy）——**只缓存模型句柄不缓存业务状态** | 进程 |
| sidecar 向量索引 | 文件系统（memoryRoot 下）+ `contentHash` 绑定 | 持久，随模型空间整体失效 |
| 去重账本（含层 4 限速） | runtime 字段（R6 通道实例） | 会话 |
| 度量账本 | 磁盘 JSONL（追加） | 持久 |

不变量：检索层只读记忆文件与 sidecar，写只发生在 sidecar backfill/重建；快照与选中
条目在进入 injector 前是**不可变纯数据**（J3-2 R7 同款）；禁止检索层直接渲染注入文本
（渲染只经 `inject()`，防绕过重验证）。

## 常量（集中 `memory/recall/retrieval/constants.ts` + `pending.ts` 追加，改这里即改协议）

| 常量 | 值 | 出处 |
| --- | --- | --- |
| `RECALL_TOP_K` | `8` | R1 |
| `RECALL_FIRST_TURN_SKIP` | `true` | R6 静默期 |
| `BM25_K1` / `BM25_B` | `1.2` / `0.75` | R3 |
| `RRF_K` / `RRF_POOL_MULTIPLIER` | `60` / `5` | R4（jcode 同参） |
| `EMBEDDING_MODEL_ID` | `minilm-l6-v2-int8-384` | R4（自定义短 id，非 HF 全名——空间标签要稳定） |
| `EMBEDDING_DIM` | `384` | R4 |
| `SIDECAR_BACKFILL_LIMIT_PER_RETRIEVAL` | `20` | R4 |
| `RERANK_MIN_CANDIDATES` / `RERANK_SCORE_SPREAD` / `RERANK_TIMEOUT_MS` | `8` / `0.5` / `10_000` | R5 |
| `FILENAME_MIN_INTERVAL_MS` | `10 * 60_000` | R7 层 4 |
| `DECAY_SCORE_FLOOR` | `0.7` | R10（omp `0.7 + 0.3 * decay` 同款） |
| `WEIBULL_PARAMS` | 见 R10 表 | R10（omp 21 档 → ACode 四类映射） |
| `VERACITY_WEIGHTS` | `user_stated 1.1 / tool_observed 1.05 / extracted 1.0 / unknown 1.0` | R11 |
| `MEMORY_IMPORTANCE_DEFAULT` | `0.5` | R13（omp remember 缺省同值） |
| （沿用 J3-2）`PENDING_FRESHNESS_MS` 等 | 不变 | J3-2 常量表 |

## 接口

```ts
// core/src/memory/recall/retrieval/index.ts（新）
export interface MemoryRetrievalCandidate {
  entry: MemoryRecallEntry;      // J3-2 类型复用
  fusedScore: number;
  bm25Rank?: number; denseRank?: number;
}
export interface MemoryRetrievalResult {
  status: "ok"; candidates: MemoryRetrievalCandidate[];
  phaseMask: "A" | "AB" | "ABC"; degradedReasons: string[];   // R1 降级记录
}
export interface EmbeddingBackend {
  modelId: string; dim: number;
  embed(texts: readonly string[]): Promise<number[][]>;       // 失败抛，由管线捕获降级
}
export function createLocalWasmEmbeddingBackend(deps): Promise<EmbeddingBackend | null>; // null=不可用
export function createMemoryRetrievalPipeline(deps: {
  injector: MemoryRecallInjector;        // J3-2，capture/verify 复用
  embedding?: EmbeddingBackend;          // 缺省 undefined → Phase A only
  reranker?: ListwiseReranker;           // 缺省 undefined → Phase C off
  logger: Logger; now?: () => number;
}): MemoryRetrievalPipeline;

// core/src/runtime（接线）：runtime 持有 pipeline + 会话级账本；
// turn-loop 采集 query → pipeline.retrieve → injector.inject（dedupe 四层）
// → reminder 动态段渲染（reference 形态）。
```

`memory/recall/pending.ts` 修改点（最小）：`now` 缺省换单调钟 + `capturedAtMs > now` 检测
（R7）；去重账本结构加层 4（filename → lastInjectedAt）。`renderMemoryRecallBlock` 仍不导出。

## 验收场景

测试：`apps/acode-cli/tests/memory-semantic-recall.test.mjs`（`node --import tsx --test`）。

**分词与 BM25（R2/R3）**：
1. 中文 bigram：query「凭据 401」命中含「主密钥分叉致凭据 401」的记忆且排位高于无关条目；
   纯英文 query 同样可达（拉丁词路径）；
2. `description` 加权：两条正文同等命中时，description 含 query 词者排前；
3. 200 文档 BM25 打分耗时实测记录进测试注释（断言 < 50ms，防性能回归）。

**融合与隔离（R4）**：
4. RRF 融合：构造 dense 序与 BM25 序部分交叉的候选 → 融合序正确（公式手算对照）；
   无 dense 后端时 `phaseMask="A"` 且结果 = BM25 序；
5. **空间隔离**：sidecar `model` 与后端 `modelId` 不等 → 判过期、Phase B 关、触发重建
   标记，**绝不出现跨空间余弦比较**（源码断言：embed 比较处有 model 全等守卫）；
6. sidecar 损坏/shape 不符 → 删除重建 + warn + 本轮 Phase A 降级；
7. backfill 上限：21 条无向量 → 单次检索只补 20，下轮继续。

**降级链（R1）**：8. embedding 后端抛错 → 本轮 `phaseMask="A"` + `degradedReasons` 记录 +
   warn 一次（同因不重复 warn）；注入协议行为与无 Phase B 时逐字节一致。

**重排（R5）**：9. flag 关 → 零模型调用；flag 开 + 候选 8 + 分差 0.3 → 一次 listwise 调用
   且重排生效；reranker 超时 → 用融合序（降级不 fail）；prompt 含不可信声明段。

**会话级通道（R6）**：
10. 首轮不检索（零候选、零注入）；第二轮起 query 采集为纯文本投影（图片/附件剥离）；
11. 注入文本 `memory_N` reference 形态、无路径无 name、含不可信声明（J3-2 R6 验收同款）；
12. 注入落在 reminder 动态段——**context section 快照字节不变**（前缀缓存不受影响，
    快照测试钉住）；
13. 会话内去重四层全可达：J3-2 场景 9-11 原样重放 + **层 4**：同 filename 微改写
    （+1 空格换 hash）10 分钟内二次注入 → 该条被剔除、其余条目照常（F3 放大器拆除）。

**时钟债（R7/F4）**：14. 墙钟回拨（`Date.now` 桩拨回 1h）→ 新鲜度判定不受影响（单调钟）；
    `capturedAtMs > now` 异常 → `stale-snapshot` 拒绝。

**协议不变（红线）**：15. J3-2 全部 21 个既有验收场景重跑全绿（注入协议零回归）；
    Extraction 通道行为不变（`dedupe:false`、全清单、target 形态）。

**度量（R8）**：16. 各事件分类计数落 JSONL；`content`/`description` 全文不出现（源码断言）。

## 写侧生命周期三件套（Phase D 首批落地，R10-R13）

> 机制移植自 oh-my-pi (MIT) packages/mnemopi —— `core/weibull.ts`（按类型 Weibull
> 衰减）、`core/beam/recall.ts:459`（superseded/valid_until 可见性过滤）、
> `core/beam/recall.ts:746-753`（veracity 乘权）、`core/beam/store.ts:449-495`
> （重复内容合并 UPDATE），Copyright (c) 2025 Mario Zechner & Stencil Labs。
> 自撰 TypeScript 实现，移植文件头逐条注明。Phase D 相应登记项（未做 §1）就此清偿。

### R10 Weibull 时间衰减

- **公式**（与 omp weibull.ts 同式）：`decay = exp(-((ageHours / eta) ** k))`，
  `ageHours <= 0`（未来 mtime / 时钟偏差）→ `decay = 1.0`；`eta <= 0` → `0`。
- **按类型参数表**（omp 21 档映射到 ACode 四类，参数是**可调常量**，改 `memory/decay.ts`
  即改协议）。选型理由：取 omp 参数表中语义最近的档位——
  user 画像/偏好长期稳定（preference 档），feedback 是工作方式指引、半衰约 3 周
  （instruction 档），project 约束中等寿命（project 档），reference 外部资源中等偏长
  （artifact 档）；type 缺失/未知走 omp `general` 档兜底。

| ACode type | k（shape） | eta（scale，小时） | omp 来源档 |
| --- | --- | --- | --- |
| `user` | 0.4 | 4380 | preference |
| `feedback` | 0.9 | 480 | instruction |
| `project` | 0.85 | 1080 | project |
| `reference` | 0.75 | 2160 | artifact |
| （缺失/未知） | 1.0 | 168 | general（omp `DEFAULT_HALFLIFE_HOURS` 同值） |

- **时间戳源 = 文件 mtime**（**spec 决策：不新增 created/updated frontmatter 字段**）。
  理由：mtime 由文件系统单一所有者维护，写入/合并即刷新，语义是「最后确认时间」，
  与 omp `remember()` 合并时 `timestamp = now` 同构；frontmatter 日期由模型手写，与
  mtime 是两条必然漂移的时间线（多一份可漂移状态违反单一所有者原则）。存量文件无需
  迁移——无日期字段天然回退 mtime。
- **应用位置**：RRF 融合**之后**、rerank/top-K 之前，`score *= (0.7 + 0.3 * decay)`
  （omp recall.ts 同款下限混合）。0.7 下限保证完全陈旧的条目不会被清零（长尾相关仍可
  经强 BM25 命中上浮，与 R4「无硬阈值」同一立场），只压排序位次。
- 防陈旧记忆长期霸榜：衰减只作用于排序权重，不删除、不改写任何文件（检索层只读，R9）。

### R11 veracity 分级加权

- **四档**（可调常量 `VERACITY_WEIGHTS`，`memory/veracity.ts`）：

| 档位 | 语义 | 权重 |
| --- | --- | --- |
| `user_stated` | 用户显式要求记住的内容 | 1.1 |
| `tool_observed` | 工具实跑输出直接印证的事实 | 1.05 |
| `extracted` | 子代理从对话归纳/推断（Extraction 产出缺省） | 1.0 |
| `unknown` | 字段缺失/无法解析（**中性**，存量兼容） | 1.0 |

- 与 omp `VERACITY_WEIGHT_DEFAULTS`（stated 1.0 / inferred 0.7 / tool 0.5 /
  imported 0.6 / unknown 0.8）的偏差及理由：任务口径钉住「存量无该字段按 unknown
  **中性**权重」→ unknown = 1.0 为基线；extracted 同为 1.0（新产出不因打标降权，
  否则所有新记忆都排在存量之后）。omp 把 tool 排最低反映其 working_memory 语境
  （工具输出噪声大）；ACode 的 `tool_observed` 语义是「实跑输出印证的事实」，比推断硬，
  排在 extracted 之上。非未知档只上浮不下压，回归风险单侧化。
- **写侧打标**：Extraction prompt（`memory/extraction.ts`）指引模型在 frontmatter 写
  `veracity`——用户显式要求记住 → `user_stated`；引用工具实跑输出 → `tool_observed`；
  归纳/推断 → `extracted`。机械兜底：Extraction 循环内 Write/Edit 落盘后，frontmatter
  缺 `veracity` 字段时由 `enforceMemoryWriteLifecycle` 补写缺省 `extracted`（R13 通道）；
  模型已写的值（含显式 `unknown`）不被覆盖。主对话显式记忆写入不在该循环内（prompt 面，
  本波不改 context section），缺字段 → unknown 中性，向后兼容。
- **应用位置**：与 R10 同一处，`score *= veracityWeight`（omp recall.ts:746-753 语义：
  `row.veracity || "unknown"` 回退 + 查表乘权）。解析失败的档位字符串按 `unknown`。

### R12 机械失效（superseded-by / valid-until）

- frontmatter 新增两个可选字段（kebab-case，顶层或 `metadata:` 嵌套均认）：
  - `superseded-by: <name|filename>`——该记忆已被指定更新者取代，检索层**不再可见**；
  - `valid-until: <ISO-8601>`——有效期，`validUntil <= now` 视为过期，检索层不再可见
    （omp recall.ts:459 的 WHERE 语义：`valid_until IS NULL OR valid_until > now AND
    superseded_by IS NULL`）。
- **过滤位置**：`readRetrievalDocuments` 装配文档时剔除（进 BM25 之前）——失效条目连
  候选池都不进，不是降权。全部条目失效 → 返回零候选（不是 rejected：存储可读，只是
  没有可见记忆）。
- **写边的人**：Extraction prompt 指引模型「新事实取代旧记忆时，给旧文件加
  `superseded-by: <new-name>` 而不是留两条都活跃」（Phase D §1 的「谁写边」决策：
  Extraction 子代理写，主对话仍可手工维护）。`valid-until` 由模型按事实寿命自行声明。
- **解析失败 fail-open**：`valid-until` 无法解析成时间 → 视为字段不存在（不过滤）。
  过滤是「隐藏内容」的负向动作，坏数据不隐藏内容；`superseded-by` 空串同理不算失效。
- **向后兼容**：存量文件无这两个字段 → 永不过滤，行为不变。
- **边界**：本波只过滤**检索管线**；J3-2 注入协议与 Extraction 通道的全量清单注入不
  改（Extraction 子代理仍能看到失效条目，恰好便于它清理）。检索选中到注入之间的瞬间
  失效窗口（先检索后 supersede）不设防，注入层重验证只比对内容签名，属已知小窗口。

### R13 写入侧机械去重合并

- **触发点**：`runMemoryAgentLoop`（`memory/memory-agent-loop.ts`）在每批模型工具调用
  结束后、下一次模型请求前，对本批**成功落盘**且路径含于 memoryRoot 的 Write/Edit 依序
  执行 `enforceMemoryWriteLifecycle`（`memory/dedupe.ts`）。这是「extraction 子代理产出
  新记忆走机械通道」的唯一写点；去重不再只靠 prompt 提示「先扫 MEMORY.md」。
- **归一化**：正文（frontmatter 剥离后）→ NFC → 小写 → 连续空白折叠为单空格 → trim →
  sha256。比 omp `findDuplicate` 的全等匹配（`WHERE content = ?`）更强，全等是其子集；
  frontmatter 差异不参与（两个只有 frontmatter 不同的文件是重复）。
- **命中合并**（omp store.ts:449-495 的 UPDATE 语义移植到文件形态）：命中时**既有文件
  是幸存者**（保住入链 `[[name]]` 与文件身份，等价于 omp 返回既有 row id），新写文件
  删除。合并规则（幸存者 frontmatter ← 新写 frontmatter）：
  - `importance` = MAX(既有 ?? 0.5, 新写 ?? 0.5)（omp `MAX(importance, ?)`；ACode 新增
    可选 `importance` frontmatter 字段，0..1，缺省 0.5，本波只参与合并、不参与检索打分）；
  - `veracity`：新写非 `unknown` 且存在 → 覆盖，否则保留既有（omp
    `CASE WHEN ? != 'unknown' THEN ? ELSE veracity END`）；
  - `valid-until` / `type` / `description`：新写存在 → 覆盖（omp `COALESCE(?, col)` =
    新非空则新）；
  - `superseded-by` / `name` / 其余键：保留既有（合并不得复活已失效记忆；name 是
    `[[name]]` 互链身份，omp 无对应概念，此处刻意偏离 COALESCE 语义）；
  - 正文保留幸存者原文（归一化相等，正文等价；omp 同样不改 content 只改元数据）。
  与多个既有文件同时命中时只合并进相对名最小者，其余命中者不动（先存量后清理，不扩散
  本次写入的影响面）。
- **veracity 缺省补写**：去重扫描前先做 R11 的机械兜底（缺字段补 `extracted`），使补写
  值参与同一轮合并。
- **并发边界**：单批内依序串行（for-await），批间由 agent loop 天然串行；同批两文件互为
  重复时，第二个文件执行时第一个已并入/删除，结果收敛且幂等（重复执行无剩余重复）。
- **失败语义**：enforcement 任何 IO 失败 → 记 warn、不抛进 agent loop（Extraction 不因
  生命周期故障中断；去重是增强，不是写路径的正确性前提）。
- `MEMORY.md` 不是条目（J3-2 R10），扫描天然排除；单次扫描文件数以
  `MANIFEST_FILE_LIMIT` 为上限（与检索同源）。

### R10-R13 验收场景（追加，接验收 16）

17. **衰减函数（R10）**：各 type 的参数表单测（k/eta 与 R10 表逐格相等）；eta 点位
    `decay = exp(-1 ** k)` 与公式直算对照（同式重算而非魔法数）；未来 mtime → 1.0；
    type 缺失 → general 兜底参数；`eta<=0` → 0。
18. **veracity 权重（R11）**：四档查表值正确；字段缺失/无法解析 → unknown（1.0，中性）；
    检索排序中「新近 + user_stated」上浮「陈旧 + extracted」（集成）。
19. **失效过滤（R12）**：`superseded-by` 非空 → 检索零命中；`valid-until` 未来 → 可见、
    过去 → 不可见、不可解析 → 不过滤；全部条目失效 → 零候选且 status=ok。
20. **机械去重（R13）**：归一化哈希命中 → 幸存者保留既有文件名与正文、importance 取高、
    veracity 非空覆盖、新写文件被删除；未命中 → 文件原样不动；`MEMORY.md` 不参与。
21. **veracity 机械兜底（R11/R13）**：Extraction 循环 Write 落盘无 `veracity` → 文件被
    补写 `veracity: extracted`；模型已写的值不被覆盖。
22. **recall 排序集成（R10/R11）**：同正文两条，新近 + user_stated 排位高于陈旧 + 无
    veracity；陈旧条目仍在候选中（下限混合不清零）。
23. **存量兼容（R10-R13）**：无任何新字段的记忆文件照常检索、不过滤、veracity=unknown
    中性、仅按 mtime 衰减——单文件场景排序与未引入三件套时一致。

## 未做与取舍

1. **Phase D 记忆图演化**（contradiction 边）：supersede 边已随 R12 落地（frontmatter
   `superseded-by` + 检索过滤 + Extraction 写边指引），按类别半衰期时间衰减随 R10 落地；
   contradiction 边与冲突消解语义仍需独立产品决策——登记不落实现，Phase A-C 数据（R8
   账本）先行。失效条目的过滤计数暂不落 R8 账本（账本消费方在 runtime 接线层），列后续项。
2. **不落盘 BM25 索引**：200 文档内存现算 <5ms，落盘是第二份可漂移状态（AGENTS.md
   单一所有者原则）；FTS5 落库属 K4 的会话存储域，不混入记忆域。
3. **OpenAI 兼容 embedding 后端**：接口位保留（`EmbeddingBackend`），不实现——默认路径
   必须本地（零凭据依赖、离线可用）；外部 API 送记忆正文还有数据外流面，如将来做需
   走与 WebFetch 同级的 egress 声明。
4. **跨项目全局记忆检索**（jcode `MemoryScope::All`）：ACode 全局记忆面尚不存在（现状
   仅项目级），不预建。
5. **wasm 模型资产进 Electron 发布包**：Phase B 落地时在发布清单登记（asar 内资产
   路径 + 下载回退双路径），参照 J5 L1 发布清单模式。

## 第三方归属

`retrieval/` 新文件头注明「机制参照 jcode (MIT)：hybrid BM25+dense RRF（memory.rs）、
向量空间隔离不变量（embedding_backend.rs）、listwise 重排（memory_rerank.rs）」。
Phase B 依赖 transformers.js（Apache-2.0）与模型权重（MiniLM，Apache-2.0），
依赖引入时在 `THIRD-PARTY-NOTICES.md` 登记。

写侧生命周期三件套（R10-R13）移植自 oh-my-pi (MIT) packages/mnemopi：`memory/decay.ts`
（core/weibull.ts）、`memory/veracity.ts` 与 `memory/lifecycle-frontmatter.ts`
（core/beam/recall.ts 可见性与乘权、config.ts 权重缺省）、`memory/dedupe.ts`
（core/beam/store.ts 重复合并），文件头注明
`// Mechanism ported from oh-my-pi (MIT) packages/mnemopi — <文件>, Copyright (c) 2025 Mario Zechner & Stencil Labs`。
零新依赖（`yaml` 为 core 既有依赖）。
