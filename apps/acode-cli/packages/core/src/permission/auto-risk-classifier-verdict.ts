// ============================================================
// auto 模式风险分类器 - verdict 词汇 / 输出解析 / 决策缓存（纯叶子层）
// ============================================================
// 从 auto-risk-classifier.ts 拆出（批 2，max-lines 门禁 + 层次边界）：本文件是
// 零依赖叶子（只 import node:crypto），协议主文件与 sidecar 经既有导入路径
// （auto-risk-classifier.ts 的再导出）消费，接口逐名不变。
// 语义裁决全部沿第一批：specs/auto-mode-risk-classifier.md R3/R4/D5/D7。

import { createHash } from "node:crypto";

/** D5：session 级决策缓存上限（LRU；ask 永不缓存）。 */
export const AUTO_CLASSIFIER_CACHE_MAX = 256;
/** 分类请求里工具入参序列化的硬截断。 */
export const AUTO_CLASSIFIER_INPUT_MAX_CHARS = 4_096;
/** reason 展示字段截断（自由文本只进展示、永不参与 verdict 解析）。 */
export const AUTO_CLASSIFIER_REASON_MAX_CHARS = 200;

export const AUTO_RISK_REASON_CODES = [
  "serves_stated_intent",
  "reversible_in_workspace",
  "irreversible_destructive",
  "sensitive_data_access",
  "external_egress",
  "scope_mismatch",
  "insufficient_evidence",
] as const;
export type AutoRiskReasonCode = (typeof AUTO_RISK_REASON_CODES)[number];

export type AutoRiskUnavailableReason =
  | "no_model"
  | "budget"
  | "timeout"
  | "parse_error"
  | "low_confidence"
  | "error";

export type AutoRiskVerdict =
  | {
      kind: "verdict";
      verdict: "allow" | "ask" | "deny";
      confidence: number;
      reasonCode: AutoRiskReasonCode;
      reason: string;
      /** 决策来源：缓存复用 or 本次模型调用（审计与日志字段）。 */
      via: "cache" | "model";
    }
  | { kind: "unavailable"; reason: AutoRiskUnavailableReason };

export function serializeAutoRiskClassifierInput(input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? String(input);
  } catch {
    serialized = String(input);
  }
  return serialized.length > AUTO_CLASSIFIER_INPUT_MAX_CHARS
    ? `${serialized.slice(0, AUTO_CLASSIFIER_INPUT_MAX_CHARS)}…[truncated]`
    : serialized;
}

/**
 * 输出解析（R4：schema 硬约束）。verdict/confidence 非法 → parse_error（消费方
 * fail-safe 到 ASK）；reasonCode 未知 → 收敛到 insufficient_evidence（宽容展示、
 * 从严语义）；<think> 段与 fenced JSON 容错沿 title sidecar 纪律。
 */
export function parseAutoRiskVerdict(raw: string): AutoRiskVerdict | null {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const candidates = [
    withoutThinking,
    extractFencedJson(withoutThinking),
    extractBraceSlice(withoutThinking),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  for (const candidate of candidates) {
    const verdict = parseAutoRiskVerdictCandidate(candidate);
    if (verdict) return verdict;
  }
  return null;
}

function parseAutoRiskVerdictCandidate(text: string): AutoRiskVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const verdict = record.verdict;
  if (verdict !== "allow" && verdict !== "ask" && verdict !== "deny") return null;
  const confidence = record.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  const normalizedConfidence = Math.min(1, Math.max(0, confidence));
  const reasonCode = AUTO_RISK_REASON_CODES.includes(record.reasonCode as AutoRiskReasonCode)
    ? (record.reasonCode as AutoRiskReasonCode)
    : "insufficient_evidence";
  const reason =
    typeof record.reason === "string"
      ? record.reason.slice(0, AUTO_CLASSIFIER_REASON_MAX_CHARS)
      : "";
  return {
    kind: "verdict",
    verdict,
    confidence: normalizedConfidence,
    reasonCode,
    reason,
    via: "model",
  };
}

function extractFencedJson(text: string): string | null {
  const match = text.match(/```[ \t]*(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i);
  return match?.[1]?.trim() ?? null;
}

function extractBraceSlice(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

// ------------------------------------------------------------
// 决策缓存（D5；端口实现内部状态，session 级生命周期）
// ------------------------------------------------------------

export function buildAutoRiskCacheKey(toolName: string, input: unknown): string {
  const digest = createHash("sha256").update(serializeAutoRiskClassifierInput(input)).digest("hex");
  return `${toolName}\u0000${digest}`;
}

/** 极简 LRU：Map 迭代序 = 插入序，命中即搬尾，超限逐首。只存 allow/deny（R3/D5）。 */
export function createAutoRiskDecisionCache(): {
  get(key: string): AutoRiskVerdict | undefined;
  set(key: string, verdict: AutoRiskVerdict): void;
  readonly size: number;
} {
  const entries = new Map<string, AutoRiskVerdict>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
      }
      return hit;
    },
    set(key, verdict) {
      entries.delete(key);
      entries.set(key, verdict);
      while (entries.size > AUTO_CLASSIFIER_CACHE_MAX) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    get size() {
      return entries.size;
    },
  };
}
