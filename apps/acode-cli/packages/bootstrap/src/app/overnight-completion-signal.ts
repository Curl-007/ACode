// Overnight（K3）完成信号的**纯投影**与 git 快照解析（specs/overnight-completion-notify.md §7）。
//
// 从 overnight-controller.ts 抽出（400 行纪律）：这两个函数是无副作用的纯变换，与 controller
// 的装配/生命周期逻辑不同关注点。抽出后 controller 回到上限内，且本叶子可被发射测试直接 import
// （overnight-completion-emission.test.mjs 从 overnight-controller.ts re-export 处取用）。
import type { OvernightPreflightGitSnapshot, OvernightRunResult } from "@acode/core";
import type {
  OvernightCompletionOutcome,
  V4OvernightCompletionNotification,
} from "@acode/shared/acode-protocol-v4";

/**
 * 把 supervisor 的终态结果投影成跨进程完成信号（specs/overnight-completion-notify.md §7）。
 * 纯函数、可离线单测：outcome 三态来自 `status` × `cancelled`（与 core runner.ts 落 runtime-task
 * 投影同款判据——runner.ts:196-200 `status: event.cancelled ? "cancelled" : "completed"`），
 * morningReportReady 来自 manifest 的权威标志 `morningReportPostedAtMs`（R5：只在晨报文件确认后置位）。
 *
 * 为什么读 completion 的 manifest 而非 onEvent 的事件对象：overnight.completed/failed 事件只带
 * runId+cancelled，不带 manifest（supervisor.ts:50-51），拿不到 parentTaskId 与晨报标志；
 * OvernightRunResult.manifest 是唯一同时含全部四个字段的权威快照，且 completion promise 每 run
 * 恰 resolve 一次（supervisor.ts:299-314 的 runPromise 记忆化）——天然满足「一 run 一信号」幂等。
 */
export function toOvernightCompletionSignal(
  result: OvernightRunResult,
): V4OvernightCompletionNotification {
  // 失败是最硬终态：先判 failed，取消标志不能掩盖一次真实失败（supervisor 正常路径下
  // failed 与 cancelled 互斥——cancel 落 completed+cancelled，熔断落 failed+!cancelled；
  // 这里的次序是防御性的，确保任何异常组合下失败都如实呈现，与 Main 侧 failed→"failed" 一致）。
  const outcome: OvernightCompletionOutcome =
    result.status === "failed"
      ? "failed"
      : result.cancelled
        ? "cancelled"
        : "completed";
  return {
    runId: result.manifest.runId,
    // parentTaskId = 发起 /overnight 的可见会话（runner 装配时写 manifest.parentTaskId，
    // 见 runner.ts:84 / startOvernightRun deps.parentTaskId）；点击直达目标是它，非 coordinator id。
    parentTaskId: result.manifest.parentTaskId,
    outcome,
    morningReportReady: result.manifest.morningReportPostedAtMs !== null,
  };
}

/**
 * 解析 `git status --porcelain --branch` 输出为 preflight 快照。纯函数，无 IO。
 */
export function parseGitStatusPorcelain(stdout: string): OvernightPreflightGitSnapshot {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const branchLine = lines.find((line) => line.startsWith("## "));
  if (!branchLine) return { error: "git status --branch 未返回分支行（可能不在 git 仓库内）" };
  const branchSegment = branchLine.slice(3).split("...")[0]!.trim();
  return {
    branch: branchSegment.length > 0 ? branchSegment : undefined,
    dirty: lines.length > 1,
  };
}
