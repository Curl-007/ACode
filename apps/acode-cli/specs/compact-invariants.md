# 压缩不变量审计（J1-3）

方案条目 **J1-3**（`docs/jcode-inspired-upgrade-plan.md:111-133`），性质：**审计 + 修正**。

本 spec 是审计清单式登记处：五条来自 jcode 事故记录的压缩不变量 → 逐条判定
（**成立 / 缺口 / 不适用**）→ 亲自复核的证据（`file:line` + 实跑命令与输出）→ 修正项 → 测试。
不预设结论；判定「成立」的写守卫测试钉住，判定「不适用」的把前提写成可执行断言，
判定「缺口」的落最小侵入修正。

jcode 参照（只读，MIT）：`crates/jcode-compaction-core/src/lib.rs`（45-58 图片平价、239-292 safe
cutoff、354-393 会计归一、602-698 413 分轨）、`crates/jcode-base/src/compaction.rs`（1189-1211
stale 守卫、1516-1532 abort 在途）。**只提炼机制，实现为自撰 TypeScript**，未拷贝任何文件。

## 审计口径

- 行号以本次审计时的检出为准（分支 `dev/0.0.1`）。
- 每条判定至少一条**亲自跑过**的证据：要么 `file:line` 逐行读过，要么用
  `node --import tsx -e` / `node --import tsx --test` 实跑过。命令与输出登记在各条的「证据」里，
  回归测试统一落在 `apps/acode-cli/tests/compact-invariants.test.mjs`。
- 所有权边界：`core/src/compact/**`、`core/src/runtime/helpers/model-errors.ts`、
  `core/src/runtime/methods/compact-active.ts`、本 spec 与该测试。边界外的发现只登记，不改。

## 判定总览

| # | 不变量（jcode 事故教训） | 判定 | 修正项 | 测试 |
| --- | --- | --- | --- | --- |
| I1 | 图片按平价计费，不按 base64 长度 | **缺口 → 已修** | M1 | I1-1 … I1-6 |
| I2 | provider token 会计归一，显示与决策共用唯一事实来源 | **成立**（附一条结构性观察） | 无（观察 O1 登记） | I2-1 … I2-4 |
| I3 | 压缩切点不拆 tool_use/tool_result 对；配不齐则放弃压缩 | **成立**（结构性保证，无需回退搜索） | 无 | I3-1 … I3-4 |
| I4 | hard compact 必须 abort 在途后台压缩 + stale cutoff 守卫 | **不适用**（当前无后台压缩；前提已钉住） | 无（前提 P1 登记） | I4-1 … I4-3 |
| I5 | HTTP 413 字节超限走独立恢复轨道 | **缺口 → 已修（compact 路径）** | M2 | I5-1 … I5-6 |

---

## I1 · 图片 token 计费（estimate 模式）

**判定：缺口 → 已修（M1）。**

### 证据

1. **修正前的实测低估**（本审计实跑）：

   ```
   node --import tsx -e "…estimateMessageTokens([{role:'user',content:[{type:'image',
     mediaType:'image/png',dataUrl:'data:image/png;base64,'+'A'.repeat(400000)]}]}])"
   → image-only estimate: 7
   → text-only estimate（3000 字符正文）: 1000
   ```

   一张 400KB base64 截图计 **7 token**；同一条估算里 3000 字符正文计 1000 token
   （字符除数 3，`packages/shared/src/usage-stats.ts:9`）。低估约 200 倍。
2. **低估的来源**：估算投影对非 reasoning 块一律走共享正文投影
   （修正前 `core/src/compact/manual.ts` 的 `modelMessageContentToTokenEstimateText`），
   而共享投影把 image/video 折成占位文本 `[Attached image/png]`
   （`contracts/src/model/index.ts:454-457` + `:470-472`，20 字符 → 7 token）。
3. **不是纯理论**：estimate 轨道真实可达。
   - `core/src/compact/policy.ts:102-104`：无 `tokenOverride` 时决策值就是本地估算；
   - override 只在存在「已提交 assistant usage anchor」时才有
     （`core/src/runtime/methods/compact.ts:317-320`）；
   - **压缩之后** preserved 尾巴里的 assistant usage 被显式清零
     （`core/src/runtime/helpers/compact.ts:157-166` → `invalidateRuntimeTokenUsage`），
     于是「带图尾巴 + 刚压缩过」正好落回 estimate 轨道；
   - provider 轨道的**本地增量段**同样是估算（`methods/compact.ts:323-325`），
     anchor 之后新进来的图片一样被低估。
4. **jcode 的同源事故（方向相反）**：`lib.rs:45-58` 记录 base64 长度 ÷ 4 会**高估约 100 倍**，
   导致连续三次压缩仍降不下来（图片就留在保留轮次里）；ACode 的占位文本则是**低估到 ~0**。
   两者都让阈值失真，正确解都是「按块平价」。

### 修正项 M1

- 新增 compact 自有常量 `COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS = 1_600`
  （`core/src/compact/manual.ts:37`，文件内注释记录取值依据与两个方向的失真事故）。
- 估算改为「字符部分 ÷ 除数 + 内联媒体按块平价」
  （`core/src/compact/manual.ts:123-141`），媒体块不再进字符投影
  （`:158-192`，`isInlineMediaBlockForTokenEstimate` 覆盖 image / video / 无正文的 file 附件）。
- **落点严格限制在 compact 自己的估算投影**，与既有 reasoning 独立投影同一先例；
  `contracts/src/model/index.ts` 的 `modelMessageContentBlockToText` **未改动**，
  memory、错误文案、UI 摘要等消费方语义不变（测试 I1-5 钉住占位文本仍是 `[Attached image/png]`）。
- 既有阈值常量语义**未变**：`policy.ts:6-14` 的 200K / 32K / 21K / 13K / 3 次熔断原样保留；
  测试 I1-6 显式断言 `getAutoCompactThreshold({contextWindow:60000}) === 60000-21000-13000`。

取值依据（三处独立证据同量级）：jcode `IMAGE_TOKEN_COST = 1600`；Anthropic 单张图片 token 上界量级；
ACode 自己的 Read 图片管线也以 token 预算约束图片体积
（`contracts/src/tools/read.ts:16,22`：`READ_MAX_OUTPUT_TOKENS = 25_000`、
`READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO = 0.125`）。

### 验收场景（测试）

| 场景 | 断言 | 测试 |
| --- | --- | --- |
| 平价计费 | 单图 = 1600；1KB 与 4MB base64 同值（不随体积放大） | I1-1 |
| 线性累加 | 多图相加；正文与 toolCalls 入参仍按字符计费 | I1-2 |
| 媒体覆盖面 | video、无正文 file 附件同样平价；**带正文的 file 仍按正文**（既有语义不变） | I1-3 |
| 零回归 | reasoning 仍计入估算（既有修正不回退） | I1-4 |
| 边界不外溢 | 共享投影 `modelMessageContentBlockToText` 语义未变 | I1-5 |
| 阈值效果 | 20 张截图 + 60K 窗口：修正后 `above_threshold`，且反证「去掉平价就落到阈值下」 | I1-6 |

### 残留风险

- video / document 的平价是**下限**（真实成本随帧数、页数上升）。当前不按时长/页数分档：
  ACode 侧拿不到帧数事实，凭空造分档常量会引入新的失真。缓解：estimate 轨道只在无 usage
  anchor 时生效，一次 provider 响应后即由 `provider_usage` 接管（`policy.ts:103-104`）。
- 平价计费会让带图历史的估算值上升，从而**更早**触发 microcompact / auto compact。
  这是修正的目的（对齐真实上下文），不是副作用；microcompact 本身不清理媒体结果
  （`core/src/compact/microcompact.ts:227,249-256`），因此不会把图片"清掉"来凑节省量，
  节省不足时按既有 `below_min_savings` 原样返回（`:147-153`）。

---

## I2 · provider token 会计归一

**判定：成立。**（附结构性观察 O1，不修正）

### 证据

1. **归一发生在 SDK 边界，ACode 侧只需「不再叠加 cache」**。实跑读取已安装依赖：
   `node_modules/@ai-sdk/anthropic/dist/index.js:1808-1814`

   ```js
   inputTokens: { total: inputTokens + cacheCreationTokens + cacheReadTokens, noCache: …, cacheRead: …, cacheWrite: … }
   ```

   即 Anthropic 的 split accounting（`input_tokens` 不含 cache）已由 AI SDK 加回成 total input。
   OpenAI 侧 `prompt_tokens` 本身就含 cached（subset accounting），同样不需要再加。
   jcode 的 `effective_context_tokens_from_usage`（`lib.rs:354-393`）在 ACode 退化为一条规则：
   **一律不得把 cacheRead/cacheWrite 叠加到 input window 上**。
2. **三处实现同口径，且都写明不得叠加**：
   - 显示侧：`contracts/src/model/index.ts:571-590`（`getModelUsageInputWindowTokens`，注释
     `:576-577` 明写「再叠 cacheReadTokens 会把 context meter 和 compact 阈值放大一截」），
     经 `contracts/src/events/event-reducer.ts:223` → `projection.contextUsed` →
     TUI 侧边栏 `packages/tui/src/app-sidebar.tsx:327`、`app-input-status.tsx:182`；
   - core 内副本：`core/src/runtime/methods/turn-model-step-usage.ts:160-182`
     （注释 `:163-164` 说明是 contracts 未构建时的有意重复）；
   - 持久化形态：`core/src/agent/message-history-usage.ts:11-52`（`contextUsageTokens = input + output`）。
3. **决策与 preflight 共用同一入口**：
   - 唯一的 provider → context token 转换点：`core/src/runtime/methods/compact.ts:313-340`；
   - 同一函数对外暴露为 `estimateCurrentModelInputTokens`（`:342-350`），
     被请求 preflight 消费（`core/src/runtime/methods/turn-model-step.ts:242`）；
   - 决策消费同一 override，并把 `tokenSource` 与 provider 明细全部外显
     （`core/src/compact/policy.ts:102-122`）、进日志与 telemetry
     （`core/src/runtime/methods/compact-log-context.ts:21`、`methods/compact-active.ts:105-118`）。
4. **实测（本审计实跑）**：anchor `input=50000 / output=1000 / cache.read=40000 / cache.write=5000`，
   尾段 3000 字符 tool 结果：

   ```
   estimateCurrentModelInputTokens(messages, sourceEntries) → 52002   # = 51000 + 1002
   estimateMessageTokens(messages.slice(2))                   → 1002
   estimateMessageTokens(messages)                            → 1007
   无 anchor 时 estimateCurrentModelInputTokens               → 1007   # 回落 estimate
   ```

   若错误叠加 cache，结果会是 97002。

### 观察 O1（登记，不修正）

同一归一规则存在**三份实现**（上列 2 的三处）。这是结构性重复而非语义分歧——三者口径一致，
且 `turn-model-step-usage.ts:163-164` 已注明重复的原因（core 测试/运行时经包入口解析 contracts，
新增 helper 在未构建时不可用）。合并需要改 `contracts/src/model`（本次所有权边界外，
且 AGENTS.md 要求跨包只走公开入口），因此只登记：**若未来 provider 侧改成 split accounting
（AI SDK 不再合并 cache），三处必须同时改**，否则显示与决策会分叉（jcode issue #441 的形状）。

### 验收场景（守卫测试）

| 场景 | 断言 | 测试 |
| --- | --- | --- |
| 不重复计 cache | 会计值 = `input + output + 尾段估算`，且严格小于「叠加 cache」的错误值 | I2-1 |
| 回落如实标注 | 无 anchor → 等于纯估算；`tokenSource === "estimate"` | I2-2 |
| 唯一事实来源 | provider override 覆盖估算参与阈值判定；`estimatedTokenCount` 仍外显且低于阈值（反证判定用的是 provider 值） | I2-3 |
| provider 轨道的增量段 | anchor 之后新进来的图片按平价进入增量 | I2-4 |

---

## I3 · 压缩切点不拆 tool_use/tool_result 对

**判定：成立**（结构性保证；jcode 的回退搜索在 ACode 无对应需求）。

### 证据

1. **机制差异**：jcode 用数值 cutoff + 向后回退搜索，配不齐就返回 0（放弃压缩）
   （`lib.rs:239-292`）。ACode 的切点由「assistant 起始轮」分组派生：
   `core/src/compact/rounds.ts:10-28` 只有 `role === "assistant"` 能开启新组，
   tool 结果**永远**与它前面那条 assistant 同组 → 切点在组边界上，配对不可能被切开。
2. **切分实现**：`core/src/runtime/helpers/compact-selection.ts:359-363`（分组）、
   `:45-56`（整组切分，preserved = 末尾 N 组）、
   `:41`（`maxGroupsToPreserve = groups.length - 1` → 第 0 组永不进保留侧，
   所以保留侧首条一定是 assistant，不会是孤儿 tool 结果）。
3. **prefix 切分不会插进配对**：`:209-227` 只在头部切 prefix，
   `core/src/agent/message-history.ts:269-296` 的 `countContextPrefixMessages` 只认
   system / `context_prefix` / `skills_listing`，遇到其他角色立即 break。
4. **prompt-too-long 的两条回退也不拆对**：重选按整组增加保留轮数（`:59-101`），
   截断按整组从头丢弃且 `dropCount ≤ groups.length - 1`（`:279-335`）。
5. **附件重排不跨界**：`core/src/runtime/helpers/provider-request-messages.ts:106-139,175-182`
   ——`isBubbleStop` 含 assistant 与 tool，reminder 只能停在配对之外。
6. **「未回答的 tool 调用」不由压缩产生**：`core/src/runtime/methods/turn-tools.ts:141-144`
   注释明确「assistant tool_use 进入 history 后，Stop 不能在 tool result 创建前直接抛出」，
   取消路径为每个 tool call 生成 ToolCancelled result。
7. **实测（本审计实跑）**：`[system, user, assistant(tc t1), tool t1, user, assistant(tc t2), tool t2]`
   经 `selectCompactEntries({trigger: Auto})` →
   `preserved = [assistant, tool:t2]`、`summary = [system, user, assistant(tc:t1), tool:t1, user]`，
   两侧各自配对完整。

### 「配不齐则放弃压缩」的 ACode 等价语义

不需要：ACode 没有数值 cutoff，因此不存在「配不齐」的中间态。等价的放弃语义是
**不足两轮不压缩**（`compact-selection.ts:147-153`），并且表现为健康 no-op：
`methods/compact-active.ts:221-242` 返回 `outcome: "skipped"` + `CompactTimelineStatus.Skipped`
（注释：「刚压缩过或历史太少时，/compact 是健康 no-op，不能暴露成系统故障」）。

### 验收场景（守卫测试）

| 场景 | 断言 | 测试 |
| --- | --- | --- |
| 常规历史 | 保留侧首条不是 tool；两侧 tool 结果都有同侧调用；摘要侧不以未回答的调用结尾 | I3-1 |
| 分组不变量 | 除首轮外每组都由 assistant 起始（多种历史形状，含并行 tool call） | I3-2 |
| 回退路径 | prompt-too-long 重选与整组截断后配对仍完整，且截断留痕 | I3-3 |
| 放弃语义 | 不足两轮 → `hasEnough*` 为 false；compact-active 走 `skipped` 分支 | I3-4 |

### 残留风险

- 若**历史本身**已含孤儿 tool 结果（例如外部导入/旧版本持久化的残缺轨迹），
  压缩不会修好它，也不会让它更糟：孤儿会整体落在摘要侧或保留侧。
  ACode 当前没有任何 tool 配对修复器（grep `orphan|dangling|missingToolResult` 在
  `core/src`、`adapters/src` 均无命中）——这属于历史完整性议题，不是压缩切点议题，本次不扩权处理。

---

## I4 · 并发压缩防护

**判定：不适用**（当前不存在后台/在途压缩）。**前提已写成可执行断言**，未来引入并发时先红。

### 前提 P1（登记）

ACode 的压缩是**同步串行**的，其正确性依赖三条前提；jcode 的两道并发防护
（abort 在途后台压缩 `compaction.rs:1516-1532`、stale cutoff 守卫 `compaction.rs:1189-1211`，
事故文案「kept 0 recent messages」）在 ACode **没有对应物，也暂时不需要**：

1. 三个压缩调用点全部内联 `await`：`core/src/runtime/methods/compact.ts:86`（manual）、
   `:258`（auto）、`:411`（reactive）；无 `void this.compact*`、无
   `setTimeout/setInterval/queueMicrotask/setImmediate`、无 `.then(` 形式的后台压缩（实跑 grep 无命中）。
2. 单活跃 turn 互斥：manual `/compact` 先取 `beginActiveTurn`（`methods/compact.ts:57` →
   `methods/steering.ts:296-323`），已有 turn 或已有 turn 预约时抛 `turn_in_progress`
   （实测文案 `Cannot start compact turn while another turn is active`）；
   auto/reactive 在**同一个** active turn 内部串行执行，不可能与别的 turn 并存。
3. 压缩回写是**无守卫的整体覆盖**：`core/src/agent/message-history.ts:228-235`
   （`this.entries = messages.map(cloneEntryInput)`，无 revision/version/expectedCount 校验）。
   即「压缩期间没有别的写入者」完全由前提 1、2 保证，历史对象自己不做 stale 检测。
   目前已存在的唯一 stale 缓解是回写时重读 canonical prefix
   （`methods/compact-active.ts:672-679` 的 `preserveCanonicalContextPrefix`，
   注释说明配置刷新会立即替换 canonical prefix）。

**因此：任何未来引入后台/并发压缩的改动，必须同时补 jcode 那两道防护**
（hard compact 前 abort 在途任务；应用结果前校验 cutoff 相对当前 active 长度是否 stale，
active tail 不足则丢弃结果），否则前提 3 会直接把活跃消息整体覆盖掉。

### 验收场景（守卫测试）

| 场景 | 断言 | 测试 |
| --- | --- | --- |
| 无后台压缩 | 三个调用点全部 `await`；三份 compact 源文件无延迟/后台调度与 fire-and-forget | I4-1 |
| 互斥 | `beginActiveTurn` 在 activeTurn / 预约态下抛 `turn_in_progress`；`finishActiveTurn` 只释放自己那把锁 | I4-2 |
| 前提登记 | `replaceMessages` 仍是无守卫覆盖（新增守卫即测试红，提醒同步更新本 spec）；compact 回写仍重读 canonical prefix | I4-3 |

---

## I5 · HTTP 413 字节超限的独立恢复轨道

**判定：缺口 → 已修（M2，覆盖 compact summary 请求路径）。**

### 证据

1. **修正前 413 对三条判定全不可见**（本审计实跑）：

   ```
   error = AiSdkModelAdapterError{ code:'MODEL_REQUEST_FAILED', context:{ statusCode:413, reason:'unknown' } }
   isModelContextExceededError(error) → false
   isModelMediaTooLargeError(error)   → false
   isModelRequestPayloadTooLargeError → undefined（当时不存在该判定）
   ```

2. **adapter 侧把 413 归一成不可重试的通用失败**：
   `adapters/src/model/failure-classifier.ts:183-257` 的分支只覆盖 429 / 529 / 401 / 403 /
   400 / 422 / ≥500，413 落到 `:294-305` 的兜底（`MODEL_REQUEST_FAILED` +
   `reason: unknown` + `retryable = isProviderMarkedRetryable(error)`，通常为 false）；
   真实状态码只保留在 `context.statusCode`（`adapters/src/model/runner-retry.ts:136`）。
3. **compact 侧因此没有恢复动作**：修正前 `methods/compact-active.ts` 的 catch 只有
   media-too-large（原 `:432`）与 context-exceeded（原 `:445`）两条轨道，413 直接 `throw error`（原 `:454`）；
   auto compact 外层因 `retryable === false` 也不再重试（`:739-741`）→ 压缩硬失败。
4. **预防侧预算不足以排除 413**：`core/src/runtime/helpers/media-budget.ts:28`
   `DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES = 40MiB`，**高于** Anthropic 约 32MB 的请求体硬上限
   （jcode `lib.rs:33-40` 注释记录同一事实），而 compact summary 请求确实走这条聚合预算
   （`methods/compact-active.ts:330-333`）。所以「已经过预算投影」不等于「不会 413」。
5. **token 轨道救不了字节超限**：token 会计有意不按 base64 长度计费（见 I1），
   丢轮次/截断 summary 输入（`compact-selection.ts:59-139,167-207`）针对的是 token 压力，
   对「请求体字节数」既诊断不出原因、也不保证降得下来。jcode 因此把它拆成独立轨道
   （`lib.rs:602-698` + `jcode-app-core/src/agent/compaction.rs:187-207`），
   且**无可剥媒体时直接放弃、不回落 token 轨道**（`jcode-tui/src/tui/app/model_context.rs:791-812`）。

### 修正项 M2

**(1) 独立判定**（`core/src/runtime/helpers/model-errors.ts`）

- `isModelRequestPayloadTooLargeError`（`:316-354`）：与既有两个判定同款 cause 链遍历（≤6 层、WeakSet 防环）。
- 状态码**精确匹配 413**（`:356`、`:401-405`），字段覆盖 adapter 与 provider 业务错误的各种键名
  （`:359-366`：`statusCode` / `responseStatus` / `httpStatus` / `httpStatusCode` /
  `httpResponseStatus` / `status`，顶层与 `context` 各查一遍）。
- 文案 marker 与模式（`:368-383`）：`request_too_large`、`payload_too_large`、
  `request_entity_too_large`、`request_payload_too_large`、`http_413`；
  `payload too large` / `request too large` / `request entity too large` /
  `request body too large` / `request exceeds the maximum size` / `exceeds the maximum size`。
- **独立状态码匹配防误命中**（`:427-444`）：`413` 命中，`4130` / `41300` 不命中
  （前后不得紧邻 ASCII 数字，与 jcode `contains_independent_status_code` 同口径）。
- **比 jcode 更严的一处刻意偏差**（`:385-399`、`:413-425`）：裸「413」还要求句中出现
  HTTP/体积语境词（http / status / payload / entity / body / size / bytes）。
  原因：ACode 的 token 超窗文案里可能出现三位数（`prompt is too long: 413 tokens > 200 maximum`，
  该形状正是 `compact-selection.ts:400-410` 要解析的 token gap），若照 jcode 直接匹配裸 413，
  会把 token 轨道的错误抢判成字节轨道，恢复动作就从「丢轮次」错换成「剥媒体」。

**(2) 预算阶梯**（`core/src/compact/payload-recovery.ts`，新文件）

- `COMPACT_PAYLOAD_RECOVERY_MEDIA_BUDGET_BYTES = 12MiB`（与 jcode `PAYLOAD_IMAGE_CHAR_BUDGET` 同量级：
  明显低于 provider 请求体硬上限，给正文/tool schema/协议封装留余量，一次重试大概率能过）。
- `nextCompactPayloadRecoveryMediaBudget`：`undefined → 12MiB → 0 → undefined`（耗尽）；
  非法值（NaN / 负数）直接耗尽，杜绝无限重试。

**(3) 恢复动作与接线**（`core/src/runtime/methods/compact-active.ts`）

- 轨道状态 `payloadRecoveryMediaBudgetBytes`（`:278`，与 `stripMediaForSummary` 同层，每个 attempt 重置）。
- 请求构建阶段按预算重投影「实际请求消息」与「可记录消息」两份（`:372-394`）。
- 剥离动作**复用**既有聚合媒体预算投影 `projectMessagesForMediaBudget`（`:782-793`），
  而不是新写一份剥离逻辑：oldest-first（`media-budget.ts:123-132` 按 messageIndex 倒序保留最近的）、
  CUA 图块配对（`media-budget.ts:225-240` → `official-cua-media.ts`）、
  media_type 占位文案（`media-budget.ts:253-259`）都只有一处实现（AGENTS.md：避免多条写入路径）。
- `preserveLatestUserMedia: false`（`:786-792` 注释）：summary 请求的最后一条 user 是 compact prompt，
  没有需要保护的「当前附件」；沿用保护规则会让 0 预算抛
  `MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE` 而不是剥离媒体（**实测**：默认旗标 + 0 预算确实抛错，
  测试 I5-5 钉住这条必要性）。
- catch 分支顺序：取消 → **413（`:466-489`）** → media-too-large → context-exceeded。
  413 排在 media-too-large 之前，因为字节阶梯比「一次性剥光媒体」更渐进（先保最近的媒体）；
  阶梯耗尽（媒体已全剥仍 413）**直接抛出**，不回落 token 轨道——与 jcode 一致，
  也避免把「请求体太大」误诊成「上下文太长」后被 auto compact 外层放大成 3×3 重试。
- 观测：`compact.request.payload_too_large.retry`（warn，含 `maxMediaBytes`）与
  `compact.request.payload_too_large.media_projection`（warn，含
  `omittedMediaCount` / `totalMediaBytes` / `projectedMediaBytes` / `retainedMediaCount`，`:795-815`）。
- 落点说明：两个新私有函数（`projectCompactMessagesForPayloadRecovery`、
  `logCompactPayloadRecoveryProjection`）留在 `compact-active.ts` 内，而不是另起
  `runtime/methods/*` 新文件——本次所有权边界只含 `compact-active.ts`；
  也不能下沉到 `core/src/compact/**`，因为 `projectMessagesForMediaBudget` 在
  `runtime/helpers`，而 `runtime/helpers → compact` 已是既有依赖方向
  （`compact-selection.ts:16` 引 `../../compact/rounds.js`），反向引用会成环。
  代价：`compact-active.ts` 从 725 行增至 752 行，该文件在 HEAD 就已触发 `max-lines`
  （上限 400）——**既有 error，数量未增加**。

### 验收场景（测试）

| 场景 | 断言 | 测试 |
| --- | --- | --- |
| 判定命中 | `context.statusCode:413`、`responseStatus:413`、`413 Payload Too Large`、`413 Request Entity Too Large`、`request too large`、`code:'request_too_large'`、`httpResponseStatus:413`、cause 链嵌套、裸对象 | I5-1 |
| 判定不误命中 | `model version 4130 is unavailable`、业务码 `4130`、429 限流、403 鉴权、`413 tokens > 200 maximum`、context-exceeded、media_payload_too_large、非对象输入 | I5-2 |
| 三轨互不吞并 | 413 既不是 context-exceeded 也不是 media-too-large；反之亦然 | I5-3 |
| 阶梯 | 12MiB → 0 → 耗尽；NaN/负数直接耗尽 | I5-4 |
| 恢复动作 | 按预算 oldest-first 剥离、最近的媒体保留、占位文案含 media_type；0 预算剥光且不抛错；默认旗标下 0 预算会抛错（证明 `preserveLatestUserMedia:false` 的必要性） | I5-5 |
| 接线 | 413 分支存在且先于另两条轨道；推进阶梯；耗尽 `throw error`；不复用丢轮次/截断；两份消息都重投影 | I5-6 |

### 偏差与覆盖面登记

- **偏差 D1（占位文案不含原始字节长度）**：jcode 的 marker 含
  `media_type=… original_base64_chars=…`（`lib.rs:683-690`）。ACode 复用聚合媒体预算投影，
  其占位文案含 media_type 但不含原始长度（`media-budget.ts:253-259`）。
  本次把原始/投影后字节数落在日志（`compact.request.payload_too_large.media_projection`）而不是
  provider 可见文案里：改文案需要动 `media-budget.ts`（边界外），且那是**所有**请求共用的投影，
  不宜为 compact 的一条恢复轨道改全局措辞。见「边界外建议 B1」。
- **覆盖面 C1（只接了 compact summary 请求）**：普通 turn 的 413 恢复点在
  `core/src/runtime/methods/turn-model-step.ts`（边界外），本次未接线；
  但判定函数放在共享的 `runtime/helpers/model-errors.ts`，turn 侧可直接复用。见「边界外建议 B2」。
- **覆盖面 C2（stream 回退会多传一次超大请求体）**：
  `core/src/runtime/methods/compact-summary-model-request.ts:263-271` 的短路清单
  （取消 / context-exceeded / media-too-large / setup 失败 / 已提交 content block）不含 413，
  因此 413 会先触发一次 non-streaming 回退（同一个超大 body 再上传一遍）才落到本轨道。
  正确性不受影响（回退同样 413 → 抛回 → 进入 M2 分支），代价是一次重复上传。见「边界外建议 B3」。
- **未做的验证**：没有对真实 provider 触发 413 的端到端验证（仓库内无该 harness，
  本审计也未联网）。M2 的验证由三部分组成：判定/阶梯/投影的单元测试（I5-1…I5-5）
  + 接线源码守卫（I5-6）+ 类型检查。`continue` 重试循环本身只被源码守卫覆盖，未被行为测试覆盖。

---

## 边界外建议（登记，不在本次所有权内实施）

| # | 建议 | 位置 | 理由 |
| --- | --- | --- | --- |
| B1 | 媒体剥离占位文案补 `original_bytes` | `core/src/runtime/helpers/media-budget.ts:253-259` | 对齐 jcode marker（偏差 D1）；影响所有请求的 provider 可见文案，需单独评审 |
| B2 | 普通 turn 请求接 413 恢复轨道 | `core/src/runtime/methods/turn-model-step.ts` | 判定函数已共享，缺 turn 侧接线（覆盖面 C1） |
| B3 | compact summary 的 stream 回退短路清单加入 413 | `core/src/runtime/methods/compact-summary-model-request.ts:263-271` | 避免 413 时把超大请求体重复上传一遍（覆盖面 C2） |
| B4 | 观察 O1：三份 usage 归一实现的收敛计划 | `contracts/src/model/index.ts`、`core/src/runtime/methods/turn-model-step-usage.ts`、`core/src/agent/message-history-usage.ts` | 若 provider 改 split accounting，三处必须同改，否则显示与决策分叉 |
| B5 | 预防侧媒体预算（40MiB）与 provider 请求体硬上限（Anthropic ~32MB）的关系复核 | `core/src/runtime/helpers/media-budget.ts:28` | 本次不改既有阈值常量语义；但 40MiB 高于 32MB 意味着预防侧无法排除 413，值得单独决策 |

## 复现命令

```bash
# 回归 + 守卫测试（23 例）
node --import tsx --test apps/acode-cli/tests/compact-invariants.test.mjs

# 类型检查（core 包）
node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/core/tsconfig.json --noEmit

# Lint（根门禁）
pnpm lint

# 格式（apps/acode-cli 自带 oxfmt；根 oxfmt 按 .prettierignore 不覆盖该目录）
cd apps/acode-cli && ./node_modules/.bin/oxfmt --check \
  packages/core/src/compact/manual.ts \
  packages/core/src/compact/payload-recovery.ts \
  packages/core/src/runtime/helpers/model-errors.ts \
  packages/core/src/runtime/methods/compact-active.ts
```

## 门禁实跑结果（本次改动，全部亲自执行）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 新增回归 + 守卫测试 | `node --import tsx --test apps/acode-cli/tests/compact-invariants.test.mjs` | **tests 23 / pass 23 / fail 0** |
| CLI 测试全量（estimator 改动的回归面） | `node --import tsx --test "apps/acode-cli/tests/*.test.mjs"` | **tests 336 / pass 336 / fail 0**（含本次 23 例） |
| core 类型检查 | `node apps/acode-cli/node_modules/typescript/bin/tsc -p apps/acode-cli/packages/core/tsconfig.json --noEmit` | **exit 0** |
| 架构检查 | `pnpm architecture:check --changed` | `architecture: OK`，`violations: 0 / baseline: 0 / new: 0` |
| 根 lint | `pnpm lint` | `Found 76 warnings and 0 errors`（= 既有基线）。**注意**：根 `.oxlintrc.json:70` 的 `ignorePatterns` 含 `apps/acode-cli`，因此这条门禁**不覆盖**本次改动文件 |
| CLI 侧 lint（真正覆盖本次文件） | `apps/acode-cli/node_modules/.bin/oxlint <文件> --no-ignore` | `manual.ts` / `payload-recovery.ts` / `compact/index.ts` / `model-errors.ts`：**0 warning / 0 error**；`compact-active.ts`：1 warning（`:183` `executionMaxOutputTokens` 未使用，HEAD 既有，本次未触碰该行）+ 1 error（`max-lines` 752 > 400；HEAD 为 725 行时已触发，**既有 error，数量未增加**） |
| 格式 | `cd apps/acode-cli && ./node_modules/.bin/oxfmt --check <本次 4 个 .ts>` | `All matched files use the correct format`。另：`compact/index.ts` 在 HEAD 就有一处 oxfmt 偏差（`:1-5` 的 `prompt.js` export 块；用 `git show HEAD:… \| oxfmt --stdin-filepath` 对照确认为既有），本次未顺手重排 |
| knip | `pnpm knip` | 仓库整体 exit 1（既有基线，大量未使用导出）。grep 本次新增符号（`COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS` / `COMPACT_PAYLOAD_RECOVERY_*` / `nextCompactPayloadRecoveryMediaBudget` / `isModelRequestPayloadTooLargeError`）**零命中** → 基线未扩大；唯一涉及本次文件的条目 `getMessagesToSummarize`（`compact/index.ts:14`、`manual.ts:82`）是 HEAD 既有的未使用导出 |

**未执行 / 未验证**：

- 根 `pnpm typecheck`（只覆盖 `packages/*`，不含 `apps/acode-cli`，对本次改动无信号）；
- 真实 provider 触发 413 的端到端验证（仓库内无该 harness，本审计全程未联网）——
  M2 的验证由单元测试（I5-1…I5-5）+ 接线源码守卫（I5-6）+ 类型检查组成，
  `continue` 重试循环本身只有源码守卫覆盖；
- 三条既有基线红测试（`packages/desktop/tests/no-official-platform.test.mjs`、
  `packages/ui/tests/no-telemetry.test.mjs`、`packages/ui/test/nonCliAcpRetirement.test.ts`）
  未运行、未修改、不计入本项。

## 状态所有者与接口（本次改动）

| 事实 | 唯一所有者 | 消费者 |
| --- | --- | --- |
| 内联媒体的估算 token 平价 | `core/src/compact/manual.ts`（`COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS`） | `compact/policy.ts`、`compact/microcompact.ts`、`runtime/helpers/compact-selection.ts`、`runtime/methods/compact.ts` |
| 请求体字节超限的判定 | `core/src/runtime/helpers/model-errors.ts`（`isModelRequestPayloadTooLargeError`） | `runtime/methods/compact-active.ts`（其余消费者待接，见 B2） |
| 413 恢复的媒体预算阶梯 | `core/src/compact/payload-recovery.ts` | `runtime/methods/compact-active.ts` |
| 媒体剥离动作本身 | `core/src/runtime/helpers/media-budget.ts`（既有，未改） | 所有模型请求 + compact 413 轨道 |
| 压缩是否可并发 | `runtime/methods/steering.ts` 的单活跃 turn 互斥（既有，未改） | manual / auto / reactive 三条压缩路径 |

事件顺序（413 轨道，同一次 compact attempt 内）：

```
build request → capability+聚合媒体预算投影 → [stripMediaForSummary?] → [413 阶梯预算投影?]
  → provider 请求 → 413
  → 阶梯推进（12MiB → 0 → 耗尽）→ continue 重建请求
  → 耗尽则 throw（不回落 token 轨道，不进 auto compact 外层重试）
```
