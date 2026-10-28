// ============================================================
// Dynamic Workflow Run 的观察面辅助（run service 的只读半身）
// ============================================================
// 快照/列表/详情的合成规则。从 dynamic-workflow-run-service.ts 拆出：服务文件承载入口与门，
// 本文件承载「registry + journal → 对外读面」的纯合成规则（无 I/O、无状态）。
//
// 行数拆分（原 613 行超过 400 行门禁）：按「共享状态核 → 快照面 → 详情面」拆成三个叶子——
//   - observation-registry.ts：注册表条目、终态集、状态合成四档优先级、resume 谓词、结算等待；
//   - observation-snapshot.ts：快照合成（含三个字段投影与 reports）；
//   - observation-detail.ts：列表/详情截面、终态字段、日志映射、会话摘要。
// 依赖方向：registry ← snapshot / detail，detail ← snapshot（单向），叶子不反向 import 本文件。
// 本文件降为桶：原样再导出全部原导出符号，所有消费方（service / introspection / submit /
// reconcile / replay / retune / roster / lifecycle / launch / import）的 import 一行不变。
//
// 读模型的归并（lineage / label / activeMs / artifacts）住在 @acode/workflow-run-read 包，
// 叶子从那里 import；本文件同样从契约包取 `artifactsOf` 并原样再导出。
//
// ⚠ 术语：这里的 artifact 是**用户面产物**（脚本经 `artifact.*` 发布给用户看的字节），
// 与快照的 `output`（脚本顶层返回值，引擎内部也叫 artifact）是两件不同的东西。

import { artifactsOf } from "@acode/workflow-run-read/contract";

/**
 * 产物归并住在 @acode/workflow-run-read 的 artifact projection（本文件顶到 oxlint 的 400 行上限）。
 * 原样再导出而不是让四个调用点各改 import：它们找的是「观察面」，而这次拆分是行数约束的结果、
 * 不是边界的变化——把它变成一次跨模块改名，只会让 git blame 指向一个与意图无关的提交。
 */
export { artifactsOf };

export {
  INTERRUPTED_FAILURE_CODE,
  TERMINAL_RUN_STATUSES,
  isResumableRecord,
  isResumableSettlement,
  settleOrAbort,
  stopReasonOf,
  synthesizeRunStatus,
  type RunRegistryEntry,
} from "./observation-registry.js";

export {
  runConcurrencyField,
  runScriptPathField,
  runSubagentModelField,
  snapshotOf,
} from "./observation-snapshot.js";

export {
  journalRunSummary,
  registryRunSummary,
  terminalErrorField,
  terminalResultField,
  toLogTailEntry,
  toSessionSummary,
} from "./observation-detail.js";
