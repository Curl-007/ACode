import { z } from "zod";

/**
 * 出站消息自动翻译（renderer composer 挂载，PRD：docs/prd-auto-translate-outgoing.md）。
 *
 * 状态所有者是 AppSettings.autoTranslate（setting.json 唯一持久化位）；调用通道是既有
 * sidecar RPC `workspace/generateText`，UI hook 直接传 selection，不新建 host 服务。
 *
 * `querySource` 常量必须共享的原因与 next-step-suggestions.ts 相同：协议侧只校验
 * nonEmptyString，UI 与 core 各写一份字面量必然漂移，而 core 靠它决定是否给辅助调用
 * 绑定最低档位（workspace-generate-text.ts 的 AUXILIARY_QUERY_SOURCES）。
 * core 的运行时依赖不包含 @acode/shared，所以 core 侧本地声明同值字面量并注释指向这里。
 */
export const AUTO_TRANSLATE_QUERY_SOURCE = "auto_translate";

/** 翻译输入上限：超出直接放弃翻译、原样发送，不做分段拼接（与 voicePolish 同裁决）。 */
export const AUTO_TRANSLATE_INPUT_MAX_CHARS = 4_000;

/** 翻译超时；超时即 abort 并静默回退发原文（不可调，见 PRD §4.6）。 */
export const AUTO_TRANSLATE_TIMEOUT_MS = 15_000;

/** 输出预算：与 voicePolish 一致，防止模型把翻译扩写成回答。 */
export const AUTO_TRANSLATE_MAX_OUTPUT_TOKENS = 512;

/**
 * 译文长度超过 输入长度 × 2 + 200 字符时视为模型漂移（把翻译做成了回答/扩写），
 * 调用方回退发原文。阈值公式见 PRD §4.6。
 */
export const AUTO_TRANSLATION_LENGTH_BIAS_CHARS = 200;
export const AUTO_TRANSLATION_LENGTH_FACTOR = 2;

/**
 * 协议层 RPC 超时。必须大于自身 deadline（15s），否则协议 client 默认 3 分钟超时
 * 会先于调用方 deadline 触发并被误判 stale 杀进程；+5s 缓冲照 voicePolish 同口径。
 */
export const AUTO_TRANSLATE_REQUEST_TIMEOUT_MS = AUTO_TRANSLATE_TIMEOUT_MS + 5_000;

const nonEmptyString = z.string().trim().min(1);

const autoTranslateModelSelectionSchema = z
  .object({
    providerId: nonEmptyString,
    modelId: nonEmptyString,
  })
  .strict();

const autoTranslateModeSchema = z.enum(["translate", "translate-polish"]);

/**
 * 自动翻译设置。默认整份关闭：`enabled: false` 时零行为变化（PRD §4.1 语义表 #1）。
 *
 * `modelSelection` 只存 `{providerId, modelId}` 不带档位：翻译属于辅助调用，档位由
 * CLI 侧 AUXILIARY 档位绑定自动补齐，设置里无需用户选档。null = 未选模型，此时
 * 即使 `enabled: true` 也不发起任何请求（语义表 #2，硬验收点）。
 */
export const autoTranslateSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: autoTranslateModeSchema.default("translate"),
    modelSelection: autoTranslateModelSelectionSchema.nullable().default(null),
  })
  .strict();

export type AutoTranslateMode = z.infer<typeof autoTranslateModeSchema>;
export type AutoTranslateModelSelection = z.infer<typeof autoTranslateModelSelectionSchema>;
export type AutoTranslateSettings = z.infer<typeof autoTranslateSettingsSchema>;

export const DEFAULT_AUTO_TRANSLATE_SETTINGS: AutoTranslateSettings = {
  enabled: false,
  mode: "translate",
  modelSelection: null,
};
