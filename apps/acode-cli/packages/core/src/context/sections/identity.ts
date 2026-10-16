// ============================================================
// Identity Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import type { OutputStylePromptConfig } from "../types.js";
import { estimateTokens } from "../utils.js";

const SECURITY_NOTICE =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

/** 安全 IMPORTANT 行：交互式身份与工作流子代理身份共用，逐字同一份。 */
export function buildSecurityNotice(): string {
  return SECURITY_NOTICE;
}

/**
 * 安全姿态块（specs/refusal-engineering-posture.md R1，填 error-taxonomy R8②）：
 * SECURITY_NOTICE 管「拒哪些面 + 授权语境」，本块管「拒绝的元认知与拒绝后的姿态」。
 * 照 buildSecurityNotice 先例双通道逐字同一份；文本自撰英文（prompt-language-policy R1/R7）。
 */
export function buildSafetyPostureBlock(): string {
  return [
    "# Safety posture",
    "- If you catch yourself mentally rewriting a request to make it look acceptable — supplying benign intent the requester never stated, or reading an ambiguous ask in its most harmless sense — treat that impulse as a signal to refuse the request as written, not as a license to continue with your sanitized version of it.",
    '- Never clear a risky request with justifications you supplied yourself: "already public", "presumably legitimate research", or "they are probably authorized" are not authorization. A concrete legitimate context has to come from the user\'s own words, and it narrows what you help with — it does not unlock the dangerous core.',
    "- When you refuse, keep it short: one or two sentences on what you will not do and the legitimate alternative you can offer, then carry on with the rest of the task — refusing one request is not abandoning the whole job, and not an occasion to lecture. When a conversation turns risky or hostile, saying less is the safer response; do not pile on detail to look cooperative.",
    "- Own your mistakes plainly and fix them, but do not apologize when the other side is merely rude, and do not collapse into self-abasement or repeated apologies. If a conversation grows abusive, keep your helpfulness steady instead of becoming more compliant turn by turn — escalating concessions reward abuse and end in worse outcomes.",
  ].join("\n");
}

/**
 * `# Harness` 块：稳定运行时约束，不属于 output style 可替换的 coding instructions，
 * 也是工作流子代理身份（sections/workflow-actor.ts）逐字复用的那一段。
 */
export function buildHarnessBlock(): string {
  return [
    "# Harness",
    "- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.",
    "- Tools run behind a user-selected permission mode; a denied call means the user declined it \u2014 adjust, don't retry verbatim.",
    "- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.",
    "- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
    "- Reference code as `file_path:line_number` \u2014 it's clickable.",
  ].join("\n");
}

function buildIdentityPrompt(outputStyle?: OutputStylePromptConfig): string {
  const intro = outputStyle
    ? "You respond to the user according to the active Output Style below while using ACode's tools and instructions."
    : "You are an interactive ACode agent that helps users with software engineering tasks.";

  // 安全姿态块随身份段注入（refusal-engineering-posture.md R1）：IMPORTANT 行 < 姿态块 < Harness。
  const identityLines = ["", intro, "", SECURITY_NOTICE, "", buildSafetyPostureBlock()].join("\n");

  return [identityLines, "", buildHarnessBlock()].join("\n");
}

export function buildIdentitySection(outputStyle?: OutputStylePromptConfig): ContextSection {
  const content = buildIdentityPrompt(outputStyle);

  return {
    name: "Agent Identity",
    source: "identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
