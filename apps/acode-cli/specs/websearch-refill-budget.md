# WebSearch refill 式预算 × 通用 quota-refill 件

状态：2026-10-15 落地（价值提取第二轮 W2-M1 件1）。机制形态参照外部成熟实现的
公开行为（每窗口名额上限 + 随时间连续回补 + 惰性结算 + 拒绝文案含恢复时间），
实现、命名与文案全部自撰；厂商内部代号与遥测事件名不进入本仓。

红线：拒绝事实只存在于工具结果与既有本地日志面，**不新增任何遥测/网络上报**
（`specs/no-telemetry.md`）。

## 背景

- `core/src/tool/handlers/websearch.ts` 此前没有任何会话级用量预算：一次失控的
  搜索循环（模型反复改query重试）只受 provider 侧限额与 turn 预算约束，本地没有
  「每窗口 N 次、随时间回补」的软闸门。
- 参考实现的行为形态（还原工程复核，见「证据对照」）：一次性总量预算被 refill 式
  预算替代——桶容量仍是每会话上限，但用掉的名额按「每小时 N 次」连续回补；超限
  拒绝是 **in-band 工具结果**（不是异常），文案包含限额、回补速率、恢复时间与
  「不要空等/不要绕过」的模型指引。
- ACode 既有 `ambient/usage-ledger`、cron/off-peak 派发面将来也会出现同形态的
  「每窗口 N 次 + 回补」预算需求，因此回补算法做成通用件而不是 websearch 私有。

## 产品规则

### R1 通用件：refill 式配额（`core/src/tool/quota-refill.ts`）

- `createRefillQuota({ resolveConfig, now? })` 返回 `{ tryConsume, peekRetryAfterMs }`。
- 配置快照 `RefillQuotaConfig`：
  - `limitPerWindow`：窗口内名额上限（桶容量）。**<= 0 = 预算关闭**（恒放行、
    不计数、永不拒绝）；
  - `windowMs`：回补窗口（非法值按缺省 1h）；
  - `refillPerWindow`：每窗口回补名额数，缺省 = `limitPerWindow`；0 = 不回补
    （退化为一次性总量）。
- **惰性结算**：回补只在 `tryConsume` / `peekRetryAfterMs` 被调用时按经过时间
  结算，无后台定时器。
- **桶满不攒信用**：`consumed === 0` 时信用累积器清零——空闲时间不能兑换成
  未来的突发额度。
- **速率热调整保守夹取**：一段结算区间的信用按 `min(新速率, 旧速率)` 累积；
  调高速率不能把上一段低速率区间追溯兑现。
- `resolveConfig` 每次结算重读：消费面（如 env 热调整）即时生效。
- 拒绝判定返回 `retryAfterMs`（>= 1）；不回补时为 `Infinity`（消费面必须表述为
  「不会自行恢复」，不得编造时间）。
- 状态是**实例私有**的：模块无共享可变态；每个消费面自持实例并自定键。
  **复用可能（登记）**：ambient 配额（`core/src/ambient/usage-ledger` 的每窗口
  派发上限）与 cron/off-peak 的派发限速是同形态需求，接入时各自 new 实例、
  以各自的身份键（workspace/automation）持有；本批不接线。

### R2 WebSearch 消费面（`core/src/tool/handlers/websearch.ts`）

- **预算键 = sessionId**：同一 session 的主 agent 与 subagent 共享同一份预算
  （与参考行为「shared by every agent in this session」一致）。长驻进程的
  session 配额实例按插入序逐出（保留上限 256）；逐出是软状态丢失，同 session
  再来只是从满桶重新开始，不构成正确性问题。
- **门禁位置**：handler 最前（模型/能力检查之前）——拒绝不消耗 provider 资源，
  也不依赖 model 存在。消费发生在尝试时点：后续失败（模型错误等）不退名额
  （与参考行为一致，失败也是真实用量）。
- **env 旋钮**（缺省开启，热调整即时生效）：
  - `ACODE_WEBSEARCH_BUDGET`：每窗口名额 N（非负整数字符串；`0` = 关闭预算；
    非法值按缺省 100）；
  - `ACODE_WEBSEARCH_BUDGET_WINDOW_MINUTES`：窗口粒度（分钟；非法/0 按缺省 60）。
- **拒绝形态 = in-band 工具结果**（不是异常）：合法 `WebSearchOutput`
  （`results: []`、`sources: []`、`webSearchRequests: 0`、指引文案在 `summary`），
  通过 runtimeOutputSchema 校验，模型按普通结果消费。
- **拒绝文案（自撰）必须包含**：限额与窗口、会话内共享事实、回补语义、
  **恢复时间**（`retryAfterMs` 人性化；不回补时说「不会自行恢复」）、「不要
  空等/不要循环重试」、以及**反绕过条款**（不得用 Bash curl/wget 打搜索引擎、
  不得经第三方 reader/proxy/archive 绕行）。
- **渲染面**：`formatModelContent` 用预算感知包装——零结果零来源（拒绝或真实
  零命中）时只渲染 summary，不带「必须附来源链接」提醒（没有可引用的东西）；
  有结果/来源时走既有渲染，行为不变。

## 证据对照（还原工程复核，2026-10-15）

| 参考行为 | 证据（只读复核） | ACode 落点 |
| --- | --- | --- |
| 桶+回补算法（惰性结算/桶空清零/速率夹取/retryAfter 公式） | `Cen/src/beautified-claude-code/_raw/chunk-r43r8drf.js:24`（`Ye` 预算工厂） | `quota-refill.ts`（算法同构，命名/实现自撰） |
| 超限拒绝 in-band 结果 + 文案要素（限额/回补/别空等/反绕过/env 提示） | `Cen/src/beautified-claude-code/chunk-3w5rm14n.js:2340-2400` | `websearch.ts` 拒绝路径（文案自撰，无厂商事件名） |
| 默认 100 次/h 回补、总量上限 env 可调 | 同上（`ne=100`、`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`） | `ACODE_WEBSEARCH_BUDGET`（缺省 100）+ 窗口旋钮 |

参考实现的 telemetry 事件（`web_search_session_cap`）与厂商 env 名**不搬**
（no-telemetry 红线 + 文案自撰纪律）。

## 状态所有者

| 状态 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 名额计数 / 信用累积 / 结算锚点 | `RefillQuota` 实例（quota-refill.ts） | 实例私有，无模块级可变态 |
| session → quota 映射与逐出 | `websearch.ts` 模块级 Map | 软状态；逐出只影响预算余量 |
| 配置事实 | env（每次结算重读） | 无缓存副本，热调整即生效 |

## 接口

```ts
// core/src/tool/quota-refill.ts
export interface RefillQuotaConfig {
  limitPerWindow: number; // <=0 = 关闭
  windowMs: number;
  refillPerWindow?: number; // 缺省 = limitPerWindow；0 = 不回补
}
export interface RefillQuotaVerdict { allowed: boolean; retryAfterMs?: number }
export interface RefillQuota {
  tryConsume(): RefillQuotaVerdict;
  peekRetryAfterMs(): number;
}
export function createRefillQuota(options: {
  resolveConfig: () => RefillQuotaConfig;
  now?: () => number;
}): RefillQuota;
```

## 验收场景

1. 假时钟下：limit=3/窗口 60min → 第 4 次立即拒绝且 `retryAfterMs` ≈ 20min
   （连续回补速率 3/h → 每 20min 一个名额）；推进 20min 后放行。
2. limit=0 → 恒放行（预算关闭）；refillPerWindow=0 → 耗尽后 `retryAfterMs=Infinity`。
3. 桶满不攒信用：空闲 3 个窗口后突发仍只能消费 limit 个名额。
4. 速率热调整保守夹取：低速率区间不因后来调高速率而多兑现信用。
5. handler 超限拒绝：返回合法 `WebSearchOutput`（results/sources 空、summary 含
   恢复时间与反绕过条款、webSearchRequests=0），不抛异常；`formatModelContent`
   对该输出不渲染来源提醒。
6. 预算按 session 隔离：不同 sessionId 各自满桶；同 sessionId（含 subagent 复用
   同 id）共享耗尽。

## 常量定值记录

- 缺省 N=100 / 窗口=60min：对齐参考实现缺省量级；env 可调，判据不入代码。
- session 配额实例保留上限 256：长驻进程内存护栏，逐出语义见 R2。

## 不在本项范围

- ambient / cron 面的实际接线（R1 只登记复用可能）。
- provider 侧真实用量对账（本预算是本地软闸门，不与账单核对）。
- 把预算余量暴露到 UI/协议面（拒绝文案即产品面）。
