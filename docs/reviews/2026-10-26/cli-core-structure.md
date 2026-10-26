# ACode 1.0.4 深度 Review · CLI core 内部结构

审查日期：2026-10-26（Asia/Shanghai）。基线：`dev/1.0.4`，提交 `6b2bc3fc`。方法：只读源码审查 + 上轮（2026-10-22，基线 `ebe9033b`）修复逐条核验 + 全 core/bootstrap 迁移缺口扫描。总入口见 [../../project-review-2026-10-26.md](../../project-review-2026-10-26.md)。

范围：`apps/acode-cli/packages/core` 内部结构 + `bootstrap/src/app/` 装配层 + product-projection。状态所有权、原型注入模式、模块级全局状态、bootstrap 边界。运行时 admission 行为见 [cli-runtime.md](cli-runtime.md)。

---

## 1. 上轮修复回归核对

| finding | 声称修复 | 核验结论 | 当前证据（file:line + 计数） |
|---|---|---|---|
| **R1-01 [P1]** 原型注入 + `this:Internal` 使 ~180 方法可绕过 owner 只读约束读写 ~50 扁平字段 | 7 个 turn 时序字段 → WeakMap owner；负向 tsc + 机械门禁；后续批次登记 spec | **HOLDS（有界切片）** | `runtime/runtime-turn-timing.ts` 在位（**200 行**，主审亲验；`RuntimeTurnTimingOwner` = WeakMap 真值 + 只读 getter + 冻结写端口）。**主审亲验 `internal.ts:202` `RuntimeTurnState extends RuntimeTurnCoordinationView, RuntimeTurnTimingView`**——7 个扁平字段确已从接口删除（grep 命中仅 `:191,:195` 两处注释）。`agent-runtime.ts:173,257-270` `declare private readonly`；`:336` 构造期 initialize。门禁 + 负向 tsc 在 `tests/runtime-state-ownership.test.mjs:963-1074`。**但原型注入机制本身未变**（`methods/index.ts:204` `proto.X = X`；`agent-runtime.ts:787` `installAgentRuntimeMethods(AgentRuntime)`）——诚实，spec §269 把根因登记为独立项目 |
| **R2-11 [P2]** bootstrap `src/app/` 57 文件/13,590 行应用服务层，增长中 | 里程碑债（依赖 legacy M3），未触碰 | **PARTIAL（冻结，未增长）** | 57 文件 / **13,596 行**（+6）。自基线 diff = **仅 `create-app.ts` +21/−15**（CLI-04 sink 接线）。**无新服务文件、无抽取。** 上轮「13590」vs 现「13596」的 +6 是接线成本，非生长 |
| **product-projection 上帝文件 [P2]** 6075→5680 经 5 纯叶子 + spec | 5 叶子 <400、class 逐字节相同、spec D1-D14、batch2=harness | **HOLDS（批次 1）** | `product-projection.ts` = **5680 行**（主审亲验）。5 新叶子确认：types(140)/primitives(22)/hooks(61)/model(76)/tool-display(186)，全 <400。spec `product-projection-structure.md`（89 行，D1-D14 + 批次计划）。**批次 2 harness 未启动**——主审亲验无任何 equivalence/golden-replay 文件存在；spec §72 标记为被阻塞前置（诚实停止） |
| **v4-gateway.ts [P2 次级]** 3486 行 | 延后（独立 spec 周期） | **NOT-ADDRESSED（如声称）** | `v4-gateway.ts` 仍 **3486 行**（主审亲验），未变 |
| **core zod 依赖** | `"zod": "4.6.5"` 运行时依赖（`z.unknown()`） | **HOLDS** | `core/package.json:53` `"zod": "4.6.5"`；`deferred-tool-call.ts:14` `import { z } from "zod"`、`:88` `z.unknown()` |

## 2. 扁平字段收敛计分板

- **本切片收敛**：7 个 turn 时序字段（turnNumber、activeTurn、pendingInputSequence、pendingInputReservations、pendingInputDrains、queueAutoDrain、queueExternalDrainActive）——主审核验已从 `RuntimeTurnState` 扁平面移除（仅在 `internal.ts:195` 注释中出现）。
- **剩余扁平可变字段：33**（代理精确枚举）：ContextMemory **19** + MessageProjection **5** + CacheDiagnostics **4** + TurnState 剩余 **5**（activeForegroundExecution、foregroundPromotionLease、runtimeCommandQueue、currentTurnFileChanges、lastAssistantCompletedAtMs）。
- 上轮 review 表述「~50 总量，7 收敛 → 剩 ~43+」；本轮精确的剩余**可变**字段计数是 **33**。差异在分母：「~50/93 属性」口径包含 identity/deps/readonly/已收敛字段。
- **门禁覆盖**：R1-01 机械门禁（`test:1026-1074`）断言 `Object.getOwnPropertyNames(AgentRuntime.prototype)` ⊆ `AgentRuntime` + `AgentRuntimeInternal` 声明成员。它**运行时快照整个 proto**，故也覆盖第二注入面 `installAutoResumeRuntimeMethods(proto)`（`methods/index.ts:397`、`runtime/auto-resume/runtime-api.ts:154-156`）——无未受门禁的注入路径。负向 tsc 断言 `diagnostics.length === 18`（17× code 2540 readonly + 1× 2339/2551）。**门禁 = 注入面完整性 + 逐字段写只读；它不强制写入经端口路由**（那是逐字段 tsc readonly 的职责）。
- **迁移缺口/双写：干净。** 全 `core/src` 扫描 7 字段在 owner 外的直接赋值 = **0 命中**。`steering.ts` 写点迁移**逐字节等价**（原 `setQueueAutoDrain` 行 1018-1024 == 端口的 `applyQueueAutoDrainChange`，含 true→true no-op 分支，测试 `:723-725` 钉住）。`pendingInputDrains` 0→undefined 映射保持 `permission-full-access.ts:28` 的真值读语义。

## 3. 新发现

| 级别 | 问题 | 位置 | 证据 | 定性 |
|---|---|---|---|---|
| **P3** | spec 后续批次引用了膨胀的剩余字段计数 | `specs/runtime-state-ownership.md:265` | 原文「约 46 个扁平字段」（主审亲验该行）；精确枚举 = 剩余 3 簇 **28**（19+5+4），含 TurnState 剩余则 **33**。仅文档漂移——批次优先级排序不受影响；疑为批次 1 前测量的遗留 | CONFIRMED |
| — | 无新模块级可变状态 | — | diff `ebe9033b..HEAD`：core/bootstrap **0** 个新增顶层 `let`、**0** 个新 `Map/Set/WeakMap` 单例。仅 6 个新文件（5 叶子 + owner） | CONFIRMED（干净） |
| — | CLI-04 sink 降低模块级全局风险 | `mcp/call-audit.ts`、`worktree/session-worktree-fence.ts` | 两者从进程级 `set*Sink` 迁至 sessionId 键控注册表（`sessionWarnSinks = new Map`）+ 幂等释放 + 进程级 fallback。对上轮 P3 模块级全局担忧是净改善 | CONFIRMED（改善） |

无超出门禁的新原型注入面。无 owner 迁移缺口。无装配层服务增长。

## 4. 层面健康度

**良**。R1-01 第一切片真实、范围正确、门禁扎实：WeakMap owner + 只读 getter + 冻结端口、负向 tsc（18 诊断）+ 全表面 proto 门禁、零双写（逐字节迁移）、诚实登记 P1 根因（原型注入读表面）为独立项目而非假「已修」。product-projection 批次 1 真实（−395 行、5 叶子、class 逐字节相同）且批次 2 harness 诚实阻塞；zod + CLI-04 sink 正确/改善；app 层冻结（未增长）为 M3 依赖的里程碑债。不到优的原因：P1 根因（180 方法 × 完整 `this` 字段并集）仍按设计存在，仅 7/~33 扁平可变字段被写收窄，且 `src/app/` 仍是 13.6k 行应用服务层。唯一 nit 是 spec §265 的膨胀字段计数（P3 文档漂移）。
