// ============================================================
// amend-resume 导入：resume 侧重建入口（自 dynamic-workflow-import.ts 行数拆分）
// ============================================================
// 拆出依据：原文件 556 行超过 400 行门禁。三叶的最后一叶：崩溃后 `port.resume` 见
// `record.resumedFrom` 在场时重建同一张导入缓存。依赖方向：import-preflight ← import-build
// ← 本叶，无环。叶子不反向 import 原文件（原文件降为桶，原样再导出原有 4 个公开符号）。

import type { ImportedRunCache } from "@acode/dynamic-workflow";
import { buildImportedCache } from "./import-build.js";
import type { AmendImportDeps } from "./import-preflight.js";

/**
 * resume 侧的入口：重建修订 run 的导入缓存。**任何失败都只降级、不拒绝 resume**。
 *
 * 与提交侧共用同一个 {@link buildImportedCache}——这不是复用的顺手，而是正确性前提：修订 run 的
 * journal 只对「已到达的执行前缀」自含，未消费的导入靠这次重建补回，两侧算出不同的表就意味着
 * 「重建」变成了「另建一张」。
 *
 * 三条理由让「重建失败」与「提交时构建失败」判然不同：
 *   - 修订 run 已经存在了。拒绝 resume 等于把一个可续跑的 run 变成永久卡死的 run；
 *   - 已消费的命中在本 run 的 journal 里是**真行**，replay 不需要这张表——run 的自含性不依赖它；
 *   - 未消费的导入退化成 live 重执行，结果正确，只是花掉本可省下的 token。
 *
 * 所以这里连门的三个理由都不区分：对 resume 而言 `run_not_found`（前驱被清理）与 `missing_boundaries`
 * 是同一件事——「这次没有缓存可用」。前驱 journal 因此是修订 run 的**存续依赖，但只是加速结构**：
 * 丢了变贵，不变错。记一条 info 便于事后解释账单。
 *
 * **不带 quietSessions**（见 `AmendImportOptions.quietSessions`）：走到这里的前驱早已终态，本进程里
 * 没有它的 driver，没有任何东西在写它的会话。带一个空集合进来会让重建出的表比提交时那张少一个 `inFlight`，而两侧必须是同一张表（见原文件头）。
 */
export async function rebuildImportedCacheForResume(
  deps: AmendImportDeps,
  /** 被 resume 的修订 run 与它的 `resumed_from`（调用方已确认后者在场）。 */
  run: { runId: string; predecessorRunId: string },
): Promise<ImportedRunCache | undefined> {
  const { predecessorRunId, runId } = run;
  const built = await buildImportedCache(deps, predecessorRunId);
  if (built.ok) return built.cache;
  deps.logger?.info?.("Dynamic workflow amend cache rebuild skipped; resuming without it", {
    event: "dynamic_workflow.amend.rebuild_skipped",
    module: "bootstrap.app",
    reason: built.reason,
    resumedFrom: predecessorRunId,
    runId,
  });
  return undefined;
}
