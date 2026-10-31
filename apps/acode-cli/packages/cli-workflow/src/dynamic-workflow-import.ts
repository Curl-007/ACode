// ============================================================
// amend-resume 的导入构建：读前驱 journal → ImportedRunCache
// ============================================================
//
// 本模块是 amend-resume 唯一的**读前驱**处，三个调用点共用它：
//   1. `port.amend` 的**预检**（{@link preflightAmendImport}）：停下在飞前驱之前就判定
//      `run_not_found` / `missing_boundaries`——被拒时前驱照旧在跑、一行不建；
//   2. `port.amend` 在前驱结算之后构建缓存（{@link buildImportedCache}）；
//   3. `port.resume` 见 `record.resumedFrom` 在场：崩溃后重建同一张表。
//
// 两处共用同一套构建规则：修订 run 的 journal 只包含已消费的执行前缀，未消费的导入需要重建。
// 已完成条目只由 journal 决定，遍历顺序取自 journal 的插入序；未完成 ask 的边界还依赖源转录。
//
// 一处例外要说清楚，它是这张表里**第一个不是 journal 纯函数**的数：在飞 ask 的接续（`inFlight`）的边界取自**前驱会话此刻的消息条数**，不是 journal 里的某一列。
//
// 它在两次构建之间大体稳定，靠的是「前驱已经结算、没人再写它的会话」：
//   - 提交时由 {@link AmendImportOptions.quietSessions} 保证（被取代的前驱刚 abort，driver 等它的 turn 落地；没等到的会话不接续）；
//   - 重建时前驱早已终态、本进程里没有它的 driver，天然无人在写，所以不带这个集合（缺席 = 全部静默）。
//
// 但「大体」不是「一定」，而且**不必**是：两条路能让重建算出一个更大的 M——前驱被重新 resume 过又写了几轮（被 supersede 的前驱不可 resume，所以只有「修订一个早已 stopped 的 run、之后又去 resume 它」构造得出），或者一条迟到的后台通知消息落进了那个会话。两者都只会让 M **变大**，而正确性不依赖 M 稳定：
//   - 抄进去的那一侧已经把门关死了——`seedActorTranscript` 只往「空的、或只装着本会话种子消息的」目标里写（workflow-actor-transcript.ts 的性质 2）。后继一旦跑出自己的消息，更大的 M 再送回来也一个字节都不会被写进去，所以绝无「前驱的消息被追加到本会话历史之后」这种静默错乱；
//   - 后继还没跑出自己的消息时，更大的 M 抄来的是**同一条 ask 的更晚快照**，顺序仍由下标决定（种子 id 按 (会话, 下标) 纯确定，重抄是 upsert），所以那只是多带一点上文，不会变错。
// 这条也是给**将来**每一个非 journal 事实的兜底：不必逐个去证明它们不会变大，复制点一次性堵死。
//
// 唯一的 I/O 是 journal 读与转录条数读（两者都经窄端口注入），本模块自己不碰会话存储实现。
//
// ————————————————————————————————————————————————————————————————
// 行数拆分（原 556 行超过 400 行门禁）：按「预检/依赖形状 → 构建器 → resume 重建」拆成三个叶子——
//   - import-preflight.ts：预检与门 3 谓词、拒绝理由、AmendImportDeps / AmendImportOptions、
//     转录源解析与条数读取；
//   - import-build.ts：缓存构建器与它的私有步骤（候选、前缀、在飞接续、world 队列）；
//   - import-rebuild.ts：resume 侧重建入口。
// 依赖方向：preflight ← build ← rebuild，无环；叶子不反向 import 本文件。
// 本文件降为桶：原样再导出原有全部公开符号，两个消费方（run-submit 的三个函数与 deps 的依赖类型）的 import 一行不变。
// ————————————————————————————————————————————————————————————————

export { preflightAmendImport, type AmendImportOptions } from "./import-preflight.js";
export { buildImportedCache } from "./import-build.js";
export { rebuildImportedCacheForResume } from "./import-rebuild.js";
