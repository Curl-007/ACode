// ============================================================
// Overnight（K3）完成信号的 v4 词汇（agent 进程 → host 进程）
// ============================================================
// 设计见 packages/desktop/specs/overnight-completion-notify.md §7。
//
// 为什么需要这条 agent→host 通知（而不是复用既有 runtime-task / sessions-index 通道）：
//   overnight 的权威事实在 CLI agent 子进程内的 supervisor（core/overnight/supervisor.ts），
//   coordinator 是 `hidden: true` 的 fork 子会话，live 期不进 sessions-index、不 fan-out
//   （spec §1.1 证据 4/5）。runtime-task registry 是 agent 进程内内存态，从不跨进程序列化到
//   host（`registry.all()` 在 bootstrap 内无任何外发点）。因此完成事实必须经一条显式的
//   live v4 通知主动上报——与 networkCaptureRecords 同族（进程内 live 事实，重放不补造）。
//
// 刻意**不进** conversation topic snapshot/recovery：完成通知是进程内一次性 live 事实，
// 冷恢复不应补发（与 V4_NOTIFICATIONS.cuaPermissionObservation / networkCaptureRecords 同一纪律）。
// 桌面 Main 侧的 overnightCompletionNotify 是它唯一的最终消费者（弹系统通知 + 点击直达）。

import { z } from "zod";

/**
 * agent→host 的 v4 通知方法名。
 *
 * 不复用 transport.ts 的 V4_NOTIFICATIONS 常量表：该文件当前由并行任务独占，且通知的
 * `method` 在线上只按 `nonEmptyString` 校验（acodeProtocolNotificationSchema），故本模块
 * 自带方法名常量即可，host 侧 dispatch 以此为判据。命名沿用既有 `v4/<domain>/<noun>` 形态。
 */
export const V4_OVERNIGHT_COMPLETION_METHOD = "v4/overnight/completion";

/**
 * overnight run 的终态。对齐 supervisor：
 *   - `overnight.completed` + `cancelled: false` → "completed"
 *   - `overnight.completed` + `cancelled: true`  → "cancelled"
 *   - `overnight.failed`                          → "failed"
 * Main 侧 overnightCompletionNotify 据此选择本地化文案与通知状态。
 */
export const overnightCompletionOutcomeSchema = z.enum(["completed", "failed", "cancelled"]);
export type OvernightCompletionOutcome = z.infer<typeof overnightCompletionOutcomeSchema>;

/**
 * 完成信号载荷（agent→host 与 host→main 共用同一形状；host→main 只额外加 `type` 判别字面量）。
 *
 * - `runId`：Main 侧幂等键（一个 run 至多一条通知）。
 * - `parentTaskId`：点击直达目标——发起 /overnight 的**可见**会话，绝非 coordinator 自身的
 *   隐藏 fork 会话 id（coordinator live 期不在 taskListCache，路由到它会「task not found」）。
 *   取自 manifest.parentTaskId（runner 装配时写入 `String(runtime.getSessionId())`）。
 * - `morningReportReady`：晨报文件是否已确认存在——权威来源是 `manifest.morningReportPostedAtMs`
 *   （R5 收紧语义：只在文件确认后写入），**不猜测、不硬编码**。
 */
export const v4OvernightCompletionNotificationSchema = z
  .object({
    // 标识符用 trim().min(1)（对齐 shared 的 nonEmptyStringSchema 惯例）：纯空白 runId/parentTaskId
    // 是非法值——parentTaskId 会直接进点击路由，空白会让 onTaskNotificationClick 反查失败。
    runId: z.string().trim().min(1).max(128),
    parentTaskId: z.string().trim().min(1).max(256),
    outcome: overnightCompletionOutcomeSchema,
    morningReportReady: z.boolean(),
  })
  .strict();
export type V4OvernightCompletionNotification = z.infer<
  typeof v4OvernightCompletionNotificationSchema
>;
