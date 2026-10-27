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

## Public boundary（迁移已完成，2026-10-27）

- `contract.ts` 是**已注册的公开入口**（`architecture-policy.yaml` 的 `publicEntrypoints`），
  覆盖全部消费方符号：任务索引/列表投影与 `IACodeTaskService`、automation 调度（repo/service/
  cron/手动触发语义）、off-peak（repo/service/client/mock/上游模型解析与鉴权装配）、
  跨会话 mailbox 类型、会话模式与标题派生。deep-import 对 session **强校验**（不再是迁移态的
  惰性放行）。
- **`internalEdgeAllowlist` 保留 15 条**（原 24 条迁移态白名单已收口），全部是写入路径或装配
  机器件，刻意不经消费契约：
  - `TaskIndexRepo` 构造边 **5 条**（node.ts 装配根、acodeAgentService、acodeTaskIndexSyncer、
    acodeTaskServiceAdapter、repairSubagentTaskIndex）。task-index-writers 守护把源码中对该
    repo 符号的**任何文本引用**都当待评审写入面（barrel 转发乃至注释都算），放进 contract.ts
    会让每个消费方都成为登记写入方、守护失效。实测验证过两条替代路径均被守护判红：加
    `composition.ts` 转发叶子、以及在 contract.ts 里以类名书写说明注释。故 contract.ts 的
    文件头刻意用描述性说法而不写该类名——改动该注释时须保持这一写法。5 个引用方全部已在
    task-index-writers 白名单内（双重登记：写所有权守护 + internalEdgeAllowlist）。
  - claude-native / external-import 会话导入机器件 **6 条**（adapter 与 repair 专属消费）。
  - tasksDatabase startup/prepared **2 条**（只由 storage-startup 消费）。
  - mcpWorkspaceScope **1 条**（acode-session 专属 MCP scope 装配）。
  - acodeTaskIndexSyncer 的 `acodeTaskListTypes` 边已迁入契约（不再是白名单项）。
- **修复了一处 resolver 盲区（本轮实测发现）**：checker 只解析 tsconfig paths 与 package.json
  `exports`，**不**解析 package.json `imports` 字段，故 services 的 102 处 `#src/...` 导入对
  deep-import 门禁完全不可见。原 24 条白名单只登记了相对路径形态的边，**23 条 `#src/session/*`
  边从未受管**——「止增机制在位」的结论对这批边不成立（正是 review §3 26R2-03 的同构问题：
  守护边界窄于成文规则）。修法：`global.aliasRules` 新增 `#src/* → packages/services/src/*`
  （仅 services 包声明该别名，故规则作用面精确），并补 fixture 守护
  `apps/acode-cli/tests/architecture-coverage.test.mjs`「包私有 #src/* 别名…被拦截（真负例）」
  与「去掉 aliasRule 即不被解析」双向钉住，防止盲区静默重开。
- 收敛纪律（继续有效）：新代码一律从 `contract.ts` 导入；需要新的写入/装配边时先在
  internalEdgeAllowlist 登记并说明为何不能进消费契约（TaskIndexRepo 的判据是写所有权守护），
  不允许直引实现文件了事。
- 里程碑工作量（已落地，2026-10-27）：迁移前共 **47 条**真实 services→session 边——24 条相对
  路径形态（原 internalEdgeAllowlist，门禁可见）+ **23 条 `#src/session/*` 形态（门禁不可见）**。
  迁移后 **15 条**保留登记（1 条相对 + 14 条 `#src`），全部是上述写入/装配面；其余 32 条消费方
  边已改指 `contract.ts`。
  **原评估低估了两点**：① 「`taskIndexRepo` 只 1 条边需单独设计」实为 **5 条写入方边**，因为
  其中 4 条是 `#src` 形态、门禁看不见；② 白名单「见底」在补齐别名解析前无法真正成立——24 条
  只是可见面的数字。review §5 的约 39-40 是含 test/specifier 重复计数的另一口径。
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
