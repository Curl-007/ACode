# Renderer 内存预算与有界缓存

## 背景

主窗口渲染进程在单日使用中堆内存从 87MB 棘轮式增长至 2088MB（V8 堆上限），死前完整 GC 无效（`Ineffective mark-compacts near heap limit`），且会话投影 `projection.rows` 清零后堆不回落。定位为多处「只增不减」的模块级缓存与无界数据窗口：shiki 高亮 token 缓存（自有 + `@streamdown/code` 内置，两者均按含 `code.length` 的内容键缓存，流式每个 delta 产生一条新副本且永不淘汰）、投影 rows 窗口经 `loadOlder`/`loadAllOlder` 合并后无上限、版本化任务查询缓存只增不删、任务快照内存缓存与持久层防护不对称。

## 产品规则

1. **缓存必有上限**：渲染进程任何模块级缓存必须声明条数或字节上限并在插入时淘汰；新增缓存必须向 `uiMemoryDiagnosticsRegistry` 注册计数器（条数、字节、淘汰数）。
2. **流式中间态不入缓存**：内容仍在增长的版本（每个 delta 一个内容键）不得写入 token 缓存；采用「二次命中才缓存」策略——同一内容键第二次被请求时才入缓存，首次仅记入廉价的键存在集合。
3. **投影窗口有界**：`ConversationProjectionStore` 的 `rows.window` 始终是有界连续尾窗（行数与字节双上限）；超限时从头部裁剪，`window[0].rowId` 保持为分页游标。turn navigator 的 rail 依赖轻量 turn 索引（rowId/kind/origin/摘要），不依赖全量 rows；窗口外 turn 的正文按需经既有 `rowsRange` 回拉。
4. **版本化缓存只留最新**：任务列表查询缓存同一查询形状只保留最新版本键；任务快照的内存缓存与 localStorage 持久缓存执行同一预算（20 条 / 2MB）。
5. **诊断先行**：所有受本 spec 约束的结构，其 60s 内存采样曲线必须在修复后呈平台期而非棘轮。

## 状态所有者与不变量

| 状态                       | 唯一所有者                                            | 不变量                                                                                        |
| -------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 高亮 token 缓存            | `lib/shikiHighlighter.ts` 模块单例                    | ≤2000 条且 ≤40MB；二次命中策略；淘汰最旧                                                      |
| Streamdown 代码高亮        | `lib/streamdownCodePlugin.ts`（委托 `highlightCode`） | 主窗口不加载 `@streamdown/code` 及其 JS 正则引擎；接口满足 streamdown `CodeHighlighterPlugin` |
| 投影 rows 窗口与 turn 索引 | `v4/conversationProjectionStore.ts`                   | 窗口为连续尾窗，≤4000 行且 ≤128MB；索引条目 ≤20000；store `close()` 时两者一并释放            |
| 任务查询结果缓存           | `store/taskQueryCacheStore.ts`                        | 同形状只留最新版本；总量 ≤64 条 LRU；workspace 失效路径清理对应实体 meta                      |
| 任务快照缓存               | `hooks/useACodeTaskService.ts`                        | 内存层与持久层同预算（20 条 / 2MB），每次写入后剪枝                                           |

失败语义：淘汰与裁剪只造成「降级重算」——token 缓存未命中回落到异步 tokenize；窗口外 turn 回落到 `rowsRange` 回拉；均不抛错、不改变 ACK/owner/lease/序列语义。裁剪不触碰 desktop-continuous 与 web-remote-replayable 的投递边界，wire 协议不变。

## 验收

- 单测：流式 400 个不同长度 delta 后 `tokensCache` 条目数为常数级；LRU 超上限淘汰最旧且字节回落；二次命中前后缓存可见性变化；查询缓存同形状 supersede 与 LRU 上限；快照内存/持久剪枝对称；窗口超限裁头后游标连续、`loadOlder` 仍可分页、索引保留被裁 turn。
- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 无新增违反。
- 实机：soak 会话中 `shiki.tokensCacheBytes`、`projection.rows`、`taskQueryCache.queryKeys` 采样曲线呈平台期；堆快照中 `ThemedToken` 聚合 retained size 显著下降。

## 后续立项（本轮不实现）

- CUA/工具截图 base64 内嵌 row 改为附件 ref 通道（需 `packages/shared` 协议改动）；本轮由窗口字节预算限幅。
- xterm 常驻注册表与 forceMount 侧栏：数量受用户 tab/pane 数约束，且其投影已受窗口上限约束，接受为设计内占用。
