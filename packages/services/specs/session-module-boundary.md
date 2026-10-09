# Session module boundary

## Scope

`packages/services/src/session`（52 文件）是会话/任务域服务模块，owner
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

- `contract.ts` 是迁移目标入口，已落地（精选面：任务索引/列表、automation、
  off-peak、mailbox 五组名字），但 **publicEntrypoints 有意为空**：
  checker 只在入口列表非空时校验 deep-import（scripts/architecture/index.mjs），
  空列表使 services→session 的 31 条内部边（15 个实现文件，经 services
  index.ts/node.ts barrel 出面）保持合法，而不是在纳管当天变成 31 条违规。
- 收敛路径（ratchet）：新代码从 `contract.ts` 导入；存量内部边逐条迁到契约面；
  迁移完成后把 contract.ts 注册为入口并清空直引。注册入口之前不得新增
  services→session 的实现文件直引（评审纪律，checker 暂不阻断）。
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
- **已登记债务：session ↔ services 双向模块耦合**（services→session 31 边、
  session→services 7 边）。legal 化依据是 requires 里的 `services`；解除方向是
  descriptors/serviceLogger/auth 接口下沉中立叶子模块（或随 services 纳管时
  统一分层），不是继续加 re-export 兜底。
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
   missing-module-artifact 全绿）；publicEntrypoints 为空 → 无
   missing-public-entrypoint、deep-import 惰性；baseline 不新增。
2. `node scripts/architecture/architecture-check.mjs context session` 展示
   owner conversation 与 contract。
3. `pnpm --filter @acode/services test` 全绿（session 无独立 test 入口）。
4. `pnpm exec tsc -b packages/services` 通过（contract.example.ts 参与编译）。
