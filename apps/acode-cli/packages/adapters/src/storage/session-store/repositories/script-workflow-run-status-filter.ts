// 逻辑态闭集（物理六词 + interrupted）→ `workflow_run` 查询的参数化 SQL 片段。
// 2026-10-18 自 script-workflow-runs.ts **纯移动**（该文件顶过 managed 模块 400 行硬上限），
// 判据依据与「唯一映射所有者」的指向原样保留；调用方只有同目录的 listScriptWorkflowRuns。
import type { SQLInputValue } from "node:sqlite";
// 落库契约常量（failure_json 的 interrupted code 与受 CHECK 约束的物理词表）：唯一定义在
// contracts，SQL 判据与 cli-workflow 唯一映射函数（logicalScriptWorkflowStatus）共用同一值。
import {
  SCRIPT_WORKFLOW_INTERRUPTED_CODE,
  SCRIPT_WORKFLOW_RUN_STATUSES,
  type ScriptWorkflowLogicalRunStatus,
} from "@acode/contracts";

/**
 * 逻辑态闭集（物理六词 + interrupted）的 SQL 展开。interrupted 没有物理词（CHECK 约束），
 * 它 = `cancelled` 且 failure_json.code 命中 {@link SCRIPT_WORKFLOW_INTERRUPTED_CODE}；
 * json_extract 对 NULL / 非对象 failure 都回 SQL NULL，与 cli-workflow 唯一映射
 * （logicalScriptWorkflowStatus 的 readFailureCode：只认对象上的非空 string code）同判：
 * 命中 → interrupted，否则 cancelled。两词同时请求时一切 cancelled 行都匹配其一，不分流。
 * 展开与映射的一致性由 script-workflow-management-store 测试逐行互钉。
 */
export function logicalStatusesClause(
  logicalStatuses: readonly ScriptWorkflowLogicalRunStatus[] | undefined,
): { sql: string; values: SQLInputValue[] } | undefined {
  if (!logicalStatuses || logicalStatuses.length === 0) return undefined;
  const requested = new Set(logicalStatuses);
  const wantsCancelled = requested.has("cancelled");
  const wantsInterrupted = requested.has("interrupted");
  // 一一对应的物理词按词表规范序进 in (...)（输出确定，不随调用方传参顺序漂移）。
  const direct = SCRIPT_WORKFLOW_RUN_STATUSES.filter(
    (word) => word !== "cancelled" && requested.has(word),
  );
  const disjuncts: string[] = [];
  const disjunctValues: SQLInputValue[] = [];
  if (direct.length > 0) {
    disjuncts.push(`status in (${direct.map(() => "?").join(", ")})`);
    disjunctValues.push(...direct);
  }
  if (wantsCancelled && wantsInterrupted) {
    disjuncts.push("status = 'cancelled'");
  } else if (wantsCancelled) {
    disjuncts.push(
      "(status = 'cancelled' and coalesce(json_extract(failure_json, '$.code'), '') <> ?)",
    );
    disjunctValues.push(SCRIPT_WORKFLOW_INTERRUPTED_CODE);
  } else if (wantsInterrupted) {
    disjuncts.push("(status = 'cancelled' and json_extract(failure_json, '$.code') = ?)");
    disjunctValues.push(SCRIPT_WORKFLOW_INTERRUPTED_CODE);
  }
  if (disjuncts.length === 0) return undefined;
  return {
    sql: disjuncts.length === 1 ? disjuncts[0]! : `(${disjuncts.join(" or ")})`,
    values: disjunctValues,
  };
}
