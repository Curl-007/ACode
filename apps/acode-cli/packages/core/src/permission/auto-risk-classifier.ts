import type {
  CollaborationMode,
  ModelToolSideEffectScope,
  RiskLevel,
  TraceContext,
} from "@acode/contracts";
import type { PermissionDecisionResult } from "./service.js";
import {
  getToolAdjudicationAnnotation,
  renderToolDossierBlock,
} from "./tool-adjudication-corpus.js";
import {
  buildTranscriptProvenanceDigest,
  recordTranscriptFileProvenanceFromAllowedCall,
} from "./file-provenance-ledger.js";
import type {
  AutoRiskReasonCode,
  AutoRiskUnavailableReason,
  AutoRiskVerdict,
} from "./auto-risk-classifier-verdict.js";

// ============================================================
// auto 模式 LLM 风险分类器（specs/auto-mode-risk-classifier.md）
// 本文件是协议的"纯层"：常量、端口、接缝消费辅助、审计 sink——零 runtime 依赖
// （sidecar 实现住在 runtime/methods/auto-risk-classifier-sidecar.ts，装配点唯一
// 在 runtime/helpers/runtime-tools.ts 的 createRuntimeToolExecutor）。
// 批 2 起三个内聚层单独成文件、经本文件再导出（max-lines 门禁 + 资产边界，
// 既有导入路径逐名不变）：
// - rubric 系统提示词 → auto-risk-classifier-prompt.ts
// - verdict 词汇/输出解析/决策缓存 → auto-risk-classifier-verdict.ts
// - 工具裁决注记语料 / transcript 来源台账 → tool-adjudication-corpus.ts /
//   file-provenance-ledger.ts（批 2 R8/R9 新增，直接导出）
// ============================================================

export const AUTO_RISK_CLASSIFY_QUERY_SOURCE = "auto_risk_classify";

/** D6：分类调用超时（工具执行关键路径上，比 title sidecar 的 60s 短得多）。 */
export const AUTO_CLASSIFIER_TIMEOUT_MS = 15_000;
/** D6：每 turn 分类调用上限；超限灰区一律 ASK（防成本失控与循环滥用）。 */
export const AUTO_CLASSIFIER_MAX_CALLS_PER_TURN = 12;
/** D7：自报置信低于阈值 → 强制 ASK。 */
export const AUTO_CLASSIFIER_MIN_CONFIDENCE = 0.7;
/** D4-B：取证窗硬截断（最近 1 条真实用户消息；工具结果/文件内容默认不进）。 */
export const AUTO_CLASSIFIER_FORENSIC_MAX_CHARS = 2_048;

// verdict 词汇 / 解析 / 缓存（纯叶子层，语义裁决见该文件头注）。
export {
  AUTO_CLASSIFIER_CACHE_MAX,
  AUTO_CLASSIFIER_INPUT_MAX_CHARS,
  AUTO_CLASSIFIER_REASON_MAX_CHARS,
  AUTO_RISK_REASON_CODES,
  buildAutoRiskCacheKey,
  createAutoRiskDecisionCache,
  parseAutoRiskVerdict,
  serializeAutoRiskClassifierInput,
} from "./auto-risk-classifier-verdict.js";
export type {
  AutoRiskReasonCode,
  AutoRiskUnavailableReason,
  AutoRiskVerdict,
} from "./auto-risk-classifier-verdict.js";

// rubric 系统提示词（恒英文，prompt-language-policy；提示词资产，调优守 hillclimb R7）。
export { AUTO_RISK_CLASSIFIER_SYSTEM_PROMPT } from "./auto-risk-classifier-prompt.js";

export interface AutoRiskClassifyRequest {
  toolName: string;
  input: unknown;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  turnId: string | undefined;
  traceContext?: TraceContext;
  signal?: AbortSignal;
  /**
   * 批 2 R9：transcript 来源台账摘要（接缝计算后随请求携带；当前 sidecar 经
   * 同步作用域消费，本字段供未来端口实现直接透传——两路同源同值）。
   */
  provenanceDigest?: string;
}

export interface AutoRiskClassifierPort {
  classify(req: AutoRiskClassifyRequest): Promise<AutoRiskVerdict>;
}

export function buildAutoRiskClassifierUserMessage(input: {
  toolName: string;
  riskLevel: RiskLevel;
  sideEffectScope?: string;
  serializedInput: string;
  forensicWindow: string;
  /**
   * 批 2 R9：来源台账摘要。显式参数优先；缺席时读同步作用域（灰区接缝在
   * classify 调用外设置）；两者皆无 → 如实渲染「台账不可用」（rubric 据此
   * 从严 = fail-safe 方向）。
   */
  provenanceDigest?: string;
}): string {
  const dossier = renderToolDossierBlock(getToolAdjudicationAnnotation(input.toolName));
  const provenance =
    input.provenanceDigest ?? activeProvenanceDigest ?? buildTranscriptProvenanceDigest(undefined);
  return [
    "<tool-call>",
    `tool: ${input.toolName}`,
    `riskLevel: ${input.riskLevel}`,
    `sideEffectScope: ${input.sideEffectScope ?? "none"}`,
    "input:",
    input.serializedInput,
    "</tool-call>",
    // 批 2 R8：逐工具裁决注记（宿主自撰语料，非不可信数据；缺席 = 无块）。
    ...(dossier === undefined ? [] : ["<tool-dossier>", dossier, "</tool-dossier>"]),
    // 批 2 R9：transcript 文件来源台账（破坏性判定的来源证据）。
    "<transcript-provenance>",
    provenance,
    "</transcript-provenance>",
    "<recent-user-intent>",
    input.forensicWindow.trim() || "(none)",
    "</recent-user-intent>",
  ].join("\n");
}

// ------------------------------------------------------------
// 来源摘要的同步作用域（批 2 R9）：灰区接缝在调 classify 前写入台账摘要，
// 生产端口实现（sidecar）从 classify 到构造 user message 是同步前缀（cache→
// 预算→模型选择→buildClassifierMessages，首个 await 在其后），单线程 JS 下
// 作用域不会串会话；若端口实现延迟构造消息，块退化为「台账不可用」→ 分类器
// 按从严语义裁决（fail-safe，spec 钉住退化形态）。
// ------------------------------------------------------------

let activeProvenanceDigest: string | undefined;

export function runWithProvenanceScope<T>(digest: string | undefined, fn: () => T): T {
  const previous = activeProvenanceDigest;
  activeProvenanceDigest = digest;
  try {
    return fn();
  } finally {
    activeProvenanceDigest = previous;
  }
}

// ------------------------------------------------------------
// 接缝消费（R3；两个接缝共用本函数，防语义分叉）
// ------------------------------------------------------------

interface AutoClassifierLogger {
  debug(message: string, context?: Record<string, unknown>): void;
}

export interface AutoGrayZoneResolutionInput {
  classifier: AutoRiskClassifierPort | undefined;
  decision: PermissionDecisionResult;
  mode: CollaborationMode;
  toolName: string;
  executionInput: unknown;
  sessionId: string;
  turnId: string | undefined;
  traceContext: TraceContext;
  signal?: AbortSignal;
  logger?: AutoClassifierLogger;
}

/**
 * 灰区标记消费：仅 autoGrayZone && mode==="auto" 进入；端口缺席/异常/超时/低置信/
 * 预算尽 → 维持 ask（fail-safe，R3 步骤 4）。重写只改 decision/ruleId/reason，
 * riskLevel/sideEffectScope/mode 原样，allowed/escalated 按既有 result() 语义重算。
 * 分类器裁决不产生任何持久规则（R3 纪律）。
 */
export async function resolveAutoGrayZoneDecision(
  input: AutoGrayZoneResolutionInput,
): Promise<PermissionDecisionResult> {
  if (!input.decision.autoGrayZone || input.mode !== "auto") {
    return input.decision;
  }
  // 端口缺席：标记退回其 wire 形态（ask），fail-safe。
  const fallbackAsk: PermissionDecisionResult = stripAutoGrayZone(input.decision);
  if (!input.classifier) return fallbackAsk;
  // 闭包捕获用局部常量（早退后 TS 收窄不进回调）。
  const classifier = input.classifier;

  const startedAt = Date.now();
  let verdict: AutoRiskVerdict;
  // 批 2 R9：来源台账摘要随请求携带 + 写入同步作用域（sidecar 构造 user message
  // 时消费；两路同源同值）。
  const provenanceDigest = buildTranscriptProvenanceDigest(input.sessionId);
  try {
    verdict = await runWithProvenanceScope(provenanceDigest, () =>
      classifier.classify({
        toolName: input.toolName,
        input: input.executionInput,
        riskLevel: input.decision.riskLevel,
        ...(input.decision.sideEffectScope
          ? { sideEffectScope: input.decision.sideEffectScope }
          : {}),
        turnId: input.turnId,
        traceContext: input.traceContext,
        ...(input.signal ? { signal: input.signal } : {}),
        provenanceDigest,
      }),
    );
  } catch {
    // 端口自身抛异常也是 fail-safe 路径（实现内部本应自捕获，双保险）。
    verdict = { kind: "unavailable", reason: "error" };
  }
  const latencyMs = Date.now() - startedAt;

  const mapped = mapAutoRiskVerdictToDecision(fallbackAsk, verdict);
  // 批 2 R9：分类器放行的写入也是 transcript 来源（与 service 的 allow 喂入同源；
  // 灰区进来时 service 记的是 ask，不喂——此处补上，双喂不会发生）。
  if (mapped.decision === "allow") {
    recordTranscriptFileProvenanceFromAllowedCall({
      sessionId: input.sessionId,
      toolName: input.toolName,
      toolInput: input.executionInput,
    });
  }
  input.logger?.debug("Auto risk classifier decided", {
    event: "tool.permission.auto_classified",
    module: "core.permission",
    tool: input.toolName,
    toolCallVerdict: mapped.decision,
    ruleId: mapped.ruleId,
    reasonCode: verdict.kind === "verdict" ? verdict.reasonCode : undefined,
    confidence: verdict.kind === "verdict" ? verdict.confidence : undefined,
    latencyMs,
    cache: verdict.kind === "verdict" && verdict.via === "cache" ? "hit" : "miss",
    ...(verdict.kind === "unavailable" ? { fallback: verdict.reason } : {}),
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
  });
  writeAutoClassifierAuditEntry({
    timestamp: new Date().toISOString(),
    event: "auto_classifier_verdict",
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    tool: input.toolName,
    verdict: mapped.decision,
    ruleId: mapped.ruleId,
    ...(verdict.kind === "verdict"
      ? { reasonCode: verdict.reasonCode, confidence: verdict.confidence }
      : { fallback: verdict.reason }),
    latencyMs,
    cache: verdict.kind === "verdict" && verdict.via === "cache" ? "hit" : "miss",
  });
  return mapped;
}

function mapAutoRiskVerdictToDecision(
  base: PermissionDecisionResult,
  verdict: AutoRiskVerdict,
): PermissionDecisionResult {
  if (verdict.kind === "verdict") {
    if (verdict.verdict === "allow") {
      return rewriteDecision(base, "allow", "auto.classifier.allow", autoClassifierReason(verdict));
    }
    if (verdict.verdict === "deny") {
      return rewriteDecision(base, "deny", "auto.classifier.deny", autoClassifierReason(verdict));
    }
    return rewriteDecision(base, "ask", "auto.classifier.ask", autoClassifierReason(verdict));
  }
  if (verdict.reason === "budget") {
    return rewriteDecision(
      base,
      "ask",
      "auto.classifier.budget",
      "Auto-mode risk classifier call budget exhausted for this turn; approval required",
    );
  }
  return rewriteDecision(
    base,
    "ask",
    "auto.classifier.ask",
    `Auto-mode risk classifier could not decide (${verdict.reason}); approval required`,
  );
}

function autoClassifierReason(verdict: Extract<AutoRiskVerdict, { kind: "verdict" }>): string {
  const detail = verdict.reason.trim();
  return `[auto-classifier:${verdict.reasonCode}]${detail ? ` ${detail}` : ""}`.trim();
}

function rewriteDecision(
  base: PermissionDecisionResult,
  decision: PermissionDecisionResult["decision"],
  ruleId: string,
  reason: string,
): PermissionDecisionResult {
  return {
    ...base,
    decision,
    allowed: decision === "allow",
    escalated: decision === "ask",
    ruleId,
    reason,
  };
}

function stripAutoGrayZone(decision: PermissionDecisionResult): PermissionDecisionResult {
  const { autoGrayZone: _autoGrayZone, ...rest } = decision;
  return rest;
}

// ------------------------------------------------------------
// 审计 sink（R6；仿 setBashReflexAuditSink 进程级注册模式，bootstrap 装配期接线，
// 默认无 sink——测试与未装配环境零输出，绝不阻塞权限决策）
// ------------------------------------------------------------

export interface AutoClassifierAuditEntry {
  timestamp: string;
  event: "auto_classifier_verdict";
  sessionId: string;
  turnId?: string;
  tool: string;
  verdict: "allow" | "ask" | "deny";
  ruleId: string;
  reasonCode?: AutoRiskReasonCode;
  confidence?: number;
  latencyMs: number;
  cache: "hit" | "miss";
  fallback?: AutoRiskUnavailableReason;
}

export type AutoClassifierAuditSink = (entry: AutoClassifierAuditEntry) => void;

let autoClassifierAuditSink: AutoClassifierAuditSink | null = null;
const sessionAutoClassifierAuditSinks = new Map<string, AutoClassifierAuditSink>();

export function setAutoClassifierAuditSink(sink: AutoClassifierAuditSink | null): void {
  autoClassifierAuditSink = sink;
}

/** 注册一个 app/session 的分类器审计 sink，返回幂等释放函数。 */
export function registerAutoClassifierAuditSink(
  sessionId: string,
  sink: AutoClassifierAuditSink,
): () => void {
  sessionAutoClassifierAuditSinks.set(sessionId, sink);
  return () => {
    if (sessionAutoClassifierAuditSinks.get(sessionId) === sink) {
      sessionAutoClassifierAuditSinks.delete(sessionId);
    }
  };
}

export function writeAutoClassifierAuditEntry(entry: AutoClassifierAuditEntry): void {
  try {
    (sessionAutoClassifierAuditSinks.get(entry.sessionId) ?? autoClassifierAuditSink)?.(entry);
  } catch {
    // 审计失败不得影响权限决策链路。
  }
}
