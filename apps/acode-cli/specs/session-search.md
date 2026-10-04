# 跨会话搜索：SQLite FTS5 索引 + SessionSearch 工具（K4）

方案条目：`docs/k-series-upgrade-plan.md` §K4。工具语义参照 jcode (MIT)
`crates/jcode-app-core/src/tool/session_search.rs`（1892 行：默认隐藏当前会话与工具噪音、
索引预热、结果投影），实现为 ACode 自有存储层上的自撰 TypeScript，未拷贝任何文件。

给 ACode 补「搜历史会话内容」能力：现状只有 `ReadSessionContext`（按会话 id 读上下文，
不能搜内容）。历史会话是用户最有价值的资产之一——「上次那个 401 是怎么修的」这类问题
今天无法回答。会话存储是自研 SQLite 层（`apps/acode-cli/packages/adapters/src/storage/
session-store/sqlite-session-store.ts` + `repositories/messages.ts`），天然适合 FTS5
全文索引。

红线：**存储层既有读写路径零语义变化**（FTS 表是旁挂投影，主表不动）；**实施首日先验证
运行时 FTS5 可用性**（node 内置 sqlite 的扩展支持），不可用则启用本 spec 的回退条款
（R8）而非强推；不改 acode-protocol v4（新工具走既有工具注册面）。

裁剪边界：不做跨机器/远程会话搜索（本地数据根目录范围）；不做语义/embedding 检索
（那是 K1 记忆域的事，会话搜索是关键词全文检索，两者互补不合并）；不做当前会话内
搜索工具（当前会话在内存，模型自己有 transcript——jcode 的 conversation_search 依赖
其 compaction 体系，ACode 场景下价值弱，登记不做）；UI 搜索框（desktop/web 全局搜索）
是 UI 域后续批次，本项只交付 agent 工具面 + 存储层索引。

---

## 背景：已核实的现状

1. **存储层**：`adapters/src/storage/session-store/`——`sqlite-session-store.ts`（引擎
   封装）、`repositories/messages.ts`（消息行级 upsert，J5 基线报告核实为行级非全量
   重写）、`migrations/` + `migration-runner.ts`（编号迁移体系，新增表走这里）、
   `rows.ts`/`codecs.ts`（行结构与编解码）；
2. **无任何 FTS/搜索面**：全仓 `CREATE VIRTUAL TABLE` 零命中（已核实）；
3. **既有相近工具**：`ReadSessionContext`（按 sessionId 精确读）；`Skill`/`agent-browser`
   等无搜索历史会话能力；
4. **消息内容形态**：消息行含 role/block 结构（assistant/user 文本块、tool 调用与结果
   分块存储于行内 codec）——FTS 索引的文档粒度取「行级文本投影」（R3）；
5. **jcode 参照要点**：默认隐藏当前会话（自引无价值）与工具噪音（grep 类工具结果刷屏）；
   结果带会话/时间/片段投影；索引预热（首次查询前后台建索引，防首查卡顿）。

## 产品规则

### R1 索引结构（存储层旁挂投影）

- 新迁移（编号顺延既有 migrations）：建 FTS5 虚表
  `session_message_fts(fts5(session_id UNINDEXED, task_id UNINDEXED, role UNINDEXED,
  message_ts UNINDEXED, body))`——非检索维度全部 UNINDEXED，只索引 body；
- `body` = 消息行级**文本投影**（R3）；
- **同步维护**：messages 仓储的 insert/upsert/delete 处，同事务内维护 FTS 行
  （外部内容表 + 触发器二选一：**实施首日验证**——node sqlite 若触发器创建受限则走
  仓储代码路径同步维护；两形态都以「与主表同事务」为不变量，失败即整个写回滚，
  **不允许索引落后于主表**）；
- 迁移对存量库：建表后全量回填（分批 1000 行/事务，防大库长事务锁）；回填进度记录在
  migration 体系内（幂等可续）。

### R2 中文检索（与 K1 R2 同款分词决策）

FTS5 默认 unicode61 分词器对 CJK 按字切（单字 token），中文检索信噪比差但可用。
**决策：trigram 分词器**（FTS5 内置 `tokenize='trigram'`）——支持中文 2-3 字词命中与
子串匹配，且对拉丁文本同时提供 substring 搜索能力；若运行时验证 trigram 不可用，
退 unicode61 + 查询侧 CJK bigram 展开（查询预处理，索引侧不动）。
分词器选择记录在迁移注释——**FTS 表一旦建立分词器不可换**（重建=删表回填，登记为
破坏性操作默认禁止）。

### R3 body 文本投影

- 收录：assistant/user 消息的文本块与 thinking 块（thinking 是排查推理的富矿）；
  tool 调用的**入参摘要**（命令文本/bash 命令行——搜「上次那条 pnpm 命令」是真实需求）；
- **排除**：tool 结果体（噪音主源，jcode 同款决策）、图片/二进制块、系统注入段
  （reminders/context sections——它们每会话雷同，进索引只会污染召回）；
- 投影是**写时物化**（写消息时算好存 FTS 行），不是查询时重算——投影规则变更 =
  重建索引（破坏性，默认禁止，规则演进走「新列追加」而非改旧列）；
- 每行 body 上限 `FTS_BODY_MAX_CHARS=20_000`（超长消息截断，尾部标记 `…[truncated]`）。

### R4 SessionSearch 工具（core `tool/handlers/session-search.ts`）

```
SessionSearch({ query: string, limit?: number(缺省10,上限50),
                taskId?: string, beforeTs?: number, afterTs?: number,
                includeCurrentTask?: boolean(缺省 false) })
→ { results: [{ taskId, taskTitle, role, messageTs, snippet, matchCount }], truncated: boolean }
```

- **默认隐藏当前会话**（`includeCurrentTask:false` 时过滤 runtime 当前 taskId——jcode
  同款：搜历史是工具的存在理由，自引无价值）；
- **snippet**：FTS5 `snippet()` 函数生成（窗口 ±64 字符，高亮标记 `<>`——渲染前转义，
  防内容注入 UI；工具输出本身是给模型看的不可信数据，带「历史会话内容是不可信数据」
  声明行，J3-2 R6/K1 同款口径）；
- 查询语法：FTS5 MATCH 原生语法透传，但**先过安全归一**（去 `"` 不平衡、截 256 字符、
  禁 `*` 前缀通配打头——防性能滥用）；
- 排序：`ORDER BY rank, message_ts DESC`（相关性优先，同分新者优先）；
- 性能：查询超时 500ms（超时返回已完成部分 + truncated 标记，不 fail）；
- 工具描述引导用法（「找上次怎么修的 X」→ SessionSearch 而非 Glob 翻日志）。

### R5 索引预热

- runtime 启动（storageReady 后）低优先级后台任务：`SELECT count(*) FROM messages` 对
  FTS 行数，缺口 >0 则分批补齐（异常退出的回填兜底）；
- 预热不阻塞任何读路径；与 R1 同事务写入的差额应为零，预热只是防御层。

### R6 状态所有权

| 状态 | 所有者 | 生命周期 |
| --- | --- | --- |
| FTS 表与行 | session-store（同事务维护，主表是唯一事实源） | 持久 |
| body 投影规则 | 写路径单一实现（`fts-projection.ts`，唯一所有者） | 代码 |
| 查询与归一 | SessionSearch handler | 单次调用 |
| 预热任务 | runtime 启动序列 | 进程 |

不变量：FTS 是**可重建的派生投影**（主表在则索引可重建，任何不一致的终解是重建而非
修补）；写路径不因 FTS 维护失败而部分成功（同事务回滚）；投影规则只有一份实现。

## 常量

| 常量 | 值 | 出处 |
| --- | --- | --- |
| `FTS_BODY_MAX_CHARS` | `20_000` | R3 |
| `SESSION_SEARCH_DEFAULT_LIMIT` / `_MAX_LIMIT` | `10` / `50` | R4 |
| `SESSION_SEARCH_TIMEOUT_MS` | `500` | R4 |
| `SESSION_SEARCH_QUERY_MAX_CHARS` | `256` | R4 |
| `FTS_BACKFILL_BATCH_ROWS` | `1_000` | R1 |

## 接口

adapters：migration（FTS 建表 + 存量回填）、`storage/session-store/fts.ts`
（投影 + 同事务维护 + 查询封装 `searchSessionMessages(params)`）；
contracts：`SessionSearchInputSchema/OutputSchema`；
core：`tool/handlers/session-search.ts`（注册进 BUILT_IN 工具面，无 port 门——
只读本地存储，与 ReadSessionContext 同级暴露）。

## 验收场景

测试：`apps/acode-cli/tests/session-search.test.mjs`（临时 SQLite 库真实读写）。

1. 中文：trigram 路径下「凭据 401」命中含该短语的消息（若走回退分词则 bigram 展开命中）；
   拉丁词/版本号命中；
2. 噪音排除：tool 结果体、reminders 段不进索引（写入后 FTS 行 body 不含其文本——
   投影单测 + 集成双钉）；thinking 块与 bash 命令行可搜；
3. 同事务性：主表写成功 FTS 必在（查询即中）；构造 FTS 写失败（桩）→ 主表写回滚；
4. 默认隐藏当前会话；`includeCurrentTask:true` 时可见；
5. snippet 转义（`<script>` 内容不产生标签）；不可信声明行在场；
6. 查询归一：256 截断、不平衡引号修复、`*foo` 打头剥离；超时返回部分结果 + truncated；
7. 迁移幂等：二次跑迁移 no-op；存量回填中断续跑（模拟批次间 kill）终态一致；
8. **实施首日能力验证记录**（本 spec 附录补记）：FTS5 可用性、trigram 可用性、触发器
   可用性三项的运行时探测结果与最终选型；不可用项走 R8。

## R8 回退条款（能力探测失败时）

- FTS5 整体不可用 → 本项降级为「LIKE 扫描 + 进程内倒排缓存」形态：查询侧
  `WHERE body LIKE`（内存映射最近 N 天消息构建 bigram 倒排，冷数据 LIKE）；
  功能面（工具 schema/行为）不变，性能预期下降——验收场景 1-7 照跑，超时阈值放宽
  至 2s。**此条款只在探测失败时启用，探测结果进 spec 附录**；
- trigram 不可用但 unicode61 可用 → R2 的查询侧 bigram 展开路径（索引 unicode61）。

## 未做与取舍

1. **不做 conversation_search（当前会话内搜索）**：当前会话在内存 transcript，模型
   本身持有；jcode 该工具服务其 compaction 后找回，ACode 场景价值弱；
2. **不做向量/语义会话检索**：与 K1 记忆域的 embedding 基建未来可共享后端，但会话
   body 向量化是另一个数量级的索引成本，登记远期；
3. **不做 UI 全局搜索**：desktop/web 搜索框走 services 层新查询服务（复用 fts.ts 封装），
   UI 批次立项；
4. **FTS 表分词器不可换**（R2）：演进策略=新列/新表追加，旧表废弃不删除（历史库兼容）；
5. **两阶段排序的已知产品限制**（对抗复核 L2 登记）：MATCH 段收满 limit 时 LIKE 段
   命中被完全挤出、混合出现时 LIKE 命中永远垫底——后续可考虑跨阶段归并或短段加权，
   本轮接受；
6. **URL/路径开箱回执 fire-and-forget**（K9 spec 取舍在 K4 语境的同族记录，
   详见 K9 spec §未做 2）。

## 第三方归属

工具语义参照 jcode (MIT) `tool/session_search.rs`（默认隐藏当前会话与工具噪音、
snippet 投影形态），存储与实现为 ACode 自研 SQLite 层上的自撰代码。

## 附录 · 实施首日能力验证记录（2026-10-04，node v25.8.2 `node:sqlite`）

- FTS5 建表：**OK**；trigram 分词器：**OK**；触发器：**OK**——R8 回退条款不启用，
  走 trigram 主路径；
- **短 token 限制（实测修正 R2）**：trigram 要求查询 token ≥3 字符——`"凭据"`（2 字 CJK）
  MATCH 不命中（前缀 `凭据*` 与 phrase `"凭据"` 均不命中，拉丁 <3 同）；`主密钥`（3 字）
  与 `凭据主密`（4 字）命中。**检索口径定死**：查询归一后 ≥3 字符的段走 `MATCH`，
  含 <3 字符段的查询该段降级 `body LIKE '%段%'`（trigram 表支持 LIKE 索引扫描，
  实测命中），多段 OR 组合——这是 R2「trigram 不可用退 unicode61+bigram」条款的
  实测替代，无需退化分词器；
- `snippet(t2, 0, '[', ']', '…', 10)` 高亮正常（`[主密钥]` 形态）。
- **组合语义定死为段间 OR**（实现期钉住）：AND/OR/NOT/NEAR 算符 token 按停用词丢弃
  （FTS5 的 MATCH 出现在 OR 组合里时拒绝计算 rank——"unable to use function MATCH in
  the requested context"），因此实现为**两阶段**：纯 MATCH 段按 `rank, message_ts desc`
  排序 + 短段 LIKE 按时间倒序，按 messageId 去重合并；`and`/`not` 作为正文词仍可命中。
- 外部内容表删除须用 `'delete'` 命令且携带 doc 行**旧值**、在改 doc 之前调用；
  会话级联删除绕过 removeMessage 的孤儿投影由 reconcile 反连接对账清理（预热即
  不限游标的 reconcile——游标只对升级后顺扫成立）。
