# Session module boundary

## Scope

`packages/services/src/session`（56 文件）是会话/任务域服务模块，owner
`conversation`。本 spec 登记其纳管为架构模块（managed，ARCH-04 batch 3）。
session 嵌套在 services 包内，无独立 package.json；对外经 services 的
`index.ts` / `node.ts` barrel re-export 出面。纳管不改变运行时行为与
services 包的公开 API。

## Ownership and invariants

- `TaskIndexRepo` / `AutomationRepo` / `OffPeakTaskRepo` 是各自 sqlite 表的
  唯一写入所有者；service 层（AcodeTaskService/AutomationService/
  OffPeakTaskService）只做编排，不另存第二份任务状态。`TaskIndexRepo` 有意
  不入 contract.ts：task-index-writers 守护测试
  （specs/task-index-write-ownership.md）把任何引用它的文件都视为待评审的
  写入面（barrel 转发也是引用），契约面只暴露 IACodeTaskService 与纯投影。
- 调度语义是纯函数：`computeRetryAt`（base 30s、cap 15min、封顶
  DISPATCH_MAX_ATTEMPTS=5）、`computeNextRunAt` / `computeAutomationNextRunAt` /
  `isValidCronExpr`（croner 构造即校验）——无状态、无 IO、可单测。
- claim/stale 语义：automation 与 off-peak 同库不同表、常量全独立
  （`CLAIM_STALE_MS` vs `OFF_PEAK_CLAIM_STALE_MS`），不共享调度状态。
- mailbox 消息自带 `requestId`，投递结果以 `SessionMessageDeliveryResult`
  闭环（success/failed 二态 + 可选 error），不引入第二套确认通道。

## Public boundary（登记的迁移状态）

- `contract.ts` 是迁移目标入口，已落地（55 行 / 25 named re-export：任务索引/列表、
  automation、off-peak、mailbox 等名字），但 **publicEntrypoints 有意为空**：
  checker 只在目标模块声明了任一边界（精确入口 / 通配入口 / 内部边白名单）时才校验
  deep-import（`scripts/architecture/index.mjs` 的 `moduleHasBoundary`）。
- **内部边白名单机制（ARCH-04 resolver 缺口④，2026-10-22 落地）**：session 用
  `architecture-policy.yaml` 的 `internalEdgeAllowlist` 逐条冻结 **24 条** services→session
  存量实现文件直引（checker 口径 = distinct 非 test 跨模块 (from,to) 对，与 deep-import
  指纹一致；review §5 说的约 39-40 是含 test 文件与 specifier 重复计数的另一口径）。白名单
  只精确匹配 (from,to) 对，不做前缀/通配，范围最窄且可审计。效果：既有 24 条边保持合法，
  **任何未登记的新 services→session 边立即报 deep-import**——把「惰性保持合法」变成
  「新增需显式登记」，止住内部边增长（不再靠评审纪律）。
- 收敛路径（ratchet）：新代码从 `contract.ts` 导入；存量内部边逐条迁到契约面，迁一条就从
  白名单删一条；白名单见底即把 `contract.ts` 注册为 publicEntrypoints、清空 `internalEdgeAllowlist`，
  session 转为常规 deep-import 强校验。**例外到期（2026-12-31）前白名单必须见底**——这与
  `onboard-b3-session-over-limit` / `-disables` 两个例外同批到期，是同一里程碑的三面
  （拆 7 个 over-limit 文件 + 移 8 处 disable + 迁 24 条内部边）。
- 里程碑工作量（评估，不在本轮实施）：24 条边集中在 `acodeTaskService.ts`(6)、`offPeakTask.ts`(3)、
  `acodeTaskListTypes.ts`(2)、`taskChangeSummary.ts`(2) 等 15 个 target；importer 集中在
  `services/src/node.ts`(装配根，12 条)、`index.ts`(barrel，5 条)、`accessor.ts`(2 条)。
  barrel/装配根的边迁移即「contract.ts 补名 + 调用方改 import 路径」，预估 1-2 人日；
  `taskIndexRepo` 有意不入 contract.ts（见 Ownership），其 1 条边需单独设计只读投影出口。
- session 模块内部 0 文件级环（纳管时实测）。

## Dependency direction

- requires：`[provider, rpc, services, shared]`（module.ts 与策略一致）。
  - shared（39 边）：协议/类型，全部命中包根 index.ts 与
    acode-protocol-v4/index.ts 两个登记入口。
  - services（7 边，双向耦合的 session 侧）：5 条 type-only
    （`ServiceLogger` ×4：offPeakTaskService/offPeakMockGateway/
    offPeakServerClient/offPeakRuntimeModel；`IAccountRequestAuthService` ×1）
    - 2 条值导入（`descriptors.js` 的 createServiceDescriptor：offPeakTask.ts；
      `accountProviderRequestAuthService.js` 的 AccountRequestCredentialUnavailableError：
      offPeakRuntimeModel.ts）。
  - rpc（1 边）：`Event` 类型（acodeTaskService.ts）。
  - provider（1 边）：`ModelSelection` / `ModelSelectionValidation` 类型
    （offPeakTaskService.ts）。
- **已登记债务：session ↔ services 双向模块耦合**（services→session 24 边，
  见 Public boundary 的 internalEdgeAllowlist；session→services 7 边）。legal 化
  依据是 requires 里的 `services`；解除方向是 descriptors/serviceLogger/auth 接口
  下沉中立叶子模块（或随 services 纳管时统一分层），不是继续加 re-export 兜底。
- 层：单层 `app`（`layers: { app: "." }`）——直接持有 sqlite（node:sqlite）、
  定时器与网络 client（55 处 `node:` import），声明 domain 层会触发 domain-io。

## Registered debt（例外，expires 2026-12-31）

- `onboard-b3-session-over-limit`：7 个存量超 400 行文件（taskIndexRepo.ts
  2567 行为最大头）；例外只冻结存量，新增超限文件仍阻断。
- `onboard-b3-session-disables`：8 个含 lint disable 的存量文件。
- 到期前应拆分文件、移除 disable，而不是续期例外。

## Acceptance scenarios

1. `node scripts/architecture/architecture-check.mjs check`：session 零新违规
   （module-dependency、cycle、max-file-lines、disable-count、
   missing-module-artifact 全绿）；publicEntrypoints 为空 + internalEdgeAllowlist
   冻结 24 条存量边 → 无 missing-public-entrypoint，既有边放行、新增边报
   deep-import；baseline 不新增。
2. 新增一条未登记的 services→session 直引，check 立即报 deep-import（白名单
   止增长的验收：fixture `internalEdgeAllowlist：登记边放行，未登记新边报
   deep-import`，apps/acode-cli/tests/architecture-coverage.test.mjs）。
3. `node scripts/architecture/architecture-check.mjs context session` 展示
   owner conversation 与 contract。
4. `pnpm --filter @acode/services test` 全绿（session 无独立 test 入口）。
5. `pnpm exec tsc -b packages/services` 通过（contract.example.ts 参与编译）。
