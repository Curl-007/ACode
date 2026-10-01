# Renderer 内存泄漏修复与实机验证（2026-10-01）

主窗口渲染进程单日堆内存 87MB→2088MB 棘轮式增长、顶死 2GB 上限后 OOM；死前完整 GC 无效（`Ineffective mark-compacts near heap limit`）；会话投影 `projection.rows` 清零后堆不回落。产品规则与状态所有者见 `packages/ui/specs/renderer-memory-budget.md`。

## 根因

1. 两个无淘汰的 shiki 高亮 token 缓存：`packages/ui/src/lib/shikiHighlighter.ts` 的 `tokensCache` 与 `@streamdown/code` 插件内置缓存。两者缓存键均含 `code.length` 与首尾片段，流式输出中每个 delta 产生一条新键、一份全量 token 副本，永不释放。
2. 投影 rows 窗口经 `loadOlder`/`loadAllOlder` 合并后无上界，宽窗口下自动全量补拉并常驻；row 可内嵌 CUA base64 截图。
3. `taskQueryCacheStore` 版本化 queryKey 只增不删；`useACodeTaskService` 内存快照缓存无界而持久层有 20 条/2MB 剪枝（防护不对称）。

## 修复

- shiki 缓存改为 2000 条/40MB 字节预算 LRU，并采用「二次命中才缓存」：流式中间态键只出现一次、不入缓存；稳定块二次请求才入缓存。
- 新建 `streamdownCodePlugin.ts` 实现 streamdown `CodeHighlighterPlugin`，委托本仓 wasm 高亮；移除 `@streamdown/code` 依赖，主窗口不再加载其 JS 正则引擎（V8 code cage 风险源）。
- 投影窗口双上限 4000 行/128MB，始终保持连续尾窗；`loadAllOlder` 分页缓冲本身有界化；新增 turn 轻量索引（≤20000 条）登记含被裁行。
- 查询缓存同形状只留最新版本 + 64 条 LRU；快照内存缓存与持久层同预算剪枝。
- 诊断计数器扩展：`shiki.tokensCacheBytes/evictions/hits/misses/seenKeys`、`projection.turnIndex*`、`taskQueryCache.evictions`、`taskSnapshotCache.bytes/evictions`，经 60s 采样落桌面主日志。

## 验证

单元：4 个测试文件 31 用例全绿（流式 400 delta 后缓存常数级、LRU 淘汰、二次命中、版本 supersede、窗口裁头游标连续、索引上限）。门禁：typecheck、lint 0 error、`architecture:check --changed` 0 新增、9 个改动文件 oxfmt 干净。

真实运行时 soak（Node + `--expose-gc` 直接 import 修复模块）：40 块 × 50 delta × 2 入口共 4000 次流式高亮后，缓存 200 条/4.17MB、GC 后堆增量 8MB；6000 行/602MB 投影输入（10% 为 1MB base64 截图行）裁剪后保留 1279 行/127MB（≤128MB 上限）。

真应用 UI 驱动 soak（dev 构建 + CDP 9229，单会话约 15 轮、正文 129KB、`projection.rows` 54）：堆在流式期冲高（峰值 297663KB）并于回合间回落基线（约 144-152MB），六个代码围栏回合逐轮堆 155/147/161/154/148/155MB 无趋势——峰值可回收，与修复前棘轮形态相反。

## 范围与后续

- UI soak 期间 app 内 shiki 高亮分支未被触发：被测模型在自动化约束下只发 inline code chip，Lexical 输入框拍平多行粘贴，历史会话亦无围栏块。该分支有界性由真实运行时 soak 承担（同一 `highlightCode` 入口）；日常含代码块对话可由 `shiki.tokensCacheBytes` 采样曲线做最终实机确认。
- 后续立项（spec 已记录）：CUA/工具截图 base64 改附件 ref 通道（需 `packages/shared` 协议改动）；turn navigator rail 改读 turn 索引并支持窗口外 turn 按需回拉。
- 仓库存量红未触碰：全仓 `fmt:check` 遗留文件、`no-telemetry.test.mjs` 引用已删除文件、错版本 pnpm 下 patchedDependencies 哈希 mismatch（用 packageManager pin 的 pnpm 10.33.2 即消失）。
