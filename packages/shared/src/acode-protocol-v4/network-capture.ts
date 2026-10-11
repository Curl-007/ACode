// ============================================================
// 运行时网络观测（agent 进程内）的 v4 词汇
// ============================================================
// 设计见 packages/desktop/specs/runtime-network-capture.md。两条通道：
//   ① networkCaptureSetEnabled（host→CLI 的 v4 方法）：开关 + captureId 对账；
//   ② networkCaptureRecords（CLI→host 的 v4 通知，仅 live）：批量上报观测记录。
// 刻意**不进** conversation topic snapshot/recovery：观测是进程内 live 事实，重放不补造
// （与 V4_NOTIFICATIONS.cuaPermissionObservation 同一条纪律）；资源管理器是它唯一的消费者。
//
// 脱敏纪律（写入侧执行，schema 是线上第二道闸）：不记 headers、不记 body；
// URL 剥 userinfo；query 只保留参数名（值一律 `<redacted>`）。

import { z } from "zod";

/** 观测记录的线上形状。字段闭集；加字段是 additive，但语义上只允许「更多脱敏」。 */
export const networkCaptureRecordSchema = z
  .object({
    /** 请求开始（epoch 毫秒，agent 进程时钟）。 */
    startedAt: z.number().int().nonnegative(),
    /** 总耗时毫秒。失败/未完成的请求在完成或放弃时上报一次。 */
    durationMs: z.number().int().nonnegative(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
    /** 脱敏后的 URL（见文件头纪律；≤ 2048 字符，超长截断）。 */
    url: z.string().min(1).max(2048),
    /** HTTP 状态码；网络层失败（DNS/TLS/超时）为 null。 */
    status: z.number().int().positive().nullable(),
    /**
     * 发起面：模型网关 / WebFetch / WebSearch / MCP http / 其他。
     * "other" = 未打标的出站请求（观测面宁可多记一条诚实的 other，也不静默漏掉外联）。
     */
    phase: z.enum(["model", "webfetch", "websearch", "mcp", "other"]),
  })
  .strict();
export type NetworkCaptureRecord = z.infer<typeof networkCaptureRecordSchema>;

/** 单批上限：环形缓冲 500 条 ÷ 批量节奏（满 50 或 10s）的保守界。 */
export const NETWORK_CAPTURE_MAX_RECORDS_PER_NOTIFICATION = 50;

// ── v4 方法：networkCaptureSetEnabled（host → CLI）──
// 不是 conversation 命令（不带 sessionId）：抓的是 agent 进程的进程级事实。
export const v4NetworkCaptureSetEnabledParamsSchema = z
  .object({
    enabled: z.boolean(),
    /** 开启方生成的对账 id；随后每条 records 通知带同一个 id，关闭后即失效。 */
    captureId: z.string().min(1).max(128),
  })
  .strict();
export type V4NetworkCaptureSetEnabledParams = z.infer<typeof v4NetworkCaptureSetEnabledParamsSchema>;

export const v4NetworkCaptureSetEnabledResultSchema = z.object({ enabled: z.boolean() }).strict();
export type V4NetworkCaptureSetEnabledResult = z.infer<typeof v4NetworkCaptureSetEnabledResultSchema>;

// ── v4 通知：networkCaptureRecords（CLI → host，仅 live）──
export const v4NetworkCaptureRecordsNotificationSchema = z
  .object({
    captureId: z.string().min(1).max(128),
    records: z.array(networkCaptureRecordSchema).max(NETWORK_CAPTURE_MAX_RECORDS_PER_NOTIFICATION),
  })
  .strict();
export type V4NetworkCaptureRecordsNotification = z.infer<
  typeof v4NetworkCaptureRecordsNotificationSchema
>;
