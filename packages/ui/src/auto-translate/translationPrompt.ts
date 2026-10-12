/**
 * 出站翻译的 prompt 构造与输出规整（PRD auto-translate-outgoing §4.4）。
 *
 * 拆成纯函数是为了可单测：`useAutoTranslate` 只负责调用 `workspace/generateText`
 * 与失败回退，prompt 的形状与边界全部收敛在这里。
 *
 * 失败语义照抄 voicePolish：只 warn、不弹 toast、不阻塞发送（回退发原文）。
 */
import {
  AUTO_TRANSLATE_INPUT_MAX_CHARS,
  AUTO_TRANSLATION_LENGTH_BIAS_CHARS,
  AUTO_TRANSLATION_LENGTH_FACTOR,
  type AutoTranslateMode,
} from "@acode/shared";

const TRANSLATE_SYSTEM_PROMPT = [
  "You translate the user's chat message into clear, natural English for a coding assistant.",
  "Rules:",
  "- Preserve technical terms, file paths, identifiers, code snippets and math exactly as written.",
  "- Do NOT answer the message, do NOT explain, do not add or omit content.",
  "- Output only the translation, no quotes, no prefix, no explanations.",
].join("\n");

const TRANSLATE_POLISH_SYSTEM_PROMPT = [
  "You translate and polish the user's chat message into clear, natural, well-written English for a coding assistant.",
  "Rules:",
  "- Preserve technical terms, file paths, identifiers, code snippets and math exactly as written.",
  "- Do NOT answer the message, do NOT explain, do not add or omit content.",
  "- Polish for grammar and clarity, but do not change the meaning or add/remove content.",
  "- Output only the translation, no quotes, no prefix, no explanations.",
].join("\n");

/**
 * 构造翻译请求的 user 消息正文；输入为空、全空白或超上限时返回 null
 * （调用方放弃翻译、原样发送）。
 *
 * 输入超 `AUTO_TRANSLATE_INPUT_MAX_CHARS` 时同样返回 null：与 voicePolish 同裁决，
 * 不做「翻译前半段 + 原文后半段」的拼接，避免注入出语义断裂的文本。
 */
export function buildTranslationUserMessage(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > AUTO_TRANSLATE_INPUT_MAX_CHARS) {
    return null;
  }
  return `<chat_message>\n${trimmed}\n</chat_message>`;
}

/** 按模式取 system prompt；模式集合只有两档（PRD §1 裁决，不发散）。 */
export function resolveTranslationSystemPrompt(mode: AutoTranslateMode): string {
  return mode === "translate-polish" ? TRANSLATE_POLISH_SYSTEM_PROMPT : TRANSLATE_SYSTEM_PROMPT;
}

/**
 * 规整模型输出：去掉可能的代码围栏与成对包裹引号（照抄 normalizeVoicePolishOutput）。
 * 输出为空时返回 null（调用方回退发原文，不注入空串）。
 */
export function normalizeTranslationOutput(rawOutput: string): string | null {
  let text = rawOutput.trim();
  if (!text) {
    return null;
  }
  // 模型偶发把整段包进 ``` 围栏；围栏内的内容才是译文正文。
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced?.[1] !== undefined) {
    text = fenced[1].trim();
  }
  // 成对的包裹引号（中英文）也是噪声。
  const quotePairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["「", "」"],
  ];
  for (const [open, close] of quotePairs) {
    if (text.length > 1 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }
  return text || null;
}

/**
 * 译文超长防护（PRD §4.6）：译文长度 > 输入长度 × 2 + 200 字符 → 视为模型漂移
 * （把翻译做成了回答/扩写），调用方回退发原文 + warn 日志。
 */
export function isTranslationOutputExcessive(
  translatedLength: number,
  inputLength: number,
): boolean {
  return (
    translatedLength >
    inputLength * AUTO_TRANSLATION_LENGTH_FACTOR + AUTO_TRANSLATION_LENGTH_BIAS_CHARS
  );
}
