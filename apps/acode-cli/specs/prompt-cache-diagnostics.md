# Spec：prompt-cache miss-cause 归因诊断（批次 2 C4）

> 状态：实施批次（2026-10-03，`docs/capability-uplift-plan.md` 批次 2）。
> 机制借鉴：zoode 还原的 Claude Code `prompt_cache` 健康对象（hit_ratio + miss-cause
> 闭集）。按边界纪律只搬运机制设计，落地为 ACode 自有实现，因集按 ACode 真实可检测
> 事件重新推导（不照抄 Claude Code 的因名）。
> 硬约束：`no-telemetry.md` —— 诊断只进本地 debug 面，零网络外发。

## 背景（已核实的事实，修正提升方案的两处假设）

### 命中率已有、归因全无

- **Path A（provider-usage 驱动，GUI 命中率的唯一来源）**：
  `core/src/runtime/methods/turn-model-step-usage.ts#recordMainTurnCacheHitUsage`
  按 `usage.cacheReadTokens` 判命中（miss = `cacheReadTokens===0 && inputTokens>0`），
  产出 `latestHitRate` 并进 `MainTurnCacheHitAggregate`（`runtime/types.ts:277-282`，
  纯内存，resume/rewind 时经 `mainTurnCacheHitAggregateFromMessages` 从持久化 tokens
  重建）；经 `ModelComplete.cacheHit`（`contracts/src/events/session.events.ts:765-777`）
  → v4 `product-projection.ts:4495` **原样**进 snapshot → UI。
- **Path B（`setCacheMiss` 旗标驱动）只到 TUI 侧栏与 debug analyzer，从不进 GUI/协议
  cacheHit**。提升方案原设想「在 setCacheMiss 调用点附 cause」落在 Path B——归因会
  到不了任何展示面。本 spec 的归因点改为 **Path A**。
- **既有"miss 事件"的真实面目**（与提升方案描述的差异）：
  - `turn.ts:520` 的 `setCacheMiss()` 是**每 turn 无条件重置**，不是 interrupt 标记；
    interrupt（cancelled TurnComplete）根本不携带 cacheStats、无任何标记。
  - compaction/microcompact/context-refresh 经 `replaceMessages` **隐式**重置旗标，
    不调用 setCacheMiss。
  - model 切换、system prompt/tools 变化、provider TTL 过期：**今天完全无检测**。
    仅 model 切换有相邻探测器（`recordPendingModelChange`，timeline 持久化）、
    闲置时长有相邻事实（`lastAssistantCompletedAtMs`）。

### 版本偏斜危险点（同批加宽的强制理由）

v4 projection 把 `cacheHit` 原样放进 `conversationSnapshotSchema` →
`conversationTopicFrameSchema`，**客户端**（`packages/ui/src/v4/agentConversationTransport.ts:115`）
用 `packages/shared` 的 `.strict()` 镜像 schema 校验。CLI 生产侧加字段而 shared 镜像
不同批加宽 = 每个桌面端 `SUBSCRIPTION_CONTENT_REJECTED` 确定性内容故障（P0 教训，
`session-mapper.ts:853-861` 注释在案）。**生产侧与全部镜像必须同一提交加宽。**

## 产品规则

### R1 miss-cause 闭集（按 ACode 真实可检测事件推导）

```
conversation_rewind   会话回溯重建（rewind-message.ts:726 既有事件点）
control_only_turn     无模型输出的边界 turn（control-only-turn.ts:113）
compaction            全量压缩或 microcompact 的 replaceMessages（compact-active.ts:672 / microcompact.ts:74）
context_refresh       context 前缀重建（context-refresh.ts:45）
model_changed         本次请求模型 ≠ 上次记录的请求模型（归因时判定，见 R2）
idle_ttl_suspected    推断值：miss 且距上次 assistant 完成 > CACHE_TTL_SUSPECT_MS（5 分钟，
                      对齐主流 provider cache TTL 量级；UI 文案必须标注"疑似"）
unknown               无本地事件可归因（含 provider 侧静默逐出、interrupt 后首请求）
```

- **phase 2 登记不实现**：`system_prompt_changed` / `tools_changed`——需要 runtime
  逐 turn hash 快照对比（可复用 `context/manifest.ts` 的 `hashSectionText`/
  `computeManifestSectionsHash` 纯函数，但对比回路不存在）；tools 变化探测器完全
  不存在。先落 7 因闭集，避免为两个因引入每 turn 全量 hash 的成本。
- 因集唯一家在 `contracts`（`PromptCacheMissCause` 联合类型 + 常量数组）；
  **shared 镜像 schema 用开放 `z.record(z.string(), 非负整数)`** 不复刻枚举——未来
  CLI 加因不需要再动 shared（偏斜安全），闭集纪律由生产侧类型 + 单测钉住。

### R2 归因点与优先级（Path A 单点归因）

- 归因发生在 `recordMainTurnCacheHitUsage` 判定 miss 的同一处：
  **显式 pending cause > model_changed > idle_ttl_suspected > unknown**。
  显式事件（R1 前四项）在事件点写入 runtime 的 `pendingCacheMissCause`；
  归因消费后立即清空，**命中时也清空**（防止陈旧 pending 归因给后续无关 miss）。
- model_changed 判定：runtime 记 `lastRequestModelId`，本步请求模型不同即命中
  （自包含在归因点，不做 timeline 标记的跨层搬运）。
- 计数进 runtime `cacheMissCauseCounts: Partial<Record<PromptCacheMissCause, number>>`，
  随 `cacheHit` 载荷以 `missCauses` 快照形式下发（只增不减的进程内累计）。

### R3 生命周期：进程内累计，不持久化

- 计数器与 `MainTurnCacheHitAggregate` 同生命周期（内存态）；resume/rewind 的聚合
  重建路径**从空计数开始**（tokens 可重建命中率、不可重建归因——诚实边界，
  与 SessionDebug WeakMap 语义一致）。不落 session store、不进 journal、零 schema 迁移。

### R4 协议与镜像同批加宽清单

| 层 | 文件 | 改动 |
|---|---|---|
| CLI contracts | `contracts/src/events/session.events.ts` | `ModelCompletePayload.cacheHit` 增可选 `missCauses`；新 `PromptCacheMissCause` 类型+常量 |
| CLI v4 | `bootstrap/.../product-projection.ts` | 零改动（:4495 原样透传自动携带）|
| shared 镜像 | `acode-protocol-legacy-types.ts#acodeSessionContextCacheUsageSchema` | `.strict()` 对象增 `missCauses: z.record(z.string(), z.number().int().nonnegative()).optional()` |
| shared 类型 | `acode-task-types-core.ts#ACodeContextCacheUsage` | 增 `missCauses?: Record<string, number>` |
| services 中继 | `acodeTaskServiceAdapter.ts#contextCacheUsageFromPayload` | 显式字段挑取处补 missCauses（否则 v3 链路静默丢弃）|
| session-debug | `bootstrap/.../session-debug.ts` + shared `session-debug.ts` schema | 观测面接受 model_complete 累计因集；snapshot cache 镜像同批加宽 |
| v3 冷重建 | `session-mapper.ts#contextCacheUsageFromMessages` | **不加**（R3：不可重建，缺席即语义）|

### R5 UI 落点：DeveloperToolsPane（session-debug 面）

- 最小落点：`packages/ui/src/DeveloperToolsPane.tsx` 既有 cache 汇总网格增 miss-cause
  行（`font-mono`/`tabular-nums`，`tokenDebug.*` i18n 键 en-US/zh-CN 双语，
  `idle_ttl_suspected` 文案带「疑似」）。数据走 `useSessionDebug` 既有 1s 轮询，
  **不动** contextUsage 弹层（其 props 收窄、双 feed、dedupe 等式三处加宽留 phase 2）。
- `CodingPlanUsagePanel` 的 cacheHitRate 是 **provider 套餐 API 的同名异物**，禁止混用。

### R6 no-telemetry 红线

因集与计数只进本地 debug 面（host RPC / WeakMap / 内存聚合），不新增任何网络出口；
守护测试仿 `no-telemetry.test.mjs` 负向断言。

## 状态所有者

```
事件点（core：rewind / control-only / compact / microcompact / context-refresh）
   └─ 写 runtime.pendingCacheMissCause（单格，消费即清）
recordMainTurnCacheHitUsage（归因唯一判定点，Path A）
   ├─ runtime.cacheMissCauseCounts（进程内累计，唯一事实源）
   ├─ runtime.lastRequestModelId（model_changed 判定输入）
   └─ cacheHit.missCauses 快照 → ModelComplete 事件
        ├─ v4 product-projection 原样透传 → snapshot（shared strict 镜像已同批加宽）
        └─ bootstrap session-debug 累计 → DeveloperToolsPane（本地轮询）
TUI Path B（lastCacheHit 旗标/CacheStats wire 形态）：零改动。
```

## 验收场景

1. 显式事件归因：rewind/compact/context-refresh/control-only 后的首个 miss 步分别计入
   对应因；计数只增；`missCauses` 随 cacheHit 下发且 ∈ 闭集。
2. 优先级：同 turn 先 compact 后 miss → compaction（显式胜出）；无显式事件 + 换模型 →
   model_changed；无显式 + 同模型 + 超 5 分钟闲置 → idle_ttl_suspected；其余 → unknown。
3. 命中不计数且清空 pending（陈旧 pending 不污染后续 miss）。
4. resume/rewind 重建后计数从空开始（R3），命中率重建行为不回归。
5. 版本偏斜守护：shared 镜像 schema 接受带/不带 missCauses 两种载荷；services 中继
   挑取字段完整（源码不变量测试钉住三处同批加宽点）。
6. no-telemetry：诊断链路零网络符号（负向断言）。
7. UI：DeveloperToolsPane 出现因集行、双语键齐全、idle 因带「疑似」标注。
8. 验证命令：`node --import tsx --test apps/acode-cli/tests/prompt-cache-diagnostics.test.mjs`；
   根 `pnpm typecheck`；CLI contracts/core/bootstrap tsc；`pnpm lint`；
   `pnpm architecture:check -- --changed`。

## 不在本 spec 范围

- `system_prompt_changed` / `tools_changed` runtime hash 对比回路（phase 2 登记）。
- contextUsage 弹层的因集 breakdown（phase 2；含 areTaskUsageCachesEqual 加宽）。
- 因集计数的跨重启持久化（R3 裁决：与 SessionDebug 同语义）。
- TUI 侧栏展示因集（Path B 零改动）。
- provider 真实 TTL 的精确探测（只能疑似推断，文案如实标注）。
