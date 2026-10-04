import type { ACodeAutomationNotifyDecision } from "./automation-types.js";

// Automation heartbeat 通知决策协议的唯一词汇家
//（packages/desktop/specs/automation-heartbeat-protocol.md R2/R3）：
// 指令文本、标签格式、解析器、尾部缓冲都归口本模块；host settle 与 bots 终态是
// 两个评估点，必须 import 同一 parseAutomationNotice，禁止各写各的正则（单一语义来源）。

/** 决策标签名。完整标签形如 <automation-notice>NOTIFY</automation-notice>。 */
export const AUTOMATION_NOTICE_TAG = "automation-notice";

/**
 * 决策文本尾部缓冲上限。标签约定在最终回复末尾，滚动尾部即可判定且有界；
 * host 与 bots 共用同一上限，避免两处各自发明缓冲策略。
 */
export const AUTOMATION_NOTICE_BUFFER_MAX_CHARS = 8 * 1024;

/**
 * 派发注入段（Q3 裁决：后缀拼接在作者 prompt 之后，原文语义不被改写）。
 * 恒英文（prompt-language-policy）：这是模型可见指令文本，不随 UI 语言变化。
 * 机制借鉴 Codex heartbeat 协议：强制单个决策、默认安静、触发本身不构成通知理由。
 */
export const AUTOMATION_NOTICE_INSTRUCTION = [
  "",
  "",
  `<${AUTOMATION_NOTICE_TAG}-protocol>`,
  "This run was triggered by a scheduled automation, not by the user typing a message.",
  "When your work for this run is complete, end your final reply with exactly one decision tag:",
  `<${AUTOMATION_NOTICE_TAG}>NOTIFY</${AUTOMATION_NOTICE_TAG}> if the outcome genuinely deserves the user's attention,`,
  `or <${AUTOMATION_NOTICE_TAG}>DONT_NOTIFY</${AUTOMATION_NOTICE_TAG}> if it is routine and should stay silent.`,
  "The trigger itself is never a reason to notify. Output the tag exactly once, at the very end.",
  `</${AUTOMATION_NOTICE_TAG}-protocol>`,
].join("\n");

// DONT_NOTIFY 放在 NOTIFY 之前：虽然两者都以 > 或空白锚定不会互相误配，
// 显式长优先避免未来改宽松边界时踩前缀坑。g+i：模型大小写不规范时仍可解析。
const AUTOMATION_NOTICE_PATTERN = new RegExp(
  `<${AUTOMATION_NOTICE_TAG}>\\s*(DONT_NOTIFY|NOTIFY)\\s*</${AUTOMATION_NOTICE_TAG}>`,
  "gi",
);

/**
 * 纯函数解析（R2 fail-safe）：取文本中最后一个合法决策标签（last-match——bots 侧
 * 订阅可能跨 run 复用，尾部即最新 run 的决策）；无标签/非法 → "absent"，
 * 消费方必须把 absent 当 dont_notify 处理（默认安静）。
 */
export function parseAutomationNotice(text: string): ACodeAutomationNotifyDecision {
  let decision: ACodeAutomationNotifyDecision = "absent";
  for (const match of text.matchAll(AUTOMATION_NOTICE_PATTERN)) {
    const value = match[1]?.toUpperCase();
    if (value === "DONT_NOTIFY") decision = "dont_notify";
    else if (value === "NOTIFY") decision = "notify";
  }
  return decision;
}

/** 滚动尾部累积：只保留最后 AUTOMATION_NOTICE_BUFFER_MAX_CHARS 个字符。 */
export function appendAutomationNoticeTail(tail: string, chunk: string): string {
  const next = tail + chunk;
  return next.length > AUTOMATION_NOTICE_BUFFER_MAX_CHARS
    ? next.slice(next.length - AUTOMATION_NOTICE_BUFFER_MAX_CHARS)
    : next;
}
