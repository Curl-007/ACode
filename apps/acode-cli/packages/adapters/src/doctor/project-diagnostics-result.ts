// ============================================================
// Provider Doctor 报告 → U08 跨进程 DTO 投影（provider-diagnostics.md R6/R7）
// ============================================================
//
// 唯一职责：把 Doctor 的**内存报告**（含中文 label/detail、含原始 Registry 事实）投影成
// `@acode/shared` 的白名单 DTO——只搬结构化闭集（id/status/reasonCode/verdict/spend/…），
// 丢弃 label 与 detail（用户文本由 UI 按 id+reasonCode 走 i18n，见契约叶子文件头设计要点 1）。
//
// 两条承重不变量：
// 1. **不做文本匹配**（根 AGENTS.md / R6）：errorCode 由首个未通过检查点的
//    `(id, status, reasonCode)` 结构化三元组派生，绝不解析 detail。
// 2. **verdict 逐字沿用 Doctor**（R1/R5）：`ready` 只可能来自 live 档全通过；本投影不重算、
//    不放宽。tier 结论的判定权在 `computeProviderDoctorVerdict`（report-assembly.ts），
//    这里只读 `report.verdict` / `report.tierPassed`。
//
// 复用 Doctor 既有的 `findFirstFailure`（report-assembly.ts）：failed|blocked 的首个检查点，
// 与账本 `firstFailure`、CLI `--json` 的失败归因同源，不另立一套「谁先失败」的定义。

import type { ProviderDiagnosticsReasonCode, ProviderDiagnosticsRemediationAction } from "@acode/shared";
import { PROVIDER_DIAGNOSTICS_ZERO_SPEND } from "@acode/shared";
import { findFirstFailure } from "./report-assembly.js";
import type {
  ProviderDoctorCheckResult,
  ProviderDoctorReport,
  ProviderDoctorRunResult,
} from "./types.js";

/**
 * 首个未通过检查点的 `(id, status, reasonCode)` → 稳定错误码（R6 闭集）。
 *
 * 只有 `failed` / `blocked` 会成为「错误码」；`skipped` 不是失败（R5，轻档不跑重档检查点，
 * 或前置未满足而刻意不发请求），因此不在派生表里——`findFirstFailure` 本就不返回 skipped。
 *
 * `catalog_live_endpoint` 的 failed 细分（密钥被拒 / 网络不可达 / 目录为空）来自 catalog-probe
 * 就地落的 `reasonCode`；缺码时退回 `catalog-unreachable`（「拿不到目录」的最保守归因）。
 */
const ERROR_CODE_BY_CHECKPOINT: Readonly<
  Record<ProviderDoctorCheckResult["id"], ProviderDiagnosticsReasonCode>
> = Object.freeze({
  config_sources_loaded: "config-source-unavailable",
  provider_schema_valid: "config-schema-invalid",
  endpoint_shape_valid: "endpoint-shape-invalid",
  // credential_available 的 failed(引用悬空/未配置) 与 blocked(库不可解密) 在下方按 status 细分。
  credential_available: "credential-missing",
  catalog_models_declared: "catalog-not-declared",
  model_route_resolved: "model-route-unresolved",
  endpoint_public_egress: "endpoint-not-public",
  catalog_live_endpoint: "catalog-unreachable",
  catalog_model_listed: "model-not-listed",
  non_streaming_chat_completion: "live-probe-failed",
  streaming_chat_completion: "live-probe-failed",
  tool_call_parse: "live-probe-failed",
});

/**
 * 从 12 检查点派生整体错误码。无未通过项 → undefined（对应 tier-passed/ready）。
 * 结构化派生，不碰 detail 文本（R6）。
 */
export function deriveProviderDiagnosticsErrorCode(
  checks: readonly ProviderDoctorCheckResult[],
): ProviderDiagnosticsReasonCode | undefined {
  const first = findFirstFailure(checks);
  if (!first) return undefined;
  // credential_available 的两种非通过态语义不同：failed=事实性缺失（引用悬空/未配置），
  // blocked=凭据库不可用（诊断无法证明，spec R5）。分开派生，UI 才能给不同修复动作。
  if (first.id === "credential_available" && first.status === "blocked") {
    return "credential-undecryptable";
  }
  // catalog_live_endpoint 的 failed 细分靠 catalog-probe 就地落的 reasonCode（401 拒凭据 /
  // 网络不可达 / 2xx 空目录）。reasonCode 是结构化枚举，不是文本匹配。
  if (first.reasonCode) return first.reasonCode;
  return ERROR_CODE_BY_CHECKPOINT[first.id];
}

/**
 * 错误码 → 允许 UI 呈现的修复动作白名单（R6 闭集）。
 *
 * 只给**动作类别**，不给可执行命令（命令走 `nextStepCommands`，由 Doctor R7 白名单化）。
 * 每条都带 `verify-later`（提案 §3.6：失败不清空已保存 provider，可保持「已保存、未验证」
 * 稍后再诊断）；失败态都带 `retry-diagnostics`（R3：重试不重新创建 provider）。
 */
export function deriveRemediationActions(input: {
  readonly errorCode: ProviderDiagnosticsReasonCode | undefined;
  readonly tier: ProviderDoctorReport["tier"];
  readonly verdict: ProviderDoctorReport["verdict"];
}): readonly ProviderDiagnosticsRemediationAction[] {
  const actions = new Set<ProviderDiagnosticsRemediationAction>();
  const { errorCode, tier, verdict } = input;

  if (errorCode === undefined) {
    // 通过态：轻档通过时提示升档（Doctor R7「升档建议」），live 档 ready 无需修复动作。
    if (verdict === "tier-passed") {
      actions.add(tier === "offline" ? "escalate-tier-catalog" : "escalate-tier-live");
    }
    // live 档 tier-passed（非 ready）通常是某检查点 skipped，例如模型不支持 tool call；
    // 给「换个模型」以到达完整 ready（U08-A5）。
    if (tier === "live" && verdict === "tier-passed") {
      actions.add("select-another-model");
    }
    actions.add("retry-diagnostics");
    actions.add("verify-later");
    return [...actions];
  }

  switch (errorCode) {
    case "config-source-unavailable":
      actions.add("retry-diagnostics");
      break;
    case "config-schema-invalid":
      actions.add("open-api-key-settings");
      break;
    case "endpoint-shape-invalid":
    case "endpoint-not-public":
      actions.add("edit-endpoint");
      if (errorCode === "endpoint-not-public") actions.add("check-network");
      break;
    case "credential-missing":
    case "credential-undecryptable":
    case "credential-rejected":
      // 报告不携带 access 类型，无法在此区分账号 vs API Key；两种修复都给，
      // 用户知道自己配的是哪种。精确命令走 nextStepCommands（Doctor 已按 access 分派）。
      actions.add("open-api-key-settings");
      actions.add("relogin-account");
      break;
    case "catalog-not-declared":
      actions.add("select-another-model");
      actions.add("open-api-key-settings");
      break;
    case "model-route-unresolved":
    case "model-not-listed":
      actions.add("select-another-model");
      break;
    case "catalog-empty":
      actions.add("open-api-key-settings");
      actions.add("check-network");
      break;
    case "catalog-unreachable":
    case "live-probe-failed":
      actions.add("check-network");
      actions.add("retry-diagnostics");
      break;
    case "no-agent-runtime":
    case "invalid-request":
    case "live-opt-in-required":
    case "revision-mismatch":
    case "provider-unknown":
    case "cancelled":
    case "execution-failed":
    case "offline-network-blocked":
    case "tool-call-unsupported":
      // 这些要么是控制面终态（cancelled/invalid-request…），要么不指向用户可修的配置。
      // 只给重试/稍后，不臆造修复动作。
      break;
  }
  // 失败态一律可重试（不重新创建 provider，R3）并可稍后验证。
  actions.add("retry-diagnostics");
  actions.add("verify-later");
  return [...actions];
}

/**
 * 把 Doctor 的**成功运行结果**投影成一份 completed DTO。
 *
 * @param report   目标 provider 的 Doctor 报告（runProviderDoctor 的 reports 里选出的一条）
 * @param envelope requestId + revision（host 盖章，逐字回显，R2）
 * @param run      顶层运行结果（取 blockedNetworkCalls）
 */
export function projectProviderDiagnosticsResult(input: {
  readonly report: ProviderDoctorReport;
  readonly requestId: string;
  readonly revision: number;
  readonly run: ProviderDoctorRunResult;
}): CompletedProjection {
  const { report, requestId, revision, run } = input;
  const checkpoints = report.checks.map((check) => ({
    id: check.id,
    status: check.status,
    ...(check.reasonCode ? { reasonCode: check.reasonCode } : {}),
    ...(check.durationMs !== undefined ? { durationMs: check.durationMs } : {}),
  }));

  // offline 档若拦到网络调用（>0），零网络不变量被违背（R9）：这优先于任何 verdict，
  // 因为「offline 通过但偷偷联网了」绝不能呈现成 tier-passed。
  const offlineBreached = report.tier === "offline" && run.blockedNetworkCalls > 0;
  const derivedErrorCode = offlineBreached
    ? ("offline-network-blocked" as const)
    : deriveProviderDiagnosticsErrorCode(report.checks);

  // verdict：offline 违背时强制降级为 failed（不给背书）；否则逐字沿用 Doctor 结论。
  const verdict = offlineBreached ? ("failed" as const) : report.verdict;
  const remediationActions = deriveRemediationActions({
    errorCode: derivedErrorCode,
    tier: report.tier,
    verdict,
  });

  return {
    requestId,
    providerId: report.providerId,
    revision,
    tier: report.tier,
    ...(report.modelId ? { modelId: report.modelId } : {}),
    status: "completed",
    verdict,
    ...(derivedErrorCode ? { errorCode: derivedErrorCode } : {}),
    checkpoints,
    remediationActions,
    nextStepCommands: [...report.nextSteps],
    spend: { ...report.spend },
    blockedNetworkCalls: run.blockedNetworkCalls,
    ...(report.endpointHost ? { endpointHost: report.endpointHost } : {}),
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
  };
}

/** projectProviderDiagnosticsResult 的返回形状（供 adapter 直接喂给 parseProviderDiagnosticsResult）。 */
export interface CompletedProjection {
  readonly requestId: string;
  readonly providerId: string;
  readonly revision: number;
  readonly tier: ProviderDoctorReport["tier"];
  readonly modelId?: string;
  readonly status: "completed";
  readonly verdict: ProviderDoctorReport["verdict"];
  readonly errorCode?: ProviderDiagnosticsReasonCode;
  readonly checkpoints: readonly {
    readonly id: ProviderDoctorCheckResult["id"];
    readonly status: ProviderDoctorCheckResult["status"];
    readonly reasonCode?: ProviderDiagnosticsReasonCode;
    readonly durationMs?: number;
  }[];
  readonly remediationActions: readonly ProviderDiagnosticsRemediationAction[];
  readonly nextStepCommands: readonly string[];
  readonly spend: typeof PROVIDER_DIAGNOSTICS_ZERO_SPEND;
  readonly blockedNetworkCalls: number;
  readonly endpointHost?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}
