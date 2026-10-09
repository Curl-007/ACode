# 技术债登记册（Tech Debt Backlog）

> 建立于 2026-10-05 深度审查落地批次，2026-10-09 按 commit `f9ed8961`（`dev/0.0.7`）复测同步。当前量化基线（2026-10-09 17:34，`dev/0.0.8` @ `fa9d6d0c`，相对 `origin/dev/0.0.8` ahead 19 / 相对 `origin/main` ahead 21）：architecture 超限 415 / new 0 / regrown 0，managed 18 模块 776 文件 / legacy 5 模块 3463 文件；lint 145 warnings / 0 errors（扫描 4333 文件）；根 `pnpm test` 2004 tests / 2001 pass / 3 skip / 0 fail，CLI 全套 1338 / 1337 pass / 1 skip / 0 fail；typecheck 单一门禁三阶段退出 0。实测证据见[修复记录](reviews/2026-10-08/fix-status-2026-10-09.md)文首当前复核表。本文件是**索引**：每项债务的动机、方案与验收标准在各自的 spec/计划文档里，这里只登记状态与量化基线。原则（与 architecture ratchet 相同）：每项债务要么有只减不增的门禁，要么有带验收标准的计划文档——不允许无登记的债务。

## 有门禁的债务（恶化即红）

| 债务 | 量化基线（2026-10-05） | 门禁 | 收敛计划 |
| --- | --- | --- | --- |
| 超 400 行的存量源文件 | 415 个（`.architecture-baseline.json` legacy ratchet 条目；2026-10-05 为 492，2026-10-09 批二收紧至 415） | `pnpm architecture:check`：新增超限文件即失败；测试/评测文件豁免 | 各域拆分 spec（host-index-domain-map.md、god-component-split-plan.md 等）；每次拆分后 `architecture:baseline:update` 收紧 |
| task index 派生库写入方 | 10 个登记文件 | `packages/services/tests/task-index-writers.test.mjs` 白名单 | `packages/services/specs/task-index-write-ownership.md` |
| bootstrap 跨包深导入 | 0（当前干净） | `apps/acode-cli/tests/bootstrap-boundary.test.mjs` | `apps/acode-cli/specs/bootstrap-app-boundary.md` W1/W2 |
| node-forge 环境声明副本 | 1 份权威（services） | `apps/acode-cli/tests/acp-host-adapter.test.mjs` F8 | 已收敛（单一事实源） |
| 遥测/官方平台回归 | 0 | desktop/ui/shared 各自 no-telemetry、no-official-platform 测试 | 已收敛 |
| renderer / CLI 自身入口类型检查 | 0 个诊断（2026-10-09；2026-10-05 的 renderer 112 个错误已修完） | 单一入口 `scripts/typecheck-gate.mjs`（根 `pnpm typecheck`）：`packages` barrier 后 renderer 与 CLI 并行；`apps/acode-cli/tests/typecheck-gate.test.mjs` 7/7 覆盖注入必红与 workflow 旁路扫描 | 已收敛（U01 完成）；`fa9d6d0c` 修正 renderer 守护测试盯已删内联命令的回归。剩余为 Node `24.14.0`、clean checkout 与三平台 runner 的首次 CI 确认，规则见 `docs/specs/cli-validation-gates.md` 第 3-6 条 |
| RPC descriptor 方法/事件表与参数校验 | 全部 `createServiceDescriptor` 的方法与 `onDynamicXxx` 事件均登记 `argumentValidators`（2026-10-09 批二清零） | `packages/services/tests/rpc-descriptor-surface.test.mjs`：缺表、表外键或漏登记校验器即红（复测 1/1 通过） | `packages/rpc/specs/rpc-service-boundary.md` 规则 7；普通 `onXxx` 事件的豁免依据写在 spec 与门禁注释 |
| managed 模块例外登记 | 42 条 `expires: "2026-12-31"`（`max-file-lines` 28、`disable-count` 14） | `pnpm architecture:check`：到期或超出登记范围即红；例外不刷新 `.architecture-baseline.json` | 各模块边界 spec（`cli-workflow-package-boundary.md`、`architecture-contracts-module.md`、各 `module-boundary.md`）；到期前拆文件偿还 |

## 有计划的债务（里程碑推进）

| 债务 | 现状 | 计划文档 |
| --- | --- | --- |
| 三代协议面并存（legacy 3,714 行 + legacy server 48 文件 14.7k 行 + v4） | legacy 面冻结（只删不增） | `docs/legacy-protocol-convergence-plan.md` M1-M4 |
| UI 未读三处存储（meta.unreadAt / query cache overlay / legacy map） | 写入方维持现状，禁止新增读取方 | `packages/ui/specs/unread-single-source.md` S1-S3（S3 需 E2E） |
| host/index.ts 剩余域（2,204 行） | automation 派发域已抽出（第一批） | `packages/desktop/specs/host-index-domain-map.md` |
| SessionPane（3,629 行）/ConversationComposer（2,143 行）上帝组件 | 附件预览接缝已抽出（第一批） | `packages/ui/specs/god-component-split-plan.md` |
| AgentRuntime ~110 字段共享可变（95 个方法文件原型注入） | lifecycle 状态簇可写扁平字段已清零，spec 断言扩到 I1-I8；context/turn/projection/cache 仍待分批 | `apps/acode-cli/specs/runtime-state-ownership.md`（I1-I8 断言化批次） |
| bootstrap workflow 应用层独立成包 | W1-R3 物理拆包完成：引擎族 66 文件迁入 `@acode/cli-workflow`，`bootstrap/src/app` 现约 11.3k 行 `.ts`/`.tsx`（2026-10-09 实测），只剩五个装配接缝 | `apps/acode-cli/specs/bootstrap-app-boundary.md` W1；W2 待 M3 |

## 待立项的债务（本批核实、暂无门禁）

| 债务 | 量化基线（2026-10-05 实测） | 说明 |
| --- | --- | --- |
| knip unused exports/types backlog | 454 个 unused exports + 257 个 unused exported types（本批已将 files/dependencies/devDependencies 三类清理并纳入门禁） | 逐项需 dep-refs 验证后删除或标记 `@public`；集中在 `packages/shared/src/validation.ts`（成套死 schema）等 |
| formal-proof 一致性无机械对照 | 两侧裁决表人工对齐（projection-state.ts ↔ formal-proof/model.ts） | 原「formal-proof-consistency 黄金测试」宣称不存在，注释已改为如实陈述；建黄金测试或删除 formal-proof 包二选一 |
| desktop main 的两个类型镜像文件 | `src/main/schedulerProtocolTypes.ts`（镜像 scheduler 协议）、`src/main/desktopWindowsAppUserModelId.ts`（镜像构建脚本逻辑） | rootDir=src/main 边界导致的权宜镜像，头部已写同步义务注释；彻底修法是给 tsconfig.main.json 加工程引用或给 scripts 补 .d.mts（2026-10-05 main 类型修绿批次登记） |
| apps/acode-cli/pnpm-lock.yaml 嵌套锁文件过期 | 相对嵌套 package.json 的依赖删除已失同步；`pnpm -C apps/acode-cli install --lockfile-only` 因既有结构问题（@acode/model-option-map 在根 workspace）无法再生 | 无任何 scripts/CI 消费该锁文件（2026-10-05 grep 核实）；应删除或修复嵌套 workspace 结构，二选一 |
| 高风险执行链路零行为测试 | node-execution-adapter（约 4.3k 行）、v4-gateway（3,336 行）、TUI（8k 行） | 「决定要不要执行」有 8+ 测试文件，「实际执行」没有 |
| desktop-continuous / web-remote-replayable 同路径 if 分叉 | 分叉点散落 acodeAgentConnectionScope / acodeTaskServiceAdapter / host | 需收口成显式策略对象；改动必须同时验证两种语义（AGENTS.md） |
| Main 进程两套窗口 ID 空间（win.id vs webContents.id） | 5 个注册表跨 ID 手工对齐 | 品牌类型方案随 main 类型门禁落地后实施 |
