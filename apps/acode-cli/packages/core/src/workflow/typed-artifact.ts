// 机制参照 jcode (MIT) crates/jcode-plan/src/dag/mod.rs（HandoffArtifact 契约）与
// crates/jcode-plan/src/dag/ops.rs（validate_artifact 薄 artifact 校验），自撰实现。
// 产品规则见 specs/workflow-typed-artifacts.md R2-R4。
//
// expert workflow 子会话没有 submit_result 端口（respond/submit 工具只注册给 dwf actor 与
// subagent_child），节点「完成提交」= 子会话末轮 response 文本。typed 段经 response 尾部的
// ```acode-artifact 围栏 JSON 块传输：宽容归一化（snake_case 别名、confidence 大小写）后过
// contracts 的 WorkflowArtifactTypedSchema；「deep 必填」不在 schema 层，而是
// validateDeepNodeArtifact 的引擎规则——light 档允许部分 typed 段、无效块直接忽略（零回归）。

import {
  WorkflowArtifactTypedSchema,
  type WorkflowArtifactTyped,
} from "@acode/contracts";
import { isRecord, readLooseString, readLooseStringArray } from "./expert/parsers/json.js";

/** typed artifact 围栏块的语言标签（区别于 planner/critic 用的 ```json）。 */
export const TYPED_ARTIFACT_FENCE = "acode-artifact";

export type ExtractTypedArtifactResult =
  | { kind: "absent" }
  | { kind: "invalid"; reasons: string[] }
  | { kind: "valid"; typed: WorkflowArtifactTyped };

/**
 * 从节点完成的 response 文本提取 typed artifact 块。
 * 多个块时取最后一个（末态生效，与 addArtifact 按 path 覆盖同一语义）。
 */
export function extractTypedArtifact(response: string): ExtractTypedArtifactResult {
  const block = lastTypedArtifactBlock(response);
  if (block === undefined) return { kind: "absent" };

  let raw: unknown;
  try {
    raw = parseJsonObject(block);
  } catch (error) {
    return {
      kind: "invalid",
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (!isRecord(raw)) {
    return { kind: "invalid", reasons: ["typed artifact block must be a JSON object"] };
  }

  const parsed = WorkflowArtifactTypedSchema.safeParse(normalizeTypedCandidate(raw));
  if (!parsed.success) {
    return {
      kind: "invalid",
      reasons: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "$"}: ${issue.message}`,
      ),
    };
  }
  return { kind: "valid", typed: parsed.data };
}

/**
 * deep 档薄 artifact 校验（镜像 jcode validate_artifact）：返回违规文案列表，空 = 通过。
 * 诚实的 low 不是违规——它会被 critic gate 的置信度债务规则路由成后续工作。
 */
export function validateDeepNodeArtifact(typed: WorkflowArtifactTyped): string[] {
  const reasons: string[] = [];
  if (typed.findings.trim().length === 0) {
    reasons.push("deep-mode artifact requires non-empty findings");
  }
  if (typed.whatINotChecked.length === 0) {
    reasons.push(
      'deep-mode artifact must list whatINotChecked (use an explicit "nothing, fully covered" entry only when truly exhaustive)',
    );
  }
  if (!typed.confidence) {
    reasons.push(
      'deep-mode artifact must state a confidence of low, medium, or high (an honest "low" routes follow-up work instead of penalizing you)',
    );
  }
  return reasons;
}

/** deep 档节点提示词尾部追加的 typed artifact 契约段（light 档不追加，提示词字节不变）。 */
export function typedArtifactContractLines(): string[] {
  return [
    "",
    "Typed artifact contract (deep gate):",
    `End your final response with exactly one fenced \`\`\`${TYPED_ARTIFACT_FENCE} block containing a single JSON object:`,
    '{"findings":"what shipped / what you concluded","evidence":["path/file.ts:123"],"validation":"commands you ran and their results","openQuestions":["..."],"confidence":"low|medium|high","whatINotChecked":["..."]}',
    'findings must be non-empty; whatINotChecked must be non-empty (write an explicit "nothing, fully covered" entry only when truly exhaustive); confidence must be one of low, medium, high — an honest "low" routes follow-up work instead of penalizing you.',
    "A missing or invalid block requeues this node once; a second miss fails it.",
  ];
}

function lastTypedArtifactBlock(response: string): string | undefined {
  const pattern = new RegExp(`\`\`\`${TYPED_ARTIFACT_FENCE}[ \\t]*\\r?\\n?([\\s\\S]*?)\`\`\``, "g");
  let last: string | undefined;
  for (const match of response.matchAll(pattern)) {
    if (match[1] !== undefined) last = match[1];
  }
  return last;
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error("typed artifact block does not contain a JSON object");
}

// 宽容归一化：模型常见 snake_case / 大小写漂移在进入严格 schema 前收敛。键别名机制与 jcode
// serde alias 同构；confidence 则**只**做 trim（readLooseString）+ 小写归一（"Low"→"low"），
// **不做** jcode ConfidenceLevel::parse 式的自由文本档位解析——非枚举 confidence 交由 zod
// 拒绝、整块按 invalid 处理，后果登记见 spec R2（对抗复核 F-2：原注释声称与
// ConfidenceLevel::parse「同一意图」言过其实，如实修正；宽容解析登记为后续可选加固）。
// 只映射已知语义别名，未知键交给 zod 剥离。
//
// 别名集必须与 spec R2 的登记表**同名同集**（specs/workflow-typed-artifacts.md）：少一个
// 别名 = deep 档提交该拼写时字段静默变空 → 白白烧掉一次 requeue、第二次直接 fail；多一个
// 未登记别名 = 契约不可审计。readLooseValue 先按列出顺序做精确匹配、再走 loose-key
// 归一化（小写 + 去非字母数字），所以 camelCase 拼写（whatIDidNotCheck / whatIDidntCheck）
// 由对应的 snake_case 条目自动覆盖，这里仍显式列出便于对照 spec。
function normalizeTypedCandidate(raw: Record<string, unknown>): Record<string, unknown> {
  const candidate: Record<string, unknown> = {};
  const findings = readLooseString(raw, ["findings", "summary"]);
  if (findings !== undefined) candidate.findings = findings;
  const evidence = readLooseStringArray(raw, ["evidence", "references"]);
  if (evidence !== undefined) candidate.evidence = evidence;
  const validation = readLooseString(raw, ["validation", "verification"]);
  if (validation !== undefined) candidate.validation = validation;
  const openQuestions = readLooseStringArray(raw, ["openQuestions", "open_questions"]);
  if (openQuestions !== undefined) candidate.openQuestions = openQuestions;
  const confidence = readLooseString(raw, ["confidence"]);
  // 仅 trim（readLooseString）+ 小写；不做自由文本档位解析，非枚举值由 zod 拒绝（spec R2 / F-2）。
  if (confidence !== undefined) candidate.confidence = confidence.toLowerCase();
  const whatINotChecked = readLooseStringArray(raw, [
    "whatINotChecked",
    "what_i_not_checked",
    "what_i_did_not_check",
    "whatIDidNotCheck",
    // 评审 J2 修复：spec R2 登记的第三个别名此前漏实现——`whatididntcheck` 与已登记的
    // `whatinotchecked` / `whatididnotcheck` 归一化后都不相等，loose-key 救不回来，
    // 于是 deep 档提交该拼写会拿到空数组并被 R3 判「must list whatINotChecked」。
    "what_i_didnt_check",
  ]);
  if (whatINotChecked !== undefined) candidate.whatINotChecked = whatINotChecked;
  return candidate;
}
