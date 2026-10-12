/**
 * 出站翻译的门禁与竞态裁决（纯函数，PRD auto-translate-outgoing §4.1 / §4.3）。
 *
 * 抽成纯函数是为了可单测：composer 的 submit() 在序列化之后、发送之前调用
 * `shouldTranslateOutgoingText` 决定是否进入「翻译中」过渡态；`shouldKeepTranslation`
 * 在译文到达时裁决 revision 竞态。语义表全场景必须逐行覆盖（§6.1）。
 */
import { AUTO_TRANSLATE_INPUT_MAX_CHARS, type AutoTranslateSettings } from "@acode/shared";

/** 门禁输入：设置快照 + 即将发送的原始文本。 */
export interface AutoTranslateGateInput {
  settings: AutoTranslateSettings | undefined | null;
  text: string;
}

/**
 * 是否应把这条出站文本送入翻译。
 *
 * 语义表对应关系（§4.1）：
 * - #1（enabled=false）：false，零行为变化；
 * - #2（enabled=true + modelSelection=null）：false，不调模型、零延迟；
 * - #5（enabled=true + 已选模型）：非空、非 slash、长度 ≤ 上限时 true。
 * #3/#4（模型已删/缺档位）不在这里拦截——运行时失败本身走静默回退原文，语义一致。
 */
export function shouldTranslateOutgoingText({ settings, text }: AutoTranslateGateInput): boolean {
  if (!settings?.enabled) {
    return false;
  }
  if (!settings.modelSelection) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  // slash 命令（如 /help）不翻译（§2 非目标）；首字符 / 即视为命令。
  if (trimmed.startsWith("/")) {
    return false;
  }
  return trimmed.length <= AUTO_TRANSLATE_INPUT_MAX_CHARS;
}

/** 竞态裁决输入：发起翻译时冻结的草稿 revision 与译文到达时的当前 revision。 */
export interface TranslationRevisionGateInput {
  /** 发起翻译那一刻的 revision；由调用方从 composer 的 contentRevisionRef 冻结。 */
  startRevision: number;
  /** 译文到达时重新读取的当前 revision。 */
  currentRevision: number;
}

/**
 * 译文到达时是否仍然有效（§4.3 第 7 条）。
 *
 * revision 不匹配 → 该次发送已被用户的后续操作实质取代 → 丢弃译文
 * （不注入、不回填、不发送旧译文、也不发原文）。
 */
export function shouldKeepTranslation({
  startRevision,
  currentRevision,
}: TranslationRevisionGateInput): boolean {
  return startRevision === currentRevision;
}
