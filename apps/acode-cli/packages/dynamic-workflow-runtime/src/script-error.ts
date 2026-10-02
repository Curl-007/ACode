/**
 * 沙箱未捕获错误 → run 级 WorkflowError 的归一（从 harness.ts 拆出——该文件已抵
 * oxlint max-lines 上限；拆分姿态与仓库先例一致：child-entry-file.ts 同样从 harness 拆出，
 * 公开面不变，harness 只留调用点）。
 *
 * 住独立模块而不留在 harness 的理由不只是行数：这段归一是**线形态（WireError）与引擎
 * 错误词汇表（WorkflowErrorCode）之间的边界翻译**，两侧的形状它都要认识，而 harness 的
 * 职责是进程编排与桥接。
 */

import { isWorkflowErrorCode, WorkflowError, type Violation } from "@acode/dynamic-workflow";
import type { WireError } from "./protocol.js";

/**
 * 带**合法码**的按原码重建：节点级拒绝（例如预算保险丝的 `AgentBudgetExceeded` /
 * `TokenBudgetExceeded`）没被脚本 catch 而冒到顶层时，journal 的 failure_json 因此保住
 * 结构化原因——读面按 code 分叉，一律折成 DriverError 会把「预算耗尽」和「脚本自己写错」
 * 混成同一个码，只能靠 message 文本区分（specs/workflow-budget-fuses.md R2 的「原因入
 * journal」走的就是这条路）。
 *
 * 线形态的 code 本是父进程 toWireError 的去程回声，但沙箱不是安全边界（脚本可以自造
 * `e.code`），所以重建前过词汇表 guard：编造的码仍归 DriverError，failure_json 的稳定
 * 词汇表不被污染。violations / finalText 同车带回（引擎序列化产物的忠实往返）。
 */
export function scriptThrowError(err: WireError | undefined): WorkflowError {
  const message = err?.message ?? "The workflow script threw an error";
  if (err !== undefined && isWorkflowErrorCode(err.code)) {
    return new WorkflowError(err.code, message, {
      ...(err.violations === undefined ? {} : { violations: err.violations as Violation[] }),
      ...(typeof err.finalText === "string" ? { finalText: err.finalText } : {}),
      ...(err.stack === undefined ? {} : { cause: err.stack }),
    });
  }
  return new WorkflowError("DriverError", message, { cause: err?.stack ?? err?.name });
}
