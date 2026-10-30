import { z } from "zod";

/**
 * 本地诊断报告（U12）的契约真源。规格见 specs/local-diagnostic-report.md。
 *
 * 设计要点（安全承重，勿轻改）：
 * 1. 白名单优先——报告只由本 schema 允许的结构化字段组成，`.strict()` 拒绝任何未知字段，
 *    禁止「透传 arbitrary metadata」。敏感信息（Bearer/API key/cookie/token/URL userinfo/
 *    原始路径/用户名/主机名/会话正文）**不在 schema 内**，是结构性排除而非采集后过滤。
 * 2. 可用性四态——每个字段组带 availability，缺失不伪造健康：未检查的字段绝不能标 collected。
 * 3. 各端只报自己拥有的事实——Web 无 build 版本时整组标 unavailable，不猜测。
 *
 * 本叶子经 index.ts 的 `export *` 公开，**不进** legacy acode-protocol barrel（冻结面只删不增）。
 */

/** 字段组可用性四态：见 spec 产品规则 3。 */
export const localDiagnosticAvailabilitySchema = z.enum([
  /** 已成功采集。 */
  "collected",
  /** 该端/该平台无法提供（如 Web 无 performance.memory、无 Desktop 版本事实）。 */
  "unavailable",
  /** 用户未把该组选入导出范围。 */
  "not-collected",
  /** 采集了但超上限被截断（当前仅 events 组会触发）。 */
  "truncated",
]);
export type LocalDiagnosticAvailability = z.infer<typeof localDiagnosticAvailabilitySchema>;

/** 报告 schema 版本；当前唯一值 1。字段演进时递增，消费端按版本解析。 */
export const LOCAL_DIAGNOSTIC_REPORT_SCHEMA_VERSION = 1 as const;

/** 轻量 JSON 报告大小上限（spec 量化门槛）。超限拒绝或截断并标记，不静默产出超大文件。 */
export const LOCAL_DIAGNOSTIC_MAX_BYTES = 1 * 1024 * 1024;

/** 事件摘要条目上限（spec 产品规则 6）。超限 fieldAvailability.events 置 truncated，条目裁到该值。 */
export const LOCAL_DIAGNOSTIC_MAX_EVENTS = 200;

/**
 * 构建/环境事实组。用户名/主机名/原始 workspacePath/内部 endpoint 结构性不在字段内。
 *
 * os/arch/appVersion/commit 为**可选**：它们的所有者是 Desktop main（`app.getVersion()` 等），
 * Web 端无法可靠得知——读 `navigator.userAgentData` 会新开设备指纹面，违反「各端只报自己拥有的
 * 事实、不猜测」（spec 产品规则 2）。故 Web 端省略这些字段而非伪造，`platformType` 提到顶层必填，
 * 保证任何报告都能表明自己来自哪一端。
 */
export const localDiagnosticBuildSchema = z
  .object({
    /** 应用版本；仅 Desktop main 拥有此事实，Web 省略。 */
    appVersion: z.string().min(1).optional(),
    /** 公开 commit（非内部构建元数据）；无干净来源时省略而非伪造。 */
    commit: z.string().min(1).optional(),
    /** 操作系统；仅 Desktop 可靠提供（`process.platform`），Web 省略。 */
    os: z.string().min(1).optional(),
    /** CPU 架构；仅 Desktop 可靠提供（`process.arch`），Web 省略。 */
    arch: z.string().min(1).optional(),
    locale: z.string().min(1),
    /** 平台能力标记（如 ["exportLogs","saveDialog"]），供维护者判断可用通道；不含敏感值。 */
    capabilities: z.array(z.string().min(1)),
  })
  .strict();
export type LocalDiagnosticBuild = z.infer<typeof localDiagnosticBuildSchema>;

/** 连接状态组。只出档位/阶段/公开稳定错误码/重连计数；URL/token/正文结构性不在字段内。 */
export const localDiagnosticConnectionSchema = z
  .object({
    /** 交付档位（desktop-continuous / web-remote-replayable 等），可选。 */
    deliveryMode: z.string().min(1).optional(),
    /** 连接阶段（connected/reconnecting/disconnected 等），公开稳定词，可选。 */
    phase: z.string().min(1).optional(),
    /** 公开稳定错误码集合（非原始 err.message）。 */
    errorCodes: z.array(z.string().min(1)),
    /** 本次会话重连次数计数。 */
    reconnectCount: z.number().int().nonnegative(),
  })
  .strict();
export type LocalDiagnosticConnection = z.infer<typeof localDiagnosticConnectionSchema>;

/** 性能组。只出有界计数与内存可用性布尔；原始堆快照结构性不在字段内。 */
export const localDiagnosticPerformanceSchema = z
  .object({
    /** 有界计数（rows/index/cache 条数与字节等），键为公开指标名。 */
    counts: z.record(z.string(), z.number().int().nonnegative()),
    /** 内存指标是否可得（Web 无 performance.memory 时 false，配合组 availability=unavailable）。 */
    memoryAvailable: z.boolean(),
  })
  .strict();
export type LocalDiagnosticPerformance = z.infer<typeof localDiagnosticPerformanceSchema>;

/** Provider 摘要单条。绝不含 API key/凭据引用/key hash；仅既有 tier/checkpoint 状态与码。 */
export const localDiagnosticProviderEntrySchema = z
  .object({
    /** provider 标识（非凭据、非 key hash）。 */
    id: z.string().min(1),
    tier: z.string().min(1).optional(),
    checkpoint: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    /** 公开稳定状态码。 */
    code: z.string().min(1).optional(),
  })
  .strict();
export type LocalDiagnosticProviderEntry = z.infer<typeof localDiagnosticProviderEntrySchema>;

export const localDiagnosticProviderSchema = z
  .object({
    /** 仅用户选入范围的 provider 条目。 */
    entries: z.array(localDiagnosticProviderEntrySchema),
  })
  .strict();
export type LocalDiagnosticProvider = z.infer<typeof localDiagnosticProviderSchema>;

/** 事件摘要单条：时间 + 公开稳定码 + 可选聚合计数。不含正文/参数/敏感值。 */
export const localDiagnosticEventSchema = z
  .object({
    at: z.string().min(1),
    code: z.string().min(1),
    count: z.number().int().positive().optional(),
  })
  .strict();
export type LocalDiagnosticEvent = z.infer<typeof localDiagnosticEventSchema>;

/**
 * 本地诊断报告顶层。`.strict()` 使任何未登记字段（尤其敏感字段名）在 parse 时被拒。
 * 各字段组可选：未选入范围的组缺席，且 fieldAvailability 对应项标 not-collected。
 */
export const localDiagnosticReportSchema = z
  .object({
    schemaVersion: z.literal(LOCAL_DIAGNOSTIC_REPORT_SCHEMA_VERSION),
    /** 报告来自哪一端。提到顶层必填：Web 端 build 组可能整体缺席，但端类型永远可知。 */
    platformType: z.enum(["desktop", "web"]),
    /** 生成时间 ISO 字符串。 */
    generatedAt: z.string().min(1),
    /** 每个字段组的可用性标记——即使组缺席也要有对应 availability，杜绝「缺失=健康」误读。 */
    fieldAvailability: z
      .object({
        build: localDiagnosticAvailabilitySchema,
        connection: localDiagnosticAvailabilitySchema,
        performance: localDiagnosticAvailabilitySchema,
        provider: localDiagnosticAvailabilitySchema,
        events: localDiagnosticAvailabilitySchema,
      })
      .strict(),
    build: localDiagnosticBuildSchema.optional(),
    connection: localDiagnosticConnectionSchema.optional(),
    performance: localDiagnosticPerformanceSchema.optional(),
    provider: localDiagnosticProviderSchema.optional(),
    events: z.array(localDiagnosticEventSchema).optional(),
  })
  .strict();
export type LocalDiagnosticReport = z.infer<typeof localDiagnosticReportSchema>;

/** 报告解析失败的稳定错误码（fail-loud，不吞异常）。 */
export const LOCAL_DIAGNOSTIC_PARSE_ERROR = "local-diagnostic-report-invalid" as const;

/**
 * 运行时校验：把未知输入解析为 LocalDiagnosticReport，失败抛带稳定码的错误。
 * 用于 (a) 各端 DTO 组合后 UI 自校验（fail-loud 暴露 bug）、(b) 维护者侧消费外部报告的入口校验。
 */
export function parseLocalDiagnosticReport(input: unknown): LocalDiagnosticReport {
  const result = localDiagnosticReportSchema.safeParse(input);
  if (!result.success) {
    throw new Error(LOCAL_DIAGNOSTIC_PARSE_ERROR);
  }
  return result.data;
}

/**
 * 各端 collectLocalDiagnostics 返回的**事实 DTO**（非完整报告）：只含各端自己拥有的
 * build/connection 白名单事实 + 各组可用性。UI 再合并 memoryDiagnostics/provider/events
 * 组装成完整 LocalDiagnosticReport。Web 无法提供的组标 unavailable 并省略该组。
 */
export const localDiagnosticFactsSchema = z
  .object({
    /** 该端类型。Web 端即使 build 组其余字段全缺，也必须报出自己是 web。 */
    platformType: z.enum(["desktop", "web"]),
    build: localDiagnosticBuildSchema.optional(),
    buildAvailability: localDiagnosticAvailabilitySchema,
    connection: localDiagnosticConnectionSchema.optional(),
    connectionAvailability: localDiagnosticAvailabilitySchema,
  })
  .strict();
export type LocalDiagnosticFacts = z.infer<typeof localDiagnosticFactsSchema>;

/**
 * 保存报告的结果形状。定义在 shared 以便 `IPlatformService.saveDiagnosticReport`、
 * IPC 通道映射（channels.ts PlatformChannelMap）与 Desktop main 实现三处共用单一定义。
 *
 * 语义（spec 产品规则 7 / 验收 U12-A5）：用户取消保存 → `{saved:false, cancelled:true}`，
 * **取消不是错误**；写失败 → `{saved:false, error:<稳定码>}`，错误对外只给稳定码
 * （原始异常含用户目录路径，只进 main 日志——同 R2-04 错误脱敏纪律）。
 */
export interface SaveDiagnosticReportResult {
  saved: boolean;
  /** 实际保存路径（Desktop 保存框返回）；Web 走 Blob 下载时缺席。 */
  path?: string;
  /** 用户取消。与 error 互斥：取消是正常结果，不是失败。 */
  cancelled?: boolean;
  /** 稳定错误码，不含原始异常消息/路径。 */
  error?: string;
}
