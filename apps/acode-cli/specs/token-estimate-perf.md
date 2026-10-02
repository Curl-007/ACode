# Token 估算投影性能优化（J5-L4）

方案条目 **J5-L4**（`docs/j5-performance-baseline.md` §7），性质：**纯性能重构，输出字节级不变**。

## 背景

基线剖析（`docs/j5-performance-baseline.md` §4.2/§5）实测：`estimateMessageTokens`
（`core/src/compact/manual.ts`）是 O(transcript) 全量重算，每个 model step 被调用 2~4 次
（microcompact 检查 `microcompact.ts:91`+`:145`、autocompact 策略 `policy.ts:102`、
usage 锚点 `runtime/methods/compact.ts:325/348`）。900KB transcript 单次 329µs、2.4MB 单次 821µs；
长会话（400 msg）每-step 本地核算墙钟线性退化 8×。

静态分析（每轮上下文装配）发现 `projectMessageContentForTokenEstimate`（manual.ts:158-183）
对每条消息把可见文本块 `textParts.join("\n\n")` 拼成一份**新字符串**，而调用方
`estimateMessageTokens`（manual.ts:126）**只取 `.length`**，从不用拼接后的字符串本体。
这份 join 分配是纯浪费：每次估算为每条多块消息分配一份全文副本，直接喂给 GC。

## 不变量（必须保持）

本优化**不得改变 `estimateMessageTokens` 对任何输入的输出**。它是 `compact-invariants.md`
（J1-3）审计钉住的估算函数，I1（图片平价 1600 token）等不变量依赖其精确语义。等价性论证：

- `textParts.join("\n\n").length` ≡ `Σ(part.length) + 2×(partCount−1)`（partCount≥1），partCount=0 时为 0。
  `"\n\n"` 恒为 2 字符；join 只在相邻 part 间插分隔符，故分隔符总贡献 = `2×(partCount−1)`。
- `textParts` 只收非空串（reasoning 块 `block.text.length>0` 才 push；其他块 `modelMessageContentBlockToText`
  结果 `.length>0` 才 push），故每个 part 贡献 ≥1，上式精确成立，无「空 part 多算分隔符」边界。
- 字符串内容（`typeof content === "string"`）路径：`textLength = content.length`，与 `text=content; text.length` 一致。
- 媒体平价（`inlineMediaTokens`）路径不变：仍按块累加 `COMPACT_ESTIMATE_INLINE_MEDIA_TOKENS`，与文本长度分轨。

结论：把投影返回从 `{inlineMediaTokens, text}` 改为 `{inlineMediaTokens, textLength}`，
其中 `textLength` 按上式累加而**不分配 join 字符串**，输出对任意**符合 `ModelMessageContent`
类型的契约内输入**逐位相同。契约外畸形输入（如 `text` 为非字符串）不在等价保证范围——旧版 join
字符串化与新版长度计数对此均为无意义值；M1 修复（`!(length > 0)` 守卫）确保此类输入不产 NaN、不崩溃
（与旧版 `text.length > 0` 过滤同构），但不保证两者数值相同。

## 实现

`core/src/compact/manual.ts`（唯一所有权；`projectMessageContentForTokenEstimate` 是私有函数，
唯一消费点是 `estimateMessageTokens:125-126`，改返回形状安全）：

1. `TokenEstimateProjection` 接口：`text: string` → `textLength: number`。
2. `projectMessageContentForTokenEstimate`：累加 `textLength`（首个 part 加 `len`，后续 part 加 `2+len`），
   不再 `textParts.push` + `join`。`modelMessageContentBlockToText(block)` 仍按块调用取 `.length`
   （per-block 字符串本就存在，不新增分配；省掉的是最终全文 join）。
3. `estimateMessageTokens:126`：`projection.text.length` → `projection.textLength`。

**不做**（本轮明确排除，登记 deferred）：
- 跨调用 memoization（缓存整份 transcript 估算）：消息在 microcompact 被 clone+变异
  （`microcompact.ts:90` `cloneLocalMicrocompactMessage`、`:139-142` 清 tool result），
  无稳定对象身份可作缓存键；强行缓存有 stale 风险，会破坏 J1-3 估算精确性。需要 turn-loop
  层的身份/不可变保证，属独立立项。
- toolCall input 的 `JSON.stringify`（`stringifyToolCallInputForTokenEstimate`）改无分配长度计算：
  精确匹配 JSON.stringify 输出长度（转义/unicode/数字格式）风险高，收益不抵正确性风险，不做。

## 验收

- 等价守卫测试（`apps/acode-cli/tests/token-estimate-perf.test.mjs`）：对覆盖
  字符串内容 / 单文本块 / 多文本块 / reasoning+text 混合 / 媒体块 / 空块 / toolCalls 的
  消息样本，断言优化后 `estimateMessageTokens` 输出与「join 后取 length」的参考实现逐位相同。
- 既有 `compact-invariants.test.mjs`（I1 图片平价等）全绿，证明不变量未破。
- 门禁：root typecheck、core 包 tsc、lint、arch、CLI 全量测试。

## 所有权边界

`core/src/compact/manual.ts`、本 spec、`apps/acode-cli/tests/token-estimate-perf.test.mjs`。
边界外（microcompact/policy/compact.ts 的调用频率、turn-loop 拷贝次数）只登记不改——
调用频率优化属 L4-deferred（memoization）与 L5（transcript 拷贝），见 `docs/j5-performance-baseline.md` §7。
