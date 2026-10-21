// 本轮生成指标 / Composer 状态栏事实（apps/acode-cli/specs/usage-statusbar-port.md §3.1）。
// rows.ts 已贴住 max-lines 预算，按既有叶子拆分先例独立成文件，并从 rows.js re-export。
import { z } from "zod";

// 本轮生成指标（首 token / 输出 token / 解码速度）。CLI 投影从 main_turn 的
// model_request_completed 累加；null 一律表示「未知」，不得用请求总耗时或 0 替代
// （与 session-debug.ts 的 calculateOutputTps 同一裁决）。
export const turnMetricsSchema = z.object({
  // 本轮首个产出内容的主回合模型请求的首 token 延迟；尚无内容时为 null。
  firstTokenMs: z.number().nonnegative().nullable(),
  // 本轮全部主回合模型请求的 outputTokens 之和。
  outputTokens: z.number().nonnegative(),
  // 本轮输出解码速度（tokens/s）；计时完整的请求不存在或耗时不完整时为 null。
  tokensPerSecond: z.number().nonnegative().nullable(),
  // 本轮全部主回合模型请求的 inputTokens 之和（含缓存读取/写入）。
  // additive：旧 CLI 不携带时 UI 把「本轮用量」整段隐藏，不用输出侧凑数。
  inputTokens: z.number().nonnegative().optional(),
  // 进入累加的主回合模型请求段数（状态栏明细「已完成请求 N 段」）。
  requestCount: z.number().int().nonnegative().optional(),
  // 本轮主回合请求的思考 / 缓存读 / 缓存写 token 之和（状态栏「本轮用量」明细）。additive。
  reasoningTokens: z.number().nonnegative().optional(),
  cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(),
  // 最快一段速率（单次请求解码窗内的 输出 tokens ÷ 解码耗时，取最大值）。
  // additive：旧 CLI 不下发时状态栏「段 / 峰」整行隐藏，不用 tokensPerSecond 冒充峰值。
  peakTokensPerSecond: z.number().nonnegative().optional(),
});
export type TurnMetrics = z.infer<typeof turnMetricsSchema>;

// Composer 状态栏读的当前轮指标。挂在 snapshot A 区，不随 rows 尾窗裁剪；
// streaming 由投影按当前 product turn 是否仍在跑写入，UI 不从 phase 反推。
export const composerTurnMetricsSchema = z.object({
  metrics: turnMetricsSchema,
  streaming: z.boolean(),
});
export type ComposerTurnMetrics = z.infer<typeof composerTurnMetricsSchema>;
